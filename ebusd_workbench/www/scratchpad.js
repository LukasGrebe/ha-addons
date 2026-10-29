// The inspector of the selected message and what goes with it, inserted under the message's row in
// the list: the telegram byte by byte with every definition that fits as a row (see inspector.js),
// the search over the open pull requests (the way to find a definition, started by itself when
// nothing is set up for the message), the definitions that fail, and the chart of a field as a
// box over the table when a sparkline is clicked (hovering it shows that telegram in the table).
// It stays put: the list freezes while a message is selected, and the inspector is only drawn
// again when its structure changes (another definition fits, the pick changed, a line of your own
// changed) or on your own actions, never while you type. Nothing waits for ebusd's library: a
// line of your own shows the moment it is saved, marked "checking" until it has been decoded.
import { app, append, bus, fmt, h, toast } from "./app.js";
import { drawChart, nearestPoint, seriesFields, seriesValues } from "./chart.js";
import { accessKind, groupCandidates, rowTelegrams, whyNot } from "./compare.js";
import { messageColors } from "./colors.js";
import { analyzeBytes, buildCsv, defaultHeader, initialSegments, samplesOf } from "./define.js";
import { parseDefinition } from "./definition-edit.js";
import { MINE, MINE_FILE, setup } from "./setup.js";
import { mineLines, upsertMine } from "./mine.js";
import { prSearch } from "./prsearch.js";
import { inspector } from "./inspector.js";

const base = (file) => file.replace(/^.*\//, "");
const chip = (circuit, name) => { const c = messageColors(circuit, name); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit} ${name}`); };
const sourceBadge = (def) => h("span", { class: `tbadge ${def.source === MINE ? "custom" : def.source === "release" ? "" : "src"}`, title: `from ${def.sourceLabel || def.source}` }, def.source === MINE ? "mine" : def.sourceLabel || def.source);

/** Whether a line of your own (its header) is for this message. */
function lineFits(header, row) {
  const id = (header.id || "").toLowerCase(), rowId = row.id || "";
  return (header.pbsb || "").toLowerCase() === row.pbsb && (!header.zz || header.zz.toLowerCase() === row.zz) && (!id || rowId.startsWith(id) || id.startsWith(rowId));
}

/** A line of your own the decoder has not checked yet, as a definition the inspector can show. */
function pendingDef(line, header) {
  return { key: line.key, source: MINE, sourceLabel: "my definitions", circuit: header.circuit, name: header.name, csv: line.line, file: MINE_FILE, status: "custom", pending: true,
    write: /w/i.test(header.type), passive: /u/i.test(header.type), conditions: [], available: true, inScanFile: true, zz: header.zz, pbsb: header.pbsb, idlen: (header.id || "").length / 2 };
}

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
    this.state = null;
    this.model = null;
    this.key = null;
    this.inspectorEl = null;
    if (app.decoder) app.decoder.priorityLines = new Set();
    this.host.replaceChildren();
    this.view.select(null);
    this.view.unmountInspector();
  }

  // -- the definitions of the message ---------------------------------------------------------------------

  refreshModel() {
    const { row } = this.state;
    const decoder = app.decoder;
    const telegrams = rowTelegrams(decoder, row.row);
    const all = decoder.candidatesOf(telegrams.map((t) => t.line));
    for (const [key, c] of row.candidates || []) if (!all.has(key)) all.set(key, c);
    const candidates = [...all.values()];
    const usedKey = candidates.find((c) => c.used)?.def.key || null;
    const { groups } = groupCandidates(decoder, candidates, telegrams, { chosenKey: row.defKey, usedKey });
    const hideFailing = !!app.settings?.ui?.hideFailing;
    const shown = groups.filter((g) => !g.failed && !(hideFailing && g.coverage.errors > 0 && !g.hasChosen));
    const hidden = groups.filter((g) => !shown.includes(g));
    const included = new Set(setup.includedKeys(decoder.entries));
    const chosen = setup.chosenFor(row.key);
    // lines of your own for this message that the decoder has not been over yet: rows at once, "checking"
    const pending = row.kind === "telegram" ? mineLines().map((l) => ({ l, header: parseDefinition(l.line).header })).filter(({ l, header }) => !all.has(l.key) && lineFits(header, row)).map(({ l, header }) => pendingDef(l, header)) : [];
    const keys = [...candidates.map((c) => c.def.key), ...pending.map((p) => p.key)];
    const defKey = chosen && keys.includes(chosen) ? chosen : usedKey || candidates.find((c) => included.has(c.def.key))?.def.key || pending.find((p) => included.has(p.key))?.key || null;
    this.model = { telegrams, candidates, usedKey, groups, shown, hidden, included, defKey, pending, keys, mineText: app.settings?.custom || "", total: telegrams.reduce((n, t) => n + (t.n || 0), 0),
      current: groups.find((g) => g.members.some((m) => m.def.key === defKey)) || groups.find((g) => g.hasUsed) || shown[0] || null };
    // the telegrams of the inspected message are decoded first when a source is added
    decoder.priorityLines = new Set(telegrams.map((t) => t.line));
  }

  /** What the inspector is made of: a change of this is the only reason to draw it again by itself. */
  structureKey() {
    const m = this.model;
    return JSON.stringify([app.decoder.build?.id, m.shown.map((g) => [g.members.map((x) => x.def.key), g.coverage?.ok, g.coverage?.errors]), m.hidden.length, m.defKey, [...m.included].filter((k) => m.keys.includes(k)), m.telegrams.length, m.pending.map((p) => p.key), m.mineText]);
  }

  preferred(g) {
    const order = Object.fromEntries(app.decoder.sources().map((s, i) => [s.id, i]));
    return g.members.find((m) => m.def.key === this.model.defKey) || g.members.find((m) => m.def.key === this.model.usedKey)
      || g.members.slice().sort((a, b) => (order[a.def.source] ?? 99) - (order[b.def.source] ?? 99))[0];
  }

  telegramsNewestFirst() { return this.model.telegrams.slice().sort((a, b) => (b.last_ms || 0) - (a.last_ms || 0)); }

  /** Something changed on the bus or in the setup: draw again only when the structure changed, and never while typing. */
  refresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshNow(), 300);
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
    if (st.row.kind === "event") this.renderEvent(host); else this.renderRow(host);
    this.key = this.model ? this.structureKey() : null;
    if (scroll) {
      if (list) list.scrollTop = scroll.list;
      const w = host.querySelector(".inspector-wrap"); if (w) w.scrollLeft = scroll.wrap;
    }
  }

  renderEvent(el) {
    const { row, run } = this.state;
    append(el, h("div", { class: "pad-head" },
      h("span", { class: "mono key" }, row.label), row.name ? h("span", { class: "name" }, row.name) : null,
      h("span", { style: "margin-left:auto" }), h("button", { class: "small", onclick: () => this.close() }, "✕")),
      h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", {}, "time"), h("th", {}, "state"), h("th", {}, "previous"), h("th", {}, "source"), h("th", {}, "attributes"))),
        h("tbody", {}, row.runs.filter((r) => !run || r === run).map((r) => h("tr", {},
          h("td", { class: "mono" }, fmt.dateTime(r.t0, true)), h("td", {}, r.event.state ?? ""), h("td", {}, r.event.previous ?? ""), h("td", {}, r.event.source),
          h("td", { class: "mono", style: "white-space:normal" }, JSON.stringify(r.event.attributes || {}).slice(0, 300)))))));
  }

  renderRow(el) {
    const st = this.state, m = this.model;
    const { row } = st;
    const senders = row.senders ? [...row.senders.keys()].join(", ") : null;
    const prHost = h("div");
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
      prHost,
      m.hidden.length ? h("div", { class: "cards" }, this.failingCard()) : null);
    // the search over the pull requests draws its own box as it goes, not the whole inspector
    const prChanged = () => { if (this.state?.row.key === row.key && prHost.isConnected) prHost.replaceChildren(prSearch.section(row, m.telegrams, prChanged)); };
    prHost.appendChild(prSearch.section(row, m.telegrams, prChanged));
    // nothing set up for this message: the pull requests are the way to find a definition, so look by ourselves
    if (!m.defKey && !row.scan && !m.pending.length) prSearch.auto(row, m.telegrams, prChanged);
    if (st.chart) this.openChart(st.chart.defKey, st.chart.field);
  }

  notes() {
    const { row } = this.state;
    const out = [];
    if (row.scan) out.push(h("div", { class: "note-box" }, row.pbsb === "0704"
      ? "ebusd's scan: the identification every device answers (manufacturer, device id, software and hardware version). Nothing to define."
      : "ebusd's scan of a Vaillant device: its serial number in four parts as text (b5 09 24, 25, 26 and 27; vaillant/scan.csv, Scan Id), asked by ebusd itself right after the identification. Nothing to define."));
    if (!row.defKey && this.model.candidates.length) out.push(h("div", { class: "note-box" }, "ebusd itself has no definition for this message: none of these would be used as they are. Tick one for your setup, or change a copy of it."));
    if (!this.model.candidates.length && !this.model.pending.length && !row.scan) out.push(h("div", { class: "note-box" }, "No definition of any source decodes this message. The open pull requests are searched below; or start one of your own from the bytes (the tooltip of a byte says what it could be)."));
    return out.length ? h("div", {}, out) : null;
  }

  /** The inspector: the telegram byte by byte, every fitting definition as a row, with the values and sparklines. */
  inspectorSection() {
    const st = this.state, m = this.model;
    const defs = [...m.shown.map((g) => ({ def: this.preferred(g).def, group: g })), ...m.pending.map((def) => ({ def, group: null }))];
    const usedDef = m.candidates.find((c) => c.def.key === m.usedKey)?.def || null;
    this.inspectorEl = inspector({
      row: st.row, telegrams: m.telegrams, defs, decoder: app.decoder, view: this.view, telegramIndex: st.tIndex, selected: st.chart,
      included: m.included, otherKeys: m.keys, usedKey: m.usedKey, usedDef, defKey: m.defKey,
      onTelegram: (i) => { st.tIndex = i; },
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
      const key = await upsertMine(buildCsv(header, parts));   // saved; the decoder checks it in the background
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
    const def = app.decoder.def(defKey) || this.model.pending.find((p) => p.key === defKey);
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
      info.textContent = `${fmt.count(series.points.length)} telegrams${data.stride > 1 ? ` (every ${data.stride}th of ${fmt.count(data.total)})` : ""}${range}`;
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
    const members = this.model.hidden.flatMap((g) => g.members.map((m) => ({ m, g })));
    const head = h("div", { class: "card-head muted", onclick: (e) => { if (e.target.closest("button, input, a")) return; this.state.failingOpen = !open; this.render(true); } },
      h("span", { class: "fold" }, open ? "▾" : "▸"), h("span", {}, `${members.length} definition${members.length === 1 ? "" : "s"} that fail on some or all recorded telegrams`));
    const body = open ? h("div", { class: "card-body single" }, members.map(({ m, g }) => h("div", { class: "frow" },
      h("label", { class: "muted" }, h("input", { type: "checkbox", checked: this.model.included.has(m.def.key), title: "use it anyway", onchange: (e) => (e.target.checked ? setup.choose(row.key, m.def.key, otherKeys, entries) : setup.include(m.def.key, false, entries)) }), " in setup"),
      chip(m.def.circuit, m.def.name), h("span", { class: "badge kind" }, accessKind(m.def)), sourceBadge(m.def), h("span", { class: "mono muted" }, base(m.def.file)), h("span", { class: `badge ${m.def.status}` }, m.def.status),
      h("span", { class: g.failed ? "err" : "warn" }, g.failed ? "decodes none of this message's telegrams" : `fails on ${m.coverage.errors} of ${m.coverage.distinct} recorded variants (${[...m.coverage.errorKinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")})`),
      h("button", { class: "small", title: "a copy of your own, to fix it in the table", onclick: async () => { try { await upsertMine(m.def.csv); this.refresh(); } catch (err) { toast(err.message, "err"); } } }, "copy"),
      h("div", { class: "muted", style: "flex-basis:100%;margin-left:24px" }, whyNot(m.def, app.decoder.scan?.[m.def.source] || {}, g.failed ? m.coverage.errorKinds : null, usedDef))))) : null;
    return h("div", { class: `card ${open ? "open" : ""}` }, head, body);
  }
}
