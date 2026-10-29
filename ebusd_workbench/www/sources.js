// Where definitions come from. The device fetches every source as one snapshot from GitHub (no
// git): ebusd's own definitions (the release at ebus.github.io), the upcoming release, pull
// requests of ebusd-configuration and branches of other repositories. Ready-made CSV trees are
// used as they are; TypeSpec sources are compiled to CSV here in the browser (cached per
// commit). The scratchpad (your own definition lines) is a source too. Together they make the
// build the decoder works with: one complete tree per source, decoded side by side.
//
// This module keeps the build in step with the sources (a source arrives, is refreshed, enabled
// or removed; the scratchpad changes) and draws the strip at the top of the page.
import { api, app, append, bus, fmt, h, toast, refreshStatus } from "./app.js";
import { MINE, splitCsv } from "./setup.js";
import { mineSource } from "./decoder.js";

const KIND_HELP = {
  cdn: "ready-made CSV files from ebus.github.io, exactly what ebusd loads",
  pr: "a pull request of john30/ebusd-configuration: TypeSpec sources, compiled here in the browser",
  repo: "a branch of another GitHub repository: TypeSpec sources compiled here, or CSV files as they are",
  mine: "your own definition lines (My definitions in the setup column), decoded over the recording like any other source",
};

/** The definition lines of a CSV tree by file and message (comments, headers and templates left out): Map(key -> line). */
export function definitionIndex(files) {
  const out = new Map();
  for (const [file, text] of Object.entries(files || {})) {
    if (!/\.(csv|inc)$/.test(file) || /(^|\/)_templates\.csv$/.test(file)) continue;
    for (const raw of String(text).split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("*") || line.startsWith("!") || /^(\[[^\]]*\])?type\s*,/i.test(line)) continue;
      const cells = splitCsv(line);
      if (cells.length < 3) continue;
      const type = cells[0].replace(/^\[[^\]]*\]/, "").trim().toLowerCase();
      if (!/^[rwu;]+[0-9]?$/.test(type)) continue;
      out.set(`${file}|${cells[1]}|${cells[2]}|${type}`, line);
    }
  }
  return out;
}

/** What a source brings compared with a reference tree: the definitions it adds, changes and lacks. */
export function deltaOf(files, referenceFiles) {
  const a = definitionIndex(files), b = definitionIndex(referenceFiles);
  const added = [], changed = [];
  for (const [key, line] of a) {
    if (!b.has(key)) added.push(key);
    else if (b.get(key) !== line) changed.push(key);
  }
  let removed = 0;
  for (const key of b.keys()) if (!a.has(key)) removed++;
  return { added, changed, removed, total: a.size, reference: b.size };
}

// the rules of "ebusd's choice" are part of a source's stamp: a changed rule decodes everything again, once
const RULES = "r2";
const stampOf = (s) => `${s.id}@${s.head || s.fetched_at || ""}@${s.digest || ""}@${RULES}`;

/** Keeps the decoder's build in step with the sources: fetched trees, compiled pull requests, the scratchpad. */
export class Builder {
  constructor() {
    this.state = { busy: false, text: "", error: null };
    this.busy = false;
    this.again = false;
    this.lastKey = null;
    this.timer = null;
    this.tsp = null;
  }

  setState(state) { this.state = { busy: false, text: "", error: null, ...state }; bus.emit("compile-state", this.state); }

  /** The list of sources changed on the device (a fetch finished, one was enabled or removed): build again. */
  onStatus(status) {
    const list = status?.sources?.sources || [];
    const key = `${status?.sources?.language || "en"}|` + list.filter((s) => s.state === "ready").map((s) => `${stampOf(s)}:${s.enabled ? 1 : 0}`).join(",");
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.schedule();
  }

  schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this.rebuild(), 300); }

  async loadCompiler(quiet = false) {
    if (!this.tsp) {
      if (!quiet) this.setState({ busy: true, text: "loading the TypeSpec compiler…" });
      this.tsp = await import("./vendor/ebus-tsp.js");
      if (!quiet) this.setState({ busy: false });
    }
    return this.tsp;
  }

  /** Compile the TypeSpec sources of a source to CSV, once per commit (cached in the browser store). */
  async compile(source, stamp, files, { quiet = false } = {}) {
    const store = app.decoder.store;
    const cacheKey = `tsp:${stamp}`;
    const state = (s) => { if (!quiet) this.setState(s); };
    try {
      const cached = await store.get("compiles", cacheKey);
      if (cached?.outputs) return { outputs: cached.outputs, summary: cached.summary, cached: true };
    } catch (err) { console.warn(err); }
    const tsp = await this.loadCompiler(quiet);
    const language = app.status?.sources?.language || "en";
    const entry = files["main.tsp"] !== undefined ? "main.tsp" : Object.keys(files).find((p) => p.endsWith(".tsp"));
    if (!entry) throw new Error("no .tsp file to compile");
    const translations = language !== "en" && files[`${language}.yaml`] !== undefined ? `${language}.yaml` : undefined;
    state({ busy: true, text: `compiling ${source.label} (${Object.keys(files).length} files)…` });
    const t0 = performance.now();
    let result = await tsp.compileEbusTsp(files, { entry, translations });
    let partial = null;
    if (!result.ok && /^pr\//.test(source.id)) {
      // an old base that today's TypeSpec library rejects: only what the pull request changes, and what that imports
      partial = await this.partialEntry(source, files);
      if (partial) {
        state({ busy: true, text: `compiling ${source.label} (only the ${partial.count} files it changes)…` });
        result = await tsp.compileEbusTsp({ ...files, [partial.entry]: partial.text }, { entry: partial.entry, translations });
      }
    }
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    const ms = Math.round(performance.now() - t0);
    if (!result.ok) {
      const where = errors.slice(0, 3).map((d) => `${d.file ? `${d.file}:${d.line || "?"} ` : ""}${d.message}`).join("; ");
      throw new Error(`${errors.length} compile error${errors.length === 1 ? "" : "s"}${partial ? ` (also in the ${partial.count} files it changes)` : ""}: ${where}`);
    }
    const summary = `${Object.keys(result.outputs).length} files compiled in ${fmt.duration(ms)}${result.diagnostics.length ? `, ${result.diagnostics.length} warnings` : ""}${partial ? `; only the ${partial.count} files the pull request changes: its base is older than today's TypeSpec library` : ""}`;
    try { await store.putAll("compiles", [{ id: cacheKey, outputs: result.outputs, summary, partial: !!partial, at: new Date().toISOString() }]); } catch (err) { console.warn(err); }
    return { outputs: result.outputs, summary, partial: !!partial, cached: false };
  }

  /** A compile result from the browser store, without needing the files (the search over the pull requests asks this first). */
  async cachedCompile(stamp) {
    try { const c = await app.decoder.store.get("compiles", `tsp:${stamp}`); return c?.outputs ? { outputs: c.outputs, summary: c.summary, partial: !!c.partial, cached: true } : null; } catch { return null; }
  }

  /** An entry file that imports only the TypeSpec files a pull request changes (from GitHub's list), or null. */
  async partialEntry(source, files) {
    try {
      const { files: changed } = await api.get(`api/sources/changes?id=${encodeURIComponent(source.id)}`);
      const paths = [...new Set(changed.map((f) => f.path).filter((p) => p.startsWith("src/") && p.endsWith(".tsp") && !/(^|\/)(main|_templates)\.tsp$/.test(p)).map((p) => p.slice(4)))].filter((p) => files[p] !== undefined);
      if (!paths.length) return null;
      return { entry: "__workbench_changes.tsp", count: paths.length, text: paths.map((p) => `import "./${p}";`).join("\n") + "\n" };
    } catch (err) { console.warn(`changed files of ${source.id}:`, err); return null; }
  }

  /** The build: every enabled, fetched source as a CSV tree (compiled if need be) plus the scratchpad. */
  async rebuild() {
    if (!app.decoder) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      await app.decoder.ready;
      // every fetched source is part of the build, unticked ones too: their decodings stay, so ticking them again is instant
      const list = (app.status?.sources?.sources || []).filter((s) => s.state === "ready");
      const sources = [];
      for (const s of list) {
        const stamp = stampOf(s);
        const current = app.decoder.source(s.id);
        if (current && current.stamp === stamp && current.files && !current.error) { sources.push({ ...current, enabled: !!s.enabled, label: s.label, title: s.title, head: s.head }); continue; }
        const entry = { id: s.id, label: s.label, kind: s.kind, stamp, filesId: stamp, files: {}, head: s.head || null, title: s.title || null, url: s.url || null, enabled: !!s.enabled, error: null, summary: "" };
        try {
          this.setState({ busy: true, text: `loading ${s.label}…` });
          const data = await api.get(`api/sources/files?id=${encodeURIComponent(s.id)}`);
          if (data.kind === "tsp") {
            const compiled = await this.compile(s, stamp, data.files);
            entry.files = compiled.outputs;
            entry.summary = compiled.summary;
            entry.tsp = true;
            entry.partial = !!compiled.partial;
          } else {
            entry.files = data.files;
            entry.summary = `${Object.keys(data.files).length} CSV files`;
          }
        } catch (err) {
          console.error(err);
          entry.error = err.message;
          entry.files = {};
        }
        sources.push(entry);
      }
      const mine = mineSource(app.settings?.custom);
      if (mine) sources.push({ ...mine, stamp: mine.filesId });
      // what each source brings compared with the reference: what ebusd uses today (the release), else the upcoming release
      const reference = sources.find((s) => s.id === "release" && !s.error) || sources.find((s) => s.id === "next" && !s.error) || null;
      for (const s of sources) s.delta = reference && s !== reference && !s.error ? deltaOf(s.files, reference.files) : null;
      const ok = sources.filter((s) => !s.error && s.enabled);
      const summary = ok.length ? `${ok.map((s) => s.label).join(", ")}` : "no definitions";
      this.setState({ busy: false, text: summary, error: sources.find((s) => s.error) ? `${sources.filter((s) => s.error).map((s) => `${s.label}: ${s.error}`).join("; ")}` : null });
      await app.decoder.setBuild({ id: Date.now().toString(36), at: new Date().toISOString(), sources, reference: reference?.id || null, summary });
    } catch (err) {
      console.error(err);
      this.setState({ busy: false, error: `building the definitions failed: ${err.message}` });
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.schedule(); }
    }
  }

  /** The scratchpad changed: only its lines are decoded again. */
  async setMine(text) {
    const build = app.decoder?.build;
    if (!build) { this.lastKey = null; this.schedule(); return; }
    const mine = mineSource(text);
    const sources = build.sources.filter((s) => s.id !== MINE);
    if (mine) {
      const reference = sources.find((s) => s.id === build.reference) || null;
      sources.push({ ...mine, stamp: mine.filesId, delta: reference?.files ? deltaOf(mine.files, reference.files) : null });
    }
    await app.decoder.setBuild({ ...build, id: Date.now().toString(36), at: new Date().toISOString(), sources });
  }
}

// -- the strip: every source with its state, and the way to add one ----------------------------------------

const remembered = (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === "1"; } catch { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* ignore */ } };

export class SourcesStrip {
  constructor(root) {
    this.root = root;
    this.expanded = remembered("workbench.sourcesOpen", true);   // the whole strip, or one line
    this.open = false;          // the add panel
    this.suggest = null;        // the open pull requests of ebusd-configuration
    this.suggestError = null;
    this.input = "";
    bus.on("status", () => this.render());
    bus.on("decodes-changed", (reason) => { if (reason !== "progress") this.render(); });
    bus.on("compile-state", () => this.render());
    this.render();
  }

  sources() { return app.status?.sources?.sources || []; }

  /** Words that describe the devices on the bus: manufacturer, identification, circuits (to spot fitting pull requests). */
  deviceWords() {
    const words = new Set();
    const d = app.decoder;
    for (const info of Object.values(d?.devices() || {})) {
      for (const w of [info.manufacturer, info.ident, info.ident?.replace(/[0-9]+$/, "")]) if (w && w.length > 1) words.add(String(w).toLowerCase());
      if (info.hw) words.add(`hw${info.hw}`);
    }
    for (const e of d?.entries || []) if (e.status === "active" || e.status === "hidden") words.add(e.circuit.toLowerCase().replace(/[0-9]+$/, ""));
    words.delete("");
    return [...words].filter((w) => w.length > 1);
  }

  fits(title) {
    const t = title.toLowerCase();
    return this.deviceWords().filter((w) => t.includes(w));
  }

  async add(spec) {
    spec = String(spec || "").trim();
    if (!spec) return;
    try {
      const added = await api.post("api/sources", { ref: spec });
      toast(`${added.label}: fetching…`);
      this.input = "";
      await refreshStatus();
    } catch (err) { toast(`adding ${spec} failed: ${err.message}`, "err", 8000); }
    this.render();
  }

  async remove(id) {
    try { await api.del(`api/sources?id=${encodeURIComponent(id)}`); await refreshStatus(); } catch (err) { toast(err.message, "err"); }
  }

  async refresh(id) {
    try { await api.post("api/sources/refresh", { id }); await refreshStatus(); } catch (err) { toast(err.message, "err"); }
  }

  async enable(id, on) {
    try { await api.put("api/sources/enabled", { id, enabled: on }); await refreshStatus(); } catch (err) { toast(err.message, "err"); }
  }

  async loadSuggestions() {
    try { this.suggest = await api.get("api/sources/suggest"); this.suggestError = null; } catch (err) { this.suggestError = err.message; }
    this.render();
  }

  chip(s) {
    const decoded = app.decoder?.status().build?.sources.find((x) => x.id === s.id) || null;
    const built = app.decoder?.source(s.id) || null;
    const parts = [];
    let cls = "src";
    if (!s.enabled) { cls += " off"; parts.push("off"); }
    else if (s.state === "fetching") { cls += " busy"; parts.push("fetching…"); }
    else if (s.state === "error") { cls += " err"; parts.push("failed"); }
    else if (s.state === "missing") { cls += " warn"; parts.push("not fetched"); }
    else if (built?.error) { cls += " err"; parts.push("compile failed"); }
    else if (!built) { cls += " busy"; parts.push("loading…"); }
    else {
      // the text keeps its length while decoding (the progress is in the top bar), so that the strip never reflows the page
      if (decoded?.pending) cls += " busy";
      parts.push(`${fmt.count(decoded?.definitions || 0)} fit your bus`);
      if (built.delta) parts.push(`+${built.delta.added.length} new${built.delta.changed.length ? `, ${built.delta.changed.length} changed` : ""}`);
    }
    const title = [`${s.label} (${s.id})`, KIND_HELP[s.kind] || "", s.title ? `“${s.title}”` : "", s.head ? `commit ${s.head.slice(0, 7)}` : "", s.fetched_at ? `fetched ${fmt.dateTime(s.fetched_at * 1000)}` : "",
      s.error ? `error: ${s.error}` : "", built?.error ? `compile: ${built.error}` : "", built?.summary || "", built?.delta ? `compared with ${app.decoder.build.reference}: ${built.delta.added.length} definitions only here, ${built.delta.changed.length} changed, ${built.delta.removed} missing` : ""].filter(Boolean).join("\n");
    const toggle = h("input", { type: "checkbox", checked: !!s.enabled, title: s.enabled ? "leave this source out" : "use this source", onchange: () => this.enable(s.id, toggle.checked) });
    return h("span", { class: cls, title },
      toggle,
      cls.includes("busy") ? h("span", { class: "spinner", title: "decoding the recording with this source (progress in the top bar)" }) : null,
      h("b", {}, s.label),
      s.kind === "pr" && s.title ? h("span", { class: "muted t" }, s.title.length > 48 ? `${s.title.slice(0, 47)}…` : s.title) : null,
      h("span", { class: "muted" }, parts.join(" · ")),
      built?.partial ? h("span", { class: "tbadge warn", title: "its base is older than today's TypeSpec library: only the files the pull request changes are compiled, so \"ebusd's choice\" and the counts of this source cover those files only" }, "partial") : null,
      s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener", title: "open on GitHub", class: "muted" }, "↗") : null,
      h("a", { href: "#", class: "muted", title: "fetch again (the pull request may have been updated)", onclick: (e) => { e.preventDefault(); this.refresh(s.id); } }, "↻"),
      s.kind !== "cdn" ? h("a", { href: "#", class: "err", title: "remove this source", onclick: (e) => { e.preventDefault(); if (confirm(`Remove ${s.label}?`)) this.remove(s.id); } }, "✕") : null);
  }

  mineChip() {
    const st = app.decoder?.status().build?.sources.find((x) => x.id === MINE) || null;
    const lines = (app.settings?.custom || "").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
    return h("span", { class: `src ${st?.pending ? "busy" : ""}`, title: `${KIND_HELP.mine}\n${lines} definition line${lines === 1 ? "" : "s"}` },
      h("b", {}, "my definitions"), h("span", { class: "muted" }, lines ? `${lines} line${lines === 1 ? "" : "s"}${st ? ` · ${fmt.count(st.definitions)} fit your bus` : ""}` : "empty: write one in the scratchpad"));
  }

  addPanel() {
    const input = h("input", { type: "text", size: 34, value: this.input, placeholder: "660 · owner/repo#branch · GitHub URL", title: "a pull request number of john30/ebusd-configuration, a repository as owner/name (optionally #branch), or a GitHub URL of either",
      oninput: () => { this.input = input.value; }, onkeydown: (e) => { if (e.key === "Enter") this.add(input.value); } });
    const box = h("div", { class: "src-add" },
      h("div", { class: "row" }, h("b", {}, "Add a source"), input, h("button", { class: "small primary", onclick: () => this.add(input.value) }, "Add"),
        h("span", { class: "hint" }, "Pull requests are compiled here in your browser; nothing is merged anywhere.")));
    const have = new Set(this.sources().map((s) => s.id));
    if (!this.suggest && !this.suggestError) { this.loadSuggestions(); append(box, h("div", { class: "hint" }, h("span", { class: "spinner" }), " loading the open pull requests of ebusd-configuration…")); return box; }
    if (this.suggestError) { append(box, h("div", { class: "hint err" }, `The open pull requests could not be loaded: ${this.suggestError}`)); return box; }
    const words = this.deviceWords();
    const pulls = (this.suggest.pulls || []).map((p) => ({ ...p, fits: this.fits(p.title) })).sort((a, b) => b.fits.length - a.fits.length || String(b.updated_at).localeCompare(String(a.updated_at)));
    append(box, h("div", { class: "row" }, h("b", {}, `Open pull requests of ebusd-configuration (${pulls.length})`),
      h("span", { class: "hint" }, words.length ? `the ones that mention your devices (${words.slice(0, 6).join(", ")}) first` : "once your devices are identified, the ones that mention them come first"),
      this.suggest.stale ? h("span", { class: "warn" }, "(cached: GitHub did not answer)") : null,
      h("span", { style: "margin-left:auto" }), h("button", { class: "small", onclick: () => this.toggle(false) }, "close")));
    append(box, h("div", { class: "pulls" }, pulls.map((p) => h("div", { class: `pull ${p.fits.length ? "fits" : ""}` },
      h("span", { class: "mono" }, `#${p.number}`),
      h("span", { class: "title", title: p.title }, p.title, p.draft ? h("span", { class: "badge" }, "draft") : null),
      p.fits.length ? h("span", { class: "badge active", title: `mentions ${p.fits.join(", ")}` }, "your devices?") : null,
      h("span", { class: "muted" }, `${p.author || ""} · ${String(p.updated_at || "").slice(0, 10)}`),
      p.url ? h("a", { href: p.url, target: "_blank", rel: "noopener", class: "muted" }, "↗") : null,
      have.has(`pr/${p.number}`) ? h("span", { class: "ok" }, "added") : h("button", { class: "small", onclick: () => this.add(String(p.number)) }, "+ add")))));
    return box;
  }

  toggle(open = !this.open) { this.open = open; this.render(); }

  /** One bar for all sources: fetching, then decoding (every enabled source over the recording), then what fits. */
  combined() {
    const list = this.sources();
    const fetching = list.filter((s) => s.enabled && s.state === "fetching").length;
    const st = app.decoder?.status();
    let done = 0, total = 0, busySources = 0;
    for (const s of st?.build?.sources || []) { done += s.decoded; total += s.decoded + s.pending; if (s.pending) busySources++; }
    if (fetching) return h("span", { class: "combined busy", title: "the device fetches the sources from GitHub" }, h("span", { class: "spinner" }), ` fetching ${fetching} source${fetching === 1 ? "" : "s"}…`);
    if (app.compileState?.busy) return h("span", { class: "combined busy" }, h("span", { class: "spinner" }), ` ${app.compileState.text}`);
    if (total && done < total) {
      const pct = Math.round((done / total) * 100);
      return h("span", { class: "combined busy", title: `${fmt.count(done)} of ${fmt.count(total)} telegram decodings done (${busySources} source${busySources === 1 ? "" : "s"} still decoding)` },
        h("span", { class: "progress" }, h("span", { class: "fill", style: `width:${Math.max(2, pct)}%` })), ` decoding ${pct} %`);
    }
    if (!st?.build) return null;
    return h("span", { class: "combined", title: `${fmt.count(st.known)} of ${fmt.count(st.telegrams)} distinct telegrams known to ebusd` }, `${fmt.count(st.definitions)} definitions fit your bus`);
  }

  /** A source as a word in the folded strip: its label, a spinner while it decodes. */
  miniChip(s) {
    const decoded = app.decoder?.status().build?.sources.find((x) => x.id === s.id) || null;
    const built = app.decoder?.source(s.id) || null;
    const bad = s.state === "error" || built?.error;
    return h("span", { class: `src mini ${bad ? "err" : ""}`, title: [`${s.label} (${s.id})`, s.title ? `“${s.title}”` : "", bad ? `error: ${s.error || built?.error}` : "", built?.delta ? `+${built.delta.added.length} new, ${built.delta.changed.length} changed` : ""].filter(Boolean).join("\n") },
      decoded?.pending || s.state === "fetching" ? h("span", { class: "spinner" }) : null, h("b", {}, s.label));
  }

  render() {
    const root = this.root;
    if (!root) return;
    const list = this.sources();
    const fold = h("button", { class: "fold small", title: this.expanded ? "fold the sources into one line" : "show every source with its state", onclick: () => { this.expanded = !this.expanded; remember("workbench.sourcesOpen", this.expanded); this.render(); } }, this.expanded ? "▾" : "▸");
    const label = h("span", { class: "muted lbl", title: "every source is a complete set of definitions, decoded side by side; untick one to leave it out" }, "Definitions from");
    const add = h("button", { class: `small ${this.open ? "active" : ""}`, onclick: () => this.toggle() }, this.open ? "− add" : this.expanded ? "+ add a pull request or repository" : "+ add");
    const none = !list.length && !app.status?.sources ? null : !list.length ? h("span", { class: "warn" }, "no sources yet: add ebusd's definitions with “release”") : null;
    let row;
    if (this.expanded) {
      row = h("div", { class: "src-row" }, fold, label, list.map((s) => this.chip(s)), this.mineChip(), add, none);
    } else {
      const on = list.filter((s) => s.enabled), off = list.length - on.length;
      const lines = (app.settings?.custom || "").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
      row = h("div", { class: "src-row folded" }, fold, label, on.map((s) => this.miniChip(s)),
        off ? h("span", { class: "muted", title: "sources left out (unfold to tick them)" }, `+${off} off`) : null,
        lines ? h("span", { class: "src mini", title: KIND_HELP.mine }, h("b", {}, "my definitions"), h("span", { class: "muted" }, ` ${lines}`)) : null,
        this.combined(), add, none);
    }
    root.replaceChildren(row, this.open ? this.addPanel() : "");
  }
}
