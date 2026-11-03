// The inspector of a message: its telegram laid out byte by byte, every definition that fits it
// as a row that carves those bytes into fields (a bit field takes a bit column, a two byte number
// two byte columns), the bytes of one recorded telegram with buttons to step through the
// recording, what every definition decodes from it, and a sparkline per field over the whole
// recording. Definitions are compared by eye: cells where a definition reads the same bytes
// differently are highlighted. A definition of your own is edited in place: name, type, divisor
// and unit per field, or its line as text; it shows as a row the moment it is saved, marked
// "checking" until ebusd's library has been over the recording with it.
//
// The table is built once; showing another telegram (the stepper, a hover over the chart) only
// repaints the telegram row and the decoded values, so nothing else moves.
import { app, append, fmt, h, toast } from "./app.js";
import { messageColors } from "./colors.js";
import { accessKind, describeConditions, sourceUrl, summaryText, whyNot } from "./compare.js";
import { buildDefinition, parseDefinition, splitType } from "./csv.js";
import { byteLengthOf, layoutFields, parseLine, partLength } from "./pool.js";
import { TYPES } from "./define.js";
import { addressName, commandInfo, describeAddress, describeCommand } from "./ebus-spec.js";
import { MINE, setup } from "./setup.js";
import { identityOf, mineLines, removeMine, upsertMine } from "./mine.js";
import { closeTypePicker, openTypePicker } from "./typepick.js";

const chip = (circuit, name) => { const c = messageColors(circuit, name); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit} ${name}`); };
const hexToBytes = (hex) => (hex || "").match(/../g)?.map((b) => parseInt(b, 16)) || [];
/** The pill of a source: a link to the pull request on GitHub (its discussion), the repository for release and next. */
export const sourceBadge = (id) => {
  const info = app.decoder.source(id);
  const label = id === MINE ? "mine" : info?.label || id;
  const cls = `tbadge ${id === MINE ? "custom" : id === "release" ? "" : "src"}`;
  const url = id === MINE ? null : sourceUrl(id, info);
  if (!url) return h("span", { class: cls, title: `from ${label}` }, label);
  return h("a", { class: cls, href: url, target: "_blank", rel: "noopener", title: `${info?.title ? `${info.title}\n` : ""}open ${label} on GitHub`, onclick: (e) => e.stopPropagation() }, label);
};
/** Copy a text, or select it where the clipboard is not allowed. */
function copyText(text, el) {
  const select = () => { try { const range = document.createRange(); range.selectNodeContents(el); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); toast("selected: copy it with ⌘C / Ctrl+C", "info", 2500); } catch { /* ignore */ } };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast("summary copied", "ok", 1500)).catch(select);
  else select();
}
export { byteLengthOf, layoutFields };

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

/** A field name that is not taken yet: name2, name3, … */
function freeName(fields, base) {
  const taken = new Set(fields.map((f) => f.name));
  let n = 2, name = `${base}${n}`;
  while (taken.has(name)) name = `${base}${++n}`;
  return name;
}

/**
 * The inspector of a message. Returns the element with showTelegram(index), index() and markSelected(defKey, field).
 * @param ctx {row, telegrams, defs: [{def, coverage}], decoder, view, telegramIndex, selected: {defKey, field}, picker: {defKey, field},
 *   onTelegram(index), onSelect(defKey, field), onPicker(picker), onChange(), onNew(), included: Set, otherKeys, usedKey, usedDef, defKey}
 */
export function inspector(ctx) {
  const { row, telegrams, decoder } = ctx;
  const idBytes = (row.row.id || "").length / 2;
  const devices = decoder.devices(), own = app.settings?.own_address || "31";
  const nameOf = (addr) => addressName(addr, { devices, own });
  const sorted = telegrams.slice().sort((a, b) => (b.last_ms || 0) - (a.last_ms || 0));   // newest first
  let index = Math.max(0, Math.min(sorted.length - 1, ctx.telegramIndex || 0));
  const bytesOf = (t) => ({ m: hexToBytes((t?.master || "").slice(10 + idBytes * 2)), s: hexToBytes((t?.slave || "").slice(2)) });
  const lines = mineLines();
  // the type picker: closed while the table is rebuilt, opened again for the same field below
  closeTypePicker({ silent: true });
  const pickers = new Map();
  let samplesCache = null;
  const samples = () => (samplesCache ??= sorted.slice(0, 400).map((t) => ({ n: t.n || 1, last_ms: t.last_ms, ...bytesOf(t) })));
  // the columns: every byte of each part, a byte split into bits where some definition reads bits
  const layouts = ctx.defs.map((d) => ({ ...d, csv: d.def.csv, fields: layoutFields(parseDefinition(d.def.csv).fields).filter((f) => f.len !== 0 || f.bit !== null) }));
  const maxLen = { m: 0, s: 0 };
  for (const t of sorted.slice(0, 200)) { const b = bytesOf(t); maxLen.m = Math.max(maxLen.m, b.m.length); maxLen.s = Math.max(maxLen.s, b.s.length); }
  for (const l of layouts) for (const f of l.fields) maxLen[f.part] = Math.max(maxLen[f.part], f.byte + (f.len ?? 1));
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
    const len = f.len === null ? Math.max(1, maxLen[f.part] - f.byte) : f.len;   // a field that takes the rest
    let span = 0;
    for (let b = f.byte; b < f.byte + len; b++) span += bitBytes.has(`${f.part}${b}`) ? 8 : 1;
    return { start, span };
  };
  const signature = (f) => `${f.part}|${f.code}${f.bits ? ":" + f.bits : ""}|${f.divisor}|${f.unit}`;
  const pickKey = ctx.defKey ?? row.defKey;   // the definition the message is shown with: your pick, else ebusd's choice, else one of the setup
  const reference = layouts.find((l) => l.def.key === ctx.selected?.defKey) || layouts.find((l) => l.def.key === pickKey) || layouts[0] || null;
  const refSig = new Map();
  if (reference) for (const f of reference.fields) { const s = spanOf(f); if (s) for (let c = s.start; c < s.start + s.span; c++) refSig.set(c, signature(f)); }

  const table = h("table", { class: "inspector" });
  const fixedHead = [["", ""], ["QQ ZZ", "source and destination address"], ["PB SB", "primary and secondary command byte"],
    ["ID", `message ID: the first ${idBytes} data byte${idBytes === 1 ? "" : "s"}, as many as the fitting definitions use to tell this message from its siblings (1 when nothing fits)`]];
  // -- header: the byte columns
  const head = h("tr", { class: "cols" }, fixedHead.map(([t, title]) => h("th", { class: "fixed", title }, t)));
  let i = 0;
  while (i < columns.length) {
    const c = columns[i];
    if (c.bit === null) { head.appendChild(h("th", { class: `byte ${c.part}`, title: `${c.part === "m" ? "request data" : "answer"} byte ${c.byte}` }, `${c.part === "m" ? "req" : "ans"} ${c.byte}`)); i++; }
    else { head.appendChild(h("th", { class: `byte ${c.part} bits`, colspan: 8, title: `${c.part === "m" ? "request data" : "answer"} byte ${c.byte}, read as bits (bit 0 first)` }, `${c.part === "m" ? "req" : "ans"} ${c.byte} · bits 0…7`)); i += 8; }
  }
  table.appendChild(h("thead", {}, head));
  const body = h("tbody");
  table.appendChild(body);

  // -- one block per definition: its fields, what it decodes from the current telegram, the sparklines
  const sparks = [];        // {canvas, defKey, field}
  const defCells = [];      // {defKey, pending, label: td, cells: [{field, unit, td}]} repainted per telegram
  const fieldCells = new Map();   // "defKey|field" -> [td] to mark the selected field
  for (const l of layouts) {
    const def = l.def, cov = l.coverage, csv = l.csv;
    const mine = def.sources?.includes(MINE) || def.source === MINE;
    const pending = !!cov && cov.decoded === 0 && cov.pending > 0 && !def.error;
    const isRef = reference && reference.def.key === def.key;
    const chosen = pickKey === def.key;
    const parsed = parseDefinition(csv);
    // the row of fields
    const fieldsRow = h("tr", { class: `def ${isRef ? "ref" : ""} ${chosen ? "chosen" : ""} ${pending ? "pending" : ""}` });
    const nameInput = h("input", { class: "msgname", value: mine ? parsed.header.name : setup.exportName(def), title: mine ? "the message name (edits your line)" : `the message name in your config (MQTT topic ebusd/${setup.circuitOf(def)}/…); upstream: ${def.name}`,
      onchange: (e) => { if (mine) { const next = parseDefinition(csv); next.header.name = e.target.value.trim(); e.target.blur(); upsertMine(buildDefinition(next), def.key).then(() => ctx.onChange?.()).catch((err) => toast(err.message, "err")); } else setup.rename(def, e.target.value); } });
    // one sentence about the definition on this bus, to copy into a pull request: what it decodes, between which devices
    const summaryLine = () => {
      const text = summaryText({ def, cov, row, devices, own, sourceLabel: def.sourceLabel || decoder.source(def.source)?.label || def.source, pending });
      const cls = def.error || def.nomatch ? "err" : pending && !cov?.decoded ? "muted" : cov?.errors ? "warn" : "ok";
      const why = pending ? "being checked against every recorded telegram of this message" : `${def.file}\n${describeConditions(def) ? `only when ${describeConditions(def)}\n` : ""}${def.key === ctx.usedKey ? "ebusd uses this definition today." : whyNot(def, decoder.scanOf(def.source) || {}, null, ctx.usedDef)}`;
      const span = h("span", { class: `summary ${cls}`, title: `click to copy this summary (for a pull request comment)\n\n${why}`, onclick: (e) => { e.stopPropagation(); copyText(text, span); } }, text);
      return h("div", { class: "defmeta muted" }, accessKind(def), " · ", pending && !cov?.decoded ? h("span", { class: "spinner" }) : null, span);
    };
    const label = h("td", { class: "fixed label", rowspan: mine ? 4 : 3 },
      h("div", { class: "deflabel" },
        h("label", { class: "insetup", title: chosen ? "used for this message and part of your setup" : "use this definition for this message: it joins your setup, the message's other definitions leave it" },
          h("input", { type: "checkbox", checked: ctx.included.has(def.key), onchange: (e) => (e.target.checked ? setup.choose(row.key, def.key, ctx.otherKeys, decoder.entries) : setup.include(def.key, false, decoder.entries)) })),
        chip(def.circuit, def.name),
        (def.sources || [def.source]).slice(0, 3).map((id) => sourceBadge(id)),
        (def.sources || []).length > 3 ? h("span", { class: "tmeta", title: def.sources.map((id) => app.decoder.source(id)?.label || id).join(", ") }, `+${def.sources.length - 3}`) : null,
        def.refs?.length > 1 ? h("span", { class: "tmeta", title: `the same line in ${def.refs.length} places: ${def.refs.map((r) => `${app.decoder.source(r.source)?.label || r.source}: ${r.file.replace(/^.*\//, "")}`).join(", ")}` }, `×${def.refs.length}`) : null,
        def.key === ctx.usedKey ? h("span", { class: "tbadge active", title: "what ebusd uses today" }, "ebusd's choice") : null),
      summaryLine(),
      h("div", { class: "defacts" },
        h("span", { class: "muted" }, "name "), nameInput,
        mine ? h("button", { class: "small", title: "remove this line from your definitions", onclick: async () => { if (confirm(`Remove ${def.circuit} ${def.name} from your definitions?`)) await removeMine(def.key); } }, "remove") : h("button", { class: "small", title: "a copy of your own (mine), to change it freely", onclick: async () => { try { await upsertMine(def.csv); toast(`${def.circuit} ${def.name} copied: the copy (mine) is below`); ctx.onChange?.(); } catch (err) { toast(err.message, "err"); } } }, "edit a copy")));
    fieldsRow.appendChild(label);
    const { header } = parsed;
    fieldsRow.appendChild(h("td", { class: "fixed mono muted", title: `source (any) and destination the definition is for${header.zz ? `: ${nameOf(header.zz)}` : ""}` }, `${header.qq || "--"} ${header.zz || "--"}`));
    fieldsRow.appendChild(h("td", { class: "fixed mono muted" }, header.pbsb));
    fieldsRow.appendChild(h("td", { class: "fixed mono muted" }, header.id || ""));
    const valueRow = h("tr", { class: `decoded ${isRef ? "ref" : ""}` });
    const sparkRow = h("tr", { class: `sparks ${isRef ? "ref" : ""}` });
    const block = { defKey: def.key, pending, label: h("td", { class: "fixed muted rowname", colspan: 3 }), cells: [] };
    defCells.push(block);
    let col = 0;
    const filler = (upto) => { while (col < upto) { fieldsRow.appendChild(h("td", { class: "gap" })); valueRow.appendChild(h("td", { class: "gap" })); sparkRow.appendChild(h("td", { class: "gap" })); col++; } };
    for (const f of l.fields.slice().sort((a, b) => (a.part === b.part ? 0 : a.part === "m" ? -1 : 1) || a.byte - b.byte || (a.bit ?? 0) - (b.bit ?? 0))) {
      const s = spanOf(f);
      if (!s || s.start < col) continue;
      filler(s.start);
      const differs = refSig.size > 0 && !isRef && [...Array(s.span).keys()].some((k) => refSig.get(s.start + k) !== signature(f));
      const fieldIndex = parsed.fields.findIndex((x) => x === parsed.fields.find((y) => y.name === f.name && y.part === f.part && y.type === f.type));
      const selected = ctx.selected?.defKey === def.key && ctx.selected?.field === f.name;
      // the name of a source definition's field is renamed for your config; its type, divisor or unit changed makes a copy of your own
      const edit = (changes, input = null) => {
        const keys = Object.keys(changes);
        if (!mine && keys.length === 1 && keys[0] === "name") { setup.renameField(def, f.name, changes.name); return; }
        input?.blur();
        // several edits on a source's row go into the one copy: the second edit builds on the copy the first made
        const copy = mine ? null : lines.find((x) => identityOf(x.parsed) === identityOf(parseLine(def.csv, "mine/x.csv")))?.line;
        const next = parseDefinition(copy || csv);
        const target = next.fields[fieldIndex];
        if (!target) return;
        for (const [key, value] of Object.entries(changes)) target[key] = String(value).trim();
        // a field made shorter leaves bytes of the telegram behind: they become a raw field of their own, to be carved
        // further; a field made longer takes them from the raw fields that follow it
        if ("type" in changes && f.bit === null) {
          const { bytes, fixed } = partLength(next.fields, target.part);
          const have = bytesOf(sorted[index])[target.part].length;   // the telegram shown right now
          if (fixed && bytes < have) next.fields.splice(fieldIndex + 1, 0, { name: freeName(next.fields, target.name || "field"), part: target.part, type: `HEX:${have - bytes}`, divisor: "", unit: "", comment: "" });
          else if (fixed && bytes > have) {
            let excess = bytes - have;
            for (let i = fieldIndex + 1; i < next.fields.length && excess > 0; i++) {
              const g = next.fields[i];
              if (g.part !== target.part) continue;
              const { code } = splitType(g.type);
              if (!["HEX", "IGN", "STR"].includes(code)) break;
              const len = byteLengthOf(g.type) || 0;
              if (len <= excess) { excess -= len; next.fields.splice(i, 1); i--; } else { g.type = `${code}:${len - excess}`; excess = 0; }
            }
          }
        }
        const said = Object.entries(changes).map(([k, v]) => `${k} ${String(v).trim() || "empty"}`).join(", ");
        return upsertMine(buildDefinition(next), mine ? def.key : null).then((k) => {
          if (!mine) {
            toast(`a copy of your own with ${f.name}: ${said}; it is below (mine)`);
            setup.choose(row.key, k, ctx.otherKeys, decoder.entries);
          }
          // the line's key is its content: the picker follows the field to the changed line (or to the copy)
          if (ctx.picker?.defKey === def.key && ctx.picker?.field === f.name) ctx.onPicker?.({ defKey: k, field: String(changes.name ?? f.name).trim() || f.name });
          ctx.onChange?.();
        }).catch((err) => toast(err.message, "err"));
      };
      // the picker: the types that fit the bytes from this field on, with what each reads from the telegram shown
      const pick = () => {
        if (f.bit !== null) return;
        ctx.onPicker?.({ defKey: def.key, field: f.name });
        const cur = bytesOf(sorted[index]);
        openTypePicker({ anchor: typeInput, field: f, draftKey: def.key, samples: samples(), latestBytes: cur[f.part], available: Math.max(0, (cur[f.part]?.length || 0) - f.byte),
          apply: (changes) => edit(changes), onClose: () => ctx.onPicker?.(null) });
      };
      pickers.set(`${def.key}|${f.name}`, pick);
      const typeInput = h("input", { class: "ftypein", value: f.type, title: "type as in the CSV (UCH, D2C, BI0:1, BCD:2, HEX:5, …); ▾ lists the types that fit here with what each reads. A shorter type leaves the rest as a raw field of its own, a longer one takes bytes from the raw fields after it", onchange: (e) => edit({ type: e.target.value }, e.target) });
      const names = mine ? null : setup.fieldMap(def);
      const cell = h("td", { class: `field ${mine ? "mine" : ""} ${f.bit !== null ? "bitfield" : ""} ${differs ? "diff" : ""} ${selected ? "sel" : ""}`, colspan: s.span, title: `${f.name}: ${f.part === "m" ? "request" : "answer"} ${f.type}${f.divisor ? ` divisor/values ${f.divisor}` : ""}${f.unit ? ` unit ${f.unit}` : ""}${f.comment ? `\n${f.comment}` : ""}\nclick for the chart over the recording; edit the name for your config, edit type, divisor or unit for a copy of your own`,
        onclick: (e) => { if (!e.target.closest("input")) ctx.onSelect(def.key, f.name); } },
        h("input", { class: "fname", value: mine ? f.name : (names[f.name] || f.name), title: mine ? "field name" : `field name in your config (upstream: ${f.name})`, onchange: (e) => edit({ name: e.target.value }, e.target) }),
        h("div", { class: "ftype" }, typeInput,
          f.bit === null ? h("button", { class: "pickbtn", title: "the types that fit here, with what each reads from this telegram and over the recording; an enumeration from the values seen; the bits; unit and divisor", onclick: (e) => { e.stopPropagation(); pick(); } }, "▾") : null,
          h("input", { class: "fdiv", value: f.divisor, placeholder: "÷/values", title: "divisor (10), factor (-10) or value names (0=off;1=on)", onchange: (e) => edit({ divisor: e.target.value }, e.target) }),
          h("input", { class: "funit", value: f.unit, placeholder: "unit", title: "unit", onchange: (e) => edit({ unit: e.target.value }, e.target) })));
      fieldsRow.appendChild(cell);
      const valueCell = h("td", { class: `value mono ${selected ? "sel" : ""}`, colspan: s.span, onclick: () => ctx.onSelect(def.key, f.name) });
      valueRow.appendChild(valueCell);
      block.cells.push({ field: f.name, unit: f.unit, td: valueCell });
      const canvas = h("canvas", { class: "spark", title: `${f.name} over the whole recording: click for the chart` });
      const sparkCell = h("td", { class: `spark ${selected ? "sel" : ""}`, colspan: s.span, onclick: () => ctx.onSelect(def.key, f.name) }, canvas);
      sparkRow.appendChild(sparkCell);
      sparks.push({ canvas, defKey: def.key, field: f.name });
      fieldCells.set(`${def.key}|${f.name}`, [cell, valueCell, sparkCell]);
      col += s.span;
    }
    filler(columns.length);
    valueRow.insertBefore(block.label, valueRow.firstChild);
    sparkRow.insertBefore(h("td", { class: "fixed muted rowname", colspan: 3 }, "over the recording"), sparkRow.firstChild);
    body.append(fieldsRow, valueRow, sparkRow);
    if (mine) {
      const area = h("textarea", { class: "rawcsv", rows: 2, spellcheck: "false" });
      area.value = csv;
      body.appendChild(h("tr", { class: "raw" }, h("td", { class: "fixed muted rowname", colspan: 3 }, "as ebusd reads it"), h("td", { colspan: columns.length }, area,
        h("div", { class: "row" }, h("button", { class: "small primary", onclick: async () => { try { await upsertMine(area.value, def.key); ctx.onChange?.(); } catch (err) { toast(err.message, "err"); } } }, "save line")))));
    }
  }

  // -- the telegram: one recorded telegram, bytes per column, with the buttons to step through the recording
  const telegramRow = h("tr", { class: "telegram" });
  const older = h("button", { class: "small", title: "the previous (older) recorded telegram", onclick: () => { paint(index + 1); ctx.onTelegram?.(index); } }, "◀ older");
  const newer = h("button", { class: "small", title: "the next (newer) recorded telegram", onclick: () => { paint(index - 1); ctx.onTelegram?.(index); } }, "newer ▶");
  const counter = h("span", { class: "mono muted" });
  const info = h("span", { class: "muted" });
  telegramRow.appendChild(h("td", { class: "fixed label" }, h("b", {}, "telegram"), h("div", { class: "stepper" }, older, counter, newer, info)));
  const addrCell = h("td", { class: "fixed mono" });
  const cmdCell = h("td", { class: "fixed mono" });
  telegramRow.append(addrCell, cmdCell, h("td", { class: "fixed mono", title: `message ID of ${idBytes} byte${idBytes === 1 ? "" : "s"}: as many data bytes as the fitting definitions use to tell this message from its siblings (1 when nothing fits)` }, row.row.id || ""));
  const hexCells = columns.map((c) => { const td = h("td", { class: "hex muted" }); telegramRow.appendChild(td); return { ...c, td }; });
  body.insertBefore(telegramRow, body.firstChild);
  if (ctx.onNew) {
    body.appendChild(h("tr", { class: "newdef" }, h("td", { class: "fixed label", colspan: 4 },
      h("button", { class: "small primary", title: "a line of your own for this message: one raw field per part, to carve into fields here", onclick: () => ctx.onNew() }, "＋ a definition of your own")),
      h("td", { colspan: columns.length, class: "muted" }, "starts with the bytes as they are; give a field a type (the tooltip of a byte in the telegram row says what it could be: a shorter type leaves the rest as a raw field), a name, a divisor, a unit")));
  }

  /** Show one recorded telegram: the bytes, and what every definition decodes from it. Nothing else is touched. */
  function paint(i) {
    index = Math.max(0, Math.min(sorted.length - 1, i));
    const current = sorted[index] || null;
    const cur = bytesOf(current);
    older.disabled = index >= sorted.length - 1;
    newer.disabled = index <= 0;
    counter.textContent = sorted.length ? `${fmt.count(index + 1)} of ${fmt.count(sorted.length)} distinct` : "no telegram";
    const active = current?.last_ms ? app.events?.activeAt(current.last_ms) || [] : [];
    info.replaceChildren(current ? `${current.n ? `×${fmt.count(current.n)}` : "pasted"} · last ${current.last_ms ? fmt.dateTime(current.last_ms, true) : "?"}` : "",
      ...active.map((e) => h("span", { class: "evtag", style: `border-color:${e.color}`, title: `${e.label} was on from ${fmt.dateTime(e.start_ms)}${e.end_ms ? ` to ${fmt.dateTime(e.end_ms)}` : " on"} when this telegram was last recorded` }, h("span", { class: "evdot", style: `background:${e.color}` }), ` while ${e.label} on`)));
    info.title = current?.line || "";
    const master = current?.master || "";
    const cmd = master ? commandInfo(master.slice(4, 8)) : null;
    addrCell.title = master ? `${describeAddress(master.slice(0, 2), { devices, own })}\n\n${describeAddress(master.slice(2, 4), { devices, own })}` : "";
    addrCell.replaceChildren(...(master ? [`${master.slice(0, 2)} ${master.slice(2, 4)}`, h("div", { class: "addrname" }, `${nameOf(master.slice(0, 2))} → ${nameOf(master.slice(2, 4))}`)] : []));
    cmdCell.title = master ? describeCommand(master.slice(4, 8)) : "";
    cmdCell.replaceChildren(master.slice(4, 8), cmd?.service || cmd?.primary ? h("div", { class: "addrname" }, cmd.service || cmd.primary) : "");
    for (const c of hexCells) {
      const byte = cur[c.part][c.byte];
      if (byte === undefined) { c.td.className = "hex muted"; c.td.textContent = c.bit === null ? "··" : "·"; c.td.title = ""; }
      else if (c.bit === null) { c.td.className = "hex mono"; c.td.textContent = byte.toString(16).padStart(2, "0"); c.td.title = readings(cur[c.part], c.byte, c.part); }
      else { const on = (byte >> c.bit) & 1; c.td.className = `hex bit mono ${on ? "on" : ""}`; c.td.textContent = String(on); c.td.title = `bit ${c.bit} of 0x${byte.toString(16).padStart(2, "0")}`; }
    }
    for (const d of defCells) {
      const dec = current ? decoder.decodesOf(current.line)?.get(d.defKey) : null;
      d.label.replaceChildren(dec ? (dec.result === "ok" ? "decodes" : h("span", { class: "err" }, `does not decode: ${dec.result}`)) : d.pending ? h("span", { class: "muted" }, h("span", { class: "spinner" }), " checking…") : "not checked yet");
      for (const c of d.cells) {
        const value = dec && dec.result === "ok" && dec.fields && c.field in dec.fields ? dec.fields[c.field] : null;
        c.td.replaceChildren(dec ? (dec.result === "ok" ? (value === null || value === undefined ? "–" : `${value}${c.unit && typeof value === "number" ? ` ${c.unit}` : ""}`) : h("span", { class: "err", title: dec.result }, "✗")) : h("span", { class: "muted" }, "…"));
      }
    }
  }
  paint(index);

  const root = h("div", { class: "inspector-wrap" }, table);
  if (ctx.picker) requestAnimationFrame(() => { if (root.isConnected) pickers.get(`${ctx.picker.defKey}|${ctx.picker.field}`)?.(); });
  root.showTelegram = paint;
  root.index = () => index;
  root.lineAt = (i) => sorted[i]?.line || null;
  root.indexOfLine = (line) => sorted.findIndex((t) => t.line === line);
  /** Mark the field whose chart is open (or none). */
  root.markSelected = (defKey, field) => {
    for (const cells of fieldCells.values()) for (const td of cells) td.classList.remove("sel");
    if (defKey) for (const td of fieldCells.get(`${defKey}|${field}`) || []) td.classList.add("sel");
  };
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
