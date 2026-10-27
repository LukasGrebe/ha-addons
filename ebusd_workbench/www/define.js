// Defining a message from the recording: a definition prefilled with what the telegrams of a row
// tell (type, circuit, address, command, ID, the data bytes), the possible decodings of every byte
// with their values over the whole history, and the CSV line for ebusd.
//
// The data bytes after the message ID are tiled by segments (the fields of the definition). A
// new definition starts as one HEX field per part; interpreting a byte as a type splits it out.

const hex2 = (n) => n.toString(16).padStart(2, "0");
const s8 = (b) => (b[0] > 127 ? b[0] - 256 : b[0]);
const u16 = (b) => b[0] | (b[1] << 8);
const s16 = (b) => { const v = u16(b); return v > 32767 ? v - 65536 : v; };
const u32 = (b) => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/** The number types of ebusd that decode a fixed number of bytes: null is the value ebusd shows as "-" (replacement value). */
export const TYPES = {
  UCH: { len: 1, label: "unsigned byte", decode: (b) => b[0] },
  SCH: { len: 1, label: "signed byte", decode: s8 },
  D1B: { len: 1, label: "signed byte", decode: (b) => (b[0] === 0x80 ? null : s8(b)) },
  D1C: { len: 1, label: "byte / 2 (0–100 %)", decode: (b) => (b[0] === 0xff ? null : b[0] / 2) },
  UIN: { len: 2, label: "unsigned 16 bit", decode: u16 },
  SIN: { len: 2, label: "signed 16 bit", decode: s16 },
  D2B: { len: 2, label: "signed 16 bit / 256 (temperature)", decode: (b) => (u16(b) === 0x8000 ? null : round(s16(b) / 256, 4)) },
  D2C: { len: 2, label: "signed 16 bit / 16 (temperature)", decode: (b) => (u16(b) === 0x8000 ? null : round(s16(b) / 16, 4)) },
  FLT: { len: 2, label: "signed 16 bit / 1000", decode: (b) => (u16(b) === 0x8000 ? null : round(s16(b) / 1000, 4)) },
  ULG: { len: 4, label: "unsigned 32 bit", decode: u32 },
  SLG: { len: 4, label: "signed 32 bit", decode: (b) => u32(b) | 0 },
  EXP: { len: 4, label: "float", decode: (b) => { const v = new DataView(Uint8Array.from(b.slice(0, 4)).buffer).getFloat32(0, true); return Number.isFinite(v) ? round(v, 5) : null; } },
};
/** Types without a number: raw hex, ignored bytes, text of n bytes. */
export const RAW_TYPES = ["HEX", "IGN", "STR"];

export const hexToBytes = (hex) => Uint8Array.from((hex || "").match(/../g) || [], (h) => parseInt(h, 16));
export const bytesToHex = (bytes) => [...bytes].map(hex2).join("");

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

/** Every number type that fits at an offset: latest value and range over the samples. */
export function interpretations(samples, part, offset) {
  const out = [];
  for (const [type, spec] of Object.entries(TYPES)) {
    let valid = 0, total = 0, min = Infinity, max = -Infinity;
    const distinct = new Set();
    let latest = null, latestMs = -1;
    for (const s of samples) {
      const bytes = s[part];
      if (!bytes || bytes.length < offset + spec.len) continue;
      total++;
      const v = spec.decode(bytes.slice(offset, offset + spec.len));
      if (v === null || !Number.isFinite(v)) continue;
      valid++; min = Math.min(min, v); max = Math.max(max, v); distinct.add(v);
      if ((s.last_ms || 0) >= latestMs) { latestMs = s.last_ms || 0; latest = v; }
    }
    if (!total) continue;
    out.push({ type, len: spec.len, label: spec.label, latest, min: valid ? min : null, max: valid ? max : null, distinct: distinct.size, validRatio: valid / total });
  }
  // most plausible first: valid values, a modest range
  const magnitude = (i) => (i.min === null ? Infinity : Math.max(Math.abs(i.min), Math.abs(i.max)));
  return out.sort((a, b) => b.validRatio - a.validRatio || magnitude(a) - magnitude(b));
}

// -- segments: the fields of a definition tile the data bytes of a part -----------------------------

export const segmentLength = (seg) => (TYPES[seg.type] ? TYPES[seg.type].len : seg.len);

/** A new part: one raw HEX field over all bytes. */
export function initialSegments(length) {
  return length ? [{ offset: 0, len: length, type: "HEX", name: "", divisor: "", unit: "", comment: "" }] : [];
}

/** Give the bytes from offset the type (a number type covers its length, raw types the given length); what is left of overlapped fields stays raw. */
export function applyType(segments, length, offset, type, len = 1) {
  if (offset >= length) return segments;
  const span = TYPES[type] ? TYPES[type].len : Math.max(1, len);
  const end = Math.min(length, offset + span);
  const raw = (o, l) => ({ offset: o, len: l, type: "HEX", name: "", divisor: "", unit: "", comment: "" });
  const out = [];
  for (const seg of segments) {
    const segEnd = seg.offset + seg.len;
    if (segEnd <= offset || seg.offset >= end) { out.push(seg); continue; }
    if (seg.offset < offset) out.push(TYPES[seg.type] ? raw(seg.offset, offset - seg.offset) : { ...seg, len: offset - seg.offset });
    if (segEnd > end) out.push(TYPES[seg.type] ? raw(end, segEnd - end) : { ...seg, offset: end, len: segEnd - end });
  }
  out.push({ offset, len: end - offset, type, name: "", divisor: "", unit: "", comment: "" });
  out.sort((a, b) => a.offset - b.offset);
  // neighbouring raw pieces of the same kind become one field again
  const merged = [];
  for (const seg of out) {
    const prev = merged[merged.length - 1];
    if (prev && !TYPES[prev.type] && prev.type !== "STR" && prev.type === seg.type && prev.name === seg.name && prev.offset + prev.len === seg.offset) prev.len += seg.len;
    else merged.push({ ...seg });
  }
  return merged;
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
  const type = TYPES[seg.type] ? seg.type : `${seg.type}:${seg.len}`;
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

/** The key the decoder gives a definition of the own file, to pick it after it was added. */
export const customKey = (header) => `custom.csv|${header.circuit}|${header.name}|${/w/.test(header.type) ? "w" : ""}${/u/.test(header.type) ? "u" : ""}`;
