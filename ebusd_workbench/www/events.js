// Events next to the telegrams: the on/off stretches of the watched switches and binary sensors
// (the pump, the burner, a request), the value changes of the other watched entities, and the notes
// made with the `log` command of the eBUSd terminal. The device builds them from its tables
// (GET api/events); this module holds them for the views: which stretches were active at a time
// (a telegram's row, the inspector's telegram line, the bands of a chart), the share of a message's
// traffic that fell inside them (GET api/events/share), and the chronological list that interleaves
// them with the messages.
import { api, app, bus } from "./app.js";

/** A colour per entity when the settings give none: twelve that tell apart, by a hash of the id. */
const PALETTE = ["#1976d2", "#388e3c", "#f57c00", "#7b1fa2", "#c2185b", "#0097a7", "#5d4037", "#455a64", "#afb42b", "#e64a19", "#303f9f", "#00796b"];
export function defaultColor(entity) {
  let hash = 2166136261;
  for (let i = 0; i < entity.length; i++) { hash ^= entity.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return PALETTE[(hash >>> 0) % PALETTE.length];
}
/** On/off stretches for the binary domains, value changes otherwise (the device's default too). */
export const defaultMode = (entity) => (["binary_sensor", "switch", "input_boolean", "light", "fan"].includes(entity.split(".")[0]) ? "interval" : "value");

/** The intervals by entity: Map(entity -> [{start_ms, end_ms|null, label, color, entity}]). */
export function intervalsOf(events) {
  const out = new Map();
  for (const e of events || []) if (e.kind === "interval") { if (!out.has(e.entity)) out.set(e.entity, []); out.get(e.entity).push(e); }
  return out;
}

/** The intervals active at a time (an open one runs on). */
export function activeIntervals(intervals, ms) {
  if (!intervals || ms === null || ms === undefined) return [];
  const out = [];
  for (const list of intervals.values()) for (const e of list) if (e.start_ms <= ms && (e.end_ms === null || e.end_ms === undefined || ms < e.end_ms)) out.push(e);
  return out;
}

/**
 * The chronological list: message rows by their newest telegram and the events as lines (an interval as
 * its start and its end), the newest first: [{kind: "row", ms, row} | {kind: "event", ms, event, edge}].
 */
export function mergeTimeline(rows, events) {
  const items = rows.map((row) => ({ kind: "row", ms: row.latest?.last_ms || 0, row }));
  for (const e of events || []) {
    if (e.kind === "interval") {
      items.push({ kind: "event", ms: e.start_ms, event: e, edge: "start" });
      if (e.end_ms !== null && e.end_ms !== undefined) items.push({ kind: "event", ms: e.end_ms, event: e, edge: "end" });
    } else items.push({ kind: "event", ms: e.start_ms, event: e, edge: e.kind });
  }
  return items.sort((a, b) => b.ms - a.ms || (a.kind === "event" ? -1 : 1));
}

/** One line of the chronological list, in words. */
export function describeEvent(e, edge) {
  if (edge === "start") return `${e.label} on`;
  if (edge === "end") return `${e.label} off`;
  if (edge === "note") return `note: ${e.label}`;
  return `${e.label} = ${e.value}`;
}

export class Events {
  constructor() {
    this.events = [];
    this.config = [];
    this.entities = [];
    this.intervals = new Map();
    this.share = null;
    this.loaded = null;
    this.timer = null;
    this.loading = false;
    bus.on("status", () => this.schedule());
    bus.on("settings-changed", () => this.schedule(true));
  }

  /** The recording's window: the events are read once per window (the recording grows, the window with it). */
  window() {
    const db = app.status?.db;
    return db?.first_ms ? { from: db.first_ms, to: (db.last_ms || db.first_ms) + 1000 } : null;
  }

  schedule(force = false) {
    if (force) this.loaded = null;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.load().catch((err) => console.warn("events:", err)); }, force ? 50 : 3000);
  }

  async load() {
    const w = this.window();
    if (!w || this.loading) return;
    const key = `${w.from}|${Math.floor(w.to / 60000)}`;
    if (key === this.loaded) return;
    this.loading = true;
    try {
      const data = await api.get(`api/events?from=${w.from}&to=${w.to}`);
      this.events = data.events || [];
      this.config = data.config || [];
      this.entities = data.entities || [];
      this.intervals = intervalsOf(this.events);
      this.loaded = key;
      bus.emit("events-changed");
      if (this.intervals.size) {
        const share = await api.get(`api/events/share?from=${w.from}&to=${w.to}`);
        this.share = share;
        bus.emit("events-changed");
      } else this.share = null;
    } finally { this.loading = false; }
  }

  configOf(entity) { return this.config.find((c) => c.entity === entity) || null; }
  labelOf(entity) { return this.configOf(entity)?.label || entity; }
  colorOf(entity) { return this.configOf(entity)?.color || defaultColor(entity); }

  /** The intervals active at a time, with colour and label. */
  activeAt(ms) { return activeIntervals(this.intervals, ms).map((e) => ({ ...e, color: e.color || this.colorOf(e.entity) })); }

  /** The bands of a chart over [t0, t1]: every interval with its colour. */
  bandsIn(t0, t1) {
    const out = [];
    for (const list of this.intervals.values()) for (const e of list) {
      const to = e.end_ms ?? t1;
      if (to > t0 && e.start_ms < t1) out.push({ from: e.start_ms, to, color: e.color || this.colorOf(e.entity), label: e.label });
    }
    return out;
  }

  /**
   * How much of a message's traffic fell inside each entity's stretches, by the row's destination, command and
   * first ID byte: [{entity, label, color, inside, total, share}], the largest share first.
   */
  shareOf(row) {
    if (!this.share?.total) return [];
    const key = `${row.zz}|${row.pbsb}|${(row.id || "").slice(0, 2)}`;
    const total = this.share.total[key] || 0;
    if (!total) return [];
    const out = [];
    for (const [entity, counts] of Object.entries(this.share.entities || {})) {
      const inside = counts[key] || 0;
      if (inside) out.push({ entity, label: this.labelOf(entity), color: this.colorOf(entity), inside, total, share: inside / total });
    }
    return out.sort((a, b) => b.share - a.share);
  }

  get notes() { return this.events.filter((e) => e.kind === "note"); }
}
