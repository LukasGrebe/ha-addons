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
| **Definitions from** | The sources: ebusd's definitions, the upcoming release, every open pull request of ebusd-configuration (one chip, the list when unfolded) and your own lines, each with how many of its definitions fit your bus; a checkbox leaves one out, ↻ fetches it again. **+ add** keeps a pull request after it is merged or closed, or adds `owner/repo#branch`. |
| **Messages on the bus** | The devices on the bus, each with what ebusd loads for it and how much of its traffic it understands, and the messages as a list that leads with what needs a look. Click a message: its inspector opens right under it. |
| **The inspector** | Under the selected message: its telegram byte by byte with every definition that fits it as a row, from every source at once (the fields over the bytes they read, what each decodes, a sparkline per field), all of it editable; the chart of a field; the definitions that fail. |
| **My setup** | On the right: ebusd's own choice plus your changes, everything else that fits the bus, your own definition lines, how it shows up in Home Assistant, and saving for the eBUSd app. It folds to a rail while a message is inspected, so that the inspector has the width. |
| **Advanced** | One folded line at the bottom: the browser store, settings, about this app. |

### How to go about it

1. Look at the **devices**: is every device identified, does ebusd load a file for it (a device with
   *no file* is one ebusd understands nothing of), how much of its traffic is understood?
2. Work through **needs a look**: the messages ebusd does not understand today, the ones with the
   most traffic first. A message *other sources know* is one click away from your setup; a message
   *unknown everywhere* gets a definition of your own in the inspector, started from its bytes.
3. For a message, compare the **rows of the inspector**: do the values look right over the whole
   recording (a temperature of 21.5 °C is plausible, 6553.5 °C is not), does the definition decode
   every recorded variant, which of several namings do you prefer? Tick one, rename if you like.
4. **Save** the setup for the eBUSd app and copy the Home Assistant YAML.

---

## Sources

A definition is a line of CSV; a source is where lines come from. Every source is parsed into
one **pool** of distinct lines (by content, with the destination, circuit and field parts made
explicit, as ebusd fills them in), each with the sources and files it appears in. A line is a
candidate for the messages it fits by destination, command, message ID and lengths; the same
line in several files or sources is one candidate with several badges. ebusd's library (as
WebAssembly in this browser) judges the candidates: once over the whole recording with ebusd's
own definitions, exactly as the eBUSd app would ("ebusd's choice"), and otherwise per message
on demand, a small tree of that message's candidate lines over its telegrams. Results are kept
per telegram and line, so nothing is decoded twice.

| Source | What it is |
|---|---|
| **ebusd's definitions** (`release`) | The CSV files at [ebus.github.io](https://ebus.github.io), what the eBUSd app loads by default. Ready to use, no compile. |
| **upcoming release** (`next`) | The `next/` folder of the same site: the definitions of the next ebusd release, compiled from the current master of ebusd-configuration. |
| **open pull requests** | Every open pull request of [ebusd-configuration](https://github.com/john30/ebusd-configuration/pulls), fetched by the device and compiled to CSV in your browser with the official [eBUS TypeSpec library](https://github.com/john30/ebus-typespec), once per commit. Definitions for a heating system often sit in open pull requests for a long time (for a Vaillant aroTHERM with HMU HW5103, for example); their lines are candidates with a PR badge wherever they fit. Unfold the chip for the list; untick one to leave it out. |
| **PR 660** (`pr/660`) | A pull request kept as a source of its own (**+ add** with its number): its definitions stay after it is merged or closed. |
| **owner/repo#branch** | A branch of another GitHub repository: TypeSpec sources (`src/`) compiled like a pull request, or CSV files used as they are. |
| **my definitions** | ebusd CSV lines of your own (see below). |

The device fetches a source as one snapshot (a tarball) from GitHub over HTTPS: no git, no
token, no clone with history. A pull request's title and commit come from the GitHub API, which
allows 60 requests per hour without a token; the list of open pull requests is cached for an
hour. Only public repositories work. Symbolic links in the repositories (ebusd-configuration
shares definitions between devices that way) are followed.

A pull request whose base is older than today's TypeSpec library (its whole tree no longer
compiles) is compiled **partially**: only the files it changes (GitHub's list, fetched once) and
what they import. Such a source carries a *partial* badge; its definitions are real, but "ebusd's
choice" and its counts cover those files only.

Both strips fold (▾ / ▸, remembered per browser): the sources into one line with the names, how
many are off and one combined bar for fetching, compiling, ebusd's run over the recording and the
messages being checked; the devices into one line of address and model.

A source says how many of its lines fit your bus. Hover for the commit and when it was fetched.
Untick a source to leave it out (what it decoded is kept, so ticking it again is instant);
↻ fetches it again when the pull request was updated; ✕ removes one you added.

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
| ▾ | the message whose inspector is open; a second click (or Esc) closes it |
| understood by | `ebusd` when ebusd's own definitions decode it today; the other sources whose definition would be used and decodes it (a dashed badge: it fits, not checked with ebusd's library yet); *fits, but ebusd would not use it* when definitions match but are hidden (another device variant, an unmet condition); *nothing* when no definition anywhere fits |
| latest value | decoded with the row's definition, else the hex |
| telegrams, values, last seen | how much traffic, how many distinct telegrams (values), when the last one was recorded |
| fits | how many definitions from every source fit the message: the rows of the inspector (in italics while some are not checked yet) |
| setup | whether the row's definition is in your setup |

**needs a look** (the default) lists what ebusd does not understand, most traffic first, with the
messages other sources understand (blue) before the unknown ones (orange); **unknown everywhere**
and **other sources know them** are the two halves of it; **all messages** lists everything by
device, and folds commands with many messages (the registers of `b524`) into one line; **in my
setup** what you chose. The filter box matches names, circuits, addresses and commands.
**what matters** / **last received** orders the list by traffic (and device) or by the newest
telegram first.

The list never changes by itself: the recording is read into the browser on the first visit, and
afterwards **↻ load N newer telegrams** in the toolbar reads what was recorded since (the count
is kept current). While a message's inspector is open the list **stays put** too. What the list
shows is checked with ebusd's library in the background, in the list's order, so "fits" firms up
as you watch.

### Events

The timeline view of earlier versions is set aside for now; what it recorded stays and may come
back. Home Assistant entity changes are stored next to the telegrams (the entities are chosen
under *Advanced → Settings*; the Workbench subscribes to them through the Home Assistant API),
and the `log` command of the eBUSd app's terminal notes what you did or saw ("set hot water to
50 °C", with the time and how exact it is).

| Table | Content |
|---|---|
| `event` (eBUSd app) | `ts`, `ts_min`, `ts_max` (ns since 1970-01-01 UTC), `message`, `logged` |
| `ha_state` (Workbench) | `ts`, `entity`, `state`, `previous`, `attributes` (JSON), `source` (`ha` change, `ha-initial` state when the subscription started) |

---

## The inspector

Click a message in the list: its inspector opens in a row right under it (click the message
again or press Esc to close it; *My setup* folds to a rail meanwhile and comes back when you
click the rail). The head says the message, how many recorded variants and telegrams it has and
who asked for it.

Then the table: the telegram laid out byte by byte (request data after the ID, then the answer;
a byte some definition reads as bits is eight bit columns) and one block per definition that fits
the message:

- its **fields** over the bytes they read, each with its name, type, divisor and unit; the row
  label has the **in setup** checkbox (ticked, the definition is used for this message: it joins
  your setup and the message's other definitions leave it), the message **name** box, its source,
  kind and how many recorded variants it decodes, and **copy** (a copy of your own);
- what it **decodes** from the telegram shown;
- a **sparkline** per field over the whole recording.

Every box is editable, there are no modes:

| You change | What happens |
|---|---|
| the name of a message or field of a source's definition | the name in your config (MQTT topic, entity name); the definition itself stays as upstream has it, the upstream name is in the tooltip |
| the type, divisor or unit of a source's definition | a **copy of your own** with that change appears as a row of kind *mine* and is picked for the message |
| anything on a row of kind *mine* | your line is saved and decoded over the recording at once; its whole line is also there as text (*as ebusd reads it*) |

Types are written as in the CSV (`UCH`, `D2C`, `BI0:1`, `BCD:2`, …); a divisor is a number
(`10`), a factor negative (`-10`), value names `0=off;1=on`.

The **telegram** row shows one recorded telegram (newest first) with **◀ older** and **newer ▶**
to step through the recording. Its source and destination are named: the device the scan
identified (a master is named after its slave side: `10` is the master side of the controller at
`15`), *ebusd* for its own address, else the role the eBUS specification assigns to the address
(heating controller, burner control unit, …; the tooltip has the details). The tooltip of the
command bytes says what the specification or, for Vaillant, ebusd's definitions make of them
(`07 04` identification, `b5 09` register access, `b5 16` broadcasts and energy statistics, …).
The tooltip of a byte lists what it could be, read as every number type of ebusd from that byte
on (`UCH` 23, `D2C` 2.3, `SIN` …), which is how an unknown message is read.

The **message ID** is as many data bytes as the fitting definitions use to tell a message from
its siblings: one byte by default, three for the Vaillant registers of `b5 09`, eight for an
energy statistic of `b5 16` (`1000ffff03030000`: the energy source and usage are in the ID,
so *electricity for heating* and *environment for hot water* are two messages, two rows). The
head of the inspector says so for IDs longer than a byte.

**ebusd's scan** is marked as such: the identification `07 04` ebusd asks every device for, and
for Vaillant the serial number in four parts (`b5 09 24` to `27`, sent by ebusd itself right
after the identification, defined in `vaillant/scan.csv`). Nothing to define there. **＋ a definition of your own** (the last row) starts one for the message: prefilled with
the kind (active read or write when ebusd itself polls or sends, passive for what other devices
exchange), the circuit (from the identification of the device), address, command and ID, and
one raw field per part; carve it into fields by giving them types, names, divisors and units.

Cells where a definition reads the same bytes differently from the message's definition are
highlighted, so two definitions of one message are compared by eye. Click any field, value or
sparkline for the **chart** of that field over the whole recording: it opens as a box over the
lower part of the inspector; hovering it shows that telegram in the table above (the bytes and
what every definition decodes follow the pointer), a click keeps that telegram in the table, Esc
or ✕ closes the box.

The inspector only redraws when something about it changed (another definition fits, your pick
changed, a line of your own changed), never while you type; what you selected and where you
scrolled stays. Stepping through the telegrams repaints only the telegram row and the values.
Nothing waits for ebusd's library: a line of your own shows as a row the moment it is saved,
marked *checking* until it has been decoded (the progress is in the sources strip and the top
bar); a shorter type on a raw field (`HEX:9` → `HEX:5`) leaves the rest as a raw field of its own,
a longer type takes its bytes from the raw fields that follow. A line whose fields need more
bytes than the telegram carries stays on its row, marked so; a line shorter than the telegram
decodes (ebusd reads what the fields need, the bytes after them stay unexplained).

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

**hide failing** leaves out definitions that fail to decode some recorded telegram; they stay
reachable in the *N definitions that fail* card below the table, each with the reason, with *in
setup* and *copy* as well.

### The open pull requests

Every open pull request of ebusd-configuration is in: the device fetches each one once (a tarball,
cached), the browser compiles it once per commit (cached) and its lines join the pool. A message
no source of ebusd's understands shows the pull requests whose lines fit it as candidates, with
the definition's name, whether ebusd would use it with that pull request (or it is hidden in a
file for another variant) and what it decodes, checked with ebusd's library when the message is
opened. This is how a message ebusd's own definitions do not know, or one that another pull
request may name better (an outside temperature called `temp_2`), is found without reading the
pull requests by hand. A pull request whose base is older than today's TypeSpec library is
compiled partially (only the files it changes); one that does not compile at all is marked so in
the list of pull requests.

### Your own definitions

Your definitions are ebusd CSV lines, one per message, stored in the app's settings (every
browser sees them). They are a source of the pool like the others: checked on the messages they
fit the moment they are saved (this message first), shown as rows of kind *mine* wherever they
fit, never ebusd's choice. Every line goes to ebusd's library as a file of its own, so a line it
rejects (a typo like `UNI:2`) only loses itself, and the reason shows on its row. They come from
the inspector (**copy** on a row, a changed type, divisor or unit, **＋ a definition of your
own**) or from **My definitions** in the setup column, where lines from a forum post, an issue or
a file are pasted; that list says how each line fares over the recording and removes one with ✕.

---

## My setup

What this installation uses: **ebusd's own choice** (every definition of ebusd's own definitions
that decodes a message of your bus the way ebusd does today, folded away by circuit) **plus your
changes**, listed one by one with a way back: definitions you added from other sources or from
the hidden ones (+), definitions you took out (−), messages and fields you renamed (✎), circuits
you renamed. Ticking *in setup* on a row of the inspector adds it (and takes the message's other definitions out);
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
- Pull requests are compiled in the browser (the full ebusd-configuration takes a few seconds
  each, once per commit; the first visit with 40-odd open pull requests takes a few minutes).
  ebusd's own definitions decode the whole recording once (a week with 47 000 distinct telegrams
  takes about two minutes); every other candidate is checked per message when it is shown.
- A condition that refers to another message (not the device identification) is evaluated with
  the message's own telegrams only: such a line may show as *conditional* although ebusd would
  use it, or the other way round. Tick it for your setup if its values look right.
- The decodings live in the browser: another browser reads and decodes the recording again but
  sees the same setup and the same definitions of your own.
- There is no editor for TypeSpec sources any more: a definition of your own is an ebusd CSV
  line. To contribute it upstream, open a pull request of ebusd-configuration with the TypeSpec
  equivalent (the [ebus notebook](https://marketplace.visualstudio.com/items?itemName=ebusd.ebus-notebook)
  helps).
- No prebuilt image yet: Supervisor builds the app on the device at installation (a minute
  or two).
