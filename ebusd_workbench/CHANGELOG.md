# 0.6.3 (unreleased)

## Features
* **Understood by** folds: a row shows three sources, the rest as *+N* with every source in the
  tooltip; a click unfolds them for that row
* The pill of a pull request in the inspector (and in the card of failing definitions) is a
  link to the pull request on GitHub, to follow its discussion; release and next link to the
  repository
* The status of a definition in the inspector is one sentence to paste into a pull request,
  with the devices and their software versions: "vwzio Status01 (PR 707, 76.vwzio.csv): decodes
  all 4,508 of 4,508 distinct telegrams (52,027 recorded) on 700 HW6903 SW 0419 (10) & VWZIO
  HW5103 SW 0432 (76), recorded 2026-10-20 – 2026-10-27"; a click copies it. The button for a
  copy of your own is called *edit a copy* now

# 0.6.2

## Features
* **Events next to the telegrams.** A switch or a binary sensor of Home Assistant (the circulation
  pump, the burner, a heating request) is watched as **on/off stretches**, any other entity as
  value changes; notes made with the `log` command of the eBUSd terminal are events too. The
  settings (Advanced) say what is watched, how, under which name and colour. An *events* line
  above the list shows what the recording holds. Sorted by **last received**, the stretches and
  notes interleave with the messages as lines of their own; in every sort a message's row carries
  a dot per stretch that was on when it was last seen, and a thin bar per watched entity with
  how much of its traffic arrived while that was on. The inspector's telegram line says what was
  on at that telegram; the chart draws the stretches behind the values and names them under the
  pointer
* **Home Assistant connection: diagnostics and a test.** The chip's tooltip and the settings show
  since when the connection stands, the last message and the last pong, the reconnects and the
  last error with its time; *test the connection* tries connect, authentication, subscription and
  ping apart from the running connection and says which step fails; the connection log is there
  to read

## Fixes
* The connection to Home Assistant no longer drops as "no answer to ping" while nothing happens:
  the pong to the keep-alive ping was skipped, so a quiet subscription (no state change for 90 s)
  looked dead. The pong counts as the answer now

# 0.6.1

## Features
* **A type picker** on every field of a line of your own (▾ next to the type): every type of
  ebusd that fits the bytes from the field on, in plain words, each with the value it reads from
  the telegram shown and the range over the recording, the most plausible first ("−40 to 130
  with decimals: a temperature?", "only grows: a counter or a total", "3 different values: a
  state?"); an **enumeration** prefilled from the values seen in the byte, with names to fill in
  (`0=off;1=on`); the **bits** of the byte with how often each is on; raw bytes or text with a
  length; a **unit** and a **divisor** to click. The box stays open while the line is saved, so
  type, unit and divisor are three clicks. **All types** opens the legend: every abbreviation with
  its length, range, the value that means "no value" and what it is used for
* A longer type takes its bytes from the raw fields after it, a shorter one leaves a raw field
  (`UCH, HEX:1, HEX:1, HEX:7` with `UIN` on the first becomes `UIN, HEX:7`)

## Fixes
* A line of an old-style pull request (CSV with templates, a `latest/en` layout) is checked with
  the templates of its directory and of those above it, as ebusd combines them, instead of being
  rejected for an unknown type
* The small trees a message is checked with carry the identification messages (`vaillant/scan.csv`
  of the compiled sources, not only a `scan.csv` at the root), so a condition such as
  `[id_sw>=200]` is judged there as ebusd judges it. Pools are read again once for this
* A definition shorter than the telegram fits it: ebusd reads what its fields need and leaves
  the rest (PR 528's `bai Status00` of 8 bytes over a 9-byte answer)

# 0.6.0

A new backbone: a definition is a line of CSV, wherever it comes from, and ebusd's library judges
it on demand. Everything this browser decoded before is decoded again, once (the browser store
changes shape); changes of the setup made with earlier versions are dropped, since definitions
are identified by their line now.

## Features
* **The pool**: every source (ebusd's release, the upcoming release, every open pull request of
  ebusd-configuration, your own lines) is parsed into one pool of distinct definition lines, each
  with where it comes from. A line is a candidate for the messages it fits (destination, command,
  message ID, lengths), with its sources as badges; the same line in several files or sources is
  one row. The list knows what fits without decoding anything. A line shorter than the telegram
  fits (ebusd reads what its fields need and leaves the rest), one longer does not; a line of
  your own that needs more bytes than the telegram has stays on its row and says so
* **Decoded on demand**: ebusd's library runs once over the whole recording with ebusd's own
  definitions (what it understands today, which definition it picks) and otherwise per message:
  the open inspector first, then the list in attention order in the background, each a small tree
  of that message's candidate lines over its telegrams. Results are kept per telegram and line,
  so nothing is decoded twice, whatever source adds it. Adding a pull request costs nothing
* **Every open pull request is in**: fetched by the device and compiled here once per commit;
  its lines are candidates with a PR badge wherever they fit. The search over the pull requests
  and "add as a source" are gone; *+ add* keeps a pull request after it is merged or closed, or
  adds a branch of another repository. The strip has one chip for the open pull requests with
  the list when unfolded (each one can be left out)
* **Instant start**: the list shows the telegrams this browser holds within a second, with the
  rest loading; the recording is read by itself on the first visit only, afterwards on request
  with **↻ load N newer telegrams** (the count is live). No polling of the recording any more
* **Sort by last received**: the list can be ordered by the newest telegram first
* **Lines of your own** are one file each for ebusd's library, so a line it rejects only loses
  itself; the reason shows on its row ("ebusd rejects this line: unknown field type UNI"). A
  field given a longer type takes its bytes from the raw fields after it (`UCH, HEX:1, HEX:1,
  HEX:7` with `UIN` on the first becomes `UIN, HEX:7`), a shorter one leaves a raw field behind
* The timeline, its grouping settings (ID bytes per command, ID rules), the research extras
  (ebus-evidence profiles, raw log export, pasted telegrams) and their endpoints are gone

## Features of 0.5.4
* **Nothing waits for ebusd's library any more.** A line of your own shows as a row of the
  inspector the moment it is saved, marked *checking* with a spinner until it has been decoded
  (the page is given back at once; the decode runs in the background with its progress in the
  sources strip and the top bar). The stored build no longer carries the files of every source
* **A raw field is carved**: a shorter type on a raw field (`HEX:9` → `HEX:5`) leaves the rest
  as a raw field of its own (`HEX:4`), to be carved further; every edit of a line of your own
  shows at once, from the line as saved
* **The chart is a box over the table**: click a field, its value or its sparkline and the chart
  of that field over the whole recording opens over the lower part of the inspector; hovering
  it shows that telegram in the table above (the bytes and every definition's values follow the
  pointer), a click keeps it, Esc or ✕ closes. The values list is gone. Stepping through the
  telegrams only repaints the telegram row and the values, nothing else moves
* **The open pull requests are the way to a definition**: their search sits right under the
  table and runs by itself for a message nothing is set up for (once per message and page,
  never over a running search). **+ add as a source** now says what happens: fetching from
  GitHub, compiling, decoding the recording with the telegrams of the inspected message first
  (so its rows appear after the first batch), done

## Features of 0.5.3
* **The eBUS specification as hints**: the addresses of a telegram are named in the inspector
  (the device the scan identified, ebusd for its own address, else the role the specification
  assigns: heating controller, burner control unit, …), the command bytes are explained in the
  tooltip (the primary command's path or manufacturer, the standard services, Vaillant's as
  ebusd's definitions use them), and a message ID longer than a byte is explained. The tables
  of the specification's appendix (master and slave addresses, manufacturer codes, primary
  command bytes) and its standard services live in `www/ebus-spec.js`
* **ebusd's own scan** (the identification 07 04 and, for Vaillant, the serial number in four
  parts b5 09 24…27) is marked as such instead of *nothing understands it*, and leaves *needs a
  look*
* **The search over the pull requests remembers**: what was found stays per message in the
  browser store and shows at once when the message is opened again; a search again only runs
  the pull requests with a new commit or more telegrams, and a pull request compiled before is
  not even loaded from the device again
* **A definition of your own is checked in a moment**: only the telegrams of the commands your
  lines define go through ebusd's library (the same for a partially compiled pull request)
  instead of the whole recording; the views are told about new decodings at most every 1.5 s
  during a long decode, and the device scan is refreshed per set of files, not per build
* The top bar no longer narrates a trickle of new telegrams per source; while a message is
  inspected it counts the newer telegrams the paused list will show. Compiling for the search
  is reported in the search's own line only

## Features of 0.5.2
* **The inspector**: the selected message laid out byte by byte, every definition that fits it as
  a row that carves the bytes into fields (bit fields in bit columns), the bytes of one recorded
  telegram with buttons to step through the recording, what every definition decodes from it, a
  sparkline per field over the whole recording, and the chart of the clicked field below. Cells
  where a definition reads the same bytes differently are highlighted. It replaces the cards with
  their source, comparison, history and editor columns
* The inspector opens **in the list, right under the selected message** (a second click or Esc
  closes it) instead of a pane at the bottom; the list stays put while a message is inspected,
  and the inspector redraws only when something about it changed, never while you type, keeping
  the scroll position and the selected text. *My setup* folds to a rail meanwhile (and on
  demand) so that the inspector has the width
* **Every field is editable, no modes**: the name of a message or field of a source's definition
  becomes the name in your config, a changed type, divisor or unit makes a copy of your own that
  is picked for the message, a row of kind *mine* edits your line. The **in setup** checkbox
  picks a definition for the message (the ● button and the names row are gone). **＋ a
  definition of your own** starts a line from the bytes, one raw field per part, and the tooltip
  of a byte lists what it could be as every number type; this replaces the *write a definition
  from the bytes* card
* **My definitions** moved to the setup column: your lines with how each fares, and the paste box
* The timeline is set aside for now (its settings, entities and grouping, are under Advanced);
  the research time range is set under Advanced, the whole recording by default
* The sources strip and the devices line fold to one line each (remembered per browser); folded,
  the sources show one combined bar for fetching and decoding
* A pull request on an old base that today's TypeSpec library rejects is compiled partially: only
  the files it changes (marked *partial*), instead of failing

# 0.5.0

One page, no modes, no git: the Workbench is a scratchpad for finding the definitions that fit
your devices.

## Features
* **One page**: the messages on the bus on the left, the scratchpad below them, your setup on the
  right, the sources at the top; the research tools fold open at the bottom. No tabs, steps,
  popovers or drawers: a click on a message shows everything about it in the scratchpad, every
  definition that fits it as a card that folds open in place (source, comparison, history,
  editor), several at once
* **The bus as a list of messages**, the way a definition sees them (destination, command and
  message ID, whoever asked), leading with what needs a look: the messages ebusd does not
  understand today, most traffic first, the ones other sources understand marked. The devices on
  the bus head the list, each with the file ebusd loads for it (or *no file*) and how much of its
  traffic is understood. The timeline is one click away for correlating with Home Assistant
  events and notes; its settings (entities to watch, grouping) sit in its own toolbar
* **Sources instead of a git checkout**: ebusd's own definitions come ready-made from
  [ebus.github.io](https://ebus.github.io) (the release the eBUSd app loads, and the upcoming
  release), a pull request of ebusd-configuration or a branch of another GitHub repository is
  fetched as a snapshot (a tarball, about a megabyte) and compiled in the browser. The first
  start fetches the release and the upcoming release by itself; the open pull requests of
  ebusd-configuration are listed to pick from, the ones that mention your devices first
* **Every source decoded side by side**: each source is a complete set of definitions (what
  ebusd would load with `--configpath` pointing at it) and decodes the recording on its own, so
  a definition is attributed to its source exactly, "ebusd's choice" is what ebusd does today,
  and a source says what it adds compared with the release (`+9 new, 15 changed`). Adding or
  refreshing a source decodes only that source
* **Scratchpad**: your own definition lines are a source like the others; a copy of any card,
  a definition read off the bytes, or pasted lines are decoded over the whole recording at once.
  Without a selection the scratchpad lists your lines with how each fares
* **My setup** column: ebusd's own choice (folded away by circuit) plus your changes, each with a
  way back; everything else that fits the bus (with one-click additions: the plausible hidden ones,
  the counterparts for writing), how it shows up in Home Assistant (the entities ebusd's MQTT
  discovery makes, the climate and water heater YAML), and saving for the eBUSd app. The setup is
  stored as changes against ebusd's choice, so a message seen tomorrow is understood tomorrow
* **Search the open pull requests for a message**: every open pull request of
  ebusd-configuration is fetched once, compiled once per commit and tried on the recorded
  telegrams of the selected message; the ones that decode it are listed with the name they give
  it and can be added as a source with one click
* A message whose definition is in your setup counts as handled: it leaves "needs a look" and
  the device chips count it as understood
* New option **language** (en, de): the language of the definitions, as the eBUSd app's
  `--configlang`

## Fixes
* "ebusd's choice" follows ebusd's scan exactly: besides the device file, the files of a
  manufacturer folder without an address prefix (`broadcast.csv`, `general.csv`) count as loaded
  once a device of that manufacturer is identified, so broadcasts (date and time, the outside
  temperature) are understood like ebusd does
* Symbolic links in the definition repositories (ebusd-configuration shares files between device
  variants that way) are followed, so `15.720.csv` and the like are there

## Changes
* The git options (repository URL, user, token) are gone, and so are the TypeSpec editor,
  commit, pull and push: changes of your own live in the scratchpad as ebusd CSV lines, which the
  exported files and `workbench-setup.json` record with their source. To contribute a definition
  upstream, copy the line into a pull request of ebusd-configuration
* The repository folder `/config/repo` is not used any more (it can be deleted); the fetched
  sources live in `/data/sources`
* The browser store is rebuilt once: definitions are now keyed by their source
