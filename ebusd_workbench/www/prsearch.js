// Searching the open pull requests of ebusd-configuration for one message: which of them decode
// it, under what name and with what values. The device fetches every open pull request once (a
// tarball each, cached), the browser compiles each one once per commit (cached) and runs ebusd's
// decoder over the recorded telegrams of the message with it. A pull request that fits can then be
// added as a source with one click. This is how a message no added source understands, or one
// another source may name better, is found without reading 48 pull requests by hand.
import { api, app, append, bus, fmt, h, toast } from "./app.js";
import { messageColors } from "./colors.js";
import { accessKind } from "./compare.js";

const MAX_LINES = 400;
const POLL_MS = 2000;
const FETCH_TIMEOUT_MS = 4 * 60_000;
const chip = (circuit, name) => { const c = messageColors(circuit, name); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit} ${name}`); };
const isScanLine = (line) => line.slice(4, 10) === "070400";

export class PrSearch {
  constructor() {
    this.state = null;    // {rowKey, label, progress, done, error, results: [{number, title, url, author, updated, decodes: [...], error}], skipped}
    this.token = 0;
  }

  forRow(rowKey) { return this.state && this.state.rowKey === rowKey ? this.state : null; }

  cancel() { this.token++; if (this.state) { this.state.done = true; this.state.progress = this.state.progress ? "stopped" : null; } }

  /** Search every open pull request (not yet a source) for definitions that decode these telegrams. */
  async run(row, telegrams, onChange) {
    const token = ++this.token;
    const label = row.name || row.label;
    const st = (this.state = { rowKey: row.key, label, progress: "listing the open pull requests…", done: false, error: null, results: [], skipped: 0, started: Date.now() });
    const changed = () => { if (token === this.token) onChange?.(st); };
    changed();
    try {
      const decoder = app.decoder;
      const have = new Set((app.status?.sources?.sources || []).map((s) => s.id));
      const list = (await api.get("api/sources/suggest")).pulls.filter((p) => p.number && !have.has(`pr/${p.number}`) && !p.draft);
      if (!list.length) { st.progress = null; st.done = true; st.error = "no open pull request that is not a source already"; return changed(); }
      // the device fetches them (cached after the first time)
      let summaries = (await api.post("api/sources/prefetch", { numbers: list.map((p) => p.number) })).sources;
      const t0 = Date.now();
      while (summaries.some((s) => s.state === "fetching" || s.state === "missing") && Date.now() - t0 < FETCH_TIMEOUT_MS) {
        if (token !== this.token) return;
        const ready = summaries.filter((s) => s.state === "ready").length;
        st.progress = `fetching the open pull requests: ${ready} of ${list.length}…`;
        changed();
        await new Promise((r) => setTimeout(r, POLL_MS));
        summaries = (await api.post("api/sources/prefetch", { numbers: list.map((p) => p.number) })).sources;
      }
      // the telegrams of the message, newest first, with the identification telegrams so that the scan file is known
      const scan = [...decoder.telegrams.values()].filter((t) => isScanLine(t.line)).map((t) => t.line);
      const lines = telegrams.slice().sort((a, b) => (b.last_ms || 0) - (a.last_ms || 0)).slice(0, MAX_LINES).map((t) => t.line);
      const byLine = new Map(telegrams.map((t) => [t.line, t]));
      const stdin = [...scan, ...lines].join("\n") + "\n";
      let i = 0;
      for (const s of summaries) {
        if (token !== this.token) return;
        i++;
        const pull = list.find((p) => `pr/${p.number}` === s.id) || {};
        const result = { number: pull.number, title: s.title || pull.title || "", url: s.url || pull.url, author: s.author || pull.author, updated: s.updated_at || pull.updated_at, decodes: [], error: null, partial: false };
        if (s.state !== "ready") { result.error = s.error || "not fetched"; st.skipped++; st.results.push(result); continue; }
        st.progress = `${s.label}: compiling and decoding (${i} of ${summaries.length})…`;
        changed();
        try {
          const data = await api.get(`api/sources/files?id=${encodeURIComponent(s.id)}`);
          let files = data.files;
          if (data.kind === "tsp") { const compiled = await app.builder.compile({ id: s.id, label: s.label }, `${s.id}@${s.head || s.fetched_at || ""}@${s.digest || ""}@r2`, data.files); files = compiled.outputs; result.partial = !!compiled.partial; }
          const run = await decoder.run({ files, filesId: `search|${s.id}|${s.head || s.fetched_at}`, args: ["--candidates"], stdin, worker: "search" });
          const found = new Map();
          const scanOut = (run.results.find((r) => r.scan) || {}).scan || {};
          for (const r of run.results) {
            if (!("input" in r) || isScanLine(r.input)) continue;
            const t = byLine.get(r.input);
            for (const c of r.candidates || []) {
              const key = `${c.file}|${c.circuit}|${c.name}|${c.write ? "w" : ""}${c.passive ? "u" : ""}`;
              let f = found.get(key);
              if (!f) found.set(key, (f = { circuit: c.circuit, name: c.name, file: c.file, write: !!c.write, passive: !!c.passive, csv: c.csv, available: !!c.available, inScanFile: !c.file.includes("/") || c.file === (scanOut[c.zz]?.file || "") || !/^[0-9a-f]{2}\./i.test(c.file.slice(c.file.lastIndexOf("/") + 1)), ok: 0, errors: 0, occurrences: 0, latest: null, fields: new Set() }));
              if (c.result === "ok") {
                f.ok++; f.occurrences += t?.n || 1;
                for (const name of Object.keys(c.fields || {})) f.fields.add(name);
                if (!f.latest || (t?.last_ms || 0) >= f.latest.ms) f.latest = { ms: t?.last_ms || 0, text: c.text };
              } else f.errors++;
            }
          }
          result.decodes = [...found.values()].filter((f) => f.ok > 0).sort((a, b) => b.ok - a.ok);
        } catch (err) {
          console.warn(err);
          result.error = err.message;
        }
        st.results.push(result);
        changed();
      }
      st.progress = null;
      st.done = true;
      changed();
    } catch (err) {
      console.error(err);
      st.error = err.message;
      st.progress = null;
      st.done = true;
      changed();
    }
  }

  /** The section of the scratchpad: a button, the progress, and what was found. */
  section(row, telegrams, onChange) {
    const st = this.forRow(row.key);
    const box = h("div", { class: "prsearch" });
    const start = h("button", { class: `small ${st ? "" : "primary"}`, disabled: !!(st && !st.done), title: "fetch every open pull request of ebusd-configuration once, compile it here and test it against this message", onclick: () => this.run(row, telegrams, onChange) }, st?.done ? "search again" : "search the open pull requests for this message");
    append(box, h("div", { class: "row" }, h("b", {}, "In the open pull requests"), start,
      st && !st.done ? h("button", { class: "small", onclick: () => { this.cancel(); onChange?.(this.state); } }, "stop") : null,
      st?.progress ? h("span", { class: "hint" }, h("span", { class: "spinner" }), " ", st.progress) : !st ? h("span", { class: "hint" }, "Which of the 40-odd open pull requests decode this message, and how do they name it? The first search fetches and compiles them all (a few minutes); later ones are quick.") : null));
    if (!st) return box;
    if (st.error) append(box, h("div", { class: "hint err" }, st.error));
    const hits = st.results.filter((r) => r.decodes.length);
    const misses = st.results.filter((r) => !r.decodes.length && !r.error);
    const failed = st.results.filter((r) => r.error);
    if (st.done || hits.length) append(box, h("div", { class: "hint" }, `${hits.length} pull request${hits.length === 1 ? "" : "s"} decode this message${misses.length ? `, ${misses.length} do not` : ""}${failed.length ? `, ${failed.length} could not be checked` : ""}${st.done ? `; ${fmt.duration(Date.now() - st.started)}` : ""}.`));
    for (const r of hits) {
      append(box, h("div", { class: "hit" },
        h("div", { class: "row" }, h("a", { href: r.url || "#", target: "_blank", rel: "noopener", class: "mono" }, `#${r.number}`), h("span", { class: "title" }, r.title), h("span", { class: "muted" }, `${r.author || ""} · ${String(r.updated || "").slice(0, 10)}`),
          r.partial ? h("span", { class: "tbadge warn", title: "an old base: only the files this pull request changes were compiled" }, "partial") : null,
          h("span", { style: "margin-left:auto" }), h("button", { class: "small primary", title: "add this pull request as a source: its definitions are decoded over the whole recording and show up as cards", onclick: () => app.views.sources?.add(String(r.number)) }, "+ add as a source")),
        r.decodes.map((f) => h("div", { class: "frow" },
          chip(f.circuit, f.name), h("span", { class: "badge kind" }, accessKind(f)), h("span", { class: "mono muted" }, f.file.replace(/^.*\//, "")),
          f.available && f.inScanFile ? h("span", { class: "tbadge active", title: "with this pull request ebusd would use this definition" }, "ebusd's choice") : h("span", { class: "tbadge", title: f.available ? "in a file ebusd would not load for this device: pick it by hand" : "its condition was not met: pick it by hand" }, "hidden"),
          f.errors ? h("span", { class: "warn" }, `fails on ${f.errors} of ${f.ok + f.errors}`) : h("span", { class: "ok" }, `decodes all ${fmt.count(f.ok)}`),
          f.latest ? h("span", { class: "mono muted ex", title: f.latest.text }, f.latest.text.slice(0, 140)) : null))));
    }
    if (st.done && failed.length) append(box, h("details", {}, h("summary", { class: "hint" }, `${failed.length} pull requests could not be checked`), failed.map((r) => h("div", { class: "hint" }, `#${r.number} ${r.title}: ${r.error}`))));
    return box;
  }
}

export const prSearch = new PrSearch();
