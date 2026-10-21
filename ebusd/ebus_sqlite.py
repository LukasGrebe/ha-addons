#!/usr/bin/env python3
"""Store every telegram ebusd receives from the eBUS in an SQLite database.

run.sh points ebusd's binary dump (--dump --dumpflush) at a FIFO, so ebusd hands
each byte it receives from the bus to this script as soon as it has it. Every
byte is timestamped on arrival (nanoseconds), the byte stream is split into
telegrams at SYN, and each telegram is decoded into the fields of the eBUS spec:

    QQ ZZ PB SB NN DD.. CRC  ACK  NN DD.. CRC  ACK
    |------ master part ---|     |- slave part -|

One row per telegram is written to the table `telegram`.
"""

import argparse
import fcntl
import logging
import os
import queue
import signal
import sqlite3
import stat
import sys
import threading
import time

SYN = 0xAA
ESC = 0xA9
ACK = 0x00
NAK = 0xFF
BROADCAST = 0xFE

MAX_FRAME = 4096  # bytes without SYN; longer frames can only be noise
PIPE_SIZE = 1 << 20  # FIFO buffer, ~1h of bus traffic at 2400 baud
COMMIT_INTERVAL = 1.0  # seconds
PURGE_INTERVAL = 3600.0  # seconds
PURGE_CHUNK = 10000  # rows per DELETE
SILENCE_WARNING = 60.0  # seconds; an idle bus still has a SYN every ~40ms
EXIT_CONFIG = 2  # run.sh does not restart the logger on this exit code

SCHEMA_VERSION = 1
SCHEMA = """
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

COLUMNS = ("ts", "type", "qq", "zz", "pb", "sb", "nn", "dd", "crc", "ack",
           "s_nn", "s_dd", "s_crc", "s_ack", "status", "raw")
INSERT = "INSERT INTO telegram ({}) VALUES ({})".format(
    ", ".join(COLUMNS), ", ".join("?" * len(COLUMNS)))

log = logging.getLogger("sqlite")


def _crc_table():
    table = []
    for value in range(256):
        for _ in range(8):
            value = ((value << 1) ^ 0x9B) if value & 0x80 else value << 1
        table.append(value & 0xFF)
    return table


CRC_TABLE = _crc_table()  # CRC-8 with polynomial 0x9b as used by eBUS


def crc8(symbols):
    """Return the eBUS CRC of unescaped symbols (calculated over the escaped form)."""
    crc = 0
    for symbol in symbols:
        if symbol == ESC:
            crc = CRC_TABLE[CRC_TABLE[crc] ^ ESC] ^ 0x00
        elif symbol == SYN:
            crc = CRC_TABLE[CRC_TABLE[crc] ^ ESC] ^ 0x01
        else:
            crc = CRC_TABLE[crc] ^ symbol
    return crc


def is_master(address):
    """Return whether address is one of the 25 eBUS master addresses."""
    return (address & 0x0F) in (0x0, 0x1, 0x3, 0x7, 0xF) and (address >> 4) in (0x0, 0x1, 0x3, 0x7, 0xF)


def unescape(raw):
    """Return the symbols of wire bytes, or None on an invalid escape sequence."""
    symbols = bytearray()
    escaped = False
    for byte in raw:
        if escaped:
            if byte not in (0x00, 0x01):
                return None
            symbols.append(ESC if byte == 0x00 else SYN)
            escaped = False
        elif byte == ESC:
            escaped = True
        else:
            symbols.append(byte)
    return symbols  # a dangling ESC is dropped, the telegram is incomplete then anyway


def decode(sym):
    """Decode the symbols between two SYN into telegram fields.

    Returns (fields, status, master_crc_ok). A part repeated after a NAK
    replaces the fields of the first attempt; raw keeps both.
    """
    t = {}
    end = len(sym)
    master_ok = False
    pos = 0
    for attempt in range(2):  # the master part is repeated once after a NAK
        t.clear()
        master_ok = False
        if pos >= end:
            return t, "timeout", master_ok
        if not is_master(sym[pos]):
            return t, "invalid", master_ok
        t["qq"] = sym[pos]
        if pos + 1 >= end:
            return t, "timeout", master_ok
        zz = sym[pos + 1]
        if zz in (SYN, ESC):
            return t, "invalid", master_ok
        t["zz"] = zz
        t["type"] = "BC" if zz == BROADCAST else "MM" if is_master(zz) else "MS"
        for offset, name in ((2, "pb"), (3, "sb"), (4, "nn")):
            if pos + offset >= end:
                return t, "timeout", master_ok
            t[name] = sym[pos + offset]
        data_end = pos + 5 + t["nn"]
        if data_end >= end:
            return t, "timeout", master_ok
        t["dd"] = sym[pos + 5:data_end].hex()
        t["crc"] = sym[data_end]
        master_ok = t["crc"] == crc8(sym[pos:data_end])
        pos = data_end + 1
        if zz == BROADCAST:
            return t, (("ok" if pos == end else "trailing") if master_ok else "crc"), master_ok
        if pos >= end:
            return t, "timeout", master_ok
        t["ack"] = sym[pos]
        pos += 1
        if t["ack"] == NAK and attempt == 0:
            continue
        if t["ack"] == NAK:
            return t, "nak", master_ok
        if t["ack"] != ACK:
            return t, "invalid", master_ok
        if not master_ok:
            return t, "crc", master_ok
        break
    if t["type"] == "MM":
        return t, ("ok" if pos == end else "trailing"), master_ok
    for attempt in range(2):  # the slave part is repeated once after a NAK
        for name in ("s_nn", "s_dd", "s_crc", "s_ack"):
            t.pop(name, None)
        if pos >= end:
            return t, "timeout", master_ok
        start = pos
        t["s_nn"] = sym[pos]
        data_end = pos + 1 + t["s_nn"]
        if data_end >= end:
            return t, "timeout", master_ok
        t["s_dd"] = sym[pos + 1:data_end].hex()
        t["s_crc"] = sym[data_end]
        slave_ok = t["s_crc"] == crc8(sym[start:data_end])
        pos = data_end + 1
        if pos >= end:
            return t, "timeout", master_ok
        t["s_ack"] = sym[pos]
        pos += 1
        if t["s_ack"] == NAK and attempt == 0:
            continue
        if t["s_ack"] == NAK:
            return t, "nak", master_ok
        if t["s_ack"] != ACK:
            return t, "invalid", master_ok
        if not slave_ok:
            return t, "crc", master_ok
        break
    return t, ("ok" if pos == end else "trailing"), master_ok


def decode_frame(raw, own_address):
    """Return (fields, status, raw) for the wire bytes between two SYN.

    With an enhanced adapter, ebusd reports the source address of its own
    telegrams as sent instead of received, so it is missing in the dump. If a
    frame only decodes with a valid master CRC after prepending ebusd's own
    address, that address is restored.
    """
    sym = unescape(raw)
    if sym is None:
        return {}, "escape", raw
    fields, status, master_ok = decode(sym)
    if not master_ok and own_address is not None and sym:
        own_fields, own_status, own_master_ok = decode(bytes([own_address]) + sym)
        if own_master_ok:
            return own_fields, own_status, bytes([own_address]) + raw
    return fields, status, raw


class FrameSplitter:
    """Collects bytes into frames delimited by SYN and decodes complete frames."""

    def __init__(self, own_address, rows):
        self.own_address = own_address
        self.rows = rows
        self.synced = False  # bytes before the first SYN belong to an unknown frame start
        self.frame = bytearray()
        self.ts = 0

    def feed(self, ts, data):
        for byte in data:
            if byte == SYN:
                if self.synced and self.frame:
                    self.emit()
                self.frame.clear()
                self.synced = True
                continue
            if not self.synced:
                continue
            if not self.frame:
                self.ts = ts
            self.frame.append(byte)
            if len(self.frame) >= MAX_FRAME:
                self.emit()
                self.frame.clear()
                self.synced = False

    def emit(self):
        fields, status, raw = decode_frame(bytes(self.frame), self.own_address)
        row = dict(fields, ts=self.ts, status=status, raw=raw.hex())
        self.rows.append(tuple(row.get(column) for column in COLUMNS))


def open_db(path):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    if not os.access(directory, os.W_OK):
        raise OSError(f"folder {directory} is not writable (mounted read-only?)")
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")  # readers do not block the logger and vice versa
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("PRAGMA busy_timeout=5000")
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version > SCHEMA_VERSION:
        raise sqlite3.DatabaseError(
            f"{path} has schema version {version}, this app only knows up to {SCHEMA_VERSION}")
    db.executescript(SCHEMA)
    db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    return db


def open_fifo(path):
    if not stat.S_ISFIFO(os.stat(path).st_mode):
        raise OSError(f"{path} is not a FIFO")
    # Opening read-write never blocks and never sees EOF, so ebusd may close and
    # reopen its end (e.g. "ebusctl dump" twice) without disturbing the reader.
    fd = os.open(path, os.O_RDWR)
    try:
        fcntl.fcntl(fd, fcntl.F_SETPIPE_SZ, PIPE_SIZE)
    except OSError as err:
        log.debug("keeping default FIFO size: %s", err)
    return fd


def read_fifo(fd, chunks):
    """Reader thread: timestamp bytes the moment they arrive, nothing else."""
    while True:
        data = os.read(fd, 4096)
        chunks.put((time.time_ns(), data))


class Logger:
    def __init__(self, db, retention_days):
        self.db = db
        self.retention_ns = retention_days * 86400 * 1_000_000_000
        self.rows = []
        self.next_flush = time.monotonic() + COMMIT_INTERVAL
        self.next_purge = time.monotonic()
        self.purging = False
        self.last_error_log = 0.0

    def flush(self):
        if not self.rows:
            return
        try:
            with self.db:
                self.db.executemany(INSERT, self.rows)
        except sqlite3.OperationalError as err:  # locked or disk full: keep rows and retry
            if time.monotonic() - self.last_error_log >= 60:
                log.warning("unable to write %d telegrams, will retry: %s", len(self.rows), err)
                self.last_error_log = time.monotonic()
            return
        self.rows.clear()

    def purge_step(self):
        """Delete one chunk of telegrams older than the retention period."""
        cutoff = time.time_ns() - self.retention_ns
        try:
            with self.db:
                deleted = self.db.execute(
                    "DELETE FROM telegram WHERE id IN (SELECT id FROM telegram WHERE ts < ? LIMIT ?)",
                    (cutoff, PURGE_CHUNK)).rowcount
        except sqlite3.OperationalError as err:
            log.warning("unable to delete old telegrams, will retry: %s", err)
            deleted = 0
        if deleted < PURGE_CHUNK:
            self.purging = False
            self.next_purge = time.monotonic() + PURGE_INTERVAL

    def tick(self):
        now = time.monotonic()
        if now >= self.next_flush:
            self.flush()
            self.next_flush = now + COMMIT_INTERVAL
        if self.retention_ns and (self.purging or now >= self.next_purge):
            self.purging = True
            self.purge_step()


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--fifo", required=True, help="FIFO ebusd writes its binary dump to")
    parser.add_argument("--db", required=True, help="SQLite database file")
    parser.add_argument("--retention-days", type=int, default=0,
                        help="delete telegrams older than this many days (0: keep all)")
    parser.add_argument("--own-address", type=lambda value: int(value, 16),
                        help="ebusd's own master address in hex (restores it for enhanced adapters)")
    parser.add_argument("--ready-file", help="file to create once the FIFO is open")
    args = parser.parse_args()
    if args.retention_days < 0:
        parser.error("--retention-days must not be negative")
    if args.own_address is not None and not is_master(args.own_address):
        parser.error(f"--own-address {args.own_address:02x} is not a master address")
    return args


def main():
    logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                        format="[%(asctime)s] %(levelname)s: SQLite telegram log: %(message)s",
                        datefmt="%H:%M:%S")
    args = parse_args()
    try:
        db = open_db(args.db)
    except (OSError, sqlite3.Error) as err:
        log.error("unable to open database %s: %s", args.db, err)
        return EXIT_CONFIG
    try:
        fd = open_fifo(args.fifo)
    except OSError as err:
        log.error("unable to open FIFO %s: %s", args.fifo, err)
        return EXIT_CONFIG

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    sys.setswitchinterval(0.0005)  # let the reader thread take the GIL quickly for precise timestamps

    chunks = queue.SimpleQueue()
    threading.Thread(target=read_fifo, args=(fd, chunks), name="fifo", daemon=True).start()
    if args.ready_file:
        open(args.ready_file, "w").close()
    log.info("writing telegrams to %s (retention: %s)", args.db,
             f"{args.retention_days} days" if args.retention_days else "keep all")

    logger = Logger(db, args.retention_days)
    splitter = FrameSplitter(args.own_address, logger.rows)
    last_data = time.monotonic()
    silent = False
    while not stop.is_set():
        try:
            ts, data = chunks.get(timeout=0.5)
        except queue.Empty:
            if not silent and time.monotonic() - last_data >= SILENCE_WARNING:
                log.warning("no data from ebusd for %d seconds (no bus signal, or dump toggled off "
                            "with \"ebusctl dump\"?)", SILENCE_WARNING)
                silent = True
        else:
            splitter.feed(ts, data)
            last_data = time.monotonic()
            if silent:
                log.info("receiving data from ebusd again")
                silent = False
        logger.tick()
    logger.flush()
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
