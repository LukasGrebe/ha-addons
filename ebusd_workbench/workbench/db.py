"""SQLite access: the `telegram` table written by the eBUSd app, its `event` table (notes made with
the `log` command of its terminal) and the Workbench's own `ha_state` table.

Two layouts of the telegram table exist: schema version 2 (eBUSd app 26.1.11 and later; `ts` is the
key, data bytes are BLOBs) and version 1 (`id` key, data bytes as hex text). Both are read here.

Times are nanoseconds since the epoch in the database and milliseconds in everything returned from
here (JavaScript numbers hold ms exactly, ns not).
"""

import json
import os
import sqlite3
import threading
import time

NS_PER_MS = 1_000_000
MAX_ATTRIBUTES = 4096  # bytes of JSON attributes stored per state change
MASTER_NIBBLES = (0x0, 0x1, 0x3, 0x7, 0xF)

# The event table exactly as the eBUSd app creates it (ebusd/ebus_sqlite.py, schema version 2), so
# that either app can create it first. user_version is left alone: it belongs to the eBUSd app.
EVENT_SCHEMA = """
CREATE TABLE IF NOT EXISTS event (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,  -- time of the event as given, ns since 1970-01-01 UTC
  ts_min  INTEGER NOT NULL,  -- earliest time it may have happened
  ts_max  INTEGER NOT NULL,  -- latest time it may have happened
  message TEXT,              -- what happened, NULL if only the time was logged
  logged  INTEGER NOT NULL   -- when it was logged, ns since 1970-01-01 UTC
);
CREATE VIEW IF NOT EXISTS event_local AS SELECT
  id,
  strftime('%Y-%m-%d %H:%M:%S', ts / 1000000000, 'unixepoch', 'localtime')
    || printf('.%03d', ts / 1000000 % 1000) AS time_local,
  strftime('%Y-%m-%d %H:%M:%S', ts_min / 1000000000, 'unixepoch', 'localtime')
    || printf('.%03d', ts_min / 1000000 % 1000) AS earliest_local,
  strftime('%Y-%m-%d %H:%M:%S', ts_max / 1000000000, 'unixepoch', 'localtime')
    || printf('.%03d', ts_max / 1000000 % 1000) AS latest_local,
  message,
  strftime('%Y-%m-%d %H:%M:%S', logged / 1000000000, 'unixepoch', 'localtime')
    || printf('.%03d', logged / 1000000 % 1000) AS logged_local,
  ts,
  ts_min,
  ts_max
FROM event;
"""

# Home Assistant entity state changes recorded by the Workbench.
HA_STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS ha_state (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,  -- ns since 1970-01-01 UTC, like telegram.ts
  entity     TEXT NOT NULL,     -- Home Assistant entity id
  state      TEXT,              -- new state
  previous   TEXT,              -- previous state
  attributes TEXT,              -- JSON object with the entity attributes
  source     TEXT NOT NULL      -- ha: state change, ha-initial: state when the subscription started
);
CREATE INDEX IF NOT EXISTS ha_state_ts ON ha_state (ts);
CREATE INDEX IF NOT EXISTS ha_state_entity_ts ON ha_state (entity, ts);
"""


def ms(ns):
    return None if ns is None else ns // NS_PER_MS


def now_ns():
    return time.time_ns()


def hexbyte(value):
    return None if value is None else "%02x" % value


def is_master(address):
    return (address & 0x0F) in MASTER_NIBBLES and (address >> 4) in MASTER_NIBBLES


class Schema:
    """Column expressions for the two layouts of the telegram table."""

    def __init__(self, version2):
        self.version2 = version2
        self.dd = "lower(hex(dd))" if version2 else "dd"
        self.s_dd = "lower(hex(s_dd))" if version2 else "s_dd"
        self.id = "ts" if version2 else "id"
        self.raw = "raw"


NO_VALUE = object()   # filter marker: the column is NULL


class Database:
    def __init__(self, path):
        self.path = path
        self._info_cache = (0, None)
        self._schema_cache = None
        self._lock = threading.Lock()
        self.local = threading.local()   # per request: cancel() -> True when the client is gone

    # -- connection -----------------------------------------------------------

    def connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=10000")
        cancel = getattr(self.local, "cancel", None)
        if cancel is not None:
            # long queries stop when the browser has given up on the request (scrolled on, closed the tab)
            conn.set_progress_handler(lambda: 1 if cancel() else 0, 50000)
        return conn

    def ensure_schema(self):
        """Create the database folder, the event table (as the eBUSd app would) and ha_state."""
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        existed = os.path.exists(self.path)
        conn = self.connect()
        try:
            if not existed:
                conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(EVENT_SCHEMA + HA_STATE_SCHEMA)
            conn.commit()
        finally:
            conn.close()
        self._schema_cache = None

    def exists(self):
        return os.path.exists(self.path)

    def schema(self, conn=None):
        """The telegram table's layout, or None without a telegram table."""
        if self._schema_cache is not None:
            return self._schema_cache or None
        if not self.exists():
            return None
        own = conn is None
        if own:
            conn = self.connect()
        try:
            columns = {row["name"]: (row["type"] or "").upper() for row in conn.execute("PRAGMA table_info(telegram)")}
        finally:
            if own:
                conn.close()
        if not columns:
            return None
        schema = Schema(columns.get("dd") == "BLOB")
        self._schema_cache = schema
        return schema

    def has_telegrams(self, conn=None):
        return self.schema(conn) is not None

    def info(self, max_age=30.0):
        """Summary for the status API; the count is cached because it scans the whole table."""
        with self._lock:
            cached_at, cached = self._info_cache
            if cached and time.monotonic() - cached_at < max_age:
                return cached
        result = {"path": self.path, "exists": self.exists(), "telegrams": 0, "events": 0, "states": 0,
                  "first_ms": None, "last_ms": None, "size": 0, "has_telegram_table": False, "schema_version": None}
        if result["exists"]:
            result["size"] = os.path.getsize(self.path)
            conn = self.connect()
            try:
                result["schema_version"] = conn.execute("PRAGMA user_version").fetchone()[0]
                if self.has_telegrams(conn):
                    result["has_telegram_table"] = True
                    first, last, count = conn.execute("SELECT min(ts), max(ts), count(*) FROM telegram").fetchone()
                    result.update(telegrams=count, first_ms=ms(first), last_ms=ms(last))
                tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
                if "event" in tables:
                    result["events"] = conn.execute("SELECT count(*) FROM event").fetchone()[0]
                if "ha_state" in tables:
                    result["states"] = conn.execute("SELECT count(*) FROM ha_state").fetchone()[0]
            finally:
                conn.close()
        with self._lock:
            self._info_cache = (time.monotonic(), result)
        return result

    # -- telegrams --------------------------------------------------------------

    def count_since(self, since_ms):
        """How many telegrams were recorded after a time (what a browser has not read yet)."""
        if not self.exists():
            return 0
        conn = self.connect()
        try:
            if not self.has_telegrams(conn):
                return 0
            return conn.execute("SELECT count(*) FROM telegram WHERE ts >= ?", (int(since_ms) * NS_PER_MS,)).fetchone()[0]
        finally:
            conn.close()

    def _telegram_select(self, schema):
        return (f"SELECT {schema.id} AS id, ts, qq, zz, pb, sb, nn, {schema.dd} AS dd, crc, ack, s_nn, "
                f"{schema.s_dd} AS s_dd, s_crc, s_ack, status FROM telegram")

    @staticmethod
    def master_hex(r):
        if r["dd"] is None or r["nn"] is None:
            return None
        return "%02x%02x%02x%02x%02x%s" % (r["qq"], r["zz"], r["pb"], r["sb"], r["nn"], r["dd"])

    @staticmethod
    def slave_hex(r):
        if r["s_dd"] is None or r["s_nn"] is None:
            return None
        return "%02x%s" % (r["s_nn"], r["s_dd"])

    def series(self, from_ms, to_ms, qq=None, zz=None, pb=None, sb=None, id_prefix=None, max_points=20000):
        """The complete telegrams of one row over a time range as a time series.

        Returns {"lines": [telegram hex, ...], "points": [[ms, index into lines], ...], "total", "stride"}: every
        telegram is stored once in lines, so that a long series of repeated values stays small. More than
        max_points telegrams are thinned by a fixed stride (the last one is always kept).
        """
        schema = self.schema()
        if schema is None:
            return {"lines": [], "points": [], "total": 0, "stride": 1}
        where = ["ts >= ?", "ts < ?", "status = 'ok'", "dd IS NOT NULL"]
        params = [from_ms * NS_PER_MS, to_ms * NS_PER_MS]
        for column, value in (("qq", qq), ("zz", zz), ("pb", pb), ("sb", sb)):
            if value is NO_VALUE:
                where.append(f"{column} IS NULL")
            elif value is not None:
                where.append(f"{column} = ?")
                params.append(int(value))
        if id_prefix:
            where.append(f"substr({schema.dd}, 1, ?) = ?")
            params += [len(id_prefix), id_prefix]
        conn = self.connect()
        try:
            total = conn.execute(f"SELECT count(*) FROM telegram WHERE {' AND '.join(where)}", params).fetchone()[0]
            stride = max(1, -(-total // max(100, int(max_points))))
            rows = conn.execute(
                f"SELECT ts, qq, zz, pb, sb, nn, {schema.dd} AS dd, s_nn, {schema.s_dd} AS s_dd FROM telegram "
                f"WHERE {' AND '.join(where)} ORDER BY ts", params)
            index, lines, points = {}, [], []
            last = None
            for i, r in enumerate(rows):
                last = r
                if i % stride:
                    continue
                points.append(self._series_point(r, index, lines))
            if last is not None and total and (total - 1) % stride:
                points.append(self._series_point(last, index, lines))
            return {"lines": lines, "points": points, "total": total, "stride": stride}
        finally:
            conn.close()

    def _series_point(self, r, index, lines):
        line = self.master_hex(r) or ""
        slave = self.slave_hex(r)
        if slave:
            line += "/" + slave
        if line not in index:
            index[line] = len(lines)
            lines.append(line)
        return [ms(r["ts"]), index[line]]

    def distinct(self, from_ms, to_ms, limit=2000, only_ok=True):
        """Distinct telegrams (master and slave part) of a window with counts, by first appearance."""
        schema = self.schema()
        if schema is None:
            return []
        where = "ts >= ? AND ts < ?" + (" AND status = 'ok'" if only_ok else "")
        conn = self.connect()
        try:
            rows = conn.execute(
                f"SELECT qq, zz, pb, sb, nn, {schema.dd} AS dd, s_nn, {schema.s_dd} AS s_dd, status, count(*) AS n, "
                f"min(ts) AS t0, max(ts) AS t1 FROM telegram WHERE {where} AND dd IS NOT NULL "
                f"GROUP BY qq, zz, pb, sb, dd, s_nn, s_dd, status ORDER BY t0 LIMIT ?",
                (from_ms * NS_PER_MS, to_ms * NS_PER_MS, max(1, min(50000, int(limit))))).fetchall()
            return [{"master": self.master_hex(r), "slave": self.slave_hex(r), "qq": r["qq"], "zz": r["zz"],
                     "pb": r["pb"], "sb": r["sb"], "status": r["status"], "n": r["n"], "first_ms": ms(r["t0"]),
                     "last_ms": ms(r["t1"])} for r in rows]
        finally:
            conn.close()

    def markers(self, from_ms, to_ms, limit=5000):
        """Notes from the `event` table (the eBUSd terminal's `log` command and the Workbench)."""
        if not self.exists():
            return []
        conn = self.connect()
        try:
            if conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event'").fetchone() is None:
                return []
            rows = conn.execute(
                "SELECT id, ts, ts_min, ts_max, message, logged FROM event "
                "WHERE ts_max >= ? AND ts_min < ? ORDER BY ts, id LIMIT ?",
                (from_ms * NS_PER_MS, to_ms * NS_PER_MS, max(1, min(50000, int(limit))))).fetchall()
            return [{"id": r["id"], "ms": ms(r["ts"]), "ms_min": ms(r["ts_min"]), "ms_max": ms(r["ts_max"]),
                     "message": r["message"], "logged_ms": ms(r["logged"])} for r in rows]
        finally:
            conn.close()

    def add_marker(self, message, ts_ns=None, uncertainty_ns=500_000_000, ts_min_ns=None, ts_max_ns=None):
        """Note an event like the terminal's `log` command: when it happened (ts) and between which times
        (ts_min..ts_max, given as a range or as a symmetric uncertainty). message None: only the time."""
        ts = ts_ns if ts_ns is not None else now_ns()
        low = ts_min_ns if ts_min_ns is not None else ts - uncertainty_ns
        high = ts_max_ns if ts_max_ns is not None else ts + uncertainty_ns
        if not low <= ts <= high:
            raise ValueError("the time must lie between the earliest and the latest time")
        conn = self.connect()
        try:
            with conn:
                cur = conn.execute("INSERT INTO event (ts, ts_min, ts_max, message, logged) VALUES (?, ?, ?, ?, ?)",
                                   (ts, low, high, message or None, now_ns()))
                return cur.lastrowid
        finally:
            conn.close()

    def notes(self, limit=50):
        """The latest notes, newest first (by the time of the event)."""
        if not self.exists():
            return []
        conn = self.connect()
        try:
            if conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event'").fetchone() is None:
                return []
            rows = conn.execute("SELECT id, ts, ts_min, ts_max, message, logged FROM event ORDER BY ts DESC, id DESC LIMIT ?",
                                (max(1, min(500, int(limit))),)).fetchall()
            return [{"id": r["id"], "ms": ms(r["ts"]), "ms_min": ms(r["ts_min"]), "ms_max": ms(r["ts_max"]),
                     "message": r["message"], "logged_ms": ms(r["logged"])} for r in rows]
        finally:
            conn.close()

    def delete_marker(self, event_id):
        conn = self.connect()
        try:
            with conn:
                return conn.execute("DELETE FROM event WHERE id = ?", (int(event_id),)).rowcount > 0
        finally:
            conn.close()

    # -- Home Assistant states ------------------------------------------------------

    def states(self, from_ms, to_ms, limit=5000):
        conn = self.connect()
        try:
            rows = conn.execute(
                "SELECT id, ts, entity, state, previous, attributes, source FROM ha_state "
                "WHERE ts >= ? AND ts < ? ORDER BY ts, id LIMIT ?",
                (from_ms * NS_PER_MS, to_ms * NS_PER_MS, max(1, min(50000, int(limit))))).fetchall()
            return [self._state_dict(r) for r in rows]
        finally:
            conn.close()

    @staticmethod
    def _state_dict(r):
        attributes = None
        if r["attributes"]:
            try:
                attributes = json.loads(r["attributes"])
            except ValueError:
                attributes = None
        return {"id": r["id"], "ms": ms(r["ts"]), "entity": r["entity"], "state": r["state"], "previous": r["previous"],
                "attributes": attributes, "source": r["source"]}

    def last_states(self, entities):
        """Latest recorded state per entity (for avoiding duplicates on re-subscription)."""
        if not entities:
            return {}
        conn = self.connect()
        try:
            result = {}
            for entity in entities:
                row = conn.execute("SELECT state FROM ha_state WHERE entity = ? ORDER BY ts DESC, id DESC LIMIT 1",
                                   (entity,)).fetchone()
                if row is not None:
                    result[entity] = row["state"]
            return result
        finally:
            conn.close()

    def add_state(self, source, entity, state=None, previous=None, attributes=None, ts_ns=None):
        if attributes is not None and not isinstance(attributes, str):
            attributes = json.dumps(attributes, ensure_ascii=False, separators=(",", ":"))
            if len(attributes) > MAX_ATTRIBUTES:
                attributes = None
        conn = self.connect()
        try:
            with conn:
                cur = conn.execute(
                    "INSERT INTO ha_state (ts, entity, state, previous, attributes, source) VALUES (?, ?, ?, ?, ?, ?)",
                    (ts_ns if ts_ns is not None else now_ns(), entity, state, previous, attributes, source))
                return cur.lastrowid
        finally:
            conn.close()

    def state_entities(self):
        """Entities that have recorded state changes, with their counts."""
        conn = self.connect()
        try:
            rows = conn.execute("SELECT entity, count(*) AS n FROM ha_state GROUP BY entity ORDER BY entity").fetchall()
            return [{"entity": r["entity"], "n": r["n"]} for r in rows]
        finally:
            conn.close()
