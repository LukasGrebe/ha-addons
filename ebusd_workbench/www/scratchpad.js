// The scratchpad below the bus: everything about the selected message in one place, and your own
// definitions. For the selected row, every definition that decodes it is a card: from which source
// it comes, how it fares over the whole recording, what it decodes, how it compares with the
// others, its history, and an editor with a live check by ebusd's own decoder. Cards fold and
// unfold in place; nothing is a mode. Picking a card puts its definition into your setup. A copy
// of any card (or a new definition read off the bytes) becomes a line of your own, decoded over the
// recording as soon as it is saved. Without a selection the scratchpad lists your own lines.
import { api, app, append, bus, fmt, h, toast } from "./app.js";
import { drawChart, nearestPoint, seriesFields, seriesValues } from "./chart.js";
import { KIND_HELP, accessKind, describeConditions, describeDifference, differingFields, groupCandidates, rowTelegrams, structureOf, whyNot } from "./compare.js";
import { idLength, messageColors } from "./colors.js";
import { csvEditor } from "./definition-edit.js";
import { defineEditor } from "./define-ui.js";
import { MINE, setup } from "./setup.js";
import { mineLines, removeMine, upsertMine } from "./mine.js";
import { prSearch } from "./prsearch.js";

const PAGE = 120;
const STATUS_HELP = {
  active: "ebusd's choice with this source for this installation (file chosen by the scan, condition met)",
  variant: "from a file of another device variant: ebusd would not load it, but it decodes these telegrams",
  conditional: "its condition was not met by the recorded telegrams, but it decodes them",
  hidden: "in the file ebusd loads, but another definition takes precedence",
  error: "matches the telegram but cannot decode it (wrong length or values)",
  companion: "not seen on the bus: the counterpart of a seen definition (usually for writing)",
  custom: "your own definition: decoded over the whole recording, never chosen automatically",
};
const base = (file) => file.replace(/^.*\//, "");
const chip = (circuit, name) => { const c = messageColors(circuit, name); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit} ${name}`); };
const sourceBadge = (def) => h("span", { class: `tbadge ${def.source === MINE ? "custom" : def.source === "release" ? "" : "src"}`, title: `from ${def.sourceLabel || def.source}` }, def.source === MINE ? "mine" : def.sourceLabel || def.source);

export class Scratchpad {
  constructor(root, view) {
    this.root = root;
    this.view = view;              // the view of the bus the selection came from: the list of messages or the timeline
    this.state = null;
    this.model = null;
    this.expanded = new Set();     // definition keys of the unfolded cards (a group is unfolded when one of its members is)
    this.editors = new Map();      // editor elements by row and definition: they keep their draft while the panel is redrawn
    this.previews = new Map();     // live preview of a draft by definition key
    this.dirty = new Set();
    this.histories = new Map();    // definition key -> the history box being filled
    this.mineOpen = new Set();     // keys of the unfolded lines of your own (without a selection)
    bus.on("select-row", (sel) => { if (sel?.view) this.view = sel.view; sel ? this.open(sel.row, sel.run, sel.options) : this.close(); });
    bus.on("rows-built", (rows) => this.relink(rows));
    bus.on("decodes-changed", (reason) => { if (reason !== "progress") this.refresh(); });
    bus.on("setup-changed", () => this.refresh());
    bus.on("settings-changed", () => this.refresh());
    this.render();
  }

  get isOpen() { return !!this.state; }

  // -- open / close ------------------------------------------------------------------------------------

  /** Show a row, optionally at a clicked run of values. */
  open(row, run = null, { tab = null, field = null } = {}) {
    const same = this.state?.row.key === row.key;
    if (!same) { this.editors.clear(); this.previews.clear(); this.dirty.clear(); this.expanded.clear(); }
    this.state = { row, run, compareWith: same ? this.state.compareWith : null, focusMs: run ? (run.t0 + run.t1) / 2 : null, offset: 0, every: same ? this.state.every : false, field: same ? this.state.field : {}, wantedField: field, newOpen: tab === "new" || (same && this.state.newOpen), failingOpen: same && this.state.failingOpen };
    this.scroll = null;
    this.view.select(row, run);
    if (row.kind !== "event") {
      this.refreshModel();
      if (!same && this.model.current) for (const m of this.model.current.members) this.expanded.add(m.def.key);
    }
    this.render();
    this.root.scrollTop = 0;
  }

  close() {
    this.state = null;
    this.model = null;
    this.histories.clear();
    this.view.setPreview?.(null, null);
    this.view.select(null);
    this.render();
  }

  /** The bus rebuilt its rows: follow the selected one (a row that left the window keeps its panel). */
  relink(rows) {
    if (!this.state) return;
    if (this.view.kind !== "timeline") return;
    const row = rows.find((r) => r.key === this.state.row.key);
    if (row) { this.state.row = row; this.view.selected = { row, run: this.state.run }; }
  }

  /** The decodings or the setup changed (new telegrams arrive all the time): follow, without disturbing the reader. */
  refresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshNow(), 600);
  }

  refreshNow() {
    if (this.dirty.size) return;
    const active = document.activeElement;
    if (active && this.root.contains(active) && active.matches("input, textarea, select")) {   // typing: catch up when the field is left
      if (!this.waiting) { this.waiting = true; active.addEventListener("blur", () => { this.waiting = false; this.refresh(); }, { once: true }); }
      return;
    }
    if (this.state && this.state.row.kind !== "event") this.refreshModel();
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

  /** The member of a group that stands for it: the row's, else ebusd's choice, else the copy from ebusd's own definitions (the sources in their order). */
  preferred(g) {
    const { row } = this.state;
    const order = Object.fromEntries(app.decoder.sources().map((s, i) => [s.id, i]));
    return g.members.find((m) => m.def.key === row.defKey) || g.members.find((m) => m.def.key === this.model.usedKey)
      || g.members.slice().sort((a, b) => (order[a.def.source] ?? 99) - (order[b.def.source] ?? 99))[0];
  }

  isExpanded(g) { return g.members.some((m) => this.expanded.has(m.def.key)); }

  toggleGroup(g, open = !this.isExpanded(g)) {
    for (const m of g.members) if (open) this.expanded.add(m.def.key); else this.expanded.delete(m.def.key);
    this.render(true);
  }

  // -- drawing -------------------------------------------------------------------------------------------------

  /** @param keep whether the scroll positions stay (a refresh) or start again (another row) */
  render(keep = false) {
    const el = this.root;
    const scroll = keep ? { top: el.scrollTop, cols: [...el.querySelectorAll(".dcol")].map((c) => c.scrollTop), vlists: [...el.querySelectorAll(".vlist")].map((v) => v.scrollTop) } : null;
    this.scroll = scroll;
    this.prevHistories = keep ? new Map([...this.histories].map(([k, box]) => [k, box.childNodes.length > 1 ? [...box.childNodes] : null])) : new Map();
    this.histories.clear();
    el.replaceChildren();
    if (!this.state) { this.renderMine(el); }
    else if (this.state.row.kind === "event") this.renderEvent(el);
    else this.renderRow(el);
    if (scroll) {
      el.scrollTop = scroll.top;
      el.querySelectorAll(".dcol").forEach((c, i) => { c.scrollTop = scroll.cols[i] || 0; });
      el.querySelectorAll(".vlist").forEach((v, i) => { if (scroll.vlists[i]) v.scrollTop = scroll.vlists[i]; });
    }
  }

  // -- no selection: the scratchpad itself, your own lines ---------------------------------------------------

  renderMine(el) {
    const lines = mineLines();
    const entries = app.decoder?.entries || [];
    const byKey = new Map(entries.filter((e) => e.source === MINE).map((e) => [e.key, e]));
    append(el, h("div", { class: "pad-head" },
      h("b", {}, "Scratchpad"), h("span", { class: "muted" }, "click a message in the bus to see every definition that fits it, compare and pick one; your own definitions are listed here"),
      h("span", { style: "margin-left:auto" }),
      h("label", { class: "muted", title: "hide candidates that fail to decode some recorded telegram" }, h("input", { type: "checkbox", checked: !!app.settings?.ui?.hideFailing, onchange: (e) => setup.setUi("hideFailing", e.target.checked) }), " hide failing")));
    if (!lines.length) {
      append(el, h("div", { class: "pad-empty" },
        h("p", {}, "Nothing of your own yet. Three ways to get a definition of your own:"),
        h("ul", {}, h("li", {}, "click a message in the bus and ", h("b", {}, "copy"), " one of its definitions into your scratchpad to change its fields, names or units"),
          h("li", {}, "click a message that no definition decodes (“＋ define”) and read the fields off its bytes"),
          h("li", {}, "paste ebusd CSV lines below (one per message)")),
        this.pasteBox()));
      return;
    }
    append(el, h("div", { class: "cards" }, lines.map((l) => this.mineCard(l, byKey.get(l.key)))), this.pasteBox());
  }

  pasteBox() {
    const area = h("textarea", { rows: 3, class: "rawcsv", spellcheck: "false", placeholder: "r,hmu,MyTemp,my temperature,,08,b511,01,temp,s,D2C,,°C,\none ebusd CSV line per message: type,circuit,name,comment,qq,zz,pbsb,id, then per field name,part,type,divisor,unit,comment" });
    return h("div", { class: "paste" }, h("div", { class: "muted" }, "Paste definition lines (from a forum post, an issue, a file):"), area,
      h("div", { class: "row" }, h("button", { class: "small primary", onclick: async () => {
        const text = area.value.trim();
        if (!text) return;
        try { for (const line of text.split("\n")) if (line.trim() && !line.trim().startsWith("#")) await upsertMine(line); area.value = ""; toast("added to your definitions and decoded over the recording"); } catch (err) { toast(err.message, "err", 6000); }
      } }, "Add to my definitions"), h("span", { class: "hint" }, "They are decoded over the whole recording at once and show up as candidates (kind: mine) wherever they fit.")));
  }

  mineCard(line, def) {
    const open = this.mineOpen.has(line.key);
    const telegrams = def ? [...app.decoder.telegrams.values()].filter((t) => app.decoder.decodesOf(t.line)?.has(def.key)) : [];
    const head = h("div", { class: "card-head", onclick: (e) => { if (e.target.closest("button, input, a")) return; this.mineOpen[open ? "delete" : "add"](line.key); this.render(true); } },
      h("span", { class: "fold" }, open ? "▾" : "▸"),
      def ? chip(def.circuit, def.name) : h("span", { class: "mono" }, line.line.split(",").slice(1, 3).join(" ")),
      def ? h("span", { class: "tmeta" }, accessKind(def)) : null,
      def ? (def.errors ? h("span", { class: "warn" }, `decodes ${fmt.count(def.ok)} of ${fmt.count(def.distinct)} recorded variants`) : h("span", { class: "ok" }, `decodes all ${fmt.count(def.ok)} recorded variants · ${fmt.count(def.occurrences)} telegrams`)) : h("span", { class: "muted" }, "fits no recorded telegram (or not decoded yet)"),
      def?.examples?.[0] ? h("span", { class: "mono muted ex" }, def.examples[0].slice(0, 80)) : null,
      h("span", { style: "margin-left:auto" }),
      def ? h("label", { class: "muted", title: "part of your setup" }, h("input", { type: "checkbox", checked: setup.isIncluded(def.key, app.decoder.entries), onchange: (e) => setup.include(def.key, e.target.checked, app.decoder.entries) }), " in setup") : null,
      h("button", { class: "small", title: "remove this line from your definitions", onclick: async () => { if (confirm(`Remove ${line.line.slice(0, 60)}…?`)) await removeMine(line.key); } }, "✕"));
    const body = open ? h("div", { class: "card-body single" }, this.mineEditor(line, def, telegrams)) : null;
    return h("div", { class: `card ${open ? "open" : ""}` }, head, body);
  }

  mineEditor(line, def, telegrams) {
    const key = `mine|${line.key}`;
    if (!this.editors.has(key)) {
      const fake = def || { key: line.key, source: MINE, csv: line.line, condition: "" };
      const editor = csvEditor({
        def: fake, csv: line.line, telegrams, decoder: app.decoder, own: app.settings?.own_address || "31",
        onDirty: (dirty) => { dirty ? this.dirty.add(key) : this.dirty.delete(key); },
        onSave: async (csv) => { try { await upsertMine(csv, line.key); this.editors.delete(key); this.dirty.delete(key); toast("saved and decoded over the recording"); } catch (err) { toast(err.message, "err"); } },
      });
      this.editors.set(key, editor.el);
    }
    return this.editors.get(key);
  }

  // -- an entity of Home Assistant: its state changes --------------------------------------------------------

  renderEvent(el) {
    const { row, run } = this.state;
    append(el, h("div", { class: "pad-head" },
      h("span", { class: "mono key" }, row.label), row.name ? h("span", { class: "name" }, row.name) : null,
      run ? h("span", { class: "muted" }, run.n === 1 ? fmt.dateTime(run.t0, true) : `${fmt.count(run.n)}× ${fmt.dateTime(run.t0)} – ${fmt.time(run.t1)}`) : h("span", { class: "muted" }, "visible window"),
      h("span", { style: "margin-left:auto" }), h("button", { class: "small", onclick: () => this.close() }, "✕")),
      h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", {}, "time"), h("th", {}, "state"), h("th", {}, "previous"), h("th", {}, "source"), h("th", {}, "attributes"))),
        h("tbody", {}, row.runs.filter((r) => !run || r === run).map((r) => h("tr", {},
          h("td", { class: "mono" }, fmt.dateTime(r.t0, true)), h("td", {}, r.event.state ?? ""), h("td", {}, r.event.previous ?? ""), h("td", {}, r.event.source),
          h("td", { class: "mono", style: "white-space:normal" }, JSON.stringify(r.event.attributes || {}).slice(0, 300)))))));
  }

  // -- the selected message --------------------------------------------------------------------------------------

  renderRow(el) {
    const st = this.state;
    const m = this.model;
    const { row } = st;
    const run = st.run;
    const timeline = this.view.kind === "timeline";
    const current = idLength(row.row.zz, row.row.pb, row.row.sb, app.settings);
    const idSelect = timeline ? h("select", { title: "how many data bytes after the command identify a message (the rest is the value); changes the grouping of the bus rows of this command", onchange: () => this.view.setIdLength(row, Number(idSelect.value)) },
      [0, 1, 2, 3, 4, 5, 6].map((n) => h("option", { value: n, selected: n === current }, `${n}`))) : null;
    const senders = row.senders ? [...row.senders.keys()].join(", ") : null;
    append(el,
      h("div", { class: "pad-head" },
        h("span", { class: "mono key" }, row.label),
        row.name ? h("span", { class: "name" }, row.name) : null,
        run ? h("span", { class: "dtl-run", title: run.line || "" }, h("b", {}, this.view.runLabel(row, run).slice(0, 140)), h("span", { class: "muted" }, ` ${run.n === 1 ? fmt.dateTime(run.t0, true) : `${fmt.count(run.n)}× ${fmt.dateTime(run.t0)} – ${fmt.time(run.t1)}`}`)) : h("span", { class: "muted" }, `${fmt.count(m.telegrams.length)} recorded variants · ${fmt.count(m.total)} telegrams${senders ? ` · asked by ${senders}` : ""}`),
        h("span", { style: "margin-left:auto" }),
        h("label", { class: "muted", title: "hide candidates that fail to decode some recorded telegram" }, h("input", { type: "checkbox", checked: !!app.settings?.ui?.hideFailing, onchange: (e) => setup.setUi("hideFailing", e.target.checked) }), " hide failing"),
        setup.chosenFor(row.key) ? h("button", { class: "small", title: "forget the choice for this row and use ebusd's choice again", onclick: () => setup.choose(row.key, null) }, "back to ebusd's choice") : null,
        timeline ? h("label", { class: "muted" }, `ID bytes of ${fmt.hex(row.row.pb)}${fmt.hex(row.row.sb)} `, idSelect) : null,
        timeline ? h("button", { class: "small", title: "split or combine this row's messages like the definitions identify them", onclick: () => this.view.splitLikeDefinitions(m.telegrams) }, "rows like the definitions") : null,
        h("button", { class: "small", onclick: () => this.close() }, "✕")),
      this.notes(),
      h("div", { class: "cards" },
        m.shown.map((g) => this.card(g)),
        m.hidden.length ? this.failingCard() : null,
        this.newCard()),
      prSearch.section(row, m.telegrams, () => { if (this.state?.row.key === row.key && !this.dirty.size) this.render(true); }));
  }

  notes() {
    const { row } = this.state;
    const rowId = (row.row.id || "").length / 2;
    const longer = Math.max(0, ...this.model.candidates.map((c) => c.def.idlen || 0));
    const out = [];
    if (this.view.kind === "timeline" && longer > rowId) out.push(h("div", { class: "note-box" }, h("b", {}, "Why so many definitions? "), `This row groups telegrams by only ${rowId} ID byte${rowId === 1 ? "" : "s"}, but the definitions identify their messages by up to ${longer}: these can be different messages (registers) sharing the row. `,
      h("button", { class: "small primary", onclick: () => this.view.splitLikeDefinitions(this.model.telegrams) }, "Split this row like the definitions")));
    if (!row.defKey && this.model.candidates.length) out.push(h("div", { class: "note-box" }, "ebusd itself has no definition for this row: none of these would be used as they are. Pick one anyway (it joins your setup), or copy one into the scratchpad and adapt it."));
    if (!this.model.candidates.length) out.push(h("div", { class: "note-box" }, "No definition of any source decodes this message. Read its fields off the bytes below and name them; ebusd's decoder checks your definition against every recorded telegram while you work."));
    return out.length ? h("div", {}, out) : null;
  }

  /** How a card's definition relates to the row's own: the same values or not, and what differs as a definition. */
  relation(g) {
    const cur = this.model.current;
    if (!cur || g === cur) return null;
    const a = this.preferred(g).def, b = this.preferred(cur).def;
    const sameValues = g.coverage.signature === cur.coverage.signature;
    return { sameValues, structure: describeDifference(a, b), fields: sameValues ? [] : differingFields(g.coverage, cur.coverage) };
  }

  relationHint(g) {
    const rel = this.relation(g);
    if (!rel) return g === this.model.current ? "the row's definition" : "";
    const list = (names) => `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`;
    if (rel.sameValues) return rel.structure.length ? "same values, defined differently" : "same values";
    const fails = g.coverage.errors ? ` · fails on ${g.coverage.errors}` : "";
    return `${rel.fields.length ? `differs in ${list(rel.fields)}` : "different values"}${fails}`;
  }

  // -- a card: one definition (or a group of identical ones) --------------------------------------------------

  card(g) {
    const st = this.state;
    const { row } = st;
    const pref = this.preferred(g);
    const def = pref.def;
    const open = this.isExpanded(g);
    const rel = this.relation(g);
    const hint = this.relationHint(g);
    const entries = app.decoder.entries;
    const otherKeys = this.model.candidates.map((c) => c.def.key);
    const sources = [...new Map(g.members.map((m) => [m.def.source, m.def])).values()];
    const cov = g.coverage;
    const head = h("div", { class: "card-head", title: `${def.circuit} ${def.name} · ${accessKind(def)} · ${STATUS_HELP[def.status] || def.status}`,
      onmouseenter: () => this.view.setPreview(row, def.key), onmouseleave: () => this.view.setPreview(row, null),
      onclick: (e) => { if (e.target.closest("button, input, a, select")) return; this.toggleGroup(g); } },
      h("span", { class: "fold" }, open ? "▾" : "▸"),
      h("button", { class: `pick ${g.hasChosen ? "on" : ""}`, title: g.hasChosen ? "used for this row and part of your setup" : "use this definition for this row (it joins your setup, the row's other definitions leave it)", onclick: () => setup.choose(row.key, def.key, otherKeys, entries) }, g.hasChosen ? "●" : "○"),
      chip(def.circuit, def.name),
      setup.exportName(def) !== def.name ? h("span", { class: "export", title: "its name in your config" }, `→ ${setup.exportName(def)}`) : null,
      h("span", { class: "tmeta" }, accessKind(def)),
      sources.map((d) => sourceBadge(d)),
      g.members.length > sources.length ? h("span", { class: "tmeta", title: `the same definition in ${g.members.length} files` }, `×${g.members.length}`) : null,
      g.hasUsed ? h("span", { class: "tbadge active", title: "what ebusd uses with its own definitions" }, "ebusd's choice") : null,
      cov.errors ? h("span", { class: "warn", title: `fails to decode ${cov.errors} of ${cov.distinct} recorded variants` }, `⚠ ${fmt.count(cov.ok)} of ${fmt.count(cov.distinct)} decode`) : h("span", { class: "ok", title: `decodes every recorded variant of this row (${fmt.count(cov.occurrences)} telegrams)` }, `✓ all ${fmt.count(cov.ok)} decode`),
      hint ? h("span", { class: `t2 ${rel ? (rel.sameValues ? "same" : "differs") : ""}` }, hint) : null,
      cov.latest ? h("span", { class: "mono muted ex", title: cov.latest.text }, cov.latest.text.slice(0, 90)) : null,
      h("span", { style: "margin-left:auto" }),
      h("button", { class: "small", title: "copy this definition into your scratchpad to change it", onclick: () => this.copyToMine(def) }, "copy"));
    const body = open ? this.body(g, pref) : null;
    return h("div", { class: `card ${open ? "open" : ""} ${g.hasChosen ? "chosen" : ""}` }, head, body);
  }

  body(g, pref) {
    return h("div", { class: "card-body dtl-body" },
      h("div", { class: "dcol" }, this.sourceSection(g, pref)),
      h("div", { class: "dcol" }, this.compareSection(g, pref)),
      h("div", { class: "dcol" }, this.historySection(pref.def)),
      h("div", { class: "dcol edit" }, this.editSection(g, pref)));
  }

  async copyToMine(def) {
    try {
      const key = await upsertMine(def.csv);
      toast(`${def.circuit} ${def.name} copied to your scratchpad: edit the copy (kind mine)`);
      this.expanded.add(key);
      this.refresh();
    } catch (err) { toast(err.message, "err"); }
  }

  // -- source: where it comes from, why ebusd (does not) use it, its names in Home Assistant ------------------

  sourceSection(g, pref) {
    const { row } = this.state;
    const def = pref.def;
    const entries = app.decoder.entries;
    const included = new Set(setup.includedKeys(entries));
    const otherKeys = this.model.candidates.map((c) => c.def.key);
    const cond = describeConditions(def);
    const scan = app.decoder.scan?.[def.source] || {};
    const usedDef = this.model.candidates.find((c) => c.def.key === this.model.usedKey)?.def || null;
    const sec = h("section", { class: "dsec" }, h("h4", {}, "Source and use"));
    append(sec,
      h("div", { class: "row" },
        h("button", { class: `pick ${g.hasChosen ? "on" : ""}`, title: g.hasChosen ? "used for this row and part of your setup" : "use this definition for this row (it joins your setup, the row's other definitions leave it)", onclick: () => setup.choose(row.key, def.key, otherKeys, entries) }, g.hasChosen ? "● used for this row" : "○ use for this row"),
        h("label", { class: "muted", title: "part of the setup of this installation" }, h("input", { type: "checkbox", checked: included.has(def.key), onchange: (e) => setup.include(def.key, e.target.checked, entries) }), " in my setup"),
        def.source === MINE ? h("button", { class: "small", title: "remove this line from your definitions", onclick: async () => { if (confirm(`Remove ${def.circuit} ${def.name} from your definitions?`)) await removeMine(def.key); } }, "remove from mine") : null),
      h("dl", { class: "kv" },
        h("dt", {}, "kind"), h("dd", {}, h("span", { class: `badge kind ${def.write ? "write" : ""}` }, accessKind(def)), ` ${KIND_HELP[accessKind(def)]}`),
        h("dt", {}, "comes from"), h("dd", {}, g.members.map((x) => h("div", { class: "frow" },
          h("button", { class: `pick ${x.def.key === row.defKey ? "on" : ""}`, title: "use exactly this one", onclick: () => setup.choose(row.key, x.def.key, otherKeys, entries) }, x.def.key === row.defKey ? "●" : "○"),
          sourceBadge(x.def), h("span", { class: "mono", title: x.def.file }, base(x.def.file)), h("span", { class: `badge ${x.def.status}`, title: STATUS_HELP[x.def.status] }, x.def.status),
          g.members.length > 1 ? h("label", { class: "muted" }, h("input", { type: "checkbox", checked: included.has(x.def.key), onchange: (e) => setup.include(x.def.key, e.target.checked, entries) }), " in setup") : null))),
        h("dt", {}, "applies"), h("dd", {}, cond ? `only when ${cond}` : "always (for the right device)"),
        h("dt", {}, "ebusd"), h("dd", {},
          def.source === app.decoder.primary ? (pref.def.key === this.model.usedKey ? "uses this definition today." : whyNot(def, scan, null, usedDef))
            : [h("div", {}, usedDef ? `Today ebusd uses ${usedDef.circuit} ${usedDef.name} for this message.` : "Today ebusd understands this message with none of its own definitions."),
              h("div", {}, `With ${def.sourceLabel || def.source}: ${def.source === MINE ? "never ebusd's choice: pick it here." : whyNot(def, scan, null, usedDef).replace(/^ebusd uses this definition\.$/, "ebusd would use this definition.")}`)])),
      this.namesForm(def, g.coverage.latest?.fields || null));
    return sec;
  }

  /** The names a message and its fields get in your config: MQTT topics, JSON fields, Home Assistant entities. */
  namesForm(def, values) {
    const nameInput = h("input", { type: "text", value: setup.exportName(def), size: 24, onchange: () => setup.rename(def, nameInput.value) });
    const map = setup.fieldMap(def);
    const circuit = setup.circuitOf(def);
    const rows = (def.fields || []).map((field) => {
      const input = h("input", { type: "text", value: map[field], title: `entity: ${circuit} ${setup.exportName(def)} ${map[field]}`, onchange: () => setup.renameField(def, field, input.value) });
      return h("tr", {}, h("td", { class: "mono muted", title: field }, field), h("td", {}, input), h("td", { class: "mono muted latest" }, values && field in values ? String(values[field]) : ""));
    });
    return h("div", { class: "names" },
      h("div", { class: "kv-row" }, h("b", {}, "In Home Assistant"), h("span", { class: "muted" }, "topic "), h("span", { class: "mono" }, `ebusd/${circuit}/`), nameInput, setup.exportName(def) !== def.name ? h("span", { class: "muted" }, `(upstream ${def.name})`) : null),
      rows.length ? h("table", { class: "fieldnames" }, h("colgroup", {}, h("col", { style: "width:34%" }), h("col", { style: "width:36%" }), h("col", { style: "width:30%" })), h("thead", {}, h("tr", {}, h("th", {}, "field"), h("th", {}, "name in my config"), h("th", {}, values ? "latest" : ""))), h("tbody", {}, rows)) : h("div", { class: "muted" }, "This message has no named fields."),
      h("div", { class: "hint" }, `Entities are named "${circuit} ${setup.exportName(def)} <field>" by ebusd's MQTT discovery; the names end up in the exported CSV, the MQTT topics and the JSON fields, the upstream names stay in the file's comments. Letters, digits, _ . - only.`));
  }

  // -- comparison -------------------------------------------------------------------------------------------------

  compareSection(g, pref) {
    const m = this.model;
    const st = this.state;
    const sec = h("section", { class: "dsec" }, h("h4", {}, "Compared with another definition"));
    const others = m.shown.filter((x) => x !== g);
    if (!others.length) return append(sec, h("div", { class: "muted" }, "No other definition decodes this row: nothing to compare with."), this.sameFiles(g));
    const other = others.find((x) => x.key === st.compareWith) || (m.current && m.current !== g ? m.current : others[0]);
    const label = (x) => { const p = this.preferred(x).def; return `${x === m.current ? "● " : ""}${p.circuit} ${p.name} · ${accessKind(p)} · ${p.sourceLabel || p.source}${x.members.length > 1 ? ` ×${x.members.length}` : ""}`; };
    const pick = h("select", { onchange: () => { st.compareWith = pick.value; this.render(true); } }, others.map((x) => h("option", { value: x.key, selected: x === other }, label(x))));
    const a = pref.def, b = this.preferred(other).def;
    const sameValues = g.coverage.signature === other.coverage.signature;
    const diff = describeDifference(a, b);
    const sx = structureOf(a.csv), sy = structureOf(b.csv);
    const fmtField = (f) => f ? `${f.name || "?"} · ${f.part === "m" ? "request" : "answer"} ${f.type}${f.divisor ? ` ${f.divisor}` : ""}${f.unit ? ` ${f.unit}` : ""}` : "—";
    const sameField = (f, g2) => f && g2 && f.part === g2.part && f.type === g2.type && f.divisor === g2.divisor && f.unit === g2.unit;
    const rows = [];
    const row = (what, x, y, differs, mono = false) => rows.push(h("tr", { class: differs ? "diff" : "" }, h("td", {}, what), h("td", { class: mono ? "mono" : "" }, x), h("td", { class: mono ? "mono" : "" }, y)));
    row("source", a.sourceLabel || a.source, b.sourceLabel || b.source, a.source !== b.source);
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
    if (st.run && !st.run.mixed) {
      const line = st.run.line;
      const clicked = (x) => { const d = line ? app.decoder.decodesOf(line)?.get(this.preferred(x).def.key) : null; return d ? (d.result === "ok" ? d.text || "(empty)" : `✗ ${d.result}`) : "—"; };
      rows.unshift(h("tr", {}, h("td", {}, "the value you clicked"), h("td", { class: "mono" }, clicked(g)), h("td", { class: "mono" }, clicked(other))));
    }
    const cov = (x) => x.coverage.errors ? `${fmt.count(x.coverage.ok)} of ${fmt.count(x.coverage.distinct)} variants decode` : `all ${fmt.count(x.coverage.ok)} variants decode`;
    rows.push(h("tr", { class: g.coverage.errors !== other.coverage.errors ? "diff" : "" }, h("td", {}, "decodes"), h("td", {}, cov(g)), h("td", {}, cov(other))));
    rows.push(h("tr", {}, h("td", {}, "in files"), h("td", { class: "mono" }, g.members.map((x) => base(x.def.file)).join(", ")), h("td", { class: "mono" }, other.members.map((x) => base(x.def.file)).join(", "))));
    append(sec,
      h("div", { class: "row" }, h("label", { class: "muted" }, "this card against"), pick),
      h("div", { class: sameValues ? "ok verdict" : "warn verdict" }, sameValues
        ? (diff.length ? "Decodes the same values over the whole history, but is defined differently." : "Identical: the same definition, decoding the same values.")
        : `Decodes different values${diffNames.size ? ` (${[...diffNames].join(", ")})` : ""}${diff.length ? " and is defined differently" : ""}.`),
      h("table", { class: "cmp" }, h("thead", {}, h("tr", {}, h("th", {}), h("th", {}, `${a.circuit} ${a.name} (this card)`), h("th", {}, `${b.circuit} ${b.name}`))), h("tbody", {}, rows)),
      h("div", { class: "muted" }, "Highlighted rows differ; rows in italics only differ in a name. Same values with different names: pick the naming you prefer, or rename above."),
      this.sameFiles(g));
    return sec;
  }

  /** Where else the very same definition (structure and values) is: copies in other files, circuits and sources. */
  sameFiles(g) {
    if (g.members.length < 2) return null;
    return h("div", { class: "muted" }, `Identical copies of this definition: ${g.members.map((x) => `${x.def.circuit} ${x.def.name} in ${base(x.def.file)} (${x.def.sourceLabel || x.def.source})`).join("; ")}.`);
  }

  // -- history ------------------------------------------------------------------------------------------------------

  historySection(def) {
    const sec = h("section", { class: "dsec" }, h("h4", {}, "History over the recording"));
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
    const preview = this.previews.get(def.key);
    const decodeFor = (line) => (preview ? preview.results.get(line) : app.decoder.decodesOf(line)?.get(def.key));
    const shim = { decodesOf: (line) => { const d = decodeFor(line); return d ? new Map([["k", d]]) : undefined; } };
    const fields = seriesFields(data, shim, "k");
    let field = this.state.field[def.key] || this.state.wantedField;
    if (!field || !fields.includes(field)) field = fields.find((f) => seriesValues(data, shim, "k", f).numeric) || fields[0];
    const series = seriesValues(data, shim, "k", field);
    const db = app.status.db;
    const t0 = db.first_ms, t1 = db.last_ms + 1000;
    const select = fields.length > 1 ? h("select", { onchange: () => { this.state.field[def.key] = select.value; this.fillHistory(def, body); } }, fields.map((f) => h("option", { value: f, selected: f === field }, f))) : null;
    const canvas = h("canvas");
    const info = h("div", { class: "hint" });
    let geometry = null;
    const paint = (hover = null) => { geometry = drawChart(canvas, series, { t0, t1, width: Math.max(300, (body.clientWidth || 420) - 4), height: 130, band: this.view.window?.() || null, hoverMs: hover }); };
    const summary = () => {
      const values = series.points.map((p) => p.value);
      const range = series.numeric && values.length ? ` · ${Math.min(...values)} … ${Math.max(...values)}` : "";
      info.textContent = `${fmt.count(series.points.length)} telegrams${data.stride > 1 ? ` (every ${data.stride}th of ${fmt.count(data.total)})` : ""}${range}${preview ? " · this is your draft, not the saved definition" : ""} · click to go there`;
    };
    canvas.addEventListener("mousemove", (e) => { const ms = geometry.tOf(e.offsetX), p = nearestPoint(series, ms); paint(ms); info.textContent = p ? `${fmt.dateTime(p.ms)}  ${field ? `${field} = ` : ""}${p.value}` : ""; });
    canvas.addEventListener("mouseleave", () => { paint(); summary(); });
    canvas.addEventListener("click", (e) => { const ms = geometry.tOf(e.offsetX); this.state.focusMs = ms; this.state.offset = 0; bus.emit("goto-time", ms); this.fillHistory(def, body); });
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
        h("label", { class: "muted", title: "list every telegram instead of runs of the same value" }, h("input", { type: "checkbox", checked: this.state.every, onchange: (e) => { this.state.every = e.target.checked; this.state.offset = 0; this.fillHistory(def, body); } }), " every telegram")),
      series.points.length ? canvas : h("div", { class: "muted" }, "this definition decodes none of the row's telegrams"), info,
      h("div", { class: "row" }, h("b", {}, "Values"), h("span", { class: "muted" }, `${fmt.count(entries.length)} ${this.state.every ? "telegrams" : "changes"}, newest first`), h("span", { style: "margin-left:auto" }),
        h("button", { class: "small", disabled: start === 0, onclick: () => { this.state.offset--; this.fillHistory(def, body); } }, "▲ newer"),
        h("button", { class: "small", disabled: start + PAGE >= entries.length, onclick: () => { this.state.offset++; this.fillHistory(def, body); } }, "▼ older")),
      list);
    paint(); summary();
    const hl = list.querySelector("tr.hl");
    if (hl) list.scrollTop = Math.max(0, hl.offsetTop - list.clientHeight / 3);
  }

  // -- editing --------------------------------------------------------------------------------------------------------

  editSection(g, pref) {
    const { row } = this.state;
    const def = pref.def;
    const key = `edit|${row.key}|${def.key}`;
    const mine = def.source === MINE;
    const sec = h("section", { class: "dsec" }, h("h4", {}, mine ? "Edit my definition" : "Tune it: a copy of your own"));
    if (!this.editors.has(key)) {
      const editor = csvEditor({
        def, telegrams: this.model.telegrams, decoder: app.decoder, own: app.settings?.own_address || "31",
        onDirty: (dirty) => { dirty ? this.dirty.add(key) : this.dirty.delete(key); },
        onPreview: (preview) => { if (preview) this.previews.set(def.key, preview); else this.previews.delete(def.key); const body = this.histories.get(def.key); if (body) this.fillHistory(def, body); },
        onSave: (csv) => this.saveVersion(csv, def, key),
      });
      this.editors.set(key, editor.el);
    }
    append(sec, this.editors.get(key));
    return sec;
  }

  newCard() {
    const { row } = this.state;
    const open = !!this.state.newOpen;
    const key = `new|${row.key}`;
    const head = h("div", { class: "card-head new", onclick: (e) => { if (e.target.closest("button, input, a, select")) return; this.state.newOpen = !open; this.render(true); } },
      h("span", { class: "fold" }, open ? "▾" : "▸"), h("span", { class: "accent" }, "＋ write a definition from the bytes"), h("span", { class: "muted" }, "prefilled from the recording: kind, device, command, ID, the data bytes and what each could mean"));
    let body = null;
    if (open) {
      if (!this.editors.has(key)) {
        this.editors.set(key, defineEditor({
          row, telegrams: this.model.telegrams, scan: app.decoder.devices(), own: app.settings?.own_address || "31", decoder: app.decoder,
          onClose: () => { this.state.newOpen = false; this.render(true); },
          onSave: (csv, header) => this.saveVersion(csv, null, key, header),
        }));
      }
      body = h("div", { class: "card-body single" }, this.editors.get(key));
    }
    return h("div", { class: `card ${open ? "open" : ""}` }, head, body);
  }

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
      h("button", { class: "pick", title: "use this definition anyway", onclick: () => setup.choose(row.key, m.def.key, otherKeys, entries) }, "○"),
      chip(m.def.circuit, m.def.name), h("span", { class: "badge kind" }, accessKind(m.def)), sourceBadge(m.def), h("span", { class: "mono muted" }, base(m.def.file)), h("span", { class: `badge ${m.def.status}` }, m.def.status),
      h("span", { class: g.failed ? "err" : "warn" }, g.failed ? "decodes none of this row's telegrams" : `fails on ${m.coverage.errors} of ${m.coverage.distinct} recorded variants (${[...m.coverage.errorKinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")})`),
      h("button", { class: "small", title: "copy into your scratchpad to fix it", onclick: () => this.copyToMine(m.def) }, "copy"),
      h("div", { class: "muted", style: "flex-basis:100%;margin-left:24px" }, whyNot(m.def, app.decoder.scan?.[m.def.source] || {}, g.failed ? m.coverage.errorKinds : null, usedDef))))) : null;
    return h("div", { class: `card ${open ? "open" : ""}` }, head, body);
  }

  /** A line of your own from the editor (a copy of a definition, or a new one): the sources are never modified. */
  async saveVersion(csv, def, editKey, header = null) {
    const { row } = this.state;
    try {
      const key = await upsertMine(csv, def?.source === MINE ? def.key : null);
      const decoder = app.decoder;
      this.editors.delete(editKey);
      if (def) this.previews.delete(def.key);
      this.dirty.clear();
      if (!decoder.def(key)) { toast("saved to your definitions; it decodes none of this row's telegrams yet (check the line, or wait for the decoding)", "info", 7000); this.state.newOpen = false; this.refresh(); return; }
      setup.choose(row.key, key, this.model.candidates.map((c) => c.def.key), decoder.entries);
      toast(`${header ? `${header.circuit} ${header.name}` : "your version"} saved and chosen for this row`);
      this.expanded.add(key);
      this.state.newOpen = false;
      this.refreshModel();
      this.render(true);
    } catch (err) { toast(err.message, "err"); }
  }
}
