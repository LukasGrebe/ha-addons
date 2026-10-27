# 0.4.2 (unreleased)

## Features
* A command with many messages (the registers of b524, the parameters of b516) gets a header row
  with **⊟ one row**: all its telegrams become one row per source and destination; **⊞ expand**
  brings one row per message ID back

## Fixes
* Long lists of rows work: only the rows in view are drawn and in the DOM (virtual rows), so
  thousands of rows scroll and zoom like a few, and the canvas no longer stays empty beyond the
  height browsers can draw; runs that share a pixel column are drawn once and only the runs in
  the window are looked at

# 0.4.1

## Features
* **+** on a message with a definition of several fields shows one row per field (hcmode,
  flowtempdesired, …) with its value over time; **−** folds them away; a click opens the details
  with that field charted
* The tabs of the details tell how each definition relates to the row's: same values, same
  values but defined differently, or different (and in which fields); the comparison is a table
  against any other tab with the differences highlighted, and identical copies are listed

## Fixes
* The details no longer reset when telegrams arrive: a tab is followed by its definitions (its
  name changed with every new value), scroll positions and the history stay, and nothing is
  redrawn while you type in the editor

# 0.4.0

Everything about a message in one place: the details below the timeline.

## Features
* Click a value in the timeline and the **details** open in the area below it instead of a
  popover: it stays put while you move the window, can be resized by dragging its handle (the
  height is remembered), and the clicked value stays outlined in the row
* The details are one view with the definitions that decode the row as tabs (plus ＋ new
  definition and the failing ones); for the selected one: its **source** (use for this row, in
  setup, rename, TypeSpec source, kind, conditions, files), a **comparison** with the row's
  definition, its **history** as a chart and a list of values (the clicked one highlighted) and an
  **editor** (form and CSV) whose live preview by ebusd's decoder also drives the chart and list
* **Save as my version** makes your own version of any definition (the source is never
  modified), decodes the recording with it and picks it for the row; editing your own definition
  updates it
* The definitions tab keeps Sources, the overview of decodings, Choose, the TypeSpec files and
  Summary & save; per message work happens in the timeline

# 0.3.2

The timeline becomes the place where definitions are compared, chosen and named.

## Fixes
* Dropdowns and labels use plain words first, then the explanation, then the CSV shorthand: kinds
  (active read · ebusd polls this value from the device · r), field types (unsigned byte ·
  whole number 0 to 255 · UCH), the byte interpretations, conditions ("only when …"), and the
  kind badges (active read/write, passive read/write) everywhere
* The timeline no longer shifts while telegrams are decoded: notices float above it, the
  progress bar and toolbar keep their size, and the grouping notice appears only after decoding
  finished and can be dismissed

## Features
* Definitions page as steps: Sources, Live decoding (newest first), Choose, Edit, Summary &
  save. Start in the timeline: a notice offers the default definitions (cloned in the
  background with progress), your own repository or your own definitions; the Sources popover
  stays available, with pull requests and other repositories (by URL and branch) as layers
* Own definitions: a CSV text decoded over the whole recording at once, shown as candidates
  of kind "own definition"; a row without a definition opens an editor prefilled from the
  recording (kind, circuit, address, command, ID, data bytes), with every number type for a byte
  and its range over the history, a chart of the field, and ebusd's decoder checking the line
  against every recorded variant; candidates have a raw view to copy and change
* Candidate cards say what kind a definition is (read, write, passive read, passive write), tell
  groups with the same values apart by how they differ as definitions, chart the history by
  timestamp, link to the TypeSpec source at its line, and can hide candidates that fail
* Pivot rows: + and − next to a row split or combine at a message ID byte (prefix rules);
  "rows like the definitions" sets them from the decoded definitions
* Events: ＋ event does what the terminal's log command does (message, when, how exact, the
  command line, recent notes); Home Assistant entity changes are flags in an events lane
* Summary with sources of every chosen definition; deploy writes workbench-setup.json
  (repository and commit, pull requests, own definitions, devices, coverage) next to the CSV files
* The app is called ebusd Config Workbench
* Browser store (IndexedDB): the distinct telegrams of the recording are kept once with their
  counts and times, the timeline's bars as pointers to them, and every decoding of a telegram
  with every fitting definition next to it, with the definition's source (checkout or
  community layer), file and condition; kept up to date every few seconds, decoded in a Web
  Worker, incremental (identification and condition telegrams first); survives reloads
* Definitions compile automatically at start; the timeline names its rows after the decoding
  definition and shows the decoded values in the bars
* Candidate picker in the timeline: every definition that decodes a row, with status, source
  and its reading; hovering previews the decoding in the bars, picking puts the definition into
  the setup of this installation
* Names of my config: messages, fields and circuits can be renamed (verbose or industry terms
  instead of the upstream names); the exported CSV files, MQTT topics and Home Assistant YAML
  use the new names, the upstream names stay in comments and keep the entities' roles
* Setup drawer in the timeline with the included definitions and the exports (deploy, download,
  Home Assistant YAML, eBUSd app options); the setup is ebusd's own choice until changed
* Evidence checks: address mapping between the profile author's installation and this bus
  (`f1=31`), ebusd's own address as a setting used by the raw log export too
* `ebusd-check` reports the messages a condition refers to
* Candidate picker compares over the whole recording: identical definitions that decode the same
  values are shown as one card, with agreement and writable counts, coverage (all recorded
  variants decoded?), all decoded values, and the reason each candidate is not ebusd's choice;
  rename form with a field table; lumped rows (fewer ID bytes than the definitions use) are
  explained and can be split with one click
* Timeline controls like the browser developer tools (wheel scrolls, Ctrl/⌘ + wheel or pinch zooms,
  Shift + wheel moves; resizable window in the overview strip), status indicator with progress
  (loading, reading the recording, decoding x of y, compiling, cloning), notice when there are
  no definitions to decode with
* Repository operations (clone, fetch, pull, push) report their state, shown in the status bar,
  the timeline and the definitions tab
* Robustness: the recording is read into the browser day by day after the first timeline load,
  queries stop when the browser aborts a request, at most three scans run at once, reads are
  retried on 502/503/504

# 0.1.0 (unreleased)

First version (MVP).

## Features
* Timeline of the telegrams recorded by the eBUSd app (option `sqlite_db`): grouped by source,
  destination, command and message ID; unchanged values collapsed into bars with repeat count
  and interval; zoom, pan, overview of the whole recording; details with the raw telegrams
* Home Assistant entity state changes logged into the same database (table `event`) and shown
  in the timeline, plus manual markers
* Definitions: git repository of TypeSpec sources (clone, tree, editor, diff, commit, pull,
  push), compile to ebusd CSV in the browser (TypeSpec compiler 1.17, eBUS TypeSpec library
  0.31), decode recorded telegrams with ebusd 26.1's message library in the browser
  (WebAssembly), deploy the CSV files to the share folder
* Community layers: pull requests of ebusd-configuration (or branches) fetched and compiled
  on top of the checkout, merged three-way, with every definition attributed to its source
* Setup of this installation: every definition that matches the recorded telegrams, also the
  ones ebusd hides (other device variant files, unmet conditions), with decoded examples;
  the chosen ones are exported as CSV files per circuit for the eBUSd app, as Home Assistant
  `climate`/`water_heater` YAML and as eBUSd app options
* ebus-evidence: export of the recording as ebusd message-mode raw log, and evidence profile
  checks run on the recording
* Reads both layouts of the telegram log (schema version 1 and 2); notes of the eBUSd
  terminal's `log` command are shown as markers
