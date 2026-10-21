#!/usr/bin/env python3
"""End-to-end tests of the eBUSd app image with simulated eBUS adapters.

The image runs like Supervisor starts it (s6 init, /data/options.json,
Supervisor API at http://supervisor) against
  - a fake Supervisor API (app info, options, optional MQTT service),
  - simulated USB adapters (pseudo terminal, plain and enhanced protocol) and
    network adapters (TCP, plain and enhanced protocol), see fake_bus.py,
  - a Mosquitto broker for the MQTT test.

Usage: sudo python3 tests/e2e/run.py IMAGE [unittest options]
Root is needed for the fake Supervisor API on port 80.
"""

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fake_bus import BROADCAST, MS_MASTER, MS_SLAVE, SLAVE_08_ANSWER, PtyAdapter, TcpAdapter

IMAGE = None
CONTAINER = "ebusd-e2e"
BROKER = "ebusd-e2e-mqtt"
BROKER_IMAGE = "mirror.gcr.io/library/eclipse-mosquitto:2"
BASE_OPTIONS = ["--log=all:notice", "--configpath=/config/e2e"]  # local, empty config: no CDN download
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def app_mounts():
    """Folders as Supervisor mounts them: /data writable, the map entries of
    config.yaml read-only unless marked :rw."""
    mounts = {"data": "rw"}
    in_map = False
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../ebusd/config.yaml")) as config:
        for line in config:
            if not line.startswith(" "):
                in_map = line.startswith("map:")
                continue
            entry = re.match(r"\s+- (\w+)(?::(rw|ro))?\s*$", line)
            if in_map and entry:
                folder = {"addon_config": "config", "app_config": "config"}.get(entry.group(1), entry.group(1))
                mounts[folder] = entry.group(2) or "ro"
    return mounts


MOUNTS = app_mounts()


def docker(*args, check=True, timeout=120):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"docker {' '.join(args)} failed ({result.returncode}): {result.stderr.strip()}")
    return result


class FakeSupervisor:
    """Answers the Supervisor API calls bashio makes in run.sh."""

    def __init__(self):
        self.options = {}
        self.mqtt = None
        supervisor = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                routes = {
                    "/addons/self/info": {"slug": "ebusd", "version": "0.0.0-e2e"},
                    "/addons/self/options/config": supervisor.options,
                }
                if supervisor.mqtt:
                    routes["/services/mqtt"] = supervisor.mqtt
                data = routes.get(self.path)
                body = {"result": "ok", "data": data} if data is not None else {
                    "result": "error", "message": f"{self.path} not available"}
                payload = json.dumps(body).encode()
                self.send_response(200 if data is not None else 400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 80), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class AppTestCase(unittest.TestCase):
    supervisor = None

    @classmethod
    def setUpClass(cls):
        AppTestCase.supervisor = AppTestCase.supervisor or FakeSupervisor()

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ebusd-e2e-")
        for folder in ("data", "config/e2e", "share"):
            os.makedirs(os.path.join(self.tmp, folder))
        with open(os.path.join(self.tmp, "config/e2e/empty.csv"), "w") as csv:
            csv.write("# no message definitions\n")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.addCleanup(docker, "rm", "-f", CONTAINER, check=False)

    def start_app(self, options, mqtt=None, pty=False):
        options = {"seed_mqtt_cfg": False, "commandline_options": BASE_OPTIONS, **options}
        options = {key: value for key, value in options.items() if value is not None}
        with open(os.path.join(self.tmp, "data/options.json"), "w") as file:
            json.dump(options, file)
        self.supervisor.options = options
        self.supervisor.mqtt = mqtt
        args = ["run", "-d", "--name", CONTAINER, "--network", "host",
                "--add-host", "supervisor:127.0.0.1", "-e", "SUPERVISOR_TOKEN=e2e"]
        for folder, mode in MOUNTS.items():
            os.makedirs(os.path.join(self.tmp, folder), exist_ok=True)
            args += ["-v", f"{self.tmp}/{folder}:/{folder}:{mode}"]
        if pty:
            # A PTY can't be passed with --device (each container has its own devpts
            # instance), so share the host's devpts and use the host path as device.
            args += ["-v", "/dev/pts:/dev/pts"]
        docker(*args, IMAGE)

    def logs(self):
        result = docker("logs", CONTAINER, check=False)
        return ANSI.sub("", result.stdout + result.stderr)

    def wait_log(self, pattern, timeout=45):
        """Wait for pattern in the app log and return the matching line."""
        regex = re.compile(pattern)
        deadline = time.monotonic() + timeout
        while True:
            logs = self.logs()
            for line in logs.splitlines():
                if regex.search(line):
                    return line
            if time.monotonic() > deadline:
                self.fail(f"{pattern!r} not in app log within {timeout}s:\n{logs}")
            time.sleep(0.5)

    def ebusctl(self, *args):
        return docker("exec", CONTAINER, "ebusctl", *args, check=False, timeout=60).stdout.strip()

    def check_bus(self, sends=True):
        """ebusd decodes the bus traffic and, when allowed, gets its own telegram answered."""
        self.wait_log(r"signal acquired")
        self.wait_log(r"received unknown BC cmd: " + BROADCAST)
        self.wait_log(rf"received unknown MS cmd: {MS_MASTER} / {MS_SLAVE}")
        if sends:
            self.assertEqual(self.ebusctl("hex", "08b509030d2800"), SLAVE_08_ANSWER)


class Adapters(AppTestCase):
    def run_adapter(self, bus, options):
        self.addCleanup(bus.stop)
        options["commandline_options"] = BASE_OPTIONS + ["--enablehex"]
        self.start_app(options, pty=isinstance(bus, PtyAdapter))
        self.check_bus()

    def test_usb_plain(self):
        bus = PtyAdapter(enhanced_protocol=False)
        self.run_adapter(bus, {"device": bus.path})
        self.wait_log(rf"--device={bus.path} ")

    def test_usb_enhanced(self):
        bus = PtyAdapter(enhanced_protocol=True)
        self.run_adapter(bus, {"network_device": f"enh:{bus.path}"})

    def test_network_enhanced(self):
        bus = TcpAdapter(enhanced_protocol=True)
        self.run_adapter(bus, {"network_device": f"enh:127.0.0.1:{bus.port}"})
        self.assertIn("signal: acquired", self.ebusctl("info"))

    def test_network_plain(self):
        bus = TcpAdapter(enhanced_protocol=False)
        self.run_adapter(bus, {"network_device": f"127.0.0.1:{bus.port}"})


class SqliteLog(AppTestCase):
    """The SQLite telegram log records the simulated bus traffic and ebusd's own telegram."""

    def run_logged(self, bus, options, db_path):
        self.addCleanup(bus.stop)
        started = time.time_ns()
        options.update({"sqlite_db": db_path, "sqlite_retention_days": 10,
                        "commandline_options": BASE_OPTIONS + ["--enablehex"]})
        self.start_app(options, pty=isinstance(bus, PtyAdapter))
        self.wait_log(rf"SQLite telegram log: writing telegrams to {db_path}")
        self.wait_log(r"ebusd --foreground .*--dump --dumpfile=/run/ebusd-sqlite/dump.fifo --dumpflush")
        self.check_bus()
        query = """SELECT type, master, slave, status, ts FROM telegram_hex
                   WHERE master IN (?, ?, ?)"""
        own = "3108b509030d2800"
        expected = {("BC", BROADCAST, None), ("MS", MS_MASTER, MS_SLAVE), ("MS", own, SLAVE_08_ANSWER)}
        deadline = time.monotonic() + 30
        while True:
            db = sqlite3.connect(os.path.join(self.tmp, db_path.lstrip("/")))
            rows = db.execute(query, (BROADCAST, MS_MASTER, own)).fetchall()
            statuses = dict(db.execute("SELECT status, count(*) FROM telegram GROUP BY status").fetchall())
            db.close()
            if expected <= {row[:3] for row in rows} or time.monotonic() > deadline:
                break
            time.sleep(1)
        self.assertLessEqual(expected, {row[:3] for row in rows}, f"rows: {rows}")
        self.assertEqual({row[3] for row in rows}, {"ok"})
        self.assertTrue(all(started < row[4] < time.time_ns() for row in rows))
        self.assertEqual(set(statuses), {"ok"}, f"telegrams per status: {statuses}")

    def test_usb_plain_in_share(self):
        bus = PtyAdapter(enhanced_protocol=False)
        self.run_logged(bus, {"device": bus.path}, "/share/ebusd/telegrams.db")

    def test_network_enhanced_in_config(self):
        # the dump lacks the source address of ebusd's own telegrams here; the log restores it
        bus = TcpAdapter(enhanced_protocol=True)
        self.run_logged(bus, {"network_device": f"enh:127.0.0.1:{bus.port}"}, "/config/telegrams.db")


class Mqtt(AppTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        docker("rm", "-f", BROKER, check=False)
        docker("run", "-d", "--name", BROKER, "--network", "host", BROKER_IMAGE,
               "mosquitto", "-c", "/mosquitto-no-auth.conf", timeout=300)

    @classmethod
    def tearDownClass(cls):
        docker("rm", "-f", BROKER, check=False)

    def test_supervisor_broker_and_seeding(self):
        bus = TcpAdapter()
        self.addCleanup(bus.stop)
        mqtt = {"host": "127.0.0.1", "port": 1883, "ssl": False, "protocol": "3.1.1",
                "username": "e2e-user", "password": "e2e-secret"}
        self.start_app({"seed_mqtt_cfg": True, "network_device": f"enh:127.0.0.1:{bus.port}"}, mqtt=mqtt)
        self.wait_log(r"Seeding default mqtt-hassio.cfg")
        line = self.wait_log(r"ebusd --foreground ")
        for arg in ("--mqtthost=127.0.0.1", "--mqttport=1883", "--mqttuser=<redacted>",
                    "--mqttpass=<redacted>", "--mqttint=/config/mqtt-hassio.cfg", "--mqttjson"):
            self.assertIn(arg, line)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp, "config/mqtt-hassio.cfg")))
        running = docker("exec", BROKER, "mosquitto_sub", "-h", "127.0.0.1", "-t", "ebusd/global/running",
                         "-C", "1", "-W", "45", check=False, timeout=60).stdout.strip()
        self.assertEqual(running, "true")
        self.assertNotIn("e2e-secret", self.logs())


class Startup(AppTestCase):
    def test_defaults_only(self):
        self.start_app({"commandline_options": None})
        self.wait_log(r"MQTT service not available via Supervisor")
        self.wait_log(r"No device configured")
        self.wait_log(r"No commandline_options set")
        self.wait_log(r"ebusd --foreground --updatecheck=off $")

    def test_empty_commandline_options(self):
        self.start_app({"commandline_options": []})
        self.wait_log(r"ebusd --foreground --updatecheck=off $")

    def test_commandline_options_as_string(self):
        self.start_app({"commandline_options": " ".join(BASE_OPTIONS + ["--readonly"])})
        self.wait_log(r"commandline_options is a plain string")
        self.wait_log(r"ebusd --foreground .*--configpath=/config/e2e --readonly")

    def test_log_targets_are_no_duplicates(self):
        self.start_app({"commandline_options": BASE_OPTIONS + ["--log=bus:info"]})
        self.wait_log(r"ebusd --foreground .*--log=all:notice --configpath=/config/e2e --log=bus:info")
        self.assertNotIn("Duplicate flag", self.logs())

    def test_option_warnings(self):
        os.makedirs(os.path.join(self.tmp, "config/nocsv"))
        self.start_app({"loglevel_all": "info", "mqtttopic": "old", "commandline_options": [
            "--configpath=/config/nocsv", "--readonly --pollinterval=30", "--pollinterval=10", "--pollinterval=20",
            "--log=bus:info", "--log=bus:debug"]})
        self.wait_log(r"DEPRECATED CONFIG FIELDS DETECTED: mqtttopic loglevel_all")
        self.wait_log(r"'--readonly --pollinterval=30' looks like multiple flags")
        self.wait_log(r"Duplicate flag in commandline_options: '--pollinterval'")
        self.wait_log(r"Duplicate flag in commandline_options: '--log:bus'")
        self.wait_log(r"--configpath=/config/nocsv contains no CSV files")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    IMAGE = sys.argv.pop(1)
    unittest.main(verbosity=2)
