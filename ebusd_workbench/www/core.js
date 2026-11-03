// The core: the recording in the browser, the pool of definition lines of every source, and ebusd's
// library run in workers to judge them. What ebusd does today is one full run of the release tree
// over the recording (what it understands, which definition it picks); everything else is decoded
// per message on demand: a small tree of the message's candidate lines over the message's
// telegrams, the open inspector first, then the list in attention order in the background. Results
// are kept per telegram and definition line (by content hash), so nothing is decoded twice, and the
// views read everything through this facade (telegrams, candidates of a message, what a telegram
// decodes to, the definitions with their statistics, the devices).
import { api, app, bus, fmt } from "./app.js";
import { openStore } from "./store.js";
import { POOL_RULES, Pool, candidateKey, parseFiles } from "./pool.js";
import { CSV_HEADER, fnv } from "./csv.js";

const SYNC_CHUNK = 86400e3;
const BATCH = 1500;              // telegrams per run of the release tree
const MESSAGE_BATCH = 300;       // telegrams per run of a message's tree
const JOB_RULES = "j2";          // how a message's tree is built: a verdict inferred from a run (not listed by ebusd) is checked again when this changes
export const MINE = "mine";
const isScanLine = (line) => line.slice(4, 10) === "070400";
const byFirst = (a, b) => (a.first_ms ?? Infinity) - (b.first_ms ?? Infinity) || a.line.localeCompare(b.line);
const compactFields = (fields) => {
  if (!fields || typeof fields !== "object") return null;
  const out = {};
  for (const [name, f] of Object.entries(fields)) out[name] = f && typeof f === "object" && "value" in f ? f.value : f;
  return out;
};
const ORDER = { release: 0, next: 1 };
const orderOf = (id, kind) => ORDER[id] ?? (kind === "mine" ? 90 : kind === "pr" ? 10 : 20);

/** The files of your own lines: one file per line, so that a line ebusd rejects only loses itself. */
export function mineFiles(text) {
  const files = {};
  let n = 0;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^type\s*,/i.test(line)) continue;
    files[`mine/${++n}.csv`] = `${CSV_HEADER}\n${line}\n`;
  }
  return files;
}

export class Core {
  constructor() {
    this.store = null;
    this.telegrams = new Map();   // line -> {line, master, slave, status, n, first_ms, last_ms, primary: {stamp, hash}|null}
    this.results = new Map();     // line -> Map(hash -> {result, text, fields})
    this.flags = new Map();       // hash -> {available}: whether the line's condition was met on this bus
    this.conditionInfo = new Map();   // hash -> conditions as ebusd describes them
    this.lineErrors = new Map();  // hash -> what ebusd's library said when it refused the line
    this.pool = new Pool();
    this.sourceInfo = new Map();  // id -> {id, label, kind, stamp, enabled, head, title, url, error, summary, partial, files, scanKey}
    this.rowsDone = new Map();    // row key -> `${pool stamp}|${lines}`
    this.matchCache = new Map();  // line -> {version, hashes}
    this.defs = new Map();        // hash -> definition with statistics
    this.entries = [];
    this.meta = { key: "current", source: "", lastSync: null, scans: {} };
    this.queue = [];              // message jobs {key, lines, priority}
    this.jobRunning = false;
    this.primaryRunning = false;
    this.newTelegrams = 0;
    this.syncing = false;
    this.loading = null;
    this.progress = null;
    this.fraction = null;
    this.error = null;
    this.workerFailed = false;
    this.workers = {};
    this.requests = new Map();
    this.reqId = 0;
    this.lastUi = 0;
    this.ready = new Promise((resolve) => { this.markReady = resolve; });
  }

  // -- lifecycle -------------------------------------------------------------------------------------

  async init() {
    this.store = await openStore();
    const db = app.status?.db || {};
    const source = `${db.path || ""}|${db.first_ms || 0}`;
    let meta = null;
    try { meta = await this.store.get("meta", "current"); } catch (err) { console.warn(err); }
    if (meta && meta.source !== source) {
      // another recording: the telegrams and their decodings belong to the old one
      for (const name of ["telegrams", "results", "rows"]) await this.store.clear(name);
      meta = null;
    }
    this.meta = meta || { key: "current", source, lastSync: null, scans: {} };
    this.meta.scans ||= {};
    for (const [hash, message] of Object.entries(this.meta.lineErrors || {})) this.lineErrors.set(hash, message);
    try {
      this.loading = "reading the telegrams kept in this browser…";
      this.emit("loading");
      for (const t of await this.store.getAll("telegrams")) this.telegrams.set(t.line, t);
      this.loading = null;
      this.emit("telegrams");   // the list draws what the browser has
      for (const r of await this.store.getAll("results")) this.results.set(r.line, new Map(Object.entries(r.byHash || {})));
      for (const f of await this.store.getAll("flags")) this.flags.set(f.id, { available: !!f.available });
      for (const r of await this.store.getAll("rows")) this.rowsDone.set(r.key, r.stamp);
    } catch (err) { console.warn("loading the store failed:", err); this.loading = null; }
    this.markReady();
    this.emit("loaded");
    if (this.meta.lastSync === null) this.sync();   // the first visit reads the recording by itself; later ones on request
  }

  emit(reason) { bus.emit("decodes-changed", reason); }

  /** The list drew the telegrams it has: the count of newer ones starts again. */
  markDrawn() { this.newTelegrams = 0; }

  async saveMeta() {
    this.meta.lineErrors = Object.fromEntries(this.lineErrors);
    try { await this.store.putAll("meta", [this.meta]); } catch (err) { console.warn(err); }
  }

  // -- telegrams: the distinct telegrams of the recording ---------------------------------------------

  /** Read what the recording has beyond what the browser holds (on request; by itself only on the first visit). */
  async sync() {
    if (this.syncing || !this.store) return;
    const db = app.status?.db;
    if (!db?.exists || !db.has_telegram_table || !db.first_ms) return;
    this.syncing = true;
    try {
      const start = this.meta.lastSync ?? db.first_ms;
      const end = Math.min(Date.now(), (db.last_ms || 0) + 60e3);
      let added = 0, changed = 0;
      this.error = null;
      const chunks = Math.ceil((end - start) / SYNC_CHUNK);
      for (let from = start, i = 0; from < end; from = Math.min(from + SYNC_CHUNK, end), i++) {
        const to = Math.min(from + SYNC_CHUNK, end);
        this.progress = chunks > 1 ? `reading the recording: day ${i + 1} of ${chunks} (${fmt.date(from)})` : "reading the newest telegrams…";
        this.fraction = chunks > 1 ? i / chunks : null;
        this.emit("progress");
        const list = await this.fetchDistinct(from, to);
        const put = [];
        for (const t of list) {
          const line = `${t.master}${t.slave ? "/" + t.slave : ""}`;
          const existing = this.telegrams.get(line);
          if (existing) {
            existing.n = (existing.n || 0) + t.n;
            existing.first_ms = existing.first_ms === null || existing.first_ms === undefined ? t.first_ms : Math.min(existing.first_ms, t.first_ms);
            existing.last_ms = Math.max(existing.last_ms || 0, t.last_ms);
            put.push(existing);
            changed++;
          } else {
            const record = { line, master: t.master, slave: t.slave || null, status: t.status, n: t.n, first_ms: t.first_ms, last_ms: t.last_ms, primary: null };
            this.telegrams.set(line, record);
            put.push(record);
            added++;
          }
        }
        if (put.length) await this.store.putAll("telegrams", put);
        this.meta.lastSync = to;
        await this.saveMeta();
        this.newTelegrams += added;
        if (added || changed) this.emit("telegrams");
        added = changed = 0;
      }
    } catch (err) {
      console.warn("telegram sync failed:", err);
      this.error = `reading the recording failed: ${err.message}`;
    } finally {
      this.syncing = false;
      this.progress = null;
      this.fraction = null;
      this.emit("telegrams");
    }
    this.runPrimary();
  }

  async fetchDistinct(from, to, depth = 0) {
    const limit = 50000;
    const { telegrams } = await api.get(`api/telegrams/distinct?from=${Math.floor(from)}&to=${Math.ceil(to)}&limit=${limit}`);
    if (telegrams.length < limit || depth > 12 || to - from < 60e3) return telegrams;
    const mid = (from + to) / 2;
    return [...(await this.fetchDistinct(from, mid, depth + 1)), ...(await this.fetchDistinct(mid, to, depth + 1))];
  }

  // -- the sources and the pool -------------------------------------------------------------------------

  sources() { return [...this.sourceInfo.values()].sort((a, b) => orderOf(a.id, a.kind) - orderOf(b.id, b.kind)); }

  source(id) { return this.sourceInfo.get(id) || null; }

  enabledSources() { return this.sources().filter((s) => s.enabled !== false && !s.error); }

  /** The source whose choice is "what ebusd uses today": the release when it is there, else the upcoming release (never a pull request). */
  get primary() {
    const on = this.enabledSources();
    return (on.find((s) => s.id === "release") || on.find((s) => s.id === "next") || null)?.id || null;
  }

  /** The stamp of the pool as it is: a message decoded with it needs nothing more. */
  get poolStamp() { return fnv(this.enabledSources().map((s) => `${s.id}@${s.stamp}`).join(",")); }

  /**
   * A source as the sources module has it (fetched and compiled, or taken from the store). parsed is what
   * parseFiles returned, or null to take the parsed lines from the store by stamp; files are optional and
   * needed only for the primary's full run and for the scan of a source whose device files changed.
   */
  async addSource(info, parsed = null, files = null) {
    await this.ready;
    const prev = this.sourceInfo.get(info.id);
    const entry = { ...prev, ...info, files: files || prev?.files || null, enabled: info.enabled !== false };
    this.sourceInfo.set(info.id, entry);
    if (!parsed && prev?.stamp === info.stamp && this.pool.sources.has(info.id)) { this.afterPoolChange(); return; }
    if (!parsed) {
      const stored = await this.store.get("pool", `${info.stamp}@${POOL_RULES}`).catch(() => null);
      if (stored) parsed = { lines: new Map(stored.lines.map((l) => [l.hash, l])), refs: stored.refs, defaults: stored.defaults || {}, scan: stored.scan || null, templates: stored.templates || null };
    }
    if (!parsed && files) parsed = parseFiles(files);
    if (!parsed) { entry.error = entry.error || "no definitions loaded"; this.afterPoolChange(); return; }
    if (entry.kind !== "mine" && entry.stamp) {
      const record = { id: `${entry.stamp}@${POOL_RULES}`, source: entry.id, lines: [...parsed.lines.values()], refs: parsed.refs, defaults: parsed.defaults, scan: parsed.scan, templates: parsed.templates, at: Date.now() };
      this.store.putAll("pool", [record]).catch((err) => console.warn("storing the pool failed:", err));
    }
    if (entry.enabled) this.pool.setSource(entry.id, entry.stamp, parsed, orderOf(entry.id, entry.kind)); else this.pool.removeSource(entry.id);
    entry.parsed = parsed;
    this.afterPoolChange();
    if (files) this.ensureScan(entry).catch((err) => console.warn(err));
  }

  /** Whether the source's full file tree is needed here: for the primary's run over the recording, or for its scan. */
  needsFiles(id) {
    const s = this.sourceInfo.get(id);
    if (!s || s.files) return false;
    if (id === this.primary && [...this.telegrams.values()].some((t) => t.primary?.stamp !== s.stamp)) return true;
    return !this.meta.scans?.[this.scanKeyOf(s)];
  }

  async provideFiles(id, files) {
    const s = this.sourceInfo.get(id);
    if (!s) return;
    s.files = files;
    await this.ensureScan(s);
    this.runPrimary();
  }

  removeSource(id) {
    this.sourceInfo.delete(id);
    this.pool.removeSource(id);
    this.afterPoolChange();
  }

  async setSourceEnabled(id, enabled) {
    const s = this.sourceInfo.get(id);
    if (!s || s.enabled === enabled) return;
    s.enabled = enabled;
    if (enabled && s.parsed) this.pool.setSource(id, s.stamp, s.parsed, orderOf(id, s.kind));
    else if (enabled) { await this.addSource(s, null, s.files); return; }
    else this.pool.removeSource(id);
    this.afterPoolChange();
  }

  /** Your own lines, one file each. */
  async setMine(text) {
    const files = mineFiles(text);
    const stamp = `mine@${fnv(text || "")}`;
    if (!Object.keys(files).length) { if (this.sourceInfo.has(MINE)) this.removeSource(MINE); return; }
    await this.addSource({ id: MINE, label: "my definitions", kind: "mine", stamp, enabled: true }, parseFiles(files), null);
    // the lines are checked right away on the messages they fit, the open inspector first
    const byRow = new Map();
    for (const t of this.telegrams.values()) {
      if (!this.matchesOf(t).some((h) => this.pool.refs.get(h)?.some((r) => r.source === MINE))) continue;
      const key = this.rowKeyOf(t);
      if (!byRow.has(key)) byRow.set(key, []);
      byRow.get(key).push(t.line);
    }
    for (const [key, lines] of byRow) this.ensureDecoded(key, lines, "now");
  }

  afterPoolChange() {
    this.matchCache.clear();
    this.rebuildEntries();
    this.emit("build");
    this.runPrimary();
    this.kickJobs();
  }

  // -- scans: which file every source loads for every device ----------------------------------------------

  /** What decides a source's scan: its scan.csv and the device files it has (the same for most pull requests). */
  scanKeyOf(s) {
    const names = Object.keys(s.files || {}).filter((p) => /(^|\/)[0-9a-f]{2}\.[^/]*\.(csv|inc)$/i.test(p) || /(^|\/)scan\.csv$/.test(p)).sort();
    const scan = (s.files || {})["scan.csv"] || "";
    return s.scanKey || (s.scanKey = fnv(`${names.join("|")}|${scan}`));
  }

  async ensureScan(s) {
    if (!s.files) return;
    const key = this.scanKeyOf(s);
    if (this.meta.scans[key]) return;
    const lines = [...this.telegrams.values()].filter((t) => isScanLine(t.line)).map((t) => t.line);
    if (!lines.length) return;
    try {
      const result = await this.run({ files: s.files, filesId: `scan|${s.stamp}`, args: ["--candidates"], stdin: lines.join("\n") + "\n", worker: s.id === this.primary ? "primary" : "scan" });
      const scan = (result.results.find((r) => r.scan) || {}).scan;
      if (scan) { this.meta.scans[key] = scan; await this.saveMeta(); this.rebuildEntries(); this.emit("scan"); }
    } catch (err) { console.warn(`scan with ${s.id} failed:`, err); }
  }

  scanOf(sourceId) {
    const s = this.sourceInfo.get(sourceId);
    return (s && this.meta.scans?.[s.scanKey || this.scanKeyOf(s)]) || null;
  }

  /** Every source's scan by source id (for whyNot and the devices line). */
  get scan() {
    const out = {};
    for (const s of this.sourceInfo.values()) { const scan = this.scanOf(s.id); if (scan) out[s.id] = scan; }
    return out;
  }

  /**
   * Whether ebusd loads a file of a source for this installation: files at the root always; the device
   * file chosen by the scan for the device; and the files of a manufacturer folder without an address
   * prefix (broadcast.csv, general.csv) once a device of that manufacturer was identified.
   */
  inScanFile(sourceId, file, zz) {
    if (!file.includes("/")) return true;
    const scan = this.scanOf(sourceId) || {};
    if (file === (scan[zz]?.file || "")) return true;
    const dir = file.slice(0, file.indexOf("/")).toLowerCase();
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (/^[0-9a-f]{2}\./i.test(name)) return false;
    return Object.values(scan).some((d) => d.file && String(d.manufacturer || "").toLowerCase() === dir);
  }

  /** The device identification seen on the bus, with the file every source would load for it. */
  scanInfo(zz) {
    let ident = null;
    const files = {};
    for (const s of this.sources()) {
      const d = this.scanOf(s.id)?.[zz];
      if (!d) continue;
      ident ||= { manufacturer: d.manufacturer, ident: d.ident, sw: d.sw, hw: d.hw };
      files[s.id] = d.file || "";
    }
    return ident ? { ...ident, files } : null;
  }

  /** Every device identification seen on the bus: zz -> scanInfo. */
  devices() {
    const out = {};
    for (const s of this.sources()) for (const zz of Object.keys(this.scanOf(s.id) || {})) if (!out[zz]) out[zz] = this.scanInfo(zz);
    return out;
  }

  // -- matching: which lines could decode a telegram ------------------------------------------------------

  matchesOf(t) {
    const cached = this.matchCache.get(t.line);
    if (cached && cached.version === this.pool.version) return cached.hashes;
    const hashes = this.pool.matches(t.master, t.slave);
    this.matchCache.set(t.line, { version: this.pool.version, hashes });
    return hashes;
  }

  /** The message a telegram belongs to: destination, command and as many ID bytes as the fitting lines use (1 by default, 3 for b509, 6 for b524). */
  rowKeyOf(t) {
    const master = t.master;
    let idlen = 0;
    for (const h of this.matchesOf(t)) idlen = Math.max(idlen, this.pool.lines.get(h)?.idlen || 0);
    if (!idlen) idlen = { b509: 3, b524: 6 }[master.slice(4, 8)] ?? 1;
    return `${master.slice(2, 8)}:${master.slice(10, 10 + idlen * 2)}`;
  }

  // -- ebusd's library: the primary's full run -----------------------------------------------------------------

  /** Decode what the primary source has not decoded yet with its full tree (what ebusd understands today). */
  async runPrimary() {
    if (this.primaryRunning || !this.store) return;
    const id = this.primary;
    const s = id && this.sourceInfo.get(id);
    if (!s || !s.files) return;
    const pending = [...this.telegrams.values()].filter((t) => t.primary?.stamp !== s.stamp).sort(byFirst);
    if (!pending.length) return;
    this.primaryRunning = true;
    this.error = null;
    const scanLines = [...this.telegrams.values()].filter((t) => isScanLine(t.line)).map((t) => t.line);
    const keys = this.keysOf(id);
    try {
      await this.ensureScan(s);
      for (let i = 0; i < pending.length; i += BATCH) {
        if (this.sourceInfo.get(id)?.stamp !== s.stamp) break;   // the source changed meanwhile
        const batch = pending.slice(i, i + BATCH);
        this.progress = `decoding with ${s.label}: ${fmt.count(Math.min(i + BATCH, pending.length))} of ${fmt.count(pending.length)} telegrams`;
        this.fraction = i / pending.length;
        this.emit("progress");
        const stdin = [...scanLines, ...batch.map((t) => t.line)].join("\n") + "\n";
        const result = await this.run({ files: s.files, filesId: `full|${s.stamp}`, args: ["--candidates"], stdin, worker: "primary" });
        if (result.exitCode && !result.results.some((r) => "input" in r)) throw new Error(result.stderr[0] || `ebusd-check exited with ${result.exitCode}`);
        const put = [], tput = [], fput = [];
        for (const r of result.results) {
          if (!("input" in r)) continue;
          const t = this.telegrams.get(r.input);
          if (!t || isScanLine(r.input)) continue;
          const seen = new Map();
          for (const c of r.candidates || []) {
            const hash = keys.get(candidateKey(c));
            if (!hash || seen.has(hash)) continue;
            seen.set(hash, c);
            this.noteCandidate(hash, c, fput);
          }
          let used = null;
          for (const [hash, c] of seen) {
            if (!c.available || !this.inScanFile(id, c.file, c.zz)) continue;
            if (!used || (c.idlen || 0) > (used.c.idlen || 0)) used = { hash, c };
          }
          this.putResults(r.input, seen, put);
          t.primary = { stamp: s.stamp, hash: used?.hash || null };
          tput.push(t);
        }
        for (const t of batch) if (t.primary?.stamp !== s.stamp) { t.primary = { stamp: s.stamp, hash: null }; tput.push(t); }   // no candidate at all
        await this.persist(put, tput, fput);
        if (Date.now() - this.lastUi > 1500 || i + BATCH >= pending.length) { this.lastUi = Date.now(); this.rebuildEntries(); this.emit("decodes"); }
      }
    } catch (err) {
      console.error(err);
      this.error = `decoding failed: ${err.message}`;
    } finally {
      this.primaryRunning = false;
      this.progress = null;
      this.fraction = null;
      this.rebuildEntries();
      this.emit("decodes");
    }
  }

  /** The join between what ebusd reports for a source's full tree and the pool: "file|circuit|name|direction" -> hash. */
  keysOf(sourceId) {
    const out = new Map();
    for (const [hash, refs] of this.pool.refs) {
      const line = this.pool.lines.get(hash);
      for (const r of refs) if (r.source === sourceId) out.set(`${r.file}|${line.circuit}|${line.name}|${line.write ? "w" : ""}${line.passive ? "u" : ""}`, hash);
    }
    return out;
  }

  noteCandidate(hash, c, fput) {
    if (c.conditions?.length) this.conditionInfo.set(hash, c.conditions);
    const line = this.pool.lines.get(hash);
    if (line?.condition || c.conditions?.length) {
      const was = this.flags.get(hash);
      if (!was || was.available !== !!c.available) { this.flags.set(hash, { available: !!c.available }); fput.push({ id: hash, available: !!c.available }); }
    }
  }

  putResults(line, seen, put) {
    let map = this.results.get(line);
    if (!map) this.results.set(line, (map = new Map()));
    for (const [hash, c] of seen) map.set(hash, { result: c.result || "unknown", text: c.text || "", fields: compactFields(c.fields) });
    put.push({ line, byHash: Object.fromEntries(map) });
  }

  async persist(put, tput, fput) {
    try {
      if (put.length) await this.store.putAll("results", put);
      if (tput.length) await this.store.putAll("telegrams", tput);
      if (fput.length) await this.store.putAll("flags", fput);
    } catch (err) { console.warn("storing decodings failed:", err); }
  }

  // -- ebusd's library: one message at a time ------------------------------------------------------------------

  /** Decode a message's candidates over its telegrams (the inspector asks with "now", the list with "background"). */
  ensureDecoded(key, lines, priority = "background") {
    const stamp = `${this.poolStamp}|${lines.length}`;
    if (this.rowsDone.get(key) === stamp) return false;
    const job = this.queue.find((j) => j.key === key);
    if (job) { job.lines = lines; if (priority === "now" && job.priority !== "now") { job.priority = "now"; this.queue = [job, ...this.queue.filter((j) => j !== job)]; } }
    else if (priority === "now") this.queue.unshift({ key, lines, priority });
    else this.queue.push({ key, lines, priority });
    this.kickJobs();
    return true;
  }

  /** The rows of the list, in its order: what is not decoded yet goes to the background queue. */
  enqueueRows(rows) {
    this.queue = this.queue.filter((j) => j.priority === "now");
    for (const r of rows) this.ensureDecoded(r.key, r.lines, "background");
  }

  kickJobs() {
    if (this.jobRunning || !this.store || !this.queue.length) return;
    this.jobRunning = true;
    this.runJobs().catch((err) => console.error(err)).finally(() => { this.jobRunning = false; if (this.queue.length) this.kickJobs(); });
  }

  async runJobs() {
    while (this.queue.length) {
      const job = this.queue.shift();
      try { await this.runJob(job); } catch (err) { console.warn(`decoding ${job.key} failed:`, err); this.error = `decoding ${job.key} failed: ${err.message}`; }
    }
  }

  async runJob(job) {
    const stamp = `${this.poolStamp}|${job.lines.length}`;
    const telegrams = job.lines.map((l) => this.telegrams.get(l)).filter(Boolean).sort((a, b) => (b.last_ms || 0) - (a.last_ms || 0));
    // the pairs (telegram, line) without a result yet
    const wanted = new Set();
    const lines = [];
    for (const t of telegrams) {
      const results = this.results.get(t.line);
      const missing = this.matchesOf(t).filter((h) => { const r = results?.get(h); return !r || (r.inferred && r.inferred !== JOB_RULES); });
      if (!missing.length) continue;
      for (const h of missing) wanted.add(h);
      lines.push(t);
    }
    if (wanted.size) {
      const tree = this.pool.treeFor([...wanted]);
      const filesId = `msg|${fnv(Object.keys(tree.files).sort().join("|") + [...wanted].sort().join(","))}`;
      const scanLines = [...this.telegrams.values()].filter((t) => isScanLine(t.line)).map((t) => t.line);
      for (let i = 0; i < lines.length; i += MESSAGE_BATCH) {
        const batch = lines.slice(i, i + MESSAGE_BATCH);
        const stdin = [...scanLines, ...batch.map((t) => t.line)].join("\n") + "\n";
        const result = await this.run({ files: tree.files, filesId, args: ["--candidates"], stdin, worker: "jobs" });
        this.noteLoadErrors(result.stderr, tree);
        const put = [], fput = [];
        for (const r of result.results) {
          if (!("input" in r) || isScanLine(r.input)) continue;
          const t = this.telegrams.get(r.input);
          if (!t) continue;
          const seen = new Map();
          for (const c of r.candidates || []) {
            const hash = tree.keys.get(candidateKey(c));
            if (!hash || seen.has(hash)) continue;
            seen.set(hash, c);
            this.noteCandidate(hash, c, fput);
          }
          // a line that fits by the pool's reckoning but ebusd did not list: it does not decode this telegram
          for (const h of this.matchesOf(t)) if (wanted.has(h) && !seen.has(h)) { const r = this.results.get(t.line)?.get(h); if (!r || r.inferred) seen.set(h, { result: this.lineErrors.has(h) ? "rejected" : "no match", text: "", fields: null, inferred: JOB_RULES }); }
          this.putResults(r.input, seen, put);
        }
        await this.persist(put, [], fput);
        if (i + MESSAGE_BATCH < lines.length) this.emit("decodes");
      }
    }
    this.rowsDone.set(job.key, stamp);
    this.store.putAll("rows", [{ key: job.key, stamp }]).catch(() => {});
    if (this.lineErrors.size) this.saveMeta();
    this.rebuildEntriesSoon();
    this.emit("decodes");
  }

  /** ebusd's library refused a file of a tree: which lines of your own (or of a source) it was, and why. */
  noteLoadErrors(stderr, tree) {
    for (const text of stderr || []) {
      const m = /^(?:\[main error\] error reading file )?([^:\s]+\.csv):(\d+): (.*)$/.exec(text) || /([^:\s]+\.csv):(\d+): (ERR: .*)$/.exec(text);
      if (!m) continue;
      const [, file, lineNo, message] = m;
      const content = tree.files[file];
      if (!content) continue;
      const line = content.split("\n")[Number(lineNo) - 1]?.trim();
      if (!line) continue;
      for (const [key, hash] of tree.keys) if (key.startsWith(`${file}|`) && this.pool.lines.get(hash)?.csv === line) this.lineErrors.set(hash, message.replace(/^ERR: /, ""));
    }
  }

  // -- the definitions with their statistics ---------------------------------------------------------------------

  rebuildEntriesSoon() { clearTimeout(this.entriesTimer); this.entriesTimer = setTimeout(() => { this.rebuildEntries(); this.emit("decodes"); }, 400); }

  /** A definition as the views see it: the pool line with where it comes from and how it fares on the recording. */
  makeDef(hash) {
    const l = this.pool.lines.get(hash);
    if (!l) return null;
    const refs = this.pool.refs.get(hash) || [];
    const ref = this.pool.preferredRef(hash) || { source: "?", file: "" };
    const sources = [...new Set(refs.map((r) => r.source))];
    return {
      key: hash, hash, csv: l.csv, circuit: l.circuit, name: l.name, comment: l.comment, zz: l.zz, qq: l.qq, pbsb: l.pbsb, id: l.id, idlen: l.idlen, write: l.write, passive: l.passive,
      condition: l.condition, conditions: this.conditionInfo.get(hash) || [], source: ref.source, sourceLabel: this.sourceInfo.get(ref.source)?.label || ref.source, file: ref.file, refs, sources,
      mine: sources.includes(MINE), fields: l.fields.map((f) => f.name), siblings: [], companionOf: [], companion: false, available: this.flags.get(hash)?.available ?? !l.condition,
      loadedIn: sources.filter((id) => refs.some((r) => r.source === id && this.inScanFile(id, r.file, l.zz))), error: this.lineErrors.get(hash) || null,
      distinct: 0, occurrences: 0, ok: 0, errors: 0, pending: 0, used: 0, examples: [], first_ms: null, last_ms: null,
    };
  }

  rebuildEntries() {
    const defs = new Map();
    const get = (hash) => { let d = defs.get(hash); if (!d) { d = this.makeDef(hash); if (d) defs.set(hash, d); } return d; };
    for (const t of this.telegrams.values()) {
      const results = this.results.get(t.line);
      for (const hash of this.matchesOf(t)) {
        const def = get(hash);
        if (!def) continue;
        def.distinct++;
        def.occurrences += t.n || 0;
        const r = results?.get(hash);
        if (!r) def.pending++; else if (r.result === "ok") { def.ok++; if (def.examples.length < 3 && r.text && !def.examples.includes(r.text)) def.examples.push(r.text); } else def.errors++;
        if (t.primary?.hash === hash) def.used++;
        if (t.first_ms !== null && t.first_ms !== undefined) def.first_ms = def.first_ms === null ? t.first_ms : Math.min(def.first_ms, t.first_ms);
        if (t.last_ms) def.last_ms = def.last_ms === null ? t.last_ms : Math.max(def.last_ms, t.last_ms);
      }
    }
    // counterparts: the other direction of a seen definition in the same source (usually the write), not seen on the bus
    const byName = new Map();
    for (const [hash, l] of this.pool.lines) { const k = `${l.zz}|${l.circuit}|${l.name}`; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(hash); }
    for (const def of [...defs.values()]) {
      for (const other of byName.get(`${def.zz}|${def.circuit}|${def.name}`) || []) {
        if (other === def.key) continue;
        const o = this.pool.lines.get(other);
        if (o.write === def.write && o.passive === def.passive) continue;
        if (!def.siblings.includes(other)) def.siblings.push(other);
        let sib = defs.get(other);
        if (!sib) { sib = this.makeDef(other); if (!sib) continue; sib.companion = true; defs.set(other, sib); }
        if (!sib.companionOf.includes(def.key)) sib.companionOf.push(def.key);
      }
    }
    const primary = this.primary;
    for (const def of defs.values()) {
      if (def.companion) { def.status = "companion"; continue; }
      def.status = def.mine ? "custom" : def.used > 0 ? "active" : def.pending && !def.ok && !def.errors ? "pending" : def.ok === 0 ? "error" : !def.available ? "conditional" : !def.loadedIn.length ? "variant" : "hidden";
      def.primary = def.sources.includes(primary);
    }
    const order = Object.fromEntries(this.sources().map((s, i) => [s.id, i]));
    this.defs = defs;
    this.entries = [...defs.values()].sort((a, b) => a.zz.localeCompare(b.zz) || a.circuit.localeCompare(b.circuit) || a.name.localeCompare(b.name) || (order[a.source] ?? 99) - (order[b.source] ?? 99));
  }

  def(hash) { return this.defs.get(hash) || this.makeDef(hash); }

  /** What a telegram decodes to with every fitting line: Map(hash -> {result, text, fields, used, available}); lines not decoded yet are absent. */
  decodesOf(line) {
    const t = this.telegrams.get(line);
    const results = this.results.get(line);
    if (!t || !results) return undefined;
    const out = new Map();
    for (const [hash, r] of results) {
      if (!this.pool.lines.has(hash)) continue;
      out.set(hash, { ...r, defKey: hash, used: t.primary?.hash === hash, available: this.flags.get(hash)?.available ?? true });
    }
    return out;
  }

  /** The decoding ebusd itself would use for a telegram (the primary's choice), or null. */
  usedDecode(line) {
    const t = this.telegrams.get(line);
    const hash = t?.primary?.hash;
    if (!hash) return null;
    const r = this.results.get(line)?.get(hash);
    return r ? { ...r, defKey: hash, used: true } : null;
  }

  /**
   * The candidate lines of a message's telegrams with how they fared: Map(hash -> {def, ok, errors, pending, used, usedIn, last}).
   * usedIn counts the sources that would use the line (a file ebusd loads for the device, condition met).
   */
  candidatesOf(lines) {
    const out = new Map();
    for (const line of lines) {
      const t = this.telegrams.get(line);
      if (!t) continue;
      const results = this.results.get(line);
      for (const hash of this.matchesOf(t)) {
        let c = out.get(hash);
        if (!c) { const def = this.def(hash); if (!def) continue; out.set(hash, (c = { def, ok: 0, errors: 0, pending: 0, used: 0, usedIn: def.available ? def.loadedIn.length : 0, last: null })); }
        const r = results?.get(hash);
        if (!r) c.pending++; else { if (r.result === "ok") c.ok++; else c.errors++; c.last = { ...r, defKey: hash, used: t.primary?.hash === hash }; }
        if (t.primary?.hash === hash) c.used++;
      }
    }
    return out;
  }

  /** Your own lines for a message by destination, command and ID alone: the ones whose field lengths do not add up to the telegrams still show, with the reason. */
  ownLinesFor(row) {
    const out = [];
    for (const [hash, l] of this.pool.lines) {
      if (!this.pool.refs.get(hash)?.some((r) => r.source === MINE)) continue;
      if (l.pbsb !== row.pbsb || (l.zz && l.zz !== row.zz) || !(row.id.startsWith(l.id) || l.id.startsWith(row.id))) continue;
      out.push(hash);
    }
    return out;
  }

  /** Whether a message is decoded with the pool as it is. */
  isDecoded(key, lines) { return this.rowsDone.get(key) === `${this.poolStamp}|${lines.length}`; }

  /** A summary for the UI. */
  status() {
    let known = 0, decoded = 0;
    const primary = this.primary;
    const stamp = primary ? this.sourceInfo.get(primary)?.stamp : null;
    for (const t of this.telegrams.values()) {
      if (t.primary?.stamp === stamp) { decoded++; if (t.primary.hash) known++; }
    }
    const perSource = this.sources().map((s) => ({ id: s.id, label: s.label, kind: s.kind, enabled: s.enabled, error: s.error, definitions: this.entries.filter((d) => d.sources.includes(s.id) && !d.companion).length, pending: s.id === primary ? this.telegrams.size - decoded : 0 }));
    return {
      store: this.store?.kind || "none", telegrams: this.telegrams.size, decoded, known, definitions: this.entries.filter((d) => !d.companion).length,
      active: this.entries.filter((e) => e.status === "active").length, primary, sources: perSource, queue: this.queue.length, jobRunning: this.jobRunning,
      syncing: this.syncing, loading: this.loading, progress: this.progress, fraction: this.fraction, lastSync: this.meta.lastSync, error: this.error,
      build: this.sourceInfo.size ? { id: this.poolStamp, sources: perSource } : null,
    };
  }

  // -- running ebusd-check ----------------------------------------------------------------------------------------

  async run({ files, filesId, args, stdin, worker: workerName = "jobs" }) {
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

  ensureWorker(name) {
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

  /** Forget the browser-side copy of the recording and its decodings (the sources stay; the recording is read again). */
  async reset() {
    for (const name of ["telegrams", "results", "rows", "flags", "meta"]) await this.store.clear(name);
    this.telegrams.clear(); this.results.clear(); this.rowsDone.clear(); this.flags.clear(); this.matchCache.clear();
    this.meta = { key: "current", source: this.meta.source, lastSync: null, scans: {} };
    for (const s of this.sourceInfo.values()) s.scanKey = null;
    this.rebuildEntries();
    this.emit("reset");
    this.sync();
  }

  /** Decode everything again with the sources as they are (the pool stays). */
  async decodeAgain() {
    for (const name of ["results", "rows", "flags"]) await this.store.clear(name);
    this.results.clear(); this.rowsDone.clear(); this.flags.clear(); this.lineErrors.clear();
    for (const t of this.telegrams.values()) t.primary = null;
    this.rebuildEntries();
    this.emit("reset");
    this.runPrimary();
  }
}
