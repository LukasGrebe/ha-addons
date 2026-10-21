"""Unit tests of the SQLite telegram log (ebusd/ebus_sqlite.py)."""

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
        self.assertEqual((fields["dd"], fields["crc"], fields["type"]), ("27a915aa", 0x77, "BC"))
        self.assertNotIn("ack", fields)

    def test_master_slave(self):
        raw = part("1008b5110101") + b"\x00" + part("09010203040506070809") + b"\x00"
        fields, status, _ = e.decode_frame(raw, None)
        self.assertEqual((status, fields["type"], fields["dd"]), ("ok", "MS", "01"))
        self.assertEqual((fields["s_nn"], fields["s_dd"], fields["ack"], fields["s_ack"]), (9, "010203040506070809", 0, 0))

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
        self.assertEqual((status, fields["qq"], fields["s_dd"]), ("ok", 0x31, "02"))
        self.assertEqual(e.decode_frame(own[1:], None)[1], "invalid")
        other = part("1008b5110101") + b"\x00" + part("0102") + b"\x00"
        self.assertEqual(e.decode_frame(other, 0x31)[2], other)


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
        self.assertEqual((row(rows, 0)["ts"], row(rows, 0)["status"], row(rows, 0)["raw"]), (100, "ok", broadcast.hex()))
        self.assertEqual((row(rows, 1)["ts"], row(rows, 1)["s_dd"]), (300, "02"))

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
        rows = []
        e.FrameSplitter(None, rows).feed(1792583028779065053, b"\xaa" + part("10feb5050100") + b"\xaa")
        with db:
            db.executemany(e.INSERT, rows)
        view = db.execute("SELECT time_utc, qq, master, status FROM telegram_hex").fetchone()
        self.assertEqual(view, ("2026-10-21 11:43:48.779065053", "10", "10feb5050100", "ok"))
        db.close()
        e.open_db(self.path).close()  # opening an existing database again works

    def test_newer_schema_refused(self):
        e.open_db(self.path).close()
        db = sqlite3.connect(self.path)
        db.execute("PRAGMA user_version=2")
        db.close()
        with self.assertRaises(sqlite3.DatabaseError):
            e.open_db(self.path)

    def test_retention_purges_in_chunks(self):
        db = e.open_db(self.path)
        now = time.time_ns()
        day = 86400 * 10**9
        rows = [(now - (i % 20) * day - 1, "BC", 0x10, 0xFE, 0xB5, 0x05, 1, "00", 0, None, None, None, None, None,
                 "ok", "10feb505010000") for i in range(2000)]
        with db:
            db.executemany(e.INSERT, rows)
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
