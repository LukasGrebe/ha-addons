// Live decoding of the recording: keeps the distinct telegrams of the database in the browser
// store, decodes every new one with all candidate definitions of the current compile (in a Web
// Worker running ebusd's message library) and stores the decodings, so that the timeline, the
// candidate picker and the setup can read them without decoding again.
//
// ebusd evaluates conditions ([Ehp_heatpumptype=3] …) against telegrams decoded before and picks
// the file of a device from its identification (scan), so an incremental run always starts with
// the identification telegrams and the ones that decoded to a message a condition refers to.
import { api, app, bus, fmt } from "./app.js";
import { openStore } from "./store.js";

const SYNC_INTERVAL = 5000;
const SYNC_CHUNK = 86400e3;
const BATCH = 1500;

export const defKeyOf = (c) => `${c.file}|${c.circuit}|${c.name}|${c.write ? "w" : ""}${c.passive ? "u" : ""}`;
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

/** Where a decoded definition comes from: "base" (the checkout) or the layer that added it. */
export function originOf(compile, file, name) {
  if (!compile || !compile.layers?.length) return "base";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = compile.baseOutputs?.[file];
  if (base !== undefined && new RegExp(`(^|\n)(\\[[^\\]]*\\])?[rwu]+,[^,\n]*,[^,\n]*,${escaped},`).test(base)) return "base";
  const source = file.endsWith(".inc") ? file.slice(0, -4) + "_inc.tsp" : file.replace(/\.csv$/, ".tsp");
  const word = new RegExp(`\\b${escaped}\\b`);
  const inBase = word.test(compile.baseFiles?.[source] || "");
  for (const ref of compile.originLayers?.[source] || []) {
    if (!inBase && word.test(compile.layerFiles?.[ref]?.[source] || "")) return ref;
  }
  for (const ref of compile.layers) {
    for (const [path, layers] of Object.entries(compile.originLayers || {})) {
      if (layers.includes(ref) && word.test(compile.layerFiles?.[ref]?.[path] || "") && !word.test(compile.baseFiles?.[path] || "")) return ref;
    }
  }
  const origins = compile.originLayers?.[source];
  if (origins?.length) return origins.length === 1 ? origins[0] : origins.join("+");
  const dir = file.includes("/") ? file.slice(0, file.indexOf("/") + 1) : "";
  const inDir = [...new Set(Object.entries(compile.origins || {}).filter(([p]) => p.startsWith(dir)).map(([, l]) => l))];
  return inDir.length === 1 ? inDir[0] : "layers";
}

const compactFields = (fields) => {
  if (!fields || typeof fields !== "object") return null;
  const out = {};
  for (const [name, f] of Object.entries(fields)) out[name] = f && typeof f === "object" && "value" in f ? f.value : f;
  return out;
};

export class Decoder {
  constructor() {
    this.store = null;
    this.telegrams = new Map();   // line -> {line, master, slave, status, n, first_ms, last_ms, compileId, manual}
    this.decodes = new Map();     // line -> Map(defKey -> decode)
    this.defs = new Map();        // defKey -> definition with statistics
    this.entries = [];
    this.compile = null;
    this.scan = {};
    this.conditionRefs = new Set();
    this.meta = { key: "current", source: "", lastSync: null, compileId: null, scan: {} };
    this.syncing = false;
    this.decoding = false;
    this.progress = null;
    this.fraction = null;
    this.error = null;
    this.worker = null;
    this.workerFailed = false;
    this.requests = new Map();
    this.reqId = 0;
    this.dirtyDefs = new Set();
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
    this.meta = meta || { key: "current", source, lastSync: null, compileId: null, scan: {} };
    this.scan = this.meta.scan || {};
    try {
      if (this.meta.compileId) this.compile = (await this.store.get("compiles", this.meta.compileId)) || null;
      for (const t of await this.store.getAll("telegrams")) this.telegrams.set(t.line, t);
      for (const d of await this.store.getAll("decodes")) {
        if (!this.compile || d.compileId !== this.compile.id) continue;
        let map = this.decodes.get(d.line);
        if (!map) this.decodes.set(d.line, (map = new Map()));
        map.set(d.defKey, d);
      }
      for (const def of await this.store.getAll("definitions")) {
        if (this.compile && def.compileId === this.compile.id) this.defs.set(def.key, def);
      }
    } catch (err) { console.warn("loading the store failed:", err); }
    for (const def of this.defs.values()) this.noteConditions(def.conditions);
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

  /** A summary for the UI. */
  status() {
    let known = 0, decoded = 0;
    for (const t of this.telegrams.values()) {
      if (this.compile && t.compileId === this.compile.id) decoded++;
      const map = this.decodes.get(t.line);
      if (map) for (const d of map.values()) if (d.used) { known++; break; }
    }
    return {
      store: this.store?.kind || "none", compile: this.compile ? { id: this.compile.id, at: this.compile.at, summary: this.compile.summary, entry: this.compile.entry, layers: this.compile.layers, loaded: this.compile.loaded } : null,
      telegrams: this.telegrams.size, decoded, known, definitions: this.entries.length, active: this.entries.filter((e) => e.status === "active").length,
      syncing: this.syncing, decoding: this.decoding, progress: this.progress, fraction: this.fraction, lastSync: this.meta.lastSync, error: this.error,
    };
  }

  // -- telegrams: keep the distinct telegrams of the recording in the store ---------------------

  async sync() {
    if (this.syncing || !this.store) return;
    const db = app.status?.db;
    if (!db?.exists || !db.has_telegram_table || !db.first_ms) return;
    // the timeline's first load goes first: the device answers one thing at a time best
    await Promise.race([app.views.timeline?.firstLoad, new Promise((r) => setTimeout(r, 20000))]);
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
            const record = { line, master: t.master, slave: t.slave || null, status: t.status, n: t.n, first_ms: t.first_ms, last_ms: t.last_ms, compileId: null, manual: false };
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

  /** The runs the timeline fetched, as pointers to their telegram (line) with their timing. */
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
      const record = { line, master, slave: slave || null, status: "ok", n: 0, first_ms: null, last_ms: null, compileId: null, manual: true };
      this.telegrams.set(line, record);
      put.push(record);
    }
    if (put.length) await this.store.putAll("telegrams", put);
    await this.decodePending();
  }

  // -- compile -------------------------------------------------------------------------------

  /** A new compile: forget every decoding and decode the recording again. */
  async setCompile(record) {
    await this.ready;
    this.compile = record;
    this.scan = {};
    this.conditionRefs = new Set();
    this.decodes.clear();
    this.defs.clear();
    this.entries = [];
    this.error = null;
    for (const t of this.telegrams.values()) t.compileId = null;
    try {
      await this.store.clear("decodes");
      await this.store.clear("definitions");
      const old = await this.store.getAll("compiles");
      await this.store.deleteKeys("compiles", old.map((c) => c.id).filter((id) => id !== record.id));
      await this.store.putAll("compiles", [record]);
    } catch (err) { console.warn("storing the compile failed:", err); }
    this.meta.compileId = record.id;
    await this.saveMeta();
    this.emit("compile");
    await this.decodePending();
  }

  /** Decode only these compiled files (null: all). */
  async selectFiles(names) {
    if (!this.compile) return;
    this.compile.selected = names;
    await this.setCompile(this.compile);
  }

  files() {
    if (!this.compile?.outputs) return null;
    const selected = this.compile.selected;
    if (!selected) return this.compile.outputs;
    return Object.fromEntries(Object.entries(this.compile.outputs).filter(([name]) => selected.includes(name) || name.endsWith(".inc")));
  }

  // -- decoding ------------------------------------------------------------------------------

  async decodePending() {
    if (!this.compile?.outputs || this.decoding) return;
    const pending = [...this.telegrams.values()].filter((t) => t.compileId !== this.compile.id).sort(byFirst);
    if (!pending.length) return;
    this.decoding = true;
    this.error = null;
    try {
      for (let i = 0; i < pending.length; i += BATCH) {
        this.progress = `decoding ${fmt.count(Math.min(i + BATCH, pending.length))} of ${fmt.count(pending.length)} telegrams`;
        this.fraction = i / pending.length;
        this.emit("progress");
        await this.decodeBatch(pending.slice(i, i + BATCH));
        this.rebuildEntries(false);
        this.emit("decodes");
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
      if (!this.error && [...this.telegrams.values()].some((t) => t.compileId !== this.compile?.id)) setTimeout(() => this.decodePending(), 50);
    }
  }

  /** Telegrams that have to precede an incremental run: identifications and condition setters. */
  contextTelegrams() {
    const out = new Map();
    for (const t of this.telegrams.values()) {
      if (isScanLine(t.line)) { out.set(t.line, t); continue; }
      if (!this.conditionRefs.size || t.compileId !== this.compile.id) continue;
      const map = this.decodes.get(t.line);
      if (!map) continue;
      for (const key of map.keys()) {
        const def = this.defs.get(key);
        if (def && (this.conditionRefs.has(def.name.toLowerCase()) || this.conditionRefs.has(`${def.circuit}/${def.name}`.toLowerCase()))) { out.set(t.line, t); break; }
      }
    }
    return out;
  }

  noteConditions(conditions) {
    for (const ref of conditions || []) {
      if (!ref || !ref.message || ref.message === "scan") continue;
      this.conditionRefs.add(String(ref.message).toLowerCase());
      if (ref.circuit) this.conditionRefs.add(`${ref.circuit}/${ref.message}`.toLowerCase());
    }
  }

  inScanFile(file, zz) { return !file.includes("/") || file === (this.scan[zz]?.file || ""); }

  async decodeBatch(batch) {
    const compile = this.compile;
    const all = this.contextTelegrams();
    for (const t of batch) all.set(t.line, t);
    const ordered = [...all.values()].sort(byFirst);
    const files = this.files();
    const args = ["--candidates"];
    if (compile.selected) for (const name of compile.selected) if (name.endsWith(".csv")) args.push(`--file=${name}`);
    const result = await this.run({ files, filesId: `${compile.id}|${(compile.selected || []).join(",")}`, args, stdin: ordered.map((t) => t.line).join("\n") + "\n" });
    const loaded = result.results.find((r) => r.loaded);
    if (loaded) compile.loaded = { messages: loaded.messages, errors: loaded.errors, files: loaded.files?.length || 0, stderr: result.stderr.slice(0, 50) };
    if (result.exitCode && !result.results.some((r) => "input" in r)) throw new Error(result.stderr[0] || `ebusd-check exited with ${result.exitCode}`);
    const scan = (result.results.find((r) => r.scan) || {}).scan || {};
    Object.assign(this.scan, scan);
    const now = Date.now();
    const put = [], tput = [];
    for (const r of result.results) {
      if (!("input" in r)) continue;
      const t = this.telegrams.get(r.input);
      if (!t) continue;
      const seen = new Set();
      const candidates = [];
      for (const c of r.candidates || (r.found ? [{ ...r, selected: true }] : [])) {
        const key = defKeyOf(c);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(c);
      }
      const usable = candidates.filter((c) => c.available && this.inScanFile(c.file, c.zz));
      const used = usable.length ? usable.reduce((best, c) => (c.idlen > best.idlen ? c : best), usable[0]) : null;
      const map = new Map();
      for (const c of candidates) {
        const key = defKeyOf(c);
        this.noteDef(c);
        const d = { id: `${r.input}|${key}`, line: r.input, defKey: key, result: c.result || "unknown", text: c.text || "", fields: compactFields(c.fields),
          available: !!c.available, selected: !!c.selected, used: c === used, compileId: compile.id, at: now };
        map.set(key, d);
        put.push(d);
      }
      this.decodes.set(r.input, map);
      t.compileId = compile.id;
      t.error = r.error || null;
      tput.push(t);
    }
    try {
      await this.store.putAll("decodes", put);
      await this.store.putAll("telegrams", tput);
    } catch (err) { console.warn("storing decodings failed:", err); }
    await this.saveMeta();
  }

  noteDef(c) {
    const key = defKeyOf(c);
    let def = this.defs.get(key);
    if (!def) {
      def = { key, circuit: c.circuit, name: c.name, file: c.file, condition: c.condition || "", conditions: c.conditions || [], write: !!c.write, passive: !!c.passive,
        level: c.level || "", zz: c.zz, qq: c.qq || null, pbsb: c.pbsb, idlen: c.idlen, csv: c.csv || "", source: originOf(this.compile, c.file, c.name),
        compileId: this.compile.id, siblings: [], available: false, inScanFile: this.inScanFile(c.file, c.zz) };
      this.defs.set(key, def);
      this.noteConditions(def.conditions);
      this.dirtyDefs.add(key);
    }
    if (c.available) def.available = true;
    def.inScanFile = this.inScanFile(c.file, c.zz);
    for (const s of c.siblings || []) {
      const sk = defKeyOf(s);
      if (!this.defs.has(sk)) {
        this.defs.set(sk, { key: sk, circuit: s.circuit, name: s.name, file: s.file, condition: s.condition || "", conditions: s.conditions || [], write: !!s.write, passive: !!s.passive,
          level: s.level || "", zz: s.zz, qq: s.qq || null, pbsb: s.pbsb, idlen: s.idlen, csv: s.csv || "", source: originOf(this.compile, s.file, s.name),
          compileId: this.compile.id, siblings: [], available: !!s.available, inScanFile: this.inScanFile(s.file, s.zz) });
        this.dirtyDefs.add(sk);
      }
      if (!def.siblings.includes(sk)) def.siblings.push(sk);
    }
    return def;
  }

  // -- the definitions that matched, with statistics --------------------------------------------

  rebuildEntries(persist) {
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
      def.status = def.companion ? "companion" : def.used > 0 ? "active" : def.ok === 0 ? "error" : !def.available ? "conditional" : !def.inScanFile ? "variant" : "hidden";
    }
    for (const def of this.defs.values()) {
      if (def.companion && !def.fields.length) def.fields = [...new Set(def.companionOf.flatMap((k) => this.defs.get(k)?.fields || []))];
    }
    this.entries = [...this.defs.values()].sort((a, b) => a.zz.localeCompare(b.zz) || a.circuit.localeCompare(b.circuit) || a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
    if (persist && this.store && this.defs.size) {
      this.store.putAll("definitions", this.entries).catch((err) => console.warn(err));
      this.dirtyDefs.clear();
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

  /** The decoding ebusd itself would use for a telegram. */
  usedDecode(line) {
    const map = this.decodes.get(line);
    if (!map) return null;
    for (const d of map.values()) if (d.used) return d;
    return null;
  }

  /**
   * The candidate definitions of a set of telegram lines (a timeline row), with how they fared on
   * these lines: Map(defKey -> {def, ok, errors, used, last}).
   */
  candidatesOf(lines) {
    const out = new Map();
    for (const line of lines) {
      const map = this.decodes.get(line);
      if (!map) continue;
      for (const [key, d] of map) {
        const def = this.defs.get(key);
        if (!def) continue;
        let c = out.get(key);
        if (!c) out.set(key, (c = { def, ok: 0, errors: 0, used: 0, last: d }));
        if (d.result === "ok") c.ok++; else c.errors++;
        if (d.used) c.used++;
        c.last = d;
      }
    }
    return out;
  }

  /** Message ID lengths per device and command (ZZPBSB) as the used definitions define them. */
  idLengths() {
    const lengths = {};
    for (const map of this.decodes.values()) {
      for (const d of map.values()) {
        if (!d.used) continue;
        const def = this.defs.get(d.defKey);
        if (!def) continue;
        const key = def.zz + def.pbsb;
        lengths[key] = Math.max(lengths[key] || 0, def.idlen);
      }
    }
    return lengths;
  }

  // -- running ebusd-check -----------------------------------------------------------------------

  async run({ files, filesId, args, stdin }) {
    if (!this.workerFailed) {
      try {
        const worker = this.ensureWorker();
        if (worker.filesId !== filesId) {
          await this.request(worker, { type: "files", id: filesId, files });
          worker.filesId = filesId;
        }
        return await this.request(worker, { type: "decode", filesId, args, stdin });
      } catch (err) {
        console.warn("decode worker failed, decoding on the main thread:", err);
        this.workerFailed = true;
        if (this.worker) { try { this.worker.terminate(); } catch { /* ignore */ } this.worker = null; }
      }
    }
    if (!this.inline) {
      const { createEbusdCheck } = await import("./vendor/ebusd-check.js");
      this.inline = await createEbusdCheck("vendor/ebusd-check.wasm");
    }
    return this.inline({ files, args, stdin });
  }

  ensureWorker() {
    if (this.worker) return this.worker;
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
    this.worker = worker;
    return worker;
  }

  request(worker, message) {
    return new Promise((resolve, reject) => {
      const reqId = ++this.reqId;
      this.requests.set(reqId, { resolve, reject });
      worker.postMessage({ ...message, reqId });
    });
  }

  /** Forget the browser-side copy of the recording and its decodings. */
  async reset() {
    for (const name of ["telegrams", "occurrences", "decodes", "definitions", "compiles", "meta"]) await this.store.clear(name);
    this.telegrams.clear(); this.decodes.clear(); this.defs.clear(); this.entries = []; this.compile = null; this.scan = {};
    this.meta = { key: "current", source: this.meta.source, lastSync: null, compileId: null, scan: {} };
    this.emit("reset");
    this.sync();
  }
}
