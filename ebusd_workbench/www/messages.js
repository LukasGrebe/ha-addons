// The bus as a list of messages, the way a definition sees them: one row per destination,
// command and message ID (whoever asked), built from the browser store. Leads with what needs a
// look: messages ebusd does not understand today, and messages only another source (the upcoming
// release, a pull request, your scratchpad) understands. The devices on the bus head the list,
// each with what ebusd loads for it and how much of its traffic is understood. A click on a row
// opens the inspector of the message under its row.
import { app, append, bus, fmt, h } from "./app.js";
import { seriesQuery } from "./chart.js";
import { idLengthOf, messageColors } from "./colors.js";
import { accessKind } from "./compare.js";
import { MINE, setup } from "./setup.js";
import { addressName } from "./ebus-spec.js";

const FILTERS = [
  ["attention", "needs a look", "messages ebusd does not understand today: unknown ones (most traffic first) and ones another source understands"],
  ["unknown", "unknown everywhere", "messages no source decodes: start a definition of your own from their bytes in the inspector"],
  ["new", "other sources know them", "messages ebusd does not understand, but the upcoming release, a pull request or a definition of your own does"],
  ["all", "all messages", "every message on the bus, by device"],
  ["setup", "in my setup", "messages whose definition is in your setup"],
];
const GROUP_MIN = 8;
const hexByte = (n) => (n === null || n === undefined ? "--" : n.toString(16).padStart(2, "0"));
const chip = (circuit, name) => { const c = messageColors(circuit, name); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit} ${name}`); };
const remembered = (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === "1"; } catch { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* ignore */ } };
const srcBadge = (source, label) => h("span", { class: `tbadge ${source === MINE ? "custom" : source === "release" ? "" : "src"}` }, source === MINE ? "mine" : label || source);

export class MessagesView {
  constructor(root) {
    this.root = root;
    this.kind = "table";
    this.filter = "attention";
    this.query = "";
    this.device = null;          // zz to show, or null for all
    this.devicesOpen = remembered("workbench.devicesOpen", true);   // the devices with their numbers, or one line
    this.openGroups = new Set(); // zz+pbsb of the commands unfolded in the list
    this.selected = null;
    this.preview = null;         // {key, defKey} while a card is hovered: the row shows that decoding
    this.allRows = [];
    this.devices = [];
    this.seriesCache = new Map();
    this.seriesLoading = new Map();
    this.timer = null;
    this.build();
    bus.on("decodes-changed", (reason) => { if (reason !== "progress") this.schedule(); });
    bus.on("setup-changed", () => this.schedule());
    bus.on("settings-changed", () => this.schedule());
    bus.on("status", () => { if (!this.allRows.length) this.schedule(); });
    this.schedule();
  }

  get settings() { return app.settings || { id_bytes: 1, id_overrides: {} }; }

  /** The time window of the view: none, the table is the whole recording (the history charts show no band). */
  window() { return null; }

  visible() { return this.root.clientWidth > 0; }

  schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => { this.buildRows(); this.render(); }, 250); }

  build() {
    const el = (this.el = {});
    el.filters = h("span", { class: "seg group" }, FILTERS.map(([id, label, title]) => h("button", { class: id === this.filter ? "active" : "", title, "data-filter": id, onclick: () => { this.filter = id; this.device = null; this.render(true); } }, label)));
    el.search = h("input", { type: "search", placeholder: "filter: name, circuit, address, command…", size: 28, oninput: () => { this.query = el.search.value.trim().toLowerCase(); this.render(true); } });
    el.info = h("span", { class: "hint" });
    el.toolbar = h("div", { class: "toolbar msg-toolbar" }, el.filters, h("span", { class: "group" }, el.search), h("span", { class: "group", style: "margin-left:auto" }, el.info));
    el.devices = h("div", { class: "devices" });
    el.list = h("div", { class: "msg-list" });
    append(this.root, el.toolbar, el.devices, el.list);
  }

  // -- the rows: one per message as the definitions identify it -------------------------------------------

  buildRows() {
    const d = app.decoder;
    if (!d) { this.allRows = []; this.devices = []; return; }
    const primary = d.primary;
    const settings = this.settings;
    const rows = new Map();
    const senders = new Map();   // qq -> telegrams sent (to tell the masters on the bus)
    for (const t of d.telegrams.values()) {
      if (!t.master || t.manual) continue;
      const map = d.decodesOf(t.line);
      let idlen = 0;
      if (map) for (const x of map.values()) { const def = d.def(x.defKey); if (def && def.idlen > idlen) idlen = def.idlen; }
      if (!map || !map.size) idlen = idLengthOf(t.master, settings);
      const zz = t.master.slice(2, 4), pbsb = t.master.slice(4, 8), id = t.master.slice(10, 10 + idlen * 2);
      const key = `${zz}${pbsb}:${id}`;
      let row = rows.get(key);
      if (!row) {
        rows.set(key, (row = { kind: "telegram", key, zz, pbsb, id, label: `${zz} ${pbsb}${id ? " " + id : ""}`, n: 0, distinct: 0, senders: new Map(), first: null, latest: null, candidates: new Map(), knownBy: new Set(), lines: [],
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
      if (map) {
        for (const [k, x] of map) {
          const def = d.def(k);
          if (!def) continue;
          let c = row.candidates.get(k);
          if (!c) row.candidates.set(k, (c = { def, ok: 0, errors: 0, used: 0, usedIn: 0, last: x }));
          if (x.result === "ok") c.ok++; else c.errors++;
          if (x.used) { c.usedIn++; row.knownBy.add(x.source); if (x.source === primary) c.used++; }
          c.last = x;
        }
      }
    }
    const included = new Set(setup.includedKeys(d.entries));
    const order = Object.fromEntries(d.sources().map((s, i) => [s.id, i]));
    const own = app.settings?.own_address || "31";
    for (const row of rows.values()) {
      row.qq = [...row.senders.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;   // the usual sender (for defining the message)
      row.row.qq = row.qq ? parseInt(row.qq, 16) : null;
      row.known = row.knownBy.has(primary);
      row.newIn = [...row.knownBy].filter((s) => s !== primary).sort((a, b) => (order[a] ?? 99) - (order[b] ?? 99));
      row.defKey = this.rowDefinition(row, included, primary, order);
      row.def = row.defKey ? d.def(row.defKey) : null;
      row.name = row.def ? `${setup.circuitOf(row.def)} ${setup.exportName(row.def)}` : "";
      row.inSetup = [...row.candidates.keys()].some((k) => included.has(k));
      // 0 handled (ebusd understands it, or you put a definition into your setup), 1 something fits but ebusd would not use it,
      // 2 another source understands it, 3 nothing fits
      row.attention = row.known || row.inSetup ? 0 : row.newIn.length ? 2 : row.candidates.size ? 1 : 3;
      // ebusd's own scan of the devices: the identification, and for Vaillant the serial number in four parts; nothing to define
      row.scan = row.pbsb === "0704" || (row.pbsb === "b509" && /^2[4-7]$/.test(row.id) && row.senders.has(own));
      if (row.scan) row.attention = 0;
    }
    this.allRows = [...rows.values()];
    this.senders = senders;
    this.devices = this.deviceList();
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
    const others = [...row.candidates.values()].filter((c) => c.usedIn > 0).sort((a, b) => (order[a.def.source] ?? 99) - (order[b.def.source] ?? 99));
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
      // understood: by ebusd today, or with what you put into your setup
      if (row.attention === 0) { dev.known++; dev.knownN += row.n; } else if (row.attention === 2) { dev.newOnly++; dev.newN += row.n; for (const s of row.newIn) dev.newIn.add(s); } else { dev.unknown++; dev.unknownN += row.n; }
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
    if (this.filter === "attention" || this.filter === "unknown" || this.filter === "new") rows.sort((a, b) => b.n - a.n);   // the most traffic first: what matters most
    else rows.sort((a, b) => a.zz.localeCompare(b.zz) || b.n - a.n);
    return rows;
  }

  /** Rows of one command with many messages (the registers of b524) fold into one line unless unfolded. */
  grouped(rows) {
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
    this.renderDevices();
    if (this.selected && this.inspHost && !force) return;   // the list stays put while you inspect a message
    const rows = this.shownRows();
    if (this.selected && force && !rows.some((r) => r.key === this.selected.key)) { bus.emit("select-row", null); return; }
    const d = app.decoder;
    const total = this.allRows.length;
    el.info.textContent = total ? `${fmt.count(rows.length)} of ${fmt.count(total)} messages${this.device ? ` of ${this.device}` : ""}` : "";
    el.list.replaceChildren();
    if (!d?.build) { append(el.list, h("div", { class: "empty" }, d?.telegrams.size ? "Waiting for definitions to decode the recording…" : "Reading the recording into the browser…")); return; }
    if (!total) { append(el.list, h("div", { class: "empty" }, app.status?.db?.exists ? "No telegrams yet." : h("span", {}, "No telegrams recorded yet. Set ", h("code", {}, `sqlite_db: ${app.status?.db?.path || "/share/ebusd/telegrams.db"}`), " in the eBUSd app configuration (SQLite telegram log) and restart it."))); return; }
    if (!rows.length) {
      const text = this.filter === "attention" ? "ebusd understands every message on your bus (with the sources you have). Look at “all messages” to rename or add things, or add a pull request that may know more." : this.filter === "setup" ? "Nothing in your setup fits a message yet." : "Nothing matches.";
      append(el.list, h("div", { class: "empty" }, text));
      return;
    }
    const table = h("table", { class: "msgs" }, h("thead", {}, h("tr", {},
      h("th", { style: "width:18px" }), h("th", {}, "message"), h("th", {}, "understood by"), h("th", {}, "latest value"), h("th", { class: "num" }, "telegrams"), h("th", { class: "num", title: "distinct telegrams (values) seen" }, "values"), h("th", {}, "last seen"), h("th", { class: "num", title: "definitions that fit this message, from every source" }, "fits"), h("th", { title: "part of your setup" }, "setup"))),
      h("tbody", {}, this.grouped(rows).map((r) => (r.kind === "group" ? this.groupRow(r) : this.row(r)))));
    append(el.list, table);
    app.decoder?.markDrawn?.();
    this.placeInspector();
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

  groupRow(g) {
    const open = this.openGroups.has(`${g.zz}${g.pbsb}`);
    return h("tr", { class: "group", onclick: () => { const k = `${g.zz}${g.pbsb}`; this.openGroups[open ? "delete" : "add"](k); this.render(true); } },
      h("td", {}, h("span", { class: "fold" }, open ? "▾" : "▸")),
      h("td", { colspan: 2 }, h("span", { class: "mono" }, `${g.zz} ${g.pbsb}`), ` · ${g.members.length} messages`, g.known ? h("span", { class: "muted" }, ` · ${g.known} understood by ebusd`) : null, g.newOnly ? h("span", { class: "accent" }, ` · ${g.newOnly} with other sources`) : null, g.unknown ? h("span", { class: "warn" }, ` · ${g.unknown} unknown`) : null),
      h("td", {}), h("td", { class: "num" }, fmt.count(g.n)), h("td", {}), h("td", {}), h("td", {}), h("td", {}));
  }

  /** The decoding shown for the latest telegram of a row: the previewed candidate's, else the row's definition's. */
  decodeOf(row, run = null) {
    const t = run?.line ? { line: run.line } : row.latest;
    if (!t || !app.decoder) return null;
    const key = this.preview && this.preview.key === row.key ? this.preview.defKey : row.defKey;
    if (!key) return null;
    return app.decoder.decodesOf(t.line)?.get(key) || null;
  }

  runLabel(row, run) {
    const d = this.decodeOf(row, run);
    if (!d) return run?.label || "";
    return d.result === "ok" ? (d.text || "(empty)") : `✗ ${d.result}`;
  }

  row(r) {
    const d = app.decoder;
    const primary = d.primary;
    const dec = this.decodeOf(r);
    const latestHex = r.latest ? `${r.latest.master.slice(10 + r.id.length)}${r.latest.slave ? " / " + r.latest.slave.slice(2) : ""}` : "";
    const value = dec ? (dec.result === "ok" ? dec.text || "(empty)" : `✗ ${dec.result}`) : latestHex;
    const understood = [];
    if (r.known) understood.push(h("span", { class: "tbadge active", title: "ebusd understands this message today" }, "ebusd"));
    for (const s of r.newIn) understood.push(srcBadge(s, d.source(s)?.label));
    if (!r.known && r.inSetup) understood.push(h("span", { class: "tbadge custom", title: "a definition of your setup" }, "my setup"));
    if (r.scan && !r.known) understood.push(h("span", { class: "tbadge active", title: "ebusd's own scan of the device: the identification (07 04) and, for Vaillant, the serial number in four parts (b5 09 24…27, vaillant/scan.csv). Nothing to define." }, "ebusd's scan"));
    if (!r.known && !r.newIn.length && !r.inSetup && !r.scan) understood.push(h("span", { class: r.candidates.size ? "warn" : "err" }, r.candidates.size ? "fits, but ebusd would not use it" : "nothing"));
    const devices = this.idents || {}, own = app.settings?.own_address || "31";
    const senders = [...r.senders.keys()].map((q) => `${q} (${addressName(q, { devices, own })})`).join(", ");
    const title = `${r.label}${r.def ? `\n${r.def.circuit} ${r.def.name} (${r.def.sourceLabel || r.def.source}, ${r.def.file.replace(/^.*\//, "")})` : ""}\nasked by ${senders}\n${fmt.count(r.candidates.size)} definition${r.candidates.size === 1 ? "" : "s"} fit: click to compare and choose`;
    return h("tr", { class: `msg ${this.selected?.key === r.key ? "selected" : ""} attention${r.attention}`, "data-key": r.key, title, onclick: () => this.select(r, null, true) },
      h("td", {}, h("span", { class: "fold" }, this.selected?.key === r.key ? "▾" : "")),
      h("td", { class: "name" }, r.def ? [chip(r.def.circuit, r.def.name), setup.exportName(r.def) !== r.def.name ? h("span", { class: "export" }, `→ ${setup.exportName(r.def)}`) : null, h("span", { class: "tmeta" }, accessKind(r.def))] : [h("span", { class: "mono" }, r.label), h("span", { class: "tmeta" }, r.zz === "fe" ? "broadcast" : r.latest?.slave ? "answered" : "no answer")],
        !r.def && !r.scan ? h("span", { class: "define" }, "＋ define") : null, !r.def && r.scan ? h("span", { class: "tmeta" }, "scan") : null),
      h("td", {}, understood),
      h("td", { class: "mono value", title: dec ? `${value}\n${latestHex}` : "" }, value.length > 400 ? `${value.slice(0, 398)}…` : value),
      h("td", { class: "num" }, fmt.count(r.n)),
      h("td", { class: "num" }, fmt.count(r.distinct)),
      h("td", { class: "muted nowrap" }, r.latest?.last_ms ? fmt.duration(Math.max(0, Date.now() - r.latest.last_ms)) + " ago" : ""),
      h("td", { class: "num" }, r.candidates.size ? h("span", { class: "cands" }, `${r.candidates.size}`) : ""),
      h("td", {}, r.defKey ? h("input", { type: "checkbox", checked: r.inSetup, title: r.inSetup ? "in your setup" : "add to your setup", onclick: (e) => e.stopPropagation(), onchange: (e) => setup.include(r.defKey, e.target.checked, d.entries) }) : ""));
  }

  // -- the selection, for the scratchpad -------------------------------------------------------------------

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

  setPreview(row, defKey) {
    const next = defKey ? { key: row.key, defKey } : null;
    if ((this.preview?.defKey || null) === (next?.defKey || null)) return;
    this.preview = next;
    const tr = [...this.el.list.querySelectorAll("tr.msg")].find((x) => x.dataset.key === row.key);
    if (tr) { const cell = tr.querySelector("td.value"); const dec = this.decodeOf(row); if (cell && dec) cell.textContent = (dec.result === "ok" ? dec.text || "(empty)" : `✗ ${dec.result}`).slice(0, 90); }
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

  /** The rows of this view mentioned by the scratchpad: nothing to split, the rows already follow the definitions. */
  splitLikeDefinitions() {}
}

export const hexOf = hexByte;
