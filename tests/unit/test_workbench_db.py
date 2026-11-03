"""Unit tests of the Workbench database access (ebusd_workbench/workbench/db.py)."""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ebusd_workbench"))
import workbench_fixtures as fx  # noqa: E402
from workbench.db import Database  # noqa: E402

NS = 1_000_000_000


class TelegramQueries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.path = os.path.join(cls.tmp.name, "telegrams.db")
        cls.end_ns = 1_800_000_000 * NS
        cls.pump = fx.generate(cls.path, days=0.25, end_ns=cls.end_ns)
        cls.db = Database(cls.path)
        cls.db.ensure_schema()
        fx.add_events(cls.path, cls.pump)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def window(self, hours):
        return (self.end_ns // 1_000_000) - hours * 3600_000, self.end_ns // 1_000_000

    def test_info(self):
        info = self.db.info()
        self.assertTrue(info["exists"] and info["has_telegram_table"])
        self.assertGreater(info["telegrams"], 1000)
        self.assertEqual((info["events"], info["states"], info["schema_version"]), (1, len(self.pump), 2))
        self.assertLess(info["last_ms"], self.end_ns // 1_000_000)

    def test_series_of_a_row(self):
        from_ms, to_ms = self.window(1)
        series = self.db.series(from_ms, to_ms, qq=0x10, zz=0x08, pb=0xB5, sb=0x10, id_prefix="00")
        self.assertEqual(series["total"], 360)
        self.assertEqual(series["stride"], 1)
        self.assertEqual(len(series["points"]), 360)
        self.assertLess(len(series["lines"]), 20)            # repeated telegrams are stored once
        times = [p[0] for p in series["points"]]
        self.assertEqual(times, sorted(times))
        self.assertTrue(all(0 <= i < len(series["lines"]) for _, i in series["points"]))
        self.assertTrue(series["lines"][0].startswith("1008b5100"))
        thinned = self.db.series(from_ms, to_ms, qq=0x10, zz=0x08, pb=0xB5, sb=0x10, id_prefix="00", max_points=100)
        self.assertEqual(thinned["stride"], 4)
        self.assertLessEqual(len(thinned["points"]), 91)
        self.assertEqual(thinned["points"][-1][0], series["points"][-1][0])
        self.assertEqual(self.db.series(from_ms, to_ms, qq=0x99)["points"], [])

    def test_distinct_and_count_since(self):
        from_ms, to_ms = self.window(1)
        distinct = self.db.distinct(from_ms, to_ms, limit=50)
        self.assertGreater(distinct[0]["n"], distinct[-1]["n"] - 1)
        masters = {d["master"] for d in distinct}
        self.assertIn("1008b5110101", masters)
        broadcast = next(d for d in distinct if d["master"].startswith("10feb5160301"))
        self.assertIsNone(broadcast["slave"])
        total = self.db.info()["telegrams"]
        self.assertEqual(self.db.count_since(0), total)
        self.assertLess(self.db.count_since(from_ms), total)
        self.assertGreater(self.db.count_since(from_ms), 0)
        self.assertEqual(self.db.count_since(to_ms + 1), 0)

    def test_markers_and_states(self):
        from_ms, to_ms = self.window(6)
        markers = self.db.markers(from_ms, to_ms)
        self.assertEqual(len(markers), 1)
        self.assertEqual(markers[0]["message"], "opened hot water tap")
        self.assertEqual(markers[0]["ms"], self.pump[-1][0] - 60_000)
        self.assertEqual((markers[0]["ms_min"], markers[0]["ms_max"]), (markers[0]["ms"] - 500, markers[0]["ms"] + 500))
        states = self.db.states(from_ms, to_ms)
        self.assertTrue(states)
        pump = [e for e in states if e["entity"] == "switch.circulation_pump"]
        self.assertEqual(pump[0]["attributes"], {"friendly_name": "Circulation pump"})
        self.assertEqual(self.db.last_states(["switch.circulation_pump", "x.y"]), {"switch.circulation_pump": pump[-1]["state"]})
        marker_id = self.db.add_marker("test", uncertainty_ns=0)
        self.assertTrue(self.db.delete_marker(marker_id))
        self.assertFalse(self.db.delete_marker(marker_id))
        self.assertEqual(self.db.state_entities(), [{"entity": "switch.circulation_pump", "n": len(self.pump)}])
        # the eBUSd app's log command finds the same table
        import ebus_sqlite
        conn = ebus_sqlite.open_db(self.path)
        self.assertEqual(conn.execute("SELECT message FROM event_local ORDER BY id").fetchone()[0], "opened hot water tap")
        conn.close()

class WithoutTelegramTable(unittest.TestCase):
    def test_events_only_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Database(os.path.join(tmp, "sub", "new.db"))
            self.assertFalse(db.exists())
            db.ensure_schema()
            self.assertTrue(db.exists())
            self.assertFalse(db.has_telegrams())
            self.assertEqual(db.distinct(0, 10_000), [])
            self.assertEqual(db.count_since(0), 0)
            db.add_marker("hello")
            self.assertEqual(db.info()["events"], 1)
            # the eBUSd app can still create its table afterwards
            import ebus_sqlite
            ebus_sqlite.open_db(db.path).close()
            self.assertTrue(db.has_telegrams())


if __name__ == "__main__":
    unittest.main()
