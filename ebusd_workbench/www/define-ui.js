// The editor for a message without a definition, opened from a timeline row. Everything the
// recording tells about the message is prefilled (type, circuit, address, command, ID, the data
// bytes); click a byte to see what it could be (every number type with its values over the whole
// history), give it a type, and ebusd's own decoder checks the definition against the recorded
// telegrams while you work.
import { api, app, append, fmt, h, toast } from "./app.js";
import { CSV_HEADER } from "./setup.js";
import { drawChart, seriesQuery } from "./chart.js";
import { KIND_CODES, KIND_HELP } from "./compare.js";
import { RAW_TYPES, TYPES, analyzeBytes, typeInfo, typeOption, applyType, buildCsv, bytesToHex, customKey, defaultHeader, hexToBytes, initialSegments, interpretations, nameSegments, samplesOf } from "./define.js";

// the kinds of definition: plain name, what it means, then the shorthand of ebusd's CSV
const KINDS = Object.entries(KIND_CODES).map(([name, code]) => ({ name, code, help: KIND_HELP[name] }));
const kindText = (k) => `${k.name} · ${k.help} · ${k.code}`;

const fnv = (text) => { let x = 2166136261; for (let i = 0; i < text.length; i++) { x ^= text.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(16); };
const show = (v) => (v === null || v === undefined ? "–" : Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6))));

/**
 * @param ctx {row, telegrams, scan, own, decoder, onSave(csv, header), onClose()}
 */
export function defineEditor(ctx) {
  const { row, decoder } = ctx;
  const idBytes = (row.row.id || "").length / 2;
  const telegrams = ctx.telegrams.length ? ctx.telegrams
    : row.runs.filter((r) => r.line).map((r) => ({ line: r.line, master: r.line.split("/")[0], slave: r.line.split("/")[1] || null, n: r.n, first_ms: r.t0, last_ms: r.t1 }));
  const samples = samplesOf(telegrams, idBytes);
  const total = telegrams.reduce((n, t) => n + (t.n || 1), 0);
  const info = { m: analyzeBytes(samples, "m"), s: analyzeBytes(samples, "s") };
  const state = {
    header: defaultHeader(row.row, samples, { scan: ctx.scan, own: ctx.own }),
    parts: { m: initialSegments(info.m.length), s: initialSegments(info.s.length) },
    selected: { part: info.s.length ? "s" : "m", offset: 0 },
    chartSegment: null,
    raw: null,                // text of an edit by hand: it replaces the generated line
  };
  const root = h("div", { class: "definer" });
  const boxes = { grid: h("div"), interp: h("div"), segs: h("div"), csv: h("div"), check: h("div", { class: "check" }), chart: h("div", { class: "history" }) };
  let checkTimer = null, checkToken = 0, series = null, seriesPromise = null;

  const csv = () => state.raw ?? buildCsv(state.header, state.parts);

  // -- header ------------------------------------------------------------------------------------------
  const typeSelect = h("select", { class: "wide", title: "what ebusd does with the definition", onchange: () => { state.header.type = typeSelect.value; changed(); } },
    KINDS.map((k) => h("option", { value: k.code, selected: k.code === state.header.type }, kindText(k))));
  const field = (key, size, title) => {
    const input = h("input", { type: "text", value: state.header[key], size, title, onchange: () => {
      state.header[key] = key === "comment" ? input.value.trim() : input.value.trim().replace(/[^A-Za-z0-9_.-]/g, "_");
      input.value = state.header[key];
      changed();
    } });
    return input;
  };
  const header = h("div", { class: "dheader" },
    h("div", { class: "row" }, h("b", {}, `Define ${row.label}`), h("span", { class: "muted" }, `${fmt.count(telegrams.length)} recorded variants · ${fmt.count(total)} telegrams${info.s.length ? ` · answer of ${info.s.length} byte${info.s.length === 1 ? "" : "s"}` : ""}${info.m.length ? ` · request data of ${info.m.length} byte${info.m.length === 1 ? "" : "s"}` : ""}`)),
    h("div", { class: "row" }, h("label", {}, "kind"), typeSelect),
    h("div", { class: "row" },
      h("label", {}, "circuit"), field("circuit", 10, "the device group: MQTT topics are ebusd/<circuit>/<name>"),
      h("label", {}, "name"), field("name", 22, "the message name, e.g. FlowTemp"),
      h("label", {}, "comment"), field("comment", 30)),
    h("div", { class: "row muted" }, `to device ${state.header.zz || "--"} · command ${state.header.pbsb} · message ID ${state.header.id || "(none)"}`, h("span", { title: "the sending device is not part of the definition: it matches whoever sends this message" }, " · from any device")));

  // -- bytes -----------------------------------------------------------------------------------------------
  const segmentAt = (part, offset) => state.parts[part].find((s) => offset >= s.offset && offset < s.offset + s.len);
  const palette = (i) => `hsl(${(i * 67) % 360} 55% 90%)`;

  function renderGrid() {
    boxes.grid.replaceChildren();
    for (const part of ["m", "s"]) {
      const a = info[part];
      if (!a.length) continue;
      const cells = a.bytes.map((b) => {
        const seg = segmentAt(part, b.offset);
        const idx = state.parts[part].indexOf(seg);
        const variability = b.distinct === 1 ? "const" : b.distinct <= 3 ? "few" : "many";
        return h("button", { class: `byte ${variability} ${state.selected.part === part && state.selected.offset === b.offset ? "sel" : ""} ${seg.offset === b.offset ? "start" : ""}`, style: `background:${palette(idx)}`,
          title: `byte ${b.offset}: ${b.distinct} distinct value${b.distinct === 1 ? "" : "s"}${b.distinct > 1 ? ` (${b.min.toString(16).padStart(2, "0")}…${b.max.toString(16).padStart(2, "0")})` : ""}\n${typeInfo(seg.type).name}`,
          onclick: () => { state.selected = { part, offset: b.offset }; renderGrid(); renderInterp(); } },
          h("span", { class: "hex" }, b.latest === null ? "--" : b.latest.toString(16).padStart(2, "0")), h("span", { class: "idx" }, String(b.offset)));
      });
      append(boxes.grid, h("div", { class: "part" }, h("div", { class: "muted" }, part === "s" ? "Answer of the device (latest telegram; grey = never changes, blue = changes)" : "Request data after the ID (latest telegram)"), h("div", { class: "bytes" }, cells),
        a.variants > 1 ? h("div", { class: "hint warn" }, `${a.variants} different lengths were recorded; the most frequent one (${a.length} bytes) is shown`) : null));
    }
    if (!info.m.length && !info.s.length) append(boxes.grid, h("div", { class: "hint warn" }, "No recorded data bytes for this message: a definition without fields."));
  }

  function renderInterp() {
    const { part, offset } = state.selected;
    boxes.interp.replaceChildren();
    if (!info[part].length) return;
    const seg = segmentAt(part, offset);
    const list = interpretations(samples, part, offset).slice(0, 10);
    const apply = (type, len) => {
      state.parts[part] = applyType(state.parts[part], info[part].length, offset, type, len);
      state.raw = null;
      state.chartSegment = state.parts[part].find((x) => x.offset === offset);   // show the history of what was just typed
      state.chartPart = part;
      changed(true);
    };
    const len = h("input", { type: "number", min: 1, max: info[part].length - offset, value: 1, style: "width:48px" });
    append(boxes.interp, h("div", { class: "muted" }, `Byte ${offset}${part === "s" ? " of the answer" : " of the request data"} could be, starting here (latest value, range over the whole history):`),
      h("div", { class: "chips" }, list.map((i) => h("button", { class: `interp ${seg.offset === offset && seg.type === i.type ? "on" : ""} ${i.validRatio < 0.5 ? "bad" : ""}`, title: `${i.name}: ${i.label} (${i.type})${i.validRatio < 1 ? ` — ${Math.round((1 - i.validRatio) * 100)} % of the values are the replacement value "-"` : ""}`, onclick: () => apply(i.type) },
        h("b", {}, i.name), ` ${show(i.latest)}`, h("span", { class: "muted" }, `${i.min !== null ? ` (${show(i.min)} … ${show(i.max)})` : " (no valid value)"} · ${i.type}`)))),
      h("div", { class: "row" }, "or the next", len, "bytes as",
        RAW_TYPES.map((t) => h("button", { class: "small", title: `${typeInfo(t).label} (${t})`, onclick: () => apply(t, Number(len.value) || 1) }, typeInfo(t).name))));
  }

  // -- segments ------------------------------------------------------------------------------------------------
  function decodeSegment(seg, bytes) {
    if (!bytes || bytes.length < seg.offset + seg.len) return undefined;
    const slice = bytes.slice(seg.offset, seg.offset + seg.len);
    if (TYPES[seg.type]) {
      const v = TYPES[seg.type].decode(slice);
      if (v === null) return null;
      const div = Number(seg.divisor);
      return div ? v / div : v;
    }
    return bytesToHex(slice);
  }

  function renderSegments() {
    boxes.segs.replaceChildren();
    const rows = [];
    for (const part of ["m", "s"]) {
      if (!info[part].length) continue;
      for (const seg of nameSegments(state.parts[part], part)) {
        const real = state.parts[part][seg.index];
        const values = samples.map((s) => decodeSegment(real, s[part])).filter((v) => v !== undefined && v !== null);
        const numeric = values.length && values.every((v) => typeof v === "number");
        const latest = decodeSegment(real, info[part].latest?.[part]);
        const typeSel = h("select", { class: "wide", onchange: () => { state.parts[part] = applyType(state.parts[part], info[part].length, real.offset, typeSel.value, real.len); state.raw = null; changed(true); } },
          [...Object.keys(TYPES), ...RAW_TYPES].map((t) => h("option", { value: t, selected: t === real.type }, typeOption(t))));
        const name = h("input", { type: "text", value: real.name, placeholder: seg.name, size: 14, onchange: () => { real.name = name.value.trim(); state.raw = null; changed(); } });
        const div = h("input", { type: "text", value: real.divisor, size: 6, placeholder: "none", title: "divide the value (e.g. 10) or give names to values (e.g. 0=off;1=on)", onchange: () => { real.divisor = div.value.trim(); changed(true); } });
        const unit = h("input", { type: "text", value: real.unit, size: 4, onchange: () => { real.unit = unit.value.trim(); changed(); } });
        const range = numeric ? `${show(Math.min(...values))} … ${show(Math.max(...values))}` : "";
        rows.push(h("tr", { class: state.chartSegment === real ? "sel" : "", onclick: (e) => { if (e.target.closest("input,select")) return; state.chartSegment = real; state.chartPart = part; renderSegments(); renderChart(); } },
          h("td", { class: "mono muted" }, `${part === "s" ? "answer" : "request"} ${real.len > 1 ? `${real.offset}–${real.offset + real.len - 1}` : real.offset}`),
          h("td", {}, typeSel), h("td", {}, name), h("td", {}, div), h("td", {}, unit),
          h("td", { class: "mono" }, latest === undefined || latest === null ? "–" : String(typeof latest === "number" ? Number(latest.toPrecision(6)) : latest)),
          h("td", { class: "mono muted" }, range)));
      }
    }
    if (rows.length) append(boxes.segs, h("table", { class: "segs" }, h("thead", {}, h("tr", {}, h("th", {}, "bytes"), h("th", {}, "type"), h("th", {}, "field name"), h("th", {}, "divisor or value names"), h("th", {}, "unit"), h("th", {}, "latest"), h("th", {}, "range"))), h("tbody", {}, rows)));
  }

  // -- the line and ebusd's check ---------------------------------------------------------------------------
  function renderCsv() {
    boxes.csv.replaceChildren();
    const text = csv();
    const area = h("textarea", { class: "rawcsv", rows: 2, spellcheck: "false", value: text, onchange: () => { state.raw = area.value.trim(); scheduleCheck(); } });
    area.value = text;
    append(boxes.csv, h("div", { class: "muted" }, "The definition as ebusd reads it (edit it by hand if you need more than this editor offers):"), area,
      state.raw ? h("div", { class: "hint warn" }, "edited by hand: byte and field changes above replace it again", " ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); state.raw = null; changed(); } }, "discard my text")) : null);
  }

  async function runCheck() {
    const token = ++checkToken;
    boxes.check.textContent = "checking with ebusd…";
    boxes.check.className = "check hint";
    try {
      const file = `${CSV_HEADER}\n${csv()}\n`;
      const lines = telegrams.map((t) => t.line).slice(0, 3000);
      const result = await decoder.run({ files: { "draft.csv": file }, filesId: `draft|${fnv(file)}`, args: ["--candidates", "--file=draft.csv"], stdin: `${lines.join("\n")}\n`, worker: "preview" });
      if (token !== checkToken) return;
      const loaded = result.results.find((r) => r.loaded) || {};
      const byLine = new Map(telegrams.map((t) => [t.line, t]));
      let ok = 0, bad = 0, occurrences = 0, unmatched = 0, latest = null;
      const kinds = new Map();
      for (const r of result.results) {
        if (!("input" in r)) continue;
        const c = (r.candidates || []).find((x) => x.file === "draft.csv");
        if (!c) { unmatched++; continue; }
        const t = byLine.get(r.input);
        if (c.result === "ok") {
          ok++; occurrences += t?.n || 1;
          if (!latest || (t?.last_ms || 0) >= latest.ms) latest = { ms: t?.last_ms || 0, text: c.text };
        } else { bad++; kinds.set(c.result, (kinds.get(c.result) || 0) + 1); }
      }
      boxes.check.replaceChildren();
      if (loaded.errors || !loaded.messages) {
        append(boxes.check, h("div", { class: "err" }, "ebusd cannot read this definition:"), h("pre", { class: "log" }, (result.stderr.length ? result.stderr : ["no definition loaded"]).slice(0, 6).join("\n")));
        boxes.check.className = "check";
        return;
      }
      boxes.check.className = `check ${bad || unmatched ? "warn" : "ok"}`;
      append(boxes.check,
        h("div", {}, h("b", {}, bad || unmatched ? `ebusd decodes ${fmt.count(ok)} of ${fmt.count(lines.length)} recorded variants` : `ebusd decodes all ${fmt.count(ok)} recorded variants`), h("span", { class: "muted" }, ` · ${fmt.count(occurrences)} telegrams${bad ? ` · fails: ${[...kinds.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")}` : ""}${unmatched ? ` · ${unmatched} not matched (check the ID and addresses)` : ""}`)),
        latest ? h("div", { class: "mono decoded" }, latest.text) : null);
    } catch (err) {
      if (token === checkToken) { boxes.check.textContent = `check failed: ${err.message}`; boxes.check.className = "check err"; }
    }
  }

  function scheduleCheck() { clearTimeout(checkTimer); checkTimer = setTimeout(runCheck, 400); }

  // -- history of the selected field ----------------------------------------------------------------------------
  async function loadSeries() {
    if (series) return series;
    const db = app.status?.db;
    if (!db?.first_ms) return null;
    seriesPromise ||= api.get(seriesQuery(row.row, db.first_ms, db.last_ms + 1000)).then((d) => { series = d; return d; });
    return seriesPromise;
  }

  async function renderChart() {
    const seg = state.chartSegment;
    boxes.chart.replaceChildren();
    if (!seg || !TYPES[seg.type]) { append(boxes.chart, h("div", { class: "muted" }, "Click a number field in the table to see its history over the recording.")); return; }
    const part = state.chartPart || "s";
    boxes.chart.textContent = "loading history…";
    const data = await loadSeries();
    if (!data || state.chartSegment !== seg) return;
    const decodeLine = (line) => {
      const [master, slave] = line.split("/");
      const bytes = part === "s" ? (slave ? hexToBytes(slave.slice(2)) : null) : hexToBytes(master.slice(10 + idBytes * 2));
      return decodeSegment(seg, bytes);
    };
    const values = data.lines.map(decodeLine);
    const points = [];
    for (const [ms, i] of data.points) if (values[i] !== undefined && values[i] !== null) points.push({ ms, value: values[i] });
    const db = app.status.db;
    const canvas = h("canvas");
    boxes.chart.replaceChildren();
    append(boxes.chart, h("div", { class: "row" }, h("b", {}, "History"), ` of ${nameSegments(state.parts[part], part)[state.parts[part].indexOf(seg)].name} as ${typeInfo(seg.type).name} (${seg.type})`), canvas,
      h("div", { class: "hint" }, `${fmt.count(points.length)} telegrams${data.stride > 1 ? ` (every ${data.stride}th of ${fmt.count(data.total)})` : ""}: a value that looks like a measurement (smooth, plausible range) is the right type`));
    drawChart(canvas, { points, numeric: true, field: seg.name }, { t0: db.first_ms, t1: db.last_ms + 1000, width: Math.max(320, (root.clientWidth || 640) - 20), height: 110 });
  }

  function changed(structural = false) {
    renderCsv();
    renderSegments();
    if (structural) { renderGrid(); renderInterp(); renderChart(); }
    scheduleCheck();
  }

  // -- actions ----------------------------------------------------------------------------------------------------
  const save = h("button", { class: "primary", onclick: async () => {
    const line = csv();
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(state.header.name) || !state.header.circuit) return toast("give the message a name and a circuit", "err");
    await ctx.onSave(line, state.header);
  } }, "Add as my definition");
  append(root, header, h("h3", {}, "Data bytes"), boxes.grid, boxes.interp, h("h3", {}, "Fields"), boxes.segs, boxes.chart, h("h3", {}, "Definition"), boxes.csv, boxes.check,
    h("div", { class: "row actions" }, save, h("button", { onclick: () => ctx.onClose() }, "Cancel"), h("span", { class: "hint" }, "It is decoded over the whole recording at once and shows up as one of the row's candidates (kind: own definition).")));
  renderGrid(); renderInterp(); renderSegments(); renderCsv(); renderChart(); scheduleCheck();
  return root;
}

export { customKey };
