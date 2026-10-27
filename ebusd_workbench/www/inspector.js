// The inspector of a message: its telegram laid out byte by byte, every definition that fits it
// as a row that carves those bytes into fields (a bit field takes a bit column, a two byte number
// two byte columns), the bytes of one recorded telegram with buttons to step through the
// recording, what every definition decodes from it, and a sparkline per field over the whole
// recording. Definitions are compared by eye: cells where a definition reads the same bytes
// differently are highlighted. A definition of your own is edited in place: name, type, divisor
// and unit per field, or its line as text.
import { app, append, fmt, h, toast } from "./app.js";
import { messageColors } from "./colors.js";
import { accessKind, describeConditions, whyNot } from "./compare.js";
import { buildDefinition, parseDefinition, splitType } from "./definition-edit.js";
import { TYPES } from "./define.js";
import { MINE, mineKey, setup } from "./setup.js";
import { mineLines, removeMine, upsertMine } from "./mine.js";

/** Bytes a data type takes (bits for BI0..BI7); types with :n take n (bytes, or bits for BIx). */
const TYPE_LEN = {
  UCH: 1, SCH: 1, D1B: 1, D1C: 1, BCD: 1, HCD: 1, PIN: 2, UIN: 2, SIN: 2, UIR: 2, SIR: 2, D2B: 2, D2C: 2, FLT: 2, FLR: 2,
  ULG: 4, SLG: 4, ULR: 4, SLR: 4, EXP: 4, EXR: 4, TTM: 1, TTH: 1, TTQ: 1, HTI: 3, BTI: 3, VTI: 3, HTM: 2, BTM: 2, VTM: 2, MIN: 2,
  BDA: 3, HDA: 3, BDZ: 2, DTM: 4, VDA: 3, BDY: 1, HDY: 1, DAY: 2, TEM_P: 2, NTS: 1, STR: 1, HEX: 1, IGN: 1, NUL: 1,
};
const chip = (circuit, name) => { const c = messageColors(circuit, name); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit} ${name}`); };
const hexToBytes = (hex) => (hex || "").match(/../g)?.map((b) => parseInt(b, 16)) || [];

/**
 * Where the fields of a definition sit: [{name, part, type, divisor, unit, comment, byte, len, bit, bits}].
 * Bit fields (BI0..BI7) in ascending order share a byte; a new byte starts at a non-bit field or when the
 * bit index does not grow.
 */
export function layoutFields(csv) {
  const { fields } = parseDefinition(csv);
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
      const len = length ? Math.max(1, Number(length)) : (TYPE_LEN[code] ?? 1);
      Object.assign(out, { byte: pos[part], len, bit: null, bits: null });
      pos[part] += len;
    }
    return out;
  });
}

/** A tiny chart: a line for numbers, dots on lanes for words; points [{ms, value}]. */
export function sparkline(canvas, points, { t0, t1, width = 110, height = 26 } = {}) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!points.length) return;
  const xOf = (ms) => ((ms - t0) / Math.max(1, t1 - t0)) * (width - 2) + 1;
  const numeric = points.every((p) => typeof p.value === "number" && Number.isFinite(p.value));
  if (numeric) {
    let min = Infinity, max = -Infinity;
    for (const p of points) { if (p.value < min) min = p.value; if (p.value > max) max = p.value; }
    if (min === max) { min -= 1; max += 1; }
    const yOf = (v) => height - 2 - ((v - min) / (max - min)) * (height - 4);
    const columns = Math.max(1, Math.floor(width));
    const lo = new Array(columns).fill(Infinity), hi = new Array(columns).fill(-Infinity);
    for (const p of points) { const c = Math.min(columns - 1, Math.max(0, Math.floor(xOf(p.ms)))); lo[c] = Math.min(lo[c], p.value); hi[c] = Math.max(hi[c], p.value); }
    ctx.strokeStyle = "#0b7dda"; ctx.lineWidth = 1; ctx.beginPath();
    let started = false;
    for (let c = 0; c < columns; c++) {
      if (lo[c] === Infinity) continue;
      const y1 = yOf(hi[c]), y2 = yOf(lo[c]);
      if (!started) { ctx.moveTo(c + 0.5, (y1 + y2) / 2); started = true; }
      ctx.lineTo(c + 0.5, y1); ctx.lineTo(c + 0.5, y2);
    }
    ctx.stroke();
  } else {
    const counts = new Map();
    for (const p of points) counts.set(String(p.value), (counts.get(String(p.value)) || 0) + 1);
    const lanes = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v]) => v);
    const laneH = (height - 2) / lanes.length;
    for (const p of points) {
      const lane = lanes.indexOf(String(p.value));
      if (lane < 0) continue;
      ctx.fillStyle = lane === 0 ? "#2e7d32" : lane === 1 ? "#ef6c00" : "#7986cb";
      ctx.fillRect(Math.round(xOf(p.ms)), 1 + laneH * lane + laneH / 2 - 1, 1.5, 2);
    }
  }
}

/** What a byte (and the bytes from it on) could be, as the number types of ebusd read them. */
function readings(bytes, offset, part) {
  const lines = [`${part === "m" ? "request" : "answer"} byte ${offset}: 0x${bytes[offset].toString(16).padStart(2, "0")} = ${bytes[offset]} = ${bytes[offset].toString(2).padStart(8, "0")}b`, "read from here as:"];
  for (const [type, spec] of Object.entries(TYPES)) {
    if (bytes.length < offset + spec.len) continue;
    const v = spec.decode(bytes.slice(offset, offset + spec.len));
    lines.push(`  ${type} (${spec.name}): ${v === null ? "no value" : v}`);
  }
  return lines.join("\n");
}

/**
 * The inspector of a message.
 * @param ctx {row, telegrams, defs: [{def, group}], decoder, view, telegramIndex, selected: {defKey, field},
 *   onTelegram(index), onSelect(defKey, field), onChange(), included: Set, otherKeys, usedKey}
 */
export function inspector(ctx) {
  const { row, telegrams, decoder } = ctx;
  const idBytes = (row.row.id || "").length / 2;
  const sorted = telegrams.slice().sort((a, b) => (b.last_ms || 0) - (a.last_ms || 0));   // newest first
  const index = Math.max(0, Math.min(sorted.length - 1, ctx.telegramIndex || 0));
  const current = sorted[index] || null;
  const bytesOf = (t) => ({ m: hexToBytes((t?.master || "").slice(10 + idBytes * 2)), s: hexToBytes((t?.slave || "").slice(2)) });
  const cur = bytesOf(current);
  // the columns: every byte of each part, a byte split into bits where some definition reads bits
  const layouts = ctx.defs.map((d) => ({ ...d, fields: layoutFields(d.def.csv) }));
  const maxLen = { m: cur.m.length, s: cur.s.length };
  for (const t of sorted.slice(0, 200)) { const b = bytesOf(t); maxLen.m = Math.max(maxLen.m, b.m.length); maxLen.s = Math.max(maxLen.s, b.s.length); }
  for (const l of layouts) for (const f of l.fields) maxLen[f.part] = Math.max(maxLen[f.part], f.byte + f.len);
  const bitBytes = new Set();
  for (const l of layouts) for (const f of l.fields) if (f.bit !== null) bitBytes.add(`${f.part}${f.byte}`);
  const columns = [];   // {part, byte, bit}
  for (const part of ["m", "s"]) for (let byte = 0; byte < maxLen[part]; byte++) {
    if (bitBytes.has(`${part}${byte}`)) for (let bit = 0; bit < 8; bit++) columns.push({ part, byte, bit }); else columns.push({ part, byte, bit: null });
  }
  const colIndex = (part, byte, bit) => columns.findIndex((c) => c.part === part && c.byte === byte && (bit === null ? c.bit === null || c.bit === 0 : c.bit === bit));
  const spanOf = (f) => {
    const start = colIndex(f.part, f.byte, f.bit === null ? null : f.bit);
    if (start < 0) return null;
    if (f.bit !== null) return { start, span: Math.max(1, Math.min(f.bits, 8 - f.bit)) };
    let span = 0;
    for (let b = f.byte; b < f.byte + f.len; b++) span += bitBytes.has(`${f.part}${b}`) ? 8 : 1;
    return { start, span };
  };
  const signature = (f) => `${f.part}|${f.code}${f.bits ? ":" + f.bits : ""}|${f.divisor}|${f.unit}`;
  const pickKey = ctx.defKey ?? row.defKey;   // the definition the message is shown with: your pick, else ebusd's choice, else one of the setup
  const reference = layouts.find((l) => l.def.key === ctx.selected?.defKey) || layouts.find((l) => l.def.key === pickKey) || layouts[0] || null;
  const refSig = new Map();
  if (reference) for (const f of reference.fields) { const s = spanOf(f); if (s) for (let c = s.start; c < s.start + s.span; c++) refSig.set(c, signature(f)); }

  const table = h("table", { class: "inspector" });
  const fixedHead = ["", "QQ ZZ", "PB SB", "ID"];
  // -- header: the byte columns
  const head = h("tr", { class: "cols" }, fixedHead.map((t) => h("th", { class: "fixed" }, t)));
  let i = 0;
  while (i < columns.length) {
    const c = columns[i];
    if (c.bit === null) { head.appendChild(h("th", { class: `byte ${c.part}`, title: `${c.part === "m" ? "request data" : "answer"} byte ${c.byte}` }, `${c.part === "m" ? "req" : "ans"} ${c.byte}`)); i++; }
    else { head.appendChild(h("th", { class: `byte ${c.part} bits`, colspan: 8, title: `${c.part === "m" ? "request data" : "answer"} byte ${c.byte}, read as bits (bit 0 first)` }, `${c.part === "m" ? "req" : "ans"} ${c.byte} · bits 0…7`)); i += 8; }
  }
  table.appendChild(h("thead", {}, head));
  const body = h("tbody");
  table.appendChild(body);
  const fixedCells = (label) => [h("td", { class: "fixed label" }, label), h("td", { class: "fixed mono muted" }, ""), h("td", { class: "fixed mono muted" }, ""), h("td", { class: "fixed mono muted" }, "")];

  // -- one block per definition: its fields, what it decodes from the current telegram, the sparklines
  const sparks = [];   // {canvas, defKey, field}
  for (const l of layouts) {
    const def = l.def, g = l.group;
    const mine = def.source === MINE;
    const isRef = reference && reference.def.key === def.key;
    const chosen = pickKey === def.key;
    const dec = current ? decoder.decodesOf(current.line)?.get(def.key) : null;
    // the row of fields
    const fieldsRow = h("tr", { class: `def ${isRef ? "ref" : ""} ${chosen ? "chosen" : ""}` });
    const nameInput = h("input", { class: "msgname", value: mine ? def.name : setup.exportName(def), title: mine ? "the message name (edits your line)" : `the message name in your config (MQTT topic ebusd/${setup.circuitOf(def)}/…); upstream: ${def.name}`,
      onchange: (e) => { if (mine) { const parsed = parseDefinition(def.csv); parsed.header.name = e.target.value.trim(); e.target.blur(); upsertMine(buildDefinition(parsed), def.key).then(() => ctx.onChange?.()).catch((err) => toast(err.message, "err")); } else setup.rename(def, e.target.value); } });
    const label = h("td", { class: "fixed label", rowspan: mine ? 4 : 3 },
      h("div", { class: "deflabel" },
        h("label", { class: "insetup", title: chosen ? "used for this message and part of your setup" : "use this definition for this message: it joins your setup, the message's other definitions leave it" },
          h("input", { type: "checkbox", checked: ctx.included.has(def.key), onchange: (e) => (e.target.checked ? setup.choose(row.key, def.key, ctx.otherKeys, decoder.entries) : setup.include(def.key, false, decoder.entries)) })),
        chip(def.circuit, def.name),
        h("span", { class: `tbadge ${mine ? "custom" : def.source === "release" ? "" : "src"}` }, mine ? "mine" : def.sourceLabel || def.source),
        g?.members?.length > 1 ? h("span", { class: "tmeta", title: `the same definition in ${g.members.length} files: ${g.members.map((m) => m.def.file.replace(/^.*\//, "")).join(", ")}` }, `×${g.members.length}`) : null,
        def.key === ctx.usedKey ? h("span", { class: "tbadge active", title: "what ebusd uses today" }, "ebusd's choice") : null),
      h("div", { class: "defmeta muted", title: `${def.file}\n${describeConditions(def) ? `only when ${describeConditions(def)}\n` : ""}${def.key === ctx.usedKey ? "ebusd uses this definition today." : whyNot(def, decoder.scan?.[def.source] || {}, null, ctx.usedDef)}` },
        accessKind(def), g?.coverage ? (g.coverage.errors ? h("span", { class: "warn" }, ` · fails on ${g.coverage.errors} of ${g.coverage.distinct}`) : h("span", { class: "ok" }, ` · decodes all ${fmt.count(g.coverage.ok)}`)) : null),
      h("div", { class: "defacts" },
        h("span", { class: "muted" }, "name "), nameInput,
        mine ? h("button", { class: "small", title: "remove this line from your definitions", onclick: async () => { if (confirm(`Remove ${def.circuit} ${def.name} from your definitions?`)) await removeMine(def.key); } }, "remove") : h("button", { class: "small", title: "a copy of your own (mine), to change it freely", onclick: async () => { try { await upsertMine(def.csv); toast(`${def.circuit} ${def.name} copied: the copy (mine) is below`); ctx.onChange?.(); } catch (err) { toast(err.message, "err"); } } }, "copy")));
    fieldsRow.appendChild(label);
    const { header } = parseDefinition(def.csv);
    fieldsRow.appendChild(h("td", { class: "fixed mono muted", title: "source (any) and destination the definition is for" }, `${header.qq || "--"} ${header.zz || "--"}`));
    fieldsRow.appendChild(h("td", { class: "fixed mono muted" }, header.pbsb));
    fieldsRow.appendChild(h("td", { class: "fixed mono muted" }, header.id || ""));
    const valueRow = h("tr", { class: `decoded ${isRef ? "ref" : ""}` });
    const sparkRow = h("tr", { class: `sparks ${isRef ? "ref" : ""}` });
    let col = 0;
    const filler = (upto) => { while (col < upto) { fieldsRow.appendChild(h("td", { class: "gap" })); valueRow.appendChild(h("td", { class: "gap" })); sparkRow.appendChild(h("td", { class: "gap" })); col++; } };
    const parsed = parseDefinition(def.csv);
    for (const f of l.fields.slice().sort((a, b) => (a.part === b.part ? 0 : a.part === "m" ? -1 : 1) || a.byte - b.byte || (a.bit ?? 0) - (b.bit ?? 0))) {
      const s = spanOf(f);
      if (!s || s.start < col) continue;
      filler(s.start);
      const differs = refSig.size > 0 && !isRef && [...Array(s.span).keys()].some((k) => refSig.get(s.start + k) !== signature(f));
      const fieldIndex = parsed.fields.findIndex((x) => x === parsed.fields.find((y) => y.name === f.name && y.part === f.part && y.type === f.type));
      const selected = ctx.selected?.defKey === def.key && ctx.selected?.field === f.name;
      // the name of a source definition's field is renamed for your config; its type, divisor or unit changed makes a copy of your own
      const edit = (key, value, input = null) => {
        if (!mine && key === "name") { setup.renameField(def, f.name, value); return; }
        input?.blur();
        // several edits on a source's row go into the one copy: the second edit builds on the copy the first made
        const copy = mine ? null : mineLines().find((l) => l.key === mineKey(parseDefinition(def.csv).header))?.line;
        const next = parseDefinition(copy || def.csv);
        next.fields[fieldIndex][key] = value.trim();
        upsertMine(buildDefinition(next), mine ? def.key : null).then((k) => { if (!mine) { toast(`a copy of your own with ${f.name} as ${value.trim()}: it is below (mine)`); setup.choose(row.key, k, ctx.otherKeys, decoder.entries); } ctx.onChange?.(); }).catch((err) => toast(err.message, "err"));
      };
      const names = mine ? null : setup.fieldMap(def);
      const cell = h("td", { class: `field ${mine ? "mine" : ""} ${f.bit !== null ? "bitfield" : ""} ${differs ? "diff" : ""} ${selected ? "sel" : ""}`, colspan: s.span, title: `${f.name}: ${f.part === "m" ? "request" : "answer"} ${f.type}${f.divisor ? ` divisor/values ${f.divisor}` : ""}${f.unit ? ` unit ${f.unit}` : ""}${f.comment ? `\n${f.comment}` : ""}\nclick for the chart; edit the name for your config, edit type, divisor or unit for a copy of your own`,
        onclick: (e) => { if (!e.target.closest("input")) ctx.onSelect(def.key, f.name); } },
        h("input", { class: "fname", value: mine ? f.name : (names[f.name] || f.name), title: mine ? "field name" : `field name in your config (upstream: ${f.name})`, onchange: (e) => edit("name", e.target.value, e.target) }),
        h("div", { class: "ftype" }, h("input", { class: "ftypein", value: f.type, title: "type as in the CSV (UCH, D2C, BI0:1, BCD:2, …)", onchange: (e) => edit("type", e.target.value, e.target) }),
          h("input", { class: "fdiv", value: f.divisor, placeholder: "÷/values", title: "divisor (10), factor (-10) or value names (0=off;1=on)", onchange: (e) => edit("divisor", e.target.value, e.target) }),
          h("input", { class: "funit", value: f.unit, placeholder: "unit", title: "unit", onchange: (e) => edit("unit", e.target.value, e.target) })));
      fieldsRow.appendChild(cell);
      const value = dec && dec.result === "ok" && dec.fields && f.name in dec.fields ? dec.fields[f.name] : null;
      valueRow.appendChild(h("td", { class: `value mono ${selected ? "sel" : ""}`, colspan: s.span, onclick: () => ctx.onSelect(def.key, f.name) }, dec ? (dec.result === "ok" ? (value === null || value === undefined ? "–" : `${value}${f.unit && typeof value === "number" ? ` ${f.unit}` : ""}`) : h("span", { class: "err", title: dec.result }, "✗")) : h("span", { class: "muted" }, "…")));
      const canvas = h("canvas", { class: "spark", title: `${f.name} over the whole recording: click for the chart` });
      sparkRow.appendChild(h("td", { class: `spark ${selected ? "sel" : ""}`, colspan: s.span, onclick: () => ctx.onSelect(def.key, f.name) }, canvas));
      sparks.push({ canvas, defKey: def.key, field: f.name });
      col += s.span;
    }
    filler(columns.length);
    valueRow.insertBefore(h("td", { class: "fixed muted rowname", colspan: 3 }, dec ? (dec.result === "ok" ? "decodes" : h("span", { class: "err" }, `does not decode: ${dec.result}`)) : "not decoded yet"), valueRow.firstChild);
    sparkRow.insertBefore(h("td", { class: "fixed muted rowname", colspan: 3 }, "over the recording"), sparkRow.firstChild);
    body.append(fieldsRow, valueRow, sparkRow);
    if (mine) {
      const area = h("textarea", { class: "rawcsv", rows: 2, spellcheck: "false" });
      area.value = def.csv;
      body.appendChild(h("tr", { class: "raw" }, h("td", { class: "fixed muted rowname", colspan: 3 }, "as ebusd reads it"), h("td", { colspan: columns.length }, area,
        h("div", { class: "row" }, h("button", { class: "small primary", onclick: async () => { try { await upsertMine(area.value, def.key); ctx.onChange?.(); } catch (err) { toast(err.message, "err"); } } }, "save line")))));
    }
  }

  // -- the telegram: one recorded telegram, bytes per column, with the buttons to step through the recording
  const telegramRow = h("tr", { class: "telegram" });
  const stepper = h("div", { class: "stepper" },
    h("button", { class: "small", disabled: index >= sorted.length - 1, title: "the previous (older) recorded telegram", onclick: () => ctx.onTelegram(index + 1) }, "◀ older"),
    h("span", { class: "mono muted" }, sorted.length ? `${fmt.count(index + 1)} of ${fmt.count(sorted.length)} distinct` : "no telegram"),
    h("button", { class: "small", disabled: index <= 0, title: "the next (newer) recorded telegram", onclick: () => ctx.onTelegram(index - 1) }, "newer ▶"),
    current ? h("span", { class: "muted", title: current.line }, `${current.n ? `×${fmt.count(current.n)}` : "pasted"} · last ${current.last_ms ? fmt.dateTime(current.last_ms, true) : "?"}`) : null);
  telegramRow.appendChild(h("td", { class: "fixed label" }, h("b", {}, "telegram"), stepper));
  const master = current?.master || "";
  telegramRow.appendChild(h("td", { class: "fixed mono" }, master ? `${master.slice(0, 2)} ${master.slice(2, 4)}` : ""));
  telegramRow.appendChild(h("td", { class: "fixed mono" }, master.slice(4, 8)));
  telegramRow.appendChild(h("td", { class: "fixed mono" }, row.row.id || ""));
  for (const c of columns) {
    const byte = cur[c.part][c.byte];
    if (byte === undefined) { telegramRow.appendChild(h("td", { class: "hex muted" }, c.bit === null ? "··" : "·")); continue; }
    if (c.bit === null) telegramRow.appendChild(h("td", { class: "hex mono", title: readings(cur[c.part], c.byte, c.part) }, byte.toString(16).padStart(2, "0")));
    else telegramRow.appendChild(h("td", { class: `hex bit mono ${(byte >> c.bit) & 1 ? "on" : ""}`, title: `bit ${c.bit} of 0x${byte.toString(16).padStart(2, "0")}` }, String((byte >> c.bit) & 1)));
  }
  body.insertBefore(telegramRow, body.firstChild);
  if (ctx.onNew) {
    body.appendChild(h("tr", { class: "newdef" }, h("td", { class: "fixed label", colspan: 4 },
      h("button", { class: "small primary", title: "a line of your own for this message: one raw field per part, to carve into fields here", onclick: () => ctx.onNew() }, "＋ a definition of your own")),
      h("td", { colspan: columns.length, class: "muted" }, "starts with the bytes as they are; then give the fields a type (the tooltip of a byte in the telegram row says what it could be), a name, a divisor, a unit")));
  }

  const root = h("div", { class: "inspector-wrap" }, table);
  // the sparklines need the recording
  ctx.view.loadSeries(row).then((data) => {
    if (!data || !root.isConnected) return;
    const db = app.status?.db;
    const t0 = db?.first_ms || 0, t1 = (db?.last_ms || 0) + 1000;
    for (const s of sparks) {
      const points = [];
      for (const [ms, li] of data.points) {
        const d = decoder.decodesOf(data.lines[li])?.get(s.defKey);
        if (!d || d.result !== "ok" || !d.fields || !(s.field in d.fields)) continue;
        const v = d.fields[s.field];
        if (v === null || v === undefined) continue;
        points.push({ ms, value: v });
      }
      sparkline(s.canvas, points, { t0, t1 });
    }
  }).catch((err) => console.warn(err));
  return root;
}
