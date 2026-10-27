// Timeline of recorded telegrams and Home Assistant events.
//
// Telegrams are grouped into rows (source, destination, command and message ID) and shown as
// runs: a bar spans the time a value stayed the same, labelled with the value, the number of
// repetitions and the typical interval. Entity state changes are rows of the same kind, manual
// markers are vertical lines. Wheel zooms, dragging pans, clicking a run shows the telegrams.
//
// The decodings of the browser store are part of the picture: a row is named after the
// definition that decodes it and its bars show the decoded values. Where several definitions fit
// (community layers, other device variants, unmet conditions), a badge opens the candidates in
// place: hovering one previews its decoding in the row, picking one puts it into the setup of
// this installation, whose drawer on the right exports the config files and entities.
import { api, app, append, bus, fmt, h, toast } from "./app.js";
import { hashColor, idLength, messageColors, valueColors } from "./colors.js";
import { lineOfRun } from "./decoder.js";
import { setup } from "./setup.js";
import { generateEbusdOptions, generateHaYaml } from "./hayaml.js";
import { defineEditor, customKey } from "./define-ui.js";
import { PRESETS as LOG_PRESETS, durationText, eventRange, fromMs, logCommand, timeText, toMs } from "./log.js";
import { drawChart, nearestPoint, seriesFields, seriesQuery, seriesValues } from "./chart.js";
import { KIND_HELP, accessKind, coverage, describeDifference, groupCandidates, rowTelegrams, summarizeFields, whyNot } from "./compare.js";

const ROW = 24;
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
    this.picker = null;         // the open candidate picker {row, el}
    this.drawerOpen = false;
    this.remembered = null;     // the time range whose runs were stored as occurrences
    this.loadToken = 0;
    this.loading = null;        // {from, to} while the runs of a window are being fetched
    this.seriesCache = new Map();    // value history of a row over the whole recording (candidate picker charts)
    this.seriesLoading = new Map();
    this.firstLoad = new Promise((resolve) => { this.markFirstLoad = resolve; });
    this.build();
    bus.on("decodes-changed", (reason) => { this.onDecodes(reason); });
    bus.on("goto-time", (ms) => { this.setFollowSilently(false); this.setWindow(ms - this.span / 2, ms + this.span / 2); });
    bus.on("setup-changed", () => { this.buildRows(); this.render(); this.renderPicker(); this.renderDrawer(); });
    bus.on("compile-state", (state) => { this.compileState = state; this.updateDecodeState(); });
    bus.on("settings-changed", () => { this.syncSettings(); this.load(true); });
    bus.on("status", () => this.updateInfo());
    window.addEventListener("resize", () => this.render());
    document.addEventListener("keydown", (e) => this.onKey(e));
    this.syncSettings();
    this.load(true);
    this.loadHistogram();
    setInterval(() => { if (this.follow && document.visibilityState === "visible" && this.root.classList.contains("active")) this.load(); }, 5000);
    setInterval(() => this.loadHistogram(), 60_000);
  }

  onShow() { this.render(); }

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
    el.decodeState = h("button", { class: "small state", title: "the definitions decoding this timeline (click for the definitions tab)", onclick: () => bus.emit("show-tab", "definitions") }, "definitions…");
    el.help = h("span", { class: "help", title: "Scroll: the rows\nCtrl/⌘ + scroll or pinch: zoom the time axis\nShift + scroll or sideways swipe: move in time\nDrag the chart: move in time; double click: zoom in\nOverview strip: drag the edges to resize the window, drag inside to move it, drag outside to select a new one\nKeys: ← → move, + − zoom, N live, Esc close" }, "?");
    el.progress = h("div", { class: "tl-progress", style: "visibility:hidden" }, h("div"));
    el.notice = h("div", { class: "tl-notice", style: "display:none" });
    el.logButton = h("button", { title: "note what you did or saw, like the log command of the eBUSd terminal: it appears as a flag in the events lane", onclick: () => this.toggleLog() }, "＋ event");
    el.logPop = h("div", { class: "tl-sources tl-log", style: "display:none" });
    el.sourcesButton = h("button", { class: "small", title: "where definitions come from: repository, pull requests, your own definitions", onclick: () => this.toggleSources() }, "Sources");
    el.sourcesPop = h("div", { class: "tl-sources", style: "display:none" });
    el.setupButton = h("button", { class: "small", title: "the definitions chosen for this installation: names, config files, Home Assistant entities", onclick: () => this.toggleDrawer() }, "Setup");
    el.toolbar = h("div", { class: "toolbar" },
      el.presets,
      h("span", { class: "group" }, h("button", { title: "zoom out (-)", onclick: () => this.zoom(2) }, "−"), h("button", { title: "zoom in (+)", onclick: () => this.zoom(0.5) }, "+"), el.follow),
      h("span", { class: "group" }, h("label", {}, "ID bytes"), el.idBytes, el.applyIds),
      h("span", { class: "group" }, el.filter),
      h("label", { class: "group" }, el.onlyChanges, " only changed"),
      h("span", { class: "group" }, el.sort),
      h("span", { class: "group" }, el.logButton),
      h("span", { class: "group", style: "margin-left:auto" }, el.decodeState, el.sourcesButton, el.setupButton, el.help),
      el.info);
    el.overviewCanvas = h("canvas");
    el.overview = h("div", { class: "tl-overview", title: "all recorded telegrams; click or drag to move the window" }, el.overviewCanvas);
    el.corner = h("div", { class: "corner" });
    el.axisCanvas = h("canvas");
    el.axis = h("div", { class: "tl-axis" }, el.corner, el.axisCanvas);
    el.annotCanvas = h("canvas");
    el.annot = h("div", { class: "tl-annot", title: "Home Assistant state changes and notes: hover for details, click an entity's flag for its history" }, h("div", { class: "corner" }, "events"), el.annotCanvas);
    el.labels = h("div", { class: "tl-labels" });
    el.plotCanvas = h("canvas");
    el.plot = h("div", { class: "tl-plot" }, el.plotCanvas);
    el.body = h("div", { class: "tl-body" }, h("div", { class: "tl-rows" }, el.labels, el.plot));
    el.popover = h("div", { class: "tl-pop", style: "display:none" });
    el.drawer = h("div", { class: "tl-drawer", style: "display:none" });
    el.stage = h("div", { class: "tl-stage" }, el.body, el.popover, el.drawer);
    el.tooltip = h("div", { class: "tl-tooltip" });
    el.details = h("div", { class: "tl-details" });
    this.root.appendChild(h("div", { class: "tl" }, el.toolbar, el.progress, el.overview, el.axis, el.annot, el.stage, el.details, el.tooltip, el.sourcesPop, el.logPop, el.notice));
    this.bindMouse();
    document.addEventListener("mousedown", (e) => { if (this.picker && !el.popover.contains(e.target) && !e.target.closest(".tl-label")) this.closePicker(); });
    document.addEventListener("mousedown", (e) => { if (el.sourcesPop.style.display !== "none" && !el.sourcesPop.contains(e.target) && !e.target.closest(".toolbar")) this.toggleSources(false); });
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
    this.renderPicker();
    this.renderDrawer();
  }

  /** What the app is busy with, in one place: loading, reading the recording, decoding, compiling, cloning. */
  activity() {
    const parts = [];
    let fraction = null;
    const repoBusy = app.status?.repo?.busy;
    if (repoBusy) parts.push(`${repoBusy.what}… ${fmt.duration((Date.now() - repoBusy.since * 1000))}`);
    if (this.compileState?.busy) parts.push(this.compileState.text);
    const st = app.decoder?.status();
    if (st?.progress) { parts.push(st.progress); fraction = st.fraction; }
    if (this.loading) parts.push(`loading telegrams ${fmt.time(this.loading.from).slice(0, 5)}–${fmt.time(this.loading.to).slice(0, 5)}`);
    return { parts, fraction, st };
  }

  updateDecodeState() {
    const el = this.el.decodeState;
    const { parts, fraction, st } = this.activity();
    let text, cls = "small state";
    if (parts.length) { text = parts.join(" · "); cls += " busy"; }
    else if (st?.error) { text = st.error; cls += " err"; }
    else if (this.compileState?.error) { text = this.compileState.error; cls += " err"; }
    else if (!st?.compile) { text = app.status?.repo?.exists ? "definitions not compiled yet" : "no definitions"; cls += " warn"; }
    else text = `${fmt.count(st.definitions)} definitions · ${fmt.count(st.known)} of ${fmt.count(st.telegrams)} telegrams known to ebusd${st.compile.layers?.length ? ` · ${st.compile.layers.join(", ")}` : ""}`;
    el.textContent = text;
    el.className = cls;
    el.title = st?.compile ? `${st.compile.summary || ""}\ncompiled ${st.compile.at ? fmt.dateTime(new Date(st.compile.at).getTime()) : ""}; ${st.decoded} of ${st.telegrams} distinct telegrams decoded; store: ${st.store}\nclick for the definitions tab` : "click for the definitions tab";
    const bar = this.el.progress;
    bar.style.visibility = parts.length ? "visible" : "hidden";   // its space stays: nothing moves when work starts or ends
    bar.classList.toggle("indeterminate", parts.length > 0 && (fraction === null || fraction === undefined));
    bar.firstChild.style.width = fraction === null || fraction === undefined ? "" : `${Math.max(3, Math.round(fraction * 100))}%`;
    const n = setup.includedKeys(app.decoder?.entries).length;
    this.el.setupButton.textContent = `Setup (${n})`;
    this.el.setupButton.classList.toggle("active", this.drawerOpen);
    this.updateNotice(st);
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

  /** A notice above the timeline while there is nothing to decode with: offers the way to get definitions right there. */
  updateNotice(st) {
    const el = this.el.notice;
    const repo = app.status?.repo;
    let key = null, build = null;
    if (st?.compile || this.compileState?.busy) delete this.since?.notcompiled;
    const pending = this.pendingIdLengths().length;
    if (!repo) key = null;
    else if (repo.busy && !repo.exists) {
      key = `busy:${repo.busy.what}`;
      build = () => [h("span", { class: "spinner" }), h("span", {}, `${repo.busy.what}… until the definitions are there nothing decodes the telegrams: rows show raw hex.`)];
    } else if (!repo.exists && !st?.compile) {
      key = `none:${repo.error || ""}`;
      build = () => {
        const url = h("input", { type: "text", placeholder: "or the URL of your own repository", size: 30, value: this.noticeUrl || "", oninput: () => { this.noticeUrl = url.value; } });
        return [repo.error ? h("span", { class: "err" }, repo.error) : null,
          h("span", {}, "No definitions yet: nothing decodes the telegrams, rows show raw hex. Start with"),
          h("button", { class: "small primary", onclick: () => app.views.definitions?.cloneRepo(app.settings?.upstream_url || "https://github.com/john30/ebusd-configuration.git") }, "the default definitions"),
          url, h("button", { class: "small", onclick: () => app.views.definitions?.cloneRepo(url.value) }, "use it"),
          h("span", {}, "or"), h("button", { class: "small", onclick: () => this.toggleSources(true) }, "paste my own definitions")];
      };
    } else if (!st?.compile && this.compileState?.error) {
      key = `error:${this.compileState.error}`;
      build = () => [h("span", { class: "err" }, `Compiling the definitions failed: ${this.compileState.error}`), h("button", { class: "small", onclick: () => bus.emit("show-tab", "definitions") }, "Open Definitions")];
    } else if (!st?.compile && !this.compileState?.busy && repo.exists && this.persistsFor("notcompiled", 2500)) {
      key = "notcompiled";
      build = () => [h("span", {}, "The definitions are not compiled yet, so rows show raw hex."), h("button", { class: "small primary", onclick: () => app.views.definitions?.compile() }, "Compile")];
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
    try {
      app.settings = await api.put("api/settings", { id_rules: rules });
      this.syncSettings();
      this.closePicker();
      bus.emit("settings-changed");
      this.load(true);
    } catch (err) { toast(err.message, "err"); }
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
      if (this.data.truncated) parts.push(`⚠ window cut at ${fmt.time(this.data.to_ms)} (row limit), zoom in`);
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
    const from = Math.floor(this.t0), to = Math.ceil(this.t1);
    // a newer window makes the older request pointless: abort it so that the device stops working on it
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.loading = { from, to };
    this.updateDecodeState();
    try {
      const [runs, events] = await Promise.all([
        api.get(`api/telegrams/runs?from=${from}&to=${to}`, { signal: abort.signal }),
        api.get(`api/events?from=${from - EVENT_LOOKBACK}&to=${to}`, { signal: abort.signal }),
      ]);
      if (token !== this.loadToken) return;
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
    if (!app.decoder?.store) return;
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
    const telegramRows = [];
    for (const row of this.data?.rows || []) {
      const key = `${fmt.hex(row.qq)}→${fmt.hex(row.zz)} ${fmt.hex(row.pb)}${fmt.hex(row.sb)} ${row.id}`;
      const runs = row.runs.map((r) => {
        const [payload, slave, status] = r[3].split("/");
        const label = payload && slave ? `${payload} / ${slave}` : payload || slave || (status === "ok" ? "(no data)" : status);
        const run = { t0: r[0], t1: r[1], n: r[2], value: r[3], payload, slave, status, mean: r[4], min: r[5], label, line: null };
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
    this.rows = rows.concat(telegramRows);
    if (this.selected?.row.kind === "telegram") {
      const same = this.rows.find((r) => r.key === this.selected.row.key);
      if (same) this.selected.row = same; else this.closeDetails();
    }
    if (this.picker) this.picker.row = this.rows.find((r) => r.key === this.picker.row.key) || null;
    if (this.picker && !this.picker.row) this.closePicker();
    this.renderLabels();
  }

  /** The definition a row is shown with: the chosen one, else what ebusd uses, else an included candidate. */
  rowDefinition(rowKey, candidates) {
    if (!candidates.size) return null;
    const chosen = setup.chosenFor(rowKey);
    if (chosen && candidates.has(chosen)) return chosen;
    let best = null;
    for (const [key, c] of candidates) if (c.used && (!best || c.used > candidates.get(best).used)) best = key;
    if (best) return best;
    const included = setup.includedSet;
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
    const d = this.decodeOf(row, run);
    if (!d) return run.label;
    return d.result === "ok" ? (d.text || "(empty)") : `✗ ${d.result}`;
  }

  matches(key, name) {
    if (!this.filter) return true;
    const haystack = `${key} ${name}`.toLowerCase();
    return this.filter.split(/\s+/).every((word) => haystack.includes(word) || haystack.replace(/[→ ]/g, "").includes(word));
  }

  renderLabels() {
    const labels = this.el.labels;
    labels.replaceChildren();
    for (const [i, row] of this.rows.entries()) {
      const n = row.candidates ? row.candidates.size : 0;
      const renamed = row.def && setup.exportName(row.def) !== row.def.name;
      const title = row.kind === "telegram"
        ? `${row.label}${row.def ? `\n${row.name}${renamed ? ` (upstream: ${row.def.circuit} ${row.def.name})` : ""}\n${row.def.file}${row.def.source !== "base" ? ` from ${row.def.source}` : ""} — ${row.def.status}: ${STATUS_HELP[row.def.status] || ""}` : ""}${n ? `\n${n} candidate definition${n > 1 ? "s" : ""}: click to compare and choose` : "\nno definition decodes this row"}`
        : (row.name ? `${row.label}\n${row.name}` : row.label);
      const badge = row.kind === "telegram" && (n > 1 || (n > 0 && !row.defKey))
        ? h("span", { class: `cands ${row.defKey ? "" : "warn"}`, title: `${n} candidate definitions — click to compare and choose`, onclick: (e) => { e.stopPropagation(); this.openPicker(row, e.currentTarget.closest(".tl-label")); } }, `${n}▾`)
        : null;
      const el = h("div", { class: `tl-label ${row.kind} ${this.picker?.row === row ? "picking" : ""}`, title, "data-row": i,
        onclick: (e) => {
          if (row.kind === "telegram" && n && e.target.closest(".name")) this.openPicker(row, e.currentTarget);
          else if (row.kind === "telegram" && !n && row.row.zz !== null) this.openEditor(row);   // no definition: define it from what the recording shows
          else this.showDetails(row, null);
        } },
        row.kind === "telegram" ? h("span", { class: "pivot" },
          h("button", { title: row.row.id ? (row.row.id.length > 2 ? `combine with the rows that share the first ${row.row.id.length / 2 - 1} byte${row.row.id.length / 2 === 2 ? "" : "s"} of the message ID (−)` : "combine all rows of this command into one (−)") : "nothing to combine: no ID byte", disabled: !row.row.id, onclick: (e) => { e.stopPropagation(); this.combineRow(row); } }, "−"),
          h("button", { title: `split by the next byte after ${row.row.id || "the command"} (+)`, disabled: !row.runs.some((r) => r.payload), onclick: (e) => { e.stopPropagation(); this.splitRow(row); } }, "+")) : null,
        h("span", { class: "key" }, row.label),
        row.name ? h("span", { class: `name ${renamed ? "renamed" : ""}`, style: row.def ? `color:${messageColors(row.def.circuit, row.def.name).text}` : "" }, row.name) : null,
        badge,
        row.kind === "telegram" && !n && row.row.zz !== null ? h("span", { class: "define", title: "no definition decodes this message: click to define it from the recording" }, "＋ define") : null,
        h("span", { class: "n" }, `${fmt.count(row.n)}${row.runs.length > 1 ? ` · ${row.runs.length - 1}Δ` : ""}`));
      labels.appendChild(el);
    }
    if (!this.rows.length) {
      const db = app.status?.db;
      const hint = !db?.exists || !db?.has_telegram_table
        ? h("div", { class: "empty" }, "No telegrams recorded yet. Set ", h("code", {}, `sqlite_db: ${db?.path || "/share/ebusd/telegrams.db"}`), " in the eBUSd app configuration (SQLite telegram log) and restart it.")
        : h("div", { class: "empty" }, this.data ? "No telegrams in this time window." : "Loading…");
      labels.appendChild(hint);
    }
  }

  // -- drawing ---------------------------------------------------------------------------

  xOf(t) { return (t - this.t0) / this.span * this.width; }
  tOf(x) { return this.t0 + x / this.width * this.span; }

  sizeCanvas(canvas, width, height) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
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
    if (!this.root.classList.contains("active")) return;
    this.width = Math.max(50, this.el.plot.clientWidth || (this.el.body.clientWidth - this.el.labels.offsetWidth));
    if (this.width !== this.lastWidth) { this.lastWidth = this.width; }
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

  drawPlot() {
    const height = Math.max(this.rows.length * ROW, this.el.body.clientHeight - 2);
    const ctx = this.sizeCanvas(this.el.plotCanvas, this.width, height);
    this.el.labels.style.minHeight = `${height}px`;
    ctx.clearRect(0, 0, this.width, height);
    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
    const { ticks } = this.ticks();
    ctx.strokeStyle = "#eef1f4";
    for (const t of ticks) {
      const x = Math.round(this.xOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (const [i, row] of this.rows.entries()) {
      const y = i * ROW;
      if (row.kind === "event") { ctx.fillStyle = "#fbf7ee"; ctx.fillRect(0, y, this.width, ROW); }
      if (this.selected && this.selected.row === row) { ctx.fillStyle = "#e3f1fc"; ctx.fillRect(0, y, this.width, ROW); }
      ctx.strokeStyle = "#eef1f4"; ctx.beginPath(); ctx.moveTo(0, y + ROW - 0.5); ctx.lineTo(this.width, y + ROW - 0.5); ctx.stroke();
      this.drawRuns(ctx, row, y);
    }
    for (const marker of this.allMarkers()) {
      if ((marker.ms_max ?? marker.ms) < this.t0 || (marker.ms_min ?? marker.ms) > this.t1) continue;
      const x0 = this.xOf(marker.ms_min ?? marker.ms), x1 = this.xOf(marker.ms_max ?? marker.ms);
      if (x1 - x0 > 1.5) { ctx.fillStyle = "rgba(239,108,0,.12)"; ctx.fillRect(x0, 0, x1 - x0, height); }
      const x = Math.round(this.xOf(marker.ms)) + 0.5;
      ctx.setLineDash([4, 3]); ctx.strokeStyle = "#ef6c00";
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
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
      ctx.strokeStyle = "rgba(11,125,218,.5)"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    if (this.hover && this.hover.x !== undefined) {
      const x = Math.round(this.hover.x) + 0.5;
      ctx.strokeStyle = "rgba(31,45,61,.35)"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
  }

  drawRuns(ctx, row, y) {
    const top = y + 4, barHeight = ROW - 8;
    for (const [j, run] of row.runs.entries()) {
      if (run.t1 < this.t0 || run.t0 > this.t1) continue;
      const x0 = this.xOf(run.t0), x1 = this.xOf(run.t1);
      const { fill, stroke } = valueColors(run.value, run.status);
      const next = row.runs[j + 1];
      if (next && row.kind === "telegram") {
        // the value holds until the next (different) telegram
        const nx = this.xOf(next.t0);
        ctx.strokeStyle = stroke; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(Math.max(x1, x0 + 2), top + barHeight / 2 + 0.5); ctx.lineTo(nx, top + barHeight / 2 + 0.5); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (run.n === 1 && row.kind === "telegram") {
        ctx.fillStyle = stroke;
        ctx.fillRect(Math.round(x0) - 1, top, 2, barHeight);
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
      if (width > 28) {
        ctx.save(); ctx.beginPath(); ctx.rect(left + 2, top, width - 4, barHeight); ctx.clip();
        ctx.fillStyle = "#1f2d3d";
        let text = this.runLabel(row, run);
        if (row.kind === "telegram") {
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
    if (!this.root.classList.contains("active") || e.target.closest("input, textarea, select")) return;
    if (e.key === "ArrowLeft") this.pan(-0.2);
    else if (e.key === "ArrowRight") this.pan(0.2);
    else if (e.key === "+" || e.key === "=") this.zoom(0.5);
    else if (e.key === "-") this.zoom(2);
    else if (e.key === "n" || e.key === "N") this.setFollow(true);
    else if (e.key === "Escape") { if (this.editor) this.closeEditor(); else if (this.picker) this.closePicker(); else if (this.drawerOpen) this.toggleDrawer(false); else this.closeDetails(); }
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
    const end = row.kind === "telegram" && found.n === 1 ? found.t0 : found.t1;
    if (t <= end + tolerance) return found;
    return null;
  }

  hoverAt(e) {
    const index = Math.floor(e.offsetY / ROW);
    const row = this.rows[index];
    const run = row ? this.runAt(row, e.offsetX) : null;
    this.hover = { x: e.offsetX, row, run };
    const tip = this.el.tooltip;
    const t = this.tOf(e.offsetX);
    let text = fmt.dateTime(t, this.span < 60e3);
    const marker = this.markers.find((m) => Math.abs(this.xOf(m.ms) - e.offsetX) < 4 || ((m.ms_min ?? m.ms) <= t && t <= (m.ms_max ?? m.ms) && m.ms_max - m.ms_min > 1000));
    if (marker) {
      text = `${marker.message || "(time only)"}\n${fmt.dateTime(marker.ms)}` + (marker.ms_max > marker.ms_min ? ` (between ${fmt.time(marker.ms_min)} and ${fmt.time(marker.ms_max)})` : "");
    } else if (row && run) {
      if (row.kind === "telegram") {
        const d = this.decodeOf(row, run);
        const others = row.candidates ? [...row.candidates.values()].filter((c) => c.def.key !== row.defKey).slice(0, 4) : [];
        text = `${row.label}${row.name ? `  ${row.name}` : ""}\n${d ? `${d.result === "ok" ? d.text || "(empty)" : `✗ ${d.result}`}\n` : ""}${run.label}${run.status !== "ok" ? `  [${run.status}]` : ""}\n`
          + (run.n === 1 ? `once at ${fmt.time(run.t0, true)}` : `${fmt.count(run.n)}× from ${fmt.time(run.t0)} to ${fmt.time(run.t1)} (${fmt.duration(run.t1 - run.t0)})`
          + (run.mean ? `\nevery ${fmt.duration(run.mean)} (shortest ${fmt.duration(run.min)})` : ""))
          + (others.length ? `\n\nother candidates:${others.map((c) => { const od = app.decoder.decodesOf(run.line)?.get(c.def.key); return `\n  ${c.def.circuit} ${c.def.name} (${c.def.status}): ${od ? (od.result === "ok" ? od.text : `✗ ${od.result}`) : "—"}`; }).join("")}${row.candidates.size > 5 ? `\n  … ${row.candidates.size - 5} more` : ""}` : "");
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
    const row = this.rows[Math.floor(e.offsetY / ROW)];
    if (!row) return;
    this.showDetails(row, this.runAt(row, e.offsetX));
  }

  closeDetails() {
    this.selected = null;
    this.el.details.classList.remove("open");
    this.el.details.replaceChildren();
    this.drawPlot();
  }

  async showDetails(row, run) {
    this.selected = { row, run };
    this.drawPlot();
    const details = this.el.details;
    details.classList.add("open");
    const from = run ? run.t0 : Math.floor(this.t0), to = run ? run.t1 + 1 : Math.ceil(this.t1);
    const head = h("div", { class: "head" },
      h("span", { class: "mono" }, row.label), row.name ? h("span", { class: "name" }, row.name) : null,
      run ? h("span", { class: "muted" }, run.n === 1 ? fmt.dateTime(run.t0, true) : `${fmt.count(run.n)}× ${fmt.dateTime(run.t0)} – ${fmt.time(run.t1)}`) : h("span", { class: "muted" }, "visible window"),
      h("span", { style: "margin-left:auto" }),
      row.kind === "telegram" && row.candidates?.size ? h("button", { class: "small", onclick: (e) => this.openPicker(row, e.currentTarget) }, `${row.candidates.size} candidate${row.candidates.size > 1 ? "s" : ""} ▾`) : null,
      row.kind === "telegram" ? h("button", { class: "small", onclick: () => this.idMenu(row) }, `ID bytes for ${fmt.hex(row.row.pb)}${fmt.hex(row.row.sb)}: ${idLength(row.row.pb, row.row.sb, this.settings)}`) : null,
      h("button", { class: "small", onclick: () => this.closeDetails() }, "✕"));
    details.replaceChildren(head, h("div", { class: "muted", style: "padding:8px 10px" }, "loading…"));
    if (row.kind === "event") {
      const table = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "time"), h("th", {}, "state"), h("th", {}, "previous"), h("th", {}, "source"), h("th", {}, "attributes"))),
        h("tbody", {}, row.runs.filter((r) => !run || r === run).map((r) => h("tr", {},
          h("td", { class: "mono" }, fmt.dateTime(r.t0, true)), h("td", {}, r.event.state ?? ""), h("td", {}, r.event.previous ?? ""), h("td", {}, r.event.source),
          h("td", { class: "mono", style: "white-space:normal" }, JSON.stringify(r.event.attributes || {}).slice(0, 300))))));
      details.replaceChildren(head, table);
      return;
    }
    const r = row.row;
    try {
      const result = await api.get(`api/telegrams?from=${from}&to=${to}&qq=${fmt.hex(r.qq)}&zz=${fmt.hex(r.zz)}&pb=${fmt.hex(r.pb)}&sb=${fmt.hex(r.sb)}&id=${encodeURIComponent(r.id)}&limit=500&order=ASC`);
      const telegrams = result.telegrams;
      const decodedText = (t) => {
        if (!t.master || !row.defKey || !app.decoder) return "";
        const d = app.decoder.decodesOf(`${t.master}${t.slave ? "/" + t.slave : ""}`)?.get(row.defKey);
        return d ? (d.result === "ok" ? d.text : `✗ ${d.result}`) : "";
      };
      const table = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "time"), h("th", {}, "type"), h("th", {}, "master (QQ ZZ PB SB NN DD)"), h("th", {}, "slave (NN DD)"), h("th", {}, "status"), h("th", {}, row.name ? `decoded as ${row.name}` : "decoded"))),
        h("tbody", {}, telegrams.map((t) => h("tr", {},
          h("td", { class: "mono" }, fmt.dateTime(t.ms, true)), h("td", {}, t.type || ""),
          h("td", { class: "mono" }, t.master || t.dd || ""), h("td", { class: "mono" }, t.slave || ""),
          h("td", { class: t.status === "ok" ? "ok" : "err" }, t.status),
          h("td", { class: "mono", style: "white-space:normal" }, decodedText(t))))));
      const note = telegrams.length >= 500 ? h("div", { class: "hint", style: "padding:4px 10px" }, "showing the first 500 telegrams") : null;
      details.replaceChildren();
      append(details, head, table, note);
    } catch (err) {
      details.replaceChildren(head, h("div", { class: "err", style: "padding:8px 10px" }, err.message));
    }
  }

  // -- sources popover: where definitions come from, always at hand ------------------------------------------

  toggleSourcesOff() { if (this.el.sourcesPop.style.display !== "none") this.toggleSources(false); }

  /** Put a popover just below the toolbar (it wraps on narrow windows) so that it never covers its own button. */
  placePopover(pop) {
    pop.style.top = `${this.el.toolbar.offsetTop + this.el.toolbar.offsetHeight + 4}px`;
  }

  toggleSources(open = this.el.sourcesPop.style.display === "none") {
    const pop = this.el.sourcesPop;
    pop.style.display = open ? "" : "none";
    if (open) this.placePopover(pop);
    this.el.sourcesButton.classList.toggle("active", open);
    const definitions = app.views.definitions;
    if (open && definitions) definitions.mountSources(pop, true);
    else if (definitions) definitions.unmountSources(pop);
  }

  // -- definition editor: a message without a definition, prefilled from the recording ----------------------------

  openEditor(row) {
    this.closePicker();
    this.editor = { row };
    this.renderEditor();
  }

  closeEditor() {
    this.editor = null;
    this.el.popover.style.display = "none";
    this.el.popover.classList.remove("wide");
    this.el.popover.replaceChildren();
    this.renderLabels();
  }

  renderEditor() {
    const pop = this.el.popover;
    const row = this.editor?.row;
    if (!row) return;
    const decoder = app.decoder;
    const telegrams = rowTelegrams(decoder, row.row);
    pop.classList.add("wide");
    pop.replaceChildren();
    append(pop,
      h("div", { class: "head" }, h("b", {}, "New definition"), h("span", { style: "margin-left:auto" }), h("button", { class: "small", onclick: () => this.closeEditor() }, "✕")),
      h("div", { class: "pad" }, defineEditor({
        row, telegrams, scan: decoder.scan || {}, own: app.settings?.own_address || "31", decoder,
        onClose: () => this.closeEditor(),
        onSave: async (csv, header) => {
          await app.views.definitions.addCustomLine(csv);
          const key = customKey(header);
          const entries = decoder.entries;
          const others = [...decoder.candidatesOf(telegrams.map((t) => t.line)).keys()];
          if (decoder.def(key)) { setup.choose(row.key, key, others, entries); toast(`${header.circuit} ${header.name} added to your definitions and chosen for this row`); }
          else toast("saved, but it decodes none of this row's telegrams: check the line", "err", 6000);
          this.closeEditor();
        },
      })));
    pop.style.display = "block";
    const stageTop = this.el.stage.getBoundingClientRect().top;
    pop.style.top = `${Math.max(0, 6 - 0 * stageTop)}px`;
    pop.style.left = `${Math.max(0, Math.min(40, this.el.stage.clientWidth - pop.offsetWidth - 10))}px`;
  }

  // -- candidate picker: the definitions that decode a row, compared and chosen in place ---------

  openPicker(row, anchor) {
    if (!row.candidates?.size) return;
    this.editor = null;
    this.el.popover.classList.remove("wide");
    this.picker = { row, anchorTop: anchor ? anchor.getBoundingClientRect().top : 0 };
    this.renderPicker();
    this.renderLabels();
  }

  closePicker() {
    this.picker = null;
    this.preview = null;
    this.el.popover.style.display = "none";
    this.el.popover.replaceChildren();
    this.renderLabels();
    this.drawPlot();
  }

  setPreview(row, defKey) {
    const next = defKey ? { rowKey: row.key, defKey } : null;
    if ((this.preview?.defKey || null) === (next?.defKey || null)) return;
    this.preview = next;
    this.drawPlot();
  }

  /** Rename form of a definition: the message name and a table of its fields with their latest values. */
  renameForm(def, values = null, onDone = null) {
    const nameInput = h("input", { type: "text", value: setup.exportName(def), size: 26,
      onchange: () => setup.rename(def, nameInput.value), onkeydown: (e) => { if (e.key === "Enter") { setup.rename(def, nameInput.value); onDone?.(); } } });
    const map = setup.fieldMap(def);
    const rows = (def.fields || []).map((field) => {
      const input = h("input", { type: "text", value: map[field], size: 22, onchange: () => setup.renameField(def, field, input.value) });
      return h("tr", {}, h("td", { class: "mono muted" }, field), h("td", {}, input), h("td", { class: "mono muted" }, values && field in values ? String(values[field]) : ""));
    });
    return h("div", { class: "rename" },
      h("div", { class: "kv-row" }, h("label", {}, "Message name in my config"), nameInput, h("span", { class: "muted" }, `upstream: ${def.name}`)),
      rows.length ? h("table", { class: "fieldnames" }, h("thead", {}, h("tr", {}, h("th", {}, "Field (upstream)"), h("th", {}, "Field name in my config"), h("th", {}, values ? "Latest value" : ""))), h("tbody", {}, rows)) : h("div", { class: "muted" }, "This message has no named fields."),
      h("div", { class: "muted" }, "Names end up in the exported CSV, the MQTT topics (ebusd/<circuit>/<message>) and the JSON fields (value_json.<field>)."));
  }

  /** The definition as ebusd reads it, and a way to copy it into your own definitions to change it. */
  rawPanel(def, group) {
    const lines = [def.csv, ...(def.siblings || []).map((k) => app.decoder.def(k)?.csv).filter(Boolean)];
    const area = h("textarea", { rows: Math.min(8, lines.length + 1), class: "rawcsv", spellcheck: "false" });
    area.value = lines.join("\n");
    return h("div", { class: "rawpanel" },
      h("div", { class: "muted" }, `${def.file}${def.condition ? ` ${def.condition}` : ""} — edit the text and add it as your own definition: it is decoded over the whole recording at once and shows here as a candidate of its own${def.write ? "; this is a write definition, it changes the device when ebusd sends it" : ""}.`),
      area,
      h("div", { class: "row" }, h("button", { class: "small primary", onclick: async () => { await app.views.definitions.addCustomLine(area.value); toast("added to your definitions"); } }, "Add as my definition"),
        h("button", { class: "small", onclick: () => navigator.clipboard?.writeText(area.value).then(() => toast("copied")) }, "copy")));
  }

  /** Value history of a definition over the whole recording as a chart: one point per telegram, by its timestamp. */
  historyChart(row, defKey, groupKey) {
    const db = app.status?.db;
    const box = h("div", { class: "history" });
    if (!db?.first_ms) return null;
    const from = db.first_ms, to = db.last_ms + 1000;
    const cacheKey = `${row.key}|${from}|${Math.floor(to / 60000)}`;
    const decoder = app.decoder;
    const draw = (data) => {
      const fields = seriesFields(data, decoder, defKey);
      let field = this.picker?.fields?.[groupKey];
      if (!field || !fields.includes(field)) field = fields.find((f) => seriesValues(data, decoder, defKey, f).numeric) || fields[0];
      const series = seriesValues(data, decoder, defKey, field);
      const select = fields.length > 1 ? h("select", { onchange: () => { (this.picker.fields ||= {})[groupKey] = select.value; draw(data); } }, fields.map((f) => h("option", { value: f, selected: f === field }, f))) : null;
      const canvas = h("canvas");
      const info = h("div", { class: "hint" });
      const width = Math.max(320, (this.el.popover.clientWidth || 700) - 60);
      let geometry = null;
      const paint = (hoverMs = null) => { geometry = drawChart(canvas, series, { t0: from, t1: to, width, height: 120, band: { from: this.t0, to: this.t1 }, hoverMs }); };
      const summary = () => {
        const values = series.points.map((p) => p.value);
        const range = series.numeric && values.length ? ` · ${Math.min(...values)} … ${Math.max(...values)}` : "";
        info.textContent = `${fmt.count(series.points.length)} telegrams of this definition${data.stride > 1 ? ` (every ${data.stride}th of ${fmt.count(data.total)})` : ""}${range} · the blue band is the timeline window; click to go there`;
      };
      summary();
      canvas.addEventListener("mousemove", (e) => {
        const ms = geometry.tOf(e.offsetX), p = nearestPoint(series, ms);
        paint(ms);
        info.textContent = p ? `${fmt.dateTime(p.ms)}  ${series.field ? `${series.field} = ` : ""}${p.value}` : "";
      });
      canvas.addEventListener("mouseleave", () => { paint(); summary(); });
      canvas.addEventListener("click", (e) => bus.emit("goto-time", geometry.tOf(e.offsetX)));
      box.replaceChildren();
      append(box, h("div", { class: "row" }, h("b", {}, "History"), select ? [" of field ", select] : null), canvas, info);
      paint();
    };
    const cached = this.seriesCache.get(cacheKey);
    if (cached) { draw(cached); return box; }
    box.textContent = "loading history…";
    let pending = this.seriesLoading.get(cacheKey);
    if (!pending) {
      pending = api.get(seriesQuery(row.row, from, to)).then((data) => { this.seriesCache.set(cacheKey, data); return data; });
      this.seriesLoading.set(cacheKey, pending);
      pending.finally(() => this.seriesLoading.delete(cacheKey));
    }
    pending.then((data) => { if (box.isConnected) draw(data); }).catch((err) => { box.textContent = `history failed: ${err.message}`; });
    return box;
  }

  /** The value ranges of a candidate over the whole recording. */
  valuesDetail(cov) {
    const fields = summarizeFields(cov);
    const top = [...cov.values.values()].sort((a, b) => b.n - a.n).slice(0, 25);
    return h("div", { class: "allvalues" },
      fields.length ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Field"), h("th", {}, "Over the whole recording"))),
        h("tbody", {}, fields.map((f) => h("tr", {}, h("td", { class: "mono" }, f.name),
          h("td", { class: "mono" }, f.kind === "range" ? `${f.min} … ${f.max}  (${fmt.count(f.distinct)} distinct)` : f.top.map(([v, n]) => `${v} ×${fmt.count(n)}`).join(", ") + (f.distinct > f.top.length ? `, … ${f.distinct - f.top.length} more` : "")))))) : null,
      h("div", { class: "muted", style: "margin-top:4px" }, `${fmt.count(cov.values.size)}${cov.truncated ? "+" : ""} distinct decoded values${top.length < cov.values.size ? `, the ${top.length} most frequent:` : ":"}`),
      h("div", { class: "values-list mono" }, top.map((v) => h("div", {}, h("span", { class: "n" }, `×${fmt.count(v.n)}`), ` ${v.text}`))));
  }

  renderPicker() {
    const pop = this.el.popover;
    if (this.editor) return;      // the definition editor is open: it keeps its own state
    if (!this.picker || !this.picker.row) { pop.style.display = "none"; return; }
    const row = this.picker.row;
    const decoder = app.decoder;
    const entries = decoder?.entries || [];
    const included = new Set(setup.includedKeys(entries));
    const scan = decoder.scan || {};
    // every recorded telegram of the row, not only the ones in the visible window
    const telegrams = rowTelegrams(decoder, row.row);
    const all = decoder.candidatesOf(telegrams.map((t) => t.line));
    for (const [key, c] of row.candidates || []) if (!all.has(key)) all.set(key, c);
    const lastRun = row.runs[row.runs.length - 1];
    const sample = [...row.runs].reverse().find((r) => r.t1 >= this.t0 && r.t0 <= this.t1) || lastRun;
    const usedKey = [...all.values()].find((c) => c.used)?.def.key || null;
    const candidates = [...all.values()];
    const otherKeys = candidates.map((c) => c.def.key);
    const { groups } = groupCandidates(decoder, candidates, telegrams, { chosenKey: row.defKey, usedKey });
    const total = telegrams.reduce((n, t) => n + (t.n || 0), 0);
    const lead = groups.find((g) => g.hasUsed) || groups[0];
    const usedDef = candidates.find((c) => c.def.key === usedKey)?.def || null;
    const firstCard = groups.find((g) => !g.failed);

    const member = (m, group) => {
      const def = m.def, key = def.key;
      const chosen = key === row.defKey;
      const colors = messageColors(def.circuit, def.name);
      const exportName = setup.exportName(def);
      const renameOpen = this.picker.renaming === key;
      const d = m.coverage?.latest || null;
      const why = !chosen && key !== usedKey ? whyNot(def, scan, group.failed ? m.coverage.errorKinds : null, usedDef) : "";
      const fieldNote = group.fieldNames ? fieldNamesOf(def) : "";
      return h("div", { class: `member ${chosen ? "chosen" : ""}`, onmouseenter: () => this.setPreview(row, key), onmouseleave: () => this.setPreview(row, null) },
        h("div", { class: "line" },
          h("button", { class: `pick ${chosen ? "on" : ""}`, title: chosen ? "shown in this row and part of the setup" : "use this definition for this row (it joins the setup, the other candidates leave it)",
            onclick: () => setup.choose(row.key, key, otherKeys, entries) }, chosen ? "●" : "○"),
          h("span", { class: "chip-msg", style: `color:${colors.text};background:${colors.background};border-color:${colors.border}` }, `${def.circuit} ${def.name}`),
          h("span", { class: `badge kind ${def.write ? "write" : ""}`, title: KIND_HELP[accessKind(def)] }, accessKind(def)),
          exportName !== def.name ? h("span", { class: "export" }, `→ ${setup.circuitOf(def)} ${exportName}`) : null,
          h("span", { class: "muted mono", title: def.file }, def.file.replace(/^.*\//, "")),
          h("span", { class: `badge ${def.status}`, title: STATUS_HELP[def.status] || "" }, def.status),
          def.source !== "base" ? h("span", { class: "badge", title: "added or changed by this community layer" }, def.source) : null,
          key === usedKey ? h("span", { class: "muted", title: "the definition ebusd itself picks for these telegrams" }, "ebusd's choice") : null,
          h("span", { style: "margin-left:auto" }),
          h("label", { class: "muted", title: "part of the setup of this installation (without changing what this row shows)" },
            h("input", { type: "checkbox", checked: included.has(key), onchange: (e) => setup.include(key, e.target.checked, entries) }), " in setup"),
          h("button", { class: "small", title: "rename the message and its fields for my config", onclick: () => { this.picker.renaming = renameOpen ? null : key; this.renderPicker(); } }, renameOpen ? "done" : "rename")),
        fieldNote ? h("div", { class: "muted mono note" }, `fields: ${fieldNote}`) : null,
        why ? h("div", { class: "why" }, why) : null,
        renameOpen ? this.renameForm(def, d?.fields || null, () => { this.picker.renaming = null; this.renderPicker(); }) : null);
    };
    const fieldNamesOf = (def) => (def.fields || []).join(", ");

    const rowId = (row.row.id || "").length / 2;
    const longer = Math.max(0, ...candidates.map((c) => c.def.idlen || 0));
    const isLumped = longer > rowId;   // different messages share the row: the groups are not competing for the same telegrams
    const hideFailing = !!app.settings?.ui?.hideFailing;
    const partial = (g) => hideFailing && !g.failed && g.coverage.errors > 0 && !g.hasChosen;
    const SHORT = { active: "ebusd uses it", variant: "other device variant", conditional: "condition not met", hidden: "overridden by another", error: "fails" };
    const base = (file) => file.replace(/^.*\//, "");
    const cards = groups.filter((g) => !g.failed && !partial(g)).map((g) => {
      const cov = g.coverage;
      // one definition, possibly defined in several files (one per device variant) and under several circuit names
      const pref = g.members.find((m) => m.def.key === row.defKey) || g.members.find((m) => m.def.key === usedKey) || g.members.find((m) => !m.def.write) || g.members[0];
      const def = pref.def;
      const latest = coverage(decoder, telegrams, def.key).latest;
      const key = `${g.key}`;
      const open = this.picker.expanded?.has(key);
      const chosen = g.hasChosen;
      const names = [...new Set(g.members.map((m) => `${m.def.circuit} ${m.def.name}`))];
      const kinds = [...new Set(g.members.map((m) => accessKind(m.def)))];
      const firstPref = firstCard && firstCard !== g ? (firstCard.members.find((m) => m.def.key === usedKey) || firstCard.members[0]) : null;
      const differences = firstPref ? describeDifference(def, firstPref.def) : [];
      const sameValues = firstPref ? firstCard.coverage.signature === cov.signature : null;
      const files = g.members.map((m) => ({ file: base(m.def.file), status: m.def.status, key: m.def.key, source: m.def.source }));
      const usedM = g.members.find((m) => m.def.key === usedKey);
      const colors = messageColors(def.circuit, def.name);
      const exportName = setup.exportName(def);
      const renameOpen = this.picker.renaming === def.key;
      const filesOpen = this.picker.filesOpen?.has(key) ?? names.length > 1;   // different names matter for the export: show them
      const sentence = g.members.length === 1
        ? (usedM ? "ebusd uses this definition." : whyNot(def, scan, null))
        : usedM
          ? `One definition, defined identically in ${files.length} files for different device variants. ebusd uses it from ${base(usedM.def.file)}; the others are for other hardware or software versions than the ones identified on this bus.`
          : `One definition, defined identically in ${files.length} files. ${whyNot(def, scan, null)}`;
      return h("div", { class: `group ${chosen ? "chosen" : ""}`, onmouseenter: () => this.setPreview(row, def.key), onmouseleave: () => this.setPreview(row, null) },
        h("div", { class: "ghead" },
          h("button", { class: `pick ${chosen ? "on" : ""}`, title: chosen ? "shown in this row and part of the setup" : "use this definition for this row (it joins the setup, the other candidates leave it)",
            onclick: () => setup.choose(row.key, def.key, otherKeys, entries) }, chosen ? "●" : "○"),
          names.map((n) => { const c = messageColors(...n.split(/ (.+)/).slice(0, 2)); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, n); }),
          kinds.map((k) => h("span", { class: `badge kind ${k.includes("write") ? "write" : ""}`, title: KIND_HELP[k] }, k)),
          exportName !== def.name ? h("span", { class: "export" }, `→ ${setup.circuitOf(def)} ${exportName}`) : null,
          g.hasUsed ? h("span", { class: "badge active" }, "ebusd's choice") : null,
          h("span", { style: "margin-left:auto" }),
          h("button", { class: "small", title: def.source === "custom" ? "edit your own definitions" : "open the TypeSpec source of this definition at its line", onclick: () => bus.emit("open-source", def) }, "source ↗"),
          h("button", { class: "small", title: "the definition as ebusd reads it (CSV), to copy or edit as your own", onclick: () => { (this.picker.raw ||= new Set())[this.picker.raw.has(def.key) ? "delete" : "add"](def.key); this.renderPicker(); } }, "raw"),
          h("label", { class: "muted", title: "part of the setup of this installation" },
            h("input", { type: "checkbox", checked: included.has(def.key), onchange: (e) => setup.include(def.key, e.target.checked, entries) }), " in setup"),
          h("button", { class: "small", title: "rename the message and its fields for my config", onclick: () => { this.picker.renaming = renameOpen ? null : def.key; this.renderPicker(); } }, renameOpen ? "done" : "rename")),
        h("div", { class: "decoded mono" }, latest ? latest.text : h("span", { class: "err" }, "decodes nothing of this row"),
          latest ? h("span", { class: "muted", title: latest.line }, `  (latest, ${fmt.dateTime(latest.last_ms).slice(5, 16)})`) : null),
        h("div", { class: `cover ${cov.errors ? "warn" : "ok"}` },
          cov.errors ? `decodes ${fmt.count(cov.ok)} of ${fmt.count(cov.distinct)} recorded variants, fails for ${fmt.count(cov.errors)} (${[...cov.errorKinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")})`
            : `decodes all ${fmt.count(cov.ok)} recorded variants without error`,
          h("span", { class: "muted" }, ` · ${fmt.count(cov.okOccurrences)} telegrams${cov.first_ms ? `, ${fmt.date(cov.first_ms)} – ${fmt.date(cov.last_ms || cov.first_ms)}` : ""}`),
          cov.decoded < cov.telegrams ? h("span", { class: "muted", title: "the other telegrams of this row belong to other messages (see the note above)" }, ` · matches ${fmt.count(cov.decoded)} of the row's ${fmt.count(cov.telegrams)} variants`) : null,
          " ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); (this.picker.expanded ||= new Set())[open ? "delete" : "add"](key); this.renderPicker(); } }, open ? "hide values" : "all values")),
        cov.ok ? this.historyChart(row, def.key, key) : null,
        open ? this.valuesDetail(cov) : null,
        firstPref ? h("div", { class: "gdiff" }, h("b", {}, sameValues ? "Decodes the same values as the card above" : "Decodes different values than the card above"),
          differences.length ? ` — it differs as a definition in: ${differences.join("; ")}.` : ", with the same structure (only names, files or status differ).") : null,
        h("div", { class: "gsummary" }, sentence),
        files.length > 1 || names.length > 1 ? h("div", { class: "gfiles" },
          h("a", { href: "#", onclick: (e) => { e.preventDefault(); (this.picker.filesOpen ||= new Set(names.length > 1 ? [key] : []))[filesOpen ? "delete" : "add"](key); this.renderPicker(); } }, filesOpen ? "hide the individual definitions" : `the ${files.length} individual definitions`),
          !filesOpen ? h("span", { class: "muted" }, ` ${files.map((f) => `${f.file} (${SHORT[f.status] || f.status})`).join(" · ")}`) : null) : null,
        renameOpen ? this.renameForm(def, latest?.fields || null, () => { this.picker.renaming = null; this.renderPicker(); }) : null,
        this.picker.raw?.has(def.key) ? this.rawPanel(def, g) : null,
        filesOpen && (files.length > 1 || names.length > 1) ? g.members.map((m) => member(m, g)) : null);
    });
    const partialGroups = groups.filter(partial);
    const partialBox = partialGroups.length ? h("details", { class: "group failed" },
      h("summary", {}, `${partialGroups.reduce((n, g) => n + g.members.length, 0)} candidate${partialGroups.reduce((n, g) => n + g.members.length, 0) > 1 ? "s" : ""} fail on some recorded telegram (hidden)`),
      partialGroups.flatMap((g) => g.members.map((m) => member(m, g)))) : null;
    const failed = groups.find((g) => g.failed);
    const failedBox = failed ? h("details", { class: "group failed" },
      h("summary", {}, `${failed.members.length} candidate${failed.members.length > 1 ? "s" : ""} decode none of this row's telegrams`),
      failed.members.map((m) => member(m, failed))) : null;
    const lumped = isLumped ? h("div", { class: "note-box" },
      h("b", {}, "Why so many candidates? "), `This row groups telegrams by only ${rowId} ID byte${rowId === 1 ? "" : "s"} (${fmt.hex(row.row.zz)} ${fmt.hex(row.row.pb)}${fmt.hex(row.row.sb)} ${row.row.id}), but the definitions identify their messages by up to ${longer} bytes. So these are not ${candidates.length} alternatives for one message: they are different messages (registers) that share this row, each in the file ebusd loads and again in the files of other device variants. Only the telegrams that belong to a defined message are split off; you can also split or combine any row by hand with its + and − buttons. `,
      h("button", { class: "small primary", onclick: () => this.splitLikeDefinitions(telegrams) }, "Split this row like the definitions")) : null;
    const none = !row.defKey ? h("div", { class: "note-box" }, "ebusd itself has no definition for this row: none of the candidates below would be used. Pick one to use it anyway (it joins the setup of this installation). The reasons are listed with each candidate.") : null;

    pop.replaceChildren();
    append(pop,
      h("div", { class: "head" }, h("span", { class: "mono" }, row.label), h("span", { class: "muted" }, `${candidates.length} candidate definition${candidates.length > 1 ? "s" : ""} · ${fmt.count(telegrams.length)} recorded variants, ${fmt.count(total)} telegrams`),
        h("span", { style: "margin-left:auto" }),
        setup.chosenFor(row.key) ? h("button", { class: "small", title: "forget the choice for this row and show ebusd's choice again", onclick: () => setup.choose(row.key, null) }, "ebusd's choice") : null,
        h("label", { class: "muted", title: "hide candidates that fail to decode some recorded telegram" }, h("input", { type: "checkbox", checked: hideFailing, onchange: (e) => setup.setUi("hideFailing", e.target.checked) }), " hide failing"),
        h("button", { class: "small", title: "write a definition of your own for this message, prefilled from the recording", onclick: () => this.openEditor(row) }, "New definition…"),
        h("button", { class: "small", onclick: () => this.closePicker() }, "✕")),
      lumped, none, cards, partialBox, failedBox,
      h("div", { class: "hint foot" }, "Candidates are compared over every telegram of this row in the recording. Definitions that are the same and decode the same values are one card (the same definition is usually repeated in the files of other device variants). Hovering a card shows its decoding in the row; picking puts it into the setup (the row's other candidates leave it)."));
    pop.style.display = "block";
    const stageTop = this.el.stage.getBoundingClientRect().top;
    const top = Math.max(0, Math.min(this.picker.anchorTop - stageTop + ROW, this.el.stage.clientHeight - Math.min(pop.offsetHeight, this.el.stage.clientHeight * 0.8)));
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(0, Math.min(this.el.labels.offsetWidth - 40, this.el.stage.clientWidth - pop.offsetWidth - 10))}px`;
  }

  // -- setup drawer: what is chosen for this installation, and the exports ----------------------

  toggleDrawer(open = !this.drawerOpen) {
    this.drawerOpen = open;
    this.el.drawer.style.display = open ? "" : "none";
    this.updateDecodeState();
    this.renderDrawer();
    this.render();
  }

  renderDrawer() {
    const drawer = this.el.drawer;
    if (!this.drawerOpen) return;
    const decoder = app.decoder;
    const entries = decoder?.entries || [];
    const included = setup.includedEntries(entries);
    const layers = app.views.definitions?.layers || [];
    const deployDir = app.status?.deploy_dir || "/share/ebusd/config";
    const subdir = app.settings?.deploy_subdir || "";
    const st = decoder?.status();
    const compileLine = !st?.compile
      ? h("div", { class: "hint warn" }, app.status?.repo?.exists ? "The definitions are not compiled yet. " : "No definitions repository yet: clone one in the Definitions tab. ",
        app.status?.repo?.exists ? h("button", { class: "small primary", onclick: () => app.views.definitions?.compile() }, "Compile") : null)
      : h("div", { class: "hint" }, `${st.compile.summary || "compiled"}${st.compile.at ? `, ${fmt.dateTime(new Date(st.compile.at).getTime())}` : ""}; ${fmt.count(st.known)} of ${fmt.count(st.telegrams)} distinct telegrams known to ebusd, ${fmt.count(st.definitions)} definitions matched.`);
    const groups = new Map();
    for (const m of included) {
      const circuit = setup.circuitOf(m);
      if (!groups.has(circuit)) groups.set(circuit, []);
      groups.get(circuit).push(m);
    }
    const list = h("div", { class: "list" });
    for (const [circuit, defs] of [...groups.entries()].sort()) {
      const original = defs[0].circuit;
      const circuitInput = h("input", { type: "text", value: circuit, size: 8, title: `circuit name in my config (MQTT topic ebusd/<circuit>/…); upstream: ${original}`, onchange: () => setup.renameCircuit(original, circuitInput.value) });
      append(list, h("div", { class: "circuit" }, h("b", {}, "circuit "), circuitInput, circuit !== original ? h("span", { class: "muted" }, ` (upstream ${original})`) : null, h("span", { class: "muted", style: "margin-left:auto" }, `${defs.length} definitions`)));
      for (const m of defs.sort((a, b) => setup.exportName(a).localeCompare(setup.exportName(b)) || (a.write ? 1 : 0) - (b.write ? 1 : 0))) {
        const colors = messageColors(m.circuit, m.name);
        const exportName = setup.exportName(m);
        const editing = this.drawerEditing === m.key;
        append(list, h("div", { class: `item ${m.write ? "write" : ""}` },
          h("div", { class: "line" },
            h("span", { class: "chip-msg", style: `color:${colors.text};background:${colors.background};border-color:${colors.border}` }, exportName, m.write ? " (w)" : m.passive ? " (u)" : ""),
            exportName !== m.name ? h("span", { class: "muted", title: "upstream name" }, m.name) : null,
            h("span", { class: `badge ${m.status}`, title: STATUS_HELP[m.status] || "" }, m.status),
            m.source !== "base" ? h("span", { class: "badge" }, m.source) : null,
            h("span", { style: "margin-left:auto" }),
            h("button", { class: "small", title: "rename for my config", onclick: () => { this.drawerEditing = editing ? null : m.key; this.renderDrawer(); } }, editing ? "done" : "✎"),
            h("button", { class: "small", title: "take out of the setup", onclick: () => setup.include(m.key, false, entries) }, "✕")),
          m.examples?.[0] ? h("div", { class: "mono muted example" }, m.examples[0].slice(0, 100)) : null,
          editing ? this.renameForm(m, decoder.sampleFields(m.key), () => { this.drawerEditing = null; this.renderDrawer(); }) : null));
      }
    }
    if (!included.length) append(list, h("div", { class: "hint", style: "padding:8px" }, entries.length ? "Nothing included yet. Pick candidates in the timeline (badge next to a row name) or tick definitions in the Definitions tab." : "No definitions matched the recording yet."));
    const status = h("div", { class: "hint" });
    const exportsBox = h("div", { class: "exports" },
      h("button", { class: "primary small", disabled: !included.length, title: `write the CSV files of the setup to ${deployDir}${subdir ? "/" + subdir : ""} for the eBUSd app`, onclick: async () => {
        const files = app.views.definitions.setupDeployFiles(entries).files;
        if (!confirm(`Write ${Object.keys(files).length} files (${Object.keys(files).join(", ")}) to ${deployDir}${subdir ? "/" + subdir : ""} and remove other definition files there?`)) return;
        try {
          const result = await api.post("api/deploy", { files, subdir, clean: true });
          status.textContent = `✓ ${result.written.join(", ")} written to ${result.dir}. Restart the eBUSd app with --configpath=${result.dir}.`;
          status.className = "hint ok";
        } catch (err) { status.textContent = `deploy failed: ${err.message}`; status.className = "hint err"; }
      } }, "Deploy to eBUSd"),
      h("button", { class: "small", disabled: !included.length, onclick: () => {
        for (const [name, text] of Object.entries(app.views.definitions.setupDeployFiles(entries).files)) {
          const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: name });
          document.body.appendChild(a); a.click(); a.remove();
        }
      } }, "Download CSV"),
      h("button", { class: "small", disabled: !included.length, title: "climate and water_heater entities for configuration.yaml", onclick: () => copy(generateHaYaml(setup.haMessages(entries))) }, "copy HA YAML"),
      h("button", { class: "small", disabled: !included.length, onclick: () => copy(generateEbusdOptions(setup.haMessages(entries), `${deployDir}${subdir ? "/" + subdir : ""}`)) }, "copy ebusd options"),
      h("button", { class: "small", onclick: () => { bus.emit("show-tab", "definitions"); bus.emit("show-view", "export"); } }, "Definitions › Export"));
    const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast("copied"); } catch { toast("copy failed", "err"); } };
    drawer.replaceChildren(
      h("div", { class: "head" }, h("b", {}, "Setup of this installation"), h("span", { class: "muted" }, `${included.length} definitions${setup.customized ? "" : " (ebusd's own choice so far)"}`), h("span", { style: "margin-left:auto" }), h("button", { class: "small", onclick: () => this.toggleDrawer(false) }, "✕")),
      compileLine,
      h("div", { class: "hint" }, "Names here are what ebusd publishes (MQTT topics ebusd/<circuit>/<name>, JSON fields) once the files are deployed; the upstream names stay in the CSV comments."),
      list, exportsBox, status);
  }

  async idMenu(row) {
    const pbsb = `${fmt.hex(row.row.pb)}${fmt.hex(row.row.sb)}`;
    const current = idLength(row.row.pb, row.row.sb, this.settings);
    const value = prompt(`Message ID length in data bytes for command ${pbsb} (0–4, default ${this.settings.id_bytes}):`, String(current));
    if (value === null) return;
    const n = Math.max(0, Math.min(8, parseInt(value, 10) || 0));
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
    if (open) { this.placePopover(pop); this.toggleSourcesOff(); }
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
