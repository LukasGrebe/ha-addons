// The data types of ebusd in plain words: what each reads from the bytes, how many bytes it takes,
// its range, the value that means "no value", and what it is typically used for. The table backs
// the type picker of the inspector (the types that fit the bytes under a field, each with the
// value it reads from the telegram and the range over the recording, the most plausible first),
// the legend of abbreviations, and the tooltips. Lengths and markers follow ebusd's datatype.cpp.
//
// No imports of the page: usable in workers and tests.

const hex2 = (n) => n.toString(16).padStart(2, "0");
const pad2 = (n) => String(n).padStart(2, "0");
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
/** Unsigned integer of n bytes, first byte least significant (ebusd's order), or most significant (reversed). */
const uint = (b, n, reversed = false) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[reversed ? i : n - 1 - i]; return v; };
const signed = (v, bits) => (v >= 2 ** (bits - 1) ? v - 2 ** bits : v);
const bcdByte = (ch) => (((ch & 0xf0) > 0x90 || (ch & 0x0f) > 0x09) ? undefined : (ch >> 4) * 10 + (ch & 0x0f));
/** A BCD number of n bytes, first byte least significant unless reversed; undefined when a nibble is not a digit. */
const bcd = (b, n, reversed = false) => { let v = 0; for (let i = 0; i < n; i++) { const d = bcdByte(b[reversed ? i : n - 1 - i]); if (d === undefined) return undefined; v = v * 100 + d; } return v; };
const float32 = (b, reversed) => { const bytes = Uint8Array.from(b.slice(0, 4)); const v = new DataView(bytes.buffer).getFloat32(0, !reversed); return Number.isFinite(v) ? round(v, 5) : null; };

/** A plain integer type: replacement is the raw value that means "no value"; undefined is "cannot be read". */
const number = (n, { signed: sig = false, reversed = false, replacement = null, divisor = 1, max = null, digits = 4 }) => (b) => {
  const raw = uint(b, n, reversed);
  if (replacement !== null && raw === replacement) return null;
  const v = sig ? signed(raw, n * 8) : raw;
  if (max !== null && v > max) return undefined;
  return divisor === 1 ? v : round(v / divisor, digits);
};
const time = (h, m, s = null) => (h > 23 || m > 59 || (s !== null && s > 59) ? undefined : `${pad2(h)}:${pad2(m)}${s === null ? "" : `:${pad2(s)}`}`);
const date = (d, m, y) => (d < 1 || d > 31 || m < 1 || m > 12 ? undefined : `${pad2(d)}.${pad2(m)}.${y < 100 ? 2000 + y : y}`);
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fromDays = (days, epochMs) => { const t = new Date(epochMs + days * 86400_000); return date(t.getUTCDate(), t.getUTCMonth() + 1, t.getUTCFullYear()); };

/**
 * Every type ebusd knows, in the order the picker lists them within a kind. bytes: what it takes (bit types take
 * bits of one byte, raw types n bytes given as :n). decode(bytes) returns the value, null for "no value" (ebusd
 * shows "-"), undefined when the bytes cannot be read that way (ebusd reports an error).
 */
export const TYPES = [
  // whole numbers
  { code: "UCH", bytes: 1, kind: "number", name: "whole number, one byte", meaning: "0 to 254", none: "0xff", uses: "a count, a percentage, a state when given value names", decode: number(1, { replacement: 0xff }) },
  { code: "SCH", bytes: 1, kind: "number", name: "whole number with sign, one byte", meaning: "−127 to 127", none: "0x80", uses: "a small offset or correction", decode: number(1, { signed: true, replacement: 0x80 }) },
  { code: "D1B", bytes: 1, kind: "number", name: "whole number with sign, one byte", meaning: "−127 to 127, the same as SCH", none: "0x80", uses: "an offset", decode: number(1, { signed: true, replacement: 0x80 }) },
  { code: "UIN", bytes: 2, kind: "number", name: "whole number, two bytes", meaning: "0 to 65534, low byte first", none: "0xffff", uses: "a count, minutes, a sensor reading with a divisor", decode: number(2, { replacement: 0xffff }) },
  { code: "SIN", bytes: 2, kind: "number", name: "whole number with sign, two bytes", meaning: "−32767 to 32767, low byte first", none: "0x8000", uses: "a reading with a divisor that can be negative", decode: number(2, { signed: true, replacement: 0x8000 }) },
  { code: "UIR", bytes: 2, kind: "number", name: "whole number, two bytes, high byte first", meaning: "0 to 65534", none: "0xffff", uses: "the same as UIN in the other byte order", decode: number(2, { reversed: true, replacement: 0xffff }) },
  { code: "SIR", bytes: 2, kind: "number", name: "whole number with sign, two bytes, high byte first", meaning: "−32767 to 32767", none: "0x8000", uses: "the same as SIN in the other byte order", decode: number(2, { signed: true, reversed: true, replacement: 0x8000 }) },
  { code: "U3N", bytes: 3, kind: "number", name: "whole number, three bytes", meaning: "0 to 16777214, low byte first", none: "0xffffff", uses: "a large count or total", decode: number(3, { replacement: 0xffffff }) },
  { code: "S3N", bytes: 3, kind: "number", name: "whole number with sign, three bytes", meaning: "−8388607 to 8388607, low byte first", none: "0x800000", uses: "a large signed total", decode: number(3, { signed: true, replacement: 0x800000 }) },
  { code: "U3R", bytes: 3, kind: "number", name: "whole number, three bytes, high byte first", meaning: "0 to 16777214", none: "0xffffff", uses: "U3N in the other byte order", decode: number(3, { reversed: true, replacement: 0xffffff }) },
  { code: "S3R", bytes: 3, kind: "number", name: "whole number with sign, three bytes, high byte first", meaning: "−8388607 to 8388607", none: "0x800000", uses: "S3N in the other byte order", decode: number(3, { signed: true, reversed: true, replacement: 0x800000 }) },
  { code: "ULG", bytes: 4, kind: "number", name: "whole number, four bytes", meaning: "0 to 4294967294, low byte first", none: "0xffffffff", uses: "a total (energy, hours, starts) that only grows", decode: number(4, { replacement: 0xffffffff }) },
  { code: "SLG", bytes: 4, kind: "number", name: "whole number with sign, four bytes", meaning: "−2147483647 to 2147483647, low byte first", none: "0x80000000", uses: "a large signed value", decode: number(4, { signed: true, replacement: 0x80000000 }) },
  { code: "ULR", bytes: 4, kind: "number", name: "whole number, four bytes, high byte first", meaning: "0 to 4294967294", none: "0xffffffff", uses: "ULG in the other byte order", decode: number(4, { reversed: true, replacement: 0xffffffff }) },
  { code: "SLR", bytes: 4, kind: "number", name: "whole number with sign, four bytes, high byte first", meaning: "−2147483647 to 2147483647", none: "0x80000000", uses: "SLG in the other byte order", decode: number(4, { signed: true, reversed: true, replacement: 0x80000000 }) },
  // numbers with decimals
  { code: "D1C", bytes: 1, kind: "decimal", name: "half steps, one byte", meaning: "0.0 to 100.0 in steps of 0.5 (the byte divided by 2)", none: "0xff", uses: "a temperature or percentage without sign", decode: number(1, { replacement: 0xff, divisor: 2, max: 200 }) },
  { code: "D2C", bytes: 2, kind: "decimal", name: "sixteenths, two bytes", meaning: "−2047.9 to 2047.9 in steps of 1/16 (0.0625), low byte first", none: "0x8000", uses: "a temperature (Vaillant's usual choice), a pressure", decode: number(2, { signed: true, replacement: 0x8000, divisor: 16 }) },
  { code: "D2B", bytes: 2, kind: "decimal", name: "256ths, two bytes", meaning: "−127.99 to 127.99 in steps of 1/256, low byte first", none: "0x8000", uses: "a temperature with fine resolution", decode: number(2, { signed: true, replacement: 0x8000, divisor: 256 }) },
  { code: "FLT", bytes: 2, kind: "decimal", name: "thousandths, two bytes", meaning: "−32.767 to 32.767 in steps of 0.001, low byte first", none: "0x8000", uses: "a pressure in bar, a flow, a small factor", decode: number(2, { signed: true, replacement: 0x8000, divisor: 1000 }) },
  { code: "FLR", bytes: 2, kind: "decimal", name: "thousandths, two bytes, high byte first", meaning: "−32.767 to 32.767 in steps of 0.001", none: "0x8000", uses: "FLT in the other byte order", decode: number(2, { signed: true, reversed: true, replacement: 0x8000, divisor: 1000 }) },
  { code: "EXP", bytes: 4, kind: "decimal", name: "floating point, four bytes", meaning: "±3.0e38, IEEE 754 single, low byte first", none: "NaN (0x7fc00000)", uses: "a measured value with decimals that is not a fixed-point number", decode: (b) => float32(b, false) },
  { code: "EXR", bytes: 4, kind: "decimal", name: "floating point, four bytes, high byte first", meaning: "±3.0e38, IEEE 754 single", none: "NaN", uses: "EXP in the other byte order", decode: (b) => float32(b, true) },
  // decimal digits in the bytes (BCD: each half byte one digit)
  { code: "BCD", bytes: 1, kind: "number", name: "two decimal digits in one byte", meaning: "0 to 99, each half byte one digit (0x42 = 42); BCD:2 to BCD:4 for more digits, low byte first", none: "0xff", uses: "a date part, a counter kept in decimal digits", decode: (b) => (b[0] === 0xff ? null : bcd(b, 1)) },
  { code: "PIN", bytes: 2, kind: "number", name: "four decimal digits, two bytes", meaning: "0000 to 9999, high byte first (0x12 0x34 = 1234)", none: "0xffff", uses: "a PIN or code", decode: (b) => (uint(b, 2, true) === 0xffff ? null : bcd(b, 2, true)) },
  { code: "HCD", bytes: 4, kind: "number", name: "decimal digits shown as hex, four bytes", meaning: "0 to 99999999, each byte two digits; HCD:1 to HCD:3 for fewer bytes (rare)", none: "–", uses: "rarely needed", decode: (b) => bcd(b, 4) },
  // bits
  { code: "BI0", bytes: 0, bit: 0, kind: "bits", name: "bit 0 of the byte", meaning: "one bit (BI0:n for n bits from bit 0, up to 7); a field of its own, the byte is shared with following bit fields", none: "–", uses: "an on/off state, a flag", decode: (b) => b[0] & 1 },
  { code: "BI1", bytes: 0, bit: 1, kind: "bits", name: "bit 1 of the byte", meaning: "one bit (BI1:n for n bits from bit 1)", none: "–", uses: "a flag", decode: (b) => (b[0] >> 1) & 1 },
  { code: "BI2", bytes: 0, bit: 2, kind: "bits", name: "bit 2 of the byte", meaning: "one bit (BI2:n for n bits from bit 2)", none: "–", uses: "a flag", decode: (b) => (b[0] >> 2) & 1 },
  { code: "BI3", bytes: 0, bit: 3, kind: "bits", name: "bit 3 of the byte", meaning: "one bit (BI3:n for n bits from bit 3)", none: "–", uses: "a flag", decode: (b) => (b[0] >> 3) & 1 },
  { code: "BI4", bytes: 0, bit: 4, kind: "bits", name: "bit 4 of the byte", meaning: "one bit (BI4:n for n bits from bit 4)", none: "–", uses: "a flag", decode: (b) => (b[0] >> 4) & 1 },
  { code: "BI5", bytes: 0, bit: 5, kind: "bits", name: "bit 5 of the byte", meaning: "one bit (BI5:n for n bits from bit 5)", none: "–", uses: "a flag", decode: (b) => (b[0] >> 5) & 1 },
  { code: "BI6", bytes: 0, bit: 6, kind: "bits", name: "bit 6 of the byte", meaning: "one bit (BI6:n for n bits from bit 6)", none: "–", uses: "a flag", decode: (b) => (b[0] >> 6) & 1 },
  { code: "BI7", bytes: 0, bit: 7, kind: "bits", name: "bit 7 of the byte", meaning: "the highest bit", none: "–", uses: "a flag", decode: (b) => (b[0] >> 7) & 1 },
  // times
  { code: "HTI", bytes: 3, kind: "time", name: "time of day, three bytes", meaning: "hh:mm:ss as plain numbers, hours first", none: "0xff", uses: "a clock", decode: (b) => (b[0] === 0xff ? null : time(b[0], b[1], b[2])) },
  { code: "BTI", bytes: 3, kind: "time", name: "time of day, three bytes, decimal digits", meaning: "hh:mm:ss as decimal digits (BCD), seconds first", none: "0xff", uses: "a clock", decode: (b) => (b[2] === 0xff ? null : time(bcdByte(b[2]) ?? 99, bcdByte(b[1]) ?? 99, bcdByte(b[0]) ?? 99)) },
  { code: "VTI", bytes: 3, kind: "time", name: "time of day, three bytes, seconds first", meaning: "hh:mm:ss as plain numbers, seconds first (Vaillant)", none: "0x63", uses: "a clock", decode: (b) => (b[2] === 0x63 ? null : time(b[2], b[1], b[0])) },
  { code: "HTM", bytes: 2, kind: "time", name: "time, two bytes", meaning: "hh:mm as plain numbers, hours first", none: "0xff", uses: "a switching time", decode: (b) => (b[0] === 0xff ? null : time(b[0], b[1])) },
  { code: "BTM", bytes: 2, kind: "time", name: "time, two bytes, decimal digits", meaning: "hh:mm as decimal digits (BCD), minutes first", none: "0xff", uses: "a switching time", decode: (b) => (b[1] === 0xff ? null : time(bcdByte(b[1]) ?? 99, bcdByte(b[0]) ?? 99)) },
  { code: "VTM", bytes: 2, kind: "time", name: "time, two bytes, minutes first", meaning: "hh:mm as plain numbers, minutes first (Vaillant)", none: "0xff", uses: "a switching time", decode: (b) => (b[1] === 0xff ? null : time(b[1], b[0])) },
  { code: "MIN", bytes: 2, kind: "time", name: "minutes since midnight, two bytes", meaning: "0 to 1439 shown as hh:mm, low byte first", none: "0xffff", uses: "a switching time", decode: (b) => { const v = uint(b, 2); return v === 0xffff ? null : v > 1439 ? undefined : time(Math.floor(v / 60), v % 60); } },
  { code: "TTM", bytes: 1, kind: "time", name: "time in steps of 10 minutes, one byte", meaning: "the byte times 10 minutes, shown as hh:m0", none: "0x90", uses: "a switching time of a weekly program", decode: (b) => (b[0] === 0x90 ? null : b[0] * 10 > 1439 ? undefined : time(Math.floor(b[0] / 6), (b[0] % 6) * 10)) },
  { code: "TTH", bytes: 1, kind: "time", name: "time in half hours, 6 bits", meaning: "the value times 30 minutes", none: "0", uses: "a switching time", decode: (b) => { const v = b[0] & 0x3f; return v === 0 ? null : v * 30 > 1439 ? undefined : time(Math.floor(v / 2), (v % 2) * 30); } },
  { code: "TTQ", bytes: 1, kind: "time", name: "time in quarter hours, 7 bits", meaning: "the value times 15 minutes", none: "0", uses: "a switching time", decode: (b) => { const v = b[0] & 0x7f; return v === 0 ? null : v * 15 > 1439 ? undefined : time(Math.floor(v / 4), (v % 4) * 15); } },
  // dates
  { code: "BDA", bytes: 4, kind: "date", name: "date, four bytes, decimal digits", meaning: "day, month, weekday, year as decimal digits (BCD); BDA:3 without the weekday", none: "0xff", uses: "a date", decode: (b) => (b[0] === 0xff ? null : date(bcdByte(b[0]) ?? 0, bcdByte(b[1]) ?? 0, bcdByte(b[3]) ?? 0)) },
  { code: "HDA", bytes: 4, kind: "date", name: "date, four bytes", meaning: "day, month, weekday, year as plain numbers; HDA:3 without the weekday", none: "0xff", uses: "a date", decode: (b) => (b[0] === 0xff ? null : date(b[0], b[1], b[3])) },
  { code: "BDZ", bytes: 4, kind: "date", name: "date, four bytes, decimal digits, Sunday = 6", meaning: "like BDA with the weekday counted from Monday = 0", none: "0xff", uses: "a date", decode: (b) => (b[0] === 0xff ? null : date(bcdByte(b[0]) ?? 0, bcdByte(b[1]) ?? 0, bcdByte(b[3]) ?? 0)) },
  { code: "DAY", bytes: 2, kind: "date", name: "days since 1900, two bytes", meaning: "the number of days since 1.1.1900, shown as a date", none: "0xff", uses: "a date", decode: (b) => { const v = uint(b, 2); return v === 0xffff ? null : fromDays(v, Date.UTC(1900, 0, 1)); } },
  { code: "DTM", bytes: 4, kind: "datetime", name: "minutes since 2009, four bytes", meaning: "the number of minutes since 1.1.2009, shown as date and time", none: "–", uses: "a timestamp", decode: (b) => { const v = uint(b, 4); const d = fromDays(Math.floor(v / 1440), Date.UTC(2009, 0, 1)); return d === undefined ? undefined : `${d} ${time(Math.floor((v % 1440) / 60), v % 60)}`; } },
  { code: "BDY", bytes: 1, kind: "date", name: "weekday, Monday = 0", meaning: "0 to 6 shown as Mon to Sun", none: "0x07", uses: "the day of a weekly program", decode: (b) => (b[0] === 7 ? null : b[0] > 6 ? undefined : WEEKDAYS[b[0]]) },
  { code: "HDY", bytes: 1, kind: "date", name: "weekday, Monday = 1", meaning: "1 to 7 shown as Mon to Sun", none: "0x00", uses: "the day of a weekly program", decode: (b) => (b[0] === 0 ? null : b[0] > 7 ? undefined : WEEKDAYS[b[0] - 1]) },
  // text and raw bytes
  { code: "STR", bytes: 1, kind: "text", name: "text", meaning: "one character per byte, padded with spaces; STR:n for n bytes, STR:* for the rest", none: "–", uses: "a name, a serial number", decode: (b) => String.fromCharCode(...b.map((c) => (c >= 32 && c < 127 ? c : 46))) },
  { code: "NTS", bytes: 1, kind: "text", name: "text ending with a zero byte", meaning: "like STR, the text ends at the first 0x00; NTS:n for n bytes", none: "–", uses: "a name", decode: (b) => { const end = b.indexOf(0); return String.fromCharCode(...(end < 0 ? b : b.slice(0, end)).map((c) => (c >= 32 && c < 127 ? c : 46))); } },
  { code: "HEX", bytes: 1, kind: "raw", name: "raw bytes", meaning: "shown as hex digits, nothing decoded; HEX:n for n bytes, HEX:* for the rest", none: "–", uses: "bytes not understood yet, to carve into fields", decode: (b) => b.map(hex2).join(" ") },
  { code: "IGN", bytes: 1, kind: "raw", name: "ignored bytes", meaning: "skipped, nothing shown; IGN:n for n bytes, IGN:* for the rest", none: "–", uses: "padding, bytes nobody needs", decode: () => "" },
  { code: "TEM_P", bytes: 2, kind: "number", name: "Vaillant sensor parameter, two bytes", meaning: "a group and an id, shown as 0-0 to 31-255 (rare)", none: "–", uses: "rarely needed", decode: (b) => `${b[1] & 0x1f}-${b[0]}` },
];
export const TYPE_BY_CODE = Object.fromEntries(TYPES.map((t) => [t.code, t]));
/** Types with a value to chart: whole numbers and decimals. */
export const NUMBER_TYPES = Object.fromEntries(TYPES.filter((t) => t.kind === "number" || t.kind === "decimal").map((t) => [t.code, { len: t.bytes, name: t.name, label: `${t.meaning}; ${t.none === "–" ? "no marker for no value" : `${t.none} means no value`}`, decode: t.decode }]));
export const RAW_TYPES = ["HEX", "IGN", "STR", "NTS"];
/** Bytes a type takes as ebusd reads it (0 for a bit field); the length suffix :n of a raw type is handled by the caller. */
export const TYPE_BYTES = Object.fromEntries(TYPES.map((t) => [t.code, t.bytes]));
TYPE_BYTES.NUL = 1;
export const KINDS = { number: "whole numbers", decimal: "numbers with decimals", bits: "bits of a byte", time: "times", date: "dates", datetime: "date and time", text: "text", raw: "raw bytes" };

/** The plain name, the explanation and the CSV shorthand of a type code ("D2C", "HEX"). */
export const typeInfo = (code) => { const t = TYPE_BY_CODE[String(code || "").toUpperCase()]; return t ? { code: t.code, name: t.name, label: t.meaning } : { code, name: code, label: "" }; };

/** Units that are worth a click, and divisors: a positive divisor divides, a negative one multiplies (ebusd's rule). */
export const UNITS = ["°C", "K", "%", "bar", "W", "kW", "kWh", "Wh", "l/min", "l/h", "m³/h", "rpm", "h", "min", "s", "V", "A", "Hz", "ppm"];
export const DIVISORS = [["10", "÷10"], ["100", "÷100"], ["1000", "÷1000"], ["-10", "×10"], ["-100", "×100"]];

/** The raw bytes of a field's position: the data bytes of one part of a telegram sample. */
const sliceOf = (sample, part, offset, len) => { const bytes = sample[part]; return bytes && bytes.length >= offset + len ? Array.from(bytes.slice(offset, offset + len)) : null; };

/**
 * Every type that fits at an offset of a part over the samples (see define.js samplesOf): the value it reads from
 * the latest telegram, the range and the number of distinct values over the recording, how often it reads a value
 * at all, and a hint at what it looks like. Sorted the most plausible first. `available` limits the bytes (the
 * telegram's part from the offset on); bit types are listed for one byte.
 */
export function interpretations(samples, part, offset, { available = Infinity, latestBytes = null } = {}) {
  const out = [];
  const byTime = samples.slice().sort((a, b) => (a.last_ms || 0) - (b.last_ms || 0));
  for (const t of TYPES) {
    if (t.kind === "raw" || t.kind === "text") continue;
    const len = Math.max(1, t.bytes);
    if (len > available) continue;
    let valid = 0, total = 0, none = 0, min = Infinity, max = -Infinity, monotonic = true, previous = null;
    const distinct = new Map();
    let latest = null, latestMs = -1;
    for (const s of byTime) {
      const bytes = sliceOf(s, part, offset, len);
      if (!bytes) continue;
      const weight = s.n || 1;   // a distinct telegram counts as often as it was recorded
      total += weight;
      const v = t.decode(bytes);
      if (v === null) { none += weight; continue; }
      if (v === undefined || (typeof v === "number" && !Number.isFinite(v))) continue;
      valid += weight;
      distinct.set(v, (distinct.get(v) || 0) + (s.n || 1));
      if (typeof v === "number") { if (v < min) min = v; if (v > max) max = v; if (previous !== null && v < previous) monotonic = false; previous = v; }
      if ((s.last_ms || 0) >= latestMs) { latestMs = s.last_ms || 0; latest = v; }
    }
    if (!total) continue;
    const numeric = t.kind === "number" || t.kind === "decimal" || t.kind === "bits";
    const value = latestBytes && latestBytes.length >= offset + len ? t.decode(Array.from(latestBytes.slice(offset, offset + len))) : latest;
    const item = { code: t.code, type: t.code, kind: t.kind, len, bytes: t.bytes, name: t.name, meaning: t.meaning, uses: t.uses, none: t.none,
      value, latest, min: numeric && valid ? min : null, max: numeric && valid ? max : null, distinct: distinct.size, values: distinct, validRatio: valid / total, noneRatio: none / total, monotonic: numeric && monotonic && distinct.size > 2 };
    Object.assign(item, hintOf(item));
    out.push(item);
  }
  const bucket = (i) => (i.validRatio >= 0.999 ? 2 : i.validRatio >= 0.9 ? 1 : 0);
  // the same plausibility: the type that explains more bytes first
  return out.sort((a, b) => bucket(b) - bucket(a) || b.score - a.score || b.len - a.len || a.code.localeCompare(b.code));
}

/** What a reading looks like over the recording, in a few words, and how plausible that makes the type. */
export function hintOf(i) {
  const decimals = i.kind === "decimal";
  if (i.validRatio < 0.5) return { hint: i.noneRatio > 0.5 ? "mostly no value" : "cannot be read that way in most telegrams", score: 0 };
  if (i.kind === "bits") return { hint: i.distinct === 1 ? `always ${i.latest}` : "a flag that changes", score: i.distinct === 1 ? 0.5 : 2 };
  if (i.kind === "date" || i.kind === "datetime") {
    const years = [...i.values.keys()].map((v) => Number(/\.(\d{4})/.exec(String(v))?.[1] || 0));
    if (years.some((y) => y < 2000 || y > 2099)) return { hint: "dates far off: unlikely", score: 0.3 };
  }
  if (i.kind === "time" || i.kind === "date" || i.kind === "datetime") return { hint: i.distinct === 1 ? `always ${i.latest}` : `${i.distinct} different ${i.kind === "time" ? "times" : "dates"}`, score: i.distinct === 1 ? 0.5 : 1.5 };
  if (typeof i.latest !== "number") return { hint: "", score: 1 };
  if (i.distinct === 1) return { hint: `always ${i.latest}`, score: 0.5 };
  const span = i.max - i.min;
  if (decimals && i.min >= -40 && i.max <= 130 && i.distinct >= 4 && span >= 0.5) return { hint: "−40 to 130 with decimals: a temperature?", score: 4 };
  if (!decimals && i.monotonic && i.distinct >= 3) return { hint: "only grows: a counter or a total", score: 3 };
  if (i.len === 1 && i.distinct <= 8 && !decimals) return { hint: `${i.distinct} different values: a state? (make it an enumeration)`, score: 3 };
  if (i.min >= 0 && i.max <= 100 && i.distinct >= 3) return { hint: "0 to 100: a percentage, a level?", score: 3 };
  if (i.min >= 0 && i.max <= 1000) return { hint: "", score: 2 };
  if (Math.abs(i.min) > 1e6 || Math.abs(i.max) > 1e6) return { hint: "very large numbers", score: 0.5 };
  return { hint: "", score: 1 };
}

/** The distinct raw values of one byte (or len bytes, low byte first) at an offset, the most frequent first: [{raw, n}]. */
export function enumValues(samples, part, offset, len = 1) {
  const counts = new Map();
  for (const s of samples) { const bytes = sliceOf(s, part, offset, len); if (bytes) counts.set(uint(bytes, len), (counts.get(uint(bytes, len)) || 0) + (s.n || 1)); }
  return [...counts.entries()].map(([raw, n]) => ({ raw, n })).sort((a, b) => b.n - a.n || a.raw - b.raw);
}

/** Names to start an enumeration from: off/on for 0 and 1, otherwise placeholders to rename. */
export function enumNames(values) {
  const raws = values.map((v) => v.raw);
  const binary = raws.length <= 2 && raws.every((r) => r === 0 || r === 1);
  return Object.fromEntries(raws.map((r) => [r, binary ? (r ? "on" : "off") : `v${r}`]));
}

/** The divisor/values cell of an enumeration: "0=off;1=on", keys in ascending order, names without ; , = or spaces. */
export function enumList(names) {
  return Object.entries(names).map(([k, v]) => [Number(k), String(v).trim().replace(/[;,=\s]+/g, "_") || `v${k}`]).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}=${v}`).join(";");
}

/** The bits of one byte over the samples: for each bit how often it is on (weighted by n) and the total. */
export function bitStats(samples, part, offset) {
  const on = new Array(8).fill(0);
  let total = 0;
  for (const s of samples) { const bytes = sliceOf(s, part, offset, 1); if (!bytes) continue; total += s.n || 1; for (let i = 0; i < 8; i++) if ((bytes[0] >> i) & 1) on[i] += s.n || 1; }
  return { total, on };
}
