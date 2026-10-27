// Timeline of recorded telegrams and Home Assistant events.
//
// Telegrams are grouped into rows (source, destination, command and message ID) and shown as
// runs: a bar spans the time a value stayed the same, labelled with the value, the number of
// repetitions and the typical interval. Entity state changes are rows of the same kind, manual
// markers are vertical lines. Wheel zooms, dragging pans, clicking a run shows the telegrams.
//
// The decodings of the browser store are part of the picture: a row is named after the
// definition that decodes it and its bars show the decoded values. Where several definitions fit
// (other sources, other device variants, unmet conditions), a badge says so; a click on a row
// selects it for the scratchpad below, which compares the candidates and lets you pick and tune
// one. Hovering a candidate there previews its decoding in the row.
import { api, app, append, bus, fmt, h, toast } from "./app.js";
import { hashColor, idLength, messageColors, valueColors } from "./colors.js";
import { lineOfRun } from "./decoder.js";
import { setup } from "./setup.js";
import { PRESETS as LOG_PRESETS, durationText, eventRange, fromMs, logCommand, timeText, toMs } from "./log.js";
import { seriesQuery } from "./chart.js";
import { structureOf } from "./compare.js";
import { SettingsView } from "./settings.js";

const ROW = 24;
const LABEL_MARGIN = 30;                               // rows beyond the view that have a label in the DOM
const MIXED_COLORS = { fill: "#e8eaf6", stroke: "#7986cb" };   // a run of steps with several values (summed-up windows)
const GROUP_MIN = 6;                                   // rows of one command from which a header offers to collapse them
const DEFAULT_ID_OVERRIDES = { b509: 3, b524: 6 };      // as in the backend's settings: commands whose message ID is longer than the default
const STATUS_ORDER = { active: 0, custom: 1, hidden: 2, conditional: 3, variant: 4, error: 5, companion: 6 };
const STATUS_HELP = {
  active: "ebusd uses this definition for this installation (file chosen by the scan, condition met)",
  variant: "from a file of another device variant: ebusd would not load it, but it decodes these telegrams",
  conditional: "its condition was not met by the recorded telegrams, but it decodes them",
  hidden: "in the file ebusd loads, but another definition takes precedence",
  error: "matches the telegram but cannot decode it (wrong length or values)",
  companion: "not seen on the bus: the counterpart of a seen definition (usually for writing)",
  custom: "your own definition: decoded over the whole recording, never chosen automatically",
};
const MIN_SPAN = 10_000;
const MAX_SPAN = 31 * 86400_000;
const EVENT_LOOKBACK = 7 * 86400_000;
const PRESETS = [["15 min", 15 * 60e3], ["1 h", 3600e3], ["6 h", 6 * 3600e3], ["24 h", 86400e3], ["3 d", 3 * 86400e3], ["10 d", 10 * 86400e3]];
const TICK_STEPS = [1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3,
  3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 2 * 86400e3, 7 * 86400e3, 14 * 86400e3];

export class Timeline {
  constructor(root) {
    this.root = root;
    this.now = Date.now();
    this.span = 3600e3;
    this.t1 = this.now;
    this.t0 = this.t1 - this.span;
    this.follow = true;
    this.data = null;
    this.states = [];
    this.markers = [];
    this.idLengths = null;
    this.histogram = null;
    this.rows = [];
    this.markers = [];
    this.filter = "";
    this.onlyChanges = false;
    this.sort = "address";
    this.hover = null;
    this.selected = null;
    this.preview = null;        // {rowKey, defKey} while hovering a candidate: the row shows its decoding
    this.expanded = new Set();  // keys of the rows shown as one row per field of their definition
    this.remembered = null;     // the time range whose runs were stored as occurrences
    this.loadToken = 0;
    this.loading = null;        // {from, to} while the runs of a window are being fetched
    this.seriesCache = new Map();    // value history of a row over the whole recording (detail panel history)
    this.seriesLoading = new Map();
    this.firstLoad = new Promise((resolve) => { this.markFirstLoad = resolve; });
    this.build();
    bus.on("decodes-changed", (reason) => { this.onDecodes(reason); });
    bus.on("goto-time", (ms) => { this.setFollowSilently(false); this.setWindow(ms - this.span / 2, ms + this.span / 2); });
    bus.on("setup-changed", () => { this.buildRows(); this.render(); });
    bus.on("compile-state", (state) => { this.compileState = state; this.updateDecodeState(); });
    bus.on("settings-changed", () => { this.syncSettings(); this.load(true); });
    bus.on("status", () => this.updateInfo());
    window.addEventListener("resize", () => this.render());
    document.addEventListener("keydown", (e) => this.onKey(e));
    this.syncSettings();
    if (this.visible()) { this.load(true); this.loadHistogram(); }
    setInterval(() => { if (this.follow && !this.loading && document.visibilityState === "visible" && this.visible() && Date.now() - (this.fetchedAt || 0) > Math.max(5000, (this.fetchMs || 0) * 4)) this.load(); }, 1000);
    setInterval(() => this.loadHistogram(), 60_000);
  }

  onShow() { this.render(); if (!this.data) this.load(true); }

  /** Whether the timeline is the view of the bus that is shown (otherwise it neither loads nor draws). */
  visible() { return this.root.clientWidth > 0 && this.root.style.display !== "none"; }

  toggleSettings(open = this.el.settingsPanel.style.display === "none") {
    const panel = this.el.settingsPanel;
    panel.style.display = open ? "" : "none";
    this.el.settingsButton.classList.toggle("active", open);
    if (open && !this.settingsView) this.settingsView = new SettingsView(panel, { info: false });
    else if (open) this.settingsView.render();
  }

  // -- DOM --------------------------------------------------------------------------

  build() {
    const el = (this.el = {});
    el.presets = h("span", { class: "seg group" }, PRESETS.map(([label, span]) => h("button", { onclick: () => this.setSpan(span) }, label)));
    el.follow = h("button", { class: "active", title: "Keep the right edge at the current time (N)", onclick: () => this.setFollow(!this.follow) }, "● live");
    el.idBytes = h("select", { title: "Number of data bytes after PBSB that identify a message (the rest is the value)", onchange: () => this.changeIdBytes() },
      [0, 1, 2, 3, 4].map((n) => h("option", { value: n }, `${n}`)));
    el.filter = h("input", { type: "search", placeholder: "filter: address, command, name…", size: 24, oninput: () => { this.filter = el.filter.value.trim().toLowerCase(); this.buildRows(); this.render(); } });
    el.onlyChanges = h("input", { type: "checkbox", onchange: () => { this.onlyChanges = el.onlyChanges.checked; this.buildRows(); this.render(); } });
    el.sort = h("select", { onchange: () => { this.sort = el.sort.value; this.buildRows(); this.render(); } },
      h("option", { value: "address" }, "by address"), h("option", { value: "name" }, "by name"), h("option", { value: "activity" }, "most telegrams"), h("option", { value: "changes" }, "most changes"), h("option", { value: "candidates" }, "most candidates"));
    el.applyIds = h("button", { class: "small", style: "display:none", title: "split and combine rows so that every message the definitions know is one row (only the telegrams of known messages change)", onclick: () => this.applyIdLengths() }, "rows like the definitions");
    el.info = h("span", { class: "hint" });
    el.help = h("span", { class: "help", title: "Scroll: the rows\nCtrl/⌘ + scroll or pinch: zoom the time axis\nShift + scroll or sideways swipe: move in time\nDrag the chart: move in time; double click: zoom in\nOverview strip: drag the edges to resize the window, drag inside to move it, drag outside to select a new one\nKeys: ← → move, + − zoom, N live, Esc close" }, "?");
    el.notice = h("div", { class: "tl-notice", style: "display:none" });
    el.logButton = h("button", { title: "note what you did or saw, like the log command of the eBUSd terminal: it appears as a flag in the events lane", onclick: () => this.toggleLog() }, "＋ event");
    el.logPop = h("div", { class: "tl-log", style: "display:none" });
    el.settingsButton = h("button", { class: "small", title: "the Home Assistant entities shown in the events lane, and how telegrams are grouped into rows", onclick: () => this.toggleSettings() }, "⚙ events and grouping");
    el.settingsPanel = h("div", { class: "tl-settings", style: "display:none" });
    el.toolbar = h("div", { class: "toolbar" },
      el.presets,
      h("span", { class: "group" }, h("button", { title: "zoom out (-)", onclick: () => this.zoom(2) }, "−"), h("button", { title: "zoom in (+)", onclick: () => this.zoom(0.5) }, "+"), el.follow),
      h("span", { class: "group" }, h("label", {}, "ID bytes"), el.idBytes, el.applyIds),
      h("span", { class: "group" }, el.filter),
      h("label", { class: "group" }, el.onlyChanges, " only changed"),
      h("span", { class: "group" }, el.sort),
      h("span", { class: "group" }, el.logButton, el.settingsButton),
      h("span", { class: "group", style: "margin-left:auto" }, el.help),
      el.info);
    el.overviewCanvas = h("canvas");
    el.overview = h("div", { class: "tl-overview", title: "all recorded telegrams; click or drag to move the window" }, el.overviewCanvas);
    el.corner = h("div", { class: "corner" });
    el.axisCanvas = h("canvas");
    el.axis = h("div", { class: "tl-axis" }, el.corner, el.axisCanvas);
    el.annotCanvas = h("canvas");
    el.annot = h("div", { class: "tl-annot", title: "Home Assistant state changes and notes: hover for details, click an entity's flag for its history" }, h("div", { class: "corner" }, "events"), el.annotCanvas);
    el.labels = h("div", { class: "tl-labels" });
    el.plotCanvas = h("canvas", { class: "tl-canvas" });   // only the rows in view (and a margin) are drawn, see drawPlot
    el.plot = h("div", { class: "tl-plot" }, el.plotCanvas);
    el.body = h("div", { class: "tl-body" }, h("div", { class: "tl-rows" }, el.labels, el.plot));
    el.stage = h("div", { class: "tl-stage" }, el.body, el.notice);
    el.tooltip = h("div", { class: "tl-tooltip" });
    this.root.appendChild(h("div", { class: "tl" }, el.toolbar, el.logPop, el.settingsPanel, el.overview, el.axis, el.annot, el.stage, el.tooltip));
    this.bindMouse();
    el.body.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.updateDecodeState();
  }

  // -- decodings from the browser store ------------------------------------------------------

  onDecodes(reason) {
    // the suggestion is computed from a finished decoding only: while it runs, the notice and the button keep their last state
    if (reason !== "progress" && app.decoder && !app.decoder.decoding && !app.decoder.syncing) this.pendingRules = app.decoder.idRules(this.settings || app.settings);
    this.updateIdButton();
    this.updateDecodeState();
    if (reason === "progress") return;
    this.buildRows();
    this.render();
  }

  /** The notice above the rows follows the state of the sources and the decoder; the activity itself is in the top bar. */
  updateDecodeState() {
    this.updateNotice(app.decoder?.status());
    bus.emit("activity");
  }

  /** Whether a condition has held for ms: short gaps between steps (compile done, decoding not started) must not flash a notice. */
  persistsFor(name, ms) {
    this.since ||= {};
    this.since[name] ||= Date.now();
    if (Date.now() - this.since[name] >= ms) return true;
    clearTimeout(this.sinceTimer);
    this.sinceTimer = setTimeout(() => this.updateNotice(app.decoder?.status()), ms + 50);
    return false;
  }

  /** A notice above the rows while there is nothing to decode with: offers the way to get definitions right there. */
  updateNotice(st) {
    const el = this.el.notice;
    const sources = app.status?.sources?.sources || [];
    const enabled = sources.filter((s) => s.enabled);
    const fetching = enabled.filter((s) => s.state === "fetching");
    const failed = enabled.filter((s) => s.state === "error");
    let key = null, build = null;
    const pending = this.pendingIdLengths().length;
    if (!app.status) key = null;
    else if (!sources.length) {
      key = "none";
      build = () => [h("span", {}, "No definitions yet: nothing decodes the telegrams, rows show raw hex."),
        h("button", { class: "small primary", onclick: async () => { await app.views.sources?.add("release"); await app.views.sources?.add("next"); } }, "Load ebusd's definitions"),
        h("span", { class: "muted" }, "(what the eBUSd app uses, and the upcoming release)")];
    } else if (fetching.length && !st?.build) {
      key = `busy:${fetching.map((s) => s.id).join(",")}`;
      build = () => [h("span", { class: "spinner" }), h("span", {}, `Fetching ${fetching.map((s) => s.label).join(", ")}… until the definitions are there nothing decodes the telegrams: rows show raw hex.`)];
    } else if (!st?.build && this.compileState?.error) {
      key = `error:${this.compileState.error}`;
      build = () => [h("span", { class: "err" }, `Building the definitions failed: ${this.compileState.error}`)];
    } else if (enabled.length && failed.length === enabled.length) {
      key = `failed:${failed.map((s) => s.error).join(";")}`;
      build = () => [h("span", { class: "err" }, `Fetching the definitions failed: ${failed.map((s) => `${s.label}: ${s.error}`).join("; ")}`), h("button", { class: "small", onclick: () => app.views.sources?.refresh(failed[0].id) }, "try again")];
    } else if (pending && !this.dismissedIds) {
      key = "ids";   // not the count: it must not rebuild the notice
      build = () => [h("span", {}, `${this.pendingIdLengths().length} messages are grouped differently than the definitions identify them: different messages (registers) share a row and show up as many "candidates", or one message is spread over several rows.`),
        h("button", { class: "small primary", onclick: () => this.applyIdLengths() }, "Group like the definitions"),
        h("button", { class: "small", title: "hide this notice (the button in the toolbar stays)", onclick: () => { this.dismissedIds = true; this.noticeKey = undefined; this.updateNotice(app.decoder?.status()); } }, "dismiss")];
    }
    el.style.display = key ? "" : "none";
    if (key !== this.noticeKey) { this.noticeKey = key; el.replaceChildren(); if (build) append(el, build()); }
    else if (key === "ids") { const n = el.querySelector("span"); if (n) n.textContent = `${this.pendingIdLengths().length} messages are grouped differently than the definitions identify them: different messages (registers) share a row and show up as many "candidates", or one message is spread over several rows.`; }
  }

  syncSettings() {
    this.settings = app.settings || { id_bytes: 1, id_overrides: {} };
    this.el.idBytes.value = String(this.settings.id_bytes ?? 1);
    const overrides = Object.entries(this.settings.id_overrides || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
    this.el.idBytes.title = `Data bytes after PBSB that identify a message (the rest is the value)${overrides ? `; overrides: ${overrides}` : ""}`;
  }

  updateIdButton() {
    const n = this.pendingRules?.size || 0;
    this.el.applyIds.style.display = n ? "" : "none";
    this.el.applyIds.textContent = `rows like the definitions (${n})`;
  }

  /** The rules (zzpbsb:prefix -> ID length) that make rows follow the definitions, not yet in the settings. */
  pendingIdLengths() { return [...(this.pendingRules || new Map()).entries()]; }

  /** Store prefix rules: they change the grouping of only the telegrams that start with the prefix. */
  async saveRules(mutate) {
    const rules = { ...(this.settings.id_rules || {}) };
    mutate(rules);
    await this.saveGrouping({ id_rules: rules });   // the row is split or combined: the rows it was made of are new
  }

  async applyIdLengths() {
    const pending = this.pendingIdLengths();
    await this.saveRules((rules) => { for (const [key, length] of pending) rules[key] = length; });
    toast(`${pending.length} message${pending.length === 1 ? "" : "s"} grouped like the definitions`);
  }

  /** Pivot: split a row at its next byte (+), or combine it with the rows that share all but its last byte (−). */
  splitRow(row) {
    const command = `${fmt.hex(row.row.zz)}${fmt.hex(row.row.pb)}${fmt.hex(row.row.sb)}`;
    return this.saveRules((rules) => { rules[`${command}:${row.row.id}`] = row.row.id.length / 2 + 1; });
  }

  combineRow(row) {
    const command = `${fmt.hex(row.row.zz)}${fmt.hex(row.row.pb)}${fmt.hex(row.row.sb)}`;
    const parent = row.row.id.slice(0, -2);
    return this.saveRules((rules) => {
      for (const key of Object.keys(rules)) if (key.startsWith(`${command}:${parent}`)) delete rules[key];   // the rules below the merged row
      rules[`${command}:${parent}`] = parent.length / 2;
    });
  }

  /** Group the rows of the telegrams of a picker row like the definitions that decode them. */
  splitLikeDefinitions(telegrams) {
    const rules = app.decoder.idRulesFor(telegrams, this.settings);
    return this.saveRules((current) => { for (const [key, length] of rules) current[key] = length; });
  }

  async changeIdBytes() {
    try {
      app.settings = await api.put("api/settings", { id_bytes: Number(this.el.idBytes.value) });
      this.syncSettings();
      this.load(true);
    } catch (err) { toast(err.message, "err"); }
  }

  updateInfo() {
    const parts = [];
    if (this.data) {
      parts.push(`${fmt.count(this.data.scanned)} telegrams in ${this.rows.filter((r) => r.kind === "telegram").length} rows`);
      if (this.data.bucket_ms) parts.push(`summed up in ${fmt.duration(this.data.bucket_ms)} steps, zoom in for every value`);
    }
    this.el.info.textContent = parts.join(" · ");
    this.el.corner.textContent = `${fmt.dateTime(this.t0)} – ${fmt.time(this.t1)} (${fmt.duration(this.span)})`;
  }

  // -- window ------------------------------------------------------------------------

  setSpan(span) {
    const center = this.follow ? null : (this.t0 + this.t1) / 2;
    this.span = Math.max(MIN_SPAN, Math.min(MAX_SPAN, span));
    if (center === null) { this.t1 = Date.now(); this.t0 = this.t1 - this.span; } else { this.t0 = center - this.span / 2; this.t1 = center + this.span / 2; }
    this.load(true);
  }

  setFollow(on) {
    this.follow = on;
    this.el.follow.classList.toggle("active", on);
    if (on) { this.t1 = Date.now(); this.t0 = this.t1 - this.span; this.load(true); }
  }

  setWindow(t0, t1, reload = true) {
    const span = Math.max(MIN_SPAN, Math.min(MAX_SPAN, t1 - t0));
    this.t0 = t0; this.t1 = t0 + span; this.span = span;
    if (this.t1 < Date.now() - 2000) this.setFollowSilently(false);
    if (reload === "soon") this.load(false); else if (reload) this.load(true); else this.render();
  }

  setFollowSilently(on) { this.follow = on; this.el.follow.classList.toggle("active", on); }

  /** @param {boolean|string} reload true: fetch right away, "soon": after the gesture settled (wheel, pinch) */
  zoom(factor, at = null, reload = true) {
    const pivot = at ?? (this.follow ? this.t1 : (this.t0 + this.t1) / 2);
    let t0 = pivot - (pivot - this.t0) * factor;
    let t1 = pivot + (this.t1 - pivot) * factor;
    if (this.follow) { t1 = Date.now(); t0 = t1 - (this.span * factor); }
    this.setWindow(t0, t1, reload);
  }

  pan(fraction, reload = true) {
    const delta = this.span * fraction;
    this.setWindow(this.t0 + delta, this.t1 + delta, reload);
  }

  // -- data --------------------------------------------------------------------------

  load(immediate = false) {
    clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => this.fetch(), immediate ? 0 : 250);
    this.updateInfo();
    this.render();
  }

  async fetch() {
    if (this.follow) { this.now = Date.now(); this.t1 = this.now; this.t0 = this.t1 - this.span; }
    const token = ++this.loadToken;
    const started = Date.now();
    const from = Math.floor(this.t0), to = Math.ceil(this.t1);
    // a newer window makes the older request pointless: abort it so that the device stops working on it
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.loading = { from, to };
    this.updateDecodeState();
    try {
      const [runs, events] = await Promise.all([
        api.get(`api/telegrams/runs?from=${from}&to=${to}&buckets=${Math.max(300, Math.min(3000, Math.round(this.width || 1200)))}`, { signal: abort.signal }),
        api.get(`api/events?from=${from - EVENT_LOOKBACK}&to=${to}`, { signal: abort.signal }),
      ]);
      if (token !== this.loadToken) return;
      this.fetchedAt = Date.now();
      this.fetchMs = this.fetchedAt - started;   // heavy windows are not read every few seconds
      this.data = runs;
      this.states = events.states;
      this.markers = events.markers;
      this.buildRows();
      this.updateInfo();
      this.render();
      this.rememberRuns();
    } catch (err) {
      if (err.name !== "AbortError" && token === this.loadToken) toast(`loading telegrams failed: ${err.message}`, "err");
    } finally {
      if (token === this.loadToken) { this.loading = null; this.updateDecodeState(); this.markFirstLoad(); }
    }
  }

  async loadHistogram() {
    try {
      const status = app.status;
      const first = status?.db?.first_ms || (Date.now() - 86400e3);
      const to = Date.now();
      const bucket = Math.max(60, Math.ceil((to - first) / 1000 / 240));
      this.histogram = await api.get(`api/telegrams/histogram?from=${first}&to=${to}&bucket=${bucket}`);
      this.drawOverview();
    } catch (err) { console.warn(err); }
  }

  /** Store the fetched runs as occurrences (pointers to their telegram) for the parts of the time range not stored yet. */
  rememberRuns() {
    if (!app.decoder?.store || this.data?.bucket_ms) return;   // the runs of a summed-up window are not the telegrams
    const from = this.data?.from_ms ?? this.t0, to = this.data?.to_ms ?? this.t1;
    const r = this.remembered;
    const fresh = this.rows.filter((row) => row.kind === "telegram").map((row) => ({ runs: row.runs.filter((run) => !r || run.t0 < r.t0 || run.t1 > r.t1) }));
    if (!fresh.some((row) => row.runs.length)) return;
    app.decoder.rememberRuns(fresh);
    this.remembered = r && r.t1 >= from && r.t0 <= to ? { t0: Math.min(r.t0, from), t1: Math.max(r.t1, to) } : { t0: from, t1: to };
  }

  buildRows() {
    const rows = [];   // Home Assistant entities are annotations (see annotations()), not rows
    const decoder = app.decoder;
    this.includedKeys = new Set(setup.includedKeys(decoder?.entries || []));
    const telegramRows = [];
    for (const row of this.data?.rows || []) {
      const key = `${fmt.hex(row.qq)}→${fmt.hex(row.zz)} ${fmt.hex(row.pb)}${fmt.hex(row.sb)} ${row.id}`;
      const runs = row.runs.map((r) => {
        const [payload, slave, status] = r[3].split("/");
        const mixed = r[6] || 0;   // a summed-up window: this run is steps with several values (the value is the latest)
        const label = mixed ? `${mixed}+ different values` : payload && slave ? `${payload} / ${slave}` : payload || slave || (status === "ok" ? "(no data)" : status);
        const run = { t0: r[0], t1: r[1], n: r[2], value: r[3], payload, slave, status, mean: r[4], min: r[5], label, mixed, line: null };
        run.line = lineOfRun(row, run);
        return run;
      });
      // the definitions that decode this row, and the one it is shown with
      const candidates = decoder ? decoder.candidatesOf(runs.map((r) => r.line)) : new Map();
      const defKey = this.rowDefinition(key, candidates);
      const def = defKey ? decoder.def(defKey) : null;
      const name = def ? `${setup.circuitOf(def)} ${setup.exportName(def)}` : "";
      const candidateNames = [...candidates.values()].map((c) => `${c.def.circuit} ${c.def.name} ${setup.exportName(c.def)}`).join(" ");
      if (!this.matches(key, `${name} ${def ? `${def.circuit} ${def.name}` : ""} ${candidateNames}`)) continue;
      if (this.onlyChanges && runs.length < 2) continue;
      telegramRows.push({ kind: "telegram", key, label: key, name, def, defKey, candidates, n: row.n, runs, row });
    }
    const sorters = {
      address: (a, b) => a.row.zz - b.row.zz || a.row.pb - b.row.pb || a.row.sb - b.row.sb || a.row.id.localeCompare(b.row.id) || a.row.qq - b.row.qq,
      activity: (a, b) => b.n - a.n,
      changes: (a, b) => b.runs.length - a.runs.length || b.n - a.n,
      name: (a, b) => (a.name || "~").localeCompare(b.name || "~") || a.row.zz - b.row.zz,
      candidates: (a, b) => b.candidates.size - a.candidates.size || b.n - a.n,
    };
    telegramRows.sort(sorters[this.sort] || sorters.address);
    for (let i = 0; i < telegramRows.length; i++) {
      const row = telegramRows[i];
      if (!this.expanded.has(row.key)) continue;
      const fieldRows = this.fieldRows(row);
      telegramRows.splice(i + 1, 0, ...fieldRows);
      i += fieldRows.length;
    }
    this.rows = rows.concat(this.sort === "address" ? this.withGroupHeaders(telegramRows) : telegramRows);
    if (this.selected) {
      const same = this.rows.find((r) => r.key === this.selected.row.key);
      if (same) this.selected.row = same;   // otherwise the row left the window: the scratchpad keeps it
    }
    this.renderLabels();
    bus.emit("rows-built", this.rows);
  }

  /** Rows of one command that only differ in the message ID (b524 registers) get a header that can collapse them into one row. */
  withGroupHeaders(rows) {
    const command = (r) => `${r.row.zz}.${r.row.pb}.${r.row.sb}`;
    const totals = new Map();
    for (const r of rows) {
      if (r.kind !== "telegram" || !r.row.id) continue;
      const t = totals.get(command(r)) || { rows: 0, n: 0 };
      t.rows++; t.n += r.n;
      totals.set(command(r), t);
    }
    const out = [];
    let last = null;
    for (const r of rows) {
      if (r.kind === "telegram") {
        const total = totals.get(command(r));
        if (total && total.rows >= GROUP_MIN && command(r) !== last) {
          const pbsb = `${fmt.hex(r.row.pb)}${fmt.hex(r.row.sb)}`;
          out.push({ kind: "group", key: `group|${command(r)}`, label: `→${fmt.hex(r.row.zz)} ${pbsb}`, pbsb, zz: fmt.hex(r.row.zz), rows: total.rows, n: total.n, runs: [], candidates: new Map() });
        }
        last = command(r);
      }
      out.push(r);
    }
    return out;
  }

  /** Put all telegrams of a command (b524) into one row per source and destination: the ID is not part of the row any more. */
  async collapseCommand(pbsb) {
    const overrides = { ...(this.settings.id_overrides || {}) };
    const rules = { ...(this.settings.id_rules || {}) };
    for (const key of Object.keys(overrides)) if (key.length === 6 && key.slice(2) === pbsb) delete overrides[key];
    for (const key of Object.keys(rules)) if (key.slice(2, 6) === pbsb) delete rules[key];
    overrides[pbsb] = 0;
    await this.saveGrouping({ id_overrides: overrides, id_rules: rules });
  }

  /** Back to one row per message ID for a command. */
  async expandCommand(pbsb) {
    const overrides = { ...(this.settings.id_overrides || {}) };
    if (pbsb in DEFAULT_ID_OVERRIDES) overrides[pbsb] = DEFAULT_ID_OVERRIDES[pbsb]; else delete overrides[pbsb];
    await this.saveGrouping({ id_overrides: overrides });
  }

  async saveGrouping(patch) {
    try {
      app.settings = await api.put("api/settings", patch);
      this.syncSettings();
      this.closeDetails();
      bus.emit("settings-changed");
      this.load(true);
    } catch (err) { toast(err.message, "err"); }
  }

  /** The definition a row is shown with: the chosen one, else what ebusd uses, else an included candidate. */
  rowDefinition(rowKey, candidates) {
    if (!candidates.size) return null;
    const chosen = setup.chosenFor(rowKey);
    if (chosen && candidates.has(chosen)) return chosen;
    let best = null;
    for (const [key, c] of candidates) if (c.used && (!best || c.used > candidates.get(best).used)) best = key;
    if (best) return best;
    const included = this.includedKeys || new Set();
    for (const key of candidates.keys()) if (included.has(key)) return key;
    return null;
  }

  /** The decoding shown for a run: the previewed candidate's, else the row's definition's. */
  decodeOf(row, run) {
    if (row.kind !== "telegram" || !run.line || !app.decoder) return null;
    const key = this.preview && this.preview.rowKey === row.key ? this.preview.defKey : row.defKey;
    if (!key) return null;
    return app.decoder.decodesOf(run.line)?.get(key) || null;
  }

  runLabel(row, run) {
    if (run.mixed) return run.label;
    const d = this.decodeOf(row, run);
    if (!d) return run.label;
    return d.result === "ok" ? (d.text || "(empty)") : `✗ ${d.result}`;
  }

  matches(key, name) {
    if (!this.filter) return true;
    const haystack = `${key} ${name}`.toLowerCase();
    return this.filter.split(/\s+/).every((word) => haystack.includes(word) || haystack.replace(/[→ ]/g, "").includes(word));
  }

  // -- pivot over the fields: a message with a definition shown as one row per value -------------------

  /** The fields a row's definition decodes, when the row is one whole message (the + then shows the values instead of splitting the ID). */
  fieldsOf(row) {
    if (row.kind !== "telegram" || !row.def || !row.defKey) return [];
    const names = new Set();
    for (const run of row.runs) { const d = app.decoder.decodesOf(run.line)?.get(row.defKey); if (d?.result === "ok") for (const f of Object.keys(d.fields || {})) names.add(f); }
    return [...names];
  }

  canExpand(row) { return this.fieldsOf(row).length >= 2 && (row.def.idlen || 0) <= row.row.id.length / 2; }

  toggleExpanded(row) {
    if (this.expanded.has(row.key)) this.expanded.delete(row.key); else this.expanded.add(row.key);
    this.buildRows();
    this.render();
  }

  /** One row per field: the runs of the decoded values over time (consecutive telegrams with the same value are one run). */
  fieldRows(row) {
    const units = Object.fromEntries(structureOf(row.def.csv).fields.map((f) => [f.name, f.unit]));
    return this.fieldsOf(row).map((field) => {
      const runs = [];
      for (const run of row.runs) {
        const d = run.mixed ? null : app.decoder.decodesOf(run.line)?.get(row.defKey);
        const ok = d?.result === "ok" && d.fields && field in d.fields;
        const value = ok ? d.fields[field] : null;
        const label = run.mixed ? "changes" : !d ? "…" : !ok ? `✗ ${d.result}` : value === null ? "-" : String(value);
        const status = ok || run.mixed ? "ok" : "error";
        const last = runs[runs.length - 1];
        if (last && last.label === label && last.status === status) { last.t1 = run.t1; last.n += run.n; } else runs.push({ t0: run.t0, t1: run.t1, n: run.n, value: label, status, label, mixed: run.mixed ? 1 : 0, line: run.line, unit: ok && value !== null ? units[field] || "" : "" });
      }
      return { kind: "field", key: `${row.key}#${field}`, label: `   ↳ ${field}`, name: setup.fieldMap(row.def)[field] || field, parent: row, field, def: row.def, defKey: row.defKey, candidates: new Map(), n: row.n, runs, row: row.row };
    });
  }

  /** Rows are virtual: only the labels in view (and a margin) are in the DOM, placed at their row's height. */
  renderLabels() {
    const labels = this.el.labels;
    labels.replaceChildren();
    labels.style.height = `${Math.max(this.rows.length * ROW, this.el.body.clientHeight - 2)}px`;
    const [from, to] = this.visibleRows(LABEL_MARGIN);
    this.labelRange = { from, to };
    for (let i = from; i < to; i++) labels.appendChild(this.labelFor(this.rows[i], i));
    if (!this.rows.length) {
      const db = app.status?.db;
      const hint = !db?.exists || !db?.has_telegram_table
        ? h("div", { class: "empty" }, "No telegrams recorded yet. Set ", h("code", {}, `sqlite_db: ${db?.path || "/share/ebusd/telegrams.db"}`), " in the eBUSd app configuration (SQLite telegram log) and restart it.")
        : h("div", { class: "empty" }, this.data ? "No telegrams in this time window." : "Loading…");
      labels.appendChild(hint);
    }
  }

  /** Make the labels in the DOM cover the rows in view: when scrolling gets close to the end of what is there. */
  syncLabels() {
    const r = this.labelRange;
    const [first, last] = this.visibleRows(0);
    if (!r || (first < r.from + 4 && r.from > 0) || (last > r.to - 4 && r.to < this.rows.length)) this.renderLabels();
  }

  labelFor(row, i) {
    if (row.kind === "group") {
      return h("div", { class: "tl-label group", "data-row": i, style: `top:${i * ROW}px`, title: `${row.rows} rows of the command ${row.pbsb} to ${row.zz}: they only differ in the message ID` },
        h("span", { class: "key" }, row.label), h("span", { class: "muted" }, `${fmt.count(row.rows)} rows`),
        h("button", { class: "small collapse", title: `show all telegrams of ${row.pbsb} as one row per source and destination; + on that row brings the rows back`, onclick: (e) => { e.stopPropagation(); this.collapseCommand(row.pbsb); } }, "⊟ one row"),
        h("span", { class: "n" }, fmt.count(row.n)));
    }
    const n = row.candidates ? row.candidates.size : 0;
    const renamed = row.def && setup.exportName(row.def) !== row.def.name;
    const title = row.kind === "telegram"
      ? `${row.label}${row.def ? `\n${row.name}${renamed ? ` (upstream: ${row.def.circuit} ${row.def.name})` : ""}\n${row.def.file} (${row.def.sourceLabel || row.def.source}) — ${row.def.status}: ${STATUS_HELP[row.def.status] || ""}` : ""}${n ? `\n${n} candidate definition${n > 1 ? "s" : ""}: click to compare and choose` : "\nno definition decodes this row"}`
      : (row.name ? `${row.label}\n${row.name}` : row.label);
    const badge = row.kind === "telegram" && (n > 1 || (n > 0 && !row.defKey))
      ? h("span", { class: `cands ${row.defKey ? "" : "warn"}`, title: `${n} candidate definitions — click to compare and choose`, onclick: (e) => { e.stopPropagation(); this.showDetails(row, null); } }, `${n}▾`)
      : null;
    const el = h("div", { class: `tl-label ${row.kind} ${this.selected?.row === row ? "picking" : ""}`, title, "data-row": i, style: `top:${i * ROW}px`,
      onclick: () => this.showDetails(row, null, row.kind === "telegram" && !n && row.row.zz !== null ? { tab: "new" } : {}) },   // no definition: the scratchpad offers to define it from the recording
      row.kind === "telegram" ? h("span", { class: "pivot" },
        h("button", { title: this.expanded.has(row.key) ? "show the message as one row again (−)" : row.row.id ? (row.row.id.length > 2 ? `combine with the rows that share the first ${row.row.id.length / 2 - 1} byte${row.row.id.length / 2 === 2 ? "" : "s"} of the message ID (−)` : "combine all rows of this command into one (−)") : "nothing to combine: no ID byte", disabled: !this.expanded.has(row.key) && !row.row.id, onclick: (e) => { e.stopPropagation(); if (this.expanded.has(row.key)) this.toggleExpanded(row); else this.combineRow(row); } }, "−"),
        this.canExpand(row)
          ? h("button", { title: this.expanded.has(row.key) ? "the values of the definition are shown as rows below" : `show the values of the definition as rows of their own: ${this.fieldsOf(row).slice(0, 6).join(", ")}${this.fieldsOf(row).length > 6 ? ", …" : ""} (+)`, disabled: this.expanded.has(row.key), onclick: (e) => { e.stopPropagation(); this.toggleExpanded(row); } }, "+")
          : h("button", { title: `split by the next byte after ${row.row.id || "the command"} (+)`, disabled: !row.runs.some((r) => r.payload), onclick: (e) => { e.stopPropagation(); this.splitRow(row); } }, "+")) : null,
      row.kind === "field" ? h("span", { class: "pivot" }, h("button", { title: "show the message as one row again (−)", onclick: (e) => { e.stopPropagation(); this.toggleExpanded(row.parent); } }, "−"), h("button", { disabled: true }, "+")) : null,
      h("span", { class: "key" }, row.label),
      row.name ? h("span", { class: `name ${renamed ? "renamed" : ""}`, style: row.def ? `color:${messageColors(row.def.circuit, row.def.name).text}` : "" }, row.name) : null,
      badge,
      row.kind === "telegram" && this.settings.id_overrides?.[`${fmt.hex(row.row.pb)}${fmt.hex(row.row.sb)}`] === 0 ? h("button", { class: "small expand", title: "all messages of this command are one row: show one row per message ID again", onclick: (e) => { e.stopPropagation(); this.expandCommand(`${fmt.hex(row.row.pb)}${fmt.hex(row.row.sb)}`); } }, "⊞ expand") : null,
      row.kind === "telegram" && !n && row.row.zz !== null ? h("span", { class: "define", title: "no definition decodes this message: click to define it from the recording" }, "＋ define") : null,
      h("span", { class: "n" }, `${fmt.count(row.n)}${row.runs.length > 1 ? ` · ${row.runs.length - 1}Δ` : ""}`));
    return el;
  }

  // -- drawing ---------------------------------------------------------------------------

  xOf(t) { return (t - this.t0) / this.span * this.width; }
  tOf(x) { return this.t0 + x / this.width * this.span; }

  sizeCanvas(canvas, width, height) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(width * dpr)), hh = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== hh) canvas.height = hh;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  ticks() {
    const maxTicks = Math.max(2, this.width / 90);
    const step = TICK_STEPS.find((s) => this.span / s <= maxTicks) || TICK_STEPS[TICK_STEPS.length - 1];
    const offset = new Date(this.t0).getTimezoneOffset() * 60e3;
    const first = Math.floor((this.t0 - offset) / step) * step + offset;
    const ticks = [];
    for (let t = first; t <= this.t1; t += step) ticks.push(t);
    return { step, ticks };
  }

  tickLabel(t, step) {
    if (step < 60e3) return fmt.time(t);
    if (step < 86400e3) return fmt.time(t).slice(0, 5);
    return fmt.date(t).slice(5);
  }

  render() {
    if (!this.visible()) return;
    if (!this.histogram) this.loadHistogram();
    this.width = Math.max(50, this.el.plot.clientWidth || (this.el.body.clientWidth - this.el.labels.offsetWidth));
    if (this.width !== this.lastWidth) { this.lastWidth = this.width; }
    this.syncLabels();
    this.drawAxis();
    this.drawAnnot();
    this.drawPlot();
    this.drawOverview();
  }

  /** Notes shown on the timeline: the recorded ones and the one being written. */
  allMarkers() { return this.logDraft ? [...this.markers, this.logDraft] : this.markers; }

  /** Notes and Home Assistant state changes inside the window, as flags of the events lane. */
  annotations() {
    const items = [];
    for (const m of this.allMarkers()) {
      if (m.ms < this.t0 || m.ms > this.t1) continue;
      items.push({ ms: m.ms, kind: "marker", color: m.draft ? "#c2410c" : "#ef6c00", label: m.draft ? `new: ${m.message || "(time only)"}` : (m.message || "(time only)"), marker: m });
    }
    for (const ev of this.states) {
      if (!ev.entity || ev.ms < this.t0 || ev.ms > this.t1) continue;
      const name = ev.attributes?.friendly_name || ev.entity;
      items.push({ ms: ev.ms, kind: "state", color: hashColor(ev.entity, 70, 38), entity: ev.entity, label: `${name}: ${ev.state ?? "?"}`, event: ev });
    }
    return items.sort((a, b) => a.ms - b.ms);
  }

  drawAnnot() {
    const height = 28;
    const ctx = this.sizeCanvas(this.el.annotCanvas, this.width, height);
    ctx.clearRect(0, 0, this.width, height);
    ctx.font = "11px system-ui, sans-serif";
    const items = (this.annotItems = this.annotations());
    const lanes = [-Infinity, -Infinity];   // end of the last label per lane: labels do not overlap
    for (const it of items) {
      const x = Math.round(this.xOf(it.ms)) + 0.5;
      it.x = x;
      ctx.strokeStyle = it.color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 1); ctx.lineTo(x, height); ctx.stroke();
      ctx.fillStyle = it.color;
      ctx.beginPath(); ctx.moveTo(x, 1); ctx.lineTo(x + 6, 5); ctx.lineTo(x, 9); ctx.closePath(); ctx.fill();
      const lane = lanes[0] <= lanes[1] ? 0 : 1;
      if (x > lanes[lane] + 4) {
        const text = it.label.length > 48 ? `${it.label.slice(0, 47)}…` : it.label;
        ctx.fillStyle = "#1f2d3d";
        ctx.fillText(text, x + 9, lane ? 24 : 11);
        lanes[lane] = x + 9 + ctx.measureText(text).width;
      }
    }
  }

  drawAxis() {
    const height = 26;
    const ctx = this.sizeCanvas(this.el.axisCanvas, this.width, height);
    ctx.clearRect(0, 0, this.width, height);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "#6b7a8a";
    ctx.strokeStyle = "#d9dee3";
    const { step, ticks } = this.ticks();
    let lastDay = null;
    for (const t of ticks) {
      const x = Math.round(this.xOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, height - 6); ctx.lineTo(x, height); ctx.stroke();
      const day = fmt.date(t);
      let label = this.tickLabel(t, step);
      if (step < 86400e3 && day !== lastDay && this.span > 6 * 3600e3) { label = `${day.slice(5)} ${label}`; lastDay = day; }
      ctx.fillText(label, x + 3, height - 9);
    }
    const now = Date.now();
    if (now >= this.t0 && now <= this.t1) {
      const x = Math.round(this.xOf(now)) + 0.5;
      ctx.strokeStyle = "#0b7dda"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
  }

  /** The rows in view (plus a margin) as first and last row index. */
  visibleRows(margin = 0) {
    const body = this.el.body;
    const viewH = body.clientHeight || 800;
    return [Math.max(0, Math.floor(body.scrollTop / ROW) - margin), Math.min(this.rows.length, Math.ceil((body.scrollTop + viewH) / ROW) + margin)];
  }

  /** The row at a vertical position of the canvas (which only covers the rows around the view). */
  rowIndexAt(offsetY) { return Math.floor((offsetY + (this.canvasWin?.top || 0)) / ROW); }

  /**
   * Rows are virtual, so that thousands of them cost no more than a screenful: the scroll area
   * has the height of all rows, but the canvas covers only the rows in view and half a screen
   * above and below, and is drawn again when the view leaves that margin. (Browsers draw nothing
   * on canvases beyond about 16 000 pixels, which is what long lists of rows ran into.)
   */
  onScroll() {
    this.syncLabels();
    const c = this.canvasWin;
    const { scrollTop, clientHeight } = this.el.body;
    const content = Math.max(this.rows.length * ROW, clientHeight);
    if (!c || (scrollTop - c.top < ROW * 3 && c.top > 0) || (c.top + c.height - (scrollTop + clientHeight) < ROW * 3 && c.top + c.height < content)) this.drawPlot();
  }

  drawPlot() {
    const body = this.el.body;
    const viewH = Math.max(1, body.clientHeight - 2);
    const content = Math.max(this.rows.length * ROW, viewH);
    const dpr = window.devicePixelRatio || 1;
    const limit = Math.max(viewH, Math.floor(12e6 / (Math.max(1, this.width) * dpr * dpr)));   // keep the canvas well below what browsers can draw
    const height = Math.min(content, limit, Math.max(viewH + ROW * 20, Math.round(viewH * 2)));
    const top = Math.max(0, Math.min(body.scrollTop - (height - viewH) / 2, content - height));
    this.canvasWin = { top, height };
    this.el.plot.style.height = `${content}px`;
    this.el.plotCanvas.style.top = `${top}px`;
    const ctx = this.sizeCanvas(this.el.plotCanvas, this.width, height);
    ctx.translate(0, -top);
    ctx.clearRect(0, top, this.width, height);
    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
    const { ticks } = this.ticks();
    ctx.strokeStyle = "#eef1f4";
    for (const t of ticks) {
      const x = Math.round(this.xOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
    }
    const first = Math.floor(top / ROW), last = Math.min(this.rows.length, Math.ceil((top + height) / ROW));
    for (let i = first; i < last; i++) {
      const row = this.rows[i];
      const y = i * ROW;
      if (row.kind === "event") { ctx.fillStyle = "#fbf7ee"; ctx.fillRect(0, y, this.width, ROW); }
      if (row.kind === "group") { ctx.fillStyle = "#f7f9fb"; ctx.fillRect(0, y, this.width, ROW); }
      if (this.selected && this.selected.row === row) { ctx.fillStyle = "#e3f1fc"; ctx.fillRect(0, y, this.width, ROW); }
      ctx.strokeStyle = "#eef1f4"; ctx.beginPath(); ctx.moveTo(0, y + ROW - 0.5); ctx.lineTo(this.width, y + ROW - 0.5); ctx.stroke();
      this.drawRuns(ctx, row, y);
    }
    for (const marker of this.allMarkers()) {
      if ((marker.ms_max ?? marker.ms) < this.t0 || (marker.ms_min ?? marker.ms) > this.t1) continue;
      const x0 = this.xOf(marker.ms_min ?? marker.ms), x1 = this.xOf(marker.ms_max ?? marker.ms);
      if (x1 - x0 > 1.5) { ctx.fillStyle = "rgba(239,108,0,.12)"; ctx.fillRect(x0, top, x1 - x0, height); }
      const x = Math.round(this.xOf(marker.ms)) + 0.5;
      ctx.setLineDash([4, 3]); ctx.strokeStyle = "#ef6c00";
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
      ctx.setLineDash([]);
    }
    const states = (this.annotItems || []).filter((it) => it.kind === "state");
    if (states.length <= 400) {
      ctx.save(); ctx.globalAlpha = 0.35;
      for (const it of states) { ctx.strokeStyle = it.color; ctx.beginPath(); ctx.moveTo(it.x, 0); ctx.lineTo(it.x, height); ctx.stroke(); }
      ctx.restore();
    }
    const now = Date.now();
    if (now >= this.t0 && now <= this.t1) {
      const x = Math.round(this.xOf(now)) + 0.5;
      ctx.strokeStyle = "rgba(11,125,218,.5)"; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
    }
    if (this.hover && this.hover.x !== undefined) {
      const x = Math.round(this.hover.x) + 0.5;
      ctx.strokeStyle = "rgba(31,45,61,.35)"; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
    }
  }

  drawRuns(ctx, row, y) {
    const top = y + 4, barHeight = ROW - 8;
    const runs = row.runs;
    // the runs are in time order: start at the first one that reaches into the window, stop after the last
    let lo = 0, hi = runs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (runs[mid].t1 < this.t0) lo = mid + 1; else hi = mid; }
    let lastPixel = -1;
    for (let j = lo; j < runs.length; j++) {
      const run = runs[j];
      if (run.t0 > this.t1) break;
      const x0 = this.xOf(run.t0), x1 = this.xOf(run.t1);
      if (x1 - x0 < 2) { const pixel = Math.round(x0); if (pixel === lastPixel) continue; lastPixel = pixel; }   // many runs in one pixel column: draw the first
      const { fill, stroke } = run.mixed ? MIXED_COLORS : valueColors(run.value, run.status);
      const next = runs[j + 1];
      if (next && row.kind !== "event") {
        // the value holds until the next (different) telegram
        const nx = this.xOf(next.t0);
        ctx.strokeStyle = stroke; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(Math.max(x1, x0 + 2), top + barHeight / 2 + 0.5); ctx.lineTo(nx, top + barHeight / 2 + 0.5); ctx.stroke();
        ctx.setLineDash([]);
      }
      const picked = this.selected?.row === row && this.selected.run && this.selected.run.t0 === run.t0;   // the run shown in the details
      if (run.n === 1 && row.kind !== "event") {
        ctx.fillStyle = picked ? "#0b3d6b" : stroke;
        ctx.fillRect(Math.round(x0) - (picked ? 2 : 1), picked ? top - 2 : top, picked ? 4 : 2, picked ? barHeight + 4 : barHeight);
        if (x1 - x0 < 1 && this.span / this.width < 1000) {
          ctx.fillStyle = "#1f2d3d";
          if (next && this.xOf(next.t0) - x0 > 40) ctx.fillText(this.runLabel(row, run), x0 + 4, top + barHeight - 4);
        }
        continue;
      }
      const left = Math.max(x0, -1), right = Math.min(Math.max(x1, x0 + 3), this.width + 1);
      const width = right - left;
      ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(left + 0.5, top + 0.5, width - 1, barHeight - 1, 3); ctx.fill(); ctx.stroke();
      if (picked) { ctx.strokeStyle = "#0b3d6b"; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(left - 0.5, top - 1.5, width + 1, barHeight + 3, 4); ctx.stroke(); ctx.lineWidth = 1; }
      if (width > 28) {
        ctx.save(); ctx.beginPath(); ctx.rect(left + 2, top, width - 4, barHeight); ctx.clip();
        ctx.fillStyle = "#1f2d3d";
        let text = this.runLabel(row, run);
        if (row.kind !== "event") {
          const extra = `×${run.n}${run.mean && width > 110 ? ` every ${fmt.duration(run.mean)}` : ""}`;
          text = width > 60 ? `${text}  ${extra}` : extra;
        } else if (run.event && width > 90) {
          text = `${run.label}  (${fmt.time(run.t0).slice(0, 5)})`;
        }
        ctx.fillText(text, left + 5, top + barHeight - 5);
        ctx.restore();
      }
    }
  }

  drawOverview() {
    const width = this.el.overview.clientWidth, height = this.el.overview.clientHeight;
    if (!width) return;
    const ctx = this.sizeCanvas(this.el.overviewCanvas, width, height);
    ctx.clearRect(0, 0, width, height);
    const hist = this.histogram;
    if (!hist || !hist.buckets.length) {
      ctx.fillStyle = "#9aa7b4"; ctx.font = "11px system-ui"; ctx.fillText("no telegram history", 8, 16);
      return;
    }
    const start = hist.from_ms, end = Math.max(hist.to_ms, Date.now());
    const scale = width / (end - start);
    const max = Math.max(...hist.buckets.map((b) => b[1]));
    for (const [t, n, bad] of hist.buckets) {
      const x = (t - start) * scale;
      const w = Math.max(1, hist.bucket_s * 1000 * scale);
      const hgt = Math.max(1, (n / max) * (height - 4));
      ctx.fillStyle = "#b3d7f2"; ctx.fillRect(x, height - hgt, w, hgt);
      if (bad) { ctx.fillStyle = "#ef9a9a"; ctx.fillRect(x, height - Math.max(1, (bad / max) * (height - 4)), w, Math.max(1, (bad / max) * (height - 4))); }
    }
    const x0 = (this.t0 - start) * scale, x1 = (this.t1 - start) * scale;
    ctx.fillStyle = "rgba(11,125,218,.18)"; ctx.fillRect(x0, 0, Math.max(2, x1 - x0), height);
    ctx.strokeStyle = "#0b7dda"; ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(2, x1 - x0), height - 1);
    ctx.fillStyle = "#0b7dda";
    for (const x of [x0, x1]) { ctx.beginPath(); ctx.roundRect(Math.round(x) - 2.5, height / 2 - 9, 5, 18, 2); ctx.fill(); }
    ctx.fillStyle = "#6b7a8a"; ctx.font = "10px system-ui";
    ctx.fillText(fmt.dateTime(start).slice(0, 16), 4, 11);
    const label = "now"; ctx.fillText(label, width - ctx.measureText(label).width - 4, 11);
    this.overviewScale = { start, scale };
  }

  // -- interaction --------------------------------------------------------------------------

  /** Flags of the events lane within a few pixels of x. */
  annotAt(x) {
    return (this.annotItems || []).filter((it) => Math.abs(it.x - x) <= 6);
  }

  bindAnnot() {
    const lane = this.el.annotCanvas;
    const tip = this.el.tooltip;
    lane.addEventListener("mousemove", (e) => {
      const hits = this.annotAt(e.offsetX);
      lane.style.cursor = hits.some((h) => h.kind === "state") ? "pointer" : "default";
      if (!hits.length) { tip.style.display = "none"; return; }
      tip.textContent = hits.slice(0, 8).map((it) => it.kind === "marker"
        ? `${it.label}\n${fmt.dateTime(it.ms)}${it.marker.ms_max > it.marker.ms_min ? ` (between ${fmt.time(it.marker.ms_min)} and ${fmt.time(it.marker.ms_max)})` : ""}`
        : `${it.event.attributes?.friendly_name ? `${it.event.attributes.friendly_name} (${it.entity})` : it.entity}\n${it.event.previous !== null && it.event.previous !== undefined ? `${it.event.previous} → ` : ""}${it.event.state}  at ${fmt.dateTime(it.ms, true)}`).join("\n\n")
        + (hits.length > 8 ? `\n… ${hits.length - 8} more` : "");
      tip.style.display = "block";
      tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
      tip.style.top = `${Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8)}px`;
    });
    lane.addEventListener("mouseleave", () => { tip.style.display = "none"; });
    lane.addEventListener("click", (e) => {
      if (this.logPicking) { this.pickLogTime(this.tOf(e.offsetX)); return; }
      const note = this.annotAt(e.offsetX).find((it) => it.kind === "marker" && !it.marker.draft);
      if (note) { this.toggleLog(true, note.marker.id); return; }
      const hit = this.annotAt(e.offsetX).find((it) => it.kind === "state");
      if (!hit) return;
      const list = this.states.filter((ev) => ev.entity === hit.entity);
      const end = this.follow ? Date.now() : this.t1;
      const runs = list.map((ev, i) => ({ t0: ev.ms, t1: list[i + 1] ? list[i + 1].ms : end, n: 1, label: ev.state ?? "", value: ev.state ?? "", event: ev }));
      this.showDetails({ kind: "event", key: hit.entity, label: hit.entity, name: hit.event.attributes?.friendly_name || "", n: list.length, runs }, null);
    });
    lane.addEventListener("wheel", (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoom(Math.exp(Math.max(-100, Math.min(100, e.deltaY)) * 0.006), this.tOf(e.offsetX), "soon"); } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); this.pan((e.deltaX || e.deltaY) / this.width, "soon"); } }, { passive: false });
  }

  bindMouse() {
    this.bindAnnot();
    const plot = this.el.plotCanvas;
    let drag = null;
    plot.addEventListener("mousedown", (e) => { drag = { x: e.clientX, t0: this.t0, t1: this.t1, moved: false }; });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (!drag.moved) return;
      const dt = -dx / this.width * this.span;
      this.t0 = drag.t0 + dt; this.t1 = drag.t1 + dt;
      if (dt < 0 || this.t1 < Date.now()) this.setFollowSilently(false);
      this.updateInfo(); this.render();
    });
    window.addEventListener("mouseup", (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) this.load(true);
      else if (e.target === plot) this.click(e);
    });
    plot.addEventListener("mousemove", (e) => this.hoverAt(e));
    plot.addEventListener("mouseleave", () => { this.hover = null; this.el.tooltip.style.display = "none"; this.drawPlot(); });
    // like the browser's developer tools: scrolling scrolls the rows; Ctrl/⌘ + scroll (and a trackpad
    // pinch, which browsers report that way) zooms the time axis; Shift + scroll or a sideways swipe moves it
    plot.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = Math.max(-100, Math.min(100, e.deltaY));
        this.zoom(Math.exp(delta * 0.006), this.tOf(e.offsetX), "soon");
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        this.pan((e.deltaX || e.deltaY) / this.width, "soon");
      }
      // otherwise the event is left alone and the list of rows scrolls
    }, { passive: false });
    // Safari reports pinch gestures as gesture events instead
    let pinch = null;
    plot.addEventListener("gesturestart", (e) => { e.preventDefault(); pinch = { scale: 1 }; });
    plot.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      if (!pinch) return;
      const rect = plot.getBoundingClientRect();
      this.zoom(pinch.scale / e.scale, this.tOf(e.clientX - rect.left), "soon");
      pinch.scale = e.scale;
    });
    plot.addEventListener("gestureend", (e) => { e.preventDefault(); pinch = null; });
    plot.addEventListener("dblclick", (e) => this.zoom(0.5, this.tOf(e.offsetX)));
    // overview strip, as in the developer tools: drag the edges of the window to resize it, drag
    // inside to move it, drag outside to select a new one; the wheel zooms or moves
    const overview = this.el.overviewCanvas;
    let odrag = null;
    const EDGE = 7;
    const timeAt = (clientX) => {
      const { start, scale } = this.overviewScale;
      return start + (clientX - overview.getBoundingClientRect().left) / scale;
    };
    const hit = (clientX) => {
      if (!this.overviewScale) return "new";
      const { start, scale } = this.overviewScale;
      const x = clientX - overview.getBoundingClientRect().left;
      const x0 = (this.t0 - start) * scale, x1 = (this.t1 - start) * scale;
      if (Math.abs(x - x0) <= EDGE) return "left";
      if (Math.abs(x - x1) <= EDGE) return "right";
      return x > x0 && x < x1 ? "move" : "new";
    };
    const cursors = { left: "ew-resize", right: "ew-resize", move: "grab", new: "crosshair" };
    overview.addEventListener("mousemove", (e) => { if (!odrag) overview.style.cursor = cursors[hit(e.clientX)]; });
    overview.addEventListener("mousedown", (e) => {
      if (!this.overviewScale) return;
      const mode = hit(e.clientX);
      odrag = { mode, x: e.clientX, t0: this.t0, t1: this.t1, anchor: timeAt(e.clientX), moved: false };
      if (mode === "move") overview.style.cursor = "grabbing";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!odrag || !this.overviewScale) return;
      if (Math.abs(e.clientX - odrag.x) > 3) odrag.moved = true;
      if (!odrag.moved) return;
      const t = timeAt(e.clientX);
      let t0 = odrag.t0, t1 = odrag.t1;
      if (odrag.mode === "left") t0 = Math.min(t, odrag.t1 - MIN_SPAN);
      else if (odrag.mode === "right") t1 = Math.max(t, odrag.t0 + MIN_SPAN);
      else if (odrag.mode === "move") { t0 = odrag.t0 + (t - odrag.anchor); t1 = odrag.t1 + (t - odrag.anchor); }
      else { t0 = Math.min(odrag.anchor, t); t1 = Math.max(odrag.anchor, t); if (t1 - t0 < MIN_SPAN) t1 = t0 + MIN_SPAN; }
      this.setFollowSilently(false);
      this.setWindow(t0, t1, false);
    });
    window.addEventListener("mouseup", (e) => {
      if (!odrag) return;
      const d = odrag;
      odrag = null;
      overview.style.cursor = this.overviewScale ? cursors[hit(e.clientX)] : "";
      if (d.moved) this.load(true);
      else if (this.overviewScale && d.mode !== "left" && d.mode !== "right") {
        const center = timeAt(e.clientX);
        this.setWindow(center - this.span / 2, center + this.span / 2);
      }
    });
    overview.addEventListener("wheel", (e) => {
      if (!this.overviewScale) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom(Math.exp(Math.max(-100, Math.min(100, e.deltaY)) * 0.006), timeAt(e.clientX), "soon");
      else this.pan((e.deltaX || e.deltaY) / 400, "soon");
    }, { passive: false });
  }

  onKey(e) {
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === "ArrowLeft") this.pan(-0.2);
    else if (e.key === "ArrowRight") this.pan(0.2);
    else if (e.key === "+" || e.key === "=") this.zoom(0.5);
    else if (e.key === "-") this.zoom(2);
    else if (e.key === "n" || e.key === "N") this.setFollow(true);
    else if (e.key === "Escape") this.closeDetails();
    else return;
    e.preventDefault();
  }

  runAt(row, x) {
    const t = this.tOf(x);
    const tolerance = 4 / this.width * this.span;
    let lo = 0, hi = row.runs.length - 1, found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (row.runs[mid].t0 <= t + tolerance) { found = row.runs[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    if (!found) return null;
    const end = row.kind !== "event" && found.n === 1 ? found.t0 : found.t1;
    if (t <= end + tolerance) return found;
    return null;
  }

  hoverAt(e) {
    const row = this.rows[this.rowIndexAt(e.offsetY)];
    const run = row ? this.runAt(row, e.offsetX) : null;
    this.hover = { x: e.offsetX, row, run };
    const tip = this.el.tooltip;
    const t = this.tOf(e.offsetX);
    let text = fmt.dateTime(t, this.span < 60e3);
    const marker = this.markers.find((m) => Math.abs(this.xOf(m.ms) - e.offsetX) < 4 || ((m.ms_min ?? m.ms) <= t && t <= (m.ms_max ?? m.ms) && m.ms_max - m.ms_min > 1000));
    if (marker) {
      text = `${marker.message || "(time only)"}\n${fmt.dateTime(marker.ms)}` + (marker.ms_max > marker.ms_min ? ` (between ${fmt.time(marker.ms_min)} and ${fmt.time(marker.ms_max)})` : "");
    } else if (row && run) {
      if (run.mixed) {
        text = `${row.label}${row.name ? `  ${row.name}` : ""}\n${run.label} in ${fmt.count(run.n)} telegrams\n${fmt.dateTime(run.t0)} – ${fmt.dateTime(run.t1)}\nthe window is summed up in ${fmt.duration(this.data.bucket_ms)} steps: zoom in for every value`;
      } else if (row.kind === "telegram") {
        const d = this.decodeOf(row, run);
        const others = row.candidates ? [...row.candidates.values()].filter((c) => c.def.key !== row.defKey).slice(0, 4) : [];
        text = `${row.label}${row.name ? `  ${row.name}` : ""}\n${d ? `${d.result === "ok" ? d.text || "(empty)" : `✗ ${d.result}`}\n` : ""}${run.label}${run.status !== "ok" ? `  [${run.status}]` : ""}\n`
          + (run.n === 1 ? `once at ${fmt.time(run.t0, true)}` : `${fmt.count(run.n)}× from ${fmt.time(run.t0)} to ${fmt.time(run.t1)} (${fmt.duration(run.t1 - run.t0)})`
          + (run.mean ? `\nevery ${fmt.duration(run.mean)} (shortest ${fmt.duration(run.min)})` : ""))
          + (others.length ? `\n\nother candidates:${others.map((c) => { const od = app.decoder.decodesOf(run.line)?.get(c.def.key); return `\n  ${c.def.circuit} ${c.def.name} (${c.def.status}): ${od ? (od.result === "ok" ? od.text : `✗ ${od.result}`) : "—"}`; }).join("")}${row.candidates.size > 5 ? `\n  … ${row.candidates.size - 5} more` : ""}` : "");
      } else if (row.kind === "field") {
        text = `${row.parent.label}  ${row.name}\n${row.field} = ${run.label}${run.unit ? ` ${run.unit}` : ""}\n`
          + (run.n === 1 ? `once at ${fmt.time(run.t0, true)}` : `${fmt.count(run.n)}× from ${fmt.time(run.t0)} to ${fmt.time(run.t1)} (${fmt.duration(run.t1 - run.t0)})`);
      } else {
        text = `${row.label}${row.name ? `  ${row.name}` : ""}\n${run.label} since ${fmt.dateTime(run.t0)}${run.event.previous !== null && run.event.previous !== undefined ? ` (was ${run.event.previous})` : ""}`;
      }
    } else if (row) {
      text = `${row.label}${row.name ? `  ${row.name}` : ""}\n${text}`;
    }
    tip.textContent = text;
    tip.style.display = "block";
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tw - 8)}px`;
    tip.style.top = `${Math.min(e.clientY + 14, window.innerHeight - th - 8)}px`;
    this.drawPlot();
  }

  click(e) {
    if (this.logPicking) { this.pickLogTime(this.tOf(e.offsetX)); return; }
    const row = this.rows[this.rowIndexAt(e.offsetY)];
    if (!row || row.kind === "group") return;
    this.showDetails(row, this.runAt(row, e.offsetX));
  }

  closeDetails() { bus.emit("select-row", null); }

  /** A click on a row (or a value): the scratchpad shows the message; the selection stays drawn until it changes. */
  showDetails(row, run, options = {}) {
    bus.emit("select-row", { row, run, options, view: this });
  }

  /** Whether the timeline is the kind of view that groups rows by ID bytes (the scratchpad offers to change that). */
  get kind() { return "timeline"; }

  window() { return { from: this.t0, to: this.t1 }; }

  /** The scratchpad took a selection (or none): draw it. */
  select(row, run = null) {
    this.selected = row ? { row, run } : null;
    this.renderLabels();
    this.drawPlot();
  }

  /** The value history of a row over the whole recording, loaded once per row and recording state. */
  loadSeries(row) {
    const db = app.status?.db;
    if (!db?.first_ms) return Promise.resolve(null);
    const from = db.first_ms, to = db.last_ms + 1000;
    const cacheKey = `${row.key}|${from}|${Math.floor(to / 60000)}`;
    const cached = this.seriesCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    let pending = this.seriesLoading.get(cacheKey);
    if (!pending) {
      pending = api.get(seriesQuery(row.row, from, to)).then((data) => { this.seriesCache.set(cacheKey, data); return data; });
      this.seriesLoading.set(cacheKey, pending);
      pending.finally(() => this.seriesLoading.delete(cacheKey));
    }
    return pending;
  }

  // -- candidate preview ------------------------------------------------------------------------------

  setPreview(row, defKey) {
    const next = defKey ? { rowKey: row.key, defKey } : null;
    if ((this.preview?.defKey || null) === (next?.defKey || null)) return;
    this.preview = next;
    this.drawPlot();
  }

  /** The message ID length of a command (how many data bytes after PBSB identify a message), set from the scratchpad. */
  async setIdLength(row, n) {
    const pbsb = `${fmt.hex(row.row.pb)}${fmt.hex(row.row.sb)}`;
    const overrides = { ...(this.settings.id_overrides || {}) };
    if (n === (this.settings.id_bytes ?? 1)) delete overrides[pbsb]; else overrides[pbsb] = n;
    try {
      app.settings = await api.put("api/settings", { id_overrides: overrides });
      this.syncSettings();
      bus.emit("settings-changed");
      this.closeDetails();
    } catch (err) { toast(err.message, "err"); }
  }

  // -- events: what the terminal's `log` command does ---------------------------------------------------------------

  toggleLog(open = this.el.logPop.style.display === "none", highlight = null) {
    const pop = this.el.logPop;
    pop.style.display = open ? "" : "none";
    this.el.logButton.classList.toggle("active", open);
    if (!open) { this.logDraft = null; this.logPicking = false; this.el.plotCanvas.style.cursor = ""; this.drawAnnot(); this.drawPlot(); return; }
    this.log ||= { message: "", mode: "now", ms: Date.now(), before: { value: 500, unit: "ms" }, after: { value: 500, unit: "ms" }, whole: false, notes: [] };
    this.log.highlight = highlight;
    this.renderLog();
    this.loadNotes();
  }

  async loadNotes() {
    try { this.log.notes = (await api.get("api/notes?limit=30")).notes; this.renderLog(); } catch (err) { console.warn(err); }
  }

  /** The time the form means, the range and the draft that is drawn on the timeline meanwhile. */
  logEvent() {
    const l = this.log;
    const ms = l.mode === "now" ? Date.now() : l.ms;
    const range = eventRange({ ms, beforeMs: toMs(l.before.value, l.before.unit), afterMs: toMs(l.after.value, l.after.unit), whole: l.whole });
    return { ...range, beforeMs: toMs(l.before.value, l.before.unit), afterMs: toMs(l.after.value, l.after.unit) };
  }

  pickLogTime(ms) {
    this.logPicking = false;
    this.el.plotCanvas.style.cursor = "";
    this.log.mode = "at";
    this.log.ms = Math.round(ms);
    this.renderLog();
  }

  renderLog() {
    const pop = this.el.logPop;
    if (pop.style.display === "none" || !this.log) return;
    const l = this.log;
    const ev = this.logEvent();
    this.logDraft = l.mode === "now" ? null : { ms: ev.ms, ms_min: ev.min, ms_max: ev.max, message: l.message.trim(), draft: true };
    this.drawAnnot(); this.drawPlot();
    const local = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    const message = h("input", { type: "text", value: l.message, size: 44, placeholder: "e.g. set hot water to 50 °C (optional: only the time is noted without)", oninput: () => { l.message = message.value; this.logDraft && (this.logDraft.message = message.value.trim()); command.textContent = this.logCommandText(); this.drawAnnot(); },
      onkeydown: (e) => { if (e.key === "Enter") this.submitLog(); } });
    const when = h("input", { type: "datetime-local", step: 1, value: local(l.mode === "now" ? Date.now() : l.ms), disabled: l.mode === "now", onchange: () => { const t = new Date(when.value).getTime(); if (Number.isFinite(t)) { l.ms = t; this.renderLog(); } } });
    const units = (side) => h("select", { onchange: (e) => { l[side].unit = e.target.value; this.renderLog(); } }, ["ms", "s", "min", "h"].map((u) => h("option", { value: u, selected: u === l[side].unit }, u)));
    const amount = (side) => h("input", { type: "number", min: 0, value: l[side].value, style: "width:64px", disabled: l.whole, onchange: (e) => { l[side].value = Number(e.target.value) || 0; this.renderLog(); } });
    const command = h("code", { class: "mono" }, this.logCommandText());
    const exact = ev.max - ev.min;
    append(pop.replaceChildren() || pop,
      h("div", { class: "row" }, h("b", {}, "Note an event"), h("span", { class: "muted" }, "like the log command of the eBUSd terminal"), h("span", { style: "margin-left:auto" }), h("button", { class: "small", onclick: () => this.toggleLog(false) }, "✕")),
      h("label", { class: "col" }, "What happened", message),
      h("div", { class: "row" }, h("label", {}, "When"),
        h("label", {}, h("input", { type: "radio", name: "logwhen", checked: l.mode === "now", onchange: () => { l.mode = "now"; this.renderLog(); } }), " now"),
        h("label", {}, h("input", { type: "radio", name: "logwhen", checked: l.mode === "at", onchange: () => { l.mode = "at"; l.ms = l.ms || Date.now(); this.renderLog(); } }), " at"), when,
        h("button", { class: `small ${this.logPicking ? "primary" : ""}`, title: "then click the time on the timeline", onclick: () => { this.logPicking = !this.logPicking; this.el.plotCanvas.style.cursor = this.logPicking ? "crosshair" : ""; this.renderLog(); } }, this.logPicking ? "click the timeline…" : "pick on the timeline")),
      h("div", { class: "row" }, h("label", {}, "How exact"),
        l.whole ? h("span", {}, "the whole minute") : [h("span", {}, "up to"), amount("before"), units("before"), h("span", {}, "before and"), amount("after"), units("after"), h("span", {}, "after")]),
      h("div", { class: "chips" }, LOG_PRESETS.map(([label, preset]) => h("button", { class: "small", onclick: () => { l.before = fromMs(preset.beforeMs); l.after = fromMs(preset.afterMs); l.whole = preset.whole; this.renderLog(); } }, label))),
      h("div", { class: "hint" }, l.mode === "now" ? "The time is taken when you press Log." : `Between ${fmt.time(ev.min, true)} and ${fmt.time(ev.max, true)} (${durationText(Math.max(0, exact)) || "0ms"} wide); the band is drawn on the timeline.`),
      h("div", { class: "hint" }, "In the terminal: ", command, " ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); navigator.clipboard?.writeText(command.textContent).then(() => toast("copied")); } }, "copy")),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => this.submitLog() }, "Log event")),
      h("h3", {}, "Recent notes"),
      h("div", { class: "notes" }, l.notes.length ? l.notes.map((n) => {
        const before = n.ms - n.ms_min, after = n.ms_max - n.ms;
        const range = before === after ? (before > 500 ? `±${durationText(before)}` : "") : `${before ? `-${durationText(before)}` : ""}${after ? `+${durationText(after)}` : ""}`;
        return h("div", { class: `note ${l.highlight === n.id ? "hl" : ""}` },
          h("a", { href: "#", class: "mono", title: "show on the timeline", onclick: (e) => { e.preventDefault(); bus.emit("goto-time", n.ms); } }, fmt.dateTime(n.ms)),
          range ? h("span", { class: "muted" }, ` ${range}`) : null, " ", n.message ? h("span", {}, n.message) : h("span", { class: "muted" }, "(time only)"),
          h("a", { href: "#", class: "err", style: "margin-left:auto", title: "delete this note", onclick: async (e) => { e.preventDefault(); if (!confirm(`Delete the note "${n.message || fmt.dateTime(n.ms)}"?`)) return; try { await api.del(`api/events/${n.id}`); this.loadNotes(); this.load(true); } catch (err) { toast(err.message, "err"); } } }, "✕"));
      }) : h("div", { class: "hint" }, "none yet")));
  }

  logCommandText() {
    const l = this.log;
    const ev = this.logEvent();
    return logCommand({ message: l.message, now: l.mode === "now", ms: ev.ms, beforeMs: ev.beforeMs, afterMs: ev.afterMs, whole: l.whole });
  }

  async submitLog() {
    const l = this.log;
    const ev = this.logEvent();
    try {
      await api.post("api/events", { message: l.message.trim(), ms: Math.round(ev.ms), ms_min: Math.round(ev.min), ms_max: Math.round(ev.max) });
      toast(l.message.trim() ? "event noted" : "time noted");
      l.message = ""; l.mode = "now"; this.logDraft = null;
      this.renderLog();
      this.loadNotes();
      this.load(true);
    } catch (err) { toast(err.message, "err"); }
  }
}
