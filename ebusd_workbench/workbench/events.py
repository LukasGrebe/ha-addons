"""Events next to the telegrams: Home Assistant state changes (table ha_state) and notes made with
the `log` command of the eBUSd terminal (table event), as the views show them.

An entity watched as "interval" (a switch, a binary sensor: the pump, the burner, a request) gives
one interval per stretch in which it was on, from the change to its "on" value to the next change
away from it; an entity watched as "value" gives a point per change with the new value; a note is a
point with the span in which it may have happened. Which entities are watched how is in the
settings (`events`); an entity recorded without a setting gets a default by its domain.
"""

INTERVAL_DOMAINS = ("binary_sensor", "switch", "input_boolean", "light", "fan")
ON_STATES = ("on", "true", "open", "home", "playing", "heating", "cooling", "active", "running", "unlocked", "detected")
MODES = ("interval", "value")


def default_config(entity):
    """How an entity is watched when the settings say nothing: on/off intervals for the binary domains."""
    domain = entity.split(".", 1)[0] if "." in entity else ""
    return {"entity": entity, "mode": "interval" if domain in INTERVAL_DOMAINS else "value", "on": "on",
            "label": entity.split(".", 1)[-1].replace("_", " "), "color": ""}


def config_for(entities, settings_events):
    """The event settings for every entity (configured, or recorded): [{entity, mode, on, label, color}]."""
    by_entity = {}
    for item in settings_events or []:
        if isinstance(item, dict) and item.get("entity"):
            by_entity[item["entity"]] = dict(default_config(item["entity"]), **{k: v for k, v in item.items() if v not in (None, "")})
    for entity in entities or []:
        if entity not in by_entity:
            by_entity[entity] = default_config(entity)
    return [by_entity[e] for e in sorted(by_entity)]


def is_on(state, config):
    wanted = str(config.get("on") or "on").strip().lower()
    value = str(state if state is not None else "").strip().lower()
    if wanted == "on":
        return value in ON_STATES
    return value == wanted


def build_events(markers, states, config, from_ms=None, to_ms=None):
    """The events of a time range: intervals of the watched entities, points of the others, and the notes.

    states: rows of ha_state in time order ({ms, entity, state, previous, source}); markers: rows of the
    event table ({id, ms, ms_min, ms_max, message}). An interval still open at the end has end_ms None.
    """
    by_entity = {c["entity"]: c for c in config}
    events = []
    open_intervals = {}
    for s in sorted(states, key=lambda s: (s["ms"], s["id"])):
        entity = s["entity"]
        c = by_entity.get(entity) or default_config(entity)
        if c["mode"] == "interval":
            on = is_on(s["state"], c)
            current = open_intervals.get(entity)
            if on and current is None:
                open_intervals[entity] = {"id": f"s{s['id']}", "kind": "interval", "entity": entity, "label": c["label"], "color": c.get("color") or "",
                                          "start_ms": s["ms"], "end_ms": None, "value": s["state"], "source": s.get("source", "ha")}
                events.append(open_intervals[entity])
            elif not on and current is not None:
                current["end_ms"] = s["ms"]
                del open_intervals[entity]
        else:
            events.append({"id": f"s{s['id']}", "kind": "point", "entity": entity, "label": c["label"], "color": c.get("color") or "",
                           "start_ms": s["ms"], "end_ms": None, "value": s["state"], "previous": s.get("previous"), "source": s.get("source", "ha")})
    for m in markers:
        events.append({"id": f"n{m['id']}", "kind": "note", "entity": "", "label": m.get("message") or "(no text)", "color": "",
                       "start_ms": m["ms"], "end_ms": None, "min_ms": m.get("ms_min"), "max_ms": m.get("ms_max"), "value": None, "source": "log"})
    if from_ms is not None or to_ms is not None:
        lo = from_ms if from_ms is not None else float("-inf")
        hi = to_ms if to_ms is not None else float("inf")
        events = [e for e in events if (e["end_ms"] if e["end_ms"] is not None else (e.get("max_ms") or e["start_ms"]) if e["kind"] != "interval" else float("inf")) >= lo and e["start_ms"] < hi]
    events.sort(key=lambda e: (e["start_ms"], e["id"]))
    return events


def intervals_of(events):
    """The intervals by entity: {entity: [(start_ms, end_ms|None)]}."""
    out = {}
    for e in events:
        if e["kind"] == "interval":
            out.setdefault(e["entity"], []).append((e["start_ms"], e["end_ms"]))
    return out
