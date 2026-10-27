// Editing an existing definition: the line of the compiled definition is split into its header
// and fields, changed in a form (or as text), and decoded against the recorded telegrams while you
// type. Saving never changes the source: it makes your own version of the definition.
import { append, fmt, h } from "./app.js";
import { KIND_CODES, KIND_HELP } from "./compare.js";
import { RAW_TYPES, TYPES, typeOption } from "./define.js";
import { previewDecode } from "./preview.js";
import { joinCsv, splitCsv } from "./setup.js";

const FIELD_COLUMNS = 8;
const FIELD_GROUP = 6;

/** The line of a definition as {header, fields}: type,circuit,name,comment,qq,zz,pbsb,id and name,part,type,divisor,unit,comment per field. */
export function parseDefinition(csv) {
  const cells = splitCsv(csv || "");
  const m = /^(\[[^\]]*\])?(.*)$/.exec(cells[0] || "");
  const header = { condition: m[1] || "", type: m[2], circuit: cells[1] || "", name: cells[2] || "", comment: cells[3] || "", qq: cells[4] || "", zz: cells[5] || "", pbsb: cells[6] || "", id: cells[7] || "" };
  const fields = [];
  for (let i = FIELD_COLUMNS; i < cells.length; i += FIELD_GROUP) {
    fields.push({ name: cells[i] || "", part: cells[i + 1] || "s", type: cells[i + 2] || "", divisor: cells[i + 3] || "", unit: cells[i + 4] || "", comment: cells[i + 5] || "" });
  }
  return { header, fields };
}

/** The CSV line again (without the condition: a version of your own applies whenever it matches). */
export function buildDefinition({ header, fields }) {
  const cells = [header.type, header.circuit, header.name, header.comment, header.qq, header.zz, header.pbsb, header.id];
  for (const f of fields) cells.push(f.name, f.part, f.type, f.divisor, f.unit, f.comment);
  return joinCsv(cells);
}

/** "HEX:4" -> {code: "HEX", length: "4"}; "D2C" -> {code: "D2C", length: ""}. */
export function splitType(type) {
  const m = /^([A-Za-z][A-Za-z0-9_]*)(?::(\d+))?$/.exec(type || "");
  return m ? { code: m[1].toUpperCase(), length: m[2] || "" } : { code: "", length: "" };
}

const PARTS = [
  { code: "s", name: "answer", help: "the bytes the device sends back" },
  { code: "m", name: "request data", help: "the bytes in the message itself, after the ID" },
];
const partText = (p) => `${p.name} · ${p.help} · ${p.code}`;
const KINDS = Object.entries(KIND_CODES).map(([name, code]) => ({ name, code, help: KIND_HELP[name] }));
const kindText = (k) => `${k.name} · ${k.help} · ${k.code}`;
const KNOWN = [...Object.keys(TYPES), ...RAW_TYPES];

/**
 * @param ctx {def, csv?, telegrams, decoder, own, onPreview(preview|null), onSave(csv), onDirty(bool)}
 */
export function csvEditor(ctx) {
  const original = ctx.def.csv;
  let parsed = parseDefinition(ctx.csv ?? original);
  let raw = null;           // the text, when it was edited by hand
  let token = 0, timer = null;
  const root = h("div", { class: "csved" });
  const formBox = h("div"), rawBox = h("div"), statusBox = h("div", { class: "check" });
  const csv = () => raw ?? buildDefinition(parsed);
  const dirty = () => csv() !== original;
  const isOwn = ctx.def.source === "custom";

  const changed = (structural = false) => {
    raw = null;
    renderRaw();
    if (structural) renderForm();
    ctx.onDirty?.(dirty(), csv());
    schedule();
  };

  // -- header -----------------------------------------------------------------------------------------
  function headerForm() {
    const kind = h("select", { class: "wide", title: "what ebusd does with the definition", onchange: () => { parsed.header.type = kind.value; changed(); } },
      KINDS.map((k) => h("option", { value: k.code, selected: k.code === parsed.header.type }, kindText(k))));
    const input = (key, size, title) => { const i = h("input", { type: "text", value: parsed.header[key], size, title, onchange: () => { parsed.header[key] = i.value.trim(); changed(); } }); return i; };
    return h("div", {},
      h("div", { class: "row" }, h("label", {}, "kind"), kind),
      h("div", { class: "row" }, h("label", {}, "circuit"), input("circuit", 10, "the device group: MQTT topics are ebusd/<circuit>/<name>"), h("label", {}, "name"), input("name", 22, "the message name"), h("label", {}, "comment"), input("comment", 24)),
      h("div", { class: "row muted" }, `to device ${parsed.header.zz || "--"} · command ${parsed.header.pbsb} · message ID ${parsed.header.id || "(none)"}${parsed.header.qq ? ` · from device ${parsed.header.qq}` : " · from any device"}`,
        h("span", { title: "a version of your own applies whenever it matches, the condition of the source is not copied" }, ctx.def.condition ? " · the condition of the source is dropped" : "")));
  }

  // -- fields -------------------------------------------------------------------------------------------
  function fieldRow(f, i) {
    const { code, length } = splitType(f.type);
    const known = KNOWN.includes(code);
    const lengthed = RAW_TYPES.includes(code);
    const typeSel = h("select", { class: "wide", onchange: () => {
      if (typeSel.value === "__other") { f.type = f.type || ""; other.style.display = ""; typeSel.value = "__other"; return; }
      f.type = RAW_TYPES.includes(typeSel.value) ? `${typeSel.value}:${length || "1"}` : typeSel.value;
      changed(true);
    } }, [...KNOWN.map((t) => h("option", { value: t, selected: t === code }, typeOption(t))), h("option", { value: "__other", selected: !known }, "other type · any ebusd data type, typed as in the CSV (e.g. TTM, HDA:3, BCD:2)")]);
    const other = h("input", { type: "text", value: f.type, size: 10, style: known ? "display:none" : "", placeholder: "e.g. TTM", onchange: () => { f.type = other.value.trim(); changed(true); } });
    const len = h("input", { type: "number", min: 1, value: length || 1, style: `width:52px;${lengthed ? "" : "display:none"}`, title: "number of bytes", onchange: () => { f.type = `${code}:${Math.max(1, Number(len.value) || 1)}`; changed(); } });
    const part = h("select", { class: "wide", onchange: () => { f.part = part.value; changed(); } }, PARTS.map((p) => h("option", { value: p.code, selected: p.code === f.part }, partText(p))));
    const text = (key, size, title, placeholder = "") => { const x = h("input", { type: "text", value: f[key], size, title, placeholder, onchange: () => { f[key] = x.value.trim(); changed(); } }); return x; };
    return h("tr", {},
      h("td", {}, text("name", 14, "field name (JSON key and entity name)")),
      h("td", {}, part), h("td", {}, typeSel, len, other),
      h("td", {}, text("divisor", 12, "divide the value (e.g. 10) or give names to values (e.g. 0=off;1=on)", "none")),
      h("td", {}, text("unit", 5, "unit, e.g. °C")), h("td", {}, text("comment", 16)),
      h("td", { class: "nowrap" },
        h("button", { class: "small", title: "move up", disabled: i === 0, onclick: () => { [parsed.fields[i - 1], parsed.fields[i]] = [parsed.fields[i], parsed.fields[i - 1]]; changed(true); } }, "↑"),
        h("button", { class: "small", title: "move down", disabled: i === parsed.fields.length - 1, onclick: () => { [parsed.fields[i + 1], parsed.fields[i]] = [parsed.fields[i], parsed.fields[i + 1]]; changed(true); } }, "↓"),
        h("button", { class: "small", title: "remove this field", onclick: () => { parsed.fields.splice(i, 1); changed(true); } }, "✕")));
  }

  function renderForm() {
    formBox.replaceChildren();
    append(formBox, headerForm(),
      h("table", { class: "segs" }, h("thead", {}, h("tr", {}, h("th", {}, "field name"), h("th", {}, "where"), h("th", {}, "type"), h("th", {}, "divisor or value names"), h("th", {}, "unit"), h("th", {}, "comment"), h("th", {}))),
        h("tbody", {}, parsed.fields.map(fieldRow))),
      h("div", { class: "row" }, h("button", { class: "small", onclick: () => { parsed.fields.push({ name: `field${parsed.fields.length + 1}`, part: "s", type: "UCH", divisor: "", unit: "", comment: "" }); changed(true); } }, "+ field")));
  }

  function renderRaw() {
    rawBox.replaceChildren();
    const area = h("textarea", { class: "rawcsv", rows: 3, spellcheck: "false", onchange: () => {
      raw = area.value.trim();
      try { parsed = parseDefinition(raw); } catch { /* keep the form as it was */ }
      renderForm(); renderRaw(); ctx.onDirty?.(dirty(), csv()); schedule();
    } });
    area.value = csv();
    append(rawBox, h("div", { class: "muted" }, "The definition as ebusd reads it (CSV). Edit it by hand if you like; the form follows."), area);
  }

  // -- live preview ---------------------------------------------------------------------------------------
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 400); }

  async function run() {
    const mine = ++token;
    statusBox.textContent = "checking with ebusd…";
    statusBox.className = "check hint";
    try {
      const preview = await previewDecode(ctx.decoder, csv(), ctx.telegrams);
      if (mine !== token) return;
      ctx.onPreview?.(dirty() ? preview : null);
      statusBox.replaceChildren();
      if (preview.errors || !preview.loaded) {
        append(statusBox, h("div", { class: "err" }, "ebusd cannot read this definition:"), h("pre", { class: "log" }, (preview.stderr.length ? preview.stderr : ["no definition loaded"]).slice(0, 6).join("\n")));
        statusBox.className = "check";
        return;
      }
      const failing = preview.bad || preview.unmatched;
      statusBox.className = `check ${failing ? "warn" : "ok"}`;
      append(statusBox,
        h("div", {}, h("b", {}, failing ? `ebusd decodes ${fmt.count(preview.ok)} of ${fmt.count(preview.total)} recorded variants` : `ebusd decodes all ${fmt.count(preview.ok)} recorded variants`),
          h("span", { class: "muted" }, ` · ${fmt.count(preview.okOccurrences)} telegrams${preview.bad ? ` · fails: ${[...preview.kinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")}` : ""}${preview.unmatched ? ` · ${fmt.count(preview.unmatched)} not matched (address, command or ID changed?)` : ""}`)),
        preview.latest ? h("div", { class: "mono decoded" }, preview.latest.text) : null,
        dirty() ? h("div", { class: "hint" }, "History and charts on this panel show this draft while it differs from the source.") : null);
    } catch (err) {
      if (mine === token) { statusBox.textContent = `check failed: ${err.message}`; statusBox.className = "check err"; }
    }
  }

  // -- actions ------------------------------------------------------------------------------------------------
  const save = h("button", { class: "primary", title: isOwn ? "update your definition" : "the source stays as it is: your changes become your own version of the definition", onclick: async () => {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(parsed.header.name) || !parsed.header.circuit) return;
    await ctx.onSave(csv(), parsed.header);
  } }, isOwn ? "Update my definition" : "Save as my version");
  const reset = h("button", { onclick: () => { parsed = parseDefinition(original); raw = null; renderForm(); renderRaw(); ctx.onDirty?.(false, original); ctx.onPreview?.(null); schedule(); } }, "Reset to the source");
  append(root, formBox, rawBox, statusBox,
    h("div", { class: "row actions" }, save, reset, h("span", { class: "hint" }, isOwn ? "This is your own definition; saving replaces it." : "Saving makes your own version, decoded over the whole recording at once; the source is not modified.")));
  renderForm(); renderRaw();
  if (ctx.csv && ctx.csv !== original) schedule(); else statusBox.className = "check";
  return { el: root, csv, dirty, run };
}
