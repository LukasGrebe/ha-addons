// The setup of this installation: which definitions are included, which candidate a timeline
// row uses, and the names they get in "my config" (circuits, messages and fields renamed from the
// upstream names to whatever is clearer for this system). Shared by the timeline and the
// definitions tab; stored in the app's settings so that every browser sees the same setup.
import { api, app, bus, toast } from "./app.js";

export const CSV_HEADER = "type,circuit,name,comment,qq,zz,pbsb,id,*name,part,type,divisor/values,unit,comment";
const NAME_CHARS = /[^A-Za-z0-9_.-]/g;
const FIELD_COLUMNS = 8;   // type,circuit,name,comment,qq,zz,pbsb,id then groups of 6 per field
const FIELD_GROUP = 6;

/** Split a CSV line as ebusd reads it (double quotes around values with commas). */
export function splitCsv(line) {
  const cells = [];
  let cell = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell); cell = ""; } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

export function joinCsv(cells) {
  return cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");
}

export const sanitizeName = (name) => String(name || "").trim().replace(NAME_CHARS, "_").slice(0, 60);

class SetupModel {
  constructor() {
    this.data = { included: null, circuits: {}, names: {}, chosen: {} };
    this.timer = null;
  }

  /** Take the setup from the app settings (after they were loaded or changed elsewhere). */
  load() {
    const s = app.settings?.setup || {};
    this.data = {
      included: Array.isArray(s.included) ? s.included.slice() : null,
      circuits: { ...(s.circuits || {}) },
      names: { ...(s.names || {}) },
      chosen: { ...(s.chosen || {}) },
    };
  }

  get includedSet() { return new Set(this.data.included || []); }

  /** Whether the user made a selection yet (otherwise ebusd's own choice is the setup). */
  get customized() { return Array.isArray(this.data.included); }

  /** The keys of the included definitions; without a selection, what ebusd itself uses. */
  includedKeys(entries) {
    if (this.customized) return this.data.included.slice();
    return (entries || []).filter((e) => e.status === "active").map((e) => e.key);
  }

  includedEntries(entries) {
    const keys = new Set(this.includedKeys(entries));
    return (entries || []).filter((e) => keys.has(e.key));
  }

  isIncluded(key, entries) { return new Set(this.includedKeys(entries)).has(key); }

  setIncluded(keys) {
    this.data.included = [...new Set(keys)];
    this.save();
  }

  include(key, on, entries) {
    const keys = new Set(this.includedKeys(entries));
    if (on) keys.add(key); else keys.delete(key);
    this.setIncluded([...keys]);
  }

  /** Pick a candidate for a timeline row: it joins the setup, the row's other candidates leave it. */
  choose(rowKey, defKey, otherKeys = [], entries = null) {
    if (defKey) this.data.chosen[rowKey] = defKey; else delete this.data.chosen[rowKey];
    if (defKey) {
      const keys = new Set(this.includedKeys(entries));
      for (const other of otherKeys) if (other !== defKey) keys.delete(other);
      keys.add(defKey);
      this.data.included = [...keys];
    }
    this.save();
  }

  chosenFor(rowKey) { return this.data.chosen[rowKey] || null; }

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

  /** A definition's CSV line with the names of my config. */
  csvOf(def) {
    const cells = splitCsv(def.csv || "");
    if (cells.length < FIELD_COLUMNS) return def.csv || "";
    cells[1] = this.circuitOf(def);
    cells[2] = this.exportName(def);
    const renames = this.data.names[def.key]?.fields || {};
    for (let i = FIELD_COLUMNS; i < cells.length; i += FIELD_GROUP) {
      if (renames[cells[i]]) cells[i] = renames[cells[i]];
    }
    return joinCsv(cells);
  }

  /** CSV files for the eBUSd app: the included definitions, one file per circuit, conditions removed. */
  files(entries, layers = []) {
    const groups = {};
    const sources = new Set();
    for (const m of this.includedEntries(entries)) {
      const name = `${(this.circuitOf(m) || "misc").toLowerCase().replace(/[^a-z0-9_.-]/g, "_")}.csv`;
      (groups[name] ??= []).push(m);
      sources.add(m.file);
    }
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const out = {};
    for (const [name, list] of Object.entries(groups)) {
      list.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name) || (a.write ? 1 : 0) - (b.write ? 1 : 0));
      const lines = [CSV_HEADER, `# generated by eBUSd Workbench ${stamp} for this installation from ${[...new Set(list.map((m) => m.file))].join(", ")}`];
      let source = null;
      for (const m of list) {
        if (m.source !== source) {
          source = m.source;
          const layer = layers.find((l) => l.ref === source);
          lines.push(source === "base" ? "# from the checkout" : `# from layer ${source}${layer?.head ? ` (${layer.head.subject})` : ""}`);
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
