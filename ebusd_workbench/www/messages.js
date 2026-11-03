// The bus as a list of messages, the way a definition sees them: one row per destination,
// command and message ID (whoever asked), built from the browser store. Leads with what needs a
// look: messages ebusd does not understand today, and messages only another source (the upcoming
// release, a pull request, your own lines) could understand. The devices on the bus head the list,
// each with what ebusd loads for it and how much of its traffic is understood. A click on a row
// opens the inspector of the message under its row. What the list shows is not decoded yet is
// checked in the background, in the list's order.
import { app, append, bus, fmt, h } from "./app.js";
import { seriesQuery } from "./chart.js";
import { messageColors } from "./colors.js";
import { accessKind } from "./compare.js";
import { MINE, setup } from "./setup.js";
import { addressName } from "./ebus-spec.js";
import { describeEvent, mergeTimeline } from "./events.js";

const FILTERS = [
  ["attention", "needs a look", "messages ebusd does not understand today: unknown ones (most traffic first) and ones another source could understand"],
  ["unknown", "unknown everywhere", "messages no source decodes: start a definition of your own from their bytes in the inspector"],
  ["new", "other sources know them", "messages ebusd does not understand, but the upcoming release, a pull request or a definition of your own does"],
  ["all", "all messages", "every message on the bus, by device"],
  ["setup", "in my setup", "messages whose definition is in your setup"],
];
const SORTS = [["auto", "what matters", "the most traffic first on the attention filters, by device otherwise"], ["last", "last received", "the newest telegram first"]];
const GROUP_MIN = 8;
const BADGES_SHOWN = 3;   // sources shown per row in "understood by" before the rest fold into a count
const hexByte = (n) => (n === null || n === undefined ? "--" : n.toString(16).padStart(2, "0"));
const chip = (circuit, name) => { const c = messageColors(circuit, name); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit} ${name}`); };
const remembered = (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === "1"; } catch { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* ignore */ } };
const srcBadge = (source, label, maybe = false) => h("span", { class: `tbadge ${source === MINE ? "custom" : source === "release" ? "" : "src"} ${maybe ? "maybe" : ""}`, title: maybe ? `${label || source}: a definition fits, not checked with ebusd's library yet` : `${label || source} understands this message` }, source === MINE ? "mine" : label || source);

export class MessagesView {
  constructor(root) {
    this.root = root;
    this.kind = "table";
    this.filter = "attention";
    this.sort = "auto";
    this.query = "";
    this.device = null;          // zz to show, or null for all
    this.devicesOpen = remembered("workbench.devicesOpen", true);   // the devices with their numbers, or one line
    this.openGroups = new Set(); // zz+pbsb of the commands unfolded in the list
    this.openBadges = new Set(); // keys of the rows whose "understood by" shows every source
    this.selected = null;
    this.allRows = [];
    this.devices = [];
    this.seriesCache = new Map();
    this.seriesLoading = new Map();
    this.timer = null;
    this.build();
    bus.on("decodes-changed", (reason) => { if (reason !== "progress") this.schedule(); });
    bus.on("setup-changed", () => this.schedule());
    bus.on("settings-changed", () => this.schedule());
    bus.on("events-changed", () => this.schedule());
    bus.on("status", () => { this.renderLoad(); if (!this.allRows.length) this.schedule(); });
    this.schedule();
  }

  /** The time window of the view: none, the table is the whole recording (the chart shows no band). */
  window() { return null; }

  visible() { return this.root.clientWidth > 0; }

  /** Build and draw again, at most every 400 ms however often the core reports new decodings. */
  schedule() { if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.buildRows(); this.render(); }, 400); }

  build() {
    const el = (this.el = {});
    el.filters = h("span", { class: "seg group" }, FILTERS.map(([id, label, title]) => h("button", { class: id === this.filter ? "active" : "", title, "data-filter": id, onclick: () => { this.filter = id; this.device = null; this.render(true); } }, label)));
    el.sorts = h("span", { class: "seg group", title: "the order of the list" }, SORTS.map(([id, label, title]) => h("button", { class: id === this.sort ? "active" : "", title, "data-sort": id, onclick: () => { this.sort = id; this.render(true); } }, label)));
    el.search = h("input", { type: "search", placeholder: "filter: name, circuit, address, command…", size: 28, oninput: () => { this.query = el.search.value.trim().toLowerCase(); this.render(true); } });
    el.info = h("span", { class: "hint" });
    el.load = h("span", { class: "group load" });
    el.toolbar = h("div", { class: "toolbar msg-toolbar" }, el.filters, el.sorts, h("span", { class: "group" }, el.search), h("span", { class: "group", style: "margin-left:auto" }, el.info), el.load);
    el.devices = h("div", { class: "devices" });
    el.events = h("div", { class: "events-strip" });
    el.list = h("div", { class: "msg-list" });
    append(this.root, el.toolbar, el.devices, el.events, el.list);
    this.renderLoad();
  }

  /** The button that reads newer telegrams from the recording (the list never changes by itself). */
  renderLoad() {
    const el = this.el.load;
    const d = app.decoder;
    const db = app.status?.db;
    const st = d?.status();
    el.replaceChildren();
    if (!db?.has_telegram_table) return;
    if (st?.syncing) { append(el, h("span", { class: "hint" }, h("span", { class: "spinner" }), ` ${st.progress || "reading the recording…"}`)); return; }
    const lastSync = d?.meta?.lastSync;
    const known = lastSync ? db.telegrams_since : db.telegrams;   // the device counts what was recorded since the browser last read
    const maybe = lastSync && known === undefined && (db.last_ms || 0) > lastSync + 60e3;   // not counted yet (the next status will)
    const newer = known ?? 0;
    append(el, h("button", { class: `small ${newer || maybe ? "primary" : ""}`, disabled: !newer && !maybe, title: newer ? `${fmt.count(newer)} telegrams were recorded since this browser last read the recording` : maybe ? "newer telegrams were recorded" : "this browser has every recorded telegram", onclick: () => d?.sync() },
      newer ? `↻ load ${fmt.count(newer)} newer telegram${newer === 1 ? "" : "s"}` : maybe ? "↻ load newer telegrams" : "↻ up to date"));
  }

  // -- the rows: one per message as the definitions identify it -------------------------------------------

  buildRows() {
    const d = app.decoder;
    if (!d) { this.allRows = []; this.devices = []; return; }
    const primary = d.primary;
    const rows = new Map();
    const senders = new Map();   // qq -> telegrams sent (to tell the masters on the bus)
    for (const t of d.telegrams.values()) {
      if (!t.master) continue;
      const key = d.rowKeyOf(t);
      const zz = t.master.slice(2, 4), pbsb = t.master.slice(4, 8), id = key.slice(7);
      let row = rows.get(key);
      if (!row) {
        rows.set(key, (row = { kind: "telegram", key, zz, pbsb, id, label: `${zz} ${pbsb}${id ? " " + id : ""}`, n: 0, distinct: 0, senders: new Map(), first: null, latest: null, candidates: new Map(), knownBy: new Set(), maybeBy: new Set(), lines: [],
          row: { qq: null, zz: parseInt(zz, 16), pb: parseInt(pbsb.slice(0, 2), 16), sb: parseInt(pbsb.slice(2), 16), id, anyQq: true }, anyQq: true, runs: [] }));
      }
      const qq = t.master.slice(0, 2);
      row.n += t.n || 0;
      row.distinct++;
      row.senders.set(qq, (row.senders.get(qq) || 0) + (t.n || 0));
      senders.set(qq, (senders.get(qq) || 0) + (t.n || 0));
      if (t.first_ms !== null && t.first_ms !== undefined) row.first = row.first === null ? t.first_ms : Math.min(row.first, t.first_ms);
      if (t.last_ms && (!row.latest || t.last_ms > row.latest.last_ms)) row.latest = t;
      row.lines.push(t.line);
      if (t.primary?.hash) row.knownBy.add(primary);
      const results = d.results.get(t.line);
      for (const hash of d.matchesOf(t)) {
        let c = row.candidates.get(hash);
        if (!c) { const def = d.def(hash); if (!def) continue; row.candidates.set(hash, (c = { def, ok: 0, errors: 0, pending: 0, used: 0, usedIn: def.available ? def.loadedIn.length : 0, last: null })); }
        const r = results?.get(hash);
        if (!r) c.pending++; else { if (r.result === "ok") c.ok++; else c.errors++; c.last = { ...r, defKey: hash, used: t.primary?.hash === hash }; }
        if (t.primary?.hash === hash) c.used++;
        // other sources that would use this line for the message (a file ebusd loads for the device, condition met)
        if (c.def.available) for (const s of c.def.loadedIn) { if (s === primary) continue; if (r ? r.result === "ok" : true) (r ? row.knownBy : row.maybeBy).add(s); }
      }
    }
    const included = new Set(setup.includedKeys(d.entries));
    const order = Object.fromEntries(d.sources().map((s, i) => [s.id, i]));
    const own = app.settings?.own_address || "31";
    for (const row of rows.values()) {
      row.qq = [...row.senders.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;   // the usual sender (for defining the message)
      row.row.qq = row.qq ? parseInt(row.qq, 16) : null;
      row.known = row.knownBy.has(primary);
      for (const s of row.knownBy) row.maybeBy.delete(s);
      row.newIn = [...row.knownBy].filter((s) => s !== primary).sort((a, b) => (order[a] ?? 99) - (order[b] ?? 99));
      row.maybeIn = [...row.maybeBy].sort((a, b) => (order[a] ?? 99) - (order[b] ?? 99));
      row.pending = [...row.candidates.values()].some((c) => c.pending > 0);
      row.defKey = this.rowDefinition(row, included, primary, order);
      row.def = row.defKey ? d.def(row.defKey) : null;
      row.name = row.def ? `${setup.circuitOf(row.def)} ${setup.exportName(row.def)}` : "";
      row.inSetup = [...row.candidates.keys()].some((k) => included.has(k));
      // 0 handled (ebusd understands it, or you put a definition into your setup), 1 something fits but ebusd would not use it,
      // 2 another source understands it (or could: not checked yet), 3 nothing fits
      row.attention = row.known || row.inSetup ? 0 : row.newIn.length || row.maybeIn.length ? 2 : row.candidates.size ? 1 : 3;
      // ebusd's own scan of the devices: the identification, and for Vaillant the serial number in four parts; nothing to define
      row.scan = row.pbsb === "0704" || (row.pbsb === "b509" && /^2[4-7]$/.test(row.id) && row.senders.has(own));
      if (row.scan) row.attention = 0;
    }
    this.allRows = [...rows.values()];
    this.senders = senders;
    this.devices = this.deviceList();
    // what the list shows is checked in the background, what needs a look first
    const todo = this.allRows.filter((r) => r.pending).sort((a, b) => (b.attention - a.attention) || b.n - a.n);
    d.enqueueRows(todo.map((r) => ({ key: r.key, lines: r.lines })));
  }

  /** The definition a row is shown with: the chosen one, else ebusd's choice, else one in the setup, else what another source would use. */
  rowDefinition(row, included, primary, order) {
    if (!row.candidates.size) return null;
    const chosen = setup.chosenFor(row.key);
    if (chosen && row.candidates.has(chosen)) return chosen;
    let best = null;
    for (const [key, c] of row.candidates) if (c.used && (!best || c.used > row.candidates.get(best).used)) best = key;
    if (best) return best;
    for (const key of row.candidates.keys()) if (included.has(key)) return key;
    const others = [...row.candidates.values()].filter((c) => c.usedIn > 0 && c.ok > 0).sort((a, b) => (order[a.def.source] ?? 99) - (order[b.def.source] ?? 99));
    return others[0]?.def.key || null;
  }

  /** The devices on the bus: every destination with its identification and how much of its traffic is understood. */
  deviceList() {
    const d = app.decoder;
    const primary = d.primary;
    const idents = d.devices();
    this.idents = idents;
    const byZz = new Map();
    for (const row of this.allRows) {
      let dev = byZz.get(row.zz);
      if (!dev) byZz.set(row.zz, (dev = { zz: row.zz, messages: 0, n: 0, known: 0, knownN: 0, newOnly: 0, newN: 0, unknown: 0, unknownN: 0, newIn: new Set() }));
      dev.messages++; dev.n += row.n;
      if (row.attention === 0) { dev.known++; dev.knownN += row.n; } else if (row.attention === 2) { dev.newOnly++; dev.newN += row.n; for (const s of [...row.newIn, ...row.maybeIn]) dev.newIn.add(s); } else { dev.unknown++; dev.unknownN += row.n; }
    }
    const list = [...byZz.values()].map((dev) => {
      const ident = idents[dev.zz] || null;
      return { ...dev, ident, file: ident?.files?.[primary] ?? null, broadcast: dev.zz === "fe" };
    }).sort((a, b) => (a.broadcast - b.broadcast) || b.n - a.n);
    const masters = [...(this.senders || new Map()).entries()].filter(([qq]) => !byZz.has(qq)).sort((a, b) => b[1] - a[1]).map(([qq, n]) => ({ qq, n, role: addressName(qq, { devices: idents, own: app.settings?.own_address || "31" }) }));
    return { list, masters };
  }

  // -- what the list shows ---------------------------------------------------------------------------------

  shownRows() {
    const q = this.query;
    let rows = this.allRows.filter((r) => !this.device || r.zz === this.device);
    if (this.filter === "attention") rows = rows.filter((r) => r.attention > 0);
    else if (this.filter === "unknown") rows = rows.filter((r) => r.attention === 3 || r.attention === 1);
    else if (this.filter === "new") rows = rows.filter((r) => r.attention === 2);
    else if (this.filter === "setup") rows = rows.filter((r) => r.inSetup);
    if (q) rows = rows.filter((r) => `${r.label} ${r.zz}${r.pbsb} ${r.name} ${r.def ? `${r.def.circuit} ${r.def.name}` : ""} ${[...r.candidates.values()].map((c) => `${c.def.circuit} ${c.def.name}`).join(" ")}`.toLowerCase().includes(q));
    if (this.sort === "last") rows.sort((a, b) => (b.latest?.last_ms || 0) - (a.latest?.last_ms || 0));
    else if (this.filter === "attention" || this.filter === "unknown" || this.filter === "new") rows.sort((a, b) => b.n - a.n);   // the most traffic first: what matters most
    else rows.sort((a, b) => a.zz.localeCompare(b.zz) || b.n - a.n);
    return rows;
  }

  /** Rows of one command with many messages (the registers of b524) fold into one line unless unfolded. */
  grouped(rows) {
    if (this.sort === "last") return rows;
    const byCommand = new Map();
    for (const r of rows) { const k = `${r.zz}${r.pbsb}`; byCommand.set(k, (byCommand.get(k) || 0) + 1); }
    const out = [];
    const done = new Set();
    for (const r of rows) {
      const k = `${r.zz}${r.pbsb}`;
      if (byCommand.get(k) >= GROUP_MIN && this.filter !== "attention") {
        if (!done.has(k)) {
          done.add(k);
          const members = rows.filter((x) => `${x.zz}${x.pbsb}` === k);
          out.push({ kind: "group", key: `group|${k}`, zz: r.zz, pbsb: r.pbsb, members, n: members.reduce((s, x) => s + x.n, 0), known: members.filter((x) => x.known).length, newOnly: members.filter((x) => x.attention === 2).length, unknown: members.filter((x) => x.attention === 3 || x.attention === 1).length });
          if (this.openGroups.has(k)) out.push(...members);
        }
      } else out.push(r);
    }
    return out;
  }

  /** @param force draw the list again even while a message is selected (your own filter, search or device click) */
  render(force = false) {
    const el = this.el;
    for (const b of el.filters.querySelectorAll("button")) b.classList.toggle("active", b.dataset.filter === this.filter);
    for (const b of el.sorts.querySelectorAll("button")) b.classList.toggle("active", b.dataset.sort === this.sort);
    this.renderDevices();
    this.renderEvents();
    this.renderLoad();
    if (this.selected && this.inspHost && !force) return;   // the list stays put while you inspect a message
    const rows = this.shownRows();
    if (this.selected && force && !rows.some((r) => r.key === this.selected.key)) { bus.emit("select-row", null); return; }
    const d = app.decoder;
    const total = this.allRows.length;
    el.info.textContent = total ? `${fmt.count(rows.length)} of ${fmt.count(total)} messages${this.device ? ` of ${this.device}` : ""}` : "";
    el.list.replaceChildren();
    if (!total) { append(el.list, this.emptyState()); return; }
    if (!rows.length) {
      const text = this.filter === "attention" ? "ebusd understands every message on your bus (with the sources you have). Look at “all messages” to rename or add things." : this.filter === "setup" ? "Nothing in your setup fits a message yet." : "Nothing matches.";
      append(el.list, h("div", { class: "empty" }, text));
      return;
    }
    const table = h("table", { class: "msgs" }, h("thead", {}, h("tr", {},
      h("th", { style: "width:18px" }), h("th", {}, "message"), h("th", {}, "understood by"), h("th", {}, "latest value"), h("th", { class: "num" }, "telegrams"), h("th", { class: "num", title: "distinct telegrams (values) seen" }, "values"), h("th", {}, "last seen"), h("th", { class: "num", title: "definitions that fit this message, from every source" }, "fits"), h("th", { title: "part of your setup" }, "setup"))),
      h("tbody", {}, this.sort === "last"
        ? mergeTimeline(rows, app.events?.events || []).map((it) => (it.kind === "event" ? this.eventRow(it) : this.row(it.row)))
        : this.grouped(rows).map((r) => (r.kind === "group" ? this.groupRow(r) : this.row(r)))));
    append(el.list, table);
    d?.markDrawn?.();
    this.placeInspector();
  }

  /** What the list says while there is nothing to list: what the browser holds, what is loading, what the recording has. */
  emptyState() {
    const st = app.decoder?.status();
    const db = app.status?.db;
    if (st?.loading) return h("div", { class: "empty" }, h("span", { class: "spinner" }), ` ${st.loading}`);
    if (st?.syncing) return h("div", { class: "empty" }, h("span", { class: "spinner" }), ` ${st.progress || "reading the recording…"}`);
    if (!db?.exists || !db.has_telegram_table) return h("div", { class: "empty" }, h("span", {}, "No telegrams recorded yet. Set ", h("code", {}, `sqlite_db: ${db?.path || "/share/ebusd/telegrams.db"}`), " in the eBUSd app configuration (SQLite telegram log) and restart it."));
    return h("div", { class: "empty" }, `Nothing in this browser yet; the recording has ${fmt.count(db.telegrams)} telegrams. `, h("button", { class: "small primary", onclick: () => app.decoder?.sync() }, "↻ read the recording"));
  }

  /** The inspector of the selected message sits in a row of its own right under the message. */
  mountInspector(key, host) { this.inspHost = host; this.inspKey = key; this.placeInspector(); }

  unmountInspector() { this.inspRow?.remove(); this.inspRow = null; this.inspHost = null; this.inspKey = null; this.render(true); }

  placeInspector() {
    if (!this.inspHost) return;
    const tr = [...this.el.list.querySelectorAll("tr.msg")].find((x) => x.dataset.key === this.inspKey);
    if (!tr) return;
    if (!this.inspRow) this.inspRow = h("tr", { class: "insp" }, h("td", { colspan: 9 }, this.inspHost));
    if (tr.nextSibling !== this.inspRow) tr.insertAdjacentElement("afterend", this.inspRow);
  }

  renderDevices() {
    const el = this.el.devices;
    el.replaceChildren();
    const { list, masters } = this.devices || { list: [], masters: [] };
    if (!list.length) return;
    const primaryLabel = app.decoder?.source(app.decoder.primary)?.label || "ebusd";
    const open = this.devicesOpen;
    el.classList.toggle("folded", !open);
    el.appendChild(h("button", { class: "fold small", title: open ? "fold the devices into one line" : "show every device with its numbers", onclick: () => { this.devicesOpen = !open; remember("workbench.devicesOpen", this.devicesOpen); this.render(true); } }, open ? "▾" : "▸"));
    for (const dev of list) {
      const id = dev.ident;
      const share = dev.n ? Math.round((dev.knownN / dev.n) * 100) : 0;
      const stats = `${dev.messages} messages · ${share} % of the traffic understood${dev.newOnly ? ` · ${dev.newOnly} only other sources understand` : ""}${dev.unknown ? ` · ${dev.unknown} unknown` : ""}`;
      const title = (dev.broadcast ? "broadcasts: telegrams to every device" : id ? `${id.manufacturer} ${id.ident} (SW ${id.sw}, HW ${id.hw})\n${dev.file ? `${primaryLabel} loads ${dev.file}` : `${primaryLabel} loads no file for this identification`}` : "no identification recorded (scan telegram 0704 missing: is --scanconfig on?)") + (open ? "" : `\n${stats}`);
      const name = dev.broadcast ? "broadcast" : id ? `${id.manufacturer} ${id.ident.replace(/0{1,2}$/, "")}${id.hw ? ` HW${id.hw}` : ""}` : "unidentified device";   // ebusd drops up to two trailing zeros of an identification (HMU00 -> HMU, 70000 -> 700)
      const nofile = !dev.broadcast && id && !dev.file;
      el.appendChild(h("button", { class: `device ${this.device === dev.zz ? "active" : ""} ${nofile ? "nofile" : ""}`, title, onclick: () => { this.device = this.device === dev.zz ? null : dev.zz; if (this.device && this.filter === "attention" && !this.allRows.some((r) => r.zz === dev.zz && r.attention)) this.filter = "all"; this.render(true); } },
        h("span", { class: "mono addr" }, dev.zz), h("b", {}, open ? name : name.replace(/^Vaillant /, "")),
        nofile ? h("span", { class: "err", title: `${primaryLabel} loads no file for ${id.ident} (${id.manufacturer}): ebusd decodes nothing of this device unless a source adds a file for it` }, "no file") : open && dev.file ? h("span", { class: "mono muted" }, dev.file.replace(/^.*\//, "")) : null,
        open ? h("span", { class: "muted", title: "understood by ebusd today or by what you put into your setup" }, `${dev.messages} messages · ${share} % of the traffic understood`) : null,
        open && dev.newOnly ? h("span", { class: "accent", title: `${dev.newOnly} messages only ${[...dev.newIn].map((s) => app.decoder.source(s)?.label || s).join(", ")} understand` }, `+${dev.newOnly} with other sources`) : null,
        open && dev.unknown ? h("span", { class: "warn" }, `${dev.unknown} unknown`) : !open && dev.unknown ? h("span", { class: "warn", title: `${dev.unknown} messages unknown` }, `${dev.unknown}`) : null));
    }
    if (masters.length && open) el.appendChild(h("span", { class: "masters muted", title: "addresses that only send: the controller, remote controls, ebusd itself" }, "asking: ", masters.map((m) => h("span", { class: "mono" }, `${m.qq} (${m.role})`)).flatMap((x, i) => (i ? [", ", x] : [x]))));
  }

  /** The events watched next to the telegrams, as one line: a chip per entity with what the recording holds. */
  renderEvents() {
    const el = this.el.events;
    el.replaceChildren();
    const ev = app.events;
    if (!ev) return;
    const openSettings = () => { const details = document.querySelector("#extras details"); if (details) { details.open = true; details.querySelector(".settings")?.scrollIntoView({ behavior: "smooth", block: "start" }); } };
    const chips = [];
    for (const c of ev.config) {
      const list = ev.intervals.get(c.entity) || [];
      const points = ev.events.filter((e) => e.kind === "point" && e.entity === c.entity).length;
      const text = c.mode === "interval" ? `${fmt.count(list.length)} on-stretch${list.length === 1 ? "" : "es"}${list.some((e) => e.end_ms === null) ? ", on now" : ""}` : `${fmt.count(points)} change${points === 1 ? "" : "s"}`;
      chips.push(h("span", { class: "evchip", title: `${c.entity}: ${c.mode === "interval" ? `on/off stretches (on = ${c.on || "on"})` : "value changes"} in the recording` }, h("span", { class: "evdot", style: `background:${ev.colorOf(c.entity)};margin-left:0` }), h("b", {}, c.label || c.entity), h("span", { class: "muted" }, text)));
    }
    const notes = ev.notes.length;
    if (notes) chips.push(h("span", { class: "evchip", title: "notes made with the log command of the eBUSd terminal" }, h("b", {}, "notes"), h("span", { class: "muted" }, fmt.count(notes))));
    if (!chips.length) return;   // nothing watched, nothing noted: no line
    append(el, h("span", { class: "muted", title: "the events next to the telegrams: by last received they interleave with the messages, a message's row says what was on when it was last seen, the chart draws the stretches" }, "events"), ...chips,
      h("button", { class: "small", title: "which entities are watched, and how: in the settings under Advanced", onclick: openSettings }, "⚙"));
  }

  /** A line of the chronological list: an event began, ended, changed, or a note was made. */
  eventRow(it) {
    const e = it.event, ev = app.events;
    const color = e.color || ev?.colorOf(e.entity) || "#6b7a8a";
    const text = describeEvent(e, it.edge);
    const span = it.edge === "end" && e.start_ms ? ` · after ${fmt.duration(e.end_ms - e.start_ms)}` : it.edge === "note" && e.min_ms !== undefined && e.max_ms !== undefined && e.max_ms > e.min_ms ? ` · some time between ${fmt.time(e.min_ms)} and ${fmt.time(e.max_ms)}` : "";
    return h("tr", { class: `event ${it.edge}` },
      h("td", {}, h("span", { class: "evdot", style: `background:${color};margin-left:3px` })),
      h("td", { colspan: 5 }, h("span", { class: "evlabel" }, text), h("span", { class: "muted" }, span)),
      h("td", { class: "muted nowrap" }, fmt.dateTime(it.ms, true)),
      h("td", { colspan: 2 }));
  }

  /** The stretches that were on when the message was last seen, as dots after its name. */
  eventMarks(r) {
    const active = r.latest?.last_ms ? app.events?.activeAt(r.latest.last_ms) || [] : [];
    return active.map((e) => h("span", { class: "evdot", style: `background:${e.color}`, title: `last seen while ${e.label} was on (since ${fmt.dateTime(e.start_ms)})` }));
  }

  /** How much of the message's traffic fell inside each watched stretch, as a thin bar after the count. */
  shareBar(r) {
    const shares = app.events?.shareOf(r) || [];
    return shares.slice(0, 3).map((s) => h("span", { class: "evshare", title: `${Math.round(s.share * 100)} % of this message's telegrams (${fmt.count(s.inside)} of ${fmt.count(s.total)}, by the command's first ID byte) arrived while ${s.label} was on` }, h("i", { style: `width:${Math.max(2, Math.round(s.share * 100))}%;background:${s.color}` })));
  }

  groupRow(g) {
    const open = this.openGroups.has(`${g.zz}${g.pbsb}`);
    return h("tr", { class: "group", onclick: () => { const k = `${g.zz}${g.pbsb}`; this.openGroups[open ? "delete" : "add"](k); this.render(true); } },
      h("td", {}, h("span", { class: "fold" }, open ? "▾" : "▸")),
      h("td", { colspan: 2 }, h("span", { class: "mono" }, `${g.zz} ${g.pbsb}`), ` · ${g.members.length} messages`, g.known ? h("span", { class: "muted" }, ` · ${g.known} understood by ebusd`) : null, g.newOnly ? h("span", { class: "accent" }, ` · ${g.newOnly} with other sources`) : null, g.unknown ? h("span", { class: "warn" }, ` · ${g.unknown} unknown`) : null),
      h("td", {}), h("td", { class: "num" }, fmt.count(g.n)), h("td", {}), h("td", {}), h("td", {}), h("td", {}));
  }

  /** The decoding shown for the latest telegram of a row: the row's definition's. */
  decodeOf(row, run = null) {
    const t = run?.line ? { line: run.line } : row.latest;
    if (!t || !app.decoder || !row.defKey) return null;
    return app.decoder.decodesOf(t.line)?.get(row.defKey) || null;
  }

  row(r) {
    const d = app.decoder;
    const dec = this.decodeOf(r);
    const latestHex = r.latest ? `${r.latest.master.slice(10 + r.id.length)}${r.latest.slave ? " / " + r.latest.slave.slice(2) : ""}` : "";
    const value = dec ? (dec.result === "ok" ? dec.text || "(empty)" : `✗ ${dec.result}`) : latestHex;
    const understood = [];
    if (r.known) understood.push(h("span", { class: "tbadge active", title: "ebusd understands this message today" }, "ebusd"));
    // the other sources: three, the rest folded into a count (a click unfolds them for this row)
    const others = [...r.newIn.map((s) => ({ s, maybe: false })), ...r.maybeIn.map((s) => ({ s, maybe: true }))];
    const unfolded = this.openBadges.has(r.key);
    for (const o of unfolded ? others : others.slice(0, BADGES_SHOWN)) understood.push(srcBadge(o.s, d.source(o.s)?.label, o.maybe));
    if (others.length > BADGES_SHOWN) understood.push(h("span", { class: "tbadge more", title: unfolded ? "fold them" : `${others.length} sources understand this message:\n${others.map((o) => `${d.source(o.s)?.label || o.s}${o.maybe ? " (not checked yet)" : ""}`).join("\n")}\nclick to show them all`,
      onclick: (e) => { e.stopPropagation(); this.openBadges[unfolded ? "delete" : "add"](r.key); this.render(true); } }, unfolded ? "fewer" : `+${others.length - BADGES_SHOWN}`));
    if (!r.known && r.inSetup) understood.push(h("span", { class: "tbadge custom", title: "a definition of your setup" }, "my setup"));
    if (r.scan && !r.known) understood.push(h("span", { class: "tbadge active", title: "ebusd's own scan of the device: the identification (07 04) and, for Vaillant, the serial number in four parts (b5 09 24…27, vaillant/scan.csv). Nothing to define." }, "ebusd's scan"));
    if (!r.known && !r.newIn.length && !r.maybeIn.length && !r.inSetup && !r.scan) understood.push(h("span", { class: r.candidates.size ? "warn" : "err" }, r.candidates.size ? (r.pending ? "fits, not checked yet" : "fits, but ebusd would not use it") : "nothing"));
    const devices = this.idents || {}, own = app.settings?.own_address || "31";
    const senders = [...r.senders.keys()].map((q) => `${q} (${addressName(q, { devices, own })})`).join(", ");
    const title = `${r.label}${r.def ? `\n${r.def.circuit} ${r.def.name} (${r.def.sourceLabel || r.def.source}, ${r.def.file.replace(/^.*\//, "")})` : ""}\nasked by ${senders}\n${fmt.count(r.candidates.size)} definition${r.candidates.size === 1 ? "" : "s"} fit: click to compare and choose`;
    return h("tr", { class: `msg ${this.selected?.key === r.key ? "selected" : ""} attention${r.attention}`, "data-key": r.key, title, onclick: () => this.select(r, null, true) },
      h("td", {}, h("span", { class: "fold" }, this.selected?.key === r.key ? "▾" : "")),
      h("td", { class: "name" }, r.def ? [chip(r.def.circuit, r.def.name), setup.exportName(r.def) !== r.def.name ? h("span", { class: "export" }, `→ ${setup.exportName(r.def)}`) : null, h("span", { class: "tmeta" }, accessKind(r.def))] : [h("span", { class: "mono" }, r.label), h("span", { class: "tmeta" }, r.zz === "fe" ? "broadcast" : r.latest?.slave ? "answered" : "no answer")],
        !r.def && !r.scan ? h("span", { class: "define" }, "＋ define") : null, !r.def && r.scan ? h("span", { class: "tmeta" }, "scan") : null, this.eventMarks(r)),
      h("td", {}, understood),
      h("td", { class: "mono value", title: dec ? `${value}\n${latestHex}` : "" }, value.length > 400 ? `${value.slice(0, 398)}…` : value),
      h("td", { class: "num nowrap" }, fmt.count(r.n), this.shareBar(r)),
      h("td", { class: "num" }, fmt.count(r.distinct)),
      h("td", { class: "muted nowrap" }, r.latest?.last_ms ? fmt.duration(Math.max(0, Date.now() - r.latest.last_ms)) + " ago" : ""),
      h("td", { class: "num" }, r.candidates.size ? h("span", { class: `cands ${r.pending ? "pending" : ""}`, title: r.pending ? "some of them are not checked with ebusd's library yet" : "" }, `${r.candidates.size}`) : ""),
      h("td", {}, r.defKey ? h("input", { type: "checkbox", checked: r.inSetup, title: r.inSetup ? "in your setup" : "add to your setup", onclick: (e) => e.stopPropagation(), onchange: (e) => setup.include(r.defKey, e.target.checked, d.entries) }) : ""));
  }

  // -- the selection, for the inspector -------------------------------------------------------------------

  select(row, run = null, emit = false) {
    if (emit && row && this.selected?.key === row.key) { bus.emit("select-row", null); return; }   // a click on the selected message closes its inspector
    this.selected = row;
    if (emit) bus.emit("select-row", row ? { row, run, options: {}, view: this } : null);
    for (const tr of this.el.list.querySelectorAll("tr.msg")) {
      const on = !!row && tr.dataset.key === row.key;
      tr.classList.toggle("selected", on);
      const fold = tr.querySelector(".fold"); if (fold) fold.textContent = on ? "▾" : "";
    }
  }

  /** The value history of a message over the whole recording, loaded once per message and recording state. */
  loadSeries(row) {
    const db = app.status?.db;
    if (!db?.first_ms) return Promise.resolve(null);
    const from = db.first_ms, to = db.last_ms + 1000;
    const cacheKey = `${row.key}|${from}|${Math.floor(to / 60000)}`;
    const cached = this.seriesCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    let pending = this.seriesLoading.get(cacheKey);
    if (!pending) {
      pending = app.api.get(seriesQuery(row.row, from, to)).then((data) => { this.seriesCache.set(cacheKey, data); return data; });
      this.seriesLoading.set(cacheKey, pending);
      pending.finally(() => this.seriesLoading.delete(cacheKey));
    }
    return pending;
  }
}

export const hexOf = hexByte;
