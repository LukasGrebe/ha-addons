"""Unit tests of the SQLite telegram log (ebusd/ebus_sqlite.py)."""

import glob
import os
import sqlite3
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ebusd"))
import ebus_sqlite as e  # noqa: E402


def escape(symbols):
    out = bytearray()
    for symbol in symbols:
        if symbol == e.ESC:
            out += b"\xa9\x00"
        elif symbol == e.SYN:
            out += b"\xa9\x01"
        else:
            out.append(symbol)
    return bytes(out)


def part(hexstr):
    """Telegram part (master or slave) with its CRC."""
    data = bytes.fromhex(hexstr)
    return data + bytes([e.crc8(data)])


def row(rows, index):
    return dict(zip(e.COLUMNS, rows[index]))


def frames():
    """Wire bytes between two SYN of all kinds of telegrams, and whether raw is stored for them."""
    bad_master = bytearray(part("1008b5110101"))
    bad_master[-1] ^= 0xFF
    bad_broadcast = bytearray(part("10feb516080003181021100626"))
    bad_broadcast[-1] ^= 1
    return [
        (part("10feb5050100"), False),  # broadcast
        (escape(bytes.fromhex("10feb5050427a915aa") + b"\x77"), True),  # with escape sequences
        (part("1008b5110101") + b"\x00" + part("0102") + b"\x00", False),  # master-slave
        (part("1003b5040100") + b"\x00", False),  # master-master
        (bytes(bad_master) + b"\xff" + part("1008b5110101") + b"\x00" + part("0102") + b"\x00", True),  # NAK, repeated
        (part("1008b5110101") + b"\x00", False),  # no answer
        (bytes.fromhex("1008b5110301"), True),  # ends within the data bytes
        (bytes(bad_broadcast), False),  # CRC error
        (bytes.fromhex("08b509"), True),  # invalid source address
        (bytes.fromhex("10fea902"), True),  # invalid escape sequence
        (part("10feb5050100") + b"\x12", True),  # trailing byte
    ]


# schema of the previous version, to test the conversion
V1_SCHEMA = """
CREATE TABLE IF NOT EXISTS telegram (
  id     INTEGER PRIMARY KEY,
  ts     INTEGER NOT NULL,  -- arrival of the first byte, ns since 1970-01-01 UTC
  type   TEXT,              -- BC broadcast, MM master-master, MS master-slave
  qq     INTEGER,           -- source address
  zz     INTEGER,           -- destination address
  pb     INTEGER,           -- primary command
  sb     INTEGER,           -- secondary command
  nn     INTEGER,           -- number of data bytes of the master part
  dd     TEXT,              -- data bytes of the master part (hex)
  crc    INTEGER,           -- CRC of the master part
  ack    INTEGER,           -- ACK (0x00) / NAK (0xff) of the destination
  s_nn   INTEGER,           -- number of data bytes of the slave part
  s_dd   TEXT,              -- data bytes of the slave part (hex)
  s_crc  INTEGER,           -- CRC of the slave part
  s_ack  INTEGER,           -- ACK (0x00) / NAK (0xff) of the source for the slave part
  status TEXT NOT NULL,     -- ok, crc, nak, timeout, invalid, escape, trailing
  raw    TEXT NOT NULL      -- all bytes between the two SYN as on the wire (hex)
);
CREATE INDEX IF NOT EXISTS telegram_ts ON telegram (ts);
CREATE INDEX IF NOT EXISTS telegram_qqzzpbsb ON telegram (qq, zz, pb, sb, ts);
CREATE INDEX IF NOT EXISTS telegram_zzpbsb ON telegram (zz, pb, sb, ts);
CREATE INDEX IF NOT EXISTS telegram_pbsb ON telegram (pb, sb, ts);

-- telegram with readable times, single bytes in hex and the ebusd notation
-- QQZZPBSBNNDD / NNDD (as used by "ebusctl hex" and "ebusctl grab").
CREATE VIEW IF NOT EXISTS telegram_hex AS SELECT
  id,
  strftime('%Y-%m-%d %H:%M:%S', ts / 1000000000, 'unixepoch')
    || printf('.%09d', ts % 1000000000) AS time_utc,
  strftime('%Y-%m-%d %H:%M:%S', ts / 1000000000, 'unixepoch', 'localtime')
    || printf('.%09d', ts % 1000000000) AS time_local,
  ts,
  type,
  CASE WHEN qq IS NULL THEN NULL ELSE printf('%02x', qq) END AS qq,
  CASE WHEN zz IS NULL THEN NULL ELSE printf('%02x', zz) END AS zz,
  CASE WHEN pb IS NULL THEN NULL ELSE printf('%02x', pb) END AS pb,
  CASE WHEN sb IS NULL THEN NULL ELSE printf('%02x', sb) END AS sb,
  CASE WHEN nn IS NULL THEN NULL ELSE printf('%02x', nn) END AS nn,
  dd,
  CASE WHEN crc IS NULL THEN NULL ELSE printf('%02x', crc) END AS crc,
  CASE WHEN ack IS NULL THEN NULL ELSE printf('%02x', ack) END AS ack,
  CASE WHEN s_nn IS NULL THEN NULL ELSE printf('%02x', s_nn) END AS s_nn,
  s_dd,
  CASE WHEN s_crc IS NULL THEN NULL ELSE printf('%02x', s_crc) END AS s_crc,
  CASE WHEN s_ack IS NULL THEN NULL ELSE printf('%02x', s_ack) END AS s_ack,
  CASE WHEN dd IS NULL THEN NULL ELSE printf('%02x%02x%02x%02x%02x', qq, zz, pb, sb, nn) || dd END AS master,
  CASE WHEN s_dd IS NULL THEN NULL ELSE printf('%02x', s_nn) || s_dd END AS slave,
  status,
  raw
FROM telegram;
"""
V1_COLUMNS = ("ts", "type", "qq", "zz", "pb", "sb", "nn", "dd", "crc", "ack",
              "s_nn", "s_dd", "s_crc", "s_ack", "status", "raw")


def v1_row(ts, fields, status, raw):
    """Row as the previous version wrote it."""
    t = dict(fields, ts=ts, status=status, raw=raw.hex())
    for name in ("dd", "s_dd"):
        if name in t:
            t[name] = t[name].hex()
    return tuple(t.get(column) for column in V1_COLUMNS)


class Decode(unittest.TestCase):
    def test_crc_and_escape_match_ebusd(self):
        # test vector of ebusd's src/lib/ebus/test/test_symbol.cpp
        self.assertEqual(e.crc8(bytes.fromhex("10feb5050427a915aa")), 0x77)
        self.assertEqual(e.unescape(bytes.fromhex("10feb5050427a90015a901")), bytes.fromhex("10feb5050427a915aa"))

    def test_broadcast_with_escaped_bytes(self):
        raw = escape(bytes.fromhex("10feb5050427a915aa") + b"\x77")
        fields, status, _ = e.decode_frame(raw, None)
        self.assertEqual(status, "ok")
        self.assertEqual((fields["qq"], fields["zz"], fields["pb"], fields["sb"], fields["nn"]), (0x10, 0xFE, 0xB5, 0x05, 4))
        self.assertEqual((fields["dd"], fields["crc"], fields["type"]), (bytes.fromhex("27a915aa"), 0x77, "BC"))
        self.assertNotIn("ack", fields)

    def test_master_slave(self):
        raw = part("1008b5110101") + b"\x00" + part("09010203040506070809") + b"\x00"
        fields, status, _ = e.decode_frame(raw, None)
        self.assertEqual((status, fields["type"], fields["dd"]), ("ok", "MS", b"\x01"))
        self.assertEqual((fields["s_nn"], fields["s_dd"], fields["ack"], fields["s_ack"]), (9, bytes(range(1, 10)), 0, 0))

    def test_master_master(self):
        fields, status, _ = e.decode_frame(part("1003b5040100") + b"\x00", None)
        self.assertEqual((status, fields["type"], fields["ack"]), ("ok", "MM", 0))

    def test_master_part_repeated_after_nak(self):
        bad = bytearray(part("1008b5110101"))
        bad[-1] ^= 0xFF
        raw = bytes(bad) + b"\xff" + part("1008b5110101") + b"\x00" + part("0102") + b"\x00"
        fields, status, _ = e.decode_frame(raw, None)
        self.assertEqual((status, fields["crc"]), ("ok", e.crc8(bytes.fromhex("1008b5110101"))))

    def test_slave_part_nak_twice(self):
        raw = part("1008b5110101") + b"\x00" + part("0102") + b"\xff" + part("0102") + b"\xff"
        fields, status, _ = e.decode_frame(raw, None)
        self.assertEqual((status, fields["s_ack"]), ("nak", 0xFF))

    def test_timeout(self):
        fields, status, _ = e.decode_frame(part("1008b5110101") + b"\x00", None)
        self.assertEqual((status, fields["ack"]), ("timeout", 0))
        self.assertNotIn("s_nn", fields)
        fields, status, _ = e.decode_frame(bytes.fromhex("1008b5"), None)
        self.assertEqual((status, fields["pb"]), ("timeout", 0xB5))
        self.assertNotIn("sb", fields)

    def test_crc_error(self):
        bad = bytearray(part("10feb516080003181021100626"))
        bad[-1] ^= 1
        self.assertEqual(e.decode_frame(bytes(bad), None)[1], "crc")

    def test_invalid_escape_trailing(self):
        self.assertEqual(e.decode_frame(bytes.fromhex("08b509"), None)[1], "invalid")
        self.assertEqual(e.decode_frame(bytes.fromhex("10fea902"), None)[1], "escape")
        self.assertEqual(e.decode_frame(part("1008b5110101") + b"\x55", None)[1], "invalid")
        self.assertEqual(e.decode_frame(part("10feb5050100") + b"\x12", None)[1], "trailing")

    def test_own_address_restored(self):
        # enhanced adapters report the QQ of ebusd's own telegrams as sent: missing in the dump
        broadcast = part("31feb5050100")
        fields, status, raw = e.decode_frame(broadcast[1:], 0x31)
        self.assertEqual((status, fields["qq"], raw), ("ok", 0x31, broadcast))
        own = part("3108b5090124") + b"\x00" + part("0102") + b"\x00"
        fields, status, _ = e.decode_frame(own[1:], 0x31)
        self.assertEqual((status, fields["qq"], fields["s_dd"]), ("ok", 0x31, b"\x02"))
        self.assertEqual(e.decode_frame(own[1:], None)[1], "invalid")
        other = part("1008b5110101") + b"\x00" + part("0102") + b"\x00"
        self.assertEqual(e.decode_frame(other, 0x31)[2], other)


class Rows(unittest.TestCase):
    def test_raw_only_stored_if_fields_do_not_give_it_back(self):
        for wire, stored in frames():
            fields, status, raw = e.decode_frame(wire, None)
            self.assertEqual(dict(zip(e.COLUMNS, e.make_row(1, fields, status, raw)))["raw"],
                             wire if stored else None, wire.hex())
        own = part("31feb5050100")
        self.assertIsNone(row([e.make_row(1, *e.decode_frame(own[1:], 0x31))], 0)["raw"])


class Splitter(unittest.TestCase):
    def test_frames_and_timestamps(self):
        rows = []
        splitter = e.FrameSplitter(None, rows)
        broadcast = part("10feb5050100")
        master_slave = part("1008b5110101") + b"\x00" + part("0102") + b"\x00"
        splitter.feed(1, b"\x10\x08")  # before the first SYN: start unknown, dropped
        splitter.feed(2, b"\xaa\xaa")
        for index, byte in enumerate(broadcast):
            splitter.feed(100 + index, bytes([byte]))
        splitter.feed(200, b"\xaa")
        splitter.feed(300, master_slave + b"\xaa\xaa")
        self.assertEqual(len(rows), 2)
        self.assertEqual((row(rows, 0)["ts"], row(rows, 0)["status"], row(rows, 0)["raw"]), (100, "ok", None))
        self.assertEqual((row(rows, 1)["ts"], row(rows, 1)["s_dd"]), (300, b"\x02"))

    def test_overlong_frame(self):
        rows = []
        splitter = e.FrameSplitter(None, rows)
        splitter.feed(1, b"\xaa" + b"\x11" * (e.MAX_FRAME + 10) + b"\xaa" + part("10feb5050100") + b"\xaa")
        self.assertEqual([row(rows, i)["status"] for i in range(len(rows))], ["invalid", "ok"])


class Database(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "sub", "telegrams.db")

    def tearDown(self):
        self.tmp.cleanup()

    def test_schema_and_view(self):
        db = e.open_db(self.path)
        ts = 1792583028779065053
        rows = [e.make_row(ts + index, *e.decode_frame(wire, None)) for index, (wire, _) in enumerate(frames())]
        own = part("31feb5050100")
        rows.append(e.make_row(ts + 100, *e.decode_frame(own[1:], 0x31)))
        with db:
            e.insert(db, rows)
        view = db.execute("SELECT time_utc, type, qq, nn, dd, master, slave, status, raw FROM telegram_hex "
                          "ORDER BY ts").fetchall()
        self.assertEqual(view[0], ("2026-10-21 11:43:48.779065053", "BC", "10", "01", "00", "10feb5050100", None,
                                   "ok", part("10feb5050100").hex()))
        self.assertEqual(view[2][1:8], ("MS", "10", "01", "01", "1008b5110101", "0102", "ok"))
        self.assertEqual(view[3][1], "MM")
        self.assertEqual(view[6][3:8], ("03", None, None, None, "timeout"))
        self.assertEqual(view[8][1:3], (None, None))
        # the view gives back raw of every telegram, whether it is stored or not
        self.assertEqual([raw for *_, raw in view], [wire.hex() for wire, _ in frames()] + [own.hex()])
        db.close()
        e.open_db(self.path).close()  # opening an existing database again works

    def test_same_arrival_time(self):
        db = e.open_db(self.path)
        rows = []
        e.FrameSplitter(None, rows).feed(1000, b"\xaa" + (part("10feb5050100") + b"\xaa") * 3)
        logger = e.Logger(db, 0)
        logger.rows.extend(rows + rows[:1])  # and a ts that is already taken
        logger.flush()
        self.assertEqual(db.execute("SELECT ts FROM telegram").fetchall(), [(1000,), (1001,), (1002,), (1003,)])
        db.close()

    def test_queries_use_key_and_index(self):
        db = e.open_db(self.path)

        def plan(where):
            return " ".join(row[-1] for row in db.execute("EXPLAIN QUERY PLAN SELECT * FROM telegram " + where))
        self.assertIn("INTEGER PRIMARY KEY", plan("WHERE ts > 0 AND status != 'ok'"))
        self.assertIn("telegram_cmd", plan("WHERE pb = 0xb5 AND sb = 0x16"))
        latest = plan("WHERE qq = 0x31 AND zz = 0x08 AND pb = 0xb5 AND sb = 0x09 ORDER BY ts DESC LIMIT 20")
        self.assertIn("telegram_cmd", latest)
        self.assertNotIn("TEMP B-TREE", latest)
        db.close()

    def test_newer_schema_refused(self):
        e.open_db(self.path).close()
        db = sqlite3.connect(self.path)
        db.execute("PRAGMA user_version=3")
        db.close()
        with self.assertRaises(sqlite3.DatabaseError):
            e.open_db(self.path)

    def create_v1(self, rows):
        os.makedirs(os.path.dirname(self.path))
        db = sqlite3.connect(self.path)
        db.executescript(V1_SCHEMA)
        db.execute("PRAGMA user_version=1")
        with db:
            db.executemany("INSERT INTO telegram ({}) VALUES ({})".format(
                ", ".join(V1_COLUMNS), ", ".join("?" * len(V1_COLUMNS))), rows)
        return db

    def test_upgrade_from_version_1(self):
        ts = 1792583028779065053
        rows = [v1_row(ts + 10 * index, *e.decode_frame(wire, None)) for index, (wire, _) in enumerate(frames())]
        rows.append(v1_row(ts, *e.decode_frame(part("31feb5050100")[1:], 0x31)))  # same ts as the first
        columns = "ts, type, qq, zz, pb, sb, nn, dd, crc, ack, s_nn, s_dd, s_crc, s_ack, master, slave, status, raw"
        db = self.create_v1(rows)
        before = db.execute(f"SELECT {columns} FROM telegram_hex ORDER BY id").fetchall()
        db.close()

        db = e.open_db(self.path)
        self.assertEqual(e.upgrade_db(db, self.path), len(rows))
        after = db.execute(f"SELECT {columns} FROM telegram_hex").fetchall()
        before[-1] = (ts + 1,) + before[-1][1:]  # the ts of the first is taken
        self.assertEqual(sorted(after), sorted(before))
        self.assertEqual(db.execute("SELECT count(raw) FROM telegram").fetchone()[0],
                         sum(stored for _, stored in frames()))
        self.assertEqual(db.execute("SELECT type, name FROM sqlite_master ORDER BY name").fetchall(),
                         [("table", "event"), ("view", "event_local"), ("table", "telegram"),
                          ("index", "telegram_cmd"), ("view", "telegram_hex")])
        self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], e.SCHEMA_VERSION)
        self.assertEqual(e.upgrade_db(db, self.path), 0)
        db.close()

    def create_unconvertible_v1(self):
        rows = [v1_row(1, *e.decode_frame(part("10feb5050100"), None)),
                ("2", "BC", 0x10, 0xFE, 0xB5, 0x05, 1, "zz", 0, None, None, None, None, None, "ok", "10fe")]
        db = self.create_v1(rows)
        db.execute("PRAGMA journal_mode=WAL")  # as the previous version left it
        db.close()

    def assert_unchanged_v1(self):
        db = sqlite3.connect(self.path)
        self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT count(*) FROM telegram_hex WHERE id").fetchone()[0], 2)
        db.close()
        self.assertEqual(self.backups(), [])

    def backups(self):
        return glob.glob(os.path.join(os.path.dirname(self.path), "telegrams.v1-*"))

    def test_failed_upgrade_leaves_database_unchanged(self):
        self.create_unconvertible_v1()
        db = e.open_db(self.path)
        with self.assertRaises(ValueError):
            e.upgrade_db(db, self.path)
        self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT count(*) FROM telegram_hex WHERE id").fetchone()[0], 2)
        self.assertEqual(db.execute("SELECT count(*) FROM sqlite_master WHERE name = 'telegram_v1'").fetchone()[0], 0)
        db.close()

    def test_unconvertible_database_kept_aside(self):
        self.create_unconvertible_v1()
        db = e.upgrade_or_replace_db(e.open_db(self.path), self.path)
        e.insert(db, [e.make_row(3, *e.decode_frame(part("10feb5050100"), None))])
        db.commit()
        self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], e.SCHEMA_VERSION)
        self.assertEqual(db.execute("SELECT count(*) FROM telegram").fetchone()[0], 1)
        db.close()
        backups = self.backups()
        self.assertEqual(len(backups), 1, backups)  # no -wal or -shm beside it
        old = sqlite3.connect(backups[0])
        self.assertEqual(old.execute("PRAGMA user_version").fetchone()[0], 1)
        self.assertEqual(old.execute("SELECT count(*) FROM telegram_hex WHERE id").fetchone()[0], 2)
        old.close()

    def test_not_kept_aside_while_open_elsewhere(self):
        self.create_unconvertible_v1()
        reader = sqlite3.connect(self.path)  # e.g. Home Assistant's SQL integration
        reader.execute("SELECT count(*) FROM telegram").fetchone()
        with self.assertRaises(OSError):
            e.upgrade_or_replace_db(e.open_db(self.path), self.path)
        reader.close()
        self.assert_unchanged_v1()

    def test_locked_database_tried_again_later(self):
        self.create_unconvertible_v1()
        writer = sqlite3.connect(self.path, isolation_level=None)
        writer.execute("BEGIN IMMEDIATE")
        db = e.open_db(self.path)
        db.execute("PRAGMA busy_timeout=0")
        with self.assertRaises(sqlite3.OperationalError) as caught:
            e.upgrade_or_replace_db(db, self.path)
        self.assertTrue(e.is_locked(caught.exception))
        writer.rollback()
        writer.close()
        db.close()
        self.assert_unchanged_v1()

    def test_retention_purges_in_chunks(self):
        db = e.open_db(self.path)
        now = time.time_ns()
        day = 86400 * 10**9
        fields, status, raw = e.decode_frame(part("10feb5050100"), None)
        rows = [e.make_row(now - (i % 20) * day - 1 - i, fields, status, raw) for i in range(2000)]
        with db:
            e.insert(db, rows)
        chunk, e.PURGE_CHUNK = e.PURGE_CHUNK, 100
        try:
            logger = e.Logger(db, 10)
            logger.tick()
            while logger.purging:
                logger.tick()
        finally:
            e.PURGE_CHUNK = chunk
        count, oldest = db.execute("SELECT count(*), min(ts) FROM telegram").fetchone()
        self.assertEqual(count, 1000)
        self.assertLess(now - oldest, 10 * day)
        db.close()


if __name__ == "__main__":
    unittest.main()
