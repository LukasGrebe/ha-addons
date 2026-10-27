# Home Assistant App: ebusd Config Workbench

The ebusd Config Workbench (the Workbench for short) finds the message definitions that fit
*your* eBUS devices. It reads the telegrams recorded by the
[eBUSd app](../ebusd/DOCS.md#sqlite-telegram-log), decodes them with every definition from every
source you add (ebusd's own definitions, the upcoming release, pull requests, your own), shows
for each message what fits and how well, lets you tune and name a definition, and saves the
result as the configuration of the eBUSd app and of Home Assistant. The device only serves the
database and fetches the sources; compiling and decoding run in your browser.

> This is an early version. Expect rough edges and please report what you find in
> [issues](https://github.com/LukasGrebe/ha-addons/issues).

---

## Setup

### 1. Record the bus with the eBUSd app

In the eBUSd app configuration set **SQLite telegram log (database file)** to
`/share/ebusd/telegrams.db` (and optionally the retention in days), then restart it. Every
telegram on the bus is now stored, also unknown and broken ones. Leave `--scanconfig` on: the
identification telegrams (`0704`) are what tells the Workbench which file ebusd loads for a
device.

### 2. Install and configure the Workbench

| Option | Meaning |
|---|---|
| **Telegram database** | The same path as `sqlite_db` of the eBUSd app, default `/share/ebusd/telegrams.db`. Both layouts of the telegram log are read (schema version 2 of eBUSd 26.1.11 and later, and version 1). The Workbench adds its own table `ha_state` for entity changes and shows the notes of the eBUSd terminal's `log` command (table `event`); it creates the file if the eBUSd app has not yet. |
| **Deploy folder for the CSV files of your setup** | Where the definitions of your setup are written, default `/share/ebusd/config`. |
| **Language of the definitions** | `en` or `de`: the language of the field names and comments, as the `en`/`de` folders of ebus.github.io. Use the same as the eBUSd app (`--configlang`, English unless set). |

Start the app and click **Open Web UI** (the Workbench is also in the sidebar). On the first
start it fetches ebusd's own definitions and the upcoming release from GitHub (about a megabyte)
and starts decoding the recording.

### 3. Use the definitions in the eBUSd app

Once you have deployed your setup, add to `commandline_options` of the eBUSd app:

```
--configpath=/share/ebusd/config
```

and restart it (also after every new deploy). The files of the setup are loaded as they are, for
every device; remove `--scanconfig` or keep it (there is no manufacturer folder in the deploy
folder, so the scan loads nothing else).

---

## The page

Everything is on one page; nothing opens in a tab, a popover or a dialog.

| Region | What it is |
|---|---|
| **Top bar** | What the app is doing right now (fetching, compiling, reading the recording, decoding), the database and the Home Assistant connection. |
| **Definitions from** | The sources: each one with how many of its definitions fit your bus, what it adds compared with ebusd's own definitions, a checkbox to leave it out, ↻ to fetch it again. **+ add** lists the open pull requests of ebusd-configuration, the ones that mention your devices first, and takes a pull request number, `owner/repo#branch` or a GitHub URL. |
| **Messages on the bus** | The devices on the bus, each with what ebusd loads for it and how much of its traffic it understands, and the messages as a list that leads with what needs a look. The same messages as a **timeline** on request. Click a message for the scratchpad. |
| **Scratchpad** | Below the bus: for the selected message every definition that fits it, as cards that fold open in place; your own definitions; a definition read off the bytes. |
| **My setup** | On the right: ebusd's own choice plus your changes, everything else that fits the bus, how it shows up in Home Assistant, and saving for the eBUSd app. |
| **Advanced** | One folded line at the bottom: research with ebus-evidence, the browser store, pasted telegrams, about this app. |

The handle between the bus and the scratchpad gives either more room; the height is remembered.

### How to go about it

1. Look at the **devices**: is every device identified, does ebusd load a file for it (a device with
   *no file* is one ebusd understands nothing of), how much of its traffic is understood?
2. Work through **needs a look**: the messages ebusd does not understand today, the ones with the
   most traffic first. A message *other sources know* is one click away from your setup; a message
   *unknown everywhere* can be read off its bytes in the scratchpad.
3. For a message, compare the **cards** in the scratchpad: do the values look right over the whole
   recording (a temperature of 21.5 °C is plausible, 6553.5 °C is not), does the definition decode
   every recorded variant, which of several namings do you prefer? Pick one, rename if you like.
4. **Save** the setup for the eBUSd app and copy the Home Assistant YAML.

---

## Sources

A source is a complete set of definition files, exactly what ebusd would load with
`--configpath` pointing at it. Every source decodes the recording on its own, so a definition is
attributed to its source exactly, the same message from two sources shows up as two candidates
(grouped when they decode the same values), and "ebusd's choice" means what ebusd does today
with its own definitions.

| Source | What it is |
|---|---|
| **ebusd's definitions** (`release`) | The CSV files at [ebus.github.io](https://ebus.github.io), what the eBUSd app loads by default. Ready to use, no compile. |
| **upcoming release** (`next`) | The `next/` folder of the same site: the definitions of the next ebusd release, compiled from the current master of ebusd-configuration. |
| **PR 660** (`pr/660`) | The head of a pull request of [ebusd-configuration](https://github.com/john30/ebusd-configuration/pulls): TypeSpec sources, compiled to CSV in your browser with the official [eBUS TypeSpec library](https://github.com/john30/ebus-typespec), once per commit. Definitions for a heating system often sit in open pull requests for a long time (for a Vaillant aroTHERM with HMU HW5103, for example). |
| **owner/repo#branch** | A branch of another GitHub repository: TypeSpec sources (`src/`) compiled like a pull request, or CSV files used as they are. |
| **my definitions** | The scratchpad: ebusd CSV lines of your own (see below). |

The device fetches a source as one snapshot (a tarball) from GitHub over HTTPS: no git, no
token, no clone with history. A pull request's title and commit come from the GitHub API, which
allows 60 requests per hour without a token; the list of open pull requests is cached for an
hour. Only public repositories work. Symbolic links in the repositories (ebusd-configuration
shares definitions between devices that way) are followed.

A source says what it adds compared with ebusd's definitions: `+17 new, 12 changed` means
17 definitions that the release does not have at all and 12 that differ (by file, circuit, name
and direction). Hover for the commit and when it was fetched. Untick a source to leave it out
(its decodings are kept, so ticking it again is instant); ↻ fetches it again when the pull
request was updated; ✕ removes it.

---

## Messages on the bus

### Devices

One chip per destination address on the bus: its identification (manufacturer, model, hardware
version), the file ebusd loads for it (or **no file**, red: ebusd understands nothing of this
device until a source brings a file for its identification), how many messages it has and how much
of its traffic is understood, how many messages only other sources understand (`+10 with other
sources`) and how many are unknown everywhere. Click a device to see only its messages. The
addresses that only ask (the controller, remote controls, ebusd itself) are listed after the
devices. A device without identification means the scan telegram (`0704`) is not in the recording:
check that `--scanconfig` is on in the eBUSd app.

### The list

One row per message, the way a definition sees it: destination, command and message ID, whoever
asked. Rows are built from the browser store, so filtering is instant.

| Column | Meaning |
|---|---|
| message | the name of the definition it is shown with (the one you picked, else ebusd's choice, else one in your setup, else what another source would use) with its kind; without one, the address, command and ID in hex and **＋ define** |
| understood by | `ebusd` when ebusd's own definitions decode it today; the other sources that would; *fits, but ebusd would not use it* when definitions match but are hidden (another device variant, an unmet condition); *nothing* when no definition anywhere fits |
| latest value | decoded with the row's definition (hovering a card in the scratchpad shows that card's decoding instead), else the hex |
| telegrams, values, last seen | how much traffic, how many distinct telegrams (values), when the last one was recorded |
| fits | how many definitions from every source fit the message: click to compare |
| setup | whether the row's definition is in your setup |

**needs a look** (the default) lists what ebusd does not understand, most traffic first, with the
messages other sources understand (blue) before the unknown ones (orange); **unknown everywhere**
and **other sources know them** are the two halves of it; **all messages** lists everything by
device, and folds commands with many messages (the registers of `b524`) into one line; **in my
setup** what you chose. The filter box matches names, circuits, addresses and commands.

### The timeline

**timeline** in the head of the bus shows the same telegrams over time: one row per source →
destination, command and message ID (the ID is the first data bytes after the command: 1 byte by
default, 3 for `b509`, 6 for `b524`), a bar for every stretch where the value stayed the same,
labelled with the decoded value, the number of repetitions and the typical interval, a tick for
a single telegram, broken telegrams in red. It is the view for correlating: Home Assistant entity
changes and your notes are flags in the events lane above the rows.

- Controls like the browser's developer tools: the wheel **scrolls the rows**; **Ctrl/⌘ + wheel**
  or a trackpad pinch zooms the time axis around the pointer; **Shift + wheel** or a sideways
  swipe moves in time; dragging the chart moves, a double click zooms in. `+`/`-`/`←`/`→` work
  as well, `N` returns to **live** mode in which the right edge follows the current time, Esc
  clears the selection. The strip at the top shows the whole recording (red: telegrams with
  errors): drag the edges of the blue window to resize it, drag inside to move it, drag outside
  to select a new one.
- A window with more than 200 000 telegrams is **summed up in steps of time** (about one per
  pixel); a lavender bar says how many different values a row had within steps. Zoom in for
  every value.
- **Pivot**: the **+** and **−** buttons next to a row split it at its next message ID byte or
  combine it with the rows that share all but its last byte; a row that is one whole message of
  a definition with several fields shows the **values as rows of their own** with **+** instead.
  Commands with many messages get a header row with **⊟ one row**. A notice offers to **group
  like the definitions** once the recording is decoded; the scratchpad sets the ID length per
  command.
- **⚙ events and grouping** in the timeline's toolbar: the Home Assistant entities whose state
  changes are shown (the circulation pump, a thermostat, a window sensor, …; the Workbench
  subscribes to them through the Home Assistant API and stores every change in the table
  `ha_state` of the telegram database), and the ID lengths per command.
- **＋ event** notes what you did or saw ("set hot water to 50 °C", with the time and how exact
  it is), like the `log` command of the eBUSd app's terminal: orange flags with the uncertainty as
  a band across the rows; the terminal command is shown and can be copied.

| Table | Content |
|---|---|
| `event` (eBUSd app) | `ts`, `ts_min`, `ts_max` (ns since 1970-01-01 UTC), `message`, `logged` |
| `ha_state` (Workbench) | `ts`, `entity`, `state`, `previous`, `attributes` (JSON), `source` (`ha` change, `ha-initial` state when the subscription started) |

---

## Scratchpad

Click a message in the list (or a row of the timeline): the scratchpad shows everything about
it. The head says the message, how many recorded variants and telegrams it has and who asked for
it (in the timeline view also the **ID bytes** of its command and **rows like the definitions**).

Then one **card per definition that fits** the message, compared **over every recorded telegram
of the message, not only the visible window**. Definitions that decode the same values (a copy
in another file, circuit or source) are one card (`×4`). Each card says in one line: ● when it is
used for this row, the message, its kind (active read, passive write, …), its sources, `ebusd's
choice` for what ebusd uses today, ✓ when it decodes every recorded variant or ⚠ with the
count when it fails on some, how it relates to the row's definition (*same values*, *same values,
defined differently*, *differs in temp, flow*) and the latest decoded value. Hovering a card
previews its decoding in the bus row. **copy** puts the definition into your scratchpad (see
below). Click the line and the card folds open with four columns:

- **Source and use**: *use for this row* (it joins your setup, the row's other definitions
  leave it), *in my setup*, the kind in words, every copy with its source, file and status, when
  it applies (conditions in words), why ebusd does not use it, and **In Home Assistant**: the
  message name and every field with the name it gets in your config and the entity ebusd's
  MQTT discovery makes of it, next to the latest value. Rename here (`Z1RoomTemp → Zone1RoomTemperature`,
  `temp → temperature`): the bus, the exported CSV files and the Home Assistant entities use the
  new names, the upstream names stay in the file's comments. Names are limited to
  `A–Z a–z 0–9 _ . -` (they become MQTT topics and JSON keys).
- **Compared with another definition**: this card beside the row's definition (or any other
  card): a verdict (identical, same values but defined differently, different values and in
  which fields), then source, kind, message ID, every field with its type, divisor and unit, the
  latest values, how many variants decode and the files. Differences are highlighted; rows that
  differ only in a name are in italics. Two definitions with the same values and different names
  or comments: pick the one you prefer, or rename.
- **History over the recording**: a chart of the definition's values by the timestamp of every
  telegram (hover for a value, click to move the bus there; the blue band is the window) and the
  values as a list of runs of the same value, newest first, the clicked run highlighted.
- **Tune it**: the definition as a form (kind, circuit, name, comment, every field with where it
  is, its type in plain words, divisor or value names, unit) and as raw CSV, both ways. While you
  type, ebusd's own decoder reads the draft against every recorded variant (how many decode, the
  latest text, the errors), and the chart and list show the **draft**. **Save as my version**
  never changes the source: it adds your own version to your scratchpad, decodes the whole
  recording with it and picks it for the row.

Statuses of a definition:

| Status | Meaning |
|---|---|
| active | ebusd's choice with this source for this installation (file chosen by the scan, condition met) |
| variant | from a file of another device variant; ebusd would not load it, but it decodes the recorded telegrams |
| conditional | its condition was not met by the recorded telegrams, but it decodes them |
| hidden | in the file ebusd loads, but another definition takes precedence |
| error | matches the telegram but does not decode it (wrong length or values) |
| companion | not seen on the bus: the counterpart of a seen definition, usually the write definition |
| custom | your own definition, never chosen automatically |

**hide failing** hides cards that fail to decode some recorded telegram; they stay reachable in
the *N failing* card at the end, each with the reason. In the timeline view **many cards on one
row** usually means the row groups telegrams by fewer ID bytes than the definitions use (for
`b51a` the register is 3 bytes, the default row key 1): the "candidates" are then different
messages (registers). A notice says so and **Split this row like the definitions** fixes the
grouping; the list groups messages like the definitions by itself.

### Your own definitions

Your definitions are ebusd CSV lines, one per message, stored in the app's settings (every
browser sees them). They are a source like the others: decoded over the whole recording as soon
as they change, shown as cards of kind *mine* wherever they fit, never ebusd's choice. Three
ways to make one:

- **copy** on a card (or *Save as my version* in its editor): a copy to change fields, types,
  divisors, units, names.
- **＋ write a definition from the bytes**, the last card of every message (it opens by itself
  for a message no definition decodes): prefilled from the recording with the kind (active read
  or write when ebusd itself polls or sends, passive read or write for what other devices
  exchange, passive read for broadcasts), circuit (from the identification of the device),
  address, command and ID, and the data bytes. Click a byte to see what it could be, every
  number type (UCH, D1C, D2C, FLT, EXP, …) with its latest value and its range over the whole
  history, and apply one; the rest stays raw (HEX). Name the fields, add a divisor or unit; the
  history of the selected field is charted and ebusd's decoder checks the line against every
  recorded variant while you work.
- **Paste** lines (from a forum post, an issue, a file) into the scratchpad when nothing is
  selected.

Without a selection the scratchpad lists your lines with how each fares over the recording; each
folds open into its editor.

---

## My setup

What this installation uses: **ebusd's own choice** (every definition of ebusd's own definitions
that decodes a message of your bus the way ebusd does today, folded away by circuit) **plus your
changes**, listed one by one with a way back: definitions you added from other sources or from
the hidden ones (+), definitions you took out (−), messages and fields you renamed (✎), circuits
you renamed. Picking a card in the scratchpad adds it (and takes the row's other definitions out);
**reset** goes back to ebusd's own choice. Circuit names can be changed (`vwz → vwzio` if your
entities use that topic). ebusd's choice follows the recording: a message seen for the first time
tomorrow is understood tomorrow, your changes stay.

**Also fits your bus** lists every other definition that decoded a recorded telegram, from every
source: hidden ones, other device variants, unmet conditions, other sources, counterparts for
writing, each with its status and an example value so you can judge whether it fits (a
temperature of 21.5 °C is plausible, 6553.5 °C is not). One click adds one; **ebusd's choice
only** is the safe baseline, **+ plausible** adds every hidden definition that decoded all its
telegrams without error, **+ counterparts** adds the write definitions belonging to included
ones. Write definitions are marked: writing to a device with a definition of another variant can
be harmful, so include only what you are sure about, and test reading first.

**In Home Assistant** shows the entities ebusd's MQTT discovery (`mqtt-hassio.cfg` of the eBUSd
app) will make of the setup, named after circuit, message and field as renamed here, and the
`climate` / `water_heater` YAML for `configuration.yaml`: a climate per zone (`Z1RoomTemp`,
`Z1DayTemp`, `Z1OpMode`, `RoomHumidity`; the action from `RunDataStatuscode` when present) and a
water heater (`HwcTempDesired`, `HwcOpMode`, the storage temperature from `HwcStorageTemp` or a
message with the field `hwcstoragetemp`). Renamed messages and fields keep their role and appear
under the new topics. A note at the top lists what is missing (usually the write definitions).

**Save for the eBUSd app**: one CSV file per circuit with the included definitions, conditions
removed, under the names of your config, with comments naming the source and file of each
definition and the upstream name of renamed ones, plus `workbench-setup.json` (the sources with
their commits, the devices, your own lines, how each definition fared on your recording).
**Deploy to eBUSd** writes them to the deploy folder (optionally a subfolder, removing other
definition files there if ticked); **Download** saves them; **copy eBUSd options** gives
`--configpath` and the `--mqttvar=filter-name=…` so that MQTT discovery publishes exactly the
setup's messages, writable ones included. Then restart the eBUSd app.

---

## Research with ebus-evidence

Paste an [ebus-evidence](https://github.com/MarcelT87/ebus-evidence) profile (YAML) or load the
bundled example (`hw5103-open-evidence`, MIT License, MarcelT87) and **Run checks on the bus
window**: for every check the matching telegrams of the window are counted, the first and last
occurrence shown and the value the check describes decoded. **Download summary** saves it as
JSON for discussion. **Addresses** maps the addresses a profile names to the ones on your bus,
`f1=31` by default (ebusd's own address is whatever `--address` says: `31` in the eBUSd app,
`f1` in the profile author's installation).

**ebusd raw log**: the recorded telegrams of a time range as ebusd message-mode raw log
(`--lograwdata`), the input of ebus-evidence. Run `ebus-evidence doctor --raw FILE --profile
hw5103-open-evidence`, `import --raw FILE` and `export` on another computer to get a verified
`evidence.zip`.

---

## Folders

| Container path | Host path | Content |
|---|---|---|
| `/share/ebusd/telegrams.db` | `/share/ebusd/telegrams.db` | telegram database (eBUSd app and Workbench) |
| `/share/ebusd/config` | `/share/ebusd/config` | the CSV files of your setup for the eBUSd app |
| `/data/settings.json` | – | Workbench settings (entities, ID lengths, sources, setup with its names and choices, your own definitions, own address, …; in backups) |
| `/data/sources/` | – | the fetched sources, one folder each (`files.json`, `meta.json`), and the cached list of open pull requests; fetched again on demand |
| browser store `ebusd-workbench` | – | IndexedDB of the browser: the distinct telegrams of the recording, every decoding per source and definition, the compiled pull requests. Rebuilt from the database and the sources when they change or with *reset store*. |

The compiler and the decoder are loaded into the browser on first use (about 1.8 MB).

---

## Limitations of this version

- Only public GitHub repositories and pull requests of john30/ebusd-configuration are sources
  (no token, no other hosts). Other definitions come in by pasting their lines.
- Pull requests are compiled in the browser (the full ebusd-configuration takes a few seconds)
  and every source decodes the whole recording (a week with 47 000 distinct telegrams takes about
  two minutes per source, once); ten sources are fine, dozens are not. Leave sources you are done
  with unticked.
- The decodings live in the browser: another browser decodes the recording again (a few seconds
  per source) but sees the same setup and the same definitions of your own.
- There is no editor for TypeSpec sources any more: a definition of your own is an ebusd CSV
  line. To contribute it upstream, open a pull request of ebusd-configuration with the TypeSpec
  equivalent (the [ebus notebook](https://marketplace.visualstudio.com/items?itemName=ebusd.ebus-notebook)
  helps).
- No prebuilt image yet: Supervisor builds the app on the device at installation (a minute
  or two).
