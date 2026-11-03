// Where definitions come from. The device fetches every source as one snapshot from GitHub (no
// git): ebusd's own definitions (the release at ebus.github.io), the upcoming release, every open
// pull request of ebusd-configuration, and pull requests or branches you add. Ready-made CSV trees
// are parsed as they are; TypeSpec sources are compiled to CSV here in the browser (cached per
// commit). Every source's lines go into the core's pool (parsed once per commit, kept in the browser
// store), where a line is a candidate for the messages it fits, whatever source it came from.
//
// This module keeps the pool in step with the sources (a source arrives, is refreshed, enabled or
// removed; the open pull requests change) and draws the strip at the top of the page.
import { api, app, append, bus, fmt, h, toast, refreshStatus } from "./app.js";
import { POOL_RULES, parseFiles } from "./pool.js";
import { MINE } from "./core.js";

const KIND_HELP = {
  cdn: "ready-made CSV files from ebus.github.io, exactly what ebusd loads",
  pr: "a pull request of john30/ebusd-configuration: TypeSpec sources, compiled here in the browser",
  repo: "a branch of another GitHub repository: TypeSpec sources compiled here, or CSV files as they are",
  mine: "your own definition lines (My definitions in the setup column), checked on the messages they fit",
};
const RULES = "p1";   // the pool's reading of a tree is part of its stamp: a changed rule parses everything again, once
const stampOf = (s) => `${s.id}@${s.head || s.fetched_at || ""}@${s.digest || ""}@${RULES}`;
const POLL_MS = 3000;

/** Keeps the core's pool in step with the sources: fetched trees, compiled pull requests, your own lines. */
export class Sources {
  constructor() {
    this.state = { busy: false, text: "", error: null };
    this.busy = false;
    this.again = false;
    this.lastKey = null;
    this.timer = null;
    this.tsp = null;
    this.pulls = null;         // the open pull requests of ebusd-configuration as the device lists them
    this.pullState = {};       // id -> "fetching" | "compiling" | "ready" | "error"
    this.sweeping = false;
    this.sweepAgain = false;
  }

  setState(state) { this.state = { busy: false, text: "", error: null, ...state }; bus.emit("compile-state", this.state); }

  /** The list of sources changed on the device (a fetch finished, one was enabled or removed): build again. */
  onStatus(status) {
    const list = status?.sources?.sources || [];
    const key = `${status?.sources?.language || "en"}|` + list.filter((s) => s.state === "ready").map((s) => `${stampOf(s)}:${s.enabled ? 1 : 0}`).join(",");
    if (key !== this.lastKey) { this.lastKey = key; this.schedule(); }
    if (!this.pulls && !this.sweeping) this.sweepPulls();
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
      if (cached?.outputs) return { outputs: cached.outputs, summary: cached.summary, partial: !!cached.partial, cached: true };
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

  /** An entry file that imports only the TypeSpec files a pull request changes (from GitHub's list), or null. */
  async partialEntry(source, files) {
    try {
      const { files: changed } = await api.get(`api/sources/changes?id=${encodeURIComponent(source.id)}`);
      const paths = [...new Set(changed.map((f) => f.path).filter((p) => p.startsWith("src/") && p.endsWith(".tsp") && !/(^|\/)(main|_templates)\.tsp$/.test(p)).map((p) => p.slice(4)))].filter((p) => files[p] !== undefined);
      if (!paths.length) return null;
      return { entry: "__workbench_changes.tsp", count: paths.length, text: paths.map((p) => `import "./${p}";`).join("\n") + "\n" };
    } catch (err) { console.warn(`changed files of ${source.id}:`, err); return null; }
  }

  /** The files of a source as a CSV tree (compiled if need be): {files, summary, partial}. */
  async loadTree(s, stamp, { quiet = false } = {}) {
    const cached = await this.cachedCompile(stamp);
    if (cached) return { files: cached.outputs, summary: cached.summary, partial: cached.partial };
    const data = await api.get(`api/sources/files?id=${encodeURIComponent(s.id)}`);
    if (data.kind === "tsp") {
      const compiled = await this.compile(s, stamp, data.files, { quiet });
      return { files: compiled.outputs, summary: compiled.summary, partial: compiled.partial };
    }
    return { files: data.files, summary: `${Object.keys(data.files).length} CSV files`, partial: false };
  }

  async cachedCompile(stamp) {
    try { const c = await app.decoder.store.get("compiles", `tsp:${stamp}`); return c?.outputs ? { outputs: c.outputs, summary: c.summary, partial: !!c.partial, cached: true } : null; } catch { return null; }
  }

  /** Every registered source (release, next, the ones you added) into the pool; the primary's files for its run over the recording. */
  async rebuild() {
    const core = app.decoder;
    if (!core) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      await core.ready;
      const list = (app.status?.sources?.sources || []).filter((s) => s.state === "ready");
      for (const s of list) {
        const stamp = stampOf(s);
        const info = { id: s.id, label: s.label, kind: s.kind, stamp, head: s.head || null, title: s.title || null, url: s.url || null, enabled: !!s.enabled };
        const current = core.source(s.id);
        if (!current || current.stamp !== stamp || !core.pool.sources.has(s.id) && s.enabled) {
          const stored = await core.store.get("pool", `${stamp}@${POOL_RULES}`).catch(() => null);
          if (stored) await core.addSource(info, null, null);
          else {
            this.setState({ busy: true, text: `loading ${s.label}…` });
            try {
              const tree = await this.loadTree(s, stamp);
              await core.addSource({ ...info, summary: tree.summary, partial: tree.partial }, parseFiles(tree.files), tree.files);
            } catch (err) { console.error(err); await core.addSource({ ...info, error: err.message }, null, null); }
          }
        } else if (current.enabled !== !!s.enabled) await core.setSourceEnabled(s.id, !!s.enabled);
        // the full tree of the primary, for ebusd's own run over the recording and the scan
        if (core.needsFiles(s.id)) {
          this.setState({ busy: true, text: `loading the files of ${s.label}…` });
          try { const tree = await this.loadTree(s, stamp); await core.provideFiles(s.id, tree.files); } catch (err) { console.warn(err); }
        }
      }
      for (const id of [...core.sourceInfo.keys()]) if (!list.some((s) => s.id === id) && !/^pr\//.test(id) && id !== MINE) core.removeSource(id);
      await core.setMine(app.settings?.custom || "");
      const errors = core.sources().filter((s) => s.error);
      this.setState({ busy: false, text: "", error: errors.length ? errors.map((s) => `${s.label}: ${s.error}`).join("; ") : null });
    } catch (err) {
      console.error(err);
      this.setState({ busy: false, error: `building the definitions failed: ${err.message}` });
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.schedule(); }
    }
  }

  /** Every open pull request of ebusd-configuration into the pool: fetched by the device, compiled here, once per commit. */
  async sweepPulls() {
    if (this.sweeping) { this.sweepAgain = true; return; }
    this.sweeping = true;
    const core = app.decoder;
    try {
      await core.ready;
      const registered = new Set((app.status?.sources?.sources || []).map((s) => s.id));
      const suggest = await api.get("api/sources/suggest");
      this.pulls = (suggest.pulls || []).filter((p) => p.number && !p.draft);
      const numbers = this.pulls.map((p) => p.number).filter((n) => !registered.has(`pr/${n}`));
      bus.emit("sources-changed");
      if (!numbers.length) return;
      const disabled = new Set(app.settings?.ui?.disabledPulls || []);
      let summaries = (await api.post("api/sources/prefetch", { numbers })).sources;
      const t0 = Date.now();
      const done = new Set();
      while (Date.now() - t0 < 10 * 60_000) {
        for (const s of summaries) {
          if (done.has(s.id)) continue;
          if (s.state === "fetching" || s.state === "missing") { this.pullState[s.id] = "fetching"; continue; }
          done.add(s.id);
          if (s.state !== "ready") { this.pullState[s.id] = "error"; continue; }
          const pull = this.pulls.find((p) => `pr/${p.number}` === s.id) || {};
          const stamp = stampOf(s);
          const info = { id: s.id, label: s.label || `PR ${pull.number}`, kind: "pr", stamp, head: s.head || null, title: s.title || pull.title || null, url: s.url || pull.url || null, author: s.author || pull.author, updated: s.updated_at || pull.updated_at, enabled: !disabled.has(s.id) };
          if (core.source(s.id)?.stamp === stamp) { this.pullState[s.id] = "ready"; continue; }
          const stored = await core.store.get("pool", `${stamp}@${POOL_RULES}`).catch(() => null);
          if (stored) { await core.addSource(info, null, null); this.pullState[s.id] = "ready"; continue; }
          this.pullState[s.id] = "compiling";
          bus.emit("sources-changed");
          try {
            const tree = await this.loadTree(s, stamp, { quiet: true });
            await core.addSource({ ...info, summary: tree.summary, partial: tree.partial }, parseFiles(tree.files), tree.files);
            this.pullState[s.id] = "ready";
          } catch (err) { console.warn(err); await core.addSource({ ...info, error: err.message }, null, null); this.pullState[s.id] = "error"; }
          bus.emit("sources-changed");
        }
        if (done.size >= summaries.length) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
        summaries = (await api.post("api/sources/prefetch", { numbers })).sources;
      }
    } catch (err) {
      console.warn("the open pull requests could not be loaded:", err);
      this.pullsError = err.message;
    } finally {
      this.sweeping = false;
      bus.emit("sources-changed");
      if (this.sweepAgain) { this.sweepAgain = false; this.sweepPulls(); }
    }
  }

  /** A pull request of the sweep ticked off or on (remembered in the settings). */
  async enablePull(id, on) {
    const disabled = new Set(app.settings?.ui?.disabledPulls || []);
    if (on) disabled.delete(id); else disabled.add(id);
    try { app.settings = await api.put("api/settings", { ui: { ...(app.settings?.ui || {}), disabledPulls: [...disabled] } }); } catch (err) { toast(err.message, "err"); }
    await app.decoder.setSourceEnabled(id, on);
    bus.emit("sources-changed");
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
    this.pullsOpen = false;     // the list of the open pull requests
    this.input = "";
    bus.on("status", () => this.render());
    bus.on("sources-changed", () => this.render());
    bus.on("decodes-changed", (reason) => { if (reason !== "progress") this.schedule(); });
    bus.on("compile-state", () => this.render());
    this.render();
  }

  /** Draw again, at most every second while decodings stream in. */
  schedule() { if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.render(); }, 1000); }

  registered() { return app.status?.sources?.sources || []; }

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

  /** The count of definitions of a source that fit the bus. */
  fits(id) { return app.decoder?.status().sources.find((x) => x.id === id)?.definitions || 0; }

  chip(s) {
    const built = app.decoder?.source(s.id) || null;
    const parts = [];
    let cls = "src";
    if (!s.enabled) { cls += " off"; parts.push("off"); }
    else if (s.state === "fetching") { cls += " busy"; parts.push("fetching…"); }
    else if (s.state === "error") { cls += " err"; parts.push("failed"); }
    else if (s.state === "missing") { cls += " warn"; parts.push("not fetched"); }
    else if (built?.error) { cls += " err"; parts.push("compile failed"); }
    else if (!built) { cls += " busy"; parts.push("loading…"); }
    else parts.push(`${fmt.count(this.fits(s.id))} fit your bus`);
    const title = [`${s.label} (${s.id})`, KIND_HELP[s.kind] || "", s.title ? `“${s.title}”` : "", s.head ? `commit ${s.head.slice(0, 7)}` : "", s.fetched_at ? `fetched ${fmt.dateTime(s.fetched_at * 1000)}` : "",
      s.error ? `error: ${s.error}` : "", built?.error ? `compile: ${built.error}` : "", built?.summary || ""].filter(Boolean).join("\n");
    const toggle = h("input", { type: "checkbox", checked: !!s.enabled, title: s.enabled ? "leave this source out" : "use this source", onchange: () => this.enable(s.id, toggle.checked) });
    return h("span", { class: cls, title },
      toggle,
      cls.includes("busy") ? h("span", { class: "spinner" }) : null,
      h("b", {}, s.label),
      s.kind !== "cdn" && s.title ? h("span", { class: "muted t" }, s.title.length > 48 ? `${s.title.slice(0, 47)}…` : s.title) : null,
      h("span", { class: "muted" }, parts.join(" · ")),
      built?.partial ? h("span", { class: "tbadge warn", title: "its base is older than today's TypeSpec library: only the files the pull request changes are compiled" }, "partial") : null,
      s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener", title: "open on GitHub", class: "muted" }, "↗") : null,
      h("a", { href: "#", class: "muted", title: "fetch again (it may have been updated)", onclick: (e) => { e.preventDefault(); this.refresh(s.id); } }, "↻"),
      s.kind !== "cdn" ? h("a", { href: "#", class: "err", title: "remove this source", onclick: (e) => { e.preventDefault(); if (confirm(`Remove ${s.label}?`)) this.remove(s.id); } }, "✕") : null);
  }

  /** The open pull requests of ebusd-configuration as one chip, with the list of them when unfolded. */
  pullsChip() {
    const b = app.builder;
    const pulls = b?.pulls || [];
    const registered = new Set(this.registered().map((s) => s.id));
    const auto = pulls.filter((p) => !registered.has(`pr/${p.number}`));
    const states = auto.map((p) => b.pullState[`pr/${p.number}`] || "fetching");
    const busy = states.filter((s) => s === "fetching" || s === "compiling").length;
    const ready = states.filter((s) => s === "ready").length;
    const core = app.decoder;
    const fits = auto.reduce((n, p) => n + this.fits(`pr/${p.number}`), 0);
    const chip = h("span", { class: `src pulls ${busy ? "busy" : ""} ${this.pullsOpen ? "active" : ""}`, title: "every open pull request of john30/ebusd-configuration, compiled here once per commit: its lines are candidates with a PR badge wherever they fit", onclick: (e) => { if (e.target.closest("input, a")) return; this.pullsOpen = !this.pullsOpen; this.render(); } },
      busy ? h("span", { class: "spinner" }) : null, h("b", {}, "open pull requests"),
      h("span", { class: "muted" }, b?.pullsError ? "could not be listed" : !pulls.length ? "listing…" : busy ? `${ready} of ${auto.length} ready` : `${auto.length} · ${fmt.count(fits)} fit your bus`),
      h("span", { class: "fold" }, this.pullsOpen ? "▾" : "▸"));
    if (!this.pullsOpen) return chip;
    const disabled = new Set(app.settings?.ui?.disabledPulls || []);
    const list = h("div", { class: "pulls" }, auto.sort((a, b2) => this.fits(`pr/${b2.number}`) - this.fits(`pr/${a.number}`) || String(b2.updated_at).localeCompare(String(a.updated_at))).map((p) => {
      const id = `pr/${p.number}`;
      const state = b.pullState[id] || "fetching";
      const src = core?.source(id);
      const toggle = h("input", { type: "checkbox", checked: !disabled.has(id), title: disabled.has(id) ? "use this pull request" : "leave this pull request out", onchange: () => b.enablePull(id, toggle.checked) });
      return h("div", { class: `pull ${this.fits(id) ? "fits" : ""}` }, toggle,
        h("a", { href: p.url || "#", target: "_blank", rel: "noopener", class: "mono" }, `#${p.number}`),
        h("span", { class: "title", title: p.title }, p.title),
        h("span", { class: "muted" }, `${p.author || ""} · ${String(p.updated_at || "").slice(0, 10)}`),
        state === "error" || src?.error ? h("span", { class: "err", title: src?.error || "" }, "failed") : state !== "ready" ? h("span", { class: "muted" }, h("span", { class: "spinner" }), ` ${state}…`) : h("span", { class: this.fits(id) ? "ok" : "muted" }, `${fmt.count(this.fits(id))} fit your bus`),
        src?.partial ? h("span", { class: "tbadge warn", title: "only the files it changes are compiled: its base is older than today's TypeSpec library" }, "partial") : null,
        h("button", { class: "small", title: "keep it as a source of its own (its definitions stay even when it is merged or closed)", onclick: () => this.add(String(p.number)) }, "+ keep"));
    }));
    return [chip, list];
  }

  mineChip() {
    const lines = (app.settings?.custom || "").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
    return h("span", { class: "src", title: `${KIND_HELP.mine}\n${lines} definition line${lines === 1 ? "" : "s"}` },
      h("b", {}, "my definitions"), h("span", { class: "muted" }, lines ? `${lines} line${lines === 1 ? "" : "s"} · ${fmt.count(this.fits(MINE))} fit your bus` : "none yet: start one in the inspector"));
  }

  addPanel() {
    const input = h("input", { type: "text", size: 34, value: this.input, placeholder: "660 · owner/repo#branch · GitHub URL", title: "a pull request number of john30/ebusd-configuration (kept as a source of its own), a repository as owner/name (optionally #branch), or a GitHub URL of either",
      oninput: () => { this.input = input.value; }, onkeydown: (e) => { if (e.key === "Enter") this.add(input.value); } });
    return h("div", { class: "src-add" },
      h("div", { class: "row" }, h("b", {}, "Add a source"), input, h("button", { class: "small primary", onclick: () => this.add(input.value) }, "Add"),
        h("span", { class: "hint" }, "The open pull requests are in already; add one here to keep it after it is merged or closed, or a branch of another repository. Everything is compiled in your browser; nothing is merged anywhere."),
        h("button", { class: "small", onclick: () => this.toggle(false) }, "close")));
  }

  toggle(open = !this.open) { this.open = open; this.render(); }

  /** One bar for everything going on: fetching, compiling, ebusd's run over the recording, the messages being checked. */
  combined() {
    const list = this.registered();
    const fetching = list.filter((s) => s.enabled && s.state === "fetching").length;
    const st = app.decoder?.status();
    const b = app.builder;
    const busyPulls = Object.values(b?.pullState || {}).filter((s) => s === "fetching" || s === "compiling").length;
    if (fetching) return h("span", { class: "combined busy", title: "the device fetches the sources from GitHub" }, h("span", { class: "spinner" }), ` fetching ${fetching} source${fetching === 1 ? "" : "s"}…`);
    if (app.compileState?.busy) return h("span", { class: "combined busy" }, h("span", { class: "spinner" }), ` ${app.compileState.text}`);
    if (busyPulls) return h("span", { class: "combined busy", title: "the open pull requests are fetched by the device and compiled here, once per commit" }, h("span", { class: "spinner" }), ` preparing ${busyPulls} pull request${busyPulls === 1 ? "" : "s"}…`);
    const primary = st?.sources.find((s) => s.id === st.primary);
    if (primary?.pending) {
      const pct = Math.round(((st.telegrams - primary.pending) / Math.max(1, st.telegrams)) * 100);
      return h("span", { class: "combined busy", title: `${fmt.count(st.telegrams - primary.pending)} of ${fmt.count(st.telegrams)} telegrams decoded with ${primary.label}` },
        h("span", { class: "progress" }, h("span", { class: "fill", style: `width:${Math.max(2, pct)}%` })), ` ${primary.label} ${pct} %`);
    }
    if (st?.queue) return h("span", { class: "combined busy", title: "messages whose candidates are being checked with ebusd's library, the open one first" }, h("span", { class: "spinner" }), ` checking ${fmt.count(st.queue)} message${st.queue === 1 ? "" : "s"}…`);
    if (!st?.build) return null;
    return h("span", { class: "combined", title: `${fmt.count(st.known)} of ${fmt.count(st.telegrams)} distinct telegrams known to ebusd` }, `${fmt.count(st.definitions)} definitions fit your bus`);
  }

  miniChip(s) {
    const built = app.decoder?.source(s.id) || null;
    const bad = s.state === "error" || built?.error;
    return h("span", { class: `src mini ${bad ? "err" : ""}`, title: [`${s.label} (${s.id})`, s.title ? `“${s.title}”` : "", bad ? `error: ${s.error || built?.error}` : "", `${fmt.count(this.fits(s.id))} definitions fit your bus`].filter(Boolean).join("\n") },
      s.state === "fetching" ? h("span", { class: "spinner" }) : null, h("b", {}, s.label));
  }

  render() {
    const root = this.root;
    if (!root) return;
    const list = this.registered();
    const fold = h("button", { class: "fold small", title: this.expanded ? "fold the sources into one line" : "show every source with its state", onclick: () => { this.expanded = !this.expanded; remember("workbench.sourcesOpen", this.expanded); this.render(); } }, this.expanded ? "▾" : "▸");
    const label = h("span", { class: "muted lbl", title: "every source's lines are candidates for the messages they fit, with the source as a badge; untick one to leave it out" }, "Definitions from");
    const add = h("button", { class: `small ${this.open ? "active" : ""}`, onclick: () => this.toggle() }, this.open ? "− add" : this.expanded ? "+ add a pull request or repository" : "+ add");
    const none = !list.length && !app.status?.sources ? null : !list.length ? h("span", { class: "warn" }, "no sources yet: add ebusd's definitions with “release”") : null;
    let row;
    if (this.expanded) {
      row = h("div", { class: "src-row" }, fold, label, list.map((s) => this.chip(s)), this.pullsChip(), this.mineChip(), add, none);
    } else {
      const on = list.filter((s) => s.enabled), off = list.length - on.length;
      const pulls = (app.builder?.pulls || []).length;
      row = h("div", { class: "src-row folded" }, fold, label, on.map((s) => this.miniChip(s)),
        off ? h("span", { class: "muted", title: "sources left out (unfold to tick them)" }, `+${off} off`) : null,
        pulls ? h("span", { class: "src mini", title: "the open pull requests of ebusd-configuration (unfold for the list)" }, h("b", {}, "pull requests"), h("span", { class: "muted" }, ` ${pulls}`)) : null,
        h("span", { class: "src mini", title: KIND_HELP.mine }, h("b", {}, "mine"), h("span", { class: "muted" }, ` ${fmt.count(this.fits(MINE))}`)),
        this.combined(), add, none);
    }
    root.replaceChildren(row, this.open ? this.addPanel() : "");
  }
}
