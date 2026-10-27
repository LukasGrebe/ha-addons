// Live preview of a draft definition: ebusd's own decoder (in the decode worker) reads the draft
// line against the recorded telegrams of a row, so editing shows at once how it would decode them.
import { CSV_HEADER } from "./setup.js";

const fnv = (text) => { let x = 2166136261; for (let i = 0; i < text.length; i++) { x ^= text.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(16); };

const compact = (fields) => {
  if (!fields || typeof fields !== "object") return null;
  const out = {};
  for (const [name, f] of Object.entries(fields)) out[name] = f && typeof f === "object" && "value" in f ? f.value : f;
  return out;
};

/**
 * Decode telegram lines with a draft definition (one CSV line, or several).
 * @returns {loaded, errors, stderr, results: Map(line -> {result, text, fields}), ok, bad, unmatched, kinds, latest}
 */
export async function previewDecode(decoder, csv, telegrams, limit = 5000) {
  const text = csv.trim();
  const file = `${/^\s*type\s*,/i.test(text) ? "" : `${CSV_HEADER}\n`}${text}\n`;
  const lines = telegrams.map((t) => t.line).slice(0, limit);
  const run = await decoder.run({ files: { "draft.csv": file }, filesId: `draft|${fnv(file)}`, args: ["--candidates", "--file=draft.csv"], stdin: `${lines.join("\n")}\n`, worker: "preview" });
  const loaded = run.results.find((r) => r.loaded) || {};
  const byLine = new Map(telegrams.map((t) => [t.line, t]));
  const out = { loaded: loaded.messages || 0, errors: loaded.errors || 0, stderr: run.stderr, results: new Map(), ok: 0, bad: 0, unmatched: 0, okOccurrences: 0, kinds: new Map(), latest: null, total: lines.length };
  for (const r of run.results) {
    if (!("input" in r)) continue;
    const c = (r.candidates || []).find((x) => x.file === "draft.csv");
    if (!c) { out.unmatched++; continue; }
    out.results.set(r.input, { result: c.result || "unknown", text: c.text || "", fields: compact(c.fields) });
    const t = byLine.get(r.input);
    if (c.result === "ok") {
      out.ok++; out.okOccurrences += t?.n || 1;
      if (!out.latest || (t?.last_ms || 0) >= out.latest.ms) out.latest = { ms: t?.last_ms || 0, text: c.text, line: r.input };
    } else { out.bad++; out.kinds.set(c.result, (out.kinds.get(c.result) || 0) + 1); }
  }
  return out;
}
