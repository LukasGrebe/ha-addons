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
  protocol prefix, default port 9999 may be omited e.g. `ens:192.168.1.100` or `enh:192.168.1.100:123`

Leave both blank to let ebusd attempt mDNS auto-discovery.

### 4. Configure ebusd options

Use the **Additional ebusd options** list to pass flags to ebusd. Add one flag per entry.
Each flag must be its own entry — do not combine multiple flags in one line.

The following are always set by the addon and do not need to be added manually:

| Flag | Source |
|---|---|
| `--foreground` | always |
| `--updatecheck=off` | always |
| `--mqtthost/port/user/pass` | auto-filled from Mosquitto broker (see [MQTT](#mqtt)) |
| `--mqttjson` | auto-added when **Seed HA MQTT integration config** is enabled |
| `--mqttint=/config/mqtt-hassio.cfg` | auto-added when **Seed HA MQTT integration config** is enabled |

Common flags to add:

| Flag | Purpose |
|---|---|
| `-s` or `--scanconfig` | Scan the bus for known devices on startup |
| `--pollinterval=30` | Increase default 5 second Poll interval to 30 seconds |
| `--httpport=8889` | Enable HTTP port for the ebusd web interface |
| `--log=bus:debug` | Enable debug logging for the bus |
| `--configlang=de` | Prefer German message definitions |
| `--configpath=/config/` | Use local message definition files (see [Custom message definitions](#custom-message-definitions)) |
| `--mqtttopic=myheating` | Override the default `ebusd` MQTT topic prefix |

Full flag reference: [ebusd wiki: Run](https://github.com/john30/ebusd/wiki/2.-Run)

### 5. Start the app

Start the app and watch the log. A successful startup looks like:

```
[INFO] eBUSd addon version 26.1.x
[INFO] ebusd --foreground --updatecheck=off --mqtthost=... --mqttjson ...
```

Entities appear in HA in [the MQTT Domain](https://my.home-assistant.io/redirect/integration/?domain=mqtt) after the first successful bus scan.

---

## MQTT

### Auto-configured credentials (Mosquitto broker)

When the [HA App: Mosquitto broker](https://github.com/home-assistant/addons/tree/master/mosquitto) is running, the ebusd addon automatically reads its
host, port, username and password from the Supervisor and passes them to ebusd as
`--mqtthost`, `--mqttport`, `--mqttuser`, `--mqttpass`. No manual configuration is needed.

### Using an external MQTT broker or disabeling auto configuration

To connect to a broker other than the HA Mosquitto addon, add `--mqtthost=` to
`commandline_options`. The addon detects this and skips the Supervisor auto-fill:

```
--mqtthost=192.168.1.10
--mqttport=1883
--mqttuser=myuser
--mqttpass=mypass
```

### HA MQTT discovery (`seed_mqtt_cfg`)

The **Seed HA MQTT integration config** option (default: enabled) controls whether the
addon manages the `mqtt-hassio.cfg` integration config file for you:

- **On first start** — copies the bundled `mqtt-hassio.cfg` to
  `/addon_configs/<slug>/mqtt-hassio.cfg` (i.e. `/config/mqtt-hassio.cfg` inside the container)
  and automatically adds `--mqttint=/config/mqtt-hassio.cfg` and `--mqttjson` to the
  ebusd arguments. This enables HA MQTT auto-discovery for all devices ebusd finds.
- **On subsequent starts** — the file is not overwritten; the log will remind you that
  seeding is still active and tell you how to take full ownership.

**To disable** — set **Seed HA MQTT integration config** to `false`. The addon will no
longer add `--mqttint` or `--mqttjson` automatically. Add them to `commandline_options`
yourself if still needed.
Seeding is
skipped automatically when a custom `--mqttint` is detected;

**To use a custom integration config** — place it in `/addon_configs/<slug>/your-file.cfg` and add `--mqttint=/config/your-file.cfg` to `commandline_options`. (Also add `--mqttjson` manually if your config requires it).

> **Note:** `--mqttjson` and `--mqttint` are independent flags. The seeded
> `mqtt-hassio.cfg` is built for JSON payloads, but a custom integration config may or
> may not require `--mqttjson` — only you know which.

---

## Migrating ebusd options from version 25.1 or older

The configuration schema changed significantly in version 26.1. Individual config fields
(`scanconfig`, `loglevel_all`, `mqtttopic`, `mode`, `readonly`, etc.) have been removed.

**At startup the app will warn you if it detects your old config fields** — look for lines
starting with `DEPRECATED CONFIG FIELDS DETECTED` in the log.

To migrate, translate your old fields into `commandline_options` list entries:

| Old field | New entry in commandline_options |
|---|---|
| `scanconfig: true` | `-s` or `--scanconfig` |
| `loglevel_all: info` | `--log=all:info` |
| `loglevel_bus: debug` | `--log=bus:debug` |
| `mqtttopic: foobar` | `--mqtttopic=foobar` |
| `mqttint: /etc/ebusd/custom_mqtt.cfg` | `--mqttint=/config/custom_mqtt.cfg` (see below) |
| `readonly: true` | `--readonly` |
| `pollinterval: 30` | `--pollinterval=30` |
| `http: true` | `--httpport=8889` |
| `configpath: /config/ebusd/` | `--configpath=/config/` (see below) |
| `mode: ens` + `network_device: 192.168.1.1:9999` | set **network\_device** to `ens:192.168.1.1` (default port 9999 can be omited) |
| `mqttvar: filter-direction=r` | `--mqttvar=filter-direction=r` |

MQTT credentials (`mqtthost`, `mqttport`, `mqttuser`, `mqttpass`) are now 
auto-configured from the HA Mosquitto broker — remove them from your config entirely. Auto-configuration is disabled if `--mqtthost` is set

---

## App config folder

The app config folder is at `/addon_configs/2ad9b828_ebusd/` on the HA host and mounted at
`/config` inside the running container. It is included in HA backups.

The prefix `2ad9b828` is derived from the repository URL as you added it
(`https://github.com/LukasGrebe/ha-addons/`); a different spelling of the URL, or a
[test version](#testing-upcoming-versions), gets a different prefix. If the folder
does not exist, look into `/addon_configs/` for the `…_ebusd` folder.

Access it via:

- **Studio Code Server** (VS Code in browser addon) — full filesystem access, browse to `/addon_configs/2ad9b828_ebusd/`
- **SSH** (Advanced SSH addon) — `cd /addon_configs/2ad9b828_ebusd/`
- **Samba** — exposed as the `addon_configs` share


| Host path | Container path | Purpose |
|---|---|---|
| `/addon_configs/2ad9b828_ebusd/mqtt-hassio.cfg` | `/config/mqtt-hassio.cfg` | MQTT integration config (seeded on first start when **Seed HA MQTT integration config** is enabled) |
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

ebusd expects to find `.csv` files directly in the configpath root (loaded on every
startup) and/or `<manufacturer>/*.csv` subdirectories (loaded per-device when
`--scanconfig` is active). A CDN clone adds a language layer on top (`en/`, `de/`, etc.)
— point `--configpath` at the language subdirectory, not the repo root.

> **Tip:** The addon checks your `--configpath` at startup and warns if no CSV files are
> found at the expected locations. If it detects CSV files in a nearby directory (parent
> or language subdir), it will suggest the correct path — watch the log for
> `Did you mean...` messages.
>
> HTTP/HTTPS configpath URLs are skipped by this check.

> **Note:** `/config/` inside the container maps to
> `/addon_configs/2ad9b828_ebusd/` on the HA host — not to the HA `/config/` folder.
> A common mistake is setting `--configpath=/config/ebusd` when the CSV files are
> actually in `/config/` (i.e. the addon config root).

For authoring custom definitions, see the
[ebusd-configuration](https://github.com/john30/ebusd-configuration) repo and the
[ebus-notebook](https://github.com/john30/ebus-notebook) VS Code extension.
The toolchain uses TypeSpec (`.tsp` files) compiled to CSV — this requires a local
Node.js install and is not possible inside the HA VS Code addon.

---

## SQLite telegram log

Set **SQLite telegram log (database file)** to store every telegram ebusd receives from
the bus in an SQLite database: also telegrams without a message definition, ebusd's own
telegrams, and broken ones (CRC errors, NAK, no answer).

```yaml
sqlite_db: /share/ebusd/telegrams.db
sqlite_retention_days: 10
```

- `/share/…` can also be read by Home Assistant itself (e.g. the
  [SQL integration](https://www.home-assistant.io/integrations/sql/)) and other apps.
  `/config/…` is the app config folder (`/addon_configs/2ad9b828_ebusd/` on the host).
- Telegrams older than **SQLite telegram log retention** days are deleted every hour
  (default 10, `0` keeps everything). A telegram takes about 190 bytes, which is roughly
  50–170 MB per day depending on bus traffic. Both folders are part of HA backups.
- The app enables ebusd's binary dump of received bytes (`--dump`, `--dumpfile`,
  `--dumpflush`, `--dumpsize`) and points it at a FIFO read by the logger. Don't add dump
  options to `commandline_options` (the telegram log is then disabled), and don't run
  `ebusctl dump`: it switches the dump off until you run it again.
- Don't open the database over the Samba share while the app is running (SQLite locking
  does not work over network shares). Copy the file or use the built-in terminal.

### Table `telegram`

One row per telegram, i.e. per sequence of bytes between two SYN (`aa`). The columns follow
the eBUS telegram structure `QQ ZZ PB SB NN DD… CRC ACK NN DD… CRC ACK SYN`:

| Column | Content |
|---|---|
| `id` | row id |
| `ts` | arrival time of the first byte, integer nanoseconds since 1970-01-01 UTC |
| `type` | `BC` broadcast (ZZ = `fe`), `MM` master-master, `MS` master-slave |
| `qq` | source address (master) |
| `zz` | destination address |
| `pb`, `sb` | primary and secondary command |
| `nn` | number of data bytes of the master part |
| `dd` | data bytes of the master part (hex) |
| `crc` | CRC of the master part |
| `ack` | `00` (ACK) or `ff` (NAK) from the destination; empty for broadcasts |
| `s_nn`, `s_dd`, `s_crc` | number of data bytes, data bytes (hex) and CRC of the slave answer (`MS` only) |
| `s_ack` | `00` (ACK) or `ff` (NAK) from the source for the slave answer |
| `status` | `ok`; `crc` CRC mismatch; `nak` rejected again after the repetition; `timeout` ended by SYN before complete (e.g. slave did not answer); `invalid` invalid address or ACK byte; `escape` invalid escape sequence; `trailing` extra bytes after a complete telegram |
| `raw` | all bytes between the two SYN exactly as received (hex, escaped) |

Single bytes are stored as integers, data bytes unescaped as lower-case hex text. Columns
of parts that were not received are empty (`NULL`). If a part is repeated after a NAK, the
columns hold the repetition and `raw` holds both.

Indexes: `(ts)`, `(qq, zz, pb, sb, ts)`, `(zz, pb, sb, ts)` and `(pb, sb, ts)`.

The view `telegram_hex` shows the same rows with readable UTC and local times, single
bytes in hex, and the master and slave part in ebusd's `QQZZPBSBNNDD` / `NNDD` notation
(as in `ebusctl grab` and ebusd's `received unknown MS cmd` log lines).

**Timestamps** are taken by the logger with a nanosecond clock when ebusd hands over each
byte, typically a few hundred microseconds after ebusd read it from the adapter.

**Enhanced adapters** (`enh:`, `ens:`) report the source address of ebusd's own telegrams
to ebusd as sent instead of received, so it is missing from ebusd's dump. The logger
restores it from ebusd's own address (`--address`, default `31`) when that gives a valid CRC.

### Querying

In the built-in terminal (**Open Web UI**):

```bash
sqlite3 -box /share/ebusd/telegrams.db \
  "SELECT time_local, master, slave, status FROM telegram_hex ORDER BY id DESC LIMIT 20"
```

Query the table with hex literals to use the indexes:

```sql
-- latest B5 09 telegrams from ebusd (31) to the heater (08)
SELECT ts, dd, s_dd FROM telegram
WHERE qq = 0x31 AND zz = 0x08 AND pb = 0xb5 AND sb = 0x09
ORDER BY ts DESC LIMIT 20;

-- telegrams per command during the last hour
SELECT printf('%02x%02x', pb, sb) AS cmd, count(*) AS n FROM telegram
WHERE ts > (strftime('%s', 'now') - 3600) * 1000000000
GROUP BY pb, sb ORDER BY n DESC;

-- bus errors per day
SELECT date(ts / 1000000000, 'unixepoch') AS day, status, count(*) FROM telegram
WHERE status != 'ok' GROUP BY day, status;
```

For a Home Assistant sensor, add the **SQL** integration with the database URL
`sqlite:////share/ebusd/telegrams.db` and e.g. the query
`SELECT count(*) AS errors FROM telegram WHERE status != 'ok' AND ts > (strftime('%s', 'now') - 3600) * 1000000000`
(column `errors`).

---

## Testing upcoming versions

Changes are collected on the `next` branch before they are released. You can install
them as a separate test app next to your regular eBUSd:

[![Add repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FLukasGrebe%2Fha-addons%23channel-next)

or add `https://github.com/LukasGrebe/ha-addons#channel-next` as a repository in the app
store (⋮ → Repositories), then install **eBUSd (next)**. Every change to `next` shows up
as an update of it.

- Stop your regular eBUSd first: an adapter can only be used by one app at a time.
- The test app has its own configuration and its own config folder
  `/addon_configs/963a193d_ebusd`. Copy `mqtt-hassio.cfg` or CSV files there if you use them.
- With the same MQTT settings, both apps publish the same topics, so your HA entities keep working.
- When done: uninstall the test app, start eBUSd again and remove the repository.

Every pull request also gets a test app **eBUSd (PR #N)**: the PR has a comment with the
link. Supervisor builds it on your device, so the first install takes a few minutes.

Please report what you find in the pull request, or in an
[issue](https://github.com/LukasGrebe/ha-addons/issues) for `next`.

---

## Startup log reference

The addon logs its decisions at startup. Here is what each message means:

| Log message | Meaning |
|---|---|
| `Seeding default mqtt-hassio.cfg` | First start with `seed_mqtt_cfg: true` — file copied, `--mqttint` and `--mqttjson` added |
| `mqtt-hassio.cfg exists … seed_mqtt_cfg is true` | File already present — reminds you to set `seed_mqtt_cfg: false` to take ownership |
| `Custom --mqttint found … skipping auto seeding` | You supplied `--mqttint=` yourself; seeding and auto `--mqttjson` are skipped |
| `mqtt-hassio.cfg exists … seed_mqtt_cfg is false … no --mqttint` | File is present but unused — add `--mqttint=` or re-enable seeding |
| `Custom --mqtthost found … skipping Supervisor MQTT credentials` | External broker detected via `--mqtthost` in `commandline_options` |
| `MQTT service not available … no --mqtthost` | [Mosquitto App](https://github.com/home-assistant/addons/tree/master/mosquitto) not running and no manual `--mqtthost` — MQTT is disabled |
| `--configpath=… contains no CSV files` | Local configpath has no files ebusd can load; check the path |
| `Did you mean …?` | Addon found CSV files in a nearby directory and suggests an alternative |
| `--configpath ends in '…' but --configlang=…` | Language folder and `--configlang` don't match — loading one language's files while asking for another language's inline translations |
| `commandline_options entry '…' looks like multiple flags` | Two or more flags were put in a single entry — split them into separate entries |
| `Duplicate flag in commandline_options: '…'` | The same flag appears more than once |
| `DEPRECATED CONFIG FIELDS DETECTED` | Old (≤25.1) schema fields found — migrate them to `commandline_options` |
| `SQLite telegram log: writing telegrams to …` | The [SQLite telegram log](#sqlite-telegram-log) is running |
| `sqlite_db is set, but commandline_options contains ebusd dump options` | Remove the `--dump…` flags — the telegram log needs ebusd's dump for itself |
| `SQLite telegram log: unable to open database …` | The `sqlite_db` path is invalid or not writable; ebusd runs without the telegram log |
| `SQLite telegram log: no data from ebusd for 60 seconds` | No bus signal, or the dump was switched off with `ebusctl dump` (run it again to switch it on) |
| `SQLite telegram log exited with code … — restarting in 10s` | The logger crashed and is restarted; telegrams in between are not recorded |
