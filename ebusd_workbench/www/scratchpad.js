// The inspector of the selected message and what goes with it, inserted under the message's row in
// the list: the telegram byte by byte with every definition that fits as a row (see inspector.js),
// the definitions that fail, and the chart of a field as a box over the table when a sparkline is
// clicked (hovering it shows that telegram in the table). The candidates come from the pool of every
// source at once; the ones not checked with ebusd's library yet show as "checking" while the core
// decodes them, this message first. It stays put: the list freezes while a message is selected, and
// the inspector is only drawn again when its structure changes (a definition was checked, the pick
// changed, a line of your own changed) or on your own actions, never while you type.
import { app, append, bus, fmt, h, toast } from "./app.js";
import { drawChart, nearestPoint, seriesFields, seriesValues } from "./chart.js";
import { accessKind, coverage, rowTelegrams, whyNot } from "./compare.js";
import { closeTypePicker } from "./typepick.js";
import { messageColors } from "./colors.js";
import { analyzeBytes, buildCsv, defaultHeader, initialSegments, samplesOf } from "./define.js";
import { MINE, setup } from "./setup.js";
import { upsertMine } from "./mine.js";
import { inspector } from "./inspector.js";

const base = (file) => file.replace(/^.*\//, "");
const chip = (circuit, name) => { const c = messageColors(circuit, name); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit} ${name}`); };
const sourceBadges = (def) => def.sources.slice(0, 3).map((s) => h("span", { class: `tbadge ${s === MINE ? "custom" : s === "release" ? "" : "src"}`, title: `from ${app.decoder.source(s)?.label || s}` }, s === MINE ? "mine" : app.decoder.source(s)?.label || s));

export class Scratchpad {
  constructor(view) {
    this.view = view;                      // the list of messages
    this.host = h("div", { class: "insp-host" });
    this.state = null;
    this.model = null;
    this.key = null;                       // the structure the inspector was drawn for
    this.inspectorEl = null;
    bus.on("select-row", (sel) => { if (sel?.view) this.view = sel.view; sel ? this.open(sel.row, sel.run, sel.options) : this.close(); });
    bus.on("decodes-changed", (reason) => { if (reason !== "progress") this.refresh(); });
    bus.on("setup-changed", () => this.refresh());
    bus.on("settings-changed", () => this.refresh());
    // Esc closes the chart box first, then (app.js) the inspector
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.state?.chart && !(e.target instanceof Element && e.target.closest("input, textarea, select"))) { e.stopImmediatePropagation(); this.closeChart(); } }, true);
  }

  get isOpen() { return !!this.state; }

  // -- open / close ------------------------------------------------------------------------------------

  open(row, run = null, { field = null } = {}) {
    const same = this.state?.row.key === row.key;
    this.state = { row, run, failingOpen: same && this.state.failingOpen, tIndex: same ? this.state.tIndex : 0, chart: same ? this.state.chart : null, wantedField: field };
    this.view.select(row, run);
    this.refreshModel();
    if (run?.line) { const idx = this.telegramsNewestFirst().findIndex((t) => t.line === run.line); if (idx >= 0) this.state.tIndex = idx; }
    this.view.mountInspector(row.key, this.host);
    this.render();
  }

  close() {
    closeTypePicker({ silent: true });
    this.state = null;
    this.model = null;
    this.key = null;
    this.inspectorEl = null;
    this.host.replaceChildren();
    this.view.select(null);
    this.view.unmountInspector();
  }

  // -- the definitions of the message ---------------------------------------------------------------------

  refreshModel() {
    const { row } = this.state;
    const core = app.decoder;
    const telegrams = rowTelegrams(core, row.row);
    const lines = telegrams.map((t) => t.line);
    const candidates = [...core.candidatesOf(lines).values()];
    // a line of your own whose fields do not add up to the telegrams' length is no candidate for ebusd, but it is yours: it stays in view, with the reason
    for (const hash of core.ownLinesFor(row)) if (!candidates.some((c) => c.def.key === hash)) { const def = core.def(hash); if (def) candidates.push({ def: { ...def, nomatch: true }, ok: 0, errors: 0, pending: 0, used: 0, usedIn: 0, last: null }); }
    for (const c of candidates) c.cov = coverage(core, telegrams, c.def.key);
    const usedKey = candidates.find((c) => c.used > 0)?.def.key || null;
    const hideFailing = !!app.settings?.ui?.hideFailing;
    const included = new Set(setup.includedKeys(core.entries));
    const chosen = setup.chosenFor(row.key);
    // a line that decodes none of the telegrams goes to the failing card, except your own lines and lines ebusd rejected: those stay in view, with the reason
    const failed = (c) => c.cov.decoded > 0 && c.cov.ok === 0 && !c.def.mine && !c.def.error && !c.def.nomatch;
    const shown = candidates.filter((c) => !failed(c) && !(hideFailing && c.cov.errors > 0 && c.def.key !== chosen));
    const hidden = candidates.filter((c) => !shown.includes(c));
    const order = Object.fromEntries(core.sources().map((s, i) => [s.id, i]));
    shown.sort((a, b) => ((b.def.key === chosen) - (a.def.key === chosen)) || ((b.def.key === usedKey) - (a.def.key === usedKey)) || (b.cov.ok - a.cov.ok) || ((order[a.def.source] ?? 99) - (order[b.def.source] ?? 99)));
    const keys = candidates.map((c) => c.def.key);
    const defKey = chosen && keys.includes(chosen) ? chosen : usedKey || candidates.find((c) => included.has(c.def.key))?.def.key || null;
    this.model = { telegrams, lines, candidates, usedKey, shown, hidden, included, defKey, keys, total: telegrams.reduce((n, t) => n + (t.n || 0), 0) };
    core.ensureDecoded(row.key, lines, "now");   // this message first
  }

  /** What the inspector is made of: a change of this is the only reason to draw it again by itself. */
  structureKey() {
    const m = this.model;
    return JSON.stringify([app.decoder.poolStamp, m.shown.map((c) => [c.def.key, c.cov.ok, c.cov.errors, c.cov.pending, c.def.error, c.def.csv]), m.hidden.length, m.defKey, [...m.included].filter((k) => m.keys.includes(k)), m.telegrams.length]);
  }

  telegramsNewestFirst() { return this.model.telegrams.slice().sort((a, b) => (b.last_ms || 0) - (a.last_ms || 0)); }

  /** Something changed on the bus or in the setup: draw again only when the structure changed, and never while typing (at most every 300 ms, however often it is told). */
  refresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refreshNow(); }, 300);
  }

  refreshNow() {
    if (!this.state) return;
    const active = document.activeElement;
    if (active && this.host.contains(active) && active.matches("input, textarea, select")) {
      if (!this.waiting) { this.waiting = true; active.addEventListener("blur", () => { this.waiting = false; this.refresh(); }, { once: true }); }
      return;
    }
    this.refreshModel();
    if (this.structureKey() !== this.key) this.render(true);
  }

  // -- drawing -------------------------------------------------------------------------------------------------

  /** @param keep whether the scroll positions stay (a refresh) or start again (another message) */
  render(keep = false) {
    const host = this.host;
    const st = this.state;
    if (!st) return;
    const list = host.closest(".msg-list");
    const wrap = host.querySelector(".inspector-wrap");
    const scroll = keep ? { list: list?.scrollTop ?? 0, wrap: wrap?.scrollLeft ?? 0 } : null;
    host.replaceChildren();
    this.inspectorEl = null;
    this.renderRow(host);
    this.key = this.model ? this.structureKey() : null;
    if (scroll) {
      if (list) list.scrollTop = scroll.list;
      const w = host.querySelector(".inspector-wrap"); if (w) w.scrollLeft = scroll.wrap;
    }
  }

  renderRow(el) {
    const st = this.state, m = this.model;
    const { row } = st;
    const senders = row.senders ? [...row.senders.keys()].join(", ") : null;
    this.chartAnchor = h("div", { class: "chart-anchor" });
    append(el,
      h("div", { class: "pad-head" },
        h("span", { class: "mono key" }, row.label),
        row.name ? h("span", { class: "name" }, row.name) : null,
        h("span", { class: "muted" }, `${fmt.count(m.telegrams.length)} recorded variants · ${fmt.count(m.total)} telegrams${senders ? ` · asked by ${senders}` : ""}`),
        row.id && row.id.length > 2 ? h("span", { class: "muted", title: "the message ID is as many data bytes as the fitting definitions use to tell this message from its siblings (an energy statistic per source and usage, a register); 1 byte is only the default when nothing fits" }, `· ${row.id.length / 2}-byte ID`) : null,
        h("span", { style: "margin-left:auto" }),
        h("label", { class: "muted", title: "hide definitions that fail to decode some recorded telegram" }, h("input", { type: "checkbox", checked: !!app.settings?.ui?.hideFailing, onchange: (e) => setup.setUi("hideFailing", e.target.checked) }), " hide failing"),
        setup.chosenFor(row.key) ? h("button", { class: "small", title: "forget the pick for this message and use ebusd's choice again", onclick: () => setup.choose(row.key, null) }, "back to ebusd's choice") : null,
        h("button", { class: "small", title: "close (Esc)", onclick: () => this.close() }, "✕")),
      this.notes(),
      this.inspectorSection(),
      this.chartAnchor,
      m.hidden.length ? h("div", { class: "cards" }, this.failingCard()) : null);
    if (st.chart) this.openChart(st.chart.defKey, st.chart.field);
  }

  notes() {
    const { row } = this.state;
    const m = this.model;
    const out = [];
    if (row.scan) out.push(h("div", { class: "note-box" }, row.pbsb === "0704"
      ? "ebusd's scan: the identification every device answers (manufacturer, device id, software and hardware version). Nothing to define."
      : "ebusd's scan of a Vaillant device: its serial number in four parts as text (b5 09 24, 25, 26 and 27; vaillant/scan.csv, Scan Id), asked by ebusd itself right after the identification. Nothing to define."));
    const checking = m.candidates.filter((c) => c.cov.decoded === 0 && c.cov.pending > 0).length;
    if (!m.usedKey && m.candidates.length && checking < m.candidates.length) out.push(h("div", { class: "note-box" }, "ebusd itself has no definition for this message: none of these would be used as they are. Tick one for your setup, or change a copy of it."));
    if (!m.candidates.length && !row.scan) out.push(h("div", { class: "note-box" }, "No definition of any source fits this message: not ebusd's own, not the upcoming release, not an open pull request. Start one of your own from the bytes (the tooltip of a byte says what it could be)."));
    return out.length ? h("div", {}, out) : null;
  }

  /** The inspector: the telegram byte by byte, every fitting definition as a row, with the values and sparklines. */
  inspectorSection() {
    const st = this.state, m = this.model;
    const defs = m.shown.map((c) => ({ def: c.def, coverage: c.cov }));
    const usedDef = m.candidates.find((c) => c.def.key === m.usedKey)?.def || null;
    this.inspectorEl = inspector({
      row: st.row, telegrams: m.telegrams, defs, decoder: app.decoder, view: this.view, telegramIndex: st.tIndex, selected: st.chart, picker: st.picker,
      included: m.included, otherKeys: m.keys, usedKey: m.usedKey, usedDef, defKey: m.defKey,
      onTelegram: (i) => { st.tIndex = i; },
      onPicker: (p) => { st.picker = p; },
      onSelect: (defKey, field) => (st.chart?.defKey === defKey && st.chart?.field === field ? this.closeChart() : this.openChart(defKey, field)),
      onChange: () => this.refresh(),
      onNew: () => this.newDefinition(),
    });
    return this.inspectorEl;
  }

  /** A line of your own for this message: one raw field per part, named after the device; it shows at once and is edited in the table. */
  async newDefinition() {
    const { row } = this.state;
    const telegrams = this.model.telegrams;
    const idBytes = (row.row.id || "").length / 2;
    const samples = samplesOf(telegrams, idBytes);
    const header = defaultHeader(row.row, samples, { scan: app.decoder.devices(), own: app.settings?.own_address || "31" });
    header.name = `New_${row.pbsb || ""}${row.id || ""}`.replace(/[^A-Za-z0-9_]/g, "");
    const parts = { m: initialSegments(analyzeBytes(samples, "m").length), s: initialSegments(analyzeBytes(samples, "s").length) };
    try {
      const key = await upsertMine(buildCsv(header, parts));   // saved; the core checks it right away
      setup.choose(row.key, key, this.model.keys, app.decoder.entries);
      this.state.chart = null;
      this.refreshNow();
    } catch (err) { toast(err.message, "err"); }
  }

  // -- the chart of a field, as a box over the table ----------------------------------------------------------------

  openChart(defKey, field) {
    const st = this.state;
    if (!st || !this.inspectorEl || !this.chartAnchor) return;
    this.closeChart({ keepState: true });
    st.chart = { defKey, field };
    this.inspectorEl.markSelected(defKey, field);
    const def = app.decoder.def(defKey);
    if (!def) return;
    const info = h("span", { class: "hint" }, "loading the recording…");
    const canvas = h("canvas");
    const box = h("div", { class: "chartbox" },
      h("div", { class: "head" }, chip(def.circuit, def.name), h("b", {}, field), h("span", { class: "muted" }, "over the whole recording · hover for the telegram, click to keep it"), h("span", { style: "margin-left:auto" }),
        h("button", { class: "small", title: "close (Esc)", onclick: () => this.closeChart() }, "✕")),
      canvas, info);
    const backdrop = h("div", { class: "chart-backdrop", onclick: () => this.closeChart() });
    this.chartAnchor.replaceChildren(backdrop, box);
    backdrop.style.height = `${Math.max(0, this.host.scrollHeight - this.chartAnchor.offsetTop)}px`;
    this.fillChart(def, field, canvas, info);
  }

  closeChart({ keepState = false } = {}) {
    const st = this.state;
    if (this.chartAnchor) this.chartAnchor.replaceChildren();
    if (!keepState && st) st.chart = null;
    if (this.inspectorEl && !keepState) { this.inspectorEl.markSelected(null); this.inspectorEl.showTelegram(st?.tIndex || 0); }
  }

  async fillChart(def, field, canvas, info) {
    const st = this.state, row = st.row;
    let data;
    try { data = await this.view.loadSeries(row); } catch (err) { info.textContent = `history failed: ${err.message}`; return; }
    if (!data || !canvas.isConnected) { if (!data) info.textContent = "no recording"; return; }
    const decodeFor = (line) => app.decoder.decodesOf(line)?.get(def.key);
    const shim = { decodesOf: (line) => { const d = decodeFor(line); return d ? new Map([["k", d]]) : undefined; } };
    const fields = seriesFields(data, shim, "k");
    if (!fields.includes(field)) field = fields.find((f) => seriesValues(data, shim, "k", f).numeric) || fields[0] || field;
    const series = seriesValues(data, shim, "k", field);
    const db = app.status.db;
    const t0 = db.first_ms, t1 = db.last_ms + 1000;
    const width = Math.max(300, (this.host.clientWidth || 600) - 40);
    let geometry = null;
    const paint = (hover = null) => { geometry = drawChart(canvas, series, { t0, t1, width, height: 180, band: null, hoverMs: hover }); };
    const summary = () => {
      const values = series.points.map((p) => p.value);
      const range = series.numeric && values.length ? ` · ${Math.min(...values)} … ${Math.max(...values)}` : "";
      info.textContent = `${fmt.count(series.points.length)} telegrams${data.stride > 1 ? ` (every ${data.stride}th of ${fmt.count(data.total)})` : ""}${range}${series.points.length < data.points.length ? " · telegrams not decoded with this definition are left out" : ""}`;
    };
    const lineAt = (ms) => { const p = nearestPoint(series, ms); if (!p) return null; const idx = data.points.findIndex(([pm]) => pm === p.ms); return { p, line: idx >= 0 ? data.lines[data.points[idx][1]] : null }; };
    canvas.addEventListener("mousemove", (e) => {
      const ms = geometry.tOf(e.offsetX), hit = lineAt(ms);
      paint(ms);
      if (!hit) return;
      info.textContent = `${fmt.dateTime(hit.p.ms)}  ${field} = ${hit.p.value}`;
      const at = hit.line ? this.inspectorEl?.indexOfLine(hit.line) : -1;
      if (at >= 0) this.inspectorEl.showTelegram(at);   // the telegram row above follows the pointer
    });
    canvas.addEventListener("mouseleave", () => { paint(); summary(); this.inspectorEl?.showTelegram(st.tIndex); });
    canvas.addEventListener("click", (e) => {
      const hit = lineAt(geometry.tOf(e.offsetX));
      const at = hit?.line ? this.inspectorEl?.indexOfLine(hit.line) : -1;
      if (at >= 0) { st.tIndex = at; this.inspectorEl.showTelegram(at); toast(`telegram of ${fmt.dateTime(hit.p.ms)} kept in the table`, "ok", 1500); }
    });
    paint(); summary();
  }

  // -- definitions that fail ---------------------------------------------------------------------------------------

  failingCard() {
    const { row } = this.state;
    const open = !!this.state.failingOpen;
    const entries = app.decoder.entries;
    const otherKeys = this.model.keys;
    const usedDef = this.model.candidates.find((c) => c.def.key === this.model.usedKey)?.def || null;
    const members = this.model.hidden;
    const head = h("div", { class: "card-head muted", onclick: (e) => { if (e.target.closest("button, input, a")) return; this.state.failingOpen = !open; this.render(true); } },
      h("span", { class: "fold" }, open ? "▾" : "▸"), h("span", {}, `${members.length} definition${members.length === 1 ? "" : "s"} that fail on some or all recorded telegrams`));
    const body = open ? h("div", { class: "card-body single" }, members.map((c) => h("div", { class: "frow" },
      h("label", { class: "muted" }, h("input", { type: "checkbox", checked: this.model.included.has(c.def.key), title: "use it anyway", onchange: (e) => (e.target.checked ? setup.choose(row.key, c.def.key, otherKeys, entries) : setup.include(c.def.key, false, entries)) }), " in setup"),
      chip(c.def.circuit, c.def.name), h("span", { class: "badge kind" }, accessKind(c.def)), sourceBadges(c.def), h("span", { class: "mono muted" }, base(c.def.file)), h("span", { class: `badge ${c.def.status}` }, c.def.status),
      h("span", { class: c.cov.ok === 0 ? "err" : "warn" }, c.cov.ok === 0 ? "decodes none of this message's telegrams" : `fails on ${c.cov.errors} of ${c.cov.distinct} recorded variants (${[...c.cov.errorKinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")})`),
      h("button", { class: "small", title: "a copy of your own, to fix it in the table", onclick: async () => { try { await upsertMine(c.def.csv); this.refresh(); } catch (err) { toast(err.message, "err"); } } }, "copy"),
      h("div", { class: "muted", style: "flex-basis:100%;margin-left:24px" }, whyNot(c.def, app.decoder.scanOf(c.def.source) || {}, c.cov.ok === 0 ? c.cov.errorKinds : null, usedDef))))) : null;
    return h("div", { class: `card ${open ? "open" : ""}` }, head, body);
  }
}
