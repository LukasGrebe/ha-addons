"""Unit tests of the safe paths, deploy and settings of the Workbench."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ebusd_workbench"))
from workbench import deploy  # noqa: E402
from workbench.paths import PathError, safe_relative  # noqa: E402
from workbench.settings import Settings  # noqa: E402


class SafePaths(unittest.TestCase):
    def test_accepts_relative_paths(self):
        self.assertEqual(safe_relative("src/vaillant/08.bai.tsp"), "src/vaillant/08.bai.tsp")
        self.assertEqual(safe_relative("./a//b/"), "a/b")

    def test_rejects_escapes(self):
        for bad in ("", "/etc/passwd", "../x", "a/../../b", "a\\b", "a\x00b", None, 5):
            with self.assertRaises(PathError):
                safe_relative(bad)


class Deploy(unittest.TestCase):
    def test_deploy_and_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "share", "ebusd", "config")
            result = deploy.deploy({"vaillant/08.bai.csv": "a\n", "broadcast.csv": "b\n", "vaillant/bai.1.inc": "c\n"}, target)
            self.assertEqual(result["written"], ["broadcast.csv", "vaillant/08.bai.csv", "vaillant/bai.1.inc"])
            with open(os.path.join(target, "vaillant", "08.bai.csv")) as f:
                self.assertEqual(f.read(), "a\n")
            listed = deploy.list_deployed(target)
            self.assertEqual([f["path"] for f in listed["files"]], ["broadcast.csv", "vaillant/08.bai.csv", "vaillant/bai.1.inc"])
            result = deploy.deploy({"vaillant/08.bai.csv": "a2\n"}, target, subdir="", clean=True)
            self.assertEqual(result["removed"], ["broadcast.csv", "vaillant/bai.1.inc"])
            self.assertEqual([f["path"] for f in deploy.list_deployed(target)["files"]], ["vaillant/08.bai.csv"])
            result = deploy.deploy({"x.csv": "x"}, target, subdir="en")
            self.assertEqual(result["dir"], os.path.join(target, "en"))
            for bad in ({"../x.csv": "a"}, {"x.txt": "a"}, {}, {"x.csv": 5}, "x"):
                with self.assertRaises(PathError):
                    deploy.deploy(bad, target)
            self.assertFalse(deploy.list_deployed(os.path.join(tmp, "missing"))["exists"])


    def test_manifest_is_deployed_next_to_the_csv_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = deploy.deploy({"a.csv": "type\n", "workbench-setup.json": "{}\n"}, tmp, clean=True)
            self.assertEqual(result["written"], ["a.csv", "workbench-setup.json"])
            with self.assertRaises(PathError):
                deploy.deploy({"notes.json": "{}"}, tmp)


class SettingsFile(unittest.TestCase):
    def test_events_and_the_entities_of_old(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "settings.json")
            with open(path, "w") as f:
                json.dump({"entities": ["switch.pump", "sensor.outside"]}, f)
            settings = Settings(path)
            self.assertEqual([(e["entity"], e["mode"]) for e in settings.events], [("sensor.outside", "value"), ("switch.pump", "interval")], "the entity list of earlier versions becomes events with defaults")
            self.assertEqual(settings.entities, ["sensor.outside", "switch.pump"], "the subscription follows the events")
            self.assertTrue(settings.update({"events": [{"entity": "binary_sensor.burner", "on": "on", "label": "Burner", "color": "#ff0000"}]}), "the entities changed")
            self.assertEqual(settings.entities, ["binary_sensor.burner"])
            self.assertFalse(settings.update({"events": [{"entity": "binary_sensor.burner", "label": "Flame"}]}), "a rename changes no subscription")
            with self.assertRaises(ValueError):
                settings.update({"events": [{"entity": "burner"}]})
            with self.assertRaises(ValueError):
                settings.update({"events": [{"entity": "switch.x", "mode": "sometimes"}]})

    def test_validation_and_persistence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "data", "settings.json")
            settings = Settings(path)
            self.assertEqual(settings.entities, [])
            changed = settings.update({"entities": ["switch.pump ", "bad entity", "light.x"], "id_bytes": 99,
                                       "id_overrides": {"B504": "2"}, "unknown": 1, "deploy_subdir": "/en/"})
            self.assertTrue(changed)
            self.assertEqual(settings.entities, ["light.x", "switch.pump"])
            self.assertFalse(settings.update({"entities": ["light.x", "switch.pump"]}))
            data = Settings(path).as_dict()
            self.assertEqual(data["deploy_subdir"], "en")
            self.assertNotIn("id_overrides", data, "settings of earlier versions are ignored")
            for bad in ({"entities": "x"}, [], {"sources": 1}, {"own_address": "3"}, {"own_address": "zz"}, {"ui": "x"}):
                with self.assertRaises((ValueError, TypeError)):
                    settings.update(bad)
            # ebusd's own address and the setup (included definitions, chosen candidates, renames) round-trip
            self.assertEqual(settings.as_dict()["own_address"], "31")
            settings.update({"own_address": " F1 "})
            setup = {"included": ["a.csv|c|Name|"], "chosen": {"10→08 b509 0d": "a.csv|c|Name|"},
                     "names": {"a.csv|c|Name|": {"name": "Verbose", "fields": {"temp": "temperature"}}}, "circuits": {"c": "heating"}}
            settings.update({"setup": setup})
            data = Settings(path).as_dict()
            self.assertEqual(data["own_address"], "f1")
            self.assertEqual(data["setup"], setup)


if __name__ == "__main__":
    unittest.main()


