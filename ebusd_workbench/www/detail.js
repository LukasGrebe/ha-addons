// The detail panel docked below the timeline: everything about the message of a clicked value in one
// view. Tabs switch between the definitions that decode the row (and a new one of your own); for the
// selected definition the panel shows where it comes from, how it compares with the others, its
// history over the recording (chart and list), and an editor with a live preview. Saving the editor
// never changes the source: it makes your own version.
import { api, app, append, bus, fmt, h, toast } from "./app.js";
import { drawChart, nearestPoint, seriesFields, seriesValues } from "./chart.js";
import { KIND_HELP, accessKind, describeConditions, describeDifference, differingFields, groupCandidates, rowTelegrams, structureOf, whyNot } from "./compare.js";
import { idLength, messageColors } from "./colors.js";
import { csvEditor } from "./definition-edit.js";
import { customKey, defineEditor } from "./define-ui.js";
import { setup } from "./setup.js";

const PAGE = 120;
const STATUS_HELP = {
  active: "ebusd uses this definition for this installation (file chosen by the scan, condition met)",
  variant: "from a file of another device variant: ebusd would not load it, but it decodes these telegrams",
  conditional: "its condition was not met by the recorded telegrams, but it decodes them",
  hidden: "in the file ebusd loads, but another definition takes precedence",
  error: "matches the telegram but cannot decode it (wrong length or values)",
  companion: "not seen on the bus: the counterpart of a seen definition (usually for writing)",
  custom: "your own definition: decoded over the whole recording, never chosen automatically",
};
const base = (file) => file.replace(/^.*\//, "");
const chip = (circuit, name) => { const c = messageColors(circuit, name); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit} ${name}`); };

export class DetailPanel {
  constructor(timeline) {
    this.tl = timeline;
    this.state = null;
    this.model = null;
    this.editors = new Map();   // editor elements by row and tab: they keep their draft while the panel is redrawn
    this.previews = new Map();  // live preview of a draft by definition key
    this.dirty = new Set();
    this.historyBody = null;
  }

  get el() { return this.tl.el.details; }
  get isOpen() { return !!this.state; }

  // -- open / close ------------------------------------------------------------------------------------

  /** Show a row, optionally at a clicked run of values. */
  open(row, run = null, { tab = null, field = null } = {}) {
    const same = this.state?.row.key === row.key;
    if (!same) { this.editors.clear(); this.previews.clear(); this.dirty.clear(); }
    this.state = { row, run, tab: tab ?? (same ? this.state.tab : null), tabMembers: same ? this.state.tabMembers : null, compareWith: same ? this.state.compareWith : null, focusMs: run ? (run.t0 + run.t1) / 2 : null, offset: 0, every: false, field: same ? this.state.field : {}, wantedField: field, reveal: new Set() };
    this.scroll = null;
    this.tl.selected = { row, run };
    this.tl.showDock(true);
    this.refreshModel();
    this.ensureTab();
    this.render();
    this.tl.drawPlot();
  }

  close() {
    this.state = null;
    this.model = null;
    this.historyBody = null;
    this.tl.selected = null;
    this.tl.setPreview?.(null, null);
    this.tl.showDock(false);
    this.el.replaceChildren();
    this.tl.drawPlot();
  }

  /** The timeline rebuilt its rows or the decodings changed: follow, unless a draft is being edited. */
  relink(row) { if (this.state && this.state.row.key === row.key) this.state.row = row; }

  /**
   * The timeline rebuilt its rows or the decodings changed (new telegrams arrive all the time): follow, without
   * disturbing the reader: not while something in the panel is being edited, scroll positions and the tab stay.
   */
  refresh() {
    if (!this.state) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshNow(), 600);
  }

  refreshNow() {
    if (!this.state) return;
    const row = this.tl.rows.find((r) => r.key === this.state.row.key);
    if (row) this.state.row = row;   // a row that left the window keeps its panel: it stays put
    if (this.dirty.size) return;
    const active = document.activeElement;
    if (active && this.el.contains(active) && active.matches("input, textarea, select")) {   // typing: catch up when the field is left
      if (!this.waiting) { this.waiting = true; active.addEventListener("blur", () => { this.waiting = false; this.refresh(); }, { once: true }); }
      return;
    }
    this.refreshModel();
    this.ensureTab();
    this.render(true);
  }

  // -- the definitions of the row ----------------------------------------------------------------------------

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
    this.model = { telegrams, candidates, usedKey, groups, shown, hidden, total: telegrams.reduce((n, t) => n + (t.n || 0), 0), current: groups.find((g) => g.hasChosen) || groups.find((g) => g.hasUsed) || shown[0] || null };
  }

  ensureTab() {
    const { shown, hidden, groups } = this.model;
    const keys = new Set([...shown.map((g) => g.key), "new", ...(hidden.length ? ["failing"] : [])]);
    // a group is named by what it decodes, so its key changes when telegrams with new values arrive: follow its members
    if (this.state.tab && !keys.has(this.state.tab) && this.state.tabMembers) {
      const g = shown.find((x) => x.members.some((m) => this.state.tabMembers.has(m.def.key)));
      if (g) this.state.tab = g.key;
    }
    if (this.pendingKey) {
      const g = groups.find((x) => x.members.some((m) => m.def.key === this.pendingKey));
      if (g) { this.state.tab = g.key; this.pendingKey = null; }
    }
    if (this.state.tab && keys.has(this.state.tab)) return;
    const run = this.state.run;
    const runDef = run ? this.tl.decodeOf(this.state.row, run) : null;
    const g = groups.find((x) => runDef && x.members.some((m) => m.def.key === runDef.defKey)) || this.model.current;
    this.state.tab = g && shown.includes(g) ? g.key : shown.length ? shown[0].key : "new";
  }

  membersOf(key) { return new Set(this.model.groups.find((g) => g.key === key)?.members.map((m) => m.def.key) || []); }

  preferred(g) {
    const { row } = this.state;
    return g.members.find((m) => m.def.key === row.defKey) || g.members.find((m) => m.def.key === this.model.usedKey) || g.members.find((m) => !m.def.write) || g.members[0];
  }

  // -- drawing -------------------------------------------------------------------------------------------------

  /** @param keep whether the scroll positions of the panel stay (a refresh) or start again (another tab or row) */
  render(keep = false) {
    const st = this.state;
    if (!st) return;
    const el = this.el;
    const { row } = st;
    const scroll = keep ? this.captureScroll() : null;
    this.scroll = scroll;
    // the history stays on screen while it is read again
    this.prevHistory = keep && this.historyBody && this.historyBody.childNodes.length > 1 ? { key: this.historyKey, nodes: [...this.historyBody.childNodes] } : null;
    this.historyBody = null;
    el.replaceChildren();
    el.classList.add("docked");
    const run = st.run;
    const runDecode = run ? this.tl.decodeOf(row, run) : null;
    append(el,
      h("div", { class: "dtl-head" },
        h("span", { class: "mono key" }, row.label),
        run ? h("span", { class: "dtl-run", title: run.line || "" }, h("b", {}, this.tl.runLabel(row, run).slice(0, 140)), h("span", { class: "muted" }, ` ${run.n === 1 ? fmt.dateTime(run.t0, true) : `${fmt.count(run.n)}× ${fmt.dateTime(run.t0)} – ${fmt.time(run.t1)}`}`)) : h("span", { class: "muted" }, "whole row"),
        h("span", { style: "margin-left:auto" }),
        h("label", { class: "muted", title: "hide candidates that fail to decode some recorded telegram" }, h("input", { type: "checkbox", checked: !!app.settings?.ui?.hideFailing, onchange: (e) => setup.setUi("hideFailing", e.target.checked) }), " hide failing"),
        setup.chosenFor(row.key) ? h("button", { class: "small", title: "forget the choice for this row and use ebusd's choice again", onclick: () => setup.choose(row.key, null) }, "ebusd's choice") : null,
        h("button", { class: "small", title: "how many bytes after the command identify a message (the rest is the value)", onclick: () => this.tl.idMenu(row) }, `ID bytes for ${fmt.hex(row.row.pb)}${fmt.hex(row.row.sb)}: ${idLength(row.row.pb, row.row.sb, this.tl.settings)}`),
        h("button", { class: "small", title: "split or combine this row's messages", onclick: () => this.tl.splitLikeDefinitions(this.model.telegrams) }, "rows like the definitions"),
        h("button", { class: "small", onclick: () => this.close() }, "✕")),
      this.tabs(),
      this.notes(),
      this.body(runDecode));
    if (scroll) this.restoreScroll(scroll);
  }

  captureScroll() {
    const el = this.el;
    return {
      cols: [...el.querySelectorAll(".dcol")].map((c) => c.scrollTop),
      body: [...el.querySelectorAll(".dtl-body")].map((b) => [b.scrollLeft, b.scrollTop]),
      tabs: el.querySelector(".dtabs")?.scrollLeft || 0,
      vlist: el.querySelector(".vlist")?.scrollTop ?? null,
    };
  }

  restoreScroll(s) {
    const el = this.el;
    el.querySelectorAll(".dcol").forEach((c, i) => { c.scrollTop = s.cols[i] || 0; });
    el.querySelectorAll(".dtl-body").forEach((b, i) => { if (s.body[i]) { b.scrollLeft = s.body[i][0]; b.scrollTop = s.body[i][1]; } });
    const tabs = el.querySelector(".dtabs");
    if (tabs) tabs.scrollLeft = s.tabs;
  }

  notes() {
    const { row } = this.state;
    const rowId = (row.row.id || "").length / 2;
    const longer = Math.max(0, ...this.model.candidates.map((c) => c.def.idlen || 0));
    const out = [];
    if (longer > rowId) out.push(h("div", { class: "note-box" }, h("b", {}, "Why so many definitions? "), `This row groups telegrams by only ${rowId} ID byte${rowId === 1 ? "" : "s"}, but the definitions identify their messages by up to ${longer}: these can be different messages (registers) sharing the row. `,
      h("button", { class: "small primary", onclick: () => this.tl.splitLikeDefinitions(this.model.telegrams) }, "Split this row like the definitions")));
    if (!row.defKey && this.model.candidates.length) out.push(h("div", { class: "note-box" }, "ebusd itself has no definition for this row: none of these would be used. Use one anyway, or write your own in the new tab."));
    return out.length ? h("div", {}, out) : null;
  }

  /** How a tab's definition relates to the row's own: the same values or not, and what differs as a definition. */
  relation(g) {
    const cur = this.model.current;
    if (!cur || g === cur) return null;
    const a = this.preferred(g).def, b = this.preferred(cur).def;
    const sameValues = g.coverage.signature === cur.coverage.signature;
    return { sameValues, structure: describeDifference(a, b), fields: sameValues ? [] : differingFields(g.coverage, cur.coverage) };
  }

  /** One short line for a tab: what sets it apart from the row's definition. */
  relationHint(g) {
    const rel = this.relation(g);
    if (!rel) return g === this.model.current ? "the row's definition" : "";
    const list = (names) => `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`;
    if (rel.sameValues) return rel.structure.length ? "same values, defined differently" : "same values";
    const fails = g.coverage.errors ? ` · fails on ${g.coverage.errors}` : "";
    return `${rel.fields.length ? `differs in ${list(rel.fields)}` : "different values"}${fails}`;
  }

  tabs() {
    const st = this.state;
    const m = this.model;
    const tab = (key, label, { title = "", cls = "", onhover = null } = {}) => h("button", { class: `dtab ${st.tab === key ? "on" : ""} ${cls}`, title,
      onclick: () => { st.tab = key; st.offset = 0; st.tabMembers = this.membersOf(key); this.render(); },
      onmouseenter: () => onhover && this.tl.setPreview(st.row, onhover), onmouseleave: () => onhover && this.tl.setPreview(st.row, null) }, label);
    const tabs = m.shown.map((g) => {
      const pref = this.preferred(g);
      const def = pref.def;
      const rel = this.relation(g);
      const hint = this.relationHint(g);
      const full = rel ? (rel.sameValues ? "Decodes the same values over the whole history as the row's definition." : `Decodes different values than the row's definition${rel.fields.length ? ` (${rel.fields.join(", ")})` : ""}.`) + (rel.structure.length ? ` As a definition it differs in: ${rel.structure.join("; ")}.` : " As a definition it has the same structure.") : "The definition of this row.";
      return tab(g.key, [
        h("span", { class: "t1" },
          g.hasChosen ? h("span", { class: "dot on", title: "used for this row and part of your setup" }, "●") : h("span", { class: "dot" }, "○"),
          h("span", { class: "tname" }, `${def.circuit} ${def.name}`),
          h("span", { class: "tmeta" }, accessKind(def)),
          g.members.length > 1 ? h("span", { class: "tmeta", title: `the same definition in ${g.members.length} files` }, `×${g.members.length}`) : null,
          g.hasUsed ? h("span", { class: "tbadge active", title: "ebusd's choice" }, "ebusd") : null,
          def.source === "custom" ? h("span", { class: "tbadge custom", title: "your own definition" }, "mine") : def.source !== "base" ? h("span", { class: "tbadge", title: `from ${def.source}` }, def.source) : null,
          g.coverage.errors ? h("span", { class: "tbadge warn", title: "fails on some recorded telegram" }, "⚠") : null),
        h("span", { class: `t2 ${rel ? (rel.sameValues ? "same" : "differs") : ""}` }, hint),
      ], { title: `${def.circuit} ${def.name} · ${accessKind(def)} · ${STATUS_HELP[def.status] || def.status}\n${full}`, onhover: def.key });
    });
    if (m.hidden.length) tabs.push(tab("failing", `${m.hidden.reduce((n, g) => n + g.members.length, 0)} failing`, { title: "candidates that fail to decode some or all recorded telegrams", cls: "muted single" }));
    tabs.push(tab("new", "＋ new definition", { title: "write a definition of your own, prefilled from the recording", cls: "new single" }));
    return h("div", { class: "dtabs" }, tabs);
  }

  body(runDecode) {
    const st = this.state;
    const m = this.model;
    if (st.tab === "new") return this.newBody();
    if (st.tab === "failing") return this.failingBody();
    const g = m.groups.find((x) => x.key === st.tab);
    if (!g) return h("div", { class: "pad muted" }, "no definition");
    st.tabMembers = new Set(g.members.map((x) => x.def.key));
    const pref = this.preferred(g);
    const history = this.historySection(pref.def);
    return h("div", { class: "dtl-body" },
      h("div", { class: "dcol" }, this.sourceSection(g, pref)),
      h("div", { class: "dcol" }, this.compareSection(g, pref)),
      h("div", { class: "dcol" }, history),
      h("div", { class: "dcol" }, this.editSection(g, pref)));
  }

  // -- source -----------------------------------------------------------------------------------------------------

  sourceSection(g, pref) {
    const { row } = this.state;
    const def = pref.def;
    const entries = app.decoder.entries;
    const included = new Set(setup.includedKeys(entries));
    const otherKeys = this.model.candidates.map((c) => c.def.key);
    const names = [...new Set(g.members.map((x) => `${x.def.circuit} ${x.def.name}`))];
    const renameKey = `rename|${def.key}`;
    const renaming = this.state.reveal.has(renameKey);
    const cond = describeConditions(def);
    const exportName = setup.exportName(def);
    const sec = h("section", { class: "dsec" }, h("h4", {}, "Source"));
    append(sec,
      h("div", { class: "row" },
        h("button", { class: `pick ${g.hasChosen ? "on" : ""}`, title: g.hasChosen ? "used for this row and part of your setup" : "use this definition for this row (it joins your setup, the row's other definitions leave it)", onclick: () => setup.choose(row.key, def.key, otherKeys, entries) }, g.hasChosen ? "● used" : "○ use for this row"),
        h("label", { class: "muted", title: "part of the setup of this installation" }, h("input", { type: "checkbox", checked: included.has(def.key), onchange: (e) => setup.include(def.key, e.target.checked, entries) }), " in setup"),
        h("button", { class: "small", onclick: () => { this.state.reveal[renaming ? "delete" : "add"](renameKey); this.render(); } }, renaming ? "done" : "rename"),
        def.source !== "custom" ? h("button", { class: "small", title: "open the TypeSpec source of this definition at its line", onclick: () => bus.emit("open-source", def) }, "TypeSpec source ↗") : null),
      h("div", { class: "row" }, names.map((n) => chip(...n.split(/ (.+)/).slice(0, 2))), exportName !== def.name ? h("span", { class: "export" }, `→ ${setup.circuitOf(def)} ${exportName}`) : null),
      h("dl", { class: "kv" },
        h("dt", {}, "kind"), h("dd", {}, h("span", { class: `badge kind ${def.write ? "write" : ""}` }, accessKind(def)), ` ${KIND_HELP[accessKind(def)]}`),
        h("dt", {}, "comes from"), h("dd", {}, def.source === "base" ? "your checkout" : def.source === "custom" ? "your own definitions" : `community change ${def.source}`),
        h("dt", {}, "applies"), h("dd", {}, cond ? `only when ${cond}` : "always (for the right device)"),
        h("dt", {}, "status"), h("dd", {}, h("span", { class: `badge ${def.status}` }, def.status), ` ${pref.def.key === this.model.usedKey ? "ebusd uses this definition." : whyNot(def, app.decoder.scan || {}, null, this.model.candidates.find((c) => c.def.key === this.model.usedKey)?.def || null)}`)),
      g.members.length > 1 ? h("div", { class: "files" }, h("div", { class: "muted" }, `The same definition is in ${g.members.length} files, for different device variants:`),
        g.members.map((x) => h("div", { class: "frow" },
          h("button", { class: `pick ${x.def.key === row.defKey ? "on" : ""}`, title: "use exactly this one", onclick: () => setup.choose(row.key, x.def.key, otherKeys, entries) }, x.def.key === row.defKey ? "●" : "○"),
          h("span", { class: "mono", title: x.def.file }, base(x.def.file)), h("span", { class: `badge ${x.def.status}`, title: STATUS_HELP[x.def.status] }, x.def.status),
          x.def.source !== "base" ? h("span", { class: "badge" }, x.def.source) : null,
          h("label", { class: "muted" }, h("input", { type: "checkbox", checked: included.has(x.def.key), onchange: (e) => setup.include(x.def.key, e.target.checked, entries) }), " in setup")))) : h("div", { class: "muted mono" }, def.file),
      renaming ? this.tl.renameForm(def, g.coverage.latest?.fields || null, () => { this.state.reveal.delete(renameKey); this.render(); }) : null);
    return sec;
  }

  // -- comparison -------------------------------------------------------------------------------------------------

  compareSection(g, pref) {
    const m = this.model;
    const st = this.state;
    const sec = h("section", { class: "dsec" }, h("h4", {}, "Compared with another definition"));
    const others = m.shown.filter((x) => x !== g);
    if (!others.length) return append(sec, h("div", { class: "muted" }, "No other definition decodes this row: nothing to compare with."), this.sameFiles(g));
    const other = others.find((x) => x.key === st.compareWith) || (m.current && m.current !== g ? m.current : others[0]);
    const label = (x) => { const p = this.preferred(x).def; return `${x === m.current ? "● " : ""}${p.circuit} ${p.name} · ${accessKind(p)}${x.members.length > 1 ? ` · ×${x.members.length} files` : ""}`; };
    const pick = h("select", { onchange: () => { st.compareWith = pick.value; this.render(true); } }, others.map((x) => h("option", { value: x.key, selected: x === other }, label(x))));
    const a = pref.def, b = this.preferred(other).def;
    const sameValues = g.coverage.signature === other.coverage.signature;
    const diff = describeDifference(a, b);
    const sx = structureOf(a.csv), sy = structureOf(b.csv);
    const fmtField = (f) => f ? `${f.name || "?"} · ${f.part === "m" ? "request" : "answer"} ${f.type}${f.divisor ? ` ${f.divisor}` : ""}${f.unit ? ` ${f.unit}` : ""}` : "—";
    const sameField = (f, g2) => f && g2 && f.part === g2.part && f.type === g2.type && f.divisor === g2.divisor && f.unit === g2.unit;
    const rows = [];
    const row = (what, x, y, differs, mono = false) => rows.push(h("tr", { class: differs ? "diff" : "" }, h("td", {}, what), h("td", { class: mono ? "mono" : "" }, x), h("td", { class: mono ? "mono" : "" }, y)));
    row("kind", accessKind(a), accessKind(b), accessKind(a) !== accessKind(b));
    row("message ID", `${sx.pbsb} ${sx.id}`, `${sy.pbsb} ${sy.id}`, sx.pbsb !== sy.pbsb || sx.id !== sy.id, true);
    if (sx.qq !== sy.qq || sx.zz !== sy.zz) row("from → to", `${sx.qq || "any"} → ${sx.zz || "any"}`, `${sy.qq || "any"} → ${sy.zz || "any"}`, true, true);
    for (let i = 0; i < Math.max(sx.fields.length, sy.fields.length); i++) {
      const f = sx.fields[i], f2 = sy.fields[i];
      rows.push(h("tr", { class: sameField(f, f2) ? (f?.name === f2?.name ? "" : "names") : "diff" }, h("td", {}, `field ${i + 1}`), h("td", { class: "mono" }, fmtField(f)), h("td", { class: "mono" }, fmtField(f2))));
    }
    const la = g.coverage.latest?.fields || {}, lb = other.coverage.latest?.fields || {};
    const diffNames = new Set(differingFields(g.coverage, other.coverage));
    for (const name of new Set([...Object.keys(la), ...Object.keys(lb)])) rows.push(h("tr", { class: diffNames.has(name) ? "diff" : "" }, h("td", {}, `latest ${name}`), h("td", { class: "mono" }, name in la ? String(la[name]) : "—"), h("td", { class: "mono" }, name in lb ? String(lb[name]) : "—")));
    if (st.run) {
      const line = st.run.line;
      const clicked = (x) => { const d = line ? app.decoder.decodesOf(line)?.get(this.preferred(x).def.key) : null; return d ? (d.result === "ok" ? d.text || "(empty)" : `✗ ${d.result}`) : "—"; };
      rows.unshift(h("tr", {}, h("td", {}, "the value you clicked"), h("td", { class: "mono" }, clicked(g)), h("td", { class: "mono" }, clicked(other))));
    }
    const cov = (x) => x.coverage.errors ? `${fmt.count(x.coverage.ok)} of ${fmt.count(x.coverage.distinct)} variants decode` : `all ${fmt.count(x.coverage.ok)} variants decode`;
    rows.push(h("tr", { class: g.coverage.errors !== other.coverage.errors ? "diff" : "" }, h("td", {}, "decodes"), h("td", {}, cov(g)), h("td", {}, cov(other))));
    rows.push(h("tr", {}, h("td", {}, "in files"), h("td", { class: "mono" }, g.members.map((x) => base(x.def.file)).join(", ")), h("td", { class: "mono" }, other.members.map((x) => base(x.def.file)).join(", "))));
    append(sec,
      h("div", { class: "row" }, h("label", { class: "muted" }, "this tab against"), pick),
      h("div", { class: sameValues ? "ok verdict" : "warn verdict" }, sameValues
        ? (diff.length ? "Decodes the same values over the whole history, but is defined differently." : "Identical: the same definition, decoding the same values.")
        : `Decodes different values${diffNames.size ? ` (${[...diffNames].join(", ")})` : ""}${diff.length ? " and is defined differently" : ""}.`),
      h("table", { class: "cmp" }, h("thead", {}, h("tr", {}, h("th", {}), h("th", {}, `${a.circuit} ${a.name} (this tab)`), h("th", {}, `${b.circuit} ${b.name}`))), h("tbody", {}, rows)),
      h("div", { class: "muted" }, "Highlighted rows differ; rows in italics only differ in a name."),
      this.sameFiles(g));
    return sec;
  }

  /** Where else the very same definition (structure and values) is: copies in other files and circuits. */
  sameFiles(g) {
    if (g.members.length < 2) return null;
    return h("div", { class: "muted" }, `Identical copies of this definition: ${g.members.map((x) => `${x.def.circuit} ${x.def.name} in ${base(x.def.file)}`).join("; ")}.`);
  }

  // -- history ------------------------------------------------------------------------------------------------------

  historySection(def) {
    const sec = h("section", { class: "dsec" }, h("h4", {}, "History"));
    const body = h("div", { class: "history" });
    append(sec, body);
    this.historyBody = body;
    this.historyDef = def;
    this.historyKey = `${this.state.row.key}|${def.key}`;
    if (this.prevHistory?.key === this.historyKey) body.append(...this.prevHistory.nodes);
    this.prevHistory = null;
    this.fillHistory();
    return sec;
  }

  async fillHistory() {
    const body = this.historyBody;
    const def = this.historyDef;
    if (!body || !def) return;
    const row = this.state.row;
    if (!body.firstChild) body.textContent = "loading history…";
    let data;
    try { data = await this.tl.loadSeries(row); } catch (err) { body.textContent = `history failed: ${err.message}`; return; }
    if (this.historyBody !== body) return;
    if (!data) { body.textContent = "no recording"; return; }
    const preview = this.previews.get(def.key);
    const decodeFor = (line) => (preview ? preview.results.get(line) : app.decoder.decodesOf(line)?.get(def.key));
    const shim = { decodesOf: (line) => { const d = decodeFor(line); return d ? new Map([["k", d]]) : undefined; } };
    const fields = seriesFields(data, shim, "k");
    let field = this.state.field[def.key] || this.state.wantedField;
    if (!field || !fields.includes(field)) field = fields.find((f) => seriesValues(data, shim, "k", f).numeric) || fields[0];
    const series = seriesValues(data, shim, "k", field);
    const db = app.status.db;
    const t0 = db.first_ms, t1 = db.last_ms + 1000;
    const select = fields.length > 1 ? h("select", { onchange: () => { this.state.field[def.key] = select.value; this.fillHistory(); } }, fields.map((f) => h("option", { value: f, selected: f === field }, f))) : null;
    const canvas = h("canvas");
    const info = h("div", { class: "hint" });
    let geometry = null;
    const paint = (hover = null) => { geometry = drawChart(canvas, series, { t0, t1, width: Math.max(300, (body.clientWidth || 420) - 4), height: 130, band: { from: this.tl.t0, to: this.tl.t1 }, hoverMs: hover }); };
    const summary = () => {
      const values = series.points.map((p) => p.value);
      const range = series.numeric && values.length ? ` · ${Math.min(...values)} … ${Math.max(...values)}` : "";
      info.textContent = `${fmt.count(series.points.length)} telegrams${data.stride > 1 ? ` (every ${data.stride}th of ${fmt.count(data.total)})` : ""}${range}${preview ? " · this is your draft, not the saved definition" : ""} · click to go there`;
    };
    canvas.addEventListener("mousemove", (e) => { const ms = geometry.tOf(e.offsetX), p = nearestPoint(series, ms); paint(ms); info.textContent = p ? `${fmt.dateTime(p.ms)}  ${field ? `${field} = ` : ""}${p.value}` : ""; });
    canvas.addEventListener("mouseleave", () => { paint(); summary(); });
    canvas.addEventListener("click", (e) => { const ms = geometry.tOf(e.offsetX); this.state.focusMs = ms; this.state.offset = 0; bus.emit("goto-time", ms); this.fillHistory(); });
    // the list: values in runs of the same decoded text, newest first
    const entries = [];
    for (const [ms, i] of data.points) {
      const d = decodeFor(data.lines[i]);
      if (!d || d.result !== "ok") continue;
      const text = d.text || "(empty)";
      const last = entries[entries.length - 1];
      if (!this.state.every && last && last.text === text) { last.t1 = ms; last.n++; } else entries.push({ t0: ms, t1: ms, n: 1, text, line: data.lines[i] });
    }
    entries.reverse();
    const focus = this.state.focusMs;
    let start = 0;
    if (focus !== null && focus !== undefined) { const idx = entries.findIndex((e) => e.t0 <= focus); start = Math.max(0, (idx < 0 ? entries.length - 1 : idx) - 3); }
    start = Math.max(0, Math.min(entries.length - 1, start + this.state.offset * PAGE));
    const page = entries.slice(start, start + PAGE);
    const run = this.state.run;
    const list = h("div", { class: "vlist" }, h("table", {}, h("tbody", {}, page.map((e) => h("tr", { class: run && e.t1 >= run.t0 && e.t0 <= run.t1 ? "hl" : "", title: e.line, onclick: () => bus.emit("goto-time", (e.t0 + e.t1) / 2) },
      h("td", { class: "mono nowrap" }, e.n > 1 ? `${fmt.dateTime(e.t0).slice(5)} – ${e.t0 - e.t1 === 0 ? "" : fmt.time(e.t1)}` : fmt.dateTime(e.t0, true).slice(5)),
      h("td", { class: "muted nowrap" }, e.n > 1 ? `×${fmt.count(e.n)}` : ""), h("td", { class: "mono" }, e.text))))));
    body.replaceChildren();
    append(body,
      h("div", { class: "row" }, field ? [h("b", {}, "chart of"), select || h("span", { class: "mono" }, field)] : null, h("span", { style: "margin-left:auto" }),
        h("label", { class: "muted", title: "list every telegram instead of runs of the same value" }, h("input", { type: "checkbox", checked: this.state.every, onchange: (e) => { this.state.every = e.target.checked; this.state.offset = 0; this.fillHistory(); } }), " every telegram")),
      series.points.length ? canvas : h("div", { class: "muted" }, "this definition decodes none of the row's telegrams"), info,
      h("div", { class: "row" }, h("b", {}, "Values"), h("span", { class: "muted" }, `${fmt.count(entries.length)} ${this.state.every ? "telegrams" : "changes"}, newest first`), h("span", { style: "margin-left:auto" }),
        h("button", { class: "small", disabled: start === 0, onclick: () => { this.state.offset--; this.fillHistory(); } }, "▲ newer"),
        h("button", { class: "small", disabled: start + PAGE >= entries.length, onclick: () => { this.state.offset++; this.fillHistory(); } }, "▼ older")),
      list);
    paint(); summary();
    const hl = list.querySelector("tr.hl");
    if (this.scroll && this.scroll.vlist !== null) { list.scrollTop = this.scroll.vlist; this.scroll = null; } else if (hl) list.scrollTop = Math.max(0, hl.offsetTop - list.clientHeight / 3);   // scroll the list only, not the panel
  }

  // -- editing --------------------------------------------------------------------------------------------------------

  editSection(g, pref) {
    const { row } = this.state;
    const def = pref.def;
    const key = `edit|${row.key}|${def.key}`;
    const sec = h("section", { class: "dsec" }, h("h4", {}, def.source === "custom" ? "Edit my definition" : "Edit: make your own version"));
    if (!this.editors.has(key)) {
      const editor = csvEditor({
        def, telegrams: this.model.telegrams, decoder: app.decoder, own: app.settings?.own_address || "31",
        onDirty: (dirty) => { dirty ? this.dirty.add(key) : this.dirty.delete(key); },
        onPreview: (preview) => { if (preview) this.previews.set(def.key, preview); else this.previews.delete(def.key); if (this.historyDef?.key === def.key) this.fillHistory(); },
        onSave: (csv) => this.saveVersion(csv, def, key),
      });
      this.editors.set(key, editor.el);
    }
    append(sec, this.editors.get(key));
    return sec;
  }

  newBody() {
    const { row } = this.state;
    const key = `new|${row.key}`;
    if (!this.editors.has(key)) {
      const el = defineEditor({
        row, telegrams: this.model.telegrams, scan: app.decoder.scan || {}, own: app.settings?.own_address || "31", decoder: app.decoder,
        onClose: () => { this.state.tab = this.model.shown[0]?.key || "new"; this.render(); },
        onSave: (csv, header) => this.saveVersion(csv, null, key, header),
      });
      this.editors.set(key, el);
    }
    return h("div", { class: "dtl-body single" }, h("div", { class: "dcol wide" }, h("section", { class: "dsec" }, h("h4", {}, "New definition, prefilled from the recording"), this.editors.get(key))));
  }

  failingBody() {
    const { row } = this.state;
    const entries = app.decoder.entries;
    const otherKeys = this.model.candidates.map((c) => c.def.key);
    const scan = app.decoder.scan || {};
    const usedDef = this.model.candidates.find((c) => c.def.key === this.model.usedKey)?.def || null;
    const members = this.model.hidden.flatMap((g) => g.members.map((m) => ({ m, g })));
    return h("div", { class: "dtl-body single" }, h("div", { class: "dcol wide" }, h("section", { class: "dsec" }, h("h4", {}, "Definitions that fail on some or all recorded telegrams"),
      members.map(({ m, g }) => h("div", { class: "frow" },
        h("button", { class: "pick", title: "use this definition anyway", onclick: () => setup.choose(row.key, m.def.key, otherKeys, entries) }, "○"),
        chip(m.def.circuit, m.def.name), h("span", { class: "badge kind" }, accessKind(m.def)), h("span", { class: "mono muted" }, base(m.def.file)), h("span", { class: `badge ${m.def.status}` }, m.def.status),
        h("span", { class: g.failed ? "err" : "warn" }, g.failed ? "decodes none of this row's telegrams" : `fails on ${m.coverage.errors} of ${m.coverage.distinct} recorded variants (${[...m.coverage.errorKinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")})`),
        h("div", { class: "muted", style: "flex-basis:100%;margin-left:24px" }, whyNot(m.def, scan, g.failed ? m.coverage.errorKinds : null, usedDef)))))));
  }

  /** Your own version of a definition (or a new one): the source is never modified. */
  async saveVersion(csv, def, editKey, header = null) {
    const { row } = this.state;
    try {
      const key = await app.views.definitions.upsertCustom(csv, def?.source === "custom" ? def.key : null);
      const decoder = app.decoder;
      if (!key || !decoder.def(key)) { toast("saved, but it decodes none of this row's telegrams: check the line", "err", 6000); return; }
      setup.choose(row.key, key, this.model.candidates.map((c) => c.def.key), decoder.entries);
      toast(`${header ? `${header.circuit} ${header.name}` : "your version"} saved and chosen for this row`);
      this.editors.delete(editKey);
      if (def) this.previews.delete(def.key);
      this.dirty.clear();
      this.pendingKey = key;
      this.refreshModel();
      this.ensureTab();
      this.render();
    } catch (err) { toast(err.message, "err"); }
  }
}

export { customKey };
