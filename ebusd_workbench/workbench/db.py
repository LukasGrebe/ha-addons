"""SQLite access: the `telegram` table written by the eBUSd app and the Workbench's `event` table.

Times are nanoseconds since the epoch in the database (like the eBUSd telegram log) and
milliseconds in everything returned from here (JavaScript numbers hold ms exactly, ns not).
"""

import json
import os
import sqlite3
import threading
import time

NS_PER_MS = 1_000_000
MAX_RUN_ROWS = 300_000  # telegrams scanned per runs() call at most
MAX_ATTRIBUTES = 4096  # bytes of JSON attributes stored per event

EVENT_SCHEMA = """
CREATE TABLE IF NOT EXISTS event (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,  -- ns since 1970-01-01 UTC, like telegram.ts
  source     TEXT NOT NULL,     -- ha: entity state change, ha-initial: state when subscribed, marker: manual
  entity     TEXT,              -- Home Assistant entity id
  state      TEXT,              -- new state
  previous   TEXT,              -- previous state
  attributes TEXT,              -- JSON object with the entity attributes
  note       TEXT               -- free text (markers)
);
CREATE INDEX IF NOT EXISTS event_ts ON event (ts);
CREATE INDEX IF NOT EXISTS event_entity_ts ON event (entity, ts);
"""

TELEGRAM_COLUMNS = "id, ts, type, qq, zz, pb, sb, nn, dd, crc, ack, s_nn, s_dd, s_crc, s_ack, status"


def ms(ns):
    return None if ns is None else ns // NS_PER_MS


def now_ns():
    return time.time_ns()


def hexbyte(value):
    return None if value is None else "%02x" % value


def master_hex(row):
    """QQZZPBSBNNDD as used by ebusd (ebusctl hex, --inject)."""
    if row["dd"] is None or row["nn"] is None:
        return None
    return "%02x%02x%02x%02x%02x%s" % (row["qq"], row["zz"], row["pb"], row["sb"], row["nn"], row["dd"])


def slave_hex(row):
    """NNDD of the slave answer as used by ebusd."""
    if row["s_dd"] is None or row["s_nn"] is None:
        return None
    return "%02x%s" % (row["s_nn"], row["s_dd"])


class Database:
    def __init__(self, path):
        self.path = path
        self._info_cache = (0, None)
        self._lock = threading.Lock()

    # -- connection -----------------------------------------------------------

    def connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    def ensure_schema(self):
        """Create the database folder and the event table; the telegram table belongs to eBUSd."""
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        existed = os.path.exists(self.path)
        conn = self.connect()
        try:
            if not existed:
                conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(EVENT_SCHEMA)
            conn.commit()
        finally:
            conn.close()

    def exists(self):
        return os.path.exists(self.path)

    def has_telegrams(self, conn=None):
        own = conn is None
        if own:
            if not self.exists():
                return False
            conn = self.connect()
        try:
            row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='telegram'").fetchone()
            return row is not None
        finally:
            if own:
                conn.close()

    def info(self, max_age=30.0):
        """Summary for the status API; the count is cached because it scans the whole table."""
        with self._lock:
            cached_at, cached = self._info_cache
            if cached and time.monotonic() - cached_at < max_age:
                return cached
        result = {"path": self.path, "exists": self.exists(), "telegrams": 0, "events": 0,
                  "first_ms": None, "last_ms": None, "size": 0, "has_telegram_table": False}
        if result["exists"]:
            result["size"] = os.path.getsize(self.path)
            conn = self.connect()
            try:
                if self.has_telegrams(conn):
                    result["has_telegram_table"] = True
                    first, last, count = conn.execute("SELECT min(ts), max(ts), count(*) FROM telegram").fetchone()
                    result.update(telegrams=count, first_ms=ms(first), last_ms=ms(last))
                result["events"] = conn.execute("SELECT count(*) FROM event").fetchone()[0]
            finally:
                conn.close()
        with self._lock:
            self._info_cache = (time.monotonic(), result)
        return result

    # -- telegrams --------------------------------------------------------------

    def histogram(self, from_ms, to_ms, bucket_s):
        """Telegram counts per time bucket: [[bucket_start_ms, total, not_ok], ...]."""
        bucket_ns = max(1, int(bucket_s)) * 1_000_000_000
        if not self.has_telegrams():
            return []
        conn = self.connect()
        try:
            rows = conn.execute(
                "SELECT (ts / ?) * ? AS bucket, count(*), sum(status != 'ok') FROM telegram "
                "WHERE ts >= ? AND ts < ? GROUP BY bucket ORDER BY bucket",
                (bucket_ns, bucket_ns, from_ms * NS_PER_MS, to_ms * NS_PER_MS)).fetchall()
            return [[ms(b), n, bad or 0] for b, n, bad in rows]
        finally:
            conn.close()

    def runs(self, from_ms, to_ms, id_bytes=1, id_overrides=None, max_rows=MAX_RUN_ROWS):
        """Group the telegrams of a time window into rows (one per source, destination, command and
        message ID) and collapse consecutive identical values into runs.

        A run is a sequence of telegrams of one row whose data (master payload, slave answer and
        status) did not change: [first_ms, last_ms, count, value, mean_interval_ms, min_interval_ms].
        The message ID is the first id_bytes data bytes of the master part; id_overrides maps
        "pbsb" (e.g. "b509") to another length.
        """
        if not self.has_telegrams():
            return {"rows": [], "scanned": 0, "truncated": False, "from_ms": from_ms, "to_ms": to_ms}
        id_bytes = max(0, min(8, int(id_bytes)))
        cases = []
        params = []
        for pbsb, length in sorted((id_overrides or {}).items()):
            try:
                pb, sb = int(pbsb[0:2], 16), int(pbsb[2:4], 16)
                length = max(0, min(8, int(length)))
            except (ValueError, TypeError, IndexError):
                continue
            cases.append("WHEN pb = ? AND sb = ? THEN ?")
            params += [pb, sb, length * 2]
        id_len = "(CASE %s ELSE ? END)" % " ".join(cases) if cases else "?"
        params.append(id_bytes * 2)
        sql = f"""
WITH t AS (
  SELECT id, ts, qq, zz, pb, sb, status,
         substr(coalesce(dd, ''), 1, {id_len}) AS kid,
         substr(coalesce(dd, ''), {id_len} + 1) || '/' || coalesce(s_dd, '') || '/' || status AS value
  FROM telegram WHERE ts >= ? AND ts < ? ORDER BY ts LIMIT ?
), w AS (
  SELECT *, lag(value) OVER win AS prev, lag(ts) OVER win AS prev_ts FROM t
  WINDOW win AS (PARTITION BY qq, zz, pb, sb, kid ORDER BY ts, id)
), c AS (
  SELECT *, sum(CASE WHEN prev IS NULL OR prev != value THEN 1 ELSE 0 END)
         OVER (PARTITION BY qq, zz, pb, sb, kid ORDER BY ts, id ROWS UNBOUNDED PRECEDING) AS run
  FROM w
)
SELECT qq, zz, pb, sb, kid, min(ts) AS t0, max(ts) AS t1, count(*) AS n, value,
       avg(CASE WHEN prev = value THEN ts - prev_ts END) AS mean_interval,
       min(CASE WHEN prev = value THEN ts - prev_ts END) AS min_interval
FROM c GROUP BY qq, zz, pb, sb, kid, run ORDER BY qq, zz, pb, sb, kid, t0
"""
        params = params + params[:]  # id_len appears twice
        params += [from_ms * NS_PER_MS, to_ms * NS_PER_MS, int(max_rows) + 1]
        conn = self.connect()
        try:
            scanned, last_ts = conn.execute(
                "SELECT count(*), max(ts) FROM (SELECT ts FROM telegram WHERE ts >= ? AND ts < ? ORDER BY ts LIMIT ?)",
                (from_ms * NS_PER_MS, to_ms * NS_PER_MS, int(max_rows) + 1)).fetchone()
            truncated = scanned > max_rows
            if truncated:
                # cut the window where the row limit is reached so that all rows cover the same span
                to_ms = ms(last_ts)
                params[-2] = to_ms * NS_PER_MS
                params[-1] = int(max_rows) + 1
            rows = {}
            for r in conn.execute(sql, params):
                key = (r["qq"], r["zz"], r["pb"], r["sb"], r["kid"])
                entry = rows.get(key)
                if entry is None:
                    entry = rows[key] = {"qq": r["qq"], "zz": r["zz"], "pb": r["pb"], "sb": r["sb"],
                                         "id": r["kid"], "n": 0, "runs": []}
                entry["n"] += r["n"]
                entry["runs"].append([ms(r["t0"]), ms(r["t1"]), r["n"], r["value"],
                                      None if r["mean_interval"] is None else int(r["mean_interval"]) // NS_PER_MS,
                                      ms(r["min_interval"])])
            return {"rows": list(rows.values()), "scanned": min(scanned, max_rows), "truncated": truncated,
                    "from_ms": from_ms, "to_ms": to_ms}
        finally:
            conn.close()

    def telegrams(self, from_ms, to_ms, qq=None, zz=None, pb=None, sb=None, id_prefix=None, limit=500, order="DESC"):
        """Raw telegrams of a window, newest first by default, with ebusd's hex notation added."""
        if not self.has_telegrams():
            return []
        where = ["ts >= ?", "ts < ?"]
        params = [from_ms * NS_PER_MS, to_ms * NS_PER_MS]
        for column, value in (("qq", qq), ("zz", zz), ("pb", pb), ("sb", sb)):
            if value is not None:
                where.append(f"{column} = ?")
                params.append(int(value))
        if id_prefix:
            where.append("substr(dd, 1, ?) = ?")
            params += [len(id_prefix), id_prefix]
        order = "ASC" if str(order).upper() == "ASC" else "DESC"
        conn = self.connect()
        try:
            rows = conn.execute(
                f"SELECT {TELEGRAM_COLUMNS} FROM telegram WHERE {' AND '.join(where)} ORDER BY ts {order}, id {order} LIMIT ?",
                params + [max(1, min(5000, int(limit)))]).fetchall()
            return [self._telegram_dict(r) for r in rows]
        finally:
            conn.close()

    @staticmethod
    def _telegram_dict(r):
        return {"id": r["id"], "ms": ms(r["ts"]), "type": r["type"], "qq": r["qq"], "zz": r["zz"],
                "pb": r["pb"], "sb": r["sb"], "nn": r["nn"], "dd": r["dd"], "ack": hexbyte(r["ack"]),
                "s_nn": r["s_nn"], "s_dd": r["s_dd"], "s_ack": hexbyte(r["s_ack"]), "status": r["status"],
                "master": master_hex(r), "slave": slave_hex(r)}

    def distinct(self, from_ms, to_ms, limit=2000, only_ok=True):
        """Distinct telegrams (master and slave part) of a window with counts, most frequent first."""
        if not self.has_telegrams():
            return []
        where = "ts >= ? AND ts < ?" + (" AND status = 'ok'" if only_ok else "")
        conn = self.connect()
        try:
            rows = conn.execute(
                f"SELECT qq, zz, pb, sb, nn, dd, s_nn, s_dd, status, count(*) AS n, min(ts) AS t0, max(ts) AS t1 "
                f"FROM telegram WHERE {where} AND dd IS NOT NULL "
                f"GROUP BY qq, zz, pb, sb, nn, dd, s_nn, s_dd, status ORDER BY n DESC, t1 DESC LIMIT ?",
                (from_ms * NS_PER_MS, to_ms * NS_PER_MS, max(1, min(20000, int(limit))))).fetchall()
            return [{"master": master_hex(r), "slave": slave_hex(r), "qq": r["qq"], "zz": r["zz"], "pb": r["pb"],
                     "sb": r["sb"], "status": r["status"], "n": r["n"], "first_ms": ms(r["t0"]), "last_ms": ms(r["t1"])}
                    for r in rows]
        finally:
            conn.close()

    # -- events -----------------------------------------------------------------

    def events(self, from_ms, to_ms, limit=5000):
        conn = self.connect()
        try:
            rows = conn.execute(
                "SELECT id, ts, source, entity, state, previous, attributes, note FROM event "
                "WHERE ts >= ? AND ts < ? ORDER BY ts, id LIMIT ?",
                (from_ms * NS_PER_MS, to_ms * NS_PER_MS, max(1, min(50000, int(limit))))).fetchall()
            return [self._event_dict(r) for r in rows]
        finally:
            conn.close()

    @staticmethod
    def _event_dict(r):
        attributes = None
        if r["attributes"]:
            try:
                attributes = json.loads(r["attributes"])
            except ValueError:
                attributes = None
        return {"id": r["id"], "ms": ms(r["ts"]), "source": r["source"], "entity": r["entity"], "state": r["state"],
                "previous": r["previous"], "attributes": attributes, "note": r["note"]}

    def last_states(self, entities):
        """Latest recorded state per entity (for avoiding duplicates on re-subscription)."""
        if not entities:
            return {}
        conn = self.connect()
        try:
            result = {}
            for entity in entities:
                row = conn.execute("SELECT state FROM event WHERE entity = ? AND source LIKE 'ha%' ORDER BY ts DESC, id DESC LIMIT 1",
                                   (entity,)).fetchone()
                if row is not None:
                    result[entity] = row["state"]
            return result
        finally:
            conn.close()

    def add_event(self, source, entity=None, state=None, previous=None, attributes=None, note=None, ts_ns=None):
        if attributes is not None and not isinstance(attributes, str):
            attributes = json.dumps(attributes, ensure_ascii=False, separators=(",", ":"))
            if len(attributes) > MAX_ATTRIBUTES:
                attributes = None
        conn = self.connect()
        try:
            with conn:
                cur = conn.execute(
                    "INSERT INTO event (ts, source, entity, state, previous, attributes, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (ts_ns if ts_ns is not None else now_ns(), source, entity, state, previous, attributes, note))
                return cur.lastrowid
        finally:
            conn.close()

    def delete_event(self, event_id):
        conn = self.connect()
        try:
            with conn:
                return conn.execute("DELETE FROM event WHERE id = ?", (int(event_id),)).rowcount > 0
        finally:
            conn.close()

    def event_entities(self):
        """Entities that have events, with their counts."""
        conn = self.connect()
        try:
            rows = conn.execute("SELECT entity, count(*) AS n FROM event WHERE entity IS NOT NULL GROUP BY entity ORDER BY entity").fetchall()
            return [{"entity": r["entity"], "n": r["n"]} for r in rows]
        finally:
            conn.close()
