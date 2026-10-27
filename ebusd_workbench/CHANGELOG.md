# 0.2.1 (unreleased)

The timeline becomes the place where definitions are compared, chosen and named.

## Features
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
