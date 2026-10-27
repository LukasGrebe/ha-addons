// Timeline of recorded telegrams and Home Assistant events.
//
// Telegrams are grouped into rows (source, destination, command and message ID) and shown as
// runs: a bar spans the time a value stayed the same, labelled with the value, the number of
// repetitions and the typical interval. Entity state changes are rows of the same kind, manual
// markers are vertical lines. Wheel zooms, dragging pans, clicking a run shows the telegrams.
import { api, app, append, bus, fmt, h, toast } from "./app.js";
import { idLength, messageColors, telegramRowKey, valueColors } from "./colors.js";

const ROW = 24;
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
    this.names = new Map();
    this.filter = "";
    this.onlyChanges = false;
    this.sort = "address";
    this.hover = null;
    this.selected = null;
    this.loadToken = 0;
    this.build();
    bus.on("names", (names) => { this.names = names; this.buildRows(); this.render(); });
    bus.on("idlengths", (lengths) => { this.idLengths = lengths; this.updateIdButton(); });
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
      h("option", { value: "address" }, "by address"), h("option", { value: "activity" }, "most telegrams"), h("option", { value: "changes" }, "most changes"));
    el.applyIds = h("button", { class: "small", style: "display:none", title: "set the message ID lengths per device and command as the decoded definitions define them", onclick: () => this.applyIdLengths() }, "ID lengths from definitions");
    el.info = h("span", { class: "hint" });
    el.toolbar = h("div", { class: "toolbar" },
      el.presets,
      h("span", { class: "group" }, h("button", { title: "zoom out (-)", onclick: () => this.zoom(2) }, "−"), h("button", { title: "zoom in (+)", onclick: () => this.zoom(0.5) }, "+"), el.follow),
      h("span", { class: "group" }, h("label", {}, "ID bytes"), el.idBytes, el.applyIds),
      h("span", { class: "group" }, el.filter),
      h("label", { class: "group" }, el.onlyChanges, " only changed"),
      h("span", { class: "group" }, el.sort),
      h("span", { class: "group" }, h("button", { onclick: () => this.addMarker() }, "+ marker"), h("button", { title: "Decode the telegrams of the visible window with the compiled definitions", onclick: () => bus.emit("test-window", { from: this.t0, to: this.t1 }) }, "test window ›")),
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
    el.tooltip = h("div", { class: "tl-tooltip" });
    el.details = h("div", { class: "tl-details" });
    this.root.appendChild(h("div", { class: "tl" }, el.toolbar, el.overview, el.axis, el.body, el.details, el.tooltip));
    this.bindMouse();
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
    if (reload) this.load(true); else this.render();
  }

  setFollowSilently(on) { this.follow = on; this.el.follow.classList.toggle("active", on); }

  zoom(factor, at = null) {
    const pivot = at ?? (this.follow ? this.t1 : (this.t0 + this.t1) / 2);
    let t0 = pivot - (pivot - this.t0) * factor;
    let t1 = pivot + (this.t1 - pivot) * factor;
    if (this.follow) { t1 = Date.now(); t0 = t1 - (this.span * factor); }
    this.setWindow(t0, t1);
  }

  pan(fraction) {
    const delta = this.span * fraction;
    this.setWindow(this.t0 + delta, this.t1 + delta);
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
    try {
      const [runs, events] = await Promise.all([
        api.get(`api/telegrams/runs?from=${from}&to=${to}`),
        api.get(`api/events?from=${from - EVENT_LOOKBACK}&to=${to}`),
      ]);
      if (token !== this.loadToken) return;
      this.data = runs;
      this.states = events.states;
      this.markers = events.markers;
      this.buildRows();
      this.updateInfo();
      this.render();
    } catch (err) {
      if (token === this.loadToken) toast(`loading telegrams failed: ${err.message}`, "err");
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
    const nameIndex = this.nameIndex();
    const telegramRows = [];
    for (const row of this.data?.rows || []) {
      const key = `${fmt.hex(row.qq)}→${fmt.hex(row.zz)} ${fmt.hex(row.pb)}${fmt.hex(row.sb)} ${row.id}`;
      const name = nameIndex.get(`${fmt.hex(row.qq)}${fmt.hex(row.zz)}${fmt.hex(row.pb)}${fmt.hex(row.sb)}${row.id}`) || "";
      if (!this.matches(key, name)) continue;
      const runs = row.runs.map((r) => {
        const [payload, slave, status] = r[3].split("/");
        const label = payload && slave ? `${payload} / ${slave}` : payload || slave || (status === "ok" ? "(no data)" : status);
        return { t0: r[0], t1: r[1], n: r[2], value: r[3], payload, slave, status, mean: r[4], min: r[5], label };
      });
      if (this.onlyChanges && runs.length < 2) continue;
      telegramRows.push({ kind: "telegram", key, label: key, name, n: row.n, runs, row });
    }
    const sorters = {
      address: (a, b) => a.row.zz - b.row.zz || a.row.pb - b.row.pb || a.row.sb - b.row.sb || a.row.id.localeCompare(b.row.id) || a.row.qq - b.row.qq,
      activity: (a, b) => b.n - a.n,
      changes: (a, b) => b.runs.length - a.runs.length || b.n - a.n,
    };
    telegramRows.sort(sorters[this.sort] || sorters.address);
    this.rows = rows.concat(telegramRows);
    if (this.selected && !this.rows.some((r) => r.key === this.selected.row.key)) this.closeDetails();
    this.renderLabels();
  }

  matches(key, name) {
    if (!this.filter) return true;
    const haystack = `${key} ${name}`.toLowerCase();
    return this.filter.split(/\s+/).every((word) => haystack.includes(word) || haystack.replace(/[→ ]/g, "").includes(word));
  }

  /** master hex prefix (QQ ZZ PB SB ID) -> name, from the decoded telegrams of the definitions tab. */
  nameIndex() {
    const index = new Map();
    for (const [master, name] of this.names) {
      const key = telegramRowKey(master, this.settings);
      const existing = index.get(key);
      if (!existing) index.set(key, name);
      else if (!existing.split(", ").includes(name)) index.set(key, `${existing}, ${name}`);
    }
    return index;
  }

  renderLabels() {
    const labels = this.el.labels;
    labels.replaceChildren();
    for (const [i, row] of this.rows.entries()) {
      const el = h("div", { class: `tl-label ${row.kind}`, title: row.name ? `${row.label}\n${row.name}` : row.label, "data-row": i,
        onclick: () => this.showDetails(row, null) },
        h("span", { class: "key" }, row.label),
        row.name ? h("span", { class: "name", style: row.kind === "telegram" ? `color:${messageColors(row.name.split(" ")[0], row.name.split(" ").slice(1).join(" ")).text}` : "" }, row.name) : null,
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
          if (next && this.xOf(next.t0) - x0 > 40) ctx.fillText(run.label, x0 + 4, top + barHeight - 4);
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
        let text = run.label;
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
    plot.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { this.pan((e.deltaX || e.deltaY) / this.width); return; }
      const factor = Math.exp(Math.sign(e.deltaY) * 0.25);
      this.zoom(factor, this.tOf(e.offsetX));
    }, { passive: false });
    plot.addEventListener("dblclick", (e) => this.zoom(0.5, this.tOf(e.offsetX)));
    const overview = this.el.overviewCanvas;
    let odrag = null;
    overview.addEventListener("mousedown", (e) => { odrag = { x: e.offsetX }; });
    overview.addEventListener("mousemove", (e) => { if (odrag) { odrag.x1 = e.offsetX; } });
    window.addEventListener("mouseup", (e) => {
      if (!odrag || !this.overviewScale) { odrag = null; return; }
      const { start, scale } = this.overviewScale;
      const rect = overview.getBoundingClientRect();
      const xEnd = e.clientX - rect.left;
      if (Math.abs(xEnd - odrag.x) > 4) {
        this.setWindow(start + Math.min(odrag.x, xEnd) / scale, start + Math.max(odrag.x, xEnd) / scale);
      } else {
        const center = start + odrag.x / scale;
        this.setWindow(center - this.span / 2, center + this.span / 2);
      }
      odrag = null;
    });
  }

  onKey(e) {
    if (!this.root.classList.contains("active") || e.target.closest("input, textarea, select")) return;
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
        text = `${row.label}${row.name ? `  ${row.name}` : ""}\n${run.label}${run.status !== "ok" ? `  [${run.status}]` : ""}\n`
          + (run.n === 1 ? `once at ${fmt.time(run.t0, true)}` : `${fmt.count(run.n)}× from ${fmt.time(run.t0)} to ${fmt.time(run.t1)} (${fmt.duration(run.t1 - run.t0)})`
          + (run.mean ? `\nevery ${fmt.duration(run.mean)} (shortest ${fmt.duration(run.min)})` : ""));
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
      const table = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "time"), h("th", {}, "type"), h("th", {}, "master (QQ ZZ PB SB NN DD)"), h("th", {}, "slave (NN DD)"), h("th", {}, "status"), h("th", {}))),
        h("tbody", {}, telegrams.map((t) => h("tr", {},
          h("td", { class: "mono" }, fmt.dateTime(t.ms, true)), h("td", {}, t.type || ""),
          h("td", { class: "mono" }, t.master || t.dd || ""), h("td", { class: "mono" }, t.slave || ""),
          h("td", { class: t.status === "ok" ? "ok" : "err" }, t.status),
          h("td", {}, t.master ? h("button", { class: "small", onclick: () => bus.emit("test-telegrams", [{ master: t.master, slave: t.slave, n: 1 }]) }, "decode ›") : null)))));
      const note = telegrams.length >= 500 ? h("div", { class: "hint", style: "padding:4px 10px" }, "showing the first 500 telegrams") : null;
      details.replaceChildren();
      append(details, head, table, note);
    } catch (err) {
      details.replaceChildren(head, h("div", { class: "err", style: "padding:8px 10px" }, err.message));
    }
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
