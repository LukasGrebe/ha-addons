// Judging the candidate definitions of a message over the whole recording: how each one decodes
// the message's telegrams, and why a candidate is not the one ebusd uses.

import { addressName, slaveOf } from "./ebus-spec.js";

const hex2 = (n) => n.toString(16).padStart(2, "0");
const MAX_VALUES = 5000;
const MAX_LINES = 5000;

/** read / write / passive read / passive write: what ebusd does with the definition. */
export function accessKind(def) {
  return def.passive ? (def.write ? "passive write" : "passive read") : def.write ? "active write" : "active read";
}

export const KIND_HELP = {
  "active read": "ebusd polls this value from the device",
  "active write": "ebusd sends this value to the device (it changes the device)",
  "passive read": "ebusd only listens: it decodes what other devices send or answer on the bus",
  "passive write": "ebusd only listens: it decodes a command another device sends, e.g. the controller setting a mode",
};

/** The shorthand of the kind in ebusd's CSV (the first column). */
export const KIND_CODES = { "active read": "r", "active write": "w", "passive read": "u", "passive write": "uw" };

/** The kind as a suffix for chips: nothing for an active read, the usual case. */
export const kindSuffix = (def) => (accessKind(def) === "active read" ? "" : ` · ${accessKind(def)}`);

/** The recorded telegrams (store records) of a message: same destination, command and message ID. */
export function rowTelegrams(core, row) {
  if ([row.zz, row.pb, row.sb].some((v) => v === null || v === undefined) || (!row.anyQq && (row.qq === null || row.qq === undefined))) return [];
  const prefix = `${hex2(row.zz)}${hex2(row.pb)}${hex2(row.sb)}`;
  const sender = row.anyQq ? null : hex2(row.qq);
  const id = row.id || "";
  const out = [];
  for (const t of core.telegrams.values()) {
    const master = t.master;
    if (!master || master.slice(2, 8) !== prefix || (sender && !master.startsWith(sender)) || !master.slice(10).startsWith(id)) continue;
    out.push(t);
    if (out.length >= MAX_LINES) break;
  }
  return out.sort((a, b) => (a.first_ms ?? Infinity) - (b.first_ms ?? Infinity));
}

const valueList = (d) => (d.fields && Object.keys(d.fields).length ? Object.values(d.fields).map(String) : [d.text || ""]);

/** How a definition decodes the telegrams of a message, over the whole recording (telegrams not decoded yet count as pending). */
export function coverage(core, telegrams, hash) {
  const out = { telegrams: telegrams.length, decoded: 0, distinct: 0, ok: 0, errors: 0, pending: 0, occurrences: 0, okOccurrences: 0, first_ms: null, last_ms: null,
    errorKinds: new Map(), values: new Map(), fields: new Map(), truncated: false, latest: null };
  for (const t of telegrams) {
    const d = core.decodesOf(t.line)?.get(hash);
    if (!d) { if (core.matchesOf(t).includes(hash)) out.pending++; continue; }
    out.decoded++;
    out.distinct++;
    const n = t.n || 0;
    out.occurrences += n;
    if (t.first_ms !== null && t.first_ms !== undefined) out.first_ms = out.first_ms === null ? t.first_ms : Math.min(out.first_ms, t.first_ms);
    if (t.last_ms) out.last_ms = out.last_ms === null ? t.last_ms : Math.max(out.last_ms, t.last_ms);
    if (d.result !== "ok") {
      out.errors++;
      out.errorKinds.set(d.result, (out.errorKinds.get(d.result) || 0) + 1);
      continue;
    }
    out.ok++;
    out.okOccurrences += n;
    const text = d.text || "(empty)";
    if (!out.latest || (t.last_ms || 0) >= out.latest.last_ms) out.latest = { line: t.line, text, last_ms: t.last_ms || 0, fields: d.fields };
    let v = out.values.get(text);
    if (!v) {
      if (out.values.size >= MAX_VALUES) { out.truncated = true; v = null; } else out.values.set(text, (v = { text, n: 0, distinct: 0, first_ms: t.first_ms, last_ms: t.last_ms }));
    }
    if (v) { v.n += n; v.distinct++; v.last_ms = Math.max(v.last_ms || 0, t.last_ms || 0); }
    for (const [name, value] of Object.entries(d.fields || {})) {
      let f = out.fields.get(name);
      if (!f) out.fields.set(name, (f = { name, numeric: true, min: Infinity, max: -Infinity, values: new Map() }));
      if (typeof value === "number" && Number.isFinite(value)) { f.min = Math.min(f.min, value); f.max = Math.max(f.max, value); } else f.numeric = false;
      if (f.values.size < MAX_VALUES || f.values.has(String(value))) f.values.set(String(value), (f.values.get(String(value)) || 0) + Math.max(1, n));
    }
  }
  return out;
}

/** One line per field: the range of numbers, or the most frequent values. */
export function summarizeFields(cov, limit = 6) {
  return [...cov.fields.values()].map((f) => {
    if (f.numeric && f.min <= f.max) return { name: f.name, kind: "range", min: f.min, max: f.max, distinct: f.values.size };
    const top = [...f.values.entries()].sort((a, b) => b[1] - a[1]);
    return { name: f.name, kind: "values", distinct: f.values.size, top: top.slice(0, limit) };
  });
}

/** Why a candidate is not what ebusd uses for the message. */
export function whyNot(def, scan, errorKinds = null, used = null) {
  const s = scan?.[def.zz];
  const file = def.file.replace(/^.*\//, "");
  switch (def.status) {
    case "active":
      return "ebusd uses this definition.";
    case "pending":
      return "Not checked with ebusd's library yet.";
    case "variant":
      return `${file} is only loaded for another device variant. ${s
        ? `Device ${def.zz} identifies as ${s.manufacturer} ${s.ident} (SW ${s.sw}, HW ${s.hw}), for which ebusd loads ${s.file ? s.file.replace(/^.*\//, "") : "no device file"}.`
        : `No identification of device ${def.zz} was recorded, so ebusd would load no device file for it.`}`;
    case "conditional": {
      const needs = describeConditions(def);
      return `Its condition ${def.condition} was not met by the recorded telegrams${needs ? `: it applies only when ${needs}` : ""}.`;
    }
    case "hidden":
      return `ebusd loads this file, but finds ${used ? `${used.circuit} ${used.name} (${accessKind(used)}) from ${used.file.replace(/^.*\//, "")}` : "another definition"} first for the same address and message ID.`;
    case "error":
      return def.error ? `ebusd's library rejects this line: ${def.error}.` : `It does not decode the recorded telegrams${errorKinds?.size ? ` (${[...errorKinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")})` : ""}.`;
    case "companion":
      return "Not seen on the bus: the counterpart of a definition that was.";
    case "custom":
      return "A definition of your own: never ebusd's choice by itself, picked by you.";
    default:
      return "";
  }
}

const rangeText = (value) => {
  if (!Array.isArray(value) || !value.length) return "";
  const [lo, hi] = value;
  if (value.length === 2 && hi >= 4294967295) return `≥ ${lo}`;
  if (value.length === 2 && lo !== hi) return `${lo}…${hi}`;
  return value.length === 1 || lo === hi ? `= ${lo}` : value.join("/");
};

/** A definition's condition in words: "ehp HeatPumpType type = 3 and the device identification SW ≥ 413" (empty without one). */
export function describeConditions(def) {
  return (def.conditions || []).map((c) => (c.message === "scan" || c.circuit === "scan"
    ? `the device identification ${c.field || c.name} ${rangeText(c.value)}`
    : `${c.circuit ? c.circuit + " " : ""}${c.message}${c.field ? " " + c.field : ""} ${rangeText(c.value)}`).trim()).join(" and ");
}

/** The page of a source: a pull request on GitHub, the repository for release and next, nothing for your own lines. */
export function sourceUrl(id, info = null) {
  if (info?.url) return info.url;
  const pr = /^pr\/(\d+)$/.exec(id || "");
  if (pr) return `https://github.com/john30/ebusd-configuration/pull/${pr[1]}`;
  if (id === "release") return "https://github.com/john30/ebusd-configuration/releases";
  if (id === "next") return "https://github.com/john30/ebusd-configuration";
  return null;
}

/** A device as a pull request comment would name it: "VWZIO HW5103 SW 0432 (76)", the scan's software version included. */
export function deviceLabel(addr, { devices = {}, own = "31" } = {}) {
  const a = typeof addr === "number" ? addr : parseInt(addr, 16);
  if (Number.isNaN(a)) return "";
  const hex = a.toString(16).padStart(2, "0");
  const name = addressName(a, { devices, own });
  const scan = devices[hex] || (slaveOf(a) !== null ? devices[slaveOf(a).toString(16).padStart(2, "0")] : null);
  return `${name}${scan?.sw ? ` SW ${scan.sw}` : ""} (${hex})`;
}

const count = (n) => Number(n || 0).toLocaleString("en-US");
const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/**
 * One sentence about a definition on this bus, to paste into a pull request: what it decodes of the message's
 * recorded telegrams, between which devices (with their software versions), over which days.
 * @param row the list's row: {zz, senders: Map(qq -> n), n}; cov from coverage(); devices from the core's devices()
 */
export function summaryText({ def, cov, row, devices = {}, own = "31", sourceLabel = "", pending = false }) {
  const name = `${def.circuit} ${def.name}`;
  const file = (def.file || "").replace(/^.*\//, "");
  const where = `${name} (${[sourceLabel || def.sourceLabel || def.source, file].filter(Boolean).join(", ")})`;
  const senders = [...(row?.senders?.entries?.() || [])].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([qq]) => deviceLabel(qq, { devices, own }));
  const to = row?.zz === "fe" ? "as a broadcast" : row?.zz ? `& ${deviceLabel(row.zz, { devices, own })}` : "";
  const on = senders.length ? ` on ${senders.join(" and ")}${to ? ` ${to}` : ""}` : "";
  const span = cov?.first_ms && cov?.last_ms ? `, recorded ${day(cov.first_ms)}${day(cov.last_ms) !== day(cov.first_ms) ? ` – ${day(cov.last_ms)}` : ""}` : "";
  if (def.error) return `${where}: ebusd rejects this line: ${def.error}`;
  if (def.nomatch) return `${where}: the fields need more bytes than the telegram has`;
  if (!cov || (pending && !cov.decoded)) return `${where}: being checked against ${count(cov?.telegrams)} distinct telegrams`;
  const total = cov.telegrams || cov.distinct + cov.pending;
  const kinds = cov.errorKinds?.size ? ` (${[...cov.errorKinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")})` : "";
  const checked = cov.pending ? `, ${count(cov.pending)} of ${count(total)} still to check` : "";
  if (cov.errors) return `${where}: decodes ${count(cov.ok)} of ${count(cov.distinct)} distinct telegrams (${count(cov.occurrences)} recorded), fails on ${count(cov.errors)}${kinds}${on}${checked}${span}`;
  return `${where}: decodes all ${count(cov.ok)} of ${count(cov.pending ? cov.distinct : total)} distinct telegrams (${count(cov.occurrences)} recorded)${on}${checked}${span}`;
}
