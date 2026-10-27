"""Unit tests of the Home Assistant WebSocket client and event logger (ebusd_workbench/workbench/ha.py)."""

import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ebusd_workbench"))
from workbench import ha  # noqa: E402
from workbench.db import Database  # noqa: E402
from workbench.settings import Settings  # noqa: E402


class Frames(unittest.TestCase):
    def roundtrip(self, payload, opcode=ha.OP_TEXT):
        data = ha.encode_frame(opcode, payload)
        buffer = bytearray(data)

        def read(n):
            chunk, buffer[:n] = bytes(buffer[:n]), b""
            self.assertEqual(len(chunk), n)
            return chunk
        fin, op, out = ha.decode_frame(read)
        self.assertTrue(fin)
        self.assertEqual(op, opcode)
        self.assertEqual(out, payload)
        self.assertEqual(len(buffer), 0)

    def test_frame_sizes(self):
        self.roundtrip(b"")
        self.roundtrip(b"hello")
        self.roundtrip(b"x" * 125)
        self.roundtrip(b"y" * 126)
        self.roundtrip(b"z" * 70000)
        self.roundtrip(b"\x03\xe8", ha.OP_CLOSE)

    def test_masking(self):
        frame = ha.encode_frame(ha.OP_TEXT, b"hello")
        self.assertTrue(frame[1] & 0x80)  # client frames are masked
        self.assertNotIn(b"hello", frame)
        self.assertNotIn(b"hello", ha.encode_frame(ha.OP_TEXT, b"hello"))
        unmasked = ha.encode_frame(ha.OP_TEXT, b"hello", mask=False)
        self.assertEqual(unmasked, b"\x81\x05hello")

    def test_accept_key(self):
        # example of RFC 6455 section 1.3
        self.assertEqual(ha.accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

    def test_parse_iso(self):
        from datetime import datetime, timezone
        expected = int(datetime(2026, 10, 27, 10, 0, 0, 500000, tzinfo=timezone.utc).timestamp() * 1000) * 1_000_000
        self.assertEqual(ha.parse_iso("2026-10-27T10:00:00.500000+00:00"), expected)
        self.assertEqual(ha.parse_iso("2026-10-27T12:00:00.5+02:00"), expected)
        self.assertEqual(ha.parse_iso("2026-10-27T10:00:00.500Z"), expected)
        self.assertIsNone(ha.parse_iso("yesterday"))
        self.assertIsNone(ha.parse_iso(None))


class FakeHomeAssistant(threading.Thread):
    """A WebSocket server that behaves like the Core WebSocket API for one session."""

    def __init__(self, states, events):
        super().__init__(daemon=True)
        self.states = states
        self.events = events
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.received = []
        self.done = threading.Event()

    def run(self):
        conn, _ = self.sock.accept()
        conn.settimeout(5)
        data = b""
        while b"\r\n\r\n" not in data:
            data += conn.recv(4096)
        key = next(line.split(b":", 1)[1].strip() for line in data.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key"))
        conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     b"Sec-WebSocket-Accept: " + ha.accept_key(key.decode()).encode() + b"\r\n\r\n")
        buffer = bytearray()

        def read(n):
            nonlocal buffer
            while len(buffer) < n:
                chunk = conn.recv(4096)
                if not chunk:
                    raise ConnectionError("closed")
                buffer += chunk
            out, buffer = bytes(buffer[:n]), buffer[n:]
            return out

        def send(obj):
            conn.sendall(ha.encode_frame(ha.OP_TEXT, json.dumps(obj).encode(), mask=False))

        try:
            send({"type": "auth_required"})
            _, _, payload = ha.decode_frame(read)
            auth = json.loads(payload)
            self.received.append(auth)
            if auth.get("access_token") != "secret":
                send({"type": "auth_invalid", "message": "bad token"})
                return
            send({"type": "auth_ok"})
            while True:
                _, opcode, payload = ha.decode_frame(read)
                if opcode == ha.OP_PING:
                    conn.sendall(ha.encode_frame(ha.OP_PONG, payload, mask=False))
                    continue
                if opcode != ha.OP_TEXT:
                    break
                message = json.loads(payload)
                self.received.append(message)
                if message["type"] == "subscribe_trigger":
                    send({"id": message["id"], "type": "result", "success": True, "result": None})
                    subscription = message["id"]
                elif message["type"] == "get_states":
                    send({"id": message["id"], "type": "result", "success": True, "result": self.states})
                    for event in self.events:
                        send({"id": subscription, "type": "event", "event": {"variables": {"trigger": event}}})
                    # a fragmented text frame must work as well
                    text = json.dumps({"id": subscription, "type": "event", "event": {"variables": {"trigger": self.events[-1]}}}).encode()
                    conn.sendall(ha.encode_frame(ha.OP_TEXT, text[:10], mask=False, fin=False))
                    conn.sendall(ha.encode_frame(ha.OP_CONT, text[10:], mask=False, fin=True))
                    self.done.set()
        except (ConnectionError, OSError):
            pass
        finally:
            conn.close()


class Logger(unittest.TestCase):
    def test_logs_state_changes(self):
        states = [{"entity_id": "switch.pump", "state": "off", "attributes": {"friendly_name": "Pump"}},
                  {"entity_id": "light.other", "state": "on", "attributes": {}}]
        events = [
            {"platform": "state", "entity_id": "switch.pump", "from_state": {"state": "off"},
             "to_state": {"state": "on", "last_changed": "2026-10-27T10:00:00+00:00", "attributes": {"friendly_name": "Pump"}}},
            {"platform": "state", "entity_id": "switch.pump", "from_state": {"state": "on"},
             "to_state": {"state": "on", "attributes": {"brightness": 1}}},  # attribute-only change: ignored
            {"platform": "state", "entity_id": "switch.pump", "from_state": {"state": "on"},
             "to_state": {"state": "off", "last_changed": "2026-10-27T10:05:00+00:00", "attributes": {}}},
        ]
        server = FakeHomeAssistant(states, events)
        server.start()
        with tempfile.TemporaryDirectory() as tmp:
            db = Database(os.path.join(tmp, "db.sqlite"))
            db.ensure_schema()
            settings = Settings(os.path.join(tmp, "settings.json"))
            settings.update({"entities": ["switch.pump"]})
            client = ha.HAClient(db, settings, url=f"ws://127.0.0.1:{server.port}/api/websocket", token="secret")
            client.start()
            self.assertTrue(server.done.wait(5))
            deadline = time.time() + 5
            while client.events_logged < 4 and time.time() < deadline:
                time.sleep(0.05)
            client.stop()
            client.join(5)
            logged = sorted(db.events(0, 4_000_000_000_000), key=lambda e: e["id"])  # in order of arrival
            self.assertEqual([(e["source"], e["entity"], e["state"], e["previous"]) for e in logged], [
                ("ha-initial", "switch.pump", "off", None),
                ("ha", "switch.pump", "on", "off"),
                ("ha", "switch.pump", "off", "on"),
                ("ha", "switch.pump", "off", "on"),  # the fragmented repetition
            ])
            self.assertEqual(logged[1]["ms"], ha.parse_iso("2026-10-27T10:00:00+00:00") // 1_000_000)
            self.assertEqual(logged[1]["attributes"], {"friendly_name": "Pump"})
            self.assertEqual(client.status()["entities"], ["switch.pump"])
            subscribe = next(m for m in server.received if m.get("type") == "subscribe_trigger")
            self.assertEqual(subscribe["trigger"], {"platform": "state", "entity_id": ["switch.pump"]})

    def test_bad_token_reports_error(self):
        server = FakeHomeAssistant([], [])
        server.start()
        with tempfile.TemporaryDirectory() as tmp:
            db = Database(os.path.join(tmp, "db.sqlite"))
            db.ensure_schema()
            client = ha.HAClient(db, Settings(os.path.join(tmp, "s.json")), url=f"ws://127.0.0.1:{server.port}/", token="wrong")
            client.start()
            deadline = time.time() + 5
            while not client.last_error and time.time() < deadline:
                time.sleep(0.05)
            client.stop()
            self.assertIn("authentication failed", client.last_error)
            self.assertFalse(client.status()["connected"])


if __name__ == "__main__":
    unittest.main()
