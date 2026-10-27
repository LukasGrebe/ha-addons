// The inspector of the selected message and what goes with it, inserted under the message's row in
// the list: the telegram byte by byte with every definition that fits as a row (see inspector.js),
// the chart of the selected field, the definitions that fail, and the search over the open pull
// requests. It stays put: the list freezes while a message is selected, and the inspector is only
// drawn again when its structure changes (another definition fits, the pick changed) or on your own
// actions (stepping through the telegrams, choosing a field), never while you type.
import { app, append, bus, fmt, h, toast } from "./app.js";
import { drawChart, nearestPoint, seriesFields, seriesValues } from "./chart.js";
import { accessKind, groupCandidates, rowTelegrams, whyNot } from "./compare.js";
import { messageColors } from "./colors.js";
import { analyzeBytes, buildCsv, defaultHeader, initialSegments, samplesOf } from "./define.js";
import { MINE, setup } from "./setup.js";
import { upsertMine } from "./mine.js";
import { prSearch } from "./prsearch.js";
import { inspector } from "./inspector.js";

const PAGE = 120;
const base = (file) => file.replace(/^.*\//, "");
const chip = (circuit, name) => { const c = messageColors(circuit, name); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit} ${name}`); };
const sourceBadge = (def) => h("span", { class: `tbadge ${def.source === MINE ? "custom" : def.source === "release" ? "" : "src"}`, title: `from ${def.sourceLabel || def.source}` }, def.source === MINE ? "mine" : def.sourceLabel || def.source);

export class Scratchpad {
  constructor(view) {
    this.view = view;                      // the list of messages
    this.host = h("div", { class: "insp-host" });
    this.state = null;
    this.model = null;
    this.key = null;                       // the structure the inspector was drawn for
    this.histories = new Map();
    bus.on("select-row", (sel) => { if (sel?.view) this.view = sel.view; sel ? this.open(sel.row, sel.run, sel.options) : this.close(); });
    bus.on("decodes-changed", (reason) => { if (reason !== "progress") this.refresh(); });
    bus.on("setup-changed", () => this.refresh());
    bus.on("settings-changed", () => this.refresh());
  }

  get isOpen() { return !!this.state; }

  // -- open / close ------------------------------------------------------------------------------------

  open(row, run = null, { field = null } = {}) {
    const same = this.state?.row.key === row.key;
    this.state = { row, run, focusMs: run ? (run.t0 + run.t1) / 2 : null, offset: 0, every: same ? this.state.every : false, field: same ? this.state.field : {}, wantedField: field,
      failingOpen: same && this.state.failingOpen, tIndex: same ? this.state.tIndex : 0, sel: same ? this.state.sel : null };
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
    this.histories.clear();
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
    const defKey = chosen && candidates.some((c) => c.def.key === chosen) ? chosen : usedKey || candidates.find((c) => included.has(c.def.key))?.def.key || null;
    this.model = { telegrams, candidates, usedKey, groups, shown, hidden, included, defKey, total: telegrams.reduce((n, t) => n + (t.n || 0), 0),
      current: groups.find((g) => g.members.some((m) => m.def.key === defKey)) || groups.find((g) => g.hasUsed) || shown[0] || null };
  }

  /** What the inspector is made of: a change of this is the only reason to draw it again by itself. */
  structureKey() {
    const m = this.model;
    return JSON.stringify([app.decoder.build?.id, m.shown.map((g) => g.members.map((x) => (x.def.source === MINE ? x.def.csv : x.def.key))), m.hidden.length, m.defKey, [...m.included].filter((k) => m.candidates.some((c) => c.def.key === k)), m.telegrams.length]);
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
    this.refreshTimer = setTimeout(() => this.refreshNow(), 600);
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

  /** @param keep whether the scroll positions stay (a refresh or a step) or start again (another message) */
  render(keep = false) {
    const host = this.host;
    const st = this.state;
    if (!st) return;
    const list = host.closest(".msg-list");
    const wrap = host.querySelector(".inspector-wrap");
    const scroll = keep ? { list: list?.scrollTop ?? 0, wrap: wrap?.scrollLeft ?? 0, vlist: host.querySelector(".vlist")?.scrollTop ?? 0 } : null;
    this.prevHistories = keep ? new Map([...this.histories].map(([k, box]) => [k, box.childNodes.length > 1 ? [...box.childNodes] : null])) : new Map();
    this.histories.clear();
    host.replaceChildren();
    if (st.row.kind === "event") this.renderEvent(host); else this.renderRow(host);
    this.key = this.model ? this.structureKey() : null;
    if (scroll) {
      if (list) list.scrollTop = scroll.list;
      const w = host.querySelector(".inspector-wrap"); if (w) w.scrollLeft = scroll.wrap;
      const v = host.querySelector(".vlist"); if (v) v.scrollTop = scroll.vlist;
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
      this.selectedHistory(),
      m.hidden.length ? h("div", { class: "cards" }, this.failingCard()) : null,
      prHost);
    // the search over the pull requests draws its own box as it goes, not the whole inspector
    const prChanged = () => { if (this.state?.row.key === row.key && prHost.isConnected) prHost.replaceChildren(prSearch.section(row, m.telegrams, prChanged)); };
    prHost.appendChild(prSearch.section(row, m.telegrams, prChanged));
  }

  notes() {
    const { row } = this.state;
    const out = [];
    if (row.scan) out.push(h("div", { class: "note-box" }, row.pbsb === "0704"
      ? "ebusd's scan: the identification every device answers (manufacturer, device id, software and hardware version). Nothing to define."
      : "ebusd's scan of a Vaillant device: its serial number in four parts as text (b5 09 24, 25, 26 and 27; vaillant/scan.csv, Scan Id), asked by ebusd itself right after the identification. Nothing to define."));
    if (!row.defKey && this.model.candidates.length) out.push(h("div", { class: "note-box" }, "ebusd itself has no definition for this message: none of these would be used as they are. Tick one for your setup, or change a copy of it."));
    if (!this.model.candidates.length && !row.scan) out.push(h("div", { class: "note-box" }, "No definition of any source decodes this message. Start one of your own from the bytes below (the tooltip of a byte says what it could be), or search the open pull requests."));
    return out.length ? h("div", {}, out) : null;
  }

  /** The inspector: the telegram byte by byte, every fitting definition as a row, with the values and sparklines. */
  inspectorSection() {
    const st = this.state, m = this.model;
    const defs = m.shown.map((g) => ({ def: this.preferred(g).def, group: g }));
    const usedDef = m.candidates.find((c) => c.def.key === m.usedKey)?.def || null;
    return inspector({
      row: st.row, telegrams: m.telegrams, defs, decoder: app.decoder, view: this.view, telegramIndex: st.tIndex, selected: st.sel,
      included: m.included, otherKeys: m.candidates.map((c) => c.def.key), usedKey: m.usedKey, usedDef, defKey: m.defKey,
      onTelegram: (i) => { st.tIndex = i; this.render(true); },
      onSelect: (defKey, field) => { st.sel = { defKey, field }; st.field[defKey] = field; this.render(true); },
      onChange: () => this.refresh(),
      onNew: () => this.newDefinition(),
    });
  }

  /** A line of your own for this message: one raw field per part, named after the device; edit it in the table. */
  async newDefinition() {
    const { row } = this.state;
    const telegrams = this.model.telegrams;
    const idBytes = (row.row.id || "").length / 2;
    const samples = samplesOf(telegrams, idBytes);
    const header = defaultHeader(row.row, samples, { scan: app.decoder.devices(), own: app.settings?.own_address || "31" });
    header.name = `New_${row.pbsb || ""}${row.id || ""}`.replace(/[^A-Za-z0-9_]/g, "");
    const parts = { m: initialSegments(analyzeBytes(samples, "m").length), s: initialSegments(analyzeBytes(samples, "s").length) };
    try {
      const key = await upsertMine(buildCsv(header, parts));
      setup.choose(row.key, key, this.model.candidates.map((c) => c.def.key), app.decoder.entries);
      this.state.sel = { defKey: key, field: null };
      toast("a definition of your own: change its fields in the table");
      this.refresh();
    } catch (err) { toast(err.message, "err"); }
  }

  /** The chart and the values of the selected field (the first field of the message's definition until one is clicked). */
  selectedHistory() {
    const st = this.state, m = this.model;
    let def = st.sel ? app.decoder.def(st.sel.defKey) : null;
    if (!def && m.current) def = this.preferred(m.current).def;
    if (!def) return null;
    return this.historySection(def);
  }

  // -- history ------------------------------------------------------------------------------------------------------

  historySection(def) {
    const sec = h("section", { class: "dsec" }, h("h4", {}, `History over the recording: ${def.circuit} ${def.name}`));
    const body = h("div", { class: "history" });
    append(sec, body);
    this.histories.set(def.key, body);
    const prev = this.prevHistories?.get(def.key);
    if (prev) body.append(...prev);
    this.fillHistory(def, body);
    return sec;
  }

  async fillHistory(def, body) {
    if (!this.state) return;
    const row = this.state.row;
    if (!body.firstChild) body.textContent = "loading history…";
    let data;
    try { data = await this.view.loadSeries(row); } catch (err) { body.textContent = `history failed: ${err.message}`; return; }
    if (this.histories.get(def.key) !== body) return;
    if (!data) { body.textContent = "no recording"; return; }
    const decodeFor = (line) => app.decoder.decodesOf(line)?.get(def.key);
    const shim = { decodesOf: (line) => { const d = decodeFor(line); return d ? new Map([["k", d]]) : undefined; } };
    const fields = seriesFields(data, shim, "k");
    let field = this.state.field[def.key] || this.state.wantedField;
    if (!field || !fields.includes(field)) field = fields.find((f) => seriesValues(data, shim, "k", f).numeric) || fields[0];
    const series = seriesValues(data, shim, "k", field);
    const db = app.status.db;
    const t0 = db.first_ms, t1 = db.last_ms + 1000;
    const canvas = h("canvas");
    const info = h("div", { class: "hint" });
    let geometry = null;
    const width = Math.max(300, (body.clientWidth || this.host.clientWidth || 600) - 8);
    const paint = (hover = null) => { geometry = drawChart(canvas, series, { t0, t1, width, height: 150, band: this.view.window?.() || null, hoverMs: hover }); };
    const summary = () => {
      const values = series.points.map((p) => p.value);
      const range = series.numeric && values.length ? ` · ${Math.min(...values)} … ${Math.max(...values)}` : "";
      info.textContent = `${field ? `${field}: ` : ""}${fmt.count(series.points.length)} telegrams${data.stride > 1 ? ` (every ${data.stride}th of ${fmt.count(data.total)})` : ""}${range} · click a point to show that telegram`;
    };
    canvas.addEventListener("mousemove", (e) => { const ms = geometry.tOf(e.offsetX), p = nearestPoint(series, ms); paint(ms); info.textContent = p ? `${fmt.dateTime(p.ms)}  ${field ? `${field} = ` : ""}${p.value}` : ""; });
    canvas.addEventListener("mouseleave", () => { paint(); summary(); });
    canvas.addEventListener("click", (e) => {
      const ms = geometry.tOf(e.offsetX), p = nearestPoint(series, ms);
      if (!p) return;
      const idx = data.points.findIndex(([pm]) => pm === p.ms);
      const line = idx >= 0 ? data.lines[data.points[idx][1]] : null;
      const at = line ? this.telegramsNewestFirst().findIndex((t) => t.line === line) : -1;
      if (at >= 0) { this.state.tIndex = at; this.state.focusMs = ms; this.state.offset = 0; this.render(true); }
    });
    const entries = [];
    for (const [ms, i] of data.points) {
      const d = decodeFor(data.lines[i]);
      if (!d || d.result !== "ok") continue;
      const text = field && d.fields && field in d.fields ? String(d.fields[field]) : d.text || "(empty)";
      const last = entries[entries.length - 1];
      if (!this.state.every && last && last.text === text) { last.t1 = ms; last.n++; } else entries.push({ t0: ms, t1: ms, n: 1, text, line: data.lines[i] });
    }
    entries.reverse();
    const focus = this.state.focusMs;
    let start = 0;
    if (focus !== null && focus !== undefined) { const idx = entries.findIndex((e) => e.t0 <= focus); start = Math.max(0, (idx < 0 ? entries.length - 1 : idx) - 3); }
    start = Math.max(0, Math.min(entries.length - 1, start + this.state.offset * PAGE));
    const page = entries.slice(start, start + PAGE);
    const current = this.telegramsNewestFirst()[this.state.tIndex]?.line;
    const list = h("div", { class: "vlist" }, h("table", {}, h("tbody", {}, page.map((e) => h("tr", { class: e.line === current ? "hl" : "", title: e.line, onclick: () => { const at = this.telegramsNewestFirst().findIndex((t) => t.line === e.line); if (at >= 0) { this.state.tIndex = at; this.state.focusMs = e.t0; this.render(true); } } },
      h("td", { class: "mono nowrap" }, e.n > 1 ? `${fmt.dateTime(e.t0).slice(5)} – ${e.t0 - e.t1 === 0 ? "" : fmt.time(e.t1)}` : fmt.dateTime(e.t0, true).slice(5)),
      h("td", { class: "muted nowrap" }, e.n > 1 ? `×${fmt.count(e.n)}` : ""), h("td", { class: "mono" }, e.text))))));
    body.replaceChildren();
    append(body, canvas, info,
      h("div", { class: "row" }, h("b", {}, "Values"), h("span", { class: "muted" }, `${fmt.count(entries.length)} ${this.state.every ? "telegrams" : "changes"}, newest first`),
        h("label", { class: "muted", title: "list every telegram instead of runs of the same value" }, h("input", { type: "checkbox", checked: this.state.every, onchange: (e) => { this.state.every = e.target.checked; this.state.offset = 0; this.fillHistory(def, body); } }), " every telegram"),
        h("span", { style: "margin-left:auto" }),
        h("button", { class: "small", disabled: start === 0, onclick: () => { this.state.offset--; this.fillHistory(def, body); } }, "▲ newer"),
        h("button", { class: "small", disabled: start + PAGE >= entries.length, onclick: () => { this.state.offset++; this.fillHistory(def, body); } }, "▼ older")),
      list);
    paint(); summary();
    const hl = list.querySelector("tr.hl");
    if (hl) list.scrollTop = Math.max(0, hl.offsetTop - list.clientHeight / 3);
  }

  // -- definitions that fail ---------------------------------------------------------------------------------------

  failingCard() {
    const { row } = this.state;
    const open = !!this.state.failingOpen;
    const entries = app.decoder.entries;
    const otherKeys = this.model.candidates.map((c) => c.def.key);
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
