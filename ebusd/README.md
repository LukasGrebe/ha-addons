# Home Assistant App: eBUSd

A transparent wrapper of [ebusd](https://ebusd.eu) for Home Assistant.
Tracks upstream [john30/ebusd](https://github.com/john30/ebusd) releases automatically.

## What this app does

- Runs ebusd as a Home Assistant supervised app (container).
- Exposes ebusd's own command-line options as HA configuration fields.
- Auto-configures the MQTT connection to the HA MQTT broker.
- Seeds `mqtt-hassio.cfg` (MQTT–Home Assistant integration config) into the app config folder on first start.

## Installation

See the [repository readme](https://github.com/LukasGrebe/ha-addons#how-to-install) for how to add this repository to Home Assistant.

## Versioning

This app version mirrors [john30/ebusd releases](https://github.com/john30/ebusd/releases) — `MAJOR.MINOR` matches ebusd, `.PATCH` is reserved for app-specific changes.

For the changelog, see the upstream [ebusd releases page](https://github.com/john30/ebusd/releases).

## Support

**Configuration and device issues** — this app only runs ebusd; CSV message definition files are not managed here.
Please see the official [ebusd project](https://ebusd.eu) and [community](https://github.com/john30/ebusd/discussions).

**Issues specific to running ebusd via HA Supervisor** — use [Issues](https://github.com/LukasGrebe/ha-addons/issues) or [Pull Requests](https://github.com/LukasGrebe/ha-addons/pulls).
