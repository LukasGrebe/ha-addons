# Home Assistant App: ebusd Config Workbench

The ebusd Config Workbench (the Workbench for short) is for working on eBUS message definitions. It reads the telegrams recorded by
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
- Controls like the browser's developer tools: the wheel **scrolls the rows**; **Ctrl/⌘ + wheel**
  or a trackpad pinch zooms the time axis around the pointer; **Shift + wheel** or a sideways
  swipe moves in time; dragging the chart moves, a double click zooms in. `+`/`-`/`←`/`→` work
  as well, `N` returns to **live** mode in which the right edge follows the current time.
  The strip at the top shows the whole recording (red: telegrams with errors): **drag the
  edges of the blue window to resize it, drag inside to move it, drag outside to select a new
  one**; the wheel over it zooms (Ctrl/⌘) or moves.
- The status button in the toolbar and the bar under it show what the app is doing: loading
  telegrams of the window, reading the recording into the browser (day n of m), decoding (x of
  y telegrams), compiling, cloning the repository. A notice appears when there is no definitions
  source (nothing to decode with: rows show raw hex) or the definitions are not compiled yet.
- Clicking a bar lists its telegrams with timestamp, master part (`QQ ZZ PB SB NN DD`), slave
  part (`NN DD`), status and the decoded values of the row's definition.
- Broken telegrams (`crc`, `nak`, `timeout`, …) are red.

A window with more than 200 000 telegrams is not cut: it is **summed up in steps of time**
(about one per pixel; a note says how long a step is). A row's value that did not change stays
one bar; where a row had several values within steps, one lavender bar says how many different
values (at least) and how many telegrams. Zoom in for every value.

### Decoded values, candidates and the setup — without leaving the timeline

As soon as definitions are compiled (automatically at start when a repository is there), the
browser keeps every distinct telegram of the recording and decodes each one with **every
definition that fits it** (see [Decoded recording](#decoded-recording)). The timeline shows the
result in place:

- A row is **named** after the definition that decodes it and its bars show the **decoded
  values** (`temp=23.5 °C;pumpstate=on ×954 every 5 s`) instead of the hex; the tooltip has both,
  and the other candidates' readings.
- **Click a value** (or the name, or the badge `4▾` next to it) and the **details** open below
  the timeline. They stay put while you move the window, and the handle above them resizes them
  (the height is remembered); Esc closes them. They are one view of the message, for one
  definition at a time. **Tabs** switch between the definitions that decode the row, compared
  **over every recorded telegram of the row, not only the visible window**: definitions that
  decode the same values (a copy in another file or circuit) are one tab (`×4` files). A tab shows
  the plain kind (active read, passive write, …), `ebusd` for ebusd's choice, `mine` for your
  own, `differs` when it decodes different values than the row's definition, and ⚠ when it fails
  on some recorded telegram. Hovering a tab previews its decoding in the row's bars. The last
  tabs are **＋ new definition** and, when some fail, **N failing**. Every tab says in a second
  line how it relates to the row's definition (*same values*, *same values, defined differently*,
  *differs in temp, flow*), and its tooltip lists the differences. The panel keeps its tab,
  scroll positions and drafts while new telegrams arrive. Below the tabs:
  - **Source**: *use for this row* (it joins the setup of this installation, the row's other
    definitions leave it), *in setup*, *rename*, the TypeSpec source at its line, what kind it is,
    where it comes from, when it applies (conditions in words), why ebusd does not use it, and the
    files it is in.
  - **Compared with another definition**: this tab beside the row's definition (or any other tab
    you choose): a verdict (identical, same values but defined differently, different values and in
    which fields), then kind, message ID, every field with its type, divisor and unit, the latest
    values, how many variants decode and the files. Differences are highlighted; rows that differ
    only in a name are in italics. Identical copies in other files are listed.
  - **History**: a chart of the definition's values over the whole recording by the timestamp of
    every telegram (hover for a value, click to move the timeline there; the blue band is the
    window), and the values as a list of runs of the same value, newest first, the clicked run
    highlighted (*every telegram* lists them one by one).
  - **Edit**: the definition as a form and as raw CSV, both ways. While you type, ebusd's own
    decoder reads the draft against every recorded variant (how many decode, the latest text,
    the errors), and the chart and list show the **draft**. **Save as my version** never changes
    the source: it adds your own version (kind `mine`) to your own definitions, decodes the whole
    recording with it and picks it for the row. Editing your own definition updates it.
- **Pivot over the fields**: a row that is one whole message of a definition with several fields
  (like `hmu SetMode`: `hcmode`, `flowtempdesired`, `hwctempdesired`, …) has a **+** that shows
  the **values as rows of their own** below it, one per field, each with its value over time;
  **−** folds them away. Clicking a field's value opens the details of the message with that field
  charted. It is only a view: ebusd uses one definition per message ID (a second definition with
  the same ID is shadowed), so the definition itself stays one CSV line, and the Home Assistant
  entities are made per field anyway. Rows whose definition identifies the message by more ID
  bytes than the row shows still split at the next ID byte with **+**.
- **Pivot**: the **+** and **−** buttons next to a row split it at its next message ID byte or
  combine it with the rows that share all but its last byte (all rows of the command when no
  ID byte is left), like expanding and collapsing a pivot table. Only the telegrams that start
  with that prefix are regrouped (the rules are in *Settings → Telegram grouping*, where they can
  be cleared or reset to the defaults). **rows like the definitions** (or the notice above the
  timeline) sets the rules from the decoded definitions: one row per message they know.
- **Collapse a whole command**: commands with many messages (the registers of `b524`, the
  parameters of `b516`) get a header row, *→08 b524 · 312 rows*, with **⊟ one row**: all telegrams
  of that command become one row per source and destination, and **⊞ expand** next to the name
  brings one row per message ID back (the grouping rules of the command are replaced either way).
  The header shows where a command has six or more rows (sorted by address).
- **Thousands of rows**: only the rows in view exist, as labels and on the canvas, so a window
  with thousands of rows scrolls like a short one (browsers draw nothing on canvases taller than
  about 16 000 pixels, which is what long lists ran into).
- **hide failing** in the details (and in the Choose step) hides candidates that fail to decode
  some recorded telegram.
- **source ↗** opens the TypeSpec source of a definition at its line in the editor (read only
  for what only a community layer changes); for an own definition it opens the own definitions.
- **Many candidates on one row** usually means the row groups telegrams by fewer ID bytes
  than the definitions use (for `b51a` the register is 3 bytes, the default row key 1): the
  "candidates" are then different messages (registers), each in the file ebusd loads and again
  in the files of other device variants. The details say so, and a notice above the timeline
  offers **Split rows like the definitions** (also in the details for one command).
- **rename** opens a small form: the message name, and a table of the message's fields (upstream
  name, name in my config, latest value). It gives a message and its fields the names they should
  have in *your* config (`Z1RoomTemp → Zone1RoomTemperature`, `temp → temperature`): the timeline, the exported CSV
  files and the Home Assistant entities use the new names, the upstream names stay in the CSV
  comments and in the definitions table. Names are limited to `A–Z a–z 0–9 _ . -` (they become
  MQTT topics and JSON keys).
- **Setup (N)** opens the drawer on the right: the included definitions by circuit (circuit
  names can be changed there too, e.g. `vwz → vwzio`), each with its status, source and an
  example value, ✎ to rename, ✕ to take it out, and the exports: **Deploy to eBUSd** writes the
  CSV files of the setup to the deploy folder, **Download CSV**, **copy HA YAML** (the
  `climate`/`water_heater` entities) and **copy ebusd options**. Until you change anything, the
  setup is what ebusd itself would use.

The state button in the toolbar (`600 definitions · 11,885 of 44,175 telegrams known to
ebusd · pr/660, …`) shows what is loaded and decoding progress; it opens the definitions tab.

### Home Assistant events

In *Settings* pick the entities whose state changes you want to see (the circulation pump,
a thermostat, a window sensor, …). The Workbench subscribes to them through the Home
Assistant API and stores every change in the table `ha_state` of the telegram database, with
the previous state and the attributes. They appear as **flags in the events lane** between the
time axis and the rows (like log annotations, not as rows): hover for the change, click a flag
for the entity's history of the window. Only state changes are stored, attribute-only changes
are ignored.

### Notes: what the terminal's `log` command does

Notes ("set hot water to 50 °C", with the time it happened and how exact that time is) are
drawn as orange flags in the events lane with the uncertainty as a band across the rows. They
are made with the `log` command of the eBUSd app's terminal or with **＋ event** in the
timeline, which does the same:

- **What happened** (optional: without a message only the time is noted).
- **When**: now, or at a date and time, or **pick on the timeline** and click the moment.
- **How exact**: up to *x* before and *y* after (units ms, s, min, h), with presets: ±500 ms,
  ±2 s, ±10 s, the whole minute, up to 10 min / 1 h before. The band is drawn on the timeline
  while you fill the form.
- The equivalent terminal command is shown (`log 8:50:00 -10m Dampf vom Abtauen`) and can be
  copied.
- **Recent notes** lists the latest notes (click the time to go there, ✕ to delete); a click
  on a note's flag opens the form with that note highlighted.

Notes and entity changes live in the table `event` (layout of the eBUSd app) and `ha_state`
of the telegram database.

### Tables

| Table | Content |
|---|---|
| `event` (eBUSd app) | `ts`, `ts_min`, `ts_max` (ns since 1970-01-01 UTC), `message`, `logged` |
| `ha_state` (Workbench) | `ts`, `entity`, `state`, `previous`, `attributes` (JSON), `source` (`ha` change, `ha-initial` state when the subscription started) |

---

## Definitions

The page follows the way you work, in steps (tabs):

1. **Sources**: where definitions come from. The default definitions
   ([john30/ebusd-configuration](https://github.com/john30/ebusd-configuration), cloned in the
   background with a progress indicator), a repository of your own, community pull requests and
   other repositories (layers), definitions you write yourself, and **Compile**. The same panel
   is in the timeline (**Sources** button), and the timeline offers it as a notice when there are
   no definitions yet.
2. **Live decoding**: every distinct telegram of the recording as it is decoded, newest first.
3. **Choose**: all definitions that matched, to tick and rename.
4. **Edit**: the TypeSpec sources with their tree; saving recompiles and decodes the recording
   again.
5. **Summary & save**: what you chose with its sources and how each definition fared, and the
   files for ebusd.

*Evidence* (ebus-evidence profile checks and the raw log export) is a step of its own.

### Your own definitions

Definitions you write or paste (ebusd CSV lines, one per message) are decoded over the whole
recording at once and appear as candidates of kind *own definition* next to the compiled ones,
for rows with or without other candidates. They are never chosen automatically; pick one in the
timeline. Three ways to make one:

- **Define a message that no definition decodes**: click such a row in the timeline (it shows
  *＋ define*). The editor is prefilled from what the recording shows: the kind (active read or
  write when ebusd itself polls or sends, passive read or write for what other devices
  exchange, passive read for broadcasts; the CSV shorthand `r`, `w`, `u`, `uw` is shown last in
  every dropdown, after the plain name and its explanation), circuit (from the
  identification of the device), address, command and ID, and the data bytes. Click a byte to
  see what it could be, every number type (UCH, D1C, D2C, FLT, EXP, …) with its latest value and
  its range over the whole history, and apply one; the rest stays raw (HEX). Name the fields,
  add a divisor or unit; the history of the selected field is charted. ebusd's own decoder
  checks the line against every recorded variant while you work (how many it decodes, the
  latest decoded text, the errors). **Save as my version** decodes the recording with it and
  picks it for the row (the editor is the *＋ new definition* tab of the details).
- **Edit a definition**: the *Edit* column of the details shows its CSV line as a form and as
  text; change it and **Save as my version**.
- **Paste**: write or paste lines in the Sources step or the timeline's Sources popover.

The text is stored in the app's settings; the files of the setup contain these definitions with
the comment `# from layer custom`.

### Repository

1. **Load the default definitions** or **use another repository** (your fork of
   ebusd-configuration; set a token in the app configuration to push), or *Start empty*. The tree shows the
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
(a branch such as `upstream/master`, or the URL of another repository, optionally with a
branch: `https://github.com/<you>/ebusd-configuration.git#my-branch`) and the Workbench
fetches its head from the upstream
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

### Decoded recording

The browser keeps a copy of the recording in its own store (IndexedDB): every **distinct
telegram** (master and slave part) once, with how often and when it was seen, and the bars the
timeline fetched as pointers to those telegrams. It is filled from the database at start (a
three-week recording with 44 000 distinct telegrams takes a few seconds) and kept up to date
every few seconds, so the Workbench sees new telegrams as they arrive.

Every telegram is decoded with the compiled files in a Web Worker running ebusd's message
library, and **every definition that fits it** is stored next to it with the definition's
source (checkout or layer), file, condition and the decoded values: the one ebusd itself
would use (file chosen by the scan identification of the device, condition met, longest ID)
and the hidden candidates. New telegrams are decoded as they arrive; conditional definitions
(`[Ehp_heatpumptype=3]…` in the CSV, `@condition` in TypeSpec) are evaluated against the
telegrams decoded before, so an incremental run always starts with the identification telegrams
and the ones a condition refers to. A new compile decodes everything again; **decode again**
does the same by hand, **reset store** forgets the browser-side copy (the database is not
touched). Telegrams pasted into the text box (`QQZZPBSBNNDD/NNDD`, as in `ebusctl grab` or
the telegram log's `master`/`slave` columns) are decoded like recorded ones and counted as not
seen.

The **Decoded** tab lists the telegrams with the definition ebusd uses, its values and the
other candidates, coloured as in the timeline (filters: unknown to ebusd, with other
candidates, decode errors, in the timeline window). Everything decoded is also what the
timeline shows, so there is no separate test step: the picture updates by itself.

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
what you are sure about, and test reading first. Until you tick anything, the setup is what
ebusd itself uses. The **name in my config** column renames a message for the export (fields
are renamed in the timeline's details below the timeline or setup drawer, where their values are
visible). The selection, the choices made per timeline row and the names are stored in the
app's data folder, so every browser sees the same setup.

### Export

- **Definitions of this installation**: one CSV file per circuit with the included
  definitions, conditions removed, under the names of my config, with comments naming the
  source file and layer of each definition and the upstream name of renamed ones. Circuit
  names can be changed first (`vwz → vwzio` if your entities use that topic). **Deploy setup** writes them to the deploy folder (optionally a subfolder, removing
  other definition files there if ticked); ebusd then needs `--configpath` pointing there and
  loads them at startup without scan-based file selection (remove `--scanconfig`, or keep it
  with no `vaillant/` folder present). **Download** saves the files locally.
- **All compiled files**: the complete tree as ebusd's scan expects it.
- **Home Assistant climate and water heater**: `mqtt:` YAML for `configuration.yaml` with a
  `climate` per zone (`Z1RoomTemp`, `Z1DayTemp`, `Z1OpMode`, `RoomHumidity`; the action from
  `RunDataStatuscode` when present) and a `water_heater` (`HwcTempDesired`, `HwcOpMode`, the
  storage temperature from `HwcStorageTemp` or a message with the field `hwcstoragetemp`),
  built from the setup's messages and their field names; renamed messages and fields keep their
  role (the YAML knows that `Zone1RoomTemperature` is the room temperature) and appear under the
  new topics. ebusd's own `mqtt-hassio.cfg` creates a sensor, number or select per field; these
  composite entities it cannot. A note at the top
  lists what is missing (usually the write definitions). Next to it, the eBUSd app options for
  the setup: `--configpath` and `--mqttvar=filter-name=…` so that MQTT discovery publishes the
  setup's messages, including writable ones.
- **ebusd raw log for ebus-evidence**: the recorded telegrams of a time range as ebusd
  message-mode raw log (`--lograwdata`), the input of
  [ebus-evidence](https://github.com/MarcelT87/ebus-evidence). Telegrams sent by ebusd itself
  (its own address, `--address` of the eBUSd app, 31 unless changed; set it here once) are
  written with the direction changes ebusd logs. Run
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
exported raw log.

**Addresses** maps the addresses a profile names to the ones on your bus, `f1=31` by default:
the eBUS specification prescribes which address a kind of device takes (`03`/`08` the first
burner control unit, `10`/`15` the heating controller, `30`/`35`, `70`/`75`, `f0`/`f5` the
heating circuit controllers, `01`, `11`, `31`, `71`, `f1` remote controls and bus interfaces;
a slave address is its master address plus 5), so the same device sits at the same address in
every installation of its kind, but a second device of the same kind must take another one,
and the address of ebusd itself is whatever `--address` says — `31` in the eBUSd app, `f1` in
the profile author's installation. A check with `source: f1` therefore matches nothing until
it is mapped. Unassigned addresses may be used freely, so map device addresses only when your
installation differs.

The compiler and the decoder are loaded into the browser on first use (about 1.8 MB).

---

## Folders

| Container path | Host path | Content |
|---|---|---|
| `/share/ebusd/telegrams.db` | `/share/ebusd/telegrams.db` | telegram database (eBUSd app and Workbench) |
| `/share/ebusd/config` | `/share/ebusd/config` | deployed CSV files for the eBUSd app |
| `/config/repo` | `/addon_configs/…_ebusd_workbench/repo` | git repository with `refs/workbench/*` for the layers (in backups) |
| `/data/settings.json` | – | Workbench settings (entities, ID lengths, layers, setup with its names and choices, own address, …; in backups) |
| browser store `ebusd-workbench` | – | IndexedDB of the browser: the distinct telegrams of the recording, the timeline's bars as pointers to them, every decoding per definition, the last compile. Rebuilt from the database when the recording changes or with *reset store*. |

---

## Limitations of this first version

- The editor is a plain text area (no syntax highlighting or completion).
- Telegrams are grouped by address and ID bytes; the ID lengths of the decoded definitions can
  be applied with one click, but rows are not merged by message definition yet.
- Compiling happens on the main thread of the browser (the full ebusd-configuration with three
  layers takes about five seconds); decoding runs in a Web Worker. Browsers without IndexedDB
  (some private windows) keep the store in memory for the tab's lifetime.
- The setup is stored in the app, the decodings in the browser: another browser decodes the
  recording again (a few seconds) but sees the same setup.
- Only HTTPS remotes with a token are supported for push.
- No prebuilt image yet: Supervisor builds the app on the device at installation (a minute
  or two).
