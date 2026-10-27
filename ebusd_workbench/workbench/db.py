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
MAX_RUN_ROWS = 300_000  # telegrams scanned per runs() call at most
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


def telegram_type(zz):
    if zz is None:
        return None
    return "BC" if zz == 0xFE else "MM" if is_master(zz) else "MS"


def escape(data):
    """eBUS byte stuffing: the symbols A9 and AA are sent as A9 00 and A9 01."""
    out = bytearray()
    for byte in data:
        if byte == 0xA9:
            out += b"\xa9\x00"
        elif byte == 0xAA:
            out += b"\xa9\x01"
        else:
            out.append(byte)
    return bytes(out)


class Schema:
    """Column expressions for the two layouts of the telegram table."""

    def __init__(self, version2):
        self.version2 = version2
        self.dd = "lower(hex(dd))" if version2 else "dd"
        self.s_dd = "lower(hex(s_dd))" if version2 else "s_dd"
        self.id = "ts" if version2 else "id"
        self.raw = "raw"


class Database:
    def __init__(self, path):
        self.path = path
        self._info_cache = (0, None)
        self._schema_cache = None
        self._lock = threading.Lock()

    # -- connection -----------------------------------------------------------

    def connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=10000")
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

    @staticmethod
    def _id_length_sql(id_bytes, id_overrides):
        """SQL expression for the message ID length in hex digits and its parameters.

        id_overrides maps "pbsb" or "zzpbsb" (hex) to a length in bytes; the more specific one wins.
        """
        cases, params = [], []
        for key, length in sorted((id_overrides or {}).items(), key=lambda kv: -len(kv[0])):
            try:
                key = key.lower()
                length = max(0, min(8, int(length)))
                if len(key) == 6:
                    cases.append("WHEN zz = ? AND pb = ? AND sb = ? THEN ?")
                    params += [int(key[0:2], 16), int(key[2:4], 16), int(key[4:6], 16), length * 2]
                elif len(key) == 4:
                    cases.append("WHEN pb = ? AND sb = ? THEN ?")
                    params += [int(key[0:2], 16), int(key[2:4], 16), length * 2]
            except (ValueError, TypeError):
                continue
        params.append(max(0, min(8, int(id_bytes))) * 2)
        return ("(CASE %s ELSE ? END)" % " ".join(cases) if cases else "?"), params

    def runs(self, from_ms, to_ms, id_bytes=1, id_overrides=None, max_rows=MAX_RUN_ROWS):
        """Group the telegrams of a time window into rows (one per source, destination, command and
        message ID) and collapse consecutive identical values into runs.

        A run is a sequence of telegrams of one row whose data (master payload, slave answer and
        status) did not change: [first_ms, last_ms, count, value, mean_interval_ms, min_interval_ms].
        """
        schema = self.schema()
        if schema is None:
            return {"rows": [], "scanned": 0, "truncated": False, "from_ms": from_ms, "to_ms": to_ms}
        id_len, id_params = self._id_length_sql(id_bytes, id_overrides)
        sql = f"""
WITH t AS (
  SELECT {schema.id} AS id, ts, qq, zz, pb, sb, status,
         substr(coalesce({schema.dd}, ''), 1, {id_len}) AS kid,
         substr(coalesce({schema.dd}, ''), {id_len} + 1) || '/' || coalesce({schema.s_dd}, '') || '/' || status AS value
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
        params = id_params + id_params  # the ID length expression appears twice
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

    def _telegram_select(self, schema):
        return (f"SELECT {schema.id} AS id, ts, qq, zz, pb, sb, nn, {schema.dd} AS dd, crc, ack, s_nn, "
                f"{schema.s_dd} AS s_dd, s_crc, s_ack, status FROM telegram")

    def telegrams(self, from_ms, to_ms, qq=None, zz=None, pb=None, sb=None, id_prefix=None, limit=500, order="DESC"):
        """Raw telegrams of a window, newest first by default, with ebusd's hex notation added."""
        schema = self.schema()
        if schema is None:
            return []
        where = ["ts >= ?", "ts < ?"]
        params = [from_ms * NS_PER_MS, to_ms * NS_PER_MS]
        for column, value in (("qq", qq), ("zz", zz), ("pb", pb), ("sb", sb)):
            if value is not None:
                where.append(f"{column} = ?")
                params.append(int(value))
        if id_prefix:
            where.append(f"substr({schema.dd}, 1, ?) = ?")
            params += [len(id_prefix), id_prefix]
        order = "ASC" if str(order).upper() == "ASC" else "DESC"
        conn = self.connect()
        try:
            rows = conn.execute(
                f"{self._telegram_select(schema)} WHERE {' AND '.join(where)} ORDER BY ts {order} LIMIT ?",
                params + [max(1, min(5000, int(limit)))]).fetchall()
            return [self._telegram_dict(r) for r in rows]
        finally:
            conn.close()

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

    def _telegram_dict(self, r):
        return {"id": r["id"], "ms": ms(r["ts"]), "type": telegram_type(r["zz"]), "qq": r["qq"], "zz": r["zz"],
                "pb": r["pb"], "sb": r["sb"], "nn": r["nn"], "dd": r["dd"], "ack": hexbyte(r["ack"]),
                "s_nn": r["s_nn"], "s_dd": r["s_dd"], "s_ack": hexbyte(r["s_ack"]), "status": r["status"],
                "master": self.master_hex(r), "slave": self.slave_hex(r)}

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

    def rawlog(self, from_ms, to_ms, own_address=0x31, include_broken=False):
        """Yield the telegrams of a window as lines of ebusd's message-mode raw data log
        (--lograwdata), the input of ebus-evidence.

        Telegrams sent by ebusd itself (own_address) are split into the direction changes ebusd logs:
        `>` master part, `<` ACK and slave answer, `>` ACK of the answer. Telegrams that are not
        complete and correct are left out unless include_broken is set; those carry the bytes as
        they were on the wire.
        """
        schema = self.schema()
        if schema is None:
            return
        conn = self.connect()
        try:
            cursor = conn.execute(
                f"SELECT ts, qq, zz, pb, sb, nn, dd, crc, ack, s_nn, s_dd, s_crc, s_ack, status, {schema.raw} AS raw "
                "FROM telegram WHERE ts >= ? AND ts < ? ORDER BY ts",
                (from_ms * NS_PER_MS, to_ms * NS_PER_MS))
            for r in cursor:
                stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["ts"] // 1_000_000_000))
                stamp += ".%03d " % (r["ts"] // NS_PER_MS % 1000)
                if r["status"] != "ok":
                    if not include_broken:
                        continue
                    raw = r["raw"]
                    if raw is None:
                        continue
                    if not schema.version2:
                        raw = bytes.fromhex(raw)
                    yield stamp + "<" + raw.hex() + "\n"
                    continue
                dd = r["dd"] if schema.version2 else bytes.fromhex(r["dd"] or "")
                master = bytes([r["qq"], r["zz"], r["pb"], r["sb"], r["nn"]]) + escape(dd) + bytes([r["crc"]])
                tail = b""
                if r["ack"] is not None:
                    tail = bytes([r["ack"]])
                answer = b""
                if r["s_nn"] is not None:
                    s_dd = r["s_dd"] if schema.version2 else bytes.fromhex(r["s_dd"] or "")
                    answer = bytes([r["s_nn"]]) + escape(s_dd) + bytes([r["s_crc"]])
                if r["qq"] == own_address:
                    line = ">" + master.hex()
                    if tail:
                        line += "<" + (tail + answer).hex()
                    if r["s_ack"] is not None:
                        line += ">" + bytes([r["s_ack"]]).hex()
                else:
                    line = "<" + (master + tail + answer + (bytes([r["s_ack"]]) if r["s_ack"] is not None else b"")).hex()
                yield stamp + line + "\n"
        finally:
            conn.close()

    # -- events (notes) -------------------------------------------------------------

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

    def add_marker(self, message, ts_ns=None, uncertainty_ns=500_000_000):
        ts = ts_ns if ts_ns is not None else now_ns()
        conn = self.connect()
        try:
            with conn:
                cur = conn.execute("INSERT INTO event (ts, ts_min, ts_max, message, logged) VALUES (?, ?, ?, ?, ?)",
                                   (ts, ts - uncertainty_ns, ts + uncertainty_ns, message, now_ns()))
                return cur.lastrowid
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
