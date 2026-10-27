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
