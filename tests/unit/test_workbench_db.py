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

    def test_histogram(self):
        from_ms, to_ms = self.window(6)
        buckets = self.db.histogram(from_ms, to_ms, 3600)
        self.assertEqual(len(buckets), 6)
        self.assertTrue(all(n > 0 for _, n, _ in buckets))
        self.assertEqual(sum(n for _, n, _ in buckets), self.db.info()["telegrams"])

    def test_runs_collapse_identical_telegrams(self):
        from_ms, to_ms = self.window(1)
        result = self.db.runs(from_ms, to_ms, id_bytes=1, id_overrides={"b509": 3})
        self.assertIsNone(result["bucket_ms"])   # few telegrams: the runs are exact
        rows = {(r["qq"], r["zz"], r["pb"], r["sb"], r["id"]): r for r in result["rows"]}
        # the register poll with a 3 byte ID is one row per register, not one row for all of b509
        self.assertIn((0x31, 0x08, 0xB5, 0x09, "0d0f00"), rows)
        self.assertIn((0x31, 0x08, 0xB5, 0x09, "0d0200"), rows)
        # the controller's mode message changes rarely: few runs with many repetitions, ~10 s apart
        mode = rows[(0x10, 0x08, 0xB5, 0x10, "00")]
        self.assertEqual(mode["n"], 360)
        self.assertLess(len(mode["runs"]), 10)
        longest = max(mode["runs"], key=lambda run: run[2])
        self.assertGreater(longest[2], 50)
        self.assertAlmostEqual(longest[4] / 1000, 10, delta=0.5)  # mean interval in ms
        self.assertRegex(longest[3], r"^0[0-3][0-9a-f]{14}/01/ok$")  # hcmode, temperatures, pump bit / answer / status
        # the broadcast date/time differs every time: one run per telegram
        clock = rows[(0x10, 0xFE, 0xB5, 0x16, "00")]
        self.assertEqual(len(clock["runs"]), clock["n"])
        self.assertTrue(all(run[2] == 1 for run in clock["runs"]))
        # runs do not overlap and cover the row's telegrams
        for row in result["rows"]:
            self.assertEqual(sum(run[2] for run in row["runs"]), row["n"])
            for a, b in zip(row["runs"], row["runs"][1:]):
                self.assertLess(a[1], b[0])

    def test_runs_id_bytes(self):
        from_ms, to_ms = self.window(1)
        one = self.db.runs(from_ms, to_ms, id_bytes=1, id_overrides={})
        keys = {(r["pb"], r["sb"], r["id"]) for r in one["rows"]}
        self.assertIn((0xB5, 0x09, "0d"), keys)  # both registers collapse into one row
        zero = self.db.runs(from_ms, to_ms, id_bytes=0, id_overrides={})
        self.assertTrue(all(r["id"] == "" for r in zero["rows"]))

    def test_runs_id_rules_split_and_combine_per_message(self):
        from_ms, to_ms = self.window(1)
        # default: both registers of b509 collapse into the row "0d"
        base = self.db.runs(from_ms, to_ms, id_bytes=1, id_overrides={})
        ids = {r["id"] for r in base["rows"] if (r["pb"], r["sb"]) == (0xB5, 0x09)}
        self.assertEqual(ids, {"0d"})
        # a rule splits only the telegrams that start with the prefix: register 0d0f00 gets its own row, the rest stays together
        split = self.db.runs(from_ms, to_ms, id_bytes=1, id_overrides={}, id_rules={"08b509:0d0f": 3})
        ids = {r["id"] for r in split["rows"] if (r["pb"], r["sb"]) == (0xB5, 0x09)}
        self.assertEqual(ids, {"0d0f00", "0d"})
        total = lambda result, rid: sum(r["n"] for r in result["rows"] if (r["pb"], r["sb"], r["id"]) == (0xB5, 0x09, rid))
        self.assertEqual(total(split, "0d0f00") + total(split, "0d"), total(base, "0d"))
        # the longest matching prefix wins, and a rule can also combine: ID length 1 for a command a override splits by 3
        both = self.db.runs(from_ms, to_ms, id_bytes=1, id_overrides={"b509": 3}, id_rules={"08b509:0d": 1, "08b509:0d0f": 2})
        ids = {r["id"] for r in both["rows"] if (r["pb"], r["sb"]) == (0xB5, 0x09)}
        self.assertIn("0d", ids)
        self.assertIn("0d0f", ids)
        self.assertNotIn("0d0f00", ids)
        # rules for other commands do not touch this one; garbage is ignored
        other = self.db.runs(from_ms, to_ms, id_bytes=1, id_overrides={}, id_rules={"08b51a:04": 3, "zz": 1, "08b509:0": 1})
        ids = {r["id"] for r in other["rows"] if (r["pb"], r["sb"]) == (0xB5, 0x09)}
        self.assertEqual(ids, {"0d"})

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

    def test_big_windows_are_summed_up_not_cut(self):
        from_ms, to_ms = self.window(6)
        exact = self.db.runs(from_ms, to_ms)
        coarse = self.db.runs(from_ms, to_ms, max_rows=1000, buckets=100)
        self.assertIsNone(exact["bucket_ms"])
        self.assertEqual(coarse["bucket_ms"], -(-(to_ms - from_ms) // 100))
        self.assertEqual(coarse["scanned"], exact["scanned"])               # nothing of the window is left out
        self.assertEqual(coarse["to_ms"], to_ms)
        key = lambda r: (r["qq"], r["zz"], r["pb"], r["sb"], r["id"])
        exact_rows, coarse_rows = {key(r): r for r in exact["rows"]}, {key(r): r for r in coarse["rows"]}
        self.assertEqual(set(exact_rows), set(coarse_rows))                  # every row is there ...
        for k, row in exact_rows.items():
            other = coarse_rows[k]
            self.assertEqual(other["n"], row["n"], k)                        # ... with all its telegrams
            self.assertEqual(other["runs"][-1][1], row["runs"][-1][1], k)    # ... up to its newest one
            self.assertEqual(other["runs"][0][1] >= row["runs"][0][0], True)
            self.assertEqual(sum(run[2] for run in other["runs"]), row["n"], k)
            if len(row["runs"]) == 1:                                        # a value that never changed stays one run of it
                self.assertEqual((len(other["runs"]), other["runs"][0][3], other["runs"][0][6]), (1, row["runs"][0][3], 0), k)
        # a row that changes within a step is a run marked with the number of values: the mode message flips between few values
        changing = [run for r in coarse["rows"] for run in r["runs"] if run[6]]
        self.assertTrue(changing)
        self.assertTrue(all(run[6] > 1 for run in changing))

    def test_telegrams_and_distinct(self):
        from_ms, to_ms = self.window(1)
        rows = self.db.telegrams(from_ms, to_ms, qq=0x10, zz=0x08, pb=0xB5, sb=0x11, id_prefix="01", limit=10)
        self.assertEqual(len(rows), 10)
        self.assertTrue(all(r["master"].startswith("1008b5110101") for r in rows))
        self.assertTrue(all(r["slave"].startswith("09") for r in rows))
        self.assertGreater(rows[0]["ms"], rows[-1]["ms"])  # newest first
        distinct = self.db.distinct(from_ms, to_ms, limit=50)
        self.assertGreater(distinct[0]["n"], distinct[-1]["n"] - 1)
        masters = {d["master"] for d in distinct}
        self.assertIn("1008b5110101", masters)
        broadcast = next(d for d in distinct if d["master"].startswith("10feb5160301"))
        self.assertIsNone(broadcast["slave"])

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

    def test_rawlog(self):
        from_ms, to_ms = self.window(1)
        lines = list(self.db.rawlog(from_ms, to_ms, own_address=0x31))
        self.assertGreater(len(lines), 100)
        self.assertRegex(lines[0], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [<>][0-9a-f]+")
        own = next(l for l in lines if ">3108b509030d0f00" in l)
        self.assertRegex(own.split(" ", 2)[2].strip(), r"^>3108b509030d0f00[0-9a-f]{2}<00[0-9a-f]{8}[0-9a-f]{2}>00$")
        passive = next(l for l in lines if "<1008b5110101" in l)
        self.assertRegex(passive.split(" ", 2)[2].strip(), r"^<1008b5110101[0-9a-f]{2}0009[0-9a-f]{18}[0-9a-f]{2}00$")
        broadcast = next(l for l in lines if "<10feb51608" in l)
        self.assertEqual(len(broadcast.split(" ", 2)[2].strip()), 1 + 2 * (5 + 8 + 1))
        self.assertFalse(any("crc" in l for l in lines))
        with_broken = list(self.db.rawlog(from_ms, to_ms, include_broken=True))
        self.assertGreater(len(with_broken), len(lines))


class WithoutTelegramTable(unittest.TestCase):
    def test_events_only_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Database(os.path.join(tmp, "sub", "new.db"))
            self.assertFalse(db.exists())
            db.ensure_schema()
            self.assertTrue(db.exists())
            self.assertFalse(db.has_telegrams())
            self.assertEqual(db.runs(0, 10_000)["rows"], [])
            self.assertEqual(db.histogram(0, 10_000, 60), [])
            self.assertEqual(db.telegrams(0, 10_000), [])
            db.add_marker("hello")
            self.assertEqual(db.info()["events"], 1)
            # the eBUSd app can still create its table afterwards
            import ebus_sqlite
            ebus_sqlite.open_db(db.path).close()
            self.assertTrue(db.has_telegrams())


if __name__ == "__main__":
    unittest.main()
