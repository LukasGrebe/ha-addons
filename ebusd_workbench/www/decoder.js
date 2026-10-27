// Live decoding of the recording: keeps the distinct telegrams of the database in the browser
// store and decodes every new one with every source of definitions (ebusd's release, the upcoming
// release, pull requests, your own scratchpad), each in a Web Worker running ebusd's message
// library, and stores the decodings, so that the bus view, the scratchpad and the setup can read
// them without decoding again.
//
// A source is a complete tree of CSV files, what ebusd would load with --configpath pointing at
// it. Decoding a telegram with a source yields every definition of that source that fits it
// (--candidates): the one ebusd would use (file chosen by the scan identification of the device,
// condition met, longest ID) and the hidden ones. A definition is identified by its source, file,
// circuit, name and direction, so the same message from two sources is two candidates; the
// scratchpad groups candidates that decode the same values.
//
// ebusd evaluates conditions ([Ehp_heatpumptype=3] …) against telegrams decoded before and picks
// the file of a device from its identification (scan), so an incremental run always starts with
// the identification telegrams and the ones that decoded to a message a condition refers to.
import { api, app, bus, fmt } from "./app.js";
import { openStore } from "./store.js";
import { CSV_HEADER, MINE, MINE_FILE } from "./setup.js";
import { idLengthOf } from "./colors.js";

const SYNC_INTERVAL = 5000;
const SYNC_CHUNK = 86400e3;
const BATCH = 1500;
const BUILD_KEY = "build";

export const defKeyOf = (source, c) => `${source}|${c.file}|${c.circuit}|${c.name}|${c.write ? "w" : ""}${c.passive ? "u" : ""}`;
export const sourceOfKey = (key) => key.slice(0, key.indexOf("|"));
const hex2 = (n) => n.toString(16).padStart(2, "0");
const byFirst = (a, b) => (a.first_ms ?? Infinity) - (b.first_ms ?? Infinity) || a.line.localeCompare(b.line);
const isScanLine = (line) => line.slice(4, 10) === "070400";

/** ebusd's hex notation of a timeline run: QQ ZZ PB SB NN ID+payload [/ NN answer]. */
export function lineOfRun(row, run) {
  if ([row.qq, row.zz, row.pb, row.sb].some((v) => v === null || v === undefined) || (run.status && run.status !== "ok")) return null;
  const data = `${row.id || ""}${run.payload || ""}`;
  const master = `${hex2(row.qq)}${hex2(row.zz)}${hex2(row.pb)}${hex2(row.sb)}${hex2(data.length / 2)}${data}`;
  return run.slave ? `${master}/${hex2(run.slave.length / 2)}${run.slave}` : master;
}

export const fnvText = (text) => { let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };

const compactFields = (fields) => {
  if (!fields || typeof fields !== "object") return null;
  const out = {};
  for (const [name, f] of Object.entries(fields)) out[name] = f && typeof f === "object" && "value" in f ? f.value : f;
  return out;
};

/** The scratchpad as a source: one CSV file (the header is added when the text has none). */
export function mineSource(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const file = `${/^\s*type\s*,/i.test(trimmed) ? "" : CSV_HEADER + "\n"}${trimmed}\n`;
  return { id: MINE, label: "my definitions", kind: "mine", filesId: `${MINE}@${fnvText(file)}`, files: { [MINE_FILE]: file }, enabled: true };
}

export class Decoder {
  constructor() {
    this.store = null;
    this.telegrams = new Map();   // line -> {line, master, slave, status, n, first_ms, last_ms, decoded: {source: filesId}, manual}
    this.decodes = new Map();     // line -> Map(defKey -> decode)
    this.defs = new Map();        // defKey -> definition with statistics
    this.entries = [];
    this.build = null;            // {id, at, sources: [{id, label, kind, filesId, files, head, title, enabled, delta}]}
    this.buildChecked = false;    // the builder has had its say since the page loaded: the build from the store may be stale before
    this.scan = {};               // source -> zz -> {manufacturer, ident, sw, hw, file}
    this.scanFresh = new Set();   // "buildId|source" whose scan was taken from the current files
    this.conditionRefs = {};      // source -> Set of message names a condition refers to
    this.loaded = {};             // source -> {messages, errors, files, stderr} of the last run
    this.meta = { key: "current", source: "", lastSync: null, scan: {} };
    this.syncing = false;
    this.decoding = false;
    this.progress = null;
    this.fraction = null;
    this.error = null;
    this.workerFailed = false;
    this.workers = {};
    this.requests = new Map();
    this.reqId = 0;
    this.ready = new Promise((resolve) => { this.markReady = resolve; });
  }

  // -- lifecycle ---------------------------------------------------------------------------

  async init() {
    this.store = await openStore();
    const db = app.status?.db || {};
    const source = `${db.path || ""}|${db.first_ms || 0}`;
    let meta = null;
    try { meta = await this.store.get("meta", "current"); } catch (err) { console.warn(err); }
    if (meta && meta.source !== source) {
      // another recording: the telegrams and their decodings belong to the old one
      for (const name of ["telegrams", "occurrences", "decodes", "definitions"]) await this.store.clear(name);
      meta = null;
    }
    this.meta = meta || { key: "current", source, lastSync: null, scan: {} };
    this.scan = this.meta.scan || {};
    try {
      const build = await this.store.get("compiles", BUILD_KEY);
      this.build = build && Array.isArray(build.sources) ? build : null;
      const stamps = this.stamps();
      for (const t of await this.store.getAll("telegrams")) {
        if (!t.decoded) t.decoded = {};
        this.telegrams.set(t.line, t);
      }
      for (const d of await this.store.getAll("decodes")) {
        if (!d.source || stamps[d.source] !== d.filesId) continue;
        let map = this.decodes.get(d.line);
        if (!map) this.decodes.set(d.line, (map = new Map()));
        map.set(d.defKey, d);
      }
      for (const def of await this.store.getAll("definitions")) {
        if (def.source && stamps[def.source] === def.filesId) this.defs.set(def.key, def);
      }
    } catch (err) { console.warn("loading the store failed:", err); }
    for (const def of this.defs.values()) this.noteConditions(def.source, def.conditions);
    this.rebuildEntries(false);
    this.markReady();
    this.emit("loaded");
    setInterval(() => { if (document.visibilityState === "visible") this.sync(); }, SYNC_INTERVAL);
    this.sync();
  }

  emit(reason) { bus.emit("decodes-changed", reason); }

  async saveMeta() {
    this.meta.scan = this.scan;
    try { await this.store.putAll("meta", [this.meta]); } catch (err) { console.warn(err); }
  }

  /** The sources of the build: id -> filesId. */
  stamps() { return Object.fromEntries((this.build?.sources || []).map((s) => [s.id, s.filesId])); }

  sources() { return this.build?.sources || []; }

  enabledSources() { return this.sources().filter((s) => s.enabled !== false); }

  source(id) { return this.sources().find((s) => s.id === id) || null; }

  /** The source whose choice is "what ebusd uses": the release when it is there, else the first enabled one that is not the scratchpad. */
  get primary() {
    const enabled = this.enabledSources().filter((s) => s.kind !== "mine");
    return (enabled.find((s) => s.id === "release") || enabled[0] || null)?.id || null;
  }

  /** A summary for the UI. */
  status() {
    const enabled = this.enabledSources();
    const stamps = Object.fromEntries(enabled.map((s) => [s.id, s.filesId]));
    const primary = this.primary;
    let known = 0, decoded = 0;
    const perSource = Object.fromEntries(enabled.map((s) => [s.id, { id: s.id, label: s.label, kind: s.kind, decoded: 0, pending: 0, known: 0, definitions: 0, loaded: this.loaded[s.id] || null }]));
    for (const t of this.telegrams.values()) {
      let all = enabled.length > 0;
      for (const s of enabled) {
        const done = t.decoded?.[s.id] === stamps[s.id];
        if (done) perSource[s.id].decoded++; else { perSource[s.id].pending++; all = false; }
      }
      if (all) decoded++;
      const map = this.decodes.get(t.line);
      if (map) {
        const seen = new Set();
        for (const d of map.values()) if (d.used && !seen.has(d.source)) { seen.add(d.source); perSource[d.source] && perSource[d.source].known++; if (d.source === primary) known++; }
      }
    }
    for (const def of this.entries) if (perSource[def.source]) perSource[def.source].definitions++;
    return {
      store: this.store?.kind || "none",
      build: this.build ? { id: this.build.id, at: this.build.at, summary: this.build.summary, sources: Object.values(perSource) } : null,
      primary, telegrams: this.telegrams.size, decoded, known, definitions: this.entries.length, active: this.entries.filter((e) => e.status === "active").length,
      syncing: this.syncing, decoding: this.decoding, progress: this.progress, fraction: this.fraction, lastSync: this.meta.lastSync, error: this.error,
    };
  }

  // -- telegrams: keep the distinct telegrams of the recording in the store ---------------------

  async sync() {
    if (this.syncing || !this.store) return;
    const db = app.status?.db;
    if (!db?.exists || !db.has_telegram_table || !db.first_ms) return;
    this.syncing = true;
    try {
      const start = this.meta.lastSync ?? db.first_ms;
      // never past what the database holds (the browser's clock may differ from the device's)
      const end = Math.min(Date.now(), (db.last_ms || 0) + 60e3);
      let added = 0, changed = 0;
      this.error = null;
      const chunks = Math.ceil((end - start) / SYNC_CHUNK);
      for (let from = start, i = 0; from < end; from = Math.min(from + SYNC_CHUNK, end), i++) {
        const to = Math.min(from + SYNC_CHUNK, end);
        if (chunks > 1) {
          this.progress = `reading the recording into the browser: day ${i + 1} of ${chunks} (${fmt.date(from)})`;
          this.fraction = i / chunks;
          this.emit("progress");
        }
        const list = await this.fetchDistinct(from, to);
        const put = [];
        for (const t of list) {
          const line = `${t.master}${t.slave ? "/" + t.slave : ""}`;
          const existing = this.telegrams.get(line);
          if (existing) {
            existing.n = (existing.n || 0) + t.n;
            existing.first_ms = existing.first_ms === null || existing.first_ms === undefined ? t.first_ms : Math.min(existing.first_ms, t.first_ms);
            existing.last_ms = Math.max(existing.last_ms || 0, t.last_ms);
            existing.manual = false;
            put.push(existing);
            changed++;
          } else {
            const record = { line, master: t.master, slave: t.slave || null, status: t.status, n: t.n, first_ms: t.first_ms, last_ms: t.last_ms, decoded: {}, manual: false };
            this.telegrams.set(line, record);
            put.push(record);
            added++;
          }
        }
        if (put.length) await this.store.putAll("telegrams", put);
        this.meta.lastSync = to;
        await this.saveMeta();
        if (added || changed) this.emit("telegrams");
        added = changed = 0;
      }
      this.progress = null;
      this.fraction = null;
      await this.saveMeta();
      if (added || changed) this.emit("telegrams");
    } catch (err) {
      console.warn("telegram sync failed:", err);
      this.progress = null;
      this.fraction = null;
      this.error = `reading the recording failed: ${err.message}`;
    } finally {
      this.syncing = false;
    }
    await this.decodePending();
  }

  async fetchDistinct(from, to, depth = 0) {
    const limit = 50000;
    const { telegrams } = await api.get(`api/telegrams/distinct?from=${Math.floor(from)}&to=${Math.ceil(to)}&limit=${limit}`);
    if (telegrams.length < limit || depth > 12 || to - from < 60e3) return telegrams;
    const mid = (from + to) / 2;
    return [...(await this.fetchDistinct(from, mid, depth + 1)), ...(await this.fetchDistinct(mid, to, depth + 1))];
  }

  /** The runs the bus view fetched, as pointers to their telegram (line) with their timing. */
  async rememberRuns(rows) {
    const put = [];
    for (const row of rows) {
      for (const run of row.runs) {
        if (!run.line) continue;
        put.push({ line: run.line, t0: run.t0, t1: run.t1, n: run.n, mean: run.mean, min: run.min });
      }
    }
    try { await this.store.putAll("occurrences", put); } catch (err) { console.warn(err); }
  }

  /** Telegrams pasted by hand: decoded like recorded ones, counted as not seen. */
  async addManual(lines) {
    await this.ready;
    const put = [];
    for (const raw of lines) {
      const line = raw.trim().toLowerCase().replace(/\s+/g, "");
      if (!line || line.startsWith("#") || this.telegrams.has(line)) continue;
      const [master, slave] = line.split("/");
      const record = { line, master, slave: slave || null, status: "ok", n: 0, first_ms: null, last_ms: null, decoded: {}, manual: true };
      this.telegrams.set(line, record);
      put.push(record);
    }
    if (put.length) await this.store.putAll("telegrams", put);
    await this.decodePending();
  }

  // -- the build: the sources and their files ---------------------------------------------------

  /**
   * A new build: sources whose files changed (or that are new) are decoded over the recording,
   * sources that stayed keep their decodings, sources that left take theirs along.
   */
  async setBuild(build) {
    await this.ready;
    const before = this.stamps();
    const after = Object.fromEntries((build.sources || []).map((s) => [s.id, s.filesId]));
    const dropped = Object.keys(before).filter((id) => after[id] !== before[id]);
    this.build = build;
    this.buildChecked = true;
    this.error = null;
    if (dropped.length) await this.dropSources(dropped);
    try {
      await this.store.putAll("compiles", [{ ...build, id: BUILD_KEY, buildId: build.id }]);
    } catch (err) { console.warn("storing the build failed:", err); }
    this.rebuildEntries(true);
    this.emit("build");
    await this.decodePending();
  }

  /** Forget the decodings of some sources (they are decoded again when the source is back). */
  async dropSources(ids) {
    const gone = new Set(ids);
    const removed = [];
    for (const map of this.decodes.values()) {
      for (const [key, d] of map) if (gone.has(d.source)) { removed.push(d.id); map.delete(key); }
    }
    for (const [key, def] of [...this.defs]) if (gone.has(def.source)) this.defs.delete(key);
    for (const id of ids) { delete this.scan[id]; delete this.conditionRefs[id]; delete this.loaded[id]; }
    const tput = [];
    for (const t of this.telegrams.values()) {
      let touched = false;
      for (const id of ids) if (t.decoded && id in t.decoded) { delete t.decoded[id]; touched = true; }
      if (touched) tput.push(t);
    }
    try {
      await this.store.deleteKeys("decodes", removed);
      await this.store.putAll("telegrams", tput);
      await this.store.deleteKeys("definitions", [...this.defs.keys()].filter(() => false));
    } catch (err) { console.warn(err); }
  }

  /** Enable or disable a source of the current build without fetching anything. */
  async setSourceEnabled(id, enabled) {
    if (!this.build) return;
    const source = this.source(id);
    if (!source || (source.enabled !== false) === enabled) return;
    source.enabled = enabled;
    await this.setBuild(this.build);
  }

  // -- decoding ------------------------------------------------------------------------------

  async decodePending() {
    if (!this.build || !this.buildChecked || this.decoding) return;
    const sources = this.enabledSources().filter((s) => s.files && Object.keys(s.files).length);
    if (!sources.length) return;
    const work = sources.map((s) => ({ source: s, pending: [...this.telegrams.values()].filter((t) => t.decoded?.[s.id] !== s.filesId).sort(byFirst) })).filter((w) => w.pending.length);
    const stale = sources.filter((s) => !this.scanFresh.has(`${this.build.id}|${s.id}`));
    if (!work.length && !stale.length) return;
    this.decoding = true;
    this.error = null;
    const total = work.reduce((n, w) => n + w.pending.length, 0);
    let done = 0;
    try {
      // the identification of the devices with the files of this build (persisted results may be stale)
      for (const source of stale) await this.refreshScan(source);
      if (stale.length) { this.rebuildEntries(false); this.emit("scan"); }
      for (const { source, pending } of work) {
        for (let i = 0; i < pending.length; i += BATCH) {
          // the build changed meanwhile (a source refreshed, unticked or removed): this source is done for now
          const current = this.source(source.id);
          if (!current || current.filesId !== source.filesId || current.enabled === false) { done += pending.length - i; break; }
          this.progress = `decoding with ${source.label}: ${fmt.count(Math.min(i + BATCH, pending.length))} of ${fmt.count(pending.length)} telegrams`;
          this.fraction = done / total;
          this.emit("progress");
          await this.decodeBatch(source, pending.slice(i, i + BATCH));
          done += Math.min(BATCH, pending.length - i);
          this.rebuildEntries(false);
          this.emit("decodes");
        }
        await this.refreshScan(source);
      }
    } catch (err) {
      console.error(err);
      this.error = `decoding failed: ${err.message}`;
    } finally {
      this.decoding = false;
      this.progress = null;
      this.fraction = null;
      this.rebuildEntries(true);
      this.emit("decodes");
      // telegrams that arrived while decoding
      const stamps = this.stamps();
      if (!this.error && [...this.telegrams.values()].some((t) => this.enabledSources().some((s) => t.decoded?.[s.id] !== stamps[s.id]))) setTimeout(() => this.decodePending(), 50);
    }
  }

  /** The devices' identification as this source's files see it: the scan telegrams alone, replacing what was stored. */
  async refreshScan(source) {
    const lines = [...this.telegrams.values()].filter((t) => isScanLine(t.line)).map((t) => t.line);
    this.scanFresh.add(`${this.build.id}|${source.id}`);
    if (!lines.length) return;
    try {
      const result = await this.run({ files: source.files, filesId: source.filesId, args: ["--candidates"], stdin: lines.join("\n") + "\n", worker: source.id });
      const scan = (result.results.find((r) => r.scan) || {}).scan;
      if (scan) { this.scan[source.id] = scan; await this.saveMeta(); }
    } catch (err) { console.warn(`scan with ${source.id} failed:`, err); }
  }

  /** Telegrams that have to precede an incremental run of a source: identifications and condition setters. */
  contextTelegrams(source) {
    const out = new Map();
    const refs = this.conditionRefs[source.id];
    for (const t of this.telegrams.values()) {
      if (isScanLine(t.line)) { out.set(t.line, t); continue; }
      if (!refs?.size || t.decoded?.[source.id] !== source.filesId) continue;
      const map = this.decodes.get(t.line);
      if (!map) continue;
      for (const key of map.keys()) {
        const def = this.defs.get(key);
        if (def && def.source === source.id && (refs.has(def.name.toLowerCase()) || refs.has(`${def.circuit}/${def.name}`.toLowerCase()))) { out.set(t.line, t); break; }
      }
    }
    return out;
  }

  noteConditions(sourceId, conditions) {
    const refs = (this.conditionRefs[sourceId] ||= new Set());
    for (const ref of conditions || []) {
      if (!ref || !ref.message || ref.message === "scan") continue;
      refs.add(String(ref.message).toLowerCase());
      if (ref.circuit) refs.add(`${ref.circuit}/${ref.message}`.toLowerCase());
    }
  }

  /**
   * Whether ebusd loads a file of a source for this installation: files at the root always; the device
   * file chosen by the scan for the device; and the files of a manufacturer folder without an address
   * prefix (broadcast.csv, general.csv) once a device of that manufacturer was identified.
   */
  inScanFile(sourceId, file, zz) {
    if (!file.includes("/")) return true;
    const scan = this.scan[sourceId] || {};
    if (file === (scan[zz]?.file || "")) return true;
    const dir = file.slice(0, file.indexOf("/")).toLowerCase();
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (/^[0-9a-f]{2}\./i.test(name)) return false;
    return Object.values(scan).some((s) => s.file && String(s.manufacturer || "").toLowerCase() === dir);
  }

  async decodeBatch(source, batch) {
    const all = this.contextTelegrams(source);
    for (const t of batch) all.set(t.line, t);
    const ordered = [...all.values()].sort(byFirst);
    const result = await this.run({ files: source.files, filesId: source.filesId, args: ["--candidates"], stdin: ordered.map((t) => t.line).join("\n") + "\n", worker: source.id });
    const loaded = result.results.find((r) => r.loaded);
    if (loaded) this.loaded[source.id] = { messages: loaded.messages, errors: loaded.errors, files: loaded.files?.length || 0, stderr: result.stderr.slice(0, 50) };
    if (result.exitCode && !result.results.some((r) => "input" in r)) throw new Error(result.stderr[0] || `ebusd-check exited with ${result.exitCode}`);
    const scan = (result.results.find((r) => r.scan) || {}).scan || {};
    this.scan[source.id] = { ...(this.scan[source.id] || {}), ...scan };
    const now = Date.now();
    const put = [], tput = [];
    const mine = source.kind === "mine";
    for (const r of result.results) {
      if (!("input" in r)) continue;
      const t = this.telegrams.get(r.input);
      if (!t) continue;
      const seen = new Set();
      const candidates = [];
      for (const c of r.candidates || (r.found ? [{ ...r, selected: true }] : [])) {
        const key = defKeyOf(source.id, c);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(c);
      }
      // what ebusd would use with this source: own definitions are never ebusd's choice, they are picked by hand
      const usable = mine ? [] : candidates.filter((c) => c.available && this.inScanFile(source.id, c.file, c.zz));
      const used = usable.length ? usable.reduce((best, c) => (c.idlen > best.idlen ? c : best), usable[0]) : null;
      let map = this.decodes.get(r.input);
      if (!map) this.decodes.set(r.input, (map = new Map()));
      for (const key of [...map.keys()]) if (sourceOfKey(key) === source.id) map.delete(key);
      for (const c of candidates) {
        const key = defKeyOf(source.id, c);
        this.noteDef(source, c);
        const d = { id: `${r.input}|${key}`, line: r.input, defKey: key, source: source.id, result: c.result || "unknown", text: c.text || "", fields: compactFields(c.fields),
          available: !!c.available, selected: !!c.selected, used: c === used, filesId: source.filesId, at: now };
        map.set(key, d);
        put.push(d);
      }
      t.decoded ||= {};
      t.decoded[source.id] = source.filesId;
      t.decodedAt = now;
      if (r.error) t.error = r.error;
      tput.push(t);
    }
    try {
      await this.store.putAll("decodes", put);
      await this.store.putAll("telegrams", tput);
    } catch (err) { console.warn("storing decodings failed:", err); }
    await this.saveMeta();
  }

  noteDef(source, c) {
    const key = defKeyOf(source.id, c);
    let def = this.defs.get(key);
    const make = (k, x) => ({ key: k, source: source.id, sourceLabel: source.label, circuit: x.circuit, name: x.name, file: x.file, condition: x.condition || "", conditions: x.conditions || [], write: !!x.write, passive: !!x.passive,
      level: x.level || "", zz: x.zz, qq: x.qq || null, pbsb: x.pbsb, idlen: x.idlen, csv: x.csv || "", filesId: source.filesId, siblings: [], available: !!x.available, inScanFile: this.inScanFile(source.id, x.file, x.zz) });
    if (!def) {
      def = make(key, c);
      def.available = false;
      this.defs.set(key, def);
      this.noteConditions(source.id, def.conditions);
    }
    if (c.available) def.available = true;
    def.inScanFile = this.inScanFile(source.id, c.file, c.zz);
    for (const s of c.siblings || []) {
      const sk = defKeyOf(source.id, s);
      if (!this.defs.has(sk)) this.defs.set(sk, make(sk, s));
      if (!def.siblings.includes(sk)) def.siblings.push(sk);
    }
    return def;
  }

  // -- the definitions that matched, with statistics --------------------------------------------

  rebuildEntries(persist) {
    const order = Object.fromEntries(this.sources().map((s, i) => [s.id, i]));
    for (const def of this.defs.values()) {
      Object.assign(def, { distinct: 0, occurrences: 0, ok: 0, errors: 0, used: 0, examples: [], first_ms: null, last_ms: null, seen: false });
      def.fieldSet = new Set();
      def.companionSet = new Set();
    }
    const telegrams = [...this.telegrams.values()].sort(byFirst);
    for (const t of telegrams) {
      const map = this.decodes.get(t.line);
      if (!map) continue;
      for (const [key, d] of map) {
        const def = this.defs.get(key);
        if (!def) continue;
        def.seen = true;
        def.distinct++;
        def.occurrences += t.n || 0;
        if (d.result === "ok") def.ok++; else def.errors++;
        if (d.used) def.used++;
        for (const f of Object.keys(d.fields || {})) def.fieldSet.add(f);
        if (d.result === "ok" && def.examples.length < 3 && d.text && !def.examples.includes(d.text)) def.examples.push(d.text);
        if (t.first_ms !== null && t.first_ms !== undefined) def.first_ms = def.first_ms === null ? t.first_ms : Math.min(def.first_ms, t.first_ms);
        if (t.last_ms) def.last_ms = def.last_ms === null ? t.last_ms : Math.max(def.last_ms, t.last_ms);
        for (const sk of def.siblings) this.defs.get(sk)?.companionSet.add(key);
      }
    }
    for (const [key, def] of this.defs) {
      def.fields = [...def.fieldSet];
      def.companionOf = [...def.companionSet];
      delete def.fieldSet; delete def.companionSet;
      if (!def.seen && !def.companionOf.length) { this.defs.delete(key); continue; }
      def.companion = !def.seen;
      def.status = def.companion ? "companion" : def.source === MINE ? "custom" : def.used > 0 ? "active" : def.ok === 0 ? "error" : !def.available ? "conditional" : !def.inScanFile ? "variant" : "hidden";
    }
    for (const def of this.defs.values()) {
      if (def.companion && !def.fields.length) def.fields = [...new Set(def.companionOf.flatMap((k) => this.defs.get(k)?.fields || []))];
    }
    this.entries = [...this.defs.values()].sort((a, b) => a.zz.localeCompare(b.zz) || a.circuit.localeCompare(b.circuit) || a.name.localeCompare(b.name) || (order[a.source] ?? 99) - (order[b.source] ?? 99) || a.file.localeCompare(b.file));
    if (persist && this.store) {
      this.store.clear("definitions").then(() => this.defs.size && this.store.putAll("definitions", this.entries)).catch((err) => console.warn(err));
    }
  }

  // -- lookups for the views -------------------------------------------------------------------

  def(key) { return this.defs.get(key); }

  decodesOf(line) { return this.decodes.get(line); }

  /** The decoded fields of the latest telegram a definition decoded (for showing values next to names). */
  sampleFields(defKey) {
    let best = null;
    for (const t of this.telegrams.values()) {
      const d = this.decodes.get(t.line)?.get(defKey);
      if (d && d.result === "ok" && d.fields && (!best || (t.last_ms || 0) > best.at)) best = { at: t.last_ms || 0, fields: d.fields };
    }
    return best?.fields || null;
  }

  /** The telegrams sorted by first appearance (manual ones last). */
  telegramList() { return [...this.telegrams.values()].sort(byFirst); }

  /** The telegrams newest decoding first; the ones still waiting for a decoding at the end. */
  decodedList() {
    return [...this.telegrams.values()].sort((a, b) => (b.decodedAt || 0) - (a.decodedAt || 0) || (b.first_ms ?? -Infinity) - (a.first_ms ?? -Infinity) || a.line.localeCompare(b.line));
  }

  /** The decoding ebusd itself would use for a telegram: the choice of the primary source (or of the given one). */
  usedDecode(line, sourceId = this.primary) {
    const map = this.decodes.get(line);
    if (!map || !sourceId) return null;
    for (const d of map.values()) if (d.used && d.source === sourceId) return d;
    return null;
  }

  /** The device identification seen on the bus, with the file every source would load for it. */
  scanInfo(zz) {
    let ident = null;
    const files = {};
    for (const [sourceId, scan] of Object.entries(this.scan)) {
      const s = scan?.[zz];
      if (!s) continue;
      ident ||= { manufacturer: s.manufacturer, ident: s.ident, sw: s.sw, hw: s.hw };
      files[sourceId] = s.file || "";
    }
    return ident ? { ...ident, files } : null;
  }

  /** Every device identification seen on the bus: zz -> scanInfo. */
  devices() {
    const out = {};
    for (const scan of Object.values(this.scan)) for (const zz of Object.keys(scan || {})) if (!out[zz]) out[zz] = this.scanInfo(zz);
    return out;
  }

  /**
   * The candidate definitions of a set of telegram lines (a bus row), with how they fared on
   * these lines: Map(defKey -> {def, ok, errors, used, last}); used counts the primary source's choice.
   */
  candidatesOf(lines) {
    const out = new Map();
    const primary = this.primary;
    for (const line of lines) {
      const map = this.decodes.get(line);
      if (!map) continue;
      for (const [key, d] of map) {
        const def = this.defs.get(key);
        if (!def) continue;
        let c = out.get(key);
        if (!c) out.set(key, (c = { def, ok: 0, errors: 0, used: 0, usedIn: 0, last: d }));
        if (d.result === "ok") c.ok++; else c.errors++;
        if (d.used) { c.usedIn++; if (d.source === primary) c.used++; }
        c.last = d;
      }
    }
    return out;
  }

  /**
   * Prefix rules that make the bus rows follow the definitions: for every telegram a definition
   * of ebusd's choice decodes, the data bytes the definition uses as message ID.
   * Only rules that change the current grouping are returned: Map("zzpbsb:prefix" -> ID length).
   */
  idRules(settings) {
    const rules = new Map();
    for (const t of this.telegrams.values()) {
      const d = this.usedDecode(t.line);
      if (!d || !t.master) continue;
      const def = this.defs.get(d.defKey);
      if (!def) continue;
      if (idLengthOf(t.master, settings) === def.idlen) continue;
      rules.set(`${t.master.slice(2, 8)}:${t.master.slice(10, 10 + def.idlen * 2)}`, def.idlen);
    }
    return rules;
  }

  /** The same for the telegrams of one row and every candidate there (used by "split like the definitions"). */
  idRulesFor(telegrams, settings) {
    const rules = new Map();
    for (const t of telegrams) {
      for (const d of this.decodes.get(t.line)?.values() || []) {
        const def = this.defs.get(d.defKey);
        if (!def || d.result !== "ok" || !t.master || def.idlen <= 0) continue;
        if (idLengthOf(t.master, settings) >= def.idlen) continue;
        rules.set(`${t.master.slice(2, 8)}:${t.master.slice(10, 10 + def.idlen * 2)}`, def.idlen);
      }
    }
    return rules;
  }

  /** Message ID lengths per device and command (ZZPBSB) as the used definitions define them. */
  idLengths() {
    const lengths = {};
    const primary = this.primary;
    for (const map of this.decodes.values()) {
      for (const d of map.values()) {
        if (!d.used || d.source !== primary) continue;
        const def = this.defs.get(d.defKey);
        if (!def) continue;
        const key = def.zz + def.pbsb;
        lengths[key] = Math.max(lengths[key] || 0, def.idlen);
      }
    }
    return lengths;
  }

  // -- running ebusd-check -----------------------------------------------------------------------

  async run({ files, filesId, args, stdin, worker: workerName = "main" }) {
    if (!this.workerFailed) {
      try {
        const worker = this.ensureWorker(workerName);
        if (worker.filesId !== filesId) {
          await this.request(worker, { type: "files", id: filesId, files });
          worker.filesId = filesId;
        }
        return await this.request(worker, { type: "decode", filesId, args, stdin });
      } catch (err) {
        console.warn("decode worker failed, decoding on the main thread:", err);
        this.workerFailed = true;
        for (const w of Object.values(this.workers)) { try { w.terminate(); } catch { /* ignore */ } }
        this.workers = {};
      }
    }
    if (!this.inline) {
      const { createEbusdCheck } = await import("./vendor/ebusd-check.js");
      this.inline = await createEbusdCheck("vendor/ebusd-check.wasm");
    }
    return this.inline({ files, args, stdin });
  }

  ensureWorker(name = "main") {
    if (this.workers[name]) return this.workers[name];
    const worker = new Worker(new URL("./decode-worker.js", import.meta.url), { type: "module" });
    worker.filesId = null;
    worker.onmessage = (e) => {
      const pending = this.requests.get(e.data.reqId);
      if (!pending) return;
      this.requests.delete(e.data.reqId);
      if (e.data.ok) pending.resolve(e.data.result); else pending.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || "decode worker error");
      for (const pending of this.requests.values()) pending.reject(err);
      this.requests.clear();
    };
    this.workers[name] = worker;
    return worker;
  }

  request(worker, message) {
    return new Promise((resolve, reject) => {
      const reqId = ++this.reqId;
      this.requests.set(reqId, { resolve, reject });
      worker.postMessage({ ...message, reqId });
    });
  }

  /** Forget the browser-side copy of the recording and its decodings (the build stays, it is decoded again). */
  async reset() {
    for (const name of ["telegrams", "occurrences", "decodes", "definitions", "meta"]) await this.store.clear(name);
    this.telegrams.clear(); this.decodes.clear(); this.defs.clear(); this.entries = []; this.scan = {}; this.loaded = {};
    this.meta = { key: "current", source: this.meta.source, lastSync: null, scan: {} };
    this.emit("reset");
    this.sync();
  }
}
