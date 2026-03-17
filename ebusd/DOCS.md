# Home Assistant App: eBUSd

> **This app is a transparent wrapper.** It packages the unmodified
> [ebusd](https://ebusd.eu) binary from [john30/ebusd](https://github.com/john30/ebusd)
> into a Home Assistant supervised container. Nothing more.

**If something isn't working, the answer is almost always in the ebusd docs, not here.**
Issues with device communication, CSV message definitions, MQTT entity values, bus
errors, or heating-system behaviour belong with the ebusd project:

- [ebusd wiki](https://github.com/john30/ebusd/wiki) — primary reference
- [ebusd wiki: Run](https://github.com/john30/ebusd/wiki/2.-Run) — all command-line flags
- [ebusd-configuration](https://github.com/john30/ebusd-configuration) — message CSV files
- [ebusd discussions](https://github.com/john30/ebusd/discussions) — community support

Open an issue in [this repository](https://github.com/LukasGrebe/ha-addons/issues) only
for problems specific to running ebusd inside Home Assistant Supervisor (startup failures,
HA integration, config folder access).

---

## Setup

### 1. Connect your hardware

Connect a compatible [eBUS hardware interface](https://github.com/john30/ebusd/wiki/6.-Hardware)
to your Home Assistant device — either USB or network-attached.

### 2. Install and configure Mosquitto

This app communicates with HA via MQTT. Install the **Mosquitto broker** app from the
HA App Store and start it. The ebusd app will auto-detect it.

### 3. Configure the adapter

In the app configuration, set one of:

- **USB eBUS adapter** — select the TTY device from the picker (e.g. `/dev/serial/by-id/...`)
- **Network / enhanced-protocol adapter** — enter the full device string including
  protocol prefix, e.g. `ens:192.168.1.100:9999` or `enh:192.168.1.100:9999`

Leave both blank to let ebusd attempt mDNS auto-discovery.

### 4. Configure ebusd options

Use the **Additional ebusd options** list to pass flags to ebusd. Add one flag per entry.

The default list already contains `--mqttjson` — this is required for HA MQTT discovery.
**Do not remove it.**

Common flags to add:

| Flag | Purpose |
|---|---|
| `--scanconfig` | Scan the bus for known devices on startup |
| `--pollinterval=30` | Poll interval in seconds |
| `--httpport=8889` | Enable HTTP port for the ebusd web interface |
| `--log=bus:debug` | Enable debug logging for the bus |
| `--configlang=de` | Prefer German message definitions |
| `--configpath=/config/ebusd/` | Use local message definition files |
| `--mqtttopic=ebusd` | Override the MQTT topic prefix |

Full flag reference: [ebusd wiki: Run](https://github.com/john30/ebusd/wiki/2.-Run)

### 5. Start the app

Start the app and watch the log. A successful startup looks like:

```
[INFO] eBUSd addon version 26.1.x
[INFO] ebusd --foreground --updatecheck=off --mqtthost=... --mqttjson ...
```

Entities appear in HA under a device named *ebusd* after the first successful bus scan.

---

## Migrating ebusd options from version 25.1 or older

The configuration schema changed significantly in version 26.1. Individual config fields
(`scanconfig`, `loglevel_all`, `mqtttopic`, `mode`, `readonly`, etc.) have been removed.

**At startup the app will warn you if it detects your old config fields** — look for lines
starting with `DEPRECATED CONFIG FIELDS DETECTED` in the log.

To migrate, translate your old fields into `commandline_options` list entries:

| Old field | New entry in commandline_options |
|---|---|
| `scanconfig: true` | `--scanconfig` |
| `loglevel_all: notice` | `--log=all:notice` |
| `loglevel_bus: debug` | `--log=bus:debug` |
| `mqtttopic: ebusd` | `--mqtttopic=ebusd` |
| `mqttint: /etc/ebusd/mqtt-hassio.cfg` | `--mqttint=/config/mqtt-hassio.cfg` |
| `readonly: true` | `--readonly` |
| `pollinterval: 30` | `--pollinterval=30` |
| `http: true` | `--httpport=8889` |
| `configpath: /some/path` | `--configpath=/some/path` |
| `mode: ens` + `network_device: 192.168.1.1:9999` | set **network\_device** to `ens:192.168.1.1:9999` |
| `mqttvar: filter-direction=r` | `--mqttvar=filter-direction=r` |

MQTT credentials (`mqtthost`, `mqttport`, `mqttuser`, `mqttpass`) are now always
auto-configured from the Mosquitto broker — remove them from your config entirely.

---

## App config folder

The app config folder is at `/addon_configs/2ad9b828_ebusd/` on the HA host and mounted at
`/config` inside the running container. It is included in HA backups.

Access it via:

- **Studio Code Server** (VS Code in browser addon) — full filesystem access, browse to `/addon_configs/2ad9b828_ebusd/`
- **SSH** (Advanced SSH addon) — `cd /addon_configs/2ad9b828_ebusd/`
- **Samba** — exposed as the `addon_configs` share

> Note: the built-in **File Editor** cannot access app config folders — use one of the above instead.

| Host path | Container path | Purpose |
|---|---|---|
| `/addon_configs/2ad9b828_ebusd/mqtt-hassio.cfg` | `/config/mqtt-hassio.cfg` | MQTT integration config (seeded on first start) |
| `/addon_configs/2ad9b828_ebusd/` | `/config/` | Local message definition CSV files |

## Migrating config folder from version 25.1 or older

The config folder moved from `/config/` (shared with HA) to a dedicated app config
folder. Any files you had in `/config/` (e.g. custom `mqtt-hassio.cfg` or local CSV
files) need to be copied to the new location.

| Old path (≤25.1) | New path (≥26.1) |
|---|---|
| `/config/mqtt-hassio.cfg` | `/addon_configs/2ad9b828_ebusd/mqtt-hassio.cfg` |
| `/config/ebusd-configuration/` | `/addon_configs/2ad9b828_ebusd/` |

Copy your files via SSH or Studio Code Server. The `mqtt-hassio.cfg` is seeded
automatically on first start if it doesn't exist yet — you only need to copy it if you
have a customised version.

After migrating, restart the app and confirm the warning is gone from the logs.


---

## Using ebusctl (interactive shell)

`ebusctl` is the command-line client for querying the bus directly.

### Via the built-in terminal (easiest)

Click **Open Web UI** on the addon's Info page. This opens a full shell inside the
running container — no extra addons needed.

```bash
ebusctl info
ebusctl scan result
ebusctl read -f OutsideTemp
ebusctl find -d -r
```

### Via SSH (alternative)

Requires the [Advanced SSH & Web Terminal](https://github.com/hassio-addons/addon-ssh)
addon with **Protection mode** disabled on the ebusd addon's Info page.

```bash
docker exec -it $(docker ps --filter name=ebusd --format '{{.ID}}') /bin/bash
```

### Via raw TCP

Port 8888 accepts raw TCP — useful for quick queries or scripting. You must first expose
the port under **Network** on the addon's Configuration page (set host port for 8888/tcp).

```
telnet <HA-IP> 8888
```

See [ebusd wiki: TCP client commands](https://github.com/john30/ebusd/wiki/3.1.-TCP-client-commands).

---

## Custom message definitions

ebusd fetches message definitions automatically from [ebus.github.io](https://ebus.github.io)
when `--scanconfig` is set. **You don't need to configure anything for this to work.**

To use local definition files instead, clone the
[ebus.github.io](https://github.com/eBUS/ebus.github.io) repo into the app config folder
and add to `commandline_options`:

```
--configpath=/config/ebusd-configuration/en
```

For authoring custom definitions, see the
[ebusd-configuration](https://github.com/john30/ebusd-configuration) repo and the
[ebus-notebook](https://github.com/john30/ebus-notebook) VS Code extension.
The toolchain uses TypeSpec (`.tsp` files) compiled to CSV — this requires a local
Node.js install and is not possible inside the HA VS Code addon.
