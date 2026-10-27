#!/usr/bin/env python3
"""log: note what you did or saw in the SQLite telegram log, to find its telegrams by time.

usage: log [[DATE] TIME] [UNCERTAINTY] [MESSAGE...]

  log Modus auf Einschaltempfehlung geändert             now
  log 8:52:23 ~1s Modus auf Einschaltempfehlung geändert  8:52:22 to 8:52:24
  log 8:50 -10m Dampf vom Abtauen                         8:40 to 8:50
  log 2026-10-26 22:15 Warmwasser auf 50 °C               also 26.10.2026 or 26.10.
  log                                                     now, then asks what happened

TIME         8:52, 8:52:23 or 8:52:23.5 (local time); without a date the last time the
             clock showed it. Without a time: the moment you press Enter.
UNCERTAINTY  ~1s (or +-1s) before or after, -10m before, +30s after, -10m+30s both;
             units ms, s, m, h. Without: the precision of TIME (8:52 is 8:52:00 to 8:53:00).
MESSAGE      the rest of the line; put -- before a message that starts like a time.

The event is stored in the table `event` of the database set in the app option
sqlite_db (or --db FILE as first argument).
"""

import datetime
import json
import re
import sqlite3
import sys
import time

import ebus_sqlite

try:
    import readline  # noqa: F401  line editing at the prompt
except ImportError:
    pass

OPTIONS = "/data/options.json"
SECOND = 10**9
FUTURE_TOLERANCE = 5 * 60 * SECOND  # clocks differ; a time this far ahead still counts as today
UNITS = {"ms": SECOND // 1000, "s": SECOND, "m": 60 * SECOND, "min": 60 * SECOND, "h": 3600 * SECOND}

TIME = re.compile(r"(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?")
DATE = re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})\.(\d{1,2})\.(\d{4})?")
DURATION = r"(\d+(?:[.,]\d+)?)(ms|s|min|m|h)"  # the unit is required, so "+5 Grad" stays a message
SYMMETRIC = re.compile(rf"(?:~|±|\+-|-\+){DURATION}")
ONE_SIDED = re.compile(rf"([+-]){DURATION}(?:([+-]){DURATION})?")


def local_ns(day, hour, minute, second):
    """Return a local time on day in ns since 1970-01-01 UTC."""
    moment = datetime.datetime.combine(day, datetime.time(hour, minute, second))
    return int(moment.timestamp()) * SECOND


def parse_date(word, now):
    match = DATE.fullmatch(word)
    if match.group(1):
        year, month, day = match.group(1, 2, 3)
    else:
        day, month, year = match.group(4, 5, 6)
        year = year or datetime.date.fromtimestamp(now // SECOND).year
    try:
        return datetime.date(int(year), int(month), int(day))
    except ValueError:
        raise ValueError(f"{word} is not a valid date") from None


def parse_time(word, day, now):
    """Return (ts, resolution) of a local time like 8:52, 8:52:23 or 8:52:23.5.

    Without day, it is the last time the clock showed it: today, or yesterday if
    it is still to come today.
    """
    hour, minute, second, fraction = TIME.fullmatch(word).groups()
    fraction = fraction or ""
    resolution = SECOND // 10**len(fraction) if second else 60 * SECOND
    fraction_ns = int(fraction.ljust(9, "0")) if fraction else 0
    clock = (int(hour), int(minute), int(second or 0))
    try:
        if day is not None:
            return local_ns(day, *clock) + fraction_ns, resolution
        today = datetime.date.fromtimestamp(now // SECOND)
        ts = local_ns(today, *clock) + fraction_ns
        if ts > now + FUTURE_TOLERANCE:
            ts = local_ns(today - datetime.timedelta(days=1), *clock) + fraction_ns
        return ts, resolution
    except ValueError:
        raise ValueError(f"{word} is not a valid time") from None


def duration(number, unit):
    return round(float(number.replace(",", ".")) * UNITS[unit])


def parse_uncertainty(word):
    """Return (before, after) in ns of ~5s, ±5s, +-5s, -10m, +30s or -10m+30s, else None."""
    match = SYMMETRIC.fullmatch(word)
    if match:
        both = duration(*match.groups())
        return both, both
    match = ONE_SIDED.fullmatch(word)
    if not match or match.group(1) == match.group(4):
        return None
    sides = {match.group(1): duration(*match.group(2, 3))}
    if match.group(4):
        sides[match.group(4)] = duration(*match.group(5, 6))
    return sides.get("-", 0), sides.get("+", 0)


def parse(words, now):
    """Return (ts, ts_min, ts_max, message) of the arguments of log; message is None if empty."""
    words = list(words)
    rest = []
    if "--" in words:
        cut = words.index("--")
        words, rest = words[:cut], words[cut + 1:]
    if words:  # 2026-10-26T22:15
        day, separator, clock = words[0].partition("T")
        if separator and DATE.fullmatch(day) and TIME.fullmatch(clock):
            words[0:1] = [day, clock]
    day = None
    if words and DATE.fullmatch(words[0]):
        day = parse_date(words.pop(0), now)
        if not (words and TIME.fullmatch(words[0])):
            raise ValueError("a date needs a time, e.g. 2026-10-26 22:15")
    if words and TIME.fullmatch(words[0]):
        ts, resolution = parse_time(words.pop(0), day, now)
        if ts > now + FUTURE_TOLERANCE:
            raise ValueError(f"{show(ts)} is in the future")
    else:
        ts, resolution = now, 0
    uncertainty = parse_uncertainty(words[0]) if words else None
    if uncertainty:
        words.pop(0)
        ts_min, ts_max = ts - uncertainty[0], ts + uncertainty[1]
    else:
        ts_min, ts_max = ts, ts + resolution
    message = " ".join(words + rest).strip()
    return ts, ts_min, ts_max, message or None


def show(ts, date=True):
    """Return ts as local time, with milliseconds if there are any."""
    seconds, ns = divmod(ts, SECOND)
    text = datetime.datetime.fromtimestamp(seconds).strftime("%Y-%m-%d %H:%M:%S" if date else "%H:%M:%S")
    return text + (f".{ns // 10**6:03d}" if ns else "")


def describe(ts, ts_min, ts_max):
    """Return the time of an event and, if uncertain, when it may have happened."""
    text = show(ts)
    if ts_min != ts or ts_max != ts:
        earliest, latest = (show(t, date=show(t)[:10] != text[:10]) for t in (ts_min, ts_max))
        text += f" (between {earliest} and {latest})"
    return text


def configured_db():
    try:
        with open(OPTIONS) as file:
            return json.load(file).get("sqlite_db") or None
    except (OSError, ValueError):
        return None


def execute(db_path, sql, params):
    """Run one statement in a connection of its own and return the row id.

    The database is not kept open at the prompt: the telegram log can only keep
    an unconvertible database aside while no other program has it open.
    """
    db = ebus_sqlite.open_db(db_path)
    try:
        db.executescript(ebus_sqlite.EVENT_SCHEMA)  # missing in v1 or early v2 databases
        with db:
            return db.execute(sql, params).lastrowid
    finally:
        db.close()


def main(argv=None):
    now = time.time_ns()  # first of all: the moment Enter was pressed
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] in (["-h"], ["--help"]):
        print(__doc__.strip())
        return 0
    db_path = None
    if args[:1] == ["--db"] and len(args) > 1:
        db_path, args = args[1], args[2:]
    try:
        ts, ts_min, ts_max, message = parse(args, now)
    except ValueError as err:
        print(f"log: {err} (see log --help)", file=sys.stderr)
        return 1
    db_path = db_path or configured_db()
    if not db_path:
        print("log: no database: set the app option \"SQLite telegram log (database file)\" and restart the app",
              file=sys.stderr)
        return 1
    try:
        # stored right away, so that the time is kept even if the terminal is closed at the prompt
        event = execute(db_path, "INSERT INTO event (ts, ts_min, ts_max, message, logged) VALUES (?, ?, ?, ?, ?)",
                        (ts, ts_min, ts_max, message, now))
        if message is None:
            print(f"{describe(ts, ts_min, ts_max)} logged. What happened? "
                  "(Enter alone keeps just the time, Ctrl+C removes it)")
            try:
                message = input("> ").strip() or None
            except EOFError:
                print()
            except KeyboardInterrupt:
                execute(db_path, "DELETE FROM event WHERE id = ?", (event,))
                print("\nRemoved, nothing logged.")
                return 130
            if message:
                execute(db_path, "UPDATE event SET message = ? WHERE id = ?", (message, event))
    except (OSError, sqlite3.Error) as err:
        print(f"log: unable to write to {db_path}: {err}", file=sys.stderr)
        return 1
    print(f"Logged {describe(ts, ts_min, ts_max)}: {message or '(time only)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
