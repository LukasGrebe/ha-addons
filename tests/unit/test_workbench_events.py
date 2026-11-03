"""Unit tests of the events next to the telegrams (ebusd_workbench/workbench/events.py)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ebusd_workbench"))
from workbench import events  # noqa: E402


def state(i, ms, entity, value, source="ha"):
    return {"id": i, "ms": ms, "entity": entity, "state": value, "previous": None, "source": source}


class Building(unittest.TestCase):
    def test_defaults_by_domain(self):
        self.assertEqual(events.default_config("switch.pump")["mode"], "interval")
        self.assertEqual(events.default_config("binary_sensor.burner")["mode"], "interval")
        self.assertEqual(events.default_config("sensor.outside")["mode"], "value")
        self.assertEqual(events.default_config("switch.circulation_pump")["label"], "circulation pump")
        config = events.config_for(["sensor.outside", "switch.pump"], [{"entity": "switch.pump", "label": "Pump", "color": "#112233"}])
        self.assertEqual([c["entity"] for c in config], ["sensor.outside", "switch.pump"])
        self.assertEqual(config[1], {"entity": "switch.pump", "mode": "interval", "on": "on", "label": "Pump", "color": "#112233"})

    def test_intervals_points_and_notes(self):
        config = events.config_for(["switch.pump", "sensor.outside", "climate.hc"], [{"entity": "climate.hc", "mode": "interval", "on": "heat"}])
        states = [state(1, 1000, "switch.pump", "off", "ha-initial"), state(2, 2000, "switch.pump", "on"), state(3, 2500, "sensor.outside", "7.5"),
                  state(4, 5000, "switch.pump", "off"), state(5, 6000, "climate.hc", "heat"), state(6, 7000, "switch.pump", "on"),
                  state(7, 7500, "switch.pump", "on"), state(8, 8000, "climate.hc", "off")]
        markers = [{"id": 9, "ms": 4000, "ms_min": 3000, "ms_max": 4000, "message": "tap opened"}]
        built = events.build_events(markers, states, config)
        kinds = [(e["kind"], e["entity"], e["start_ms"], e["end_ms"]) for e in built]
        self.assertEqual(kinds, [
            ("interval", "switch.pump", 2000, 5000),
            ("point", "sensor.outside", 2500, None),
            ("note", "", 4000, None),
            ("interval", "climate.hc", 6000, 8000),
            ("interval", "switch.pump", 7000, None),   # still on at the end: open
        ])
        self.assertEqual(built[1]["value"], "7.5")
        self.assertEqual((built[2]["label"], built[2]["min_ms"], built[2]["max_ms"]), ("tap opened", 3000, 4000))
        self.assertEqual(events.intervals_of(built), {"switch.pump": [(2000, 5000), (7000, None)], "climate.hc": [(6000, 8000)]})
        # a range: an interval open at its start is kept, one that ended before it is not
        inside = events.build_events([], states, config, from_ms=5500, to_ms=7200)
        self.assertEqual([(e["entity"], e["start_ms"]) for e in inside], [("climate.hc", 6000), ("switch.pump", 7000)])
        self.assertTrue(events.is_on("Heating", {"on": "on"}), "on also means heating, running, open …")
        self.assertFalse(events.is_on("idle", {"on": "on"}))


if __name__ == "__main__":
    unittest.main()
