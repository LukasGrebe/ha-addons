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

| Host path | Container path | Purpose |
|---|---|---|
| `/addon_configs/ebusd/mqtt-hassio.cfg` | `/config/mqtt-hassio.cfg` | MQTT integration config |
| `/addon_configs/ebusd/ebusd-configuration/` | `/config/ebusd-configuration/` | Local CSV message definitions |

---

## MQTT configuration

ebusd talks to Home Assistant via MQTT. The broker connection (host, port, credentials)
is injected automatically by the Supervisor — you don't configure that.

What you *can* customise is the MQTT integration behaviour via `mqtt-hassio.cfg`.
On first start, the default file is seeded into the app config folder. Edit it at:

- **SSH / Terminal**: `/addon_configs/ebusd/mqtt-hassio.cfg`
- **Studio Code Server** addon (VS Code in browser): has full filesystem access, browse to `/addon_configs/ebusd/`
- **Samba share**: exposed as the `addon_configs` share if you have the Samba addon installed

The file is passed to ebusd as `--mqttint=/config/mqtt-hassio.cfg`. See the
[ebusd MQTT integration docs](https://github.com/john30/ebusd/wiki/5.1-MQTT-integration)
for all available options.

If you want to use a different file, set in **commandline\_options**:
```
--mqttint=/config/my-custom.cfg
```

---

## CSV message definitions

By default ebusd fetches message definitions from [ebus.github.io](https://ebus.github.io)
— a CDN serving pre-compiled CSV files. **You don't need to configure anything for this to work.**

Files are organised by language and manufacturer (e.g. `/en/vaillant/`). ebusd picks
the right file automatically when `--scanconfig` is used.

To change the preferred language:
```
--configlang=de
```

To use a **local offline copy** of the pre-compiled CSVs, clone
[ebus.github.io](https://github.com/eBUS/ebus.github.io) into the app config folder
and point ebusd at the language subfolder:

```
--configpath=/config/ebusd-configuration/en
```

See [ebus.github.io](https://ebus.github.io) and the
[ebusd configuration docs](https://github.com/john30/ebusd/wiki/4.-Configuration)
for folder structure and source mapping details.

---

## Using ebusctl (interactive shell)

`ebusctl` is the command-line client bundled with ebusd for querying the bus directly.

### Via the built-in terminal (easiest)

The app includes a web terminal. Open it by clicking **Open Web UI** on the addon's Info page.
It opens a full shell inside the running container — no extra addons or configuration needed.

```bash
ebusctl info
ebusctl read -f Hc1HeatCurveShift
ebusctl find -d -r
```

### Via SSH (alternative)

SSH into the addon container using the
[Advanced SSH & Web Terminal](https://github.com/hassio-addons/addon-ssh) addon
(the standard SSH addon cannot exec into other containers — you also need to disable
**Protection mode** on the addon's Info page).

```bash
# Open a shell inside the running ebusd container
docker exec -it $(docker ps --filter name=ebusd --format '{{.ID}}') /bin/bash
```

### Via raw TCP

Port 8888 accepts raw TCP connections — useful for scripting or quick queries without a shell:
```
telnet <HA-IP> 8888
```

See [ebusd wiki: TCP client commands](https://github.com/john30/ebusd/wiki/3.1.-TCP-client-commands)
for the full command reference.

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


---

## Writing custom message definitions (VS Code)

Message definitions are authored as [TypeSpec](https://typespec.io) `.tsp` files
(found in the `/src/` folder of [ebusd-configuration](https://github.com/john30/ebusd-configuration))
and compiled to CSV using the [ebus-typespec](https://github.com/john30/ebus-typespec) library.
**You work with `.tsp` source files, not CSV directly.**

The official tool for this is the
[ebus-notebook](https://github.com/john30/ebus-notebook) VS Code extension by john30 —
a notebook interface that handles authoring, compilation, and live testing in one place.

> **Note:** There is not yet a good, established practice on getting this toolchain up and running in Home Assistant + App

### Setup

1. Install [Node.js](https://nodejs.org) on your local machine if not already present.
2. Install the [TypeSpec for VS Code](https://marketplace.visualstudio.com/items?itemName=typespec.typespec-vscode) extension from the marketplace.
3. Install the eBUS TypeSpec package in your workspace:
   ```bash
   npm i @ebusd/ebus-typespec
   ```
4. Install [ebus-notebook](https://github.com/john30/ebus-notebook) from the repo
   (clone and install via VS Code's *Install from VSIX* if not yet on the marketplace).

### Connect to your running ebusd instance

The extension can talk directly to your ebusd instance for live testing and decoding.
Enable it by adding to **commandline\_options**:

```
--enabledefine
```

Then configure the extension in VS Code settings:

| Setting | Value |
|---|---|
| `ebus-notebook.ebusd.host` | IP of your Home Assistant instance |
| `ebus-notebook.ebusd.port` | `8888` (or whatever port you exposed) |

> Port 8888 must be mapped in the app's **Network** settings for the extension to reach it.

### Workflow

1. Run `Create New eBUS Notebook` in the VS Code command palette to get started.
2. Write TypeSpec definitions in the notebook cells (`.tsp` format).
3. The extension compiles them to CSV and can test them live against your running ebusd.
4. Place the compiled CSV files in `/addon_configs/ebusd/ebusd-configuration/` and
   point ebusd at that folder:
   ```
   --configpath=/config/ebusd-configuration
   ```

---


