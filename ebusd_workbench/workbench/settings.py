"""Settings changed from the UI, stored as JSON in the app's data folder."""

import json
import os
import threading

DEFAULTS = {
    "entities": [],               # Home Assistant entities whose state changes are logged
    "id_bytes": 1,                # message ID length (data bytes after PBSB) used to group telegrams
    "id_overrides": {"b509": 3},  # per PBSB: Vaillant register read/write carries a 3-byte ID
    "compile": {"entry": "src/main.tsp", "translations": ""},
    "deploy_subdir": "",
    "test_files": [],             # compiled files to load when testing; empty: all
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
                    if len(pbsb) != 4 or any(c not in "0123456789abcdef" for c in pbsb):
                        raise ValueError(f"invalid command {pbsb}")
                    result[pbsb] = max(0, min(8, int(length)))
                base[key] = result
            elif key == "compile":
                if not isinstance(value, dict):
                    raise ValueError("compile must be an object")
                base[key] = {"entry": str(value.get("entry", base[key]["entry"]))[:500],
                             "translations": str(value.get("translations", base[key]["translations"]))[:500]}
            elif key == "deploy_subdir":
                base[key] = str(value).strip("/ ")[:200]
            elif key == "test_files":
                if not isinstance(value, list):
                    raise ValueError("test_files must be a list")
                base[key] = [str(v)[:500] for v in value][:1000]
            elif key == "ui":
                if not isinstance(value, dict):
                    raise ValueError("ui must be an object")
                base[key] = value if len(json.dumps(value)) < 20000 else base[key]
            # unknown keys are ignored
        return base
