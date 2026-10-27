# Home Assistant App: ebusd Config Workbench

A companion of the [eBUSd app](../ebusd) for everyone who works on eBUS message definitions.

- **Timeline** of the telegrams the eBUSd app records in its SQLite telegram log: one row per
  message, a bar for every stretch where the value stayed the same (with the number of
  repetitions and the interval, e.g. "×36 every 5 min"), a new bar when it changed.
- **Home Assistant events** in the same timeline: the state changes of entities you pick (the
  circulation pump, a thermostat, …) and markers you add yourself, to correlate what happened
  with what was on the bus.
- **TypeSpec to CSV in the browser**: edit the `.tsp` sources of
  [ebusd-configuration](https://github.com/john30/ebusd-configuration) in a git repository
  and compile them with the official [eBUS TypeSpec library](https://github.com/john30/ebus-typespec),
  without Node.js on the device.
- **Test against real telegrams in the browser**: ebusd's own message library, compiled to
  WebAssembly, loads the compiled CSV files and decodes the recorded telegrams, like
  `ebusd --checkconfig --inject` does.
- **A setup for your installation**: see every definition that fits your recorded telegrams,
  also the ones ebusd hides behind device variants and conditions, and the ones in open
  community pull requests (compiled as layers on top of your checkout); pick the plausible
  ones and export them as CSV files for the eBUSd app, as Home Assistant climate and water
  heater entities, and as an ebusd raw log for [ebus-evidence](https://github.com/MarcelT87/ebus-evidence).
- **git**: clone, edit, diff, commit, pull and push from the UI; **deploy** the compiled files
  to the share folder for the eBUSd app.

See [DOCS.md](DOCS.md) for setup and usage.

## Installation

Add this repository to Home Assistant as described in the
[repository readme](https://github.com/LukasGrebe/ha-addons#how-to-install) and install
**ebusd Config Workbench**. It needs the eBUSd app with the SQLite telegram log enabled.

## Support

Questions about message definitions, the TypeSpec library or ebusd itself belong to the
[ebusd project](https://github.com/john30/ebusd/discussions). Problems with this app:
[issues](https://github.com/LukasGrebe/ha-addons/issues).
