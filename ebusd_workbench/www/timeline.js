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
import { idLength, messageColors, valueColors } from "./colors.js";
import { lineOfRun } from "./decoder.js";
import { setup } from "./setup.js";
import { generateEbusdOptions, generateHaYaml } from "./hayaml.js";
import { coverage, groupCandidates, rowTelegrams, summarizeFields, whyNot } from "./compare.js";

const ROW = 24;
const STATUS_ORDER = { active: 0, hidden: 1, conditional: 2, variant: 3, error: 4, companion: 5 };
const STATUS_HELP = {
  active: "ebusd uses this definition for this installation (file chosen by the scan, condition met)",
  variant: "from a file of another device variant: ebusd would not load it, but it decodes these telegrams",
  conditional: "its condition was not met by the recorded telegrams, but it decodes them",
  hidden: "in the file ebusd loads, but another definition takes precedence",
  error: "matches the telegram but cannot decode it (wrong length or values)",
  companion: "not seen on the bus: the counterpart of a seen definition (usually for writing)",
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
    this.firstLoad = new Promise((resolve) => { this.markFirstLoad = resolve; });
    this.build();
    bus.on("decodes-changed", (reason) => { this.onDecodes(reason); });
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
    el.applyIds = h("button", { class: "small", style: "display:none", title: "set the message ID lengths per device and command as the decoded definitions define them", onclick: () => this.applyIdLengths() }, "ID lengths from definitions");
    el.info = h("span", { class: "hint" });
    el.decodeState = h("button", { class: "small state", title: "the definitions decoding this timeline (click for the definitions tab)", onclick: () => bus.emit("show-tab", "definitions") }, "definitions…");
    el.help = h("span", { class: "help", title: "Scroll: the rows\nCtrl/⌘ + scroll or pinch: zoom the time axis\nShift + scroll or sideways swipe: move in time\nDrag the chart: move in time; double click: zoom in\nOverview strip: drag the edges to resize the window, drag inside to move it, drag outside to select a new one\nKeys: ← → move, + − zoom, N live, Esc close" }, "?");
    el.progress = h("div", { class: "tl-progress", style: "display:none" }, h("div"));
    el.notice = h("div", { class: "tl-notice", style: "display:none" });
    el.setupButton = h("button", { class: "small", title: "the definitions chosen for this installation: names, config files, Home Assistant entities", onclick: () => this.toggleDrawer() }, "Setup");
    el.toolbar = h("div", { class: "toolbar" },
      el.presets,
      h("span", { class: "group" }, h("button", { title: "zoom out (-)", onclick: () => this.zoom(2) }, "−"), h("button", { title: "zoom in (+)", onclick: () => this.zoom(0.5) }, "+"), el.follow),
      h("span", { class: "group" }, h("label", {}, "ID bytes"), el.idBytes, el.applyIds),
      h("span", { class: "group" }, el.filter),
      h("label", { class: "group" }, el.onlyChanges, " only changed"),
      h("span", { class: "group" }, el.sort),
      h("span", { class: "group" }, h("button", { onclick: () => this.addMarker() }, "+ marker")),
      h("span", { class: "group", style: "margin-left:auto" }, el.decodeState, el.setupButton, el.help),
      el.info);
    el.overviewCanvas = h("canvas");
    el.overview = h("div", { class: "tl-overview", title: "all recorded telegrams; click or drag to move the window" }, el.overviewCanvas);
    el.corner = h("div", { class: "corner" });
    el.axisCanvas = h("canvas");
    el.axis = h("div", { class: "tl-axis" }, el.corner, el.axisCanvas);
    el.labels = h("div", { class: "tl-labels" });
    el.plotCanvas = h("canvas");
    el.plot = h("div", { class: "tl-plot" }, el.plotCanvas);
    el.body = h("div", { class: "tl-body" }, h("div", { class: "tl-rows" }, el.labels, el.plot));
    el.popover = h("div", { class: "tl-pop", style: "display:none" });
    el.drawer = h("div", { class: "tl-drawer", style: "display:none" });
    el.stage = h("div", { class: "tl-stage" }, el.body, el.popover, el.drawer);
    el.tooltip = h("div", { class: "tl-tooltip" });
    el.details = h("div", { class: "tl-details" });
    this.root.appendChild(h("div", { class: "tl" }, el.toolbar, el.progress, el.notice, el.overview, el.axis, el.stage, el.details, el.tooltip));
    this.bindMouse();
    document.addEventListener("mousedown", (e) => { if (this.picker && !el.popover.contains(e.target) && !e.target.closest(".tl-label")) this.closePicker(); });
    this.updateDecodeState();
  }

  // -- decodings from the browser store ------------------------------------------------------

  onDecodes(reason) {
    this.idLengths = app.decoder?.idLengths() || null;
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
    bar.style.display = parts.length ? "" : "none";
    bar.classList.toggle("indeterminate", parts.length > 0 && (fraction === null || fraction === undefined));
    bar.firstChild.style.width = fraction === null || fraction === undefined ? "" : `${Math.max(3, Math.round(fraction * 100))}%`;
    const n = setup.includedKeys(app.decoder?.entries).length;
    this.el.setupButton.textContent = `Setup (${n})`;
    this.el.setupButton.classList.toggle("active", this.drawerOpen);
    this.updateNotice(st);
  }

  /** A notice above the timeline while there is nothing to decode with. */
  updateNotice(st) {
    const el = this.el.notice;
    const repo = app.status?.repo;
    let content = null;
    if (!repo) content = null;
    else if (repo.busy && !repo.exists) content = [h("span", {}, `The definitions repository is being fetched (${repo.busy.what}). Until it is there nothing decodes the telegrams: rows show raw hex.`)];
    else if (!repo.exists) content = [h("span", {}, "No definitions source set: there are no rules to decode with, so rows show raw hex. Clone your ebusd-configuration fork (or john30's) in the Definitions tab."),
      h("button", { class: "small primary", onclick: () => bus.emit("show-tab", "definitions") }, "Set up definitions")];
    else if (!st?.compile && this.compileState?.error) content = [h("span", { class: "err" }, `Compiling the definitions failed: ${this.compileState.error}`), h("button", { class: "small", onclick: () => bus.emit("show-tab", "definitions") }, "Open Definitions")];
    else if (!st?.compile && !this.compileState?.busy) content = [h("span", {}, "The definitions are not compiled yet, so rows show raw hex."), h("button", { class: "small primary", onclick: () => app.views.definitions?.compile() }, "Compile")];
    else if (this.pendingIdLengths().length && !this.activity().parts.length) {
      const n = this.pendingIdLengths().length;
      content = [h("span", {}, `${n} command${n > 1 ? "s are" : " is"} grouped by fewer ID bytes than the definitions use, so different messages (registers) share a row and appear as many "candidates" of one row.`),
        h("button", { class: "small primary", onclick: () => this.applyIdLengths() }, "Split rows like the definitions")];
    }
    el.style.display = content ? "" : "none";
    if (content) el.replaceChildren(...content);
  }

  syncSettings() {
    this.settings = app.settings || { id_bytes: 1, id_overrides: {} };
    this.el.idBytes.value = String(this.settings.id_bytes ?? 1);
    const overrides = Object.entries(this.settings.id_overrides || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
    this.el.idBytes.title = `Data bytes after PBSB that identify a message (the rest is the value)${overrides ? `; overrides: ${overrides}` : ""}`;
  }

  updateIdButton() {
    const pending = this.pendingIdLengths();
    this.el.applyIds.style.display = pending.length ? "" : "none";
    this.el.applyIds.textContent = `ID lengths from definitions (${pending.length})`;
  }

  /** Overrides the decoded definitions suggest that differ from the current settings. */
  pendingIdLengths() {
    if (!this.idLengths) return [];
    const overrides = this.settings.id_overrides || {};
    return Object.entries(this.idLengths).filter(([key, len]) => (key in overrides ? overrides[key] : (key.slice(2, 6) in overrides ? overrides[key.slice(2, 6)] : this.settings.id_bytes)) !== len);
  }

  async applyIdLengths() {
    const overrides = { ...(this.settings.id_overrides || {}) };
    for (const [key, len] of this.pendingIdLengths()) overrides[key] = len;
    try {
      app.settings = await api.put("api/settings", { id_overrides: overrides });
      this.syncSettings();
      this.updateIdButton();
      bus.emit("settings-changed");
      this.load(true);
    } catch (err) { toast(err.message, "err"); }
  }

  /** Group the telegrams of one device and command by this many ID bytes from now on. */
  async setIdLength(zz, pb, sb, len) {
    const key = `${fmt.hex(zz)}${fmt.hex(pb)}${fmt.hex(sb)}`;
    const overrides = { ...(this.settings.id_overrides || {}), [key]: len };
    try {
      app.settings = await api.put("api/settings", { id_overrides: overrides });
      this.syncSettings();
      this.closePicker();
      bus.emit("settings-changed");
      this.load(true);
    } catch (err) { toast(err.message, "err"); }
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
    const rows = [];
    const byEntity = new Map();
    for (const ev of this.states) {
      if (!ev.entity) continue;
      if (!byEntity.has(ev.entity)) byEntity.set(ev.entity, []);
      byEntity.get(ev.entity).push(ev);
    }
    const end = this.follow ? Date.now() : this.t1;
    for (const [entity, list] of [...byEntity.entries()].sort()) {
      const runs = list.map((ev, i) => ({ t0: ev.ms, t1: list[i + 1] ? list[i + 1].ms : end, n: 1, label: ev.state ?? "", value: ev.state ?? "", event: ev }));
      if (!this.matches(entity, list[0]?.attributes?.friendly_name || "")) continue;
      if (runs[runs.length - 1].t1 < this.t0) continue;
      rows.push({ kind: "event", key: entity, label: entity, name: list[0]?.attributes?.friendly_name || "", n: list.length, runs });
    }
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
    if (this.selected && !this.rows.some((r) => r.key === this.selected.row.key)) this.closeDetails();
    else if (this.selected) this.selected.row = this.rows.find((r) => r.key === this.selected.row.key);
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
        onclick: (e) => { if (row.kind === "telegram" && n && e.target.closest(".name")) this.openPicker(row, e.currentTarget); else this.showDetails(row, null); } },
        h("span", { class: "key" }, row.label),
        row.name ? h("span", { class: `name ${renamed ? "renamed" : ""}`, style: row.def ? `color:${messageColors(row.def.circuit, row.def.name).text}` : "" }, row.name) : null,
        badge,
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
    this.drawPlot();
    this.drawOverview();
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
    for (const marker of this.markers) {
      if (marker.ms < this.t0 || marker.ms > this.t1) continue;
      const x = this.xOf(marker.ms);
      ctx.fillStyle = "#ef6c00";
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 6, 5); ctx.lineTo(x, 10); ctx.closePath(); ctx.fill();
      ctx.fillText((marker.message || "(time only)").slice(0, 60), x + 8, 9);
      ctx.fillStyle = "#6b7a8a";
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
    for (const marker of this.markers) {
      if ((marker.ms_max ?? marker.ms) < this.t0 || (marker.ms_min ?? marker.ms) > this.t1) continue;
      const x0 = this.xOf(marker.ms_min ?? marker.ms), x1 = this.xOf(marker.ms_max ?? marker.ms);
      if (x1 - x0 > 1.5) { ctx.fillStyle = "rgba(239,108,0,.12)"; ctx.fillRect(x0, 0, x1 - x0, height); }
      const x = Math.round(this.xOf(marker.ms)) + 0.5;
      ctx.setLineDash([4, 3]); ctx.strokeStyle = "#ef6c00";
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      ctx.setLineDash([]);
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

  bindMouse() {
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
    else if (e.key === "Escape") { if (this.picker) this.closePicker(); else if (this.drawerOpen) this.toggleDrawer(false); else this.closeDetails(); }
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

  // -- candidate picker: the definitions that decode a row, compared and chosen in place ---------

  openPicker(row, anchor) {
    if (!row.candidates?.size) return;
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

    const member = (m, group) => {
      const def = m.def, key = def.key;
      const chosen = key === row.defKey;
      const colors = messageColors(def.circuit, def.name);
      const exportName = setup.exportName(def);
      const renameOpen = this.picker.renaming === key;
      const d = m.coverage?.latest || null;
      const why = !chosen && key !== usedKey ? whyNot(def, scan, group.failed ? m.coverage.errorKinds : null) : "";
      const fieldNote = group.fieldNames ? fieldNamesOf(def) : "";
      return h("div", { class: `member ${chosen ? "chosen" : ""}`, onmouseenter: () => this.setPreview(row, key), onmouseleave: () => this.setPreview(row, null) },
        h("div", { class: "line" },
          h("button", { class: `pick ${chosen ? "on" : ""}`, title: chosen ? "shown in this row and part of the setup" : "use this definition for this row (it joins the setup, the other candidates leave it)",
            onclick: () => setup.choose(row.key, key, otherKeys, entries) }, chosen ? "●" : "○"),
          h("span", { class: "chip-msg", style: `color:${colors.text};background:${colors.background};border-color:${colors.border}` }, `${def.circuit} ${def.name}${def.passive ? " (u)" : ""}`),
          exportName !== def.name ? h("span", { class: "export" }, `→ ${setup.circuitOf(def)} ${exportName}`) : null,
          h("span", { class: "muted mono", title: def.file }, def.file.replace(/^.*\//, "")),
          h("span", { class: `badge ${def.status}`, title: STATUS_HELP[def.status] || "" }, def.status),
          def.source !== "base" ? h("span", { class: "badge", title: "added or changed by this community layer" }, def.source) : null,
          def.write ? h("span", { class: "badge write", title: "write definition: sends values to the device" }, "write") : null,
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
    const cards = groups.filter((g) => !g.failed).map((g) => {
      const cov = g.coverage;
      const first = g.members.find((m) => m.def.key === row.defKey) || g.members.find((m) => m.def.key === usedKey) || g.members[0];
      const latest = coverage(decoder, telegrams, first.def.key).latest;
      const key = `${g.key}`;
      const open = this.picker.expanded?.has(key);
      return h("div", { class: `group ${g.hasChosen ? "chosen" : ""}` },
        h("div", { class: "ghead" },
          h("b", {}, g.members.length > 1 ? `${g.members.length} of ${candidates.length} candidates are the same definition and decode alike` : `1 of ${candidates.length} candidates`),
          g.writable ? h("span", { class: "badge write" }, g.writable === g.members.length ? "writable" : `${g.writable} writable`) : null,
          g.hasUsed ? h("span", { class: "badge active" }, "includes ebusd's choice") : !isLumped && lead && !lead.failed && g !== lead ? h("span", { class: "badge variant", title: "decodes differently than the definition ebusd uses" }, "differs from ebusd's choice") : null),
        h("div", { class: "decoded mono" }, latest ? latest.text : h("span", { class: "err" }, "decodes nothing of this row"),
          latest ? h("span", { class: "muted", title: latest.line }, `  (latest, ${fmt.dateTime(latest.last_ms).slice(5, 16)})`) : null),
        h("div", { class: `cover ${cov.errors ? "warn" : "ok"}` },
          cov.errors ? `decodes ${fmt.count(cov.ok)} of ${fmt.count(cov.distinct)} recorded variants, fails for ${fmt.count(cov.errors)} (${[...cov.errorKinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")})`
            : `decodes all ${fmt.count(cov.ok)} recorded variants without error`,
          h("span", { class: "muted" }, ` · ${fmt.count(cov.okOccurrences)} telegrams${cov.first_ms ? `, ${fmt.date(cov.first_ms)} – ${fmt.date(cov.last_ms || cov.first_ms)}` : ""}`),
          cov.decoded < cov.telegrams ? h("span", { class: "muted", title: "the other telegrams of this row belong to other messages (see the note above)" }, ` · matches ${fmt.count(cov.decoded)} of the row's ${fmt.count(cov.telegrams)} variants`) : null,
          " ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); (this.picker.expanded ||= new Set())[open ? "delete" : "add"](key); this.renderPicker(); } }, open ? "hide values" : "all values")),
        open ? this.valuesDetail(cov) : null,
        g.members.map((m) => member(m, g)));
    });
    const failed = groups.find((g) => g.failed);
    const failedBox = failed ? h("details", { class: "group failed" },
      h("summary", {}, `${failed.members.length} candidate${failed.members.length > 1 ? "s" : ""} decode none of this row's telegrams`),
      failed.members.map((m) => member(m, failed))) : null;
    const lumped = isLumped ? h("div", { class: "note-box" },
      h("b", {}, "Why so many candidates? "), `This row groups telegrams by only ${rowId} ID byte${rowId === 1 ? "" : "s"} (${fmt.hex(row.row.zz)} ${fmt.hex(row.row.pb)}${fmt.hex(row.row.sb)} ${row.row.id}), but the definitions identify their messages by up to ${longer} bytes. So these are not ${candidates.length} alternatives for one message: they are different messages (registers) that share this row, each in the file ebusd loads and again in the files of other device variants. `,
      h("button", { class: "small primary", onclick: () => this.setIdLength(row.row.zz, row.row.pb, row.row.sb, longer) }, `Split this row by ${longer} ID bytes`)) : null;
    const none = !row.defKey ? h("div", { class: "note-box" }, "ebusd itself has no definition for this row: none of the candidates below would be used. Pick one to use it anyway (it joins the setup of this installation). The reasons are listed with each candidate.") : null;

    pop.replaceChildren();
    append(pop,
      h("div", { class: "head" }, h("span", { class: "mono" }, row.label), h("span", { class: "muted" }, `${candidates.length} candidate definition${candidates.length > 1 ? "s" : ""} · ${fmt.count(telegrams.length)} recorded variants, ${fmt.count(total)} telegrams`),
        h("span", { style: "margin-left:auto" }),
        setup.chosenFor(row.key) ? h("button", { class: "small", title: "forget the choice for this row and show ebusd's choice again", onclick: () => setup.choose(row.key, null) }, "ebusd's choice") : null,
        h("button", { class: "small", onclick: () => { bus.emit("show-tab", "definitions"); bus.emit("show-definition", row.defKey || candidates[0]?.def.key); } }, "Definitions ›"),
        h("button", { class: "small", onclick: () => this.closePicker() }, "✕")),
      lumped, none, cards, failedBox,
      h("div", { class: "hint foot" }, "Candidates are compared over every telegram of this row in the recording. Definitions that are the same and decode the same values are shown together; what differs is their name, file and status. Hovering shows the decoding in the row; picking puts the definition into the setup (the row's other candidates leave it)."));
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
        const files = setup.files(entries, layers).files;
        if (!confirm(`Write ${Object.keys(files).length} files (${Object.keys(files).join(", ")}) to ${deployDir}${subdir ? "/" + subdir : ""} and remove other definition files there?`)) return;
        try {
          const result = await api.post("api/deploy", { files, subdir, clean: true });
          status.textContent = `✓ ${result.written.join(", ")} written to ${result.dir}. Restart the eBUSd app with --configpath=${result.dir}.`;
          status.className = "hint ok";
        } catch (err) { status.textContent = `deploy failed: ${err.message}`; status.className = "hint err"; }
      } }, "Deploy to eBUSd"),
      h("button", { class: "small", disabled: !included.length, onclick: () => {
        for (const [name, text] of Object.entries(setup.files(entries, layers).files)) {
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

  async addMarker() {
    const note = prompt("Marker text (e.g. what you just did at the heating):");
    if (!note) return;
    try {
      await api.post("api/events", { note });
      toast("marker added");
      this.load(true);
    } catch (err) { toast(err.message, "err"); }
  }
}
