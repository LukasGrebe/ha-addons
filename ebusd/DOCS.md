# Home Assistant App: eBUSd

> **This app is a transparent wrapper.** It packages the unmodified
> [ebusd](https://ebusd.eu) binary from [john30/ebusd](https://github.com/john30/ebusd)
> into a Home Assistant supervised container. Nothing more.

**If something isn't working, the answer is almost always in the ebusd docs, not here.**
Issues with device communication, CSV message definitions, MQTT entity values, bus
errors, or heating-system behaviour belong with the ebusd project:

- [ebusd wiki](https://github.com/john30/ebusd/wiki) — primary reference
- [ebusd wiki: Run](https://github.com/john30/ebusd/wiki/2.-Run) — all command-line options
- [ebusd-configuration](https://github.com/john30/ebusd-configuration) — message CSV files
- [ebusd discussions](https://github.com/john30/ebusd/discussions) — community support

Open an issue in [this repository](https://github.com/LukasGrebe/ha-addons/issues) only
for problems specific to running ebusd inside Home Assistant Supervisor (startup failures,
HA integration, config folder access).

---

## Quick start

1. Connect a [hardware interface](https://github.com/john30/ebusd/wiki/6.-Hardware)
   to the device running Home Assistant OS.
2. Set **device** (USB picker) or **network\_device** (network/enhanced adapters).
3. Start the app and check the log for the initial bus scan.
4. Entities appear in HA under a device named *ebusd* after the first successful scan.

---

## Configuration

All options map directly to ebusd command-line flags. Each option in the UI includes
a description with the corresponding flag and a link to the ebusd wiki.

Two things are managed internally and cannot be configured:

| Managed internally | Reason |
|---|---|
| `--foreground` | Required for HA process management |
| `--mqtthost/port/user/pass` | Auto-configured from the HA Mosquitto broker via Supervisor |

For any ebusd option not in the UI, use **commandline\_options**.

---

## App config folder

The app config folder is mounted at `/config` inside the container and at
`/addon_configs/ebusd/` on the host. Included in HA backups.

| Path | Purpose |
|---|---|
| `/config/mqtt-hassio.cfg` | MQTT integration config — seeded on first start, edit to customise |
| `/config/ebusd-configuration/` | Optional local [CSV message definitions](https://github.com/john30/ebusd-configuration) |

---

## Upgrading from a previous version

### Config folder change

Previous versions used the shared HA config folder. This version uses a dedicated app
config folder.

| | Old location | New location |
|---|---|---|
| File Editor | root of HA config | *ebusd* app config section |
| SSH | `/homeassistant/` | `/addon_configs/ebusd/` |

**One-time migration (SSH/terminal):**

```bash
cp -r /homeassistant/ebusd-configuration/ /addon_configs/ebusd/
cp    /homeassistant/mqtt-hassio.cfg       /addon_configs/ebusd/
```

Restart the app after copying.

### Option changes

All individual options have been removed and replaced with direct ebusd CLI equivalents.
Pass any options that are no longer in the UI via `commandline_options`.



