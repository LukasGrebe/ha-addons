// The type picker of the inspector: a box under the type of a field with every type of ebusd that
// fits the bytes from the field on, each with what it reads from the telegram shown and the range
// over the recording, the most plausible first; an enumeration prefilled from the values seen in
// the byte; the bits of the byte; raw bytes or text with a length; a unit and a divisor to click;
// and the legend of all abbreviations. Picking saves the line (the inspector's edit rules apply:
// a shorter type leaves a raw field, a longer one takes bytes from the raw fields after it) and
// the box stays open, so type, unit and divisor are three clicks.
import { h } from "./app.js";
import { DIVISORS, KINDS, TYPES, UNITS, bitStats, enumList, enumNames, enumValues, interpretations } from "./types.js";
import { splitType } from "./csv.js";

const hex2 = (n) => n.toString(16).padStart(2, "0");
let open = null;                 // the box that is open: {el, onClose, onDown, onKey, onMove}
const drafts = new Map();        // what was typed into an enumeration, per field, across rebuilds of the inspector

export function closeTypePicker({ silent = false } = {}) {
  if (!open) return;
  const o = open;
  open = null;
  o.el.remove();
  document.removeEventListener("mousedown", o.onDown, true);
  document.removeEventListener("keydown", o.onKey, true);
  window.removeEventListener("resize", o.onMove);
  document.removeEventListener("scroll", o.onMove, true);
  if (!silent) o.onClose?.();
}

const show = (v) => (v === null ? h("span", { class: "muted" }, "no value") : v === undefined ? h("span", { class: "err" }, "✗ cannot be read") : String(v));
const num = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 3 : 2).replace(/\.?0+$/, "")) : String(v));
const rangeText = (i) => {
  const parts = [];
  if (i.min !== null && i.max !== null) parts.push(i.min === i.max ? `always ${num(i.min)}` : `${num(i.min)} … ${num(i.max)}`);
  parts.push(`${i.distinct} distinct`);
  if (i.validRatio < 0.999) parts.push(`${Math.round((1 - i.validRatio) * 100)} % ${i.noneRatio > 0.5 ? "no value" : "unreadable"}`);
  return parts.join(", ");
};

/**
 * Open the picker under a type input.
 * @param o {anchor, field: {name, type, part, byte, divisor, unit}, samples (define.js samplesOf shape), latestBytes,
 *   available (bytes from the field on in the telegram shown), apply(changes) -> Promise, onClose()}
 */
export function openTypePicker(o) {
  closeTypePicker({ silent: true });
  const f = o.field;
  const draftKey = `${o.draftKey || ""}|${f.name}`;
  const draft = drafts.get(draftKey) || { legend: false, names: null };
  drafts.set(draftKey, draft);
  const el = h("div", { class: "typepick", role: "dialog" });
  const pick = (changes) => { Promise.resolve(o.apply(changes)).catch(() => {}); };
  const { code: curCode } = splitType(f.type);
  const curLen = TYPES.find((t) => t.code === curCode)?.bytes ?? 1;
  const partName = f.part === "m" ? "request" : "answer";
  const now = o.latestBytes ? Array.from(o.latestBytes.slice(f.byte, f.byte + Math.min(o.available, 8))) : [];

  const head = () => h("div", { class: "head" },
    h("b", {}, f.name),
    h("span", { class: "muted" }, o.available > 1 ? `${partName} bytes ${f.byte} to ${f.byte + o.available - 1}` : o.available === 1 ? `${partName} byte ${f.byte}` : `${partName}: this telegram has no byte ${f.byte}`),
    h("span", { class: "mono" }, now.map(hex2).join(" ") + (o.available > 8 ? " …" : "")),
    h("span", { class: "muted" }, `now ${f.type}`),
    h("span", { style: "margin-left:auto" }),
    h("button", { class: `small ${draft.legend ? "active" : ""}`, title: "every type of ebusd with its length, range and use", onclick: () => { draft.legend = !draft.legend; render(); } }, draft.legend ? "back to the choices" : "all types"),
    h("button", { class: "small", title: "close (Esc)", onclick: () => closeTypePicker() }, "×"));

  const choices = () => {
    const out = [];
    // the types that fit, with what they read
    const items = interpretations(o.samples, f.part, f.byte, { available: o.available, latestBytes: o.latestBytes }).filter((i) => i.kind !== "bits");
    out.push(h("h4", {}, `reads as (${items.length} types fit here, the most plausible first)`));
    if (!items.length) out.push(h("div", { class: "muted" }, "no telegram has bytes here: the line is longer than the telegrams"));
    else out.push(h("table", {}, h("tbody", {}, items.map((i) => h("tr", { class: `opt ${i.code === curCode ? "cur" : ""}`, title: `${i.name}\n${i.meaning}\n${i.none === "–" ? "" : `${i.none} means no value\n`}typically: ${i.uses}`, onclick: () => pick({ type: i.code }) },
      h("td", { class: "code" }, i.code), h("td", { class: "muted len" }, `${i.len} B`), h("td", { class: "val" }, show(i.value)), h("td", { class: "muted range" }, rangeText(i)),
      h("td", { class: "what" }, i.hint ? h("span", { class: "hint" }, i.hint) : h("span", { class: "muted" }, i.name)))))));
    // an enumeration: the values seen in the byte, named
    if (o.available >= 1) {
      const len = curLen === 2 && o.available >= 2 ? 2 : 1;
      const none = len === 2 ? 0xffff : 0xff;   // the value that means "no value" for UIN / UCH: ebusd allows no name for it
      const all = enumValues(o.samples, f.part, f.byte, len);
      const values = all.filter((v) => v.raw !== none);
      out.push(h("h4", {}, `a state: ${all.length} different value${all.length === 1 ? "" : "s"} in ${len === 2 ? "these two bytes" : "this byte"}`));
      const isEnum = /=/.test(f.divisor || "");
      if (isEnum) out.push(h("div", { class: "row" }, h("span", { class: "muted" }, `named now: ${f.divisor.slice(0, 80)}`), h("button", { class: "small", title: "drop the value names: the field is a plain number again", onclick: () => pick({ divisor: "" }) }, "no names")));
      if (all.length > 16) out.push(h("div", { class: "muted" }, "too many for an enumeration; a number, most likely"));
      else if (!values.length) out.push(h("div", { class: "muted" }, `only 0x${none.toString(16)}, which means "no value" for ${len === 2 ? "UIN" : "UCH"}: nothing to name`));
      else {
        if (values.length < all.length) out.push(h("div", { class: "muted" }, `0x${none.toString(16)} means "no value" for ${len === 2 ? "UIN" : "UCH"} and gets no name`));
        if (!draft.names) {
          draft.names = enumNames(values);
          if (/=/.test(f.divisor || "")) for (const pair of f.divisor.split(";")) { const [k, v] = pair.split("="); if (k !== undefined && v !== undefined && !Number.isNaN(Number(k))) draft.names[Number(k)] = v; }
        }
        const total = values.reduce((n, v) => n + v.n, 0);
        out.push(h("div", { class: "enum" }, values.map((v) => h("label", { class: "row" },
          h("span", { class: "mono" }, len === 2 ? `0x${v.raw.toString(16).padStart(4, "0")}` : `0x${hex2(v.raw)}`), h("span", { class: "mono muted" }, `= ${v.raw}`),
          h("span", { class: "muted n" }, `${Math.round((100 * v.n) / total)} %`),
          h("input", { value: draft.names[v.raw] ?? `v${v.raw}`, placeholder: "name", oninput: (e) => { draft.names[v.raw] = e.target.value; } })))));
        out.push(h("div", { class: "row" },
          h("button", { class: "small primary", title: "the type becomes UCH (UIN for two bytes) with these value names in the divisor/values column", onclick: () => pick({ type: len === 2 ? "UIN" : "UCH", divisor: enumList(Object.fromEntries(values.map((v) => [v.raw, draft.names[v.raw] ?? `v${v.raw}`]))) }) }, "use as an enumeration"),
          h("span", { class: "muted" }, `${len === 2 ? "UIN" : "UCH"} with ${enumList(Object.fromEntries(values.map((v) => [v.raw, draft.names[v.raw] ?? `v${v.raw}`]))).slice(0, 60)}…`)));
      }
      // the bits of the byte
      const st = bitStats(o.samples, f.part, f.byte);
      out.push(h("h4", {}, `the bits of byte ${f.byte}`));
      out.push(h("div", { class: "chips bits" }, [...Array(8).keys()].map((i) => {
        const on = st.total ? Math.round((100 * st.on[i]) / st.total) : 0;
        const fixed = st.on[i] === 0 || st.on[i] === st.total;
        return h("button", { class: `small ${curCode === `BI${i}` ? "active" : ""}`, title: `bit ${i} as a field of its own (BI${i}); on in ${on} % of the telegrams${fixed ? ": never changes" : ""}`, onclick: () => pick({ type: `BI${i}` }) }, `bit ${i}`, h("span", { class: fixed ? "muted" : "ok" }, ` ${on} %`));
      })));
    }
    // raw bytes or text with a length
    const sel = h("select", {}, ["HEX", "STR", "NTS", "IGN", "BCD"].map((c) => h("option", { value: c, selected: c === curCode || (c === "HEX" && !["STR", "NTS", "IGN", "BCD"].includes(curCode)) }, `${c}: ${TYPES.find((t) => t.code === c).name}`)));
    const n = h("input", { type: "number", min: 1, max: Math.max(1, o.available), value: Math.max(1, Math.min(o.available || 1, curLen || 1)), class: "len" });
    out.push(h("h4", {}, "raw bytes or text with a length"));
    out.push(h("div", { class: "row" }, sel, h("span", { class: "muted" }, "of"), n, h("span", { class: "muted" }, `byte${Number(n.value) === 1 ? "" : "s"} (${o.available} available)`),
      h("button", { class: "small", onclick: () => { const c = sel.value, k = Math.max(1, Math.min(Math.max(1, o.available), Number(n.value) || 1)); pick({ type: c === "BCD" && k === 1 ? "BCD" : `${c}:${k}` }); } }, "use"),
      h("button", { class: "small", title: "the rest of the part, whatever its length", onclick: () => pick({ type: `${sel.value === "BCD" ? "HEX" : sel.value}:*` }) }, "the rest (:*)")));
    // unit and divisor
    const isEnum = /=/.test(f.divisor || "");
    out.push(h("h4", {}, "unit"));
    out.push(h("div", { class: "chips" }, UNITS.map((u) => h("button", { class: `small ${f.unit === u ? "active" : ""}`, onclick: () => pick({ unit: f.unit === u ? "" : u }) }, u)), f.unit ? h("button", { class: "small", onclick: () => pick({ unit: "" }) }, "none") : null));
    if (!isEnum) {
      out.push(h("h4", {}, "divisor (a positive one divides, a negative one multiplies)"));
      out.push(h("div", { class: "chips" }, DIVISORS.map(([d, label]) => h("button", { class: `small ${f.divisor === d ? "active" : ""}`, title: `the number read is ${label.replace("÷", "divided by ").replace("×", "multiplied by ")}`, onclick: () => pick({ divisor: f.divisor === d ? "" : d }) }, label)), f.divisor ? h("button", { class: "small", onclick: () => pick({ divisor: "" }) }, "none") : null));
    }
    return out;
  };

  const legend = () => {
    const out = [];
    for (const [kind, label] of Object.entries(KINDS)) {
      const rows = TYPES.filter((t) => t.kind === kind);
      if (!rows.length) continue;
      out.push(h("h4", {}, label));
      out.push(h("table", { class: "legend" }, h("tbody", {}, rows.map((t) => h("tr", { class: `opt ${t.code === curCode ? "cur" : ""}`, title: "use this type", onclick: () => pick({ type: t.kind === "raw" || t.kind === "text" ? `${t.code}:${Math.max(1, Math.min(o.available || 1, curLen || 1))}` : t.code }) },
        h("td", { class: "code" }, t.code), h("td", { class: "muted len" }, t.kind === "bits" ? "bits" : t.kind === "raw" || t.kind === "text" ? ":n" : `${t.bytes} B`),
        h("td", {}, h("b", {}, t.name), h("div", { class: "muted" }, t.meaning)), h("td", { class: "muted none" }, t.none === "–" ? "" : `${t.none} = no value`), h("td", { class: "muted" }, t.uses))))));
    }
    return out;
  };

  const render = () => { el.replaceChildren(head(), ...(draft.legend ? legend() : choices())); };
  const place = () => {
    if (!o.anchor.isConnected) { closeTypePicker(); return; }
    const r = o.anchor.getBoundingClientRect();
    const width = Math.min(680, window.innerWidth - 16);
    el.style.width = `${width}px`;
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
    const useBelow = below >= Math.min(320, above) || below >= above;
    el.style.maxHeight = `${Math.max(160, Math.min(window.innerHeight * 0.75, useBelow ? below : above))}px`;
    if (useBelow) { el.style.top = `${r.bottom + 2}px`; el.style.bottom = ""; } else { el.style.bottom = `${window.innerHeight - r.top + 2}px`; el.style.top = ""; }
  };
  const onDown = (e) => { if (!el.contains(e.target) && !o.anchor.contains(e.target) && e.target !== o.anchor) closeTypePicker(); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeTypePicker(); } };
  const onMove = () => place();
  render();
  document.body.appendChild(el);
  place();
  open = { el, onClose: o.onClose, onDown, onKey, onMove };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onMove);
  document.addEventListener("scroll", onMove, true);
  return el;
}
