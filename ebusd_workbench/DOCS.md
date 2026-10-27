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
| **Telegram database** | The same path as `sqlite_db` of the eBUSd app, default `/share/ebusd/telegrams.db`. The Workbench stores entity changes in this file as well (table `event`) and creates it if the eBUSd app has not yet. |
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
- **ID bytes** sets the default message ID length; per command lengths are set from the
  details panel or in *Settings*. Rows that seem to change with every telegram (a date/time
  broadcast for example) do so because the whole payload is the value; rows mixing several
  registers need more ID bytes.
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
Assistant API and stores every change in the table `event` of the telegram database, with
the previous state and the attributes. They appear as rows at the top of the timeline. Only
state changes are stored, attribute-only changes are ignored.

**+ marker** adds a vertical line with a note at the current time, e.g. "opened the hot
water tap", so that you can find the telegrams that followed.

### Table `event`

| Column | Content |
|---|---|
| `ts` | time in ns since 1970-01-01 UTC, like `telegram.ts` |
| `source` | `ha` state change, `ha-initial` state when the subscription started, `marker` manual |
| `entity`, `state`, `previous`, `attributes` | entity id, new and previous state, attributes as JSON |
| `note` | text of a marker |

---

## Definitions

The left column is the git repository, the middle the editor, the right the build steps.

1. **Clone** your fork of ebusd-configuration (or *Start empty*). The tree shows the
   `.tsp` sources; symlinked files (ebusd-configuration shares definitions between devices
   that way) are read-only, edit their target.
2. **Edit** a file and **Save** (Ctrl+S). Changed files are marked in the tree and listed with
   *diff* and *discard*; enter a message and **Commit** the selected ones. **Pull** is
   fast-forward only, **Push** needs the access token.
3. **Compile**: pick the entry (`src/main.tsp` compiles everything, a single file only that
   file and what it imports) and optionally a translation file (`src/de.yaml`). Errors link
   to the line in the editor. Unsaved changes of the open file are compiled as they are.
4. **Test**: **from timeline window** fetches the distinct telegrams of the window shown in
   the timeline (most frequent first), or paste telegrams as `QQZZPBSBNNDD/NNDD` (as in
   `ebusctl grab` or the telegram log's `master`/`slave` columns). **Decode** loads the ticked
   compiled files into ebusd's message library and decodes every telegram. The result shows
   the matched message (circuit and name) and the decoded fields, *unknown* for telegrams
   without a definition and the error for ones that do not fit the definition. The timeline
   rows get the names of the decoded messages.
   Untick files to simulate what ebusd would load for your devices: with every file of a
   manufacturer loaded, a telegram may match a definition of another device type.
   Conditional definitions (`[Ehp_heatpumptype=3]…` in the CSV, `@condition` in TypeSpec) only
   match once the telegram that sets the condition (a register read, the scan identification)
   has been decoded, so the telegrams are decoded in the order of their first appearance.
5. **Deploy** writes the compiled `.csv` and `.inc` files to the deploy folder (optionally
   into a subfolder). *Remove other files there* deletes stale definitions. Then restart the
   eBUSd app with `--configpath` pointing there.

The compiler and the decoder are loaded into the browser on first use (about 1.7 MB).

---

## Folders

| Container path | Host path | Content |
|---|---|---|
| `/share/ebusd/telegrams.db` | `/share/ebusd/telegrams.db` | telegram database (eBUSd app and Workbench) |
| `/share/ebusd/config` | `/share/ebusd/config` | deployed CSV files for the eBUSd app |
| `/config/repo` | `/addon_configs/…_ebusd_workbench/repo` | git repository (in backups) |
| `/data/settings.json` | – | Workbench settings (entities, ID lengths, …; in backups) |

---

## Limitations of this first version

- The editor is a plain text area (no syntax highlighting or completion).
- Telegrams are grouped by address and ID bytes, not by the message definitions.
- Compiling and decoding happen on the main thread of the browser; the full
  ebusd-configuration takes about two seconds.
- Only HTTPS remotes with a token are supported for push.
- No prebuilt image yet: Supervisor builds the app on the device at installation (a minute
  or two).
