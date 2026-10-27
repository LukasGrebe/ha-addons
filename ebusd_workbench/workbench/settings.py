"""Settings changed from the UI, stored as JSON in the app's data folder."""

import json
import os
import threading

from .sources import SourceError, parse_ref

DEFAULTS = {
    "entities": [],               # Home Assistant entities whose state changes are logged
    "id_bytes": 1,                # message ID length (data bytes after PBSB) used to group telegrams
    "id_overrides": {"b509": 3, "b524": 6},  # per PBSB or ZZ+PBSB: Vaillant register access carries a longer ID
    "id_rules": {},               # per message: {"zzpbsb:prefix": ID length}: rows split or combined at a byte in the timeline
    "deploy_subdir": "",
    "setup": {},                  # the definitions chosen for this installation, their names and the choices per row
    "sources": [],                # where definitions come from: [{id: "release" | "next" | "pr/660" | "gh/owner/repo#branch", enabled}]
    "evidence_profile": "",       # ebus-evidence profile YAML last imported
    "custom": "",                 # the scratchpad: own definitions (ebusd CSV lines) decoded over the recording like any other source
    "own_address": "31",          # ebusd's own address on this bus (--address), for raw logs and evidence checks
    "ui": {},
}


def _valid_entity(value):
    return isinstance(value, str) and 0 < len(value) < 256 and value.count(".") == 1 and " " not in value


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

    def save(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2, sort_keys=True)
        os.replace(tmp, self.path)

    @property
    def entities(self):
        return list(self.data.get("entities") or [])

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
            elif key == "id_bytes":
                base[key] = max(0, min(8, int(value)))
            elif key == "id_overrides":
                if not isinstance(value, dict):
                    raise ValueError("id_overrides must be an object")
                result = {}
                for pbsb, length in value.items():
                    pbsb = str(pbsb).lower()
                    if len(pbsb) not in (4, 6) or any(c not in "0123456789abcdef" for c in pbsb):
                        raise ValueError(f"invalid command {pbsb} (PBSB or ZZPBSB in hex)")
                    result[pbsb] = max(0, min(8, int(length)))
                base[key] = result
            elif key == "id_rules":
                if not isinstance(value, dict) or len(value) > 5000:
                    raise ValueError("id_rules must be an object with at most 5000 entries")
                rules = {}
                for rule, length in value.items():
                    command, colon, prefix = str(rule).lower().partition(":")
                    if not colon or len(command) != 6 or len(prefix) % 2 or len(prefix) > 32 or any(c not in "0123456789abcdef" for c in command + prefix):
                        raise ValueError(f"invalid ID rule {rule} (zzpbsb:prefix in hex)")
                    rules[f"{command}:{prefix}"] = max(0, min(16, int(length)))
                base[key] = rules
            elif key == "deploy_subdir":
                base[key] = str(value).strip("/ ")[:200]
            elif key == "setup":
                if not isinstance(value, dict):
                    raise ValueError("setup must be an object")
                if len(json.dumps(value)) > 2_000_000:
                    raise ValueError("setup too large")
                base[key] = value
            elif key == "evidence_profile":
                base[key] = str(value)[:200_000]
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
            # unknown keys (also the ones of earlier versions: compile, layers, test_files, upstream_url) are ignored
        return base
