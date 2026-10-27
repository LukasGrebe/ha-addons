"""Unit tests of the Workbench HTTP API (ebusd_workbench/workbench/server.py) over a real socket."""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ebusd_workbench"))
import workbench_fixtures as fx  # noqa: E402
from workbench.db import Database  # noqa: E402
from workbench.sources import Sources  # noqa: E402
from test_workbench_sources import ROUTES, Fetcher  # noqa: E402
from workbench.server import Context, make_server  # noqa: E402
from workbench.settings import Settings  # noqa: E402

NS = 1_000_000_000


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        path = os.path.join(cls.tmp.name, "telegrams.db")
        cls.end_ms = 1_800_000_000_000
        cls.pump = fx.generate(path, days=0.1, end_ns=cls.end_ms * 1_000_000)
        db = Database(path)
        db.ensure_schema()
        fx.add_events(path, cls.pump)
        www = os.path.join(cls.tmp.name, "www")
        os.makedirs(www)
        with open(os.path.join(www, "index.html"), "w") as f:
            f.write("<!doctype html><html><head><title>t</title></head><body>hi</body></html>")
        settings = Settings(os.path.join(cls.tmp.name, "settings.json"))
        cls.fetch = Fetcher(ROUTES)
        ctx = Context(db, settings, Sources(cls.tmp.name, settings, fetch=cls.fetch),
                      deploy_dir=os.path.join(cls.tmp.name, "deploy"), www_dir=www)
        cls.server_ctx = ctx
        cls.server = make_server(ctx, "127.0.0.1", 0)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None, raw=False):
        data = None
        hdrs = dict(headers or {})
        if body is not None:
            data = body.encode() if raw else json.dumps(body).encode()
            hdrs["Content-Type"] = "text/plain" if raw else "application/json"
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as err:
            return err.code, err.headers, err.read()

    def get_json(self, path):
        status, _, body = self.request("GET", path)
        self.assertEqual(status, 200, body)
        return json.loads(body)

    def test_status_and_static(self):
        status = self.get_json("/api/status")
        self.assertEqual(status["db"]["schema_version"], 2)
        self.assertGreater(status["db"]["telegrams"], 100)
        self.assertIn("sources", status["sources"])
        code, headers, body = self.request("GET", "/", headers={"X-Ingress-Path": "/api/hassio_ingress/tok"})
        self.assertEqual(code, 200)
        self.assertIn(b'<base href="/api/hassio_ingress/tok/">', body)
        self.assertEqual(self.request("GET", "/../etc/passwd")[0], 404)
        self.assertEqual(self.request("GET", "/api/nothing")[0], 404)
        self.assertEqual(self.request("DELETE", "/api/status")[0], 405)

    def test_telegrams(self):
        runs = self.get_json(f"/api/telegrams/runs?from={self.end_ms - 3600_000}&to={self.end_ms}")
        self.assertTrue(runs["rows"])
        hist = self.get_json(f"/api/telegrams/histogram?from={self.end_ms - 7200_000}&to={self.end_ms}&bucket=3600")
        self.assertEqual(len(hist["buckets"]), 2)
        distinct = self.get_json(f"/api/telegrams/distinct?from={self.end_ms - 3600_000}&to={self.end_ms}")
        self.assertTrue(all("master" in t for t in distinct["telegrams"]))
        raw = self.get_json(f"/api/telegrams?from={self.end_ms - 3600_000}&to={self.end_ms}&pb=b5&sb=11&limit=5")
        self.assertEqual(len(raw["telegrams"]), 5)
        self.assertEqual(self.request("GET", "/api/telegrams/runs?from=5&to=1")[0], 400)

    def test_telegrams_of_rows_without_address(self):
        # rows of telegrams too broken to tell source or destination are shown as "--" and can be listed
        body = self.get_json(f"/api/telegrams?from={self.end_ms - 86400_000}&to={self.end_ms}&qq=--&zz=--&pb=--&sb=--&limit=5")
        self.assertIsInstance(body["telegrams"], list)
        for t in body["telegrams"]:
            self.assertIsNone(t["qq"])
        self.assertEqual(self.request("GET", f"/api/telegrams?from=0&to=1&qq=zz")[0], 400)

    def test_series_endpoint(self):
        body = self.get_json(f"/api/telegrams/series?from={self.end_ms - 3600_000}&to={self.end_ms}&qq=10&zz=08&pb=b5&sb=10&id=00")
        self.assertEqual(body["total"], len(body["points"]))
        self.assertGreater(body["total"], 100)
        self.assertEqual(body["from_ms"], self.end_ms - 3600_000)

    def test_events_and_settings(self):
        events = self.get_json(f"/api/events?from={self.end_ms - 86400_000}&to={self.end_ms}")
        self.assertEqual(len(events["markers"]), 1)
        self.assertEqual(events["entities"][0]["entity"], "switch.circulation_pump")
        code, _, body = self.request("POST", "/api/events", {"message": "test marker", "ms": self.end_ms - 1000})
        self.assertEqual(code, 200)
        event_id = json.loads(body)["id"]
        self.assertEqual(len(self.get_json(f"/api/events?from={self.end_ms - 86400_000}&to={self.end_ms}")["markers"]), 2)
        self.assertEqual(self.request("DELETE", f"/api/events/{event_id}")[0], 200)
        self.assertEqual(self.request("DELETE", f"/api/events/{event_id}")[0], 404)
        # like the terminal's `log`: a time range ("somewhere between 8:40 and 8:50"), or only a time without a message
        at = self.end_ms - 5000
        code, _, body = self.request("POST", "/api/events", {"message": "Dampf vom Abtauen", "ms": at, "ms_min": at - 600_000, "ms_max": at})
        self.assertEqual(code, 200, body)
        notes = self.get_json("/api/notes?limit=5")["notes"]
        newest = next(n for n in notes if n["message"] == "Dampf vom Abtauen")
        self.assertEqual((newest["ms"], newest["ms_min"], newest["ms_max"]), (at, at - 600_000, at))
        self.assertGreater(newest["logged_ms"], 0)
        code, _, body = self.request("POST", "/api/events", {"message": "", "ms": at - 1})
        self.assertEqual(code, 200)
        self.assertIsNone(next(n for n in self.get_json("/api/notes?limit=20")["notes"] if n["ms"] == at - 1)["message"], "time only")
        self.assertEqual(self.request("POST", "/api/events", {"message": "x", "ms": at, "ms_min": at + 1, "ms_max": at + 2})[0], 400, "the time lies outside its range")
        self.assertEqual(self.request("POST", "/api/events", {"message": "x", "ms_min": at - 1})[0], 400, "a range needs the time")
        for note in self.get_json("/api/notes?limit=50")["notes"]:
            if note["message"] in ("Dampf vom Abtauen", None):
                self.request("DELETE", f"/api/events/{note['id']}")
        code, _, body = self.request("PUT", "/api/settings", {"id_overrides": {"08b509": 5}, "sources": ["660", {"id": "next", "enabled": False}]})
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["id_overrides"], {"08b509": 5})
        self.assertEqual(json.loads(body)["sources"], [{"id": "pr/660", "enabled": True}, {"id": "next", "enabled": False}])
        self.assertEqual(self.request("PUT", "/api/settings", {"entities": "x"})[0], 400)

    def test_rawlog_export(self):
        code, headers, body = self.request("GET", f"/api/export/rawlog?from={self.end_ms - 3600_000}&to={self.end_ms}")
        self.assertEqual(code, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        lines = body.decode().splitlines()
        self.assertGreater(len(lines), 50)
        self.assertRegex(lines[0], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} ([<>][0-9a-f]+)+$")
        self.assertEqual(self.request("GET", "/api/export/rawlog?from=0&to=99999999999999")[0], 400)
        # ebusd's own address comes from the settings unless given: its telegrams are split into direction changes
        own_lines = [l for l in lines if ">" in l]
        self.assertEqual(self.request("PUT", "/api/settings", {"own_address": "10"})[0], 200)
        code, _, body = self.request("GET", f"/api/export/rawlog?from={self.end_ms - 3600_000}&to={self.end_ms}")
        self.assertEqual(code, 200)
        as_10 = [l for l in body.decode().splitlines() if ">" in l]
        self.assertNotEqual(len(own_lines), len(as_10))
        self.assertTrue(all(l.split(" ", 2)[2].startswith(">10") for l in as_10), as_10[:2])
        self.request("PUT", "/api/settings", {"own_address": "31"})

    def test_client_gone_stops_queries(self):
        import socket
        import sqlite3
        from workbench import server as srv
        a, b = socket.socketpair()
        handler = type("H", (), {"connection": a})()
        request = srv.Request(handler, "/api/telegrams/runs", {}, {})
        self.assertFalse(request.client_gone())
        b.close()                     # the browser aborted the fetch
        self.assertTrue(request.client_gone())
        a.close()
        # a connection opened for a request whose client is gone interrupts a long query
        ctx = self.server_ctx
        ctx.db.local.cancel = lambda: True
        try:
            conn = ctx.db.connect()
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 50000000) SELECT count(*) FROM c").fetchone()
            conn.close()
        finally:
            ctx.db.local.cancel = None

    def test_sources(self):
        status = self.get_json("/api/status")
        self.assertIn("sources", status["sources"])
        self.assertEqual(self.request("POST", "/api/sources", {"ref": "ssh://x"})[0], 400)
        code, _, body = self.request("POST", "/api/sources", {"ref": "660", "background": False})
        self.assertEqual(code, 200, body)
        added = json.loads(body)
        self.assertEqual((added["id"], added["state"], added["tree"], added["title"]), ("pr/660", "ready", "tsp", "vaillant: consolidate HW5103"))
        files = self.get_json("/api/sources/files?id=pr%2F660")
        self.assertEqual((files["kind"], sorted(files["files"])), ("tsp", ["de.yaml", "main.tsp", "shared/x_inc.tsp", "vaillant/08.hmu.tsp", "vaillant/15.700.tsp", "vaillant/15.720.tsp", "vaillant/15.730.tsp", "vaillant/shared/x_inc.tsp"]))
        self.assertEqual(self.request("GET", "/api/sources/files?id=release")[0], 400)
        code, _, body = self.request("PUT", "/api/sources/enabled", {"id": "pr/660", "enabled": False})
        self.assertEqual(code, 200, body)
        self.assertFalse(json.loads(body)["enabled"])
        self.assertIn("pr/660", [s["id"] for s in self.get_json("/api/sources")["sources"]])
        self.assertEqual([p["number"] for p in self.get_json("/api/sources/suggest")["pulls"]], [702, 701])
        code, _, body = self.request("POST", "/api/sources/refresh", {"id": "pr/660", "background": False})
        self.assertEqual(code, 200, body)
        self.assertEqual(self.request("DELETE", "/api/sources?id=pr%2F660")[0], 200)
        self.assertNotIn("pr/660", [s["id"] for s in self.get_json("/api/sources")["sources"]])

    def test_error_answers_leave_the_connection_usable(self):
        """A POST to an unknown path (or a rejected one) must not leave its body for the next request on the connection."""
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("POST", "/api/no-such-route", body=json.dumps({"numbers": [1, 2, 3]}), headers={"Content-Type": "application/json"})
            response = conn.getresponse()
            self.assertEqual(response.status, 404)
            response.read()
            conn.request("GET", "/api/health")
            response = conn.getresponse()
            self.assertEqual(response.status, 200, "the second request on the same connection")
            self.assertTrue(json.loads(response.read())["ok"])
            conn.request("POST", "/api/sources", body="not json", headers={"Content-Type": "application/json"})
            response = conn.getresponse()
            self.assertEqual(response.status, 400)
            response.read()
            conn.request("GET", "/api/health")
            self.assertEqual(conn.getresponse().status, 200)
        finally:
            conn.close()

    def test_deploy(self):
        self.assertEqual(self.request("GET", "/api/repo/file?path=x")[0], 404)
        code, _, body = self.request("POST", "/api/deploy", {"files": {"a.csv": "type,circuit\n", "sub/b.inc": "x\n"}})
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body)["written"], ["a.csv", "sub/b.inc"])
        self.assertEqual([f["path"] for f in self.get_json("/api/deploy")["files"]], ["a.csv", "sub/b.inc"])
        self.assertEqual(self.request("POST", "/api/deploy", {"files": {"../x.csv": "a"}})[0], 400)


if __name__ == "__main__":
    unittest.main()
