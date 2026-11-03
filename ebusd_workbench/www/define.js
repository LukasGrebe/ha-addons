// Defining a message from the recording: a definition prefilled with what the telegrams of a
// message tell (type, circuit, address, command, ID, the data bytes) and the CSV line for ebusd.
// A new definition starts as one raw HEX field per part; the inspector carves it into fields,
// with the types of ebusd in plain words (types.js).

const hex2 = (n) => n.toString(16).padStart(2, "0");

/** The number types of ebusd (code -> {len, name, label, decode}), the raw types, and a type's plain words: see types.js. */
export { NUMBER_TYPES as TYPES, RAW_TYPES, typeInfo, interpretations } from "./types.js";
import { NUMBER_TYPES } from "./types.js";

export const hexToBytes = (hex) => Uint8Array.from((hex || "").match(/../g) || [], (h) => parseInt(h, 16));

/** Whether an eBUS address is a master address (the 25 combinations of priority class and sub address). */
export function isMasterAddress(a) {
  const ok = [0x0, 0x1, 0x3, 0x7, 0xf];
  return ok.includes(a & 0x0f) && ok.includes(a >> 4);
}

/** The data bytes of the telegrams of a row by part: m = master data after the ID, s = the answer. */
export function samplesOf(telegrams, idBytes) {
  return telegrams.filter((t) => t.master).map((t) => ({
    line: t.line, n: t.n || 1, first_ms: t.first_ms, last_ms: t.last_ms,
    m: hexToBytes(t.master.slice(10 + idBytes * 2)),
    s: t.slave ? hexToBytes(t.slave.slice(2)) : null,
  }));
}

/** How many bytes a part has (the most frequent length), and how variable each byte is. */
export function analyzeBytes(samples, part) {
  const lengths = new Map();
  for (const s of samples) if (s[part]) lengths.set(s[part].length, (lengths.get(s[part].length) || 0) + s.n);
  const len = [...lengths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
  const latest = [...samples].filter((s) => s[part] && s[part].length === len).sort((a, b) => (b.last_ms || 0) - (a.last_ms || 0))[0];
  const bytes = [];
  for (let i = 0; i < len; i++) {
    const seen = new Set();
    let min = 255, max = 0;
    for (const s of samples) {
      if (!s[part] || s[part].length !== len) continue;
      seen.add(s[part][i]); min = Math.min(min, s[part][i]); max = Math.max(max, s[part][i]);
    }
    bytes.push({ offset: i, distinct: seen.size, min, max, latest: latest ? latest[part][i] : null });
  }
  return { length: len, variants: lengths.size, bytes, latest: latest || null };
}

// -- segments: the fields of a definition tile the data bytes of a part -----------------------------

/** A new part: one raw HEX field over all bytes. */
export function initialSegments(length) {
  return length ? [{ offset: 0, len: length, type: "HEX", name: "", divisor: "", unit: "", comment: "" }] : [];
}

/** Field names that are unique within the part and valid for ebusd. */
export function nameSegments(segments, part) {
  const used = new Map();
  return segments.map((seg, i) => {
    let name = (seg.name || "").trim().replace(/[^A-Za-z0-9_]/g, "_");
    if (!name) name = seg.type === "IGN" ? "ign" : seg.type === "HEX" ? (part === "s" ? "answer" : "data") : `${part === "s" ? "value" : "param"}${seg.offset || ""}`;
    const n = used.get(name) || 0;
    used.set(name, n + 1);
    return { ...seg, name: n ? `${name}_${n}` : name, index: i };
  });
}

const fieldCells = (seg, part) => {
  const type = NUMBER_TYPES[seg.type] ? seg.type : `${seg.type}:${seg.len}`;
  return [seg.name, part, type, seg.divisor || "", seg.unit || "", seg.comment || ""];
};

/** The CSV line of a definition: type,circuit,name,comment,qq,zz,pbsb,id then the fields of both parts. */
export function buildCsv(header, parts) {
  const join = (cells) => cells.map((c) => (/[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",");
  const cells = [header.type, header.circuit, header.name, header.comment || "", header.qq || "", header.zz, header.pbsb, header.id || ""];
  for (const part of ["m", "s"]) {
    const segs = nameSegments(parts[part] || [], part);
    for (const seg of segs) cells.push(...fieldCells(seg, part));
  }
  return join(cells);
}

/** Header defaults for a row from what the telegrams show. */
export function defaultHeader(row, samples, { scan = {}, own = "31" } = {}) {
  const hex = (n) => (n === null || n === undefined ? "" : hex2(n));
  const zz = hex(row.zz), qq = hex(row.qq);
  const hasAnswer = samples.some((s) => s.s && s.s.length > 0);
  const toMaster = row.zz !== null && row.zz !== undefined && (row.zz === 0xfe || isMasterAddress(row.zz));
  const mine = qq === String(own).toLowerCase();
  let type;
  if (toMaster) type = "u";                       // broadcast or between masters: only passively observable
  else if (hasAnswer) type = mine ? "r" : "u";    // answered: polled by ebusd, or seen when another device polls
  else type = mine ? "w" : "uw";                  // acknowledged only: a write
  const ident = scan[zz]?.ident ? scan[zz].ident.toLowerCase().replace(/[0-9]+$/, "") : "";
  const circuit = row.zz === 0xfe ? "broadcast" : ident || (zz ? `dev${zz}` : "dev");
  return { type, circuit, name: "NewMessage", comment: `from the recording: ${qq || "--"} to ${zz || "--"} ${hex(row.pb)}${hex(row.sb)} ${row.id || ""}`.trim(), qq: "", zz, pbsb: `${hex(row.pb)}${hex(row.sb)}`, id: row.id || "" };
}

