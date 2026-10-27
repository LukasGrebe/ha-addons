#!/usr/bin/env python3
"""Store every telegram ebusd receives from the eBUS in an SQLite database.

run.sh points ebusd's binary dump (--dump --dumpflush) at a FIFO, so ebusd hands
each byte it receives from the bus to this script as soon as it has it. Every
byte is timestamped on arrival (nanoseconds), the byte stream is split into
telegrams at SYN, and each telegram is decoded into the fields of the eBUS spec:

    QQ ZZ PB SB NN DD.. CRC  ACK  NN DD.. CRC  ACK
    |------ master part ---|     |- slave part -|

One row per telegram is written to the table `telegram`, keyed by its timestamp.
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

SCHEMA_VERSION = 2
SCHEMA = """
CREATE TABLE IF NOT EXISTS telegram (
  ts     INTEGER PRIMARY KEY,  -- arrival of the first byte, ns since 1970-01-01 UTC (unique)
  qq     INTEGER,              -- source address
  zz     INTEGER,              -- destination address
  pb     INTEGER,              -- primary command
  sb     INTEGER,              -- secondary command
  nn     INTEGER,              -- number of data bytes of the master part
  dd     BLOB,                 -- data bytes of the master part
  crc    INTEGER,              -- CRC of the master part
  ack    INTEGER,              -- ACK (0x00) / NAK (0xff) of the destination
  s_nn   INTEGER,              -- number of data bytes of the slave part
  s_dd   BLOB,                 -- data bytes of the slave part
  s_crc  INTEGER,              -- CRC of the slave part
  s_ack  INTEGER,              -- ACK (0x00) / NAK (0xff) of the source for the slave part
  status TEXT NOT NULL,        -- ok, crc, nak, timeout, invalid, escape, trailing
  raw    BLOB                  -- all bytes between the two SYN as on the wire, only if they are not just
                               -- the columns qq to s_ack one after the other (escape sequence, repetition, garbage)
);
CREATE INDEX IF NOT EXISTS telegram_cmd ON telegram (pb, sb, zz, qq);

-- telegram with readable times, bytes in hex, the type, the ebusd notation
-- QQZZPBSBNNDD / NNDD (as used by "ebusctl hex" and "ebusctl grab") and raw
-- also for the telegrams that do not store it.
CREATE VIEW IF NOT EXISTS telegram_hex AS SELECT
  strftime('%Y-%m-%d %H:%M:%S', ts / 1000000000, 'unixepoch')
    || printf('.%09d', ts % 1000000000) AS time_utc,
  strftime('%Y-%m-%d %H:%M:%S', ts / 1000000000, 'unixepoch', 'localtime')
    || printf('.%09d', ts % 1000000000) AS time_local,
  ts, type, qq, zz, pb, sb, nn, dd, crc, ack, s_nn, s_dd, s_crc, s_ack,
  qq || zz || pb || sb || nn || dd AS master,
  s_nn || s_dd AS slave,
  status,
  coalesce(raw, coalesce(qq, '') || coalesce(zz, '') || coalesce(pb, '') || coalesce(sb, '')
    || coalesce(nn, '') || coalesce(dd, '') || coalesce(crc, '') || coalesce(ack, '')
    || coalesce(s_nn, '') || coalesce(s_dd, '') || coalesce(s_crc, '') || coalesce(s_ack, '')) AS raw
FROM (SELECT
  ts,
  CASE WHEN zz IS NULL THEN NULL WHEN zz = 0xfe THEN 'BC'
    WHEN (zz & 0x0f) IN (0x0, 0x1, 0x3, 0x7, 0xf) AND (zz >> 4) IN (0x0, 0x1, 0x3, 0x7, 0xf) THEN 'MM'
    ELSE 'MS' END AS type,
  CASE WHEN qq IS NULL THEN NULL ELSE printf('%02x', qq) END AS qq,
  CASE WHEN zz IS NULL THEN NULL ELSE printf('%02x', zz) END AS zz,
  CASE WHEN pb IS NULL THEN NULL ELSE printf('%02x', pb) END AS pb,
  CASE WHEN sb IS NULL THEN NULL ELSE printf('%02x', sb) END AS sb,
  CASE WHEN nn IS NULL THEN NULL ELSE printf('%02x', nn) END AS nn,
  CASE WHEN dd IS NULL THEN NULL ELSE lower(hex(dd)) END AS dd,
  CASE WHEN crc IS NULL THEN NULL ELSE printf('%02x', crc) END AS crc,
  CASE WHEN ack IS NULL THEN NULL ELSE printf('%02x', ack) END AS ack,
  CASE WHEN s_nn IS NULL THEN NULL ELSE printf('%02x', s_nn) END AS s_nn,
  CASE WHEN s_dd IS NULL THEN NULL ELSE lower(hex(s_dd)) END AS s_dd,
  CASE WHEN s_crc IS NULL THEN NULL ELSE printf('%02x', s_crc) END AS s_crc,
  CASE WHEN s_ack IS NULL THEN NULL ELSE printf('%02x', s_ack) END AS s_ack,
  status,
  CASE WHEN raw IS NULL THEN NULL ELSE lower(hex(raw)) END AS raw
FROM telegram);
"""

COLUMNS = ("ts", "qq", "zz", "pb", "sb", "nn", "dd", "crc", "ack",
           "s_nn", "s_dd", "s_crc", "s_ack", "status", "raw")
WIRE = COLUMNS[1:13]  # the fields qq to s_ack in the order they are sent
# a telegram whose ts is taken is not inserted (rowcount 0), see insert()
INSERT = "INSERT INTO telegram ({}) VALUES ({}) ON CONFLICT (ts) DO NOTHING".format(
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
        t["dd"] = bytes(sym[pos + 5:data_end])
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
        t["s_dd"] = bytes(sym[pos + 1:data_end])
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
        self.rows.append(make_row(self.ts, fields, status, raw))


def make_row(ts, fields, status, raw):
    """Return the table row of a decoded telegram.

    raw is only stored if the fields do not give it back, i.e. if it contains an
    escape sequence, a part repeated after NAK or bytes that do not decode.
    """
    wire = bytearray()
    for name in WIRE:
        value = fields.get(name)
        if value is None:
            break  # the fields of a telegram are always received in this order
        wire += value if isinstance(value, bytes) else bytes([value])
    row = dict(fields, ts=ts, status=status, raw=None if wire == raw else raw)
    return tuple(row.get(column) for column in COLUMNS)


def insert(db, rows):
    """Insert rows in the current transaction.

    ts is the key, but telegrams read from the FIFO at once share their arrival
    time (as may telegrams after the clock was set back): such a telegram gets
    the next free nanosecond.
    """
    for row in rows:
        ts = row[0]
        while db.execute(INSERT, (ts,) + row[1:]).rowcount == 0:
            ts += 1


def open_db(path):
    """Open the database and create the schema if it is new (see upgrade_db for older ones)."""
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
    if version == 0:
        db.executescript(SCHEMA)
        db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    return db


def upgrade_db(db, path):
    """Convert a database of schema version 1 in one transaction.

    Version 1 stored the data bytes and raw as hex text, raw for every telegram,
    the type, an id and four indexes. Returns the number of telegrams converted.
    """
    if db.execute("PRAGMA user_version").fetchone()[0] != 1:
        return 0
    size = os.path.getsize(path)
    log.info("converting %s (%d MB) to the compact format of this version, this may take a few "
             "minutes; telegrams received meanwhile are written afterwards", path, size >> 20)
    started = time.monotonic()
    count = 0
    try:
        db.executescript("BEGIN IMMEDIATE; DROP VIEW IF EXISTS telegram_hex; "
                         "ALTER TABLE telegram RENAME TO telegram_v1;" + SCHEMA)
        select = db.execute("SELECT {} FROM telegram_v1 ORDER BY id".format(", ".join(COLUMNS)))
        while True:
            rows = []
            for values in select.fetchmany(10000):
                t = dict(zip(COLUMNS, values))
                for name in ("dd", "s_dd", "raw"):
                    if t[name] is not None:
                        t[name] = bytes.fromhex(t[name])
                rows.append(make_row(t["ts"], t, t["status"], t["raw"]))
            if not rows:
                break
            insert(db, rows)
            count += len(rows)
        db.execute("DROP TABLE telegram_v1")
        db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        db.commit()
    except BaseException:
        db.rollback()
        raise
    try:
        db.execute("VACUUM")  # give the space of the old table back
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.OperationalError as err:
        log.warning("unable to shrink the database file after converting it: %s", err)
    log.info("converted %d telegrams in %.0f s, the database file has %d MB now (was %d MB)",
             count, time.monotonic() - started, os.path.getsize(path) >> 20, size >> 20)
    return count


def is_locked(err):
    """Whether err says that another program holds the write lock of the database."""
    return isinstance(err, sqlite3.OperationalError) and "locked" in str(err)


def move_aside(db, path):
    """Close the database and rename its files, so that a new one can be started at path.

    Only while no other program has it open: its -wal and -shm files would end up
    with the new database otherwise. Returns the new name.
    """
    try:  # leaving WAL mode needs the database for itself
        mode = db.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
    except sqlite3.OperationalError:
        mode = None
    db.close()
    if mode != "delete":
        raise OSError(f"{path} is open in another program (e.g. Home Assistant's SQL integration)")
    stem, ext = os.path.splitext(path)
    backup = f"{stem}.v1-{time.strftime('%Y%m%d-%H%M%S')}{ext}"
    if os.path.exists(backup):
        raise OSError(f"{backup} exists")
    os.rename(path, backup)
    if os.path.exists(path + "-wal"):  # SQLite removes it when leaving WAL mode
        os.rename(path + "-wal", backup + "-wal")
    if os.path.exists(path + "-shm"):  # only an index of the -wal file, no data
        os.remove(path + "-shm")
    return backup


def upgrade_or_replace_db(db, path):
    """Convert a database of an older version, or keep it aside and start a new one.

    Returns the database to write to. Raises sqlite3.OperationalError if another
    program has the database locked (the conversion has not written anything then,
    so trying again later is cheap), and OSError or sqlite3.Error if the old
    database cannot be kept aside or a new one cannot be started.
    """
    try:
        upgrade_db(db, path)
        return db
    except (OSError, sqlite3.Error, ValueError) as err:
        if is_locked(err):
            raise
        log.error("unable to convert database %s, it is unchanged: %s", path, err)
    backup = move_aside(db, path)
    log.warning("kept the database of the previous version as %s (it is not deleted automatically), "
                "writing telegrams to a new database", backup)
    return open_db(path)


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
                insert(self.db, self.rows)
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
                    "DELETE FROM telegram WHERE ts IN (SELECT ts FROM telegram WHERE ts < ? LIMIT ?)",
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
    # after ebusd was started, so that converting a large database does not delay it
    try:
        db = upgrade_or_replace_db(db, args.db)
    except (OSError, sqlite3.Error) as err:
        if is_locked(err):
            log.warning("database %s is locked by another program, trying again: %s", args.db, err)
            return 1  # run.sh starts the logger again
        log.error("unable to keep the database aside and start a new one, telegrams are not recorded: %s", err)
        return EXIT_CONFIG
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
