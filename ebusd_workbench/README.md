# Home Assistant App: ebusd Config Workbench

A companion of the [eBUSd app](../ebusd) that finds the message definitions which fit *your*
eBUS devices, without being an ebusd expert.

- **The bus**: the telegrams the eBUSd app records in its SQLite telegram log, on a timeline:
  one row per message, a bar for every stretch where the value stayed the same, Home Assistant
  entity changes and your own notes in the same picture.
- **Every definition that fits, from every source, side by side**: ebusd's own definitions
  ([ebus.github.io](https://ebus.github.io), what the eBUSd app loads), the upcoming release,
  open pull requests of [ebusd-configuration](https://github.com/john30/ebusd-configuration)
  and branches of other repositories. Each one is fetched as a snapshot from GitHub (no git),
  compiled in your browser when it is TypeSpec, and used to decode the whole recording with
  ebusd's own message library (WebAssembly). The bus shows the decoded values, the scratchpad
  shows for a message every candidate with how it fares over the recording, its values, its
  history and how it differs from the others.
- **Tune and name**: copy any definition into the scratchpad and change its fields, types,
  divisors, units and names while ebusd's decoder checks it against every recorded telegram;
  or read a definition off the bytes of a message no definition knows. Give messages and fields
  the names they should have in Home Assistant.
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
