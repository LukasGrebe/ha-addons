"""Synthetic eBUS traffic for tests of the Workbench: a telegram database like the eBUSd app writes it.

Usage as a script: python3 tests/unit/workbench_fixtures.py OUT.db [DAYS]
"""

import os
import random
import sqlite3
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ebusd"))
import ebus_sqlite  # noqa: E402  (schema and CRC of the eBUSd telegram log)

NS = 1_000_000_000


def crc_hex(hexstr):
    return "%02x" % ebus_sqlite.crc8(bytes.fromhex(hexstr))


class Writer:
    """Writes telegrams the way the eBUSd app's logger does (schema version 2)."""

    def __init__(self, path):
        self.db = ebus_sqlite.open_db(path)
        self.rows = []

    def add(self, ts_ns, qq, zz, pb, sb, dd, s_dd=None, status="ok"):
        """Append a telegram given as data hex strings; CRCs and the wire bytes are derived."""
        dd = bytes.fromhex(dd)
        master = bytes([qq, zz, pb, sb, len(dd)]) + dd
        crc = ebus_sqlite.crc8(master)
        row = {"ts": ts_ns, "qq": qq, "zz": zz, "pb": pb, "sb": sb, "nn": len(dd), "dd": dd, "crc": crc, "status": status}
        if zz != 0xFE:
            row["ack"] = 0
            if not ebus_sqlite.is_master(zz) and s_dd is not None and status != "timeout":
                s_dd = bytes.fromhex(s_dd)
                answer = bytes([len(s_dd)]) + s_dd
                row.update(s_nn=len(s_dd), s_dd=s_dd, s_crc=ebus_sqlite.crc8(answer), s_ack=0)
        raw = None
        if status == "crc":
            row["crc"] ^= 0xFF
            raw = master + bytes([row["crc"]])
        row["raw"] = raw
        self.rows.append(tuple(row.get(c) for c in ebus_sqlite.COLUMNS))

    def commit(self):
        with self.db:
            ebus_sqlite.insert(self.db, self.rows)
        self.rows.clear()

    def close(self):
        self.commit()
        self.db.close()


def d2c(value):
    """ebusd data type D2C: signed 16 bit little endian with 1/16 resolution."""
    raw = int(round(value * 16)) & 0xFFFF
    return "%02x%02x" % (raw & 0xFF, raw >> 8)


def d2b(value):
    """ebusd data type D2B: signed 16 bit little endian with 1/256 resolution."""
    raw = int(round(value * 256)) & 0xFFFF
    return "%02x%02x" % (raw & 0xFF, raw >> 8)


def d1c(value):
    """ebusd data type D1C: unsigned 8 bit with 1/2 resolution."""
    return "%02x" % (int(round(value * 2)) & 0xFF)


def bcd(value):
    return "%02x" % (int(value) % 100 // 10 * 16 + int(value) % 10)


def generate(path, days=2.0, end_ns=None, seed=1):
    """Write a realistic mix of polled, broadcast and controller traffic plus a few events.

    Returns the pump switching times (ms) so tests can correlate telegrams and events.
    """
    rnd = random.Random(seed)
    end_ns = end_ns or time.time_ns()
    start_ns = end_ns - int(days * 86400 * NS)
    writer = Writer(path)
    pump_on = False
    pump_changes = []
    flow = 40.0
    outside = 8.0
    mode = (0, 30.0)  # hcmode, flowtempdesired of the SetMode message (vaillant bai, b510 00)
    next_pump = start_ns + 3600 * NS
    next_mode = start_ns + 5 * 3600 * NS
    t = start_ns
    second = 0
    while t < end_ns:
        jitter = rnd.randint(0, 200_000_000)
        if t >= next_pump:
            pump_on = not pump_on
            pump_changes.append((t // 1_000_000, pump_on))
            next_pump = t + rnd.randint(1800, 7200) * NS
        if t >= next_mode:
            mode = rnd.choice([(0, 30.0), (1, 30.0), (2, 45.0), (3, 60.0)])
            next_mode = t + rnd.randint(3600, 6 * 3600) * NS
        if second % 30 == 0:  # ebusd polls two heat pump registers (vaillant ehp SourceTempInput, TempInput)
            flow = max(25.0, min(75.0, flow + rnd.uniform(-0.3, 0.3) + (0.4 if pump_on else -0.2)))
            status = "ok" if rnd.random() > 0.01 else rnd.choice(["timeout", "crc"])
            writer.add(t + jitter, 0x31, 0x08, 0xB5, 0x09, "0d0f00", d2c(flow) + "00", status)
            writer.add(t + jitter + 400_000_000, 0x31, 0x08, 0xB5, 0x09, "0d0200", d2c(flow - 8) + "00", "ok")
        if second % 30 == 15:  # room controller asks for Status01 (temperatures and pump state in the answer)
            answer = d1c(flow) + d1c(flow - 8) + d2b(outside) + d1c(48.5) + d1c(50) + ("01" if pump_on else "00") + "0000"
            writer.add(t + jitter, 0x10, 0x08, 0xB5, 0x11, "01", answer)
        if second % 10 == 5:  # controller sets the operation mode (SetMode: MS with the payload in the master part)
            payload = "%02x%s%s%02x%s%s%s%s" % (mode[0], d1c(mode[1]), d1c(55.0), 60, "00", "00", "00", "01" if pump_on else "00")
            writer.add(t + jitter, 0x10, 0x08, 0xB5, 0x10, "00" + payload, "01")
        if second % 60 == 0:  # broadcast date/time (Vdatetime: BTI + BDA): every telegram differs
            tm = time.gmtime(t // NS)
            writer.add(t + jitter, 0x10, 0xFE, 0xB5, 0x16, "00" + bcd(tm.tm_sec) + bcd(tm.tm_min) + bcd(tm.tm_hour)
                       + bcd(tm.tm_mday) + bcd(tm.tm_mon) + bcd(tm.tm_wday + 1) + bcd(tm.tm_year % 100))
        if second % 300 == 100:  # broadcast outside temperature (Outsidetemp: D2B), slowly changing
            outside = max(-15.0, min(30.0, outside + rnd.uniform(-0.1, 0.1)))
            writer.add(t + jitter, 0x10, 0xFE, 0xB5, 0x16, "01" + d2b(outside))
        if second % 600 == 300:  # unknown device, unknown command
            writer.add(t + jitter, 0x03, 0x15, 0xB5, 0x23, "0a01", "02%02x" % rnd.randint(0, 3))
        second += 1
        t += NS
        if len(writer.rows) > 20000:
            writer.commit()
    writer.close()
    return pump_changes


def add_events(db_path, pump_changes):
    """Store the pump switching as Home Assistant state changes and one note, like the Workbench does."""
    from workbench.db import Database  # noqa: WPS433 (available when the Workbench package is importable)

    db = Database(db_path)
    db.ensure_schema()
    for index, (ts_ms, on) in enumerate(pump_changes):
        db.add_state("ha" if index else "ha-initial", "switch.circulation_pump", state="on" if on else "off",
                     previous=None if index == 0 else ("off" if on else "on"),
                     attributes={"friendly_name": "Circulation pump"}, ts_ns=ts_ms * 1_000_000)
    if pump_changes:
        db.add_marker("opened hot water tap", ts_ns=(pump_changes[-1][0] - 60_000) * 1_000_000)


if __name__ == "__main__":
    out = sys.argv[1]
    days = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
    if os.path.exists(out):
        os.remove(out)
    changes = generate(out, days)
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ebusd_workbench"))
    add_events(out, changes)
    print(f"{out}: {days} days, {len(changes)} pump changes")
