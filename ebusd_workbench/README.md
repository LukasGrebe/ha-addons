# Home Assistant App: ebusd Config Workbench

A companion of the [eBUSd app](../ebusd) that finds the message definitions which fit *your*
eBUS devices, without being an ebusd expert.

- **The bus**: the telegrams the eBUSd app records in its SQLite telegram log, as a list of
  messages that leads with what ebusd does not understand today, by device and by traffic.
- **Every definition that fits, from every source, side by side**: ebusd's own definitions
  ([ebus.github.io](https://ebus.github.io), what the eBUSd app loads), the upcoming release,
  open pull requests of [ebusd-configuration](https://github.com/john30/ebusd-configuration)
  and branches of other repositories. Each one is fetched as a snapshot from GitHub (no git),
  compiled in your browser when it is TypeSpec, and used to decode the whole recording with
  ebusd's own message library (WebAssembly). The list shows the decoded values; the inspector of
  a message lays its telegram out byte by byte with every definition that fits as a row: the
  fields over the bytes they read, what each decodes, a sparkline per field over the recording.
- **Tune and name**: every field in the inspector is editable: a name becomes the name in your
  config, a changed type, divisor or unit makes a copy of your own that ebusd's decoder checks
  against every recorded telegram at once; a message no definition knows gets a definition of
  your own started from its bytes.
- **Save**: the definitions you picked become CSV files for the eBUSd app (deployed to the share
  folder or downloaded), with the climate and water heater entities as YAML and the eBUSd app
  options to publish them.

See [DOCS.md](DOCS.md) for setup and usage.

## Installation

Add this repository to Home Assistant as described in the
[repository readme](https://github.com/LukasGrebe/ha-addons#how-to-install) and install
**ebusd Config Workbench**. It needs the eBUSd app with the SQLite telegram log enabled.

## Support

Questions about message definitions or ebusd itself belong to the
[ebusd project](https://github.com/john30/ebusd/discussions). Problems with this app:
[issues](https://github.com/LukasGrebe/ha-addons/issues).
