"""Home Assistant connection: a small WebSocket client (RFC 6455, standard library only) and the
logger that subscribes to state changes of selected entities and stores them as events.

Inside the app container the Core WebSocket API is ws://supervisor/core/websocket and the REST
API http://supervisor/core/api, both authenticated with the SUPERVISOR_TOKEN.
"""

import base64
import hashlib
import json
import logging
import os
import socket
import ssl
import struct
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

log = logging.getLogger("ha")

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA
MAX_FRAME = 64 * 1024 * 1024


class WebSocketError(Exception):
    pass


def encode_frame(opcode, payload=b"", mask=True, fin=True):
    """Encode one frame; client frames are masked as the RFC requires."""
    header = bytearray([(0x80 if fin else 0) | (opcode & 0x0F)])
    length = len(payload)
    mask_bit = 0x80 if mask else 0
    if length < 126:
        header.append(mask_bit | length)
    elif length < 65536:
        header.append(mask_bit | 126)
        header += struct.pack("!H", length)
    else:
        header.append(mask_bit | 127)
        header += struct.pack("!Q", length)
    if not mask:
        return bytes(header) + payload
    key = os.urandom(4)
    masked = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    return bytes(header) + key + masked


def decode_frame(read):
    """Decode one frame using read(n) (which must return exactly n bytes or raise).

    Returns (fin, opcode, payload).
    """
    b0, b1 = read(2)
    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    if length == 126:
        (length,) = struct.unpack("!H", read(2))
    elif length == 127:
        (length,) = struct.unpack("!Q", read(8))
    if length > MAX_FRAME:
        raise WebSocketError(f"frame of {length} bytes too large")
    key = read(4) if masked else None
    payload = read(length) if length else b""
    if key:
        payload = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    return fin, opcode, payload


def accept_key(key):
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()


class WebSocket:
    """A blocking WebSocket client connection for text messages."""

    def __init__(self, url, headers=None, timeout=30.0):
        self.url = url
        self.headers = headers or {}
        self.timeout = timeout
        self.sock = None
        self._buffer = b""

    def connect(self):
        parts = urllib.parse.urlsplit(self.url)
        if parts.scheme not in ("ws", "wss"):
            raise WebSocketError(f"unsupported URL scheme in {self.url}")
        host = parts.hostname
        port = parts.port or (443 if parts.scheme == "wss" else 80)
        path = (parts.path or "/") + (("?" + parts.query) if parts.query else "")
        sock = socket.create_connection((host, port), timeout=self.timeout)
        if parts.scheme == "wss":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        host_header = host if port in (80, 443) else f"{host}:{port}"
        lines = [f"GET {path} HTTP/1.1", f"Host: {host_header}", "Upgrade: websocket", "Connection: Upgrade",
                 f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
        lines += [f"{k}: {v}" for k, v in self.headers.items()]
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        self.sock = sock
        response = self._read_until(b"\r\n\r\n")
        status_line, _, header_text = response.partition(b"\r\n")
        status = status_line.split(b" ")
        if len(status) < 2 or status[1] != b"101":
            sock.close()
            self.sock = None
            raise WebSocketError(f"handshake failed: {status_line.decode(errors='replace')}")
        headers = {}
        for line in header_text.decode(errors="replace").split("\r\n"):
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip()
        if headers.get("sec-websocket-accept") != accept_key(key):
            sock.close()
            self.sock = None
            raise WebSocketError("handshake failed: bad Sec-WebSocket-Accept")

    def _read_until(self, marker):
        while marker not in self._buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WebSocketError("connection closed during handshake")
            self._buffer += chunk
            if len(self._buffer) > 65536:
                raise WebSocketError("handshake response too large")
        data, _, self._buffer = self._buffer.partition(marker)
        return data

    def _read_exact(self, n):
        while len(self._buffer) < n:
            chunk = self.sock.recv(max(4096, n - len(self._buffer)))
            if not chunk:
                raise WebSocketError("connection closed")
            self._buffer += chunk
        data, self._buffer = self._buffer[:n], self._buffer[n:]
        return data

    def send(self, opcode, payload=b""):
        if self.sock is None:
            raise WebSocketError("not connected")
        self.sock.sendall(encode_frame(opcode, payload))

    def send_text(self, text):
        self.send(OP_TEXT, text.encode())

    def send_json(self, obj):
        self.send_text(json.dumps(obj))

    def ping(self):
        self.send(OP_PING, b"wb")

    def recv_text(self):
        """Return the next text message, or None when the peer closed the connection.

        Pings are answered, pongs skipped; raises socket.timeout when nothing arrives in time.
        """
        message = bytearray()
        message_opcode = None
        while True:
            fin, opcode, payload = decode_frame(self._read_exact)
            if opcode == OP_PING:
                self.send(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                try:
                    self.send(OP_CLOSE, payload[:2])
                except OSError:
                    pass
                return None
            if opcode in (OP_TEXT, OP_BINARY):
                message_opcode = opcode
                message = bytearray(payload)
            elif opcode == OP_CONT and message_opcode is not None:
                message += payload
            else:
                raise WebSocketError(f"unexpected opcode {opcode}")
            if len(message) > MAX_FRAME:
                raise WebSocketError("message too large")
            if fin:
                if message_opcode == OP_BINARY:
                    message_opcode = None
                    continue  # HA sends text only
                return message.decode(errors="replace")

    def close(self):
        sock, self.sock = self.sock, None
        if sock is not None:
            try:
                sock.sendall(encode_frame(OP_CLOSE, struct.pack("!H", 1000)))
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass


def parse_iso(value):
    """HA's ISO timestamps (e.g. 2026-10-27T10:00:00.123456+00:00) to ns since the epoch."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1_000_000) * 1000
    except ValueError:
        return None


class HAClient(threading.Thread):
    """Subscribes to state changes of the configured entities and logs them as events.

    Reconnects with a backoff; the entity list can be changed at runtime with resubscribe().
    """

    def __init__(self, db, settings, url=None, token=None, rest_url=None):
        super().__init__(name="ha", daemon=True)
        self.db = db
        self.settings = settings  # object with .entities (list of str)
        self.url = url or os.environ.get("WORKBENCH_HA_WS", "ws://supervisor/core/websocket")
        self.rest_url = rest_url or os.environ.get("WORKBENCH_HA_URL", "http://supervisor/core/api")
        self.token = token if token is not None else os.environ.get("SUPERVISOR_TOKEN", "")
        self.ws = None
        self.connected = False
        self.last_error = None
        self.last_event_ms = None
        self.subscribed = []
        self.events_logged = 0
        self._stop = threading.Event()
        self._reconnect = threading.Event()
        self._next_id = 1
        self._states_cache = (0.0, [])

    # -- public -------------------------------------------------------------------

    def status(self):
        return {"configured": bool(self.token), "connected": self.connected, "last_error": self.last_error,
                "entities": list(self.subscribed), "last_event_ms": self.last_event_ms,
                "events_logged": self.events_logged}

    def resubscribe(self):
        """Apply a changed entity list by reconnecting."""
        self._reconnect.set()
        ws = self.ws
        if ws is not None:
            ws.close()

    def stop(self):
        self._stop.set()
        ws = self.ws
        if ws is not None:
            ws.close()

    def states(self, max_age=30.0):
        """All entity states from the REST API (for the entity picker), cached."""
        cached_at, cached = self._states_cache
        if cached and time.monotonic() - cached_at < max_age:
            return cached
        request = urllib.request.Request(self.rest_url.rstrip("/") + "/states",
                                         headers={"Authorization": f"Bearer {self.token}"})
        with urllib.request.urlopen(request, timeout=15) as response:
            data = json.loads(response.read().decode())
        result = [{"entity_id": s.get("entity_id"), "state": s.get("state"),
                   "name": (s.get("attributes") or {}).get("friendly_name") or s.get("entity_id")} for s in data]
        result.sort(key=lambda s: s["entity_id"] or "")
        self._states_cache = (time.monotonic(), result)
        return result

    # -- thread -------------------------------------------------------------------

    def run(self):
        if not self.token:
            self.last_error = "no SUPERVISOR_TOKEN: not running as Home Assistant app"
            log.warning("%s, entity logging disabled", self.last_error)
            return
        backoff = 5
        while not self._stop.is_set():
            self._reconnect.clear()
            try:
                self._session()
                backoff = 5
            except (OSError, WebSocketError, ValueError) as err:
                self.last_error = str(err) or err.__class__.__name__
                log.warning("connection to Home Assistant failed: %s", self.last_error)
            finally:
                self.connected = False
                if self.ws is not None:
                    self.ws.close()
                    self.ws = None
            if self._stop.is_set():
                break
            if self._reconnect.is_set():
                continue  # entity list changed: reconnect right away
            self._stop.wait(backoff)
            backoff = min(backoff * 2, 60)

    def _send(self, message):
        message["id"] = self._next_id
        self._next_id += 1
        self.ws.send_json(message)
        return message["id"]

    def _session(self):
        self.ws = WebSocket(self.url, timeout=30.0)
        self.ws.connect()
        self._next_id = 1
        message = json.loads(self.ws.recv_text() or "{}")
        if message.get("type") != "auth_required":
            raise WebSocketError(f"unexpected first message {message.get('type')}")
        self.ws.send_json({"type": "auth", "access_token": self.token})
        message = json.loads(self.ws.recv_text() or "{}")
        if message.get("type") != "auth_ok":
            raise WebSocketError(f"authentication failed: {message.get('message') or message.get('type')}")
        self.connected = True
        self.last_error = None
        entities = sorted(set(self.settings.entities))
        self.subscribed = entities
        subscription = None
        if entities:
            subscription = self._send({"type": "subscribe_trigger",
                                       "trigger": {"platform": "state", "entity_id": entities}})
            states_id = self._send({"type": "get_states"})
        else:
            states_id = None
        log.info("connected to Home Assistant, logging %d entities", len(entities))
        idle = 0
        while not self._stop.is_set() and not self._reconnect.is_set():
            try:
                text = self.ws.recv_text()
            except socket.timeout:
                idle += 1
                if idle > 2:
                    raise WebSocketError("no answer to ping")
                self.ws.ping()
                continue
            idle = 0
            if text is None:
                raise WebSocketError("connection closed by Home Assistant")
            message = json.loads(text)
            if message.get("type") == "result":
                if message.get("id") == states_id and message.get("success"):
                    self._log_initial_states(message.get("result") or [], entities)
                elif not message.get("success", True):
                    error = message.get("error") or {}
                    raise WebSocketError(f"request failed: {error.get('message') or error}")
            elif message.get("type") == "event" and message.get("id") == subscription:
                self._log_trigger((message.get("event") or {}).get("variables", {}).get("trigger") or {})

    def _log_initial_states(self, states, entities):
        """Record the current state of the subscribed entities unless it is already the latest event."""
        wanted = set(entities)
        last = self.db.last_states(entities)
        for state in states:
            entity = state.get("entity_id")
            if entity not in wanted:
                continue
            if last.get(entity) == state.get("state"):
                continue
            self.db.add_event("ha-initial", entity=entity, state=state.get("state"), previous=last.get(entity),
                              attributes=state.get("attributes"))
            self.events_logged += 1

    def _log_trigger(self, trigger):
        entity = trigger.get("entity_id")
        to_state = trigger.get("to_state") or {}
        from_state = trigger.get("from_state") or {}
        if not entity or not to_state:
            return
        new, old = to_state.get("state"), from_state.get("state")
        if new == old and from_state:
            return  # attribute-only change
        ts = parse_iso(to_state.get("last_changed"))
        self.db.add_event("ha", entity=entity, state=new, previous=old, attributes=to_state.get("attributes"),
                          ts_ns=ts)
        self.events_logged += 1
        self.last_event_ms = (ts or time.time_ns()) // 1_000_000
