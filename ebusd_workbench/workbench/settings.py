"""Settings changed from the UI, stored as JSON in the app's data folder."""

import json
import os
import threading

from .sources import SourceError, parse_ref

DEFAULTS = {
    "entities": [],               # Home Assistant entities whose state changes are logged (of earlier versions; see events)
    "events": [],                 # what is watched next to the telegrams: [{entity, mode: "interval" | "value", on, label, color}]
    "deploy_subdir": "",
    "setup": {},                  # the definitions chosen for this installation, their names and the choices per row
    "sources": [],                # where definitions come from: [{id: "release" | "next" | "pr/660" | "gh/owner/repo#branch", enabled}]
    "custom": "",                 # own definitions (ebusd CSV lines), a source of the pool like the others
    "own_address": "31",          # ebusd's own address on this bus (--address)
    "ui": {},
}


def _valid_entity(value):
    return isinstance(value, str) and 0 < len(value) < 256 and value.count(".") == 1 and " " not in value


def _event_entry(item):
    """One watched entity, validated: {entity, mode, on, label, color}."""
    if not isinstance(item, dict) or not _valid_entity(str(item.get("entity") or "").strip()):
        raise ValueError("an event needs an entity id like switch.pump")
    entity = str(item["entity"]).strip()
    mode = str(item.get("mode") or ("interval" if entity.split(".")[0] in ("binary_sensor", "switch", "input_boolean", "light", "fan") else "value"))
    if mode not in ("interval", "value"):
        raise ValueError("mode must be interval or value")
    color = str(item.get("color") or "").strip()
    if color and not (len(color) == 7 and color[0] == "#" and all(c in "0123456789abcdefABCDEF" for c in color[1:])):
        raise ValueError("color must be #rrggbb")
    return {"entity": entity, "mode": mode, "on": str(item.get("on") or "on").strip()[:40] or "on",
            "label": str(item.get("label") or "").strip()[:60], "color": color.lower()}


class Settings:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self.data = json.loads(json.dumps(DEFAULTS))
        self.load()

    def load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                stored = json.load(f)
        except (OSError, ValueError):
            return
        if isinstance(stored, dict):
            self.data = self._merge(json.loads(json.dumps(DEFAULTS)), stored)
            # entities of earlier versions become events with their defaults
            known = {e["entity"] for e in self.data.get("events") or []}
            for entity in self.data.get("entities") or []:
                if entity not in known:
                    self.data["events"].append(_event_entry({"entity": entity}))
            self.data["entities"] = []

    def save(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2, sort_keys=True)
        os.replace(tmp, self.path)

    @property
    def entities(self):
        """The entities to subscribe to: those watched as events (and any of the old list)."""
        return sorted({e["entity"] for e in self.data.get("events") or []} | set(self.data.get("entities") or []))

    @property
    def events(self):
        return [dict(e) for e in self.data.get("events") or []]

    def as_dict(self):
        with self._lock:
            return json.loads(json.dumps(self.data))

    def update(self, changes):
        """Merge validated changes and persist; returns whether the entity list changed."""
        if not isinstance(changes, dict):
            raise ValueError("settings must be an object")
        with self._lock:
            before = set(self.entities)
            self.data = self._merge(self.data, changes)
            self.save()
            return set(self.entities) != before

    @staticmethod
    def _merge(base, changes):
        for key, value in changes.items():
            if key == "entities":
                if not isinstance(value, list):
                    raise ValueError("entities must be a list")
                base[key] = sorted({v.strip() for v in value if _valid_entity(v.strip())})
            elif key == "events":
                if not isinstance(value, list):
                    raise ValueError("events must be a list")
                result, seen = [], set()
                for item in value[:100]:
                    entry = _event_entry(item)
                    if entry["entity"] in seen:
                        continue
                    seen.add(entry["entity"])
                    result.append(entry)
                base[key] = result
            elif key == "deploy_subdir":
                base[key] = str(value).strip("/ ")[:200]
            elif key == "setup":
                if not isinstance(value, dict):
                    raise ValueError("setup must be an object")
                if len(json.dumps(value)) > 2_000_000:
                    raise ValueError("setup too large")
                base[key] = value
            elif key == "custom":
                base[key] = str(value)[:200_000]
            elif key == "own_address":
                address = str(value).strip().lower()
                if len(address) != 2 or any(c not in "0123456789abcdef" for c in address):
                    raise ValueError("own_address must be a hex byte, e.g. 31")
                base[key] = address
            elif key == "sources":
                if not isinstance(value, list):
                    raise ValueError("sources must be a list")
                result, seen = [], set()
                for item in value[:50]:
                    spec = item.get("id") if isinstance(item, dict) else item
                    try:
                        source_id = parse_ref(spec)["id"]
                    except SourceError as err:
                        raise ValueError(str(err))
                    if source_id in seen:
                        continue
                    seen.add(source_id)
                    result.append({"id": source_id, "enabled": not (isinstance(item, dict) and item.get("enabled") is False)})
                base[key] = result
            elif key == "ui":
                if not isinstance(value, dict):
                    raise ValueError("ui must be an object")
                base[key] = value if len(json.dumps(value)) < 20000 else base[key]
            # unknown keys (also the ones of earlier versions: id_bytes, id_overrides, id_rules, evidence_profile, …) are ignored
        return base
