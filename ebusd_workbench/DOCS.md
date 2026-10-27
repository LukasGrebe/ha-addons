# Home Assistant App: eBUSd Workbench

The Workbench is for working on eBUS message definitions. It reads the telegrams recorded by
the [eBUSd app](../ebusd/DOCS.md#sqlite-telegram-log), shows them next to Home Assistant
entity changes, and lets you edit, compile, test and deploy definitions from the browser. The
device only serves files and the database: the TypeSpec compiler and ebusd's message decoder
run in your browser.

> This is a first version. Expect rough edges and please report what you find in
> [issues](https://github.com/LukasGrebe/ha-addons/issues).

---

## Setup

### 1. Record the bus with the eBUSd app

In the eBUSd app configuration set **SQLite telegram log (database file)** to
`/share/ebusd/telegrams.db` (and optionally the retention in days), then restart it. Every
telegram on the bus is now stored, also unknown and broken ones.

### 2. Install and configure the Workbench

| Option | Meaning |
|---|---|
| **Telegram database** | The same path as `sqlite_db` of the eBUSd app, default `/share/ebusd/telegrams.db`. Both layouts of the telegram log are read (schema version 2 of eBUSd 26.1.11 and later, and version 1). The Workbench adds its own table `ha_state` for entity changes and shows the notes of the eBUSd terminal's `log` command (table `event`); it creates the file if the eBUSd app has not yet. |
| **Deploy folder for compiled CSV files** | Where the compiled definitions are written, default `/share/ebusd/config`. |
| **Git repository of the message definitions** | HTTPS URL of your fork of [ebusd-configuration](https://github.com/john30/ebusd-configuration), cloned into the app config folder (`/addon_configs/…_ebusd_workbench/repo`) at start when it is not there yet. Can also be done from the UI. |
| **Git user name / email** | Author of the commits made in the Workbench. |
| **Git access token** | Token for `git push` (and for pulling private repositories) over HTTPS, e.g. a GitHub fine-grained token with *Contents: read and write* on the fork. It is handed to git on each request and never written to disk. |

Start the app and click **Open Web UI** (the Workbench is also in the sidebar).

### 3. Use the compiled definitions in the eBUSd app

Once you have deployed definitions, add to `commandline_options` of the eBUSd app:

```
--configpath=/share/ebusd/config
```

and restart it (also after every new deploy). Keep `--scanconfig` to let ebusd pick the right
file per device by its identification, as with the online configuration.

---

## Timeline

Every telegram is grouped into a row by **source → destination, command (PB SB) and message
ID**. The message ID is the first data bytes of the master part (default 1 byte; 3 bytes for
`b509`, the Vaillant register read/write). The remaining data bytes and the answer of the
slave are the **value**.

- A **bar** spans the time the value did not change, labelled with the value, the number of
  repetitions and the typical interval: `0d2800 / 03a1  ×120 every 30 s`. A dotted line
  continues to the next, different value.
- A single telegram is a **tick**.
- Rows are sorted by address; use *most changes* to find what varied, *only changed* to hide
  constant rows, and the filter for addresses, commands or names.
- **ID bytes** sets the default message ID length; per command (or device and command)
  lengths are set from the details panel or in *Settings*, and **ID lengths from
  definitions** applies the lengths of the decoded definitions after a decode run. Rows that
  seem to change with every telegram (a date/time broadcast for example) do so because the
  whole payload is the value; rows mixing several registers need more ID bytes.
- Wheel zooms, dragging pans, `+`/`-`/`←`/`→` work as well, `N` returns to **live** mode in
  which the right edge follows the current time. The strip at the top shows the whole recording
  (red: telegrams with errors); click or drag in it to jump.
- Clicking a bar lists its telegrams with timestamp, master part (`QQ ZZ PB SB NN DD`), slave
  part (`NN DD`) and status; **decode ›** sends one to the definitions tab.
- Broken telegrams (`crc`, `nak`, `timeout`, …) are red.

The window is cut when it contains more than 300 000 telegrams (a note appears); zoom in then.

### Home Assistant events

In *Settings* pick the entities whose state changes you want to see (the circulation pump,
a thermostat, a window sensor, …). The Workbench subscribes to them through the Home
Assistant API and stores every change in the table `ha_state` of the telegram database, with
the previous state and the attributes. They appear as rows at the top of the timeline. Only
state changes are stored, attribute-only changes are ignored.

### Notes and markers

Notes made with the `log` command in the eBUSd app's terminal ("set hot water to 50 °C",
with the time it happened and how exact that time is) are drawn as orange markers with the
uncertainty as a band. **+ marker** in the timeline adds such a note at the current time.
Both live in the table `event` of the telegram database, in the layout of the eBUSd app.

### Tables

| Table | Content |
|---|---|
| `event` (eBUSd app) | `ts`, `ts_min`, `ts_max` (ns since 1970-01-01 UTC), `message`, `logged` |
| `ha_state` (Workbench) | `ts`, `entity`, `state`, `previous`, `attributes` (JSON), `source` (`ha` change, `ha-initial` state when the subscription started) |

---

## Definitions

The left column is the git repository, the middle the workspace (editor, decoded telegrams,
setup, export, evidence), the right the build steps.

### Repository

1. **Clone** your fork of ebusd-configuration (or *Start empty*). The tree shows the
   `.tsp` sources; symlinked files (ebusd-configuration shares definitions between devices
   that way) are read-only, edit their target.
2. **Edit** a file and **Save** (Ctrl+S). Changed files are marked in the tree and listed with
   *diff* and *discard*; enter a message and **Commit** the selected ones. **Pull** is
   fast-forward only, **Push** needs the access token.

### Community layers

Definitions for a heating system often sit in open pull requests of
[ebusd-configuration](https://github.com/john30/ebusd-configuration/pulls) for a long time
(for a Vaillant aroTHERM with HMU HW5103 and VWZIO, for example, #660, #598 and #604 add a lot).
Instead of merging them into your fork, add them as **layers**: enter the pull request number
(or a branch such as `upstream/master`) and the Workbench fetches its head from the upstream
repository (`https://github.com/john30/ebusd-configuration.git`, changeable in the settings
file) into `refs/workbench/`, without touching your checkout. Compiling then applies the
files each enabled layer changes on top of your sources, in the listed order; a file changed
by several layers is merged three-way like git does, and conflicts show up as compile errors
with git's markers. Every decoded definition is attributed to the layer that added it, and the
setup files record it (`# from layer pr/660`). ↻ re-fetches a layer when the pull request was
updated, ✕ removes it.

### Compile

Pick the entry (`src/main.tsp` compiles everything, a single file only that file and what it
imports) and optionally a translation file (`src/de.yaml`). Errors link to the line in the
editor. Unsaved changes of the open file are compiled as they are.

### Decode

**from timeline window** fetches the distinct telegrams of the window shown in the timeline
(in the order of their first appearance), or paste telegrams as `QQZZPBSBNNDD/NNDD` (as in
`ebusctl grab` or the telegram log's `master`/`slave` columns). **Decode** loads the compiled
files into ebusd's message library and, with *all candidates* ticked, lists for every telegram
every definition that fits it: the one ebusd itself would use (file chosen by the scan
identification of the device, condition met, longest ID) and the others. The **Decoded** tab
shows them per telegram, coloured as in the timeline; the timeline rows get the names of the
decoded messages and offer the ID lengths of the definitions.

Conditional definitions (`[Ehp_heatpumptype=3]…` in the CSV, `@condition` in TypeSpec) only
count as used once the telegram that sets the condition has been decoded, which is why the
telegrams are decoded in the order of their first appearance.

### Setup: the definitions of this installation

Upstream hides many definitions from an installation: a file is loaded only for the device
identification it is named after (`08.hmu.HW5103.csv` but not `08.hmu.csv`), conditions
refer to register values the controller may never request, and some pull requests are not
merged. The **Setup** tab lists every definition that matched a recorded telegram, grouped by
device with its identification and the file ebusd loads for it, with a status:

| Status | Meaning |
|---|---|
| active | ebusd uses it for this installation |
| variant | from a file of another device variant; ebusd would not load it, but it decodes the recorded telegrams |
| conditional | its condition was not met by the recorded telegrams, but it decodes them |
| hidden | in the file ebusd loads, but another definition takes precedence |
| error | matches the telegram but does not decode it (wrong length or values) |
| companion | not seen on the bus: the counterpart of a seen definition, usually the write definition |

Tick the definitions for your setup: **include what ebusd uses** is the safe baseline,
**+ plausible hidden ones** adds every hidden definition that decoded all its telegrams
without error, **+ counterparts of included** adds the write definitions belonging to included
ones. The example column shows decoded values, so you can judge whether a hidden definition
fits (a temperature of 21.5 °C is plausible, 6553.5 °C is not). Write definitions are marked
red: writing to a device with a definition of another variant can be harmful, so include only
what you are sure about, and test reading first. The selection is stored in the app's data
folder.

### Export

- **Definitions of this installation**: one CSV file per circuit with the included
  definitions, conditions removed, with comments naming the source file and layer of each
  definition. Circuit names can be changed first (`vwz → vwzio` if your entities use that
  topic). **Deploy setup** writes them to the deploy folder (optionally a subfolder, removing
  other definition files there if ticked); ebusd then needs `--configpath` pointing there and
  loads them at startup without scan-based file selection (remove `--scanconfig`, or keep it
  with no `vaillant/` folder present). **Download** saves the files locally.
- **All compiled files**: the complete tree as ebusd's scan expects it.
- **Home Assistant climate and water heater**: `mqtt:` YAML for `configuration.yaml` with a
  `climate` per zone (`Z1RoomTemp`, `Z1DayTemp`, `Z1OpMode`, `RoomHumidity`; the action from
  `RunDataStatuscode` when present) and a `water_heater` (`HwcTempDesired`, `HwcOpMode`, the
  storage temperature from `HwcStorageTemp` or a message with the field `hwcstoragetemp`),
  built from the setup's messages and their field names. ebusd's own `mqtt-hassio.cfg` creates
  a sensor, number or select per field; these composite entities it cannot. A note at the top
  lists what is missing (usually the write definitions). Next to it, the eBUSd app options for
  the setup: `--configpath` and `--mqttvar=filter-name=…` so that MQTT discovery publishes the
  setup's messages, including writable ones.
- **ebusd raw log for ebus-evidence**: the recorded telegrams of a time range as ebusd
  message-mode raw log (`--lograwdata`), the input of
  [ebus-evidence](https://github.com/MarcelT87/ebus-evidence). Telegrams sent by ebusd itself
  (own address, default 31) are written with the direction changes ebusd logs. Run
  `ebus-evidence doctor --raw FILE --profile hw5103-open-evidence`, `import --raw FILE` and
  `export` on another computer to get a verified `evidence.zip` for cross-installation
  research (see
  [ebusd-configuration#690](https://github.com/john30/ebusd-configuration/issues/690)).

### Evidence

Paste an ebus-evidence profile (YAML) or load the bundled example
(`hw5103-open-evidence`, MIT License, MarcelT87) and **Run checks on the timeline window**:
for every check the matching telegrams of the window are counted, the first and last
occurrence shown and the value the check describes decoded (u8, u16le, float32le, …). This
shows what your bus carries for what the research is looking at; **Download summary** saves
it as JSON for discussion. The verified bundle must come from ebus-evidence itself, from the
exported raw log. Checks naming `source=f1` refer to ebusd's own address in the profile
author's installation.

The compiler and the decoder are loaded into the browser on first use (about 1.8 MB).

---

## Folders

| Container path | Host path | Content |
|---|---|---|
| `/share/ebusd/telegrams.db` | `/share/ebusd/telegrams.db` | telegram database (eBUSd app and Workbench) |
| `/share/ebusd/config` | `/share/ebusd/config` | deployed CSV files for the eBUSd app |
| `/config/repo` | `/addon_configs/…_ebusd_workbench/repo` | git repository with `refs/workbench/*` for the layers (in backups) |
| `/data/settings.json` | – | Workbench settings (entities, ID lengths, layers, setup, …; in backups) |

---

## Limitations of this first version

- The editor is a plain text area (no syntax highlighting or completion).
- Telegrams are grouped by address and ID bytes; the ID lengths of the decoded definitions can
  be applied with one click, but rows are not merged by message definition yet.
- Compiling and decoding happen on the main thread of the browser; the full
  ebusd-configuration takes about two seconds.
- Only HTTPS remotes with a token are supported for push.
- No prebuilt image yet: Supervisor builds the app on the device at installation (a minute
  or two).
