// The pool of definition lines: every source (ebusd's release, the upcoming release, every open
// pull request, your own lines) parsed into distinct lines keyed by their content, each with where
// it comes from. A definition is a line of CSV; its origin is a badge. The pool answers which lines
// could decode a telegram (destination, command, message ID, lengths) without ebusd's library, and
// builds the small trees of files ebusd's library decodes a message's candidates with.
//
// No imports of the page: usable in workers and tests.
import { CSV_HEADER, buildDefinition, fnv, joinCsv, parseDefinition, splitCsv, splitType } from "./csv.js";
import { TYPE_BYTES } from "./types.js";

/** How files are read into lines: a parsed pool kept in the store is read again when this changes. */
export const POOL_RULES = "p4";

/** Bytes a data type takes as ebusd reads it (types.js); types with :n take n bytes (bits for BI0..BI7). */
export const TYPE_LEN = TYPE_BYTES;
/** The bytes a type takes as written in a CSV: 0 for a bit field, null for "the rest" (:*). */
export function byteLengthOf(type) {
  const { code, length } = splitType(type);
  if (/^BI[0-7]$/.test(code)) return 0;
  if (length === "*") return null;
  if (length) return Math.max(1, Number(length) || 1);
  return TYPE_LEN[code] ?? null;   // a template name or an unknown type: its length is not known here
}

/**
 * Where the fields of a definition sit: [{name, part, type, divisor, unit, comment, byte, len, bit, bits, code}].
 * Bit fields (BI0..BI7) in ascending order share a byte; a new byte starts at a non-bit field or when the
 * bit index does not grow. A field of unknown length (:*) takes the rest (len null).
 */
export function layoutFields(fields) {
  const pos = { m: 0, s: 0 };
  const bitByte = { m: null, s: null };
  return fields.map((f) => {
    const part = f.part === "m" ? "m" : "s";
    const { code, length } = splitType(f.type);
    const out = { ...f, part, code };
    const bitMatch = /^BI([0-7])$/.exec(code);
    if (bitMatch) {
      const index = Number(bitMatch[1]);
      const bits = Math.max(1, Number(length) || 1);
      let byte;
      if (bitByte[part] && index > bitByte[part].last) byte = bitByte[part].byte;
      else { byte = pos[part]; pos[part] += 1; }
      bitByte[part] = { byte, last: index + bits - 1 };
      Object.assign(out, { byte, len: 1, bit: index, bits });
    } else {
      bitByte[part] = null;
      const len = byteLengthOf(f.type);
      Object.assign(out, { byte: pos[part], len, bit: null, bits: null });
      pos[part] += len === null ? 0 : len;
    }
    return out;
  });
}

/** How many data bytes a part of a definition takes: {bytes, fixed} (fixed false when a field takes the rest). */
export function partLength(fields, part) {
  let bytes = 0, fixed = true;
  for (const f of layoutFields(fields)) {
    if (f.part !== part) continue;
    if (f.len === null) { fixed = false; continue; }
    bytes = Math.max(bytes, f.byte + f.len);
  }
  return { bytes, fixed };
}

const HEADER_LINE = /^#?\s*(\[[^\]]*\])*\s*type\b/i;
const MASTER_NIBBLES = new Set([0x0, 0x1, 0x3, 0x7, 0xf]);
const isMasterAddress = (zz) => { if (!/^[0-9a-f]{2}$/.test(zz)) return false; const a = parseInt(zz, 16); return MASTER_NIBBLES.has(a >> 4) && MASTER_NIBBLES.has(a & 0xf); };
const ADDR_FILE = /(^|\/)([0-9a-f]{2})\.([^./]+)[^/]*\.(csv|inc)$/i;

/**
 * The column layout a file's header line declares: ebusd's files carry a "level" column between circuit
 * and name (# type,circuit,level,name,comment,QQ,ZZ,PBSB,ID,…), the Workbench's own lines do not.
 */
export function layoutOf(headerLine) {
  const cells = splitCsv(String(headerLine || "").replace(/^#\s*/, "")).map((c) => c.trim().toLowerCase().replace(/\s*\(.*$/, ""));
  return { level: cells.indexOf("level") === 2 };
}

/** Without a header line: whether the first definition line has the command in the 8th or the 7th cell. */
export function sniffLayout(text) {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^[#*!]/.test(line)) continue;
    const cells = splitCsv(line.replace(/^(\[[^\]]*\])+/, ""));
    if (/^[0-9a-f]{4}$/i.test((cells[7] || "").trim())) return { level: true };
    if (/^[0-9a-f]{4}$/i.test((cells[6] || "").trim())) return { level: false };
  }
  return { level: true };   // ebusd's files have the level column; the Workbench's own always carry a header
}

/** A line of ebusd's layout (with the level column) as the Workbench's layout (without it). */
export function dropLevel(text) {
  const cells = splitCsv(text);
  if (cells.length < 4) return text;
  cells.splice(2, 1);
  return joinCsv(cells);
}

/**
 * One definition line of a file as a pool line, or null for comments, headers, templates and defaults.
 * zz and circuit left empty in the line come from the file name (08.hmu.csv: device 08, circuit hmu), as ebusd fills them.
 * @param layout {level}: whether the line has ebusd's level column (see layoutOf)
 * @returns {csv, hash, type, write, passive, circuit, name, comment, qq, zz, pbsb, id, idlen, chained, condition, fields, m: {bytes, fixed}, s: {bytes, fixed}}
 */
export function parseLine(raw, file = "", layout = { level: false }, context = null) {
  let text = String(raw || "").trim();
  if (!text || text.startsWith("#") || text.startsWith("*") || text.startsWith("!") || HEADER_LINE.test(text)) return null;
  if (layout.level) text = dropLevel(text);
  const { header, fields } = parseDefinition(text);
  const type = (header.type || "").trim().toLowerCase();
  if (!/^[rwu;]+[0-9]?$/.test(type)) return null;
  const pbsb = header.pbsb.trim().toLowerCase();
  if (!/^[0-9a-f]{4}$/.test(pbsb)) return null;
  const m = ADDR_FILE.exec(file);
  const zz = (header.zz.trim().toLowerCase() || context?.zz || (m ? m[2].toLowerCase() : "")).replace(/[^0-9a-f]/g, "").slice(0, 2);
  const circuit = header.circuit.trim() || context?.circuit || (m ? m[3] : "") || file.replace(/^.*\//, "").replace(/\.(csv|inc)$/, "") || "misc";
  const idText = header.id.trim().toLowerCase();
  const chained = idText.includes(";");
  const id = (chained ? idText.split(";")[0] : idText).replace(/[^0-9a-f]/g, "");
  const write = /w/.test(type);
  // a field without a part is in the answer of a read, in the message itself of a write, a broadcast or a message to a master
  const defaultPart = write || zz === "fe" || isMasterAddress(zz) ? "m" : "s";
  for (const f of fields) f.part = f.part === "m" || f.part === "s" ? f.part : defaultPart;
  const complete = buildDefinition({ header: { ...header, zz, circuit }, fields });   // the line with zz, circuit and parts made explicit: its identity
  return {
    csv: complete, hash: fnv(complete), type, write, passive: /u/.test(type), circuit, name: header.name.trim(), comment: header.comment,
    qq: header.qq.trim().toLowerCase(), zz, pbsb, id, idlen: id.length / 2, chained, condition: header.condition || "", fields,
    m: partLength(fields, "m"), s: partLength(fields, "s"),
  };
}

/**
 * Parse the CSV files of a source: {lines: Map(hash -> line), refs: [{hash, file}], defaults: {file: [lines starting with * or !]},
 * scan: {directory: text}, templates: {directory: text}}. Every `scan.csv` (the identification messages, at the
 * root or in a manufacturer's folder) and every `_templates.csv`, by directory ("" for the root), are kept as text
 * for the trees ebusd decodes with.
 */
export function parseFiles(files) {
  const lines = new Map(), refs = [], defaults = {}, templates = {}, scan = {};
  // an included file (bai.0010002315.inc, loaded by 08.bai.csv with !load or !include) belongs to the device file
  // whose circuit it is named after: its lines get that file's destination and circuit, as ebusd gives them
  const contexts = new Map();   // "dir/circuit" -> {zz, circuit}
  for (const file of Object.keys(files || {})) {
    const m = ADDR_FILE.exec(file);
    if (m && /\.csv$/i.test(file)) contexts.set(`${file.slice(0, file.lastIndexOf("/") + 1)}${m[3].toLowerCase()}`, { zz: m[2].toLowerCase(), circuit: m[3] });
  }
  for (const [file, text] of Object.entries(files || {})) {
    if (typeof text !== "string" || !/\.(csv|inc)$/i.test(file)) continue;
    if (/(^|\/)_templates\.csv$/.test(file)) { templates[file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""] = text; continue; }
    if (/(^|\/)scan\.csv$/.test(file)) scan[file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""] = text;
    const headerLine = text.split("\n").find((l) => HEADER_LINE.test(l.trim()));
    const layout = headerLine ? layoutOf(headerLine) : sniffLayout(text);
    const context = /\.inc$/i.test(file) ? contexts.get(`${file.slice(0, file.lastIndexOf("/") + 1)}${file.replace(/^.*\//, "").split(".")[0].toLowerCase()}`) || null : null;
    for (const raw of text.split("\n")) {
      const trimmed = raw.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("!")) { (defaults[file] ||= []).push(layout.level && trimmed.startsWith("*") ? dropLevel(trimmed) : trimmed); continue; }
      const line = parseLine(raw, file, layout, context);
      if (!line) continue;
      if (!lines.has(line.hash)) lines.set(line.hash, line);
      refs.push({ hash: line.hash, file });
    }
  }
  return { lines, refs, defaults, scan, templates };
}

/** The pool: distinct lines, where each one comes from, and an index by destination and command. */
export class Pool {
  constructor() {
    this.lines = new Map();      // hash -> line
    this.refs = new Map();       // hash -> [{source, file}]
    this.sources = new Map();    // source id -> {stamp, hashes: Set, defaults, scan, order}
    this.byCmd = new Map();      // "zzpbsb" -> Set(hash)
    this.anyZz = new Map();      // "pbsb" -> Set(hash) for lines without a destination
    this.version = 0;
  }

  /** Put (or replace) the lines of a source. parsed is what parseFiles returned; order ranks the source for badges and trees. */
  setSource(id, stamp, parsed, order = 99) {
    this.removeSource(id);
    const hashes = new Set();
    for (const { hash, file } of parsed.refs) {
      const line = this.lines.get(hash) || parsed.lines.get(hash);
      if (!line) continue;
      if (!this.lines.has(hash)) {
        this.lines.set(hash, line);
        const key = line.zz ? `${line.zz}${line.pbsb}` : null;
        if (key) { if (!this.byCmd.has(key)) this.byCmd.set(key, new Set()); this.byCmd.get(key).add(hash); }
        else { if (!this.anyZz.has(line.pbsb)) this.anyZz.set(line.pbsb, new Set()); this.anyZz.get(line.pbsb).add(hash); }
      }
      if (!this.refs.has(hash)) this.refs.set(hash, []);
      if (!this.refs.get(hash).some((r) => r.source === id && r.file === file)) this.refs.get(hash).push({ source: id, file });
      hashes.add(hash);
    }
    const templates = typeof parsed.templates === "string" ? { "": parsed.templates } : parsed.templates || {};
    const scan = typeof parsed.scan === "string" ? { "": parsed.scan } : parsed.scan || {};
    this.sources.set(id, { stamp, hashes, defaults: parsed.defaults || {}, scan, templates, order });
    this.version++;
  }

  removeSource(id) {
    const s = this.sources.get(id);
    if (!s) return;
    for (const hash of s.hashes) {
      const refs = (this.refs.get(hash) || []).filter((r) => r.source !== id);
      if (refs.length) { this.refs.set(hash, refs); continue; }
      this.refs.delete(hash);
      const line = this.lines.get(hash);
      this.lines.delete(hash);
      if (line) {
        const set = line.zz ? this.byCmd.get(`${line.zz}${line.pbsb}`) : this.anyZz.get(line.pbsb);
        set?.delete(hash);
      }
    }
    this.sources.delete(id);
    this.version++;
  }

  stampOf(id) { return this.sources.get(id)?.stamp || null; }

  /** The lines that could decode a telegram (ebusd's hex: master, slave): by destination, command, message ID and lengths. */
  matches(master, slave) {
    if (!master || master.length < 10) return [];
    const zz = master.slice(2, 4), pbsb = master.slice(4, 8), qq = master.slice(0, 2), data = master.slice(10);
    const out = [];
    const slaveBytes = slave ? parseInt(slave.slice(0, 2), 16) : null;
    const consider = (set) => {
      if (!set) return;
      for (const hash of set) {
        const l = this.lines.get(hash);
        if (!l || !data.startsWith(l.id) || (l.qq && l.qq !== qq)) continue;
        // ebusd reads as many bytes as the fields need and ignores the rest: a definition shorter than the
        // telegram decodes (the last bytes stay unexplained), one longer than the telegram does not
        const mBytes = data.length / 2 - l.idlen;
        if (mBytes < l.m.bytes) continue;
        if (l.s.bytes > 0 || !l.s.fixed) {
          if (slaveBytes === null || slaveBytes < l.s.bytes) continue;
        }
        out.push(hash);
      }
    };
    consider(this.byCmd.get(`${zz}${pbsb}`));
    consider(this.anyZz.get(pbsb));
    return out;
  }

  /** The longest message ID among the lines that fit a telegram (how many data bytes identify the message), 0 when none fits. */
  idLengthOf(master, slave) {
    let best = 0;
    for (const hash of this.matches(master, slave)) best = Math.max(best, this.lines.get(hash).idlen);
    return best;
  }

  /** The reference to show a line under: the source that ranks first (the release before the next release before a pull request). */
  preferredRef(hash) {
    const refs = this.refs.get(hash) || [];
    return refs.slice().sort((a, b) => (this.sources.get(a.source)?.order ?? 99) - (this.sources.get(b.source)?.order ?? 99))[0] || null;
  }

  /**
   * A small tree of files for ebusd's library: the given lines, every one as a file of its own (never a device
   * file, so ebusd loads all of them) in its source's folder under the directory it came from, with zz and
   * circuit explicit, next to the templates that apply there (the directory's own and those of the directories
   * above it, as ebusd combines them); the scan files (the identification, for conditions) of the first source
   * that has them, in their folders; the root templates of the first source involved at the root.
   * @returns {files, keys: Map("file|circuit|name|w|u" -> hash)}
   */
  treeFor(hashes) {
    const keys = new Map();
    const sources = new Set();
    const files = {};
    let n = 0;
    const slugOf = (id) => id.replace(/[^A-Za-z0-9]+/g, "_");
    const scanFilesUsed = new Set();   // "source|dir": a scan file whose own line is in the tree is not added again
    const dirsUsed = [];               // [source, dir] of every line, in order
    // the templates of a directory and of those between it and the root (the root's own are global, below)
    const placeTemplates = (sourceId, dir) => {
      const folder = `${slugOf(sourceId)}/${dir}/`;
      if (!dir || `${folder}_templates.csv` in files) return;
      const templates = this.sources.get(sourceId)?.templates || {};
      const parts = dir.split("/");
      const applicable = parts.map((_, i) => parts.slice(0, i + 1).join("/")).filter((d) => templates[d]).map((d) => templates[d].trim());
      if (applicable.length) files[`${folder}_templates.csv`] = `${applicable.join("\n")}\n`;
    };
    for (const hash of hashes) {
      const line = this.lines.get(hash);
      const ref = this.preferredRef(hash);
      if (!line || !ref) continue;
      sources.add(ref.source);
      const dir = ref.file.includes("/") ? ref.file.slice(0, ref.file.lastIndexOf("/")) : "";
      const folder = `${slugOf(ref.source)}/${dir ? `${dir}/` : ""}`;
      // one file per line: a line ebusd refuses (a typo, a format of old) takes no other line down with it
      const path = `${folder}line__${ref.file.replace(/^.*\//, "").replace(/\.(csv|inc)$/, "").replace(/[^A-Za-z0-9.]+/g, "_")}__${++n}.csv`;
      files[path] = `${CSV_HEADER}\n${line.csv}\n`;   // complete lines (zz, circuit and parts explicit): the defaults (*) of the original file are not needed
      keys.set(`${path}|${line.circuit}|${line.name}|${line.write ? "w" : ""}${line.passive ? "u" : ""}`, hash);
      placeTemplates(ref.source, dir);
      if (/(^|\/)scan\.csv$/.test(ref.file)) scanFilesUsed.add(`${ref.source}|${dir}`);
      dirsUsed.push([ref.source, dir]);
    }
    // the identification (for conditions): the scan files next to the lines (the line's directory and its source's
    // root), else those of the first source that has any, in their folders (the root's at the root)
    const byOrder = (a, b) => (this.sources.get(a)?.order ?? 99) - (this.sources.get(b)?.order ?? 99);
    const placeScan = (sourceId, dir) => {
      const text = this.sources.get(sourceId)?.scan?.[dir];
      if (!text || scanFilesUsed.has(`${sourceId}|${dir}`)) return false;
      const path = dir ? `${slugOf(sourceId)}/${dir}/scan.csv` : "scan.csv";
      if (!(path in files)) { files[path] = text; placeTemplates(sourceId, dir); }
      return true;
    };
    let placed = false;
    for (const [sourceId, dir] of dirsUsed) { placed = placeScan(sourceId, dir) || placed; placed = placeScan(sourceId, "") || placed; }
    if (!placed) {
      const withScan = [...this.sources.keys()].sort(byOrder).find((id) => Object.keys(this.sources.get(id)?.scan || {}).length);
      if (withScan) for (const dir of Object.keys(this.sources.get(withScan).scan)) placeScan(withScan, dir);
    }
    for (const id of [...sources].sort(byOrder)) {
      const s = this.sources.get(id);
      if (s?.templates?.[""] && !files["_templates.csv"]) files["_templates.csv"] = s.templates[""];
    }
    return { files, keys };
  }
}

/** Decide which pool line a candidate ebusd reported in a synthetic tree is (file, circuit, name, direction). */
export const candidateKey = (c) => `${c.file}|${c.circuit}|${c.name}|${c.write ? "w" : ""}${c.passive ? "u" : ""}`;

export { splitCsv, parseDefinition, buildDefinition, splitType, fnv };
