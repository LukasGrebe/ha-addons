"""Unit tests of the log command of the terminal (ebusd/ebus_log.py)."""

import contextlib
import datetime
import io
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ebusd"))
import ebus_log as e  # noqa: E402

S = e.SECOND
TZ = os.environ.get("TZ")


def setUpModule():
    os.environ["TZ"] = "Europe/Berlin"
    time.tzset()


def tearDownModule():
    if TZ is None:
        del os.environ["TZ"]
    else:
        os.environ["TZ"] = TZ
    time.tzset()


def local(*args):
    """ns of a local time (Europe/Berlin)."""
    return int(datetime.datetime(*args).timestamp() * 1000) * 10**6


NOW = local(2026, 10, 27, 9, 0, 0, 123000)


class Parse(unittest.TestCase):
    def parse(self, line):
        return e.parse(line.split(), NOW)

    def test_now(self):
        self.assertEqual(self.parse(""), (NOW, NOW, NOW, None))
        self.assertEqual(self.parse("Modus auf Einschaltempfehlung geändert"),
                         (NOW, NOW, NOW, "Modus auf Einschaltempfehlung geändert"))

    def test_time_window_is_its_precision(self):
        ts = local(2026, 10, 27, 8, 52)
        self.assertEqual(self.parse("8:52 Dampf"), (ts, ts, ts + 60 * S, "Dampf"))
        ts = local(2026, 10, 27, 8, 52, 23)
        self.assertEqual(self.parse("08:52:23 Knopf"), (ts, ts, ts + S, "Knopf"))
        ts = local(2026, 10, 27, 8, 52, 23, 250000)
        self.assertEqual(self.parse("8:52:23,25"), (ts, ts, ts + S // 100, None))

    def test_uncertainty(self):
        ts = local(2026, 10, 27, 8, 52, 23)
        for word in ("~1s", "+-1s", "±1s", "-+1000ms", "-1s+1s", "+1s-1s"):
            self.assertEqual(self.parse(f"8:52:23 {word} Modus"), (ts, ts - S, ts + S, "Modus"), word)
        ts = local(2026, 10, 27, 8, 50)
        self.assertEqual(self.parse("8:50 -10m Dampf"), (ts, ts - 600 * S, ts, "Dampf"))
        self.assertEqual(self.parse("8:50 -10min+0,5h"), (ts, ts - 600 * S, ts + 1800 * S, None))
        self.assertEqual(self.parse("+30s"), (NOW, NOW, NOW + 30 * S, None))

    def test_message_like_uncertainty_or_time(self):
        self.assertEqual(self.parse("+5 Grad"), (NOW, NOW, NOW, "+5 Grad"))
        self.assertEqual(self.parse("-5s-5s"), (NOW, NOW, NOW, "-5s-5s"))
        self.assertEqual(self.parse("-- 10:30 Uhr Termin"), (NOW, NOW, NOW, "10:30 Uhr Termin"))
        ts = local(2026, 10, 27, 8, 0)
        self.assertEqual(self.parse("8:00 -- ~1s"), (ts, ts, ts + 60 * S, "~1s"))

    def test_time_still_to_come_is_yesterday(self):
        ts = local(2026, 10, 26, 23, 55)
        self.assertEqual(self.parse("23:55")[0], ts)
        ts = local(2026, 10, 27, 9, 3)
        self.assertEqual(self.parse("9:03")[0], ts)  # a few minutes ahead: other clock

    def test_date(self):
        ts = local(2026, 10, 26, 22, 15)
        for line in ("2026-10-26 22:15", "26.10.2026 22:15", "26.10. 22:15", "2026-10-26T22:15"):
            self.assertEqual(self.parse(line + " Warmwasser"), (ts, ts, ts + 60 * S, "Warmwasser"), line)
        ts = local(2026, 10, 25, 2, 30, 5)  # day of the switch to winter time
        self.assertEqual(self.parse("2026-10-25T02:30:05")[0], ts)

    def test_errors(self):
        for line, error in (("2026-10-26", "a date needs a time"),
                            ("2026-10-26 Warmwasser", "a date needs a time"),
                            ("2026-02-30 8:00", "2026-02-30 is not a valid date"),
                            ("25:00", "25:00 is not a valid time"),
                            ("8:60:00", "8:60:00 is not a valid time"),
                            ("2026-10-28 8:00", "2026-10-28 08:00:00 is in the future")):
            with self.assertRaises(ValueError, msg=line) as raised:
                self.parse(line)
            self.assertIn(error, str(raised.exception))


class Describe(unittest.TestCase):
    def test_describe(self):
        ts = local(2026, 10, 27, 8, 52, 23)
        self.assertEqual(e.describe(ts, ts, ts), "2026-10-27 08:52:23")
        self.assertEqual(e.describe(ts + 412 * 10**6, ts, ts + S),
                         "2026-10-27 08:52:23.412 (between 08:52:23 and 08:52:24)")
        ts = local(2026, 10, 27, 0, 5)
        self.assertEqual(e.describe(ts, ts - 600 * S, ts),
                         "2026-10-27 00:05:00 (between 2026-10-26 23:55:00 and 00:05:00)")


class Command(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "ebusd", "telegrams.db")
        options = os.path.join(self.tmp.name, "options.json")
        with open(options, "w") as file:
            file.write('{"sqlite_db": "%s"}' % self.db)
        patcher = mock.patch.object(e, "OPTIONS", options)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_log(self, *args, answer=None):
        out, err = io.StringIO(), io.StringIO()
        reply = mock.Mock(side_effect=[answer] if isinstance(answer, BaseException) else [answer or ""])
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch("builtins.input", reply):
            code = e.main(list(args))
        self.prompted = reply.called
        return code, out.getvalue(), err.getvalue()

    def events(self):
        db = sqlite3.connect(self.db)
        rows = db.execute("SELECT ts_max - ts_min, message FROM event ORDER BY id").fetchall()
        db.close()
        return rows

    def test_message_from_arguments(self):
        code, out, _ = self.run_log("8:52:23", "~1s", "Modus", "auf", "Einschaltempfehlung", "geändert")
        self.assertEqual(code, 0)
        self.assertFalse(self.prompted)
        self.assertRegex(out, r"^Logged \d{4}-\d\d-\d\d 08:52:23 \(between 08:52:22 and 08:52:24\): "
                              r"Modus auf Einschaltempfehlung geändert\n$")
        self.assertEqual(self.events(), [(2 * S, "Modus auf Einschaltempfehlung geändert")])
        db = sqlite3.connect(self.db)
        view = db.execute("SELECT time_local, earliest_local, latest_local, message FROM event_local").fetchone()
        db.close()
        self.assertEqual(view[1:], (view[0][:11] + "08:52:22.000", view[0][:11] + "08:52:24.000",
                                    "Modus auf Einschaltempfehlung geändert"))
        self.assertTrue(view[0].endswith(" 08:52:23.000"))

    def test_prompt(self):
        code, out, _ = self.run_log(answer="Dampf vom Abtauen ")
        self.assertEqual(code, 0)
        self.assertTrue(self.prompted)
        self.assertIn("logged. What happened?", out)
        self.assertTrue(out.endswith(": Dampf vom Abtauen\n"))
        self.assertEqual(self.events(), [(0, "Dampf vom Abtauen")])

    def test_prompt_time_only(self):
        self.assertEqual(self.run_log("-5m")[0], 0)
        self.assertEqual(self.run_log(answer=EOFError())[0], 0)
        self.assertEqual(self.events(), [(300 * S, None), (0, None)])

    def test_prompt_cancelled(self):
        self.run_log("kept")
        code, out, _ = self.run_log(answer=KeyboardInterrupt())
        self.assertEqual(code, 130)
        self.assertIn("Removed", out)
        self.assertEqual(self.events(), [(0, "kept")])

    def test_time_taken_before_the_prompt(self):
        def answer(prompt):
            time.sleep(0.05)
            return "later"
        before = time.time_ns()
        with contextlib.redirect_stdout(io.StringIO()), mock.patch("builtins.input", answer):
            e.main([])
        db = sqlite3.connect(self.db)
        ts, logged = db.execute("SELECT ts, logged FROM event").fetchone()
        db.close()
        self.assertEqual(ts, logged)
        self.assertLess(ts - before, 50 * 10**6)

    def test_errors(self):
        code, _, err = self.run_log("25:00", "x")
        self.assertEqual((code, err), (1, "log: 25:00 is not a valid time (see log --help)\n"))
        with mock.patch.object(e, "OPTIONS", os.path.join(self.tmp.name, "missing.json")):
            code, _, err = self.run_log("x")
        self.assertEqual(code, 1)
        self.assertIn("no database", err)
        self.assertFalse(os.path.exists(self.db))

    def test_db_argument_and_existing_telegram_log(self):
        other = os.path.join(self.tmp.name, "other.db")
        e.ebus_sqlite.open_db(other).close()  # a database the telegram log created
        self.assertEqual(self.run_log("--db", other, "x")[0], 0)
        db = sqlite3.connect(other)
        self.assertEqual(db.execute("SELECT message FROM event").fetchall(), [("x",)])
        self.assertEqual(db.execute("SELECT count(*) FROM telegram").fetchone(), (0,))
        db.close()
        self.assertFalse(os.path.exists(self.db))

    def test_help(self):
        code, out, _ = self.run_log("--help")
        self.assertEqual(code, 0)
        self.assertIn("usage: log", out)


if __name__ == "__main__":
    unittest.main()
