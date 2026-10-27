// Comparing the candidate definitions of a timeline row over the whole recording.
//
// The browser store holds every distinct telegram of the recording with its occurrences and, for
// each candidate definition, how it decoded. From that this module derives per candidate how it
// fares over the whole history of the row (not only the visible window), groups candidates that
// are the same definition decoding the same values (a copy in another file or for another
// circuit), and explains why a candidate is not the one ebusd uses.
import { splitCsv } from "./setup.js";

const hex2 = (n) => n.toString(16).padStart(2, "0");
const FIELD_COLUMNS = 8;
const FIELD_GROUP = 6;
const MAX_VALUES = 5000;
const MAX_LINES = 5000;

/**
 * What a definition is, apart from the names and comments chosen for it: access, source and
 * destination, command, ID and for every field its part, type, divisor/values and unit.
 */
export function structuralSignature(csv) {
  const cells = splitCsv(csv || "");
  if (cells.length < FIELD_COLUMNS) return csv || "";
  const head = [cells[0].replace(/^\[[^\]]*\]/, ""), cells[4], cells[5], cells[6], cells[7]];
  const fields = [];
  for (let i = FIELD_COLUMNS; i < cells.length; i += FIELD_GROUP) fields.push([cells[i + 1], cells[i + 2], cells[i + 3], cells[i + 4]].join("/"));
  return `${head.join(",")}|${fields.join("|")}`;
}

/** Names that distinguish definitions with the same structure: circuit, name and field names. */
export function fieldNames(csv) {
  const cells = splitCsv(csv || "");
  const names = [];
  for (let i = FIELD_COLUMNS; i < cells.length; i += FIELD_GROUP) if (cells[i]) names.push(cells[i]);
  return names;
}

/** The recorded telegrams (store records) of a timeline row: same source, destination, command and message ID. */
export function rowTelegrams(decoder, row) {
  const prefix = `${hex2(row.qq)}${hex2(row.zz)}${hex2(row.pb)}${hex2(row.sb)}`;
  const id = row.id || "";
  const out = [];
  for (const t of decoder.telegrams.values()) {
    const master = t.master;
    if (!master || !master.startsWith(prefix) || !master.slice(10).startsWith(id)) continue;
    out.push(t);
    if (out.length >= MAX_LINES) break;
  }
  return out.sort((a, b) => (a.first_ms ?? Infinity) - (b.first_ms ?? Infinity));
}

const fnv = (str, seed) => {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i++) { hash ^= str.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
  return hash.toString(16).padStart(8, "0");
};

const valueList = (d) => (d.fields && Object.keys(d.fields).length ? Object.values(d.fields).map(String) : [d.text || ""]);

/** How a definition decodes the telegrams of a row, over the whole recording. */
export function coverage(decoder, telegrams, defKey) {
  const out = { telegrams: telegrams.length, decoded: 0, distinct: 0, ok: 0, errors: 0, occurrences: 0, okOccurrences: 0, first_ms: null, last_ms: null,
    errorKinds: new Map(), values: new Map(), fields: new Map(), signature: "", truncated: false, latest: null };
  let a = 2166136261, b = 5381;
  for (const t of telegrams) {
    const d = decoder.decodesOf(t.line)?.get(defKey);
    if (!d) continue;
    out.decoded++;
    out.distinct++;
    const n = t.n || 0;
    out.occurrences += n;
    if (t.first_ms !== null && t.first_ms !== undefined) out.first_ms = out.first_ms === null ? t.first_ms : Math.min(out.first_ms, t.first_ms);
    if (t.last_ms) out.last_ms = out.last_ms === null ? t.last_ms : Math.max(out.last_ms, t.last_ms);
    const piece = d.result === "ok" ? valueList(d).join("\u0001") : `!${d.result}`;
    a = parseInt(fnv(piece + "\u0002", a), 16);
    b = parseInt(fnv(piece + "\u0003", b), 16);
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
  out.signature = `${out.ok}/${out.errors}:${a.toString(16)}${b.toString(16)}`;
  return out;
}

/**
 * Group the candidates of a row: the same structure decoding the same values over the whole
 * recording is one group (a definition copied to another file or circuit); candidates that decode
 * none of the row's telegrams form one group at the end.
 * @param candidates [{def, ...}] as returned by decoder.candidatesOf
 * @returns {groups: [{key, members, coverage, writable, readable, names, fieldNames, failed}], total}
 */
export function groupCandidates(decoder, candidates, telegrams, { chosenKey = null, usedKey = null } = {}) {
  const groups = new Map();
  for (const c of candidates) {
    const cov = coverage(decoder, telegrams, c.def.key);
    const failed = cov.ok === 0;
    const key = failed ? "failed" : `${structuralSignature(c.def.csv)}#${cov.signature}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, members: [], coverage: cov, failed }));
    g.members.push({ ...c, coverage: cov });
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.writable = g.members.filter((m) => m.def.write).length;
    g.readable = g.members.length - g.writable;
    g.names = [...new Set(g.members.map((m) => `${m.def.circuit} ${m.def.name}`))];
    const fieldSets = g.members.map((m) => fieldNames(m.def.csv).join(", "));
    g.fieldNames = new Set(fieldSets).size > 1 ? fieldSets : null;   // only when the members name the fields differently
    g.hasChosen = g.members.some((m) => m.def.key === chosenKey);
    g.hasUsed = g.members.some((m) => m.def.key === usedKey);
  }
  out.sort((x, y) => (x.failed - y.failed) || (y.hasChosen - x.hasChosen) || (y.hasUsed - x.hasUsed) || (y.members.length - x.members.length) || (y.coverage.ok - x.coverage.ok));
  return { groups: out, total: candidates.length };
}

/** One line per field: the range of numbers, or the most frequent values. */
export function summarizeFields(cov, limit = 6) {
  return [...cov.fields.values()].map((f) => {
    if (f.numeric && f.min <= f.max) return { name: f.name, kind: "range", min: f.min, max: f.max, distinct: f.values.size };
    const top = [...f.values.entries()].sort((a, b) => b[1] - a[1]);
    return { name: f.name, kind: "values", distinct: f.values.size, top: top.slice(0, limit) };
  });
}

/** Why a candidate is not what ebusd uses for the row. */
export function whyNot(def, scan, errorKinds = null) {
  const s = scan?.[def.zz];
  const file = def.file.replace(/^.*\//, "");
  switch (def.status) {
    case "active":
      return "ebusd uses this definition.";
    case "variant":
      return `${file} is only loaded for another device variant. ${s
        ? `Device ${def.zz} identifies as ${s.manufacturer} ${s.ident} (SW ${s.sw}, HW ${s.hw}), for which ebusd loads ${s.file ? s.file.replace(/^.*\//, "") : "no device file"}.`
        : `No identification of device ${def.zz} was recorded, so ebusd would load no device file for it.`}`;
    case "conditional": {
      const needs = (def.conditions || []).map((c) => (c.message === "scan" || c.circuit === "scan"
        ? `the device identification ${c.field || c.name} ${rangeText(c.value)}`
        : `${c.circuit ? c.circuit + " " : ""}${c.message}${c.field ? " " + c.field : ""} ${rangeText(c.value)}`));
      return `Its condition ${def.condition} was not met by the recorded telegrams${needs.length ? `: it needs ${needs.join(" and ")}` : ""}.`;
    }
    case "hidden":
      return "ebusd loads this file, but another definition for the same address and message ID takes precedence.";
    case "error":
      return `It does not decode the recorded telegrams${errorKinds?.size ? ` (${[...errorKinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")})` : ""}.`;
    case "companion":
      return "Not seen on the bus: the counterpart of a definition that was.";
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
