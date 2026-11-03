// ebusd's CSV: a line is split and joined as ebusd reads it (double quotes around values with commas).
// No imports: usable in workers and tests.

export function splitCsv(line) {
  const cells = [];
  let cell = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell); cell = ""; } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

export function joinCsv(cells) {
  return cells.map((c) => (/[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",");
}

export const CSV_HEADER = "type,circuit,name,comment,qq,zz,pbsb,id,*name,part,type,divisor/values,unit,comment";
const FIELD_COLUMNS = 8;   // type,circuit,name,comment,qq,zz,pbsb,id then groups of 6 per field
const FIELD_GROUP = 6;

/** The line of a definition as {header, fields}: type,circuit,name,comment,qq,zz,pbsb,id and name,part,type,divisor,unit,comment per field. */
export function parseDefinition(csv) {
  const cells = splitCsv(csv || "");
  const m = /^((?:\[[^\]]*\])*)(.*)$/.exec(cells[0] || "");
  const header = { condition: m[1] || "", type: m[2], circuit: cells[1] || "", name: cells[2] || "", comment: cells[3] || "", qq: cells[4] || "", zz: cells[5] || "", pbsb: cells[6] || "", id: cells[7] || "" };
  const fields = [];
  for (let i = FIELD_COLUMNS; i < cells.length; i += FIELD_GROUP) {
    fields.push({ name: cells[i] || "", part: (cells[i + 1] || "").trim().toLowerCase(), type: cells[i + 2] || "", divisor: cells[i + 3] || "", unit: cells[i + 4] || "", comment: cells[i + 5] || "" });
  }
  return { header, fields };
}

/** The CSV line again (the condition of the header is kept when given). */
export function buildDefinition({ header, fields }) {
  const cells = [`${header.condition || ""}${header.type}`, header.circuit, header.name, header.comment || "", header.qq || "", header.zz || "", header.pbsb, header.id || ""];
  for (const f of fields) cells.push(f.name, f.part, f.type, f.divisor, f.unit, f.comment);
  return joinCsv(cells);
}

/** "HEX:4" -> {code: "HEX", length: "4"}; "D2C" -> {code: "D2C", length: ""}; "STR:*" -> {code: "STR", length: "*"}. */
export function splitType(type) {
  const m = /^([A-Za-z][A-Za-z0-9_]*)(?::(\d+|\*))?$/.exec(type || "");
  return m ? { code: m[1].toUpperCase(), length: m[2] || "" } : { code: "", length: "" };
}

/** FNV-1a of a text as hex: the identity of a definition line. */
export function fnv(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
