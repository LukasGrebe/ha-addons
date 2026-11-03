// The setup of this installation: ebusd's own choice (what it does today with its own
// definitions) plus your changes: definitions added from other sources or the hidden ones,
// definitions taken out, the candidate picked for a message, and the names messages, fields and
// circuits get in your config. A definition is identified by the content of its line (the pool's
// hash), wherever it comes from. Stored in the app's settings so that every browser sees the same
// setup. Shared by the list, the inspector and the setup column.
import { api, app, bus, toast } from "./app.js";
import { CSV_HEADER, joinCsv, splitCsv } from "./csv.js";

export { CSV_HEADER, joinCsv, splitCsv };
export const MINE = "mine";
const NAME_CHARS = /[^A-Za-z0-9_.-]/g;
const FIELD_COLUMNS = 8;   // type,circuit,name,comment,qq,zz,pbsb,id then groups of 6 per field
const FIELD_GROUP = 6;
const isHash = (key) => /^[0-9a-f]{8}$/.test(key);

export const sanitizeName = (name) => String(name || "").trim().replace(NAME_CHARS, "_").slice(0, 60);

class SetupModel {
  constructor() {
    this.data = { added: [], removed: [], circuits: {}, names: {}, chosen: {} };
    this.timer = null;
    this.migrated = false;
  }

  /** Take the setup from the app settings (after they were loaded or changed elsewhere). */
  load() {
    const s = app.settings?.setup || {};
    this.data = {
      added: Array.isArray(s.added) ? s.added.slice() : [],
      removed: Array.isArray(s.removed) ? s.removed.slice() : [],
      circuits: { ...(s.circuits || {}) },
      names: { ...(s.names || {}) },
      chosen: { ...(s.chosen || {}) },
    };
    // keys of earlier versions (source|file|circuit|name) cannot be mapped to lines: those changes are dropped, once
    const stale = (k) => !isHash(k);
    const dropped = this.data.added.filter(stale).length + this.data.removed.filter(stale).length + Object.values(this.data.chosen).filter(stale).length + Object.keys(this.data.names).filter(stale).length;
    if (dropped) {
      this.data.added = this.data.added.filter(isHash);
      this.data.removed = this.data.removed.filter(isHash);
      for (const [row, key] of Object.entries(this.data.chosen)) if (stale(key)) delete this.data.chosen[row];
      for (const key of Object.keys(this.data.names)) if (stale(key)) delete this.data.names[key];
      if (!this.migrated) { this.migrated = true; toast(`${dropped} change${dropped === 1 ? "" : "s"} of your setup from an earlier version could not be carried over (definitions are identified by their line now)`, "info", 8000); this.save(); }
    }
  }

  /** ebusd's own choice: the definitions ebusd uses today with its own definitions. */
  baselineKeys(entries) {
    return (entries || []).filter((e) => e.status === "active").map((e) => e.key);
  }

  /** Whether you changed anything (otherwise ebusd's own choice is the setup). */
  get customized() {
    const d = this.data;
    return d.added.length > 0 || d.removed.length > 0 || Object.keys(d.chosen).length > 0 || Object.keys(d.names).length > 0 || Object.keys(d.circuits).length > 0;
  }

  /** The keys of the included definitions: ebusd's choice without what you took out, plus what you added. */
  includedKeys(entries) {
    const base = this.baselineKeys(entries);
    const removed = new Set(this.data.removed);
    const out = base.filter((k) => !removed.has(k));
    const seen = new Set(out);
    for (const k of this.data.added) if (!seen.has(k)) { out.push(k); seen.add(k); }
    return out;
  }

  includedEntries(entries) {
    const keys = new Set(this.includedKeys(entries));
    return (entries || []).filter((e) => keys.has(e.key));
  }

  isIncluded(key, entries) { return new Set(this.includedKeys(entries)).has(key); }

  /** Put a definition into the setup or take it out, relative to ebusd's choice. */
  include(key, on, entries, save = true) {
    const base = new Set(this.baselineKeys(entries));
    const d = this.data;
    if (on) {
      d.removed = d.removed.filter((k) => k !== key);
      if (!base.has(key) && !d.added.includes(key)) d.added.push(key);
    } else {
      d.added = d.added.filter((k) => k !== key);
      if (base.has(key) && !d.removed.includes(key)) d.removed.push(key);
    }
    if (save) this.save();
  }

  /** Exactly these definitions. */
  setIncluded(keys, entries) {
    const want = new Set(keys);
    const base = this.baselineKeys(entries);
    const baseSet = new Set(base);
    this.data.removed = base.filter((k) => !want.has(k));
    this.data.added = [...want].filter((k) => !baseSet.has(k));
    this.save();
  }

  /** Pick a candidate for a message: it joins the setup, the message's other candidates leave it. */
  choose(rowKey, defKey, otherKeys = [], entries = null) {
    if (defKey) this.data.chosen[rowKey] = defKey; else delete this.data.chosen[rowKey];
    if (defKey) {
      for (const other of otherKeys) if (other !== defKey) this.include(other, false, entries, false);
      this.include(defKey, true, entries, false);
    }
    this.save();
  }

  chosenFor(rowKey) { return this.data.chosen[rowKey] || null; }

  /** Your changes against ebusd's choice, as definitions. */
  changes(entries) {
    const byKey = new Map((entries || []).map((e) => [e.key, e]));
    return {
      added: this.data.added.map((k) => byKey.get(k)).filter(Boolean),
      removed: this.data.removed.map((k) => byKey.get(k)).filter(Boolean),
      renamed: (entries || []).filter((e) => this.renamed(e)),
      circuits: Object.entries(this.data.circuits),
      unknownAdded: this.data.added.filter((k) => !byKey.has(k)).length,
    };
  }

  /** Back to ebusd's own choice, names included. */
  reset() {
    this.data = { added: [], removed: [], circuits: {}, names: {}, chosen: {} };
    this.save();
  }

  // -- names in my config -----------------------------------------------------------------------

  rename(def, name) {
    const clean = sanitizeName(name);
    const entry = { ...(this.data.names[def.key] || {}) };
    if (clean && clean !== def.name) entry.name = clean; else delete entry.name;
    if (Object.keys(entry).length) this.data.names[def.key] = entry; else delete this.data.names[def.key];
    this.save();
  }

  renameField(def, field, name) {
    const clean = sanitizeName(name);
    const entry = { ...(this.data.names[def.key] || {}) };
    const fields = { ...(entry.fields || {}) };
    if (clean && clean !== field) fields[field] = clean; else delete fields[field];
    if (Object.keys(fields).length) entry.fields = fields; else delete entry.fields;
    if (Object.keys(entry).length) this.data.names[def.key] = entry; else delete this.data.names[def.key];
    this.save();
  }

  exportName(def) { return this.data.names[def.key]?.name || def.name; }

  renamed(def) { return this.exportName(def) !== def.name || Object.keys(this.data.names[def.key]?.fields || {}).length > 0; }

  /** Field names of a definition in my config: original -> exported. */
  fieldMap(def) {
    const renames = this.data.names[def.key]?.fields || {};
    const map = {};
    for (const field of def.fields || []) map[field] = renames[field] || field;
    return map;
  }

  circuitOf(def) { return this.data.circuits[def.circuit] || def.circuit; }

  renameCircuit(circuit, name) {
    const clean = sanitizeName(name);
    if (clean && clean !== circuit) this.data.circuits[circuit] = clean; else delete this.data.circuits[circuit];
    this.save();
  }

  /** A definition's CSV line with the names of my config, without its condition (it is chosen for this installation). */
  csvOf(def) {
    const cells = splitCsv(def.csv || "");
    if (cells.length < FIELD_COLUMNS) return def.csv || "";
    cells[0] = cells[0].replace(/^(\[[^\]]*\])+/, "");
    cells[1] = this.circuitOf(def);
    cells[2] = this.exportName(def);
    const renames = this.data.names[def.key]?.fields || {};
    for (let i = FIELD_COLUMNS; i < cells.length; i += FIELD_GROUP) {
      if (renames[cells[i]]) cells[i] = renames[cells[i]];
    }
    return joinCsv(cells);
  }

  /** CSV files for the eBUSd app: the included definitions, one file per circuit, conditions removed, each with its source. */
  files(entries, sourceLabels = {}) {
    const groups = {};
    const sources = new Set();
    for (const m of this.includedEntries(entries)) {
      const name = `${(this.circuitOf(m) || "misc").toLowerCase().replace(/[^a-z0-9_.-]/g, "_")}.csv`;
      (groups[name] ??= []).push(m);
      sources.add(`${m.source}:${m.file}`);
    }
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const out = {};
    for (const [name, list] of Object.entries(groups)) {
      list.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name) || (a.write ? 1 : 0) - (b.write ? 1 : 0));
      const lines = [CSV_HEADER, `# generated by ebusd Config Workbench ${stamp} for this installation from ${[...new Set(list.map((m) => m.file))].join(", ")}`];
      let source = null;
      for (const m of list) {
        if (m.source !== source) {
          source = m.source;
          lines.push(`# from ${sourceLabels[source] || m.sourceLabel || source}${source === MINE ? "" : ` (${source})`}`);
        }
        if (this.renamed(m)) lines.push(`# upstream name: ${m.circuit} ${m.name}${Object.keys(this.data.names[m.key]?.fields || {}).length ? ` (fields ${Object.entries(this.data.names[m.key].fields).map(([a, b]) => `${a}→${b}`).join(", ")})` : ""}`);
        lines.push(this.csvOf(m));
      }
      out[name] = lines.join("\n") + "\n";
    }
    return { files: out, sources: [...sources] };
  }

  /** The included messages as the Home Assistant YAML generator wants them (names of my config, roles upstream). */
  haMessages(entries) {
    return this.includedEntries(entries).map((m) => {
      const fieldOf = this.fieldMap(m);
      return { circuit: this.circuitOf(m), name: this.exportName(m), role: m.name, write: m.write, passive: m.passive, fields: Object.values(fieldOf), fieldOf };
    });
  }

  /** A flag of the shared UI settings (hide failing definitions, …); the views re-render. */
  async setUi(name, value) {
    try { app.settings = await api.put("api/settings", { ui: { ...(app.settings?.ui || {}), [name]: value } }); } catch (err) { toast(err.message, "err"); }
    bus.emit("setup-changed");
  }

  // -- persistence ----------------------------------------------------------------------------

  save() {
    bus.emit("setup-changed");
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try {
        app.settings = await api.put("api/settings", { setup: { ...this.data, updated: new Date().toISOString() } });
      } catch (err) { toast(`saving the setup failed: ${err.message}`, "err"); }
    }, 500);
  }
}

export const setup = new SetupModel();
