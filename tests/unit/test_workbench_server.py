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
from workbench.gitrepo import Repo  # noqa: E402
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
        ctx = Context(db, Settings(os.path.join(cls.tmp.name, "settings.json")), Repo(os.path.join(cls.tmp.name, "repo")),
                      deploy_dir=os.path.join(cls.tmp.name, "deploy"), www_dir=www)
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
        self.assertFalse(status["repo"]["exists"])
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
        self.assertEqual(self.request("POST", "/api/events", {"message": ""})[0], 400)
        code, _, body = self.request("PUT", "/api/settings", {"id_overrides": {"08b509": 5}, "layers": ["660", {"ref": "upstream/master"}]})
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["id_overrides"], {"08b509": 5})
        self.assertEqual(json.loads(body)["layers"], [{"ref": "660"}, {"ref": "upstream/master"}])
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

    def test_repo_and_deploy(self):
        self.assertEqual(self.request("GET", "/api/repo/file?path=x")[0], 400)
        code, _, body = self.request("POST", "/api/deploy", {"files": {"a.csv": "type,circuit\n", "sub/b.inc": "x\n"}})
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body)["written"], ["a.csv", "sub/b.inc"])
        self.assertEqual([f["path"] for f in self.get_json("/api/deploy")["files"]], ["a.csv", "sub/b.inc"])
        self.assertEqual(self.request("POST", "/api/deploy", {"files": {"../x.csv": "a"}})[0], 400)


if __name__ == "__main__":
    unittest.main()
