# 0.5.3 (unreleased)

## Features
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
