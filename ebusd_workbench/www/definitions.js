// Definitions: the git repository with TypeSpec sources, an editor, compile (TypeSpec -> CSV in
// the browser), the decodings of the recording (every candidate definition per telegram, kept in
// the browser store by decoder.js), the setup of the definitions that fit this installation,
// exports (CSV files for the eBUSd app, Home Assistant entities, ebusd raw log for ebus-evidence)
// and ebus-evidence profile checks.
import { api, app, append, bus, fmt, h, toast, refreshStatus } from "./app.js";
import { messageColors, telegramValue, valueColors } from "./colors.js";
import { generateEbusdOptions, generateHaYaml } from "./hayaml.js";
import { describeMatch, fmtTime, parseAddressMap, runProfile, summaryJson } from "./evidence.js";
import { accessKind, locateSource } from "./compare.js";
import { setup } from "./setup.js";

const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const VIEWS = [["sources", "1 · Sources"], ["results", "2 · Live decoding"], ["setup", "3 · Choose"], ["editor", "4 · Edit"], ["export", "5 · Summary & save"], ["evidence", "Evidence"]];
const STEP_HELP = {
  sources: "Where definitions come from: a repository (the default ebusd-configuration or your own), community pull requests, other repositories, and definitions you write yourself. They are compiled in your browser and decode your recorded telegrams.",
  results: "Every distinct telegram of the recording, decoded by every matching definition as it arrives, newest first. The same decodings are in the timeline.",
  setup: "All definitions that matched your telegrams, hidden ones included. Tick the ones for your installation and name them the way you want them in your config.",
  editor: "The TypeSpec sources of the definitions. Saving recompiles and decodes the whole recording again. To write a definition of your own, add it as an own definition in Sources or from a candidate in the timeline.",
  export: "What you chose, where each definition comes from and how it fared on your recording. Save it as CSV files for the eBUSd app, together with a record of its sources.",
  evidence: "Checks of ebus-evidence profiles against your recording, and the raw log export for the research.",
};
const DEFAULT_REPO = "https://github.com/john30/ebusd-configuration.git";
const STATUS_HELP = {
  active: "ebusd uses this definition for this installation (file chosen by the scan, condition met)",
  variant: "definition from a file of another device variant (ebusd would not load it); it decodes the recorded telegrams",
  conditional: "definition whose condition was not met by the recorded telegrams; it decodes them nevertheless",
  hidden: "definition in the file ebusd loads, but another definition takes precedence",
  error: "definition matches the telegram but cannot decode it (wrong length or values)",
  companion: "not seen on the bus: the counterpart of a seen definition (same name, other direction, usually for writing)",
  custom: "your own definition: decoded over the whole recording like the others, but never chosen automatically",
};

function chip(circuit, name, extra = "") {
  const c = messageColors(circuit, name);
  return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit ? circuit + " " : ""}${name}${extra}`);
}

function swatch(value, status) {
  const c = valueColors(value, status);
  return h("span", { class: "swatch", style: `background:${c.fill};border-color:${c.stroke}` });
}

function download(name, text, type = "text/plain") {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("copied"); } catch { toast("copy failed: select the text and copy it", "err"); }
}

export class Definitions {
  constructor(root) {
    this.root = root;
    this.tree = [];
    this.repo = null;
    this.openDirs = new Set(["src"]);
    this.file = null;
    this.content = "";
    this.dirty = false;
    this.layers = [];
    this.view = "sources";
    this.dirtyViews = new Set();
    this.evidenceRun = null;
    this.compiling = false;
    this.autoCompiled = false;
    this.setupFilter = "";
    this.mounts = new Set();        // containers that show the sources panel (the Sources step, the timeline's popover)
    this.compileMessage = null;     // {text, cls} of the last compile
    this.diagList = [];
    this.customDraft = null;
    this.cloneUrl = "";
    this.layerMessage = "";
    this.build();
    bus.on("status", (status) => {
      const busy = status.repo?.busy || null;
      const wasBusy = this.repo?.busy || null;
      if (status.repo?.exists !== this.repo?.exists || (wasBusy && !busy)) this.refresh();
      else if (JSON.stringify(busy) !== JSON.stringify(wasBusy) && this.repo) { this.repo.busy = busy; this.renderRepo(); this.renderSources(); }
      else if (status.repo?.error !== this.repo?.error && this.repo) { this.repo.error = status.repo.error; this.renderSources(); }
    });
    setInterval(() => { for (const el of document.querySelectorAll("[data-since]")) el.textContent = fmt.duration(Date.now() - Number(el.dataset.since)); }, 1000);
    bus.on("decodes-changed", (reason) => { this.updateDecodeStatus(); if (reason !== "progress") { this.setCounts(); this.refreshViews(); } });
    bus.on("setup-changed", () => { this.setCounts(); this.refreshViews(["setup", "export"]); });
    bus.on("show-view", (id) => this.showView(id));
    bus.on("show-definition", (key) => { const def = app.decoder?.def(key); this.setupFilter = def ? `${def.circuit} ${def.name}` : ""; this.dirtyViews.add("setup"); this.showView("setup"); });
    bus.on("open-source", (def) => this.openSource(def));
    this.refresh();
  }

  onShow() { if (!this.repo) this.refresh(); if (this.dirtyViews.has(this.view)) this.renderView(this.view); }

  /** The decodings of the recording, from the browser store. */
  get entries() { return app.decoder?.entries || []; }

  setCounts() {
    const d = app.decoder;
    this.setCount("results", d && d.telegrams.size ? fmt.count(d.telegrams.size) : "");
    this.setCount("setup", this.entries.length ? `${setup.includedKeys(this.entries).length}/${this.entries.length}` : "");
  }

  // -- layout ----------------------------------------------------------------------

  build() {
    const el = (this.el = {});
    el.repo = h("div", { class: "repo" });
    el.tree = h("div", { class: "tree" });
    el.build = h("div", { class: "build" });
    el.stephint = h("div", { class: "stephint" });
    el.subtabs = h("div", { class: "subtabs" }, VIEWS.map(([id, label]) => h("button", { "data-view": id, class: id === this.view ? "active" : "", onclick: () => this.showView(id) }, label, h("span", { class: "count" }))));
    el.panes = {};
    for (const [id] of VIEWS) el.panes[id] = h("div", { class: `pane ${id === this.view ? "active" : ""}` });
    this.buildEditor();
    el.panes.sources.appendChild(h("div", { class: "sources" }, el.build, el.repo));
    el.center = h("div", { class: "center" }, el.subtabs, el.stephint, ...Object.values(el.panes));
    this.root.appendChild(h("div", { class: "defs" }, el.center));
    el.stephint.textContent = STEP_HELP[this.view];
    this.mounts.add(el.build);
    this.renderSources();
    this.renderResults();
    this.renderSetup();
    this.renderExport();
    this.renderEvidence();
    this.setCounts();
  }

  showView(id) {
    this.view = id;
    for (const button of this.el.subtabs.querySelectorAll("button")) button.classList.toggle("active", button.dataset.view === id);
    for (const [key, pane] of Object.entries(this.el.panes)) pane.classList.toggle("active", key === id);
    this.el.stephint.textContent = STEP_HELP[id] || "";
    if (id === "export") this.renderExport();
    if (this.dirtyViews.has(id)) this.renderView(id);
  }

  /** Re-render the views that show decodings; only the visible one right away, the others when shown. */
  refreshViews(views = ["results", "setup", "export"]) {
    for (const id of views) this.dirtyViews.add(id);
    if (this.root.classList.contains("active")) this.renderView(this.view);
  }

  renderView(id) {
    this.dirtyViews.delete(id);
    if (id === "results") this.renderResults();
    else if (id === "setup") this.renderSetup();
    else if (id === "export") this.renderExport();
  }

  setCount(id, text) {
    const button = this.el.subtabs.querySelector(`button[data-view="${id}"] .count`);
    if (button) button.textContent = text || "";
  }

  buildEditor() {
    const el = this.el;
    el.path = h("span", { class: "path muted" }, "no file open");
    el.save = h("button", { class: "primary small", disabled: true, onclick: () => this.save() }, "Save");
    el.editorBar = h("div", { class: "editor-bar" }, el.path,
      h("button", { class: "small", onclick: () => this.compile(this.file), title: "compile with the open file as entry" }, "Compile this file"),
      h("button", { class: "small", onclick: () => this.newFile() }, "New file"),
      h("button", { class: "small", onclick: () => this.deleteFile() }, "Delete"),
      el.save);
    el.gutter = h("div", { class: "gutter" });
    el.textarea = h("textarea", { spellcheck: "false", placeholder: "Open a .tsp file from the tree on the left, or load definitions in the Sources step first." });
    el.textarea.addEventListener("input", () => { this.content = el.textarea.value; this.setDirty(true); this.updateGutter(); });
    el.textarea.addEventListener("scroll", () => { el.gutter.scrollTop = el.textarea.scrollTop; });
    el.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: t } = el.textarea;
        el.textarea.setRangeText("  ", s, t, "end");
        this.content = el.textarea.value; this.setDirty(true); this.updateGutter();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); this.save(); }
    });
    el.editor = h("div", { class: "editor" }, el.gutter, el.textarea);
    el.diff = h("pre", { class: "diffview", style: "display:none" });
    append(el.panes.editor, h("div", { class: "editor-layout" }, el.tree, h("div", { class: "editor-main" }, el.editorBar, el.editor, el.diff)));
  }

  // -- repository ------------------------------------------------------------------

  async refresh() {
    try {
      this.repo = await api.get("api/repo");
      this.tree = this.repo.exists ? (await api.get("api/repo/tree")).entries : [];
    } catch (err) { toast(err.message, "err"); return; }
    this.renderRepo();
    this.renderTree();
    this.renderBuild();
    await this.loadLayers();
    this.autoCompile();
  }

  /** Compile at startup when there is a repository but no compile in the browser store yet. */
  async autoCompile() {
    if (this.autoCompiled || !this.repo?.exists) return;
    this.autoCompiled = true;
    await app.decoder?.ready;
    if (!app.decoder?.compile && !this.compiling) this.compile();
  }

  // -- layers: community pull requests and other repositories compiled on top of the checkout -------------

  async loadLayers() {
    if (!this.repo?.exists) { this.layers = []; this.renderSources(); return; }
    try {
      const { layers } = await api.get("api/repo/layers?dir=src");
      this.layers = layers;
    } catch (err) { console.warn(err); this.layers = []; }
    this.renderSources();
  }

  enabledLayers() {
    const enabled = app.settings?.ui?.layersEnabled || {};
    return this.layers.filter((l) => l.fetched && enabled[l.ref] !== false).map((l) => l.ref);
  }

  async setLayerEnabled(ref, on) {
    const ui = { ...(app.settings?.ui || {}) };
    ui.layersEnabled = { ...(ui.layersEnabled || {}), [ref]: on };
    try { app.settings = await api.put("api/settings", { ui }); } catch (err) { toast(err.message, "err"); }
    this.renderSources();
  }

  async addLayer(spec) {
    if (!spec.trim()) return;
    this.layerMessage = `fetching ${spec}…`;
    this.renderSources();
    try {
      const layer = await api.post("api/repo/layers", { ref: spec.trim() });
      this.layerMessage = `fetched ${layer.ref}: ${layer.head?.subject || ""}. Compile to use it.`;
      await this.loadLayers();
    } catch (err) { this.layerMessage = `fetching ${spec} failed: ${err.message}`; this.renderSources(); }
  }

  async removeLayer(ref) {
    try { await api.del(`api/repo/layers/${encodeURIComponent(ref)}`); await this.loadLayers(); } catch (err) { toast(err.message, "err"); }
  }

  layersList() {
    const box = h("div", { class: "layers" });
    const enabled = app.settings?.ui?.layersEnabled || {};
    for (const layer of this.layers) {
      const check = h("input", { type: "checkbox", checked: layer.fetched && enabled[layer.ref] !== false, disabled: !layer.fetched, onchange: () => this.setLayerEnabled(layer.ref, check.checked) });
      const title = layer.fetched ? `${layer.head.short} ${layer.head.subject} — ${layer.head.author}, ${layer.head.date.slice(0, 10)}` : "not fetched";
      append(box, h("label", { title, style: "display:flex;gap:6px;align-items:center;padding:1px 0" }, check,
        h("span", { class: "mono" }, layer.ref.length > 34 ? `${layer.ref.slice(0, 33)}…` : layer.ref),
        h("span", { class: "muted", style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, layer.fetched ? `${layer.changes.length} files: ${layer.head.subject}` : "not fetched"),
        layer.fetched && !layer.common_history ? h("span", { class: "warn", title: "no common history with the checkout (shallow clone?): every difference counts as a change" }, "!") : null,
        h("a", { href: "#", class: "muted", title: "re-fetch", onclick: (e) => { e.preventDefault(); this.addLayer(layer.ref); } }, "↻"),
        h("a", { href: "#", class: "err", title: "remove", onclick: (e) => { e.preventDefault(); this.removeLayer(layer.ref); } }, "✕")));
    }
    if (!this.layers.length) append(box, h("div", { class: "hint" }, "none yet: e.g. 660 (HMU HW5103), 598 (VWZIO), 604"));
    return box;
  }

  async repoAction(action, body, label) {
    const slow = ["fetch", "pull", "push"].includes(action);
    if (slow) {
      // visible right away; the server's own busy state (polled with the status) takes over if the request is cut off
      this.pending = { what: `${label || action}`, since: Date.now() / 1000 };
      this.renderRepo();
      this.renderSources();
      refreshStatus();
    }
    try {
      this.repo = await api.post(`api/repo/${action}`, body);
      this.pending = null;
      toast(`${label || action} done`);
      await this.refresh();
      refreshStatus();
    } catch (err) {
      this.pending = null;
      toast(`${label || action} failed: ${err.message}`, "err", 8000);
      await this.refresh();
    }
  }

  /** Clone in the background (a full clone takes minutes); the status shows the progress and a failure. */
  async cloneRepo(url) {
    url = (url || "").trim();
    if (!url) return toast("enter the URL of a repository", "err");
    try {
      this.repo = await api.post("api/repo/clone", { url, background: true });
      await refreshStatus();
      this.renderSources();
    } catch (err) { toast(`clone failed: ${err.message}`, "err", 8000); }
  }

  /** What to do when there are no definitions yet: the default ones, a repository of your own, or start empty. */
  clonePanel() {
    const r = this.repo || app.status?.repo || {};
    const busy = r.busy || this.pending;
    if (busy) return this.busyBox(busy);
    const upstream = app.settings?.upstream_url || DEFAULT_REPO;
    const url = h("input", { type: "text", placeholder: "https://github.com/<you>/ebusd-configuration.git", value: this.cloneUrl || app.status?.repo_url || "", size: 42, oninput: () => { this.cloneUrl = url.value; } });
    return h("div", { class: "clone" },
      r.error ? h("div", { class: "err", style: "margin-bottom:6px" }, r.error) : null,
      h("div", { class: "hint" }, "No definitions yet: nothing can decode the recorded telegrams. Start with the default definitions, or use a repository of your own (a fork of ebusd-configuration, HTTPS)."),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => this.cloneRepo(upstream) }, "Load the default definitions"), h("span", { class: "muted mono" }, upstream.replace("https://", ""))),
      h("div", { class: "row" }, url, h("button", { onclick: () => this.cloneRepo(url.value) }, "Use this repository")),
      h("div", { class: "row" }, h("button", { onclick: () => this.repoAction("init", {}, "init") }, "Start empty"), h("span", { class: "hint" }, "and write your own definitions (below)")));
  }

  busyBox(busy) {
    return h("div", { class: "busy-box" }, h("span", { class: "spinner" }), h("div", {}, h("b", {}, `${busy.what}…`), " ", h("span", { class: "muted", "data-since": String(Math.round(busy.since * 1000)) }, fmt.duration(Date.now() - busy.since * 1000)),
      h("div", { class: "hint" }, busy.what.startsWith("cloning") ? "A full clone of ebusd-configuration (with its history, needed for the community pull requests) takes a minute or two on a small device. You can leave this page; the timeline shows the progress." : "This can take a moment.")));
  }

  /** The git panel of the Sources step: branch, changes to commit, history. */
  renderRepo() {
    const r = this.repo || {};
    const box = this.el.repo;
    box.replaceChildren();
    if (!r.exists) return;
    const busy = r.busy || this.pending;
    if (busy) append(box, this.busyBox(busy));
    append(box, h("h3", {}, "Git: your checkout"));
    const changes = r.changes || [];
    const checks = new Map();
    const message = h("input", { type: "text", placeholder: "commit message" });
    append(box,
      h("div", { class: "row" }, h("b", {}, r.branch || "(detached)"), h("span", { class: "muted", title: r.remote || "" }, r.upstream ? `↑${r.ahead} ↓${r.behind}` : "no upstream"),
        h("span", { style: "margin-left:auto" }),
        h("button", { class: "small", "data-action": "fetch", title: "git fetch", onclick: () => this.repoAction("fetch") }, "Fetch"),
        h("button", { class: "small", "data-action": "pull", title: "git pull --ff-only", onclick: () => this.repoAction("pull") }, "Pull"),
        h("button", { class: "small", "data-action": "push", title: "git push", onclick: () => this.repoAction("push") }, "Push"),
        h("button", { class: "small", title: "history", onclick: () => this.showLog() }, "Log")),
      r.head ? h("div", { class: "hint", title: r.head.hash }, `${r.head.short} ${r.head.subject} — ${r.head.author}, ${r.head.date.slice(0, 16).replace("T", " ")}`) : null,
      changes.length ? h("div", { class: "changes" }, changes.map((c) => {
        const check = h("input", { type: "checkbox", checked: true });
        checks.set(c.path, check);
        return h("label", {}, check, h("span", { class: `st ${c.status === "?" ? "q" : ""}` }, c.status),
          h("span", { class: "mono", style: "flex:1;overflow:hidden;text-overflow:ellipsis", title: c.path }, c.path),
          h("a", { href: "#", onclick: (e) => { e.preventDefault(); this.showDiff(c.path); } }, "diff"),
          h("a", { href: "#", class: "err", onclick: (e) => { e.preventDefault(); this.discard(c.path); } }, "discard"));
      })) : h("div", { class: "hint" }, "working tree clean"),
      changes.length ? h("div", { class: "row" }, message, h("button", { class: "primary small", "data-action": "commit", onclick: () => {
        const paths = [...checks].filter(([, c]) => c.checked).map(([p]) => p);
        if (!paths.length) return toast("select the files to commit", "err");
        this.repoAction("commit", { message: message.value, paths }, "commit");
      } }, "Commit")) : null);
  }

  async showLog() {
    try {
      const { log } = await api.get("api/repo/log?limit=50");
      this.el.diff.textContent = log.map((e) => `${e.short}  ${e.date.slice(0, 16).replace("T", " ")}  ${e.author}\n    ${e.subject}`).join("\n");
      this.showPane("diff", "git log");
    } catch (err) { toast(err.message, "err"); }
  }

  async showDiff(path) {
    try {
      const { diff } = await api.get(`api/repo/diff?path=${encodeURIComponent(path)}`);
      const pre = this.el.diff;
      pre.replaceChildren(...(diff || "(no differences)").split("\n").map((line) => h("div", {
        class: line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "" }, line)));
      this.showPane("diff", `diff: ${path}`);
    } catch (err) { toast(err.message, "err"); }
  }

  async discard(path) {
    if (!confirm(`Discard the changes of ${path}?`)) return;
    await this.repoAction("discard", { path }, "discard");
    if (this.file === path) this.open(path);
  }

  showPane(which, title) {
    this.showView("editor");
    this.el.editor.style.display = which === "editor" ? "" : "none";
    this.el.diff.style.display = which === "diff" ? "" : "none";
    if (which === "diff") { this.el.path.textContent = title; this.el.save.disabled = true; }
  }

  // -- files -------------------------------------------------------------------------

  renderTree() {
    const tree = this.el.tree;
    tree.replaceChildren();
    if (!this.repo?.exists) return;
    const children = new Map();
    for (const entry of this.tree) {
      const parent = dirname(entry.path);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(entry);
    }
    const dirty = new Set((this.repo.changes || []).map((c) => c.path));
    const render = (parent, depth) => {
      const list = (children.get(parent) || []).slice().sort((a, b) => (a.type === "dir") === (b.type === "dir") ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1);
      for (const entry of list) {
        const name = basename(entry.path);
        const isDir = entry.type === "dir";
        const isDirty = dirty.has(entry.path) || (isDir && [...dirty].some((d) => d.startsWith(entry.path + "/")));
        const node = h("div", { class: `node ${entry.type} ${this.file === entry.path ? "active" : ""} ${isDirty ? "dirty" : ""}`, style: `padding-left:${8 + depth * 14}px`, title: entry.target ? `→ ${entry.target}` : entry.path,
          onclick: () => { if (isDir) { this.openDirs.has(entry.path) ? this.openDirs.delete(entry.path) : this.openDirs.add(entry.path); this.renderTree(); } else this.open(entry.path); } },
          h("span", { class: "ico" }, isDir ? (this.openDirs.has(entry.path) ? "▾" : "▸") : entry.type === "link" ? "↪" : "·"), name);
        tree.appendChild(node);
        if (isDir && this.openDirs.has(entry.path)) render(entry.path, depth + 1);
      }
    };
    render("", 0);
    if (!this.tree.length) tree.appendChild(h("div", { class: "empty" }, "empty repository"));
  }

  async open(path) {
    if (this.dirty && !confirm(`Discard unsaved changes of ${this.file}?`)) return;
    try {
      const { content } = await api.get(`api/repo/file?path=${encodeURIComponent(path)}`);
      this.file = path;
      this.content = content;
      const entry = this.tree.find((e) => e.path === path);
      this.el.textarea.value = content;
      this.el.textarea.readOnly = entry?.type === "link";
      this.el.textarea.classList.toggle("readonly", entry?.type === "link");
      this.el.path.textContent = entry?.type === "link" ? `${path} → ${entry.target} (read only, edit the target)` : path;
      this.setDirty(false);
      this.updateGutter();
      this.showPane("editor");
      this.renderTree();
    } catch (err) { toast(err.message, "err"); }
  }

  setDirty(dirty) {
    this.dirty = dirty;
    this.el.save.disabled = !dirty || !this.file;
    this.el.save.textContent = dirty ? "Save *" : "Save";
  }

  updateGutter() {
    const lines = this.el.textarea.value.split("\n").length;
    this.el.gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
    this.el.gutter.scrollTop = this.el.textarea.scrollTop;
  }

  async save() {
    if (!this.file || !this.dirty) return;
    try {
      await api.put(`api/repo/file?path=${encodeURIComponent(this.file)}`, this.el.textarea.value, { raw: true });
      this.content = this.el.textarea.value;
      this.setDirty(false);
      toast(`saved ${this.file}`);
      await this.refresh();
      refreshStatus();
      if (this.file.endsWith(".tsp") || /\.ya?ml$/.test(this.file)) this.compile();   // the whole recording is decoded again with the new source
    } catch (err) { toast(`save failed: ${err.message}`, "err"); }
  }

  async newFile() {
    if (!this.repo?.exists) return toast("clone or create a repository first", "err");
    const suggestion = this.file ? `${dirname(this.file)}/new.tsp` : "src/new.tsp";
    const path = prompt("Path of the new file:", suggestion);
    if (!path) return;
    try {
      await api.put(`api/repo/file?path=${encodeURIComponent(path)}`, 'import "@ebusd/ebus-typespec";\nusing Ebus;\nusing Ebus.Num;\n\n', { raw: true });
      await this.refresh();
      this.open(path);
    } catch (err) { toast(err.message, "err"); }
  }

  async deleteFile() {
    if (!this.file || !confirm(`Delete ${this.file}?`)) return;
    try {
      await api.del(`api/repo/file?path=${encodeURIComponent(this.file)}`);
      this.file = null; this.el.textarea.value = ""; this.el.path.textContent = "no file open"; this.setDirty(false);
      this.refresh();
    } catch (err) { toast(err.message, "err"); }
  }

  goTo(path, line) {
    const open = this.file === path ? Promise.resolve() : this.open(path);
    return open.then(() => { this.showPane("editor"); this.selectLine(line); });
  }

  // -- sources: repository, layers, own definitions, compile ------------------------------------------------

  renderBuild() { this.renderSources(); }

  /** Show the sources panel in a container (the timeline's popover); it follows every change. */
  mountSources(container, compact = true) {
    container.sourcesCompact = compact;
    this.mounts.add(container);
    container.replaceChildren(this.sourcesPanel(compact));
  }

  unmountSources(container) { this.mounts.delete(container); }

  renderSources() {
    for (const container of [...this.mounts]) {
      if (!container.isConnected && container !== this.el.build) { this.mounts.delete(container); continue; }
      container.replaceChildren(this.sourcesPanel(container === this.el.build ? false : container.sourcesCompact !== false));
    }
    bus.emit("sources-changed");
  }

  currentEntry() {
    const settings = app.settings || {};
    const tspFiles = this.tree.filter((e) => e.path.endsWith(".tsp") && e.type !== "dir").map((e) => e.path);
    if (this.entryChoice && tspFiles.includes(this.entryChoice)) return this.entryChoice;
    return tspFiles.includes(settings.compile?.entry) ? settings.compile.entry : tspFiles.find((p) => p.endsWith("main.tsp")) || tspFiles[0] || "";
  }

  currentTranslations() { return this.translationsChoice ?? app.settings?.compile?.translations ?? ""; }

  sourcesPanel(compact = false) {
    const r = this.repo || app.status?.repo || {};
    const box = h("div", { class: `sources-panel ${compact ? "compact" : ""}` });
    // 1 repository
    append(box, h("h3", {}, "Definitions repository"));
    if (!r.exists) append(box, this.clonePanel());
    else {
      const busy = r.busy || this.pending;
      append(box, busy ? this.busyBox(busy) : null,
        h("div", { class: "row" }, h("b", {}, r.branch || "(detached)"), h("span", { class: "muted", title: r.remote || "" }, r.remote ? r.remote.replace(/^https:\/\//, "") : "local repository"),
          h("span", { style: "margin-left:auto" }),
          h("button", { class: "small", onclick: () => this.repoAction("fetch") }, "Fetch"), h("button", { class: "small", onclick: () => this.repoAction("pull") }, "Pull")),
        r.head ? h("div", { class: "hint", title: r.head.hash }, `${r.head.short} ${r.head.subject} — ${r.head.author}, ${r.head.date.slice(0, 10)}${r.changes?.length ? ` · ${r.changes.length} uncommitted changes` : ""}`) : null);
    }
    // 2 layers
    if (r.exists) {
      const input = h("input", { type: "text", placeholder: "PR number, branch, or repository URL", size: compact ? 24 : 34, title: "660 (a pull request of ebusd-configuration), upstream/master (a branch), or https://github.com/<user>/ebusd-configuration.git#<branch> (a fork)",
        onkeydown: (e) => { if (e.key === "Enter") { this.addLayer(input.value); input.value = ""; } } });
      append(box, h("h3", {}, "Community pull requests and other repositories"),
        h("div", { class: "hint", title: "Their changed files are compiled on top of your checkout, without merging. Decoded definitions show where they come from." }, "Compiled on top of the checkout, without merging:"),
        this.layersList(),
        h("div", { class: "row" }, input, h("button", { class: "small", onclick: () => { this.addLayer(input.value); input.value = ""; } }, "+ add")),
        this.layerMessage ? h("div", { class: "hint" }, this.layerMessage) : null);
    }
    // 3 own definitions
    append(box, h("h3", {}, "Your own definitions"), this.customPanel(compact));
    // 4 compile
    append(box, h("h3", {}, "Compile"), this.compilePanel(compact));
    if (!compact) append(box, this.advancedPanel());
    return box;
  }

  /** Definitions you write or paste yourself (ebusd CSV lines): decoded over the whole recording like any other candidate. */
  customPanel(compact) {
    const d = app.decoder;
    const text = this.customDraft ?? app.settings?.custom ?? "";
    const area = h("textarea", { rows: compact ? 5 : 8, spellcheck: "false", class: "customtext", placeholder: "r,hmu,MyTemp,my temperature,,08,b511,01,temp,s,D2C,,°C,\\nOne ebusd CSV line per message: type,circuit,name,comment,qq,zz,pbsb,id,then fields (name,part,type,divisor,unit,comment). Lines starting with # are comments.\\nTo start from a recorded message, click a row without a definition in the timeline.", oninput: () => { this.customDraft = area.value; } });
    area.value = text;
    const st = d?.customStatus;
    const status = h("div", { class: `hint ${st?.errors ? "err" : st ? "ok" : ""}` }, st ? `${st.messages} definition${st.messages === 1 ? "" : "s"} loaded${st.errors ? `, ${st.errors} error${st.errors === 1 ? "" : "s"}` : ""}${st.stderr?.length ? `: ${st.stderr.slice(0, 3).join(" | ")}` : ""}` : (text.trim() ? "saved" : ""));
    return h("div", {}, area, h("div", { class: "row" },
      h("button", { class: "small primary", onclick: () => this.saveCustom(area.value) }, "Save and decode the recording"), status));
  }

  async saveCustom(text) {
    try {
      app.settings = await api.put("api/settings", { custom: text });
      this.customDraft = null;
      toast("own definitions saved");
      await app.decoder.setCustom(text);
    } catch (err) { toast(err.message, "err"); }
    this.renderSources();
  }

  /** Add one definition line (from the definition editor or a candidate) to the own definitions and decode the recording with it. */
  async addCustomLine(csv) {
    const current = (this.customDraft ?? app.settings?.custom ?? "").trimEnd();
    await this.saveCustom(`${current}${current ? "\n" : ""}${csv.trim()}\n`);
  }

  compilePanel(compact) {
    const settings = app.settings || {};
    const tspFiles = this.tree.filter((e) => e.path.endsWith(".tsp") && e.type !== "dir").map((e) => e.path);
    const yamlFiles = this.tree.filter((e) => /\.ya?ml$/.test(e.path) && e.type !== "dir").map((e) => e.path);
    const compile = app.decoder?.compile;
    const message = this.compileMessage || (compile ? { text: `${compile.summary}${compile.at ? ` (${fmt.dateTime(new Date(compile.at).getTime())})` : ""}`, cls: "ok" } : { text: "TypeSpec → CSV runs in your browser; the device is not involved.", cls: "" });
    const box = h("div", {});
    if (!compact && tspFiles.length) {
      const entry = h("select", { onchange: () => { this.entryChoice = entry.value; } }, tspFiles.map((p) => h("option", { value: p, selected: p === this.currentEntry() }, p)));
      const translations = h("select", { onchange: () => { this.translationsChoice = translations.value; } }, h("option", { value: "" }, "no translation"), yamlFiles.map((p) => h("option", { value: p, selected: p === this.currentTranslations() }, p)));
      append(box, h("div", { class: "row" }, h("label", {}, "entry"), entry), h("div", { class: "row" }, h("label", {}, "i18n"), translations));
    }
    append(box, h("div", { class: "row" }, h("button", { class: "primary small", disabled: !this.repo?.exists || this.compiling, onclick: () => this.compile() }, this.compiling ? "compiling…" : "Compile"), h("div", { class: `hint ${message.cls}` }, message.text)));
    if (!compact) {
      append(box, h("div", { class: "diag" }, this.diagList.slice(0, 100).map((d) => h("div", { class: d.severity, title: d.code || "", onclick: () => d.file && this.goTo(this.compileRoot ? `${this.compileRoot}/${d.file}` : d.file, d.line || 1) }, `${d.file ? `${d.file}:${d.line || "?"} ` : ""}${d.message}`))));
      append(box, this.outputsList());
    }
    return box;
  }

  setCompileMessage(text, cls = "") { this.compileMessage = { text, cls }; this.renderSources(); }

  advancedPanel() {
    this.telegramInput = h("textarea", { rows: 3, style: "width:100%;font-family:var(--mono);font-size:11px", placeholder: "telegrams to decode by hand, one per line: QQZZPBSBNNDD/NNDD, e.g. 1008b5110101/0938…" });
    this.decodeStatus = h("div", { class: "hint" });
    const box = h("details", { class: "advanced" }, h("summary", {}, "Advanced: decoding and the browser store"),
      h("div", { class: "hint" }, "Every distinct telegram of the recording is decoded with every matching definition as it arrives, in this browser (Web Worker), and kept in the browser store with the definition's source."),
      this.decodeStatus,
      h("div", { class: "row" },
        h("button", { class: "small", title: "decode the whole recording again with the current compile", onclick: () => { if (app.decoder?.compile) app.decoder.setCompile(app.decoder.compile); } }, "decode again"),
        h("button", { class: "small", title: "forget the browser-side copy of the recording and its decodings (the database is not touched)", onclick: async () => { if (confirm("Forget the browser store (telegrams, decodings, compile)? It is rebuilt from the database.")) { await app.decoder.reset(); this.renderSources(); } } }, "reset store")),
      this.telegramInput,
      h("div", { class: "row" }, h("button", { class: "small", onclick: () => { const lines = this.telegramInput.value.split("\n").filter((l) => l.trim()); if (!lines.length) return; app.decoder.addManual(lines).then(() => { this.telegramInput.value = ""; this.showView("results"); }); } }, "Decode these too")));
    this.updateDecodeStatus();
    return box;
  }

  updateDecodeStatus() {
    const el = this.decodeStatus;
    if (!el || !el.isConnected) return;
    const st = app.decoder?.status();
    if (!st) { el.textContent = ""; return; }
    if (st.progress) { el.textContent = st.progress; el.className = "hint"; return; }
    if (st.error) { el.textContent = st.error; el.className = "hint err"; return; }
    if (!st.compile) { el.textContent = `${fmt.count(st.telegrams)} distinct telegrams in the browser store; compile to decode them.`; el.className = "hint"; return; }
    const loaded = st.compile.loaded;
    el.textContent = `${loaded ? `${fmt.count(loaded.messages)} definitions loaded${loaded.errors ? ` (${loaded.errors} file errors)` : ""}; ` : ""}${fmt.count(st.known)} of ${fmt.count(st.telegrams)} distinct telegrams known to ebusd, ${fmt.count(st.decoded)} decoded; ${st.active} definitions in use, ${st.definitions - st.active} more candidates${st.lastSync ? `; synced ${fmt.time(st.lastSync)}` : ""} (store: ${st.store})`;
    el.className = loaded?.errors ? "hint err" : "hint ok";
  }

  async loadLibs() {
    if (!this.tsp) {
      this.setCompileMessage("loading the TypeSpec compiler…");
      this.tsp = await import("./vendor/ebus-tsp.js");
    }
  }

  setCompileState(state) {
    this.compileState = state;
    bus.emit("compile-state", state);
  }

  async compile(entryPath = null) {
    const entry = entryPath || this.currentEntry();
    if (!entry) return toast("no .tsp file to compile", "err");
    if (this.compiling) return;
    const translations = this.currentTranslations();
    const root = entry.includes("/") ? entry.slice(0, entry.indexOf("/")) : "";
    const entryRel = root ? entry.slice(root.length + 1) : entry;
    const translationsRel = translations && translations.startsWith(root ? root + "/" : "") ? (root ? translations.slice(root.length + 1) : translations) : "";
    const t0 = performance.now();
    this.compiling = true;
    this.compileRoot = root;
    try {
      this.setCompileState({ busy: true, text: "loading the compiler…" });
      await this.loadLibs();
      this.setCompileMessage("loading sources…");
      this.setCompileState({ busy: true, text: "compiling: loading sources…" });
      const layers = this.enabledLayers();
      const sources = await api.get(`api/repo/sources?dir=${encodeURIComponent(root)}${layers.length ? "&layers=" + encodeURIComponent(layers.join(",")) : ""}`);
      const files = sources.files;
      const applyEditor = (map) => {
        if (this.file && this.dirty) {
          const rel = root ? (this.file.startsWith(root + "/") ? this.file.slice(root.length + 1) : null) : this.file;
          if (rel) map[rel] = this.el.textarea.value;
        }
      };
      applyEditor(files);
      const text = `compiling ${Object.keys(files).length} files${layers.length ? ` with ${layers.join(", ")}` : ""}…`;
      this.setCompileMessage(text);
      this.setCompileState({ busy: true, text });
      const options = { entry: entryRel, translations: translationsRel || undefined };
      const result = await this.tsp.compileEbusTsp(files, options);
      let baseOutputs = null, baseFiles = null;
      const layerFiles = {};
      if (result.ok && layers.length) {
        // the checkout alone, to tell which definitions the layers add
        this.setCompileState({ busy: true, text: "compiling the checkout without layers for comparison…" });
        const base = await api.get(`api/repo/sources?dir=${encodeURIComponent(root)}`);
        applyEditor(base.files);
        baseFiles = base.files;
        const baseResult = await this.tsp.compileEbusTsp(base.files, options);
        baseOutputs = baseResult.ok ? baseResult.outputs : {};
        for (const ref of layers) layerFiles[ref] = (await api.get(`api/repo/layers/files?ref=${encodeURIComponent(ref)}&dir=${encodeURIComponent(root)}`)).files;
      }
      const ms = Math.round(performance.now() - t0);
      const errors = result.diagnostics.filter((d) => d.severity === "error").length;
      const summary = result.ok ? `✓ ${Object.keys(result.outputs).length} files in ${ms} ms${layers.length ? ` with ${layers.join(", ")}` : ""}${result.diagnostics.length ? `, ${result.diagnostics.length} warnings` : ""}${sources.conflicts?.length ? `; ${sources.conflicts.length} files changed by several layers (last wins)` : ""}` : `✗ ${errors} errors, ${result.diagnostics.length - errors} warnings (${ms} ms)`;
      this.diagList = result.diagnostics;
      this.compileMessage = { text: summary, cls: result.ok ? "ok" : "err" };
      app.settings = await api.put("api/settings", { compile: { entry, translations } }).catch(() => app.settings);
      if (result.ok) {
        const record = { id: `${Date.now().toString(36)}`, at: new Date().toISOString(), entry, root, layers, outputs: result.outputs, selected: null, baseOutputs, baseFiles, layerFiles, sourceFiles: files,
          origins: sources.origins || {}, originLayers: sources.origin_layers || {}, conflicts: sources.conflicts || [], summary, warnings: result.diagnostics.length, loaded: null };
        this.setCompileState({ busy: false, text: summary });
        this.compiling = false;
        this.renderSources();
        await app.decoder.setCompile(record);
      } else {
        this.setCompileState({ busy: false, error: summary });
        this.renderSources();
        this.showView("sources");
      }
    } catch (err) {
      console.error(err);
      this.compileMessage = { text: `compile failed: ${err.message}`, cls: "err" };
      this.setCompileState({ busy: false, error: `compile failed: ${err.message}` });
    } finally {
      this.compiling = false;
      this.renderSources();
    }
  }

  outputsList() {
    const record = app.decoder?.compile;
    const list = h("div", { class: "outputs" });
    if (!record?.outputs || !Object.keys(record.outputs).length) return list;
    const names = Object.keys(record.outputs).sort();
    const selected = new Set(record.selected || names);
    const apply = h("button", { class: "small", style: "display:none", onclick: () => app.decoder.selectFiles(selected.size === names.length ? null : [...selected]) }, "decode with these files");
    append(list, h("details", {}, h("summary", {}, `${names.length} compiled files (untick files to leave them out of the decoding)`), apply,
      names.map((name) => {
        const check = h("input", { type: "checkbox", checked: selected.has(name), onchange: () => { check.checked ? selected.add(name) : selected.delete(name); apply.style.display = ""; } });
        return h("label", {}, check, h("span", { class: "mono" }, name), h("span", { class: "size" }, `${record.outputs[name].split("\n").length - 1} lines`));
      })));
    return list;
  }

  // -- from a decoded definition to its source: TypeSpec at the line, or the own definitions ------------------

  /** Open the TypeSpec source of a decoded definition at its line (read only for what only a layer has). */
  async openSource(def) {
    bus.emit("show-tab", "definitions");
    if (def.source === "custom") { this.showView("sources"); setTimeout(() => this.root.querySelector(".customtext")?.focus(), 50); return; }
    const c = app.decoder?.compile;
    const files = def.source === "base" ? (c?.baseFiles || c?.sourceFiles) : c?.sourceFiles;
    if (!files) { toast("compile the definitions first", "err"); this.showView("sources"); return; }
    const loc = locateSource(files, def);
    if (!loc) { toast(`the TypeSpec source of ${def.circuit} ${def.name} was not found (expected in ${def.file.replace(/\.(csv|inc)$/, ".tsp")})`, "err", 6000); return; }
    const root = c.root || "";
    const path = root ? `${root}/${loc.path}` : loc.path;
    this.showView("editor");
    if (def.source === "base" || !this.tree.some((e) => e.path === path) || (c.layers?.length && def.source !== "base")) {
      if (def.source === "base" && this.tree.some((e) => e.path === path)) return this.goTo(path, loc.line);
      return this.openText(path, files[loc.path], loc.line, `${def.source === "base" ? "the checkout's" : `as changed by ${def.source},`} version`);
    }
    return this.goTo(path, loc.line);
  }

  /** Show text that is not (yet) a file of the checkout, read only, with the line selected. */
  async openText(path, text, line, label) {
    if (this.dirty && !confirm(`Discard unsaved changes of ${this.file}?`)) return;
    this.file = null;
    this.content = text;
    this.el.textarea.value = text;
    this.el.textarea.readOnly = true;
    this.el.textarea.classList.add("readonly");
    this.el.path.textContent = `${path} — ${label} (read only: not part of your checkout)`;
    this.setDirty(false);
    this.updateGutter();
    this.showPane("editor");
    this.selectLine(line);
  }

  selectLine(line) {
    const ta = this.el.textarea;
    const lines = ta.value.split("\n");
    const offset = lines.slice(0, Math.max(0, line - 1)).reduce((sum, l) => sum + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(offset, offset + (lines[line - 1] || "").length);
    ta.scrollTop = Math.max(0, (line - 6) * 18);
  }

  // -- decoded telegrams ---------------------------------------------------------------------

  renderResults() {
    const pane = this.el.panes.results;
    pane.replaceChildren();
    const decoder = app.decoder;
    if (!decoder || !decoder.telegrams.size) {
      append(pane, h("div", { class: "empty" }, "The distinct telegrams of the recording appear here as soon as the browser store has read them from the database."));
      return;
    }
    if (!decoder.compile) {
      append(pane, h("div", { class: "empty" }, `${fmt.count(decoder.telegrams.size)} distinct telegrams in the browser store. Compile the definitions (right column) to decode them.`));
      return;
    }
    const filter = h("select", { onchange: () => renderTable() },
      h("option", { value: "all" }, "all telegrams"), h("option", { value: "unknown" }, "unknown to ebusd"), h("option", { value: "candidates" }, "with other candidates"),
      h("option", { value: "errors" }, "decode errors"), h("option", { value: "window" }, "in the timeline window"));
    const search = h("input", { type: "search", placeholder: "filter: hex, circuit, name", oninput: () => renderTable() });
    const body = h("div", { class: "body" });
    const info = h("span", { class: "hint" });
    append(pane, h("div", { class: "bar" }, filter, search, info), body);
    const renderTable = () => {
      const q = search.value.trim().toLowerCase();
      const tl = app.views.timeline;
      const all = decoder.decodedList();
      const rows = all.filter((t) => {
        const map = decoder.decodesOf(t.line);
        const used = decoder.usedDecode(t.line);
        if (filter.value === "unknown" && used) return false;
        if (filter.value === "candidates" && !((map?.size || 0) > (used ? 1 : 0))) return false;
        if (filter.value === "errors" && !(used && used.result !== "ok")) return false;
        if (filter.value === "window" && tl && !(t.last_ms >= tl.t0 && t.first_ms <= tl.t1)) return false;
        if (q && !t.line.includes(q) && !(map && [...map.keys()].some((k) => { const d = decoder.def(k); return d && `${d.circuit} ${d.name} ${setup.exportName(d)}`.toLowerCase().includes(q); }))) return false;
        return true;
      });
      info.textContent = `${fmt.count(rows.length)} of ${fmt.count(all.length)} distinct telegrams, newest decoding first; colours as in the timeline`;
      const table = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "n"), h("th", {}, "last seen"), h("th", {}, "telegram"), h("th", {}, "ebusd uses"), h("th", {}, "decoded"), h("th", {}, "other candidates"))),
        h("tbody", {}, rows.slice(0, 1500).map((t) => {
          const map = decoder.decodesOf(t.line);
          const used = decoder.usedDecode(t.line);
          const usedDef = used ? decoder.def(used.defKey) : null;
          const others = map ? [...map.values()].filter((d) => d !== used) : [];
          return h("tr", {},
            h("td", {}, t.manual ? h("span", { class: "muted" }, "pasted") : fmt.count(t.n)),
            h("td", { class: "mono muted" }, t.last_ms ? fmt.dateTime(t.last_ms).slice(5, 16) : ""),
            h("td", { class: "mono", title: t.line }, swatch(telegramValue(t.master, t.slave, t.status, app.settings), t.status), t.line.length > 40 ? t.line.slice(0, 38) + "…" : t.line),
            h("td", {}, t.compileId !== decoder.compile.id ? h("span", { class: "muted" }, "…") : t.error ? h("span", { class: "err" }, t.error) : !usedDef ? h("span", { class: "warn" }, "unknown") : chip(usedDef.circuit, usedDef.name, usedDef.write ? " (w)" : "")),
            h("td", { class: "mono", style: "white-space:normal" }, used ? (used.result === "ok" ? used.text : h("span", { class: "err" }, used.result)) : ""),
            h("td", { class: "cand" }, others.slice(0, 6).map((d) => { const def = decoder.def(d.defKey); return def ? h("span", { style: "margin-right:4px", title: `${def.file}${def.condition ? " " + def.condition : ""} (${def.status}${def.source !== "base" ? `, ${def.source}` : ""}): ${d.result === "ok" ? d.text : d.result}` },
              chip(def.circuit, def.name, def.write ? " (w)" : ""), d.result !== "ok" ? h("span", { class: "err" }, " ✗") : null) : null; }), others.length > 6 ? ` +${others.length - 6}` : null));
        })));
      body.replaceChildren(table, rows.length > 1500 ? h("div", { class: "hint", style: "padding:6px 10px" }, "showing the first 1500 telegrams") : null);
      const stderr = decoder.compile?.loaded?.stderr || [];
      if (stderr.length) append(body, h("div", { class: "log", style: "margin:8px 10px" }, stderr.join("\n")));
    };
    renderTable();
  }

  // -- setup: the definitions for this installation --------------------------------------------

  renderSetup() {
    const pane = this.el.panes.setup;
    pane.replaceChildren();
    const entries = this.entries;
    if (!entries.length) {
      append(pane, h("div", { class: "empty" }, "Once the recording is decoded, this tab lists every definition that matched a telegram and lets you pick and rename the ones for your installation. The timeline offers the same per row (badge next to the row name)."));
      return;
    }
    const scan = app.decoder.scan || {};
    const statusFilter = h("select", { onchange: () => renderTable() }, h("option", { value: "all" }, "all definitions"), h("option", { value: "active" }, "used by ebusd"),
      h("option", { value: "other" }, "hidden: other file / condition"), h("option", { value: "companion" }, "counterparts not seen (write)"), h("option", { value: "included" }, "included in the setup"), h("option", { value: "renamed" }, "renamed"), h("option", { value: "custom" }, "own definitions"), h("option", { value: "clean" }, "decode every recorded telegram without error"));
    const hideFailing = h("input", { type: "checkbox", checked: !!app.settings?.ui?.hideFailing, onchange: () => setup.setUi("hideFailing", hideFailing.checked) });
    const search = h("input", { type: "search", placeholder: "filter: circuit, name, file", value: this.setupFilter || "", oninput: () => { this.setupFilter = search.value; renderTable(); } });
    const summary = h("span", { class: "hint" });
    const body = h("div", { class: "body" });
    append(pane, h("div", { class: "bar" }, statusFilter, search,
      h("label", { class: "muted", title: "hide definitions that failed to decode any telegram of the recording (unless they are in the setup)" }, hideFailing, " hide ones that fail somewhere"),
      h("button", { class: "small", onclick: () => setup.setIncluded(entries.filter((m) => m.status === "active").map((m) => m.key)) }, "include what ebusd uses"),
      h("button", { class: "small", title: "also the hidden definitions that decode every recorded telegram without error", onclick: () => setup.setIncluded([...setup.includedKeys(entries), ...entries.filter((m) => m.errors === 0 && m.ok > 0 && !["error", "companion"].includes(m.status)).map((m) => m.key)]) }, "+ plausible hidden ones"),
      h("button", { class: "small", title: "the write (and other direction) definitions belonging to included ones; they were not seen on the bus. Writing to a device with a definition of another variant can be harmful.", onclick: () => { const inc = new Set(setup.includedKeys(entries)); setup.setIncluded([...inc, ...entries.filter((m) => m.status === "companion" && m.companionOf.some((k) => inc.has(k))).map((m) => m.key)]); } }, "+ counterparts of included"),
      h("button", { class: "small", onclick: () => setup.setIncluded([]) }, "clear"), summary), body);
    const renderTable = () => {
      const q = (this.setupFilter || "").trim().toLowerCase();
      const current = new Set(setup.includedKeys(entries));
      const rows = entries.filter((m) => {
        if (statusFilter.value === "active" && m.status !== "active") return false;
        if (statusFilter.value === "other" && (m.status === "active" || m.status === "error" || m.status === "companion")) return false;
        if (statusFilter.value === "companion" && m.status !== "companion") return false;
        if (statusFilter.value === "included" && !current.has(m.key)) return false;
        if (statusFilter.value === "renamed" && !setup.renamed(m)) return false;
        if (statusFilter.value === "custom" && m.source !== "custom") return false;
        if (statusFilter.value === "clean" && !(m.errors === 0 && m.ok > 0)) return false;
        if (app.settings?.ui?.hideFailing && m.errors > 0 && !current.has(m.key) && !m.companion) return false;
        return !q || `${m.circuit} ${m.name} ${setup.exportName(m)} ${m.file} ${m.condition}`.toLowerCase().includes(q);
      });
      summary.textContent = `${current.size} of ${entries.length} definitions included${setup.customized ? "" : " (ebusd's own choice so far)"} (${entries.filter((m) => m.status === "active").length} used by ebusd, ${entries.filter((m) => !["active", "error", "companion"].includes(m.status)).length} hidden, ${entries.filter((m) => m.status === "error").length} not fitting, ${entries.filter((m) => m.status === "companion").length} counterparts not seen)`;
      const tbody = h("tbody");
      let device = null;
      for (const m of rows) {
        if (m.zz !== device) {
          device = m.zz;
          const s = scan[device];
          append(tbody, h("tr", { class: "device" }, h("td", { colspan: 9 }, `device ${device}`, s ? h("span", { class: "muted" }, ` — ${s.manufacturer} ${s.ident} SW${s.sw} HW${s.hw}: ebusd loads ${s.file || "no file (none of the files matches the identification)"}`) : h("span", { class: "muted" }, " — no identification seen (scan telegram 0704 missing in the recording)"))));
        }
        const check = h("input", { type: "checkbox", checked: current.has(m.key), onchange: () => setup.include(m.key, check.checked, entries) });
        const nameInput = h("input", { type: "text", class: "rename", value: setup.exportName(m), size: 16, title: `name in my config (MQTT topic ebusd/${setup.circuitOf(m)}/<name>); upstream: ${m.name}`, onchange: () => setup.rename(m, nameInput.value) });
        append(tbody, h("tr", { class: current.has(m.key) ? "included" : "" },
          h("td", {}, check),
          h("td", {}, h("span", { class: `badge ${m.status}`, title: STATUS_HELP[m.status] }, m.status), h("span", { class: `badge kind ${m.write ? "write" : ""}`, style: "margin-left:3px" }, accessKind(m))),
          h("td", {}, chip(m.circuit, m.name)),
          h("td", {}, nameInput, setup.exportName(m) !== m.name ? h("span", { class: "muted", title: "renamed for my config" }, " ✎") : null),
          h("td", { class: "mono", title: m.file }, m.file.replace(/^.*\//, ""), m.source !== "base" ? h("span", { class: "badge", style: "margin-left:4px", title: "added or changed by this layer" }, m.source) : null),
          h("td", { class: "mono" }, m.condition),
          h("td", { title: `${m.distinct} distinct telegrams, ${m.occurrences} on the bus` }, m.companion ? h("span", { class: "muted" }, "not seen") : `${fmt.count(m.occurrences)} (${m.distinct})`),
          h("td", {}, m.companion ? "" : m.errors ? h("span", { class: m.ok ? "warn" : "err" }, `${m.ok} ok, ${m.errors} ✗`) : h("span", { class: "ok" }, "ok")),
          h("td", { class: "mono", style: "white-space:normal", title: m.examples.join("\n") }, m.examples[0] ? m.examples[0].slice(0, 90) : "")));
      }
      body.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "setup"), h("th", {}, "status"), h("th", {}, "upstream message"), h("th", {}, "name in my config"), h("th", {}, "file"), h("th", {}, "condition"), h("th", {}, "seen"), h("th", {}, "decode"), h("th", {}, "example"))), tbody));
    };
    renderTable();
  }

  // -- summary and save ---------------------------------------------------------------------------

  /** What was sourced where: the repository, the layers, the compile, the devices and every included definition with how it fared. */
  manifest(entries) {
    const d = app.decoder, c = d?.compile, repo = app.status?.repo;
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
    const enabled = new Set(this.enabledLayers());
    const head = (h) => (h ? { hash: h.hash, subject: h.subject, author: h.author, date: h.date } : null);
    return {
      generator: `ebusd Config Workbench ${app.status?.version || ""}`.trim(),
      created: new Date().toISOString(),
      note: "Which definitions this installation uses and where each one comes from. Written next to the CSV files; ebusd ignores it.",
      repository: repo?.exists ? { remote: repo.remote, branch: repo.branch, head: head(repo.head), uncommitted_changes: repo.changes?.length || 0 } : null,
      layers: this.layers.filter((l) => l.fetched && enabled.has(l.ref)).map((l) => ({ ref: l.ref, head: head(l.head), files: (l.changes || []).map((x) => x.path || x) })),
      compile: c ? { entry: c.entry, at: c.at, summary: c.summary, layers: c.layers || [] } : null,
      devices: d?.scan || {},
      recording: { distinct_telegrams: d?.telegrams.size || 0, from: iso(app.status?.db?.first_ms), to: iso(app.status?.db?.last_ms) },
      own_definitions: d?.custom?.trim() ? d.custom : undefined,
      definitions: entries.map((m) => {
        const fields = setup.data.names[m.key]?.fields;
        return {
          circuit: setup.circuitOf(m), name: setup.exportName(m), upstream_circuit: m.circuit, upstream_name: m.name,
          field_names: fields && Object.keys(fields).length ? fields : undefined,
          access: accessKind(m), source: m.source, file: m.file, condition: m.condition || undefined, status: m.status,
          recorded: { variants: m.distinct, decoded_ok: m.ok, decode_errors: m.errors, telegrams: m.occurrences, first: iso(m.first_ms), last: iso(m.last_ms) },
        };
      }),
    };
  }

  manifestText(entries) { return `${JSON.stringify(this.manifest(entries), null, 2)}\n`; }

  /** The files a deploy or download writes: the CSV files of the setup and the record of its sources. */
  setupDeployFiles(entries) {
    const included = setup.includedEntries(entries);
    if (!included.length) return { files: {}, sources: [] };
    const result = setup.files(entries, this.layers);
    return { files: { ...result.files, "workbench-setup.json": this.manifestText(included) }, sources: result.sources };
  }

  /** The included definitions with where they come from and how they decoded the recording. */
  summaryTable(included) {
    const writable = included.filter((m) => m.write).length, failing = included.filter((m) => m.errors > 0).length, own = included.filter((m) => m.source === "custom").length;
    const bySource = new Map();
    for (const m of included) bySource.set(m.source, (bySource.get(m.source) || 0) + 1);
    const rows = included.slice().sort((a, b) => setup.circuitOf(a).localeCompare(setup.circuitOf(b)) || setup.exportName(a).localeCompare(setup.exportName(b)));
    return h("div", {},
      h("div", { class: "hint" }, `${included.length} definitions: ${[...bySource.entries()].map(([k, n]) => `${n} from ${k === "base" ? "the checkout" : k === "custom" ? "your own definitions" : `layer ${k}`}`).join(", ")}${writable ? `; ${writable} can write to your devices` : ""}${failing ? `; ${failing} failed on some recorded telegram` : "; all of them decode every recorded telegram they match"}${own ? "" : ""}.`),
      h("div", { class: "summary-table" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "message in my config"), h("th", {}, "upstream"), h("th", {}, "kind"), h("th", {}, "source"), h("th", {}, "file"), h("th", {}, "on your recording"))),
        h("tbody", {}, rows.map((m) => h("tr", { class: m.write ? "write" : "" },
          h("td", {}, chip(setup.circuitOf(m), setup.exportName(m))),
          h("td", { class: "muted" }, setup.exportName(m) !== m.name || setup.circuitOf(m) !== m.circuit ? `${m.circuit} ${m.name}` : ""),
          h("td", {}, h("span", { class: `badge kind ${m.write ? "write" : ""}` }, accessKind(m))),
          h("td", {}, m.source === "base" ? "checkout" : h("span", { class: "badge" }, m.source)),
          h("td", { class: "mono", title: m.file }, m.file.replace(/^.*\//, "")),
          h("td", {}, m.companion ? h("span", { class: "muted" }, "not seen (counterpart)") : m.errors ? h("span", { class: m.ok ? "warn" : "err" }, `${fmt.count(m.ok)} of ${fmt.count(m.distinct)} variants decode, ${m.errors} fail`) : h("span", { class: "ok" }, `all ${fmt.count(m.ok)} variants decode · ${fmt.count(m.occurrences)} telegrams`))))))));
  }

  // -- export -----------------------------------------------------------------------------------

  renderExport() {
    const pane = this.el.panes.export;
    pane.replaceChildren();
    const settings = app.settings || {};
    const deployDir = app.status?.deploy_dir || "/share/ebusd/config";
    const entries = this.entries;
    const included = setup.includedEntries(entries);
    const files = this.setupDeployFiles(entries);
    const outputs = app.decoder?.compile?.outputs || null;
    // circuit names: the MQTT topics are ebusd/<circuit>/<name>, so they can be adapted here
    const circuitRows = [...new Set(included.map((m) => m.circuit))].sort().map((circuit) => {
      const input = h("input", { type: "text", value: setup.circuitOf({ circuit }), size: 10, onchange: () => setup.renameCircuit(circuit, input.value) });
      return h("span", { class: "group" }, chip(circuit, ""), " → ", input);
    });
    const renamed = included.filter((m) => setup.renamed(m));
    // setup CSV
    const preview = h("pre", { style: "display:none" });
    const list = h("div", { class: "outputs" }, Object.entries(files.files).map(([name, text]) => h("label", { style: "cursor:pointer", onclick: () => { preview.textContent = text; preview.style.display = ""; } },
      h("span", { class: "mono" }, name), h("span", { class: "size" }, name.endsWith(".json") ? "what was sourced where" : `${text.split("\n").filter((l) => l && !l.startsWith("#") && !l.startsWith("type,")).length} definitions`))));
    const subdir = h("input", { type: "text", value: settings.deploy_subdir || "", placeholder: "subfolder (optional)", size: 14, onchange: () => api.put("api/settings", { deploy_subdir: subdir.value.trim() }).then((s) => { app.settings = s; }).catch((err) => toast(err.message, "err")) });
    const clean = h("input", { type: "checkbox", checked: true });
    const setupStatus = h("div", { class: "hint" });
    append(pane, h("div", { class: "block" }, h("h3", {}, "Summary of your setup"),
      included.length ? this.summaryTable(included) : h("div", { class: "hint" }, "Nothing chosen yet: pick definitions in the timeline or in step 3.")));
    append(pane, h("div", { class: "block" }, h("h3", {}, "Save for ebusd"),
      included.length ? h("div", { class: "hint" }, `${included.length} definitions from ${files.sources.length} compiled files, grouped by circuit; conditions removed so that ebusd loads them for this installation without the scan${renamed.length ? `; ${renamed.length} renamed for my config (upstream names in the comments)` : ""}. workbench-setup.json records what was sourced where (repository and commit, pull requests, own definitions, devices, how each definition fared on your recording). ebusd then needs --configpath=${deployDir}${subdir.value ? "/" + subdir.value : ""} and no --scanconfig (or an empty vaillant/ folder).`)
        : h("div", { class: "hint" }, "No definitions included yet: pick candidates in the timeline or tick definitions in the Setup tab."),
      circuitRows.length ? h("div", { class: "row" }, h("label", { title: "circuit names as used in the MQTT topics ebusd/<circuit>/<name>; e.g. vwz → vwzio" }, "circuits"), ...circuitRows) : null,
      list, preview,
      included.length ? h("div", { class: "row", style: "margin-top:6px" }, h("span", { class: "mono" }, deployDir), "/", subdir, h("label", {}, clean, " remove other .csv/.inc files there"),
        h("button", { class: "primary", onclick: async () => {
          if (!confirm(`Write ${Object.keys(files.files).length} files to ${deployDir}${subdir.value ? "/" + subdir.value : ""}${clean.checked ? " and remove other definition files there" : ""}?`)) return;
          try {
            const result = await api.post("api/deploy", { files: files.files, subdir: subdir.value.trim(), clean: clean.checked });
            setupStatus.textContent = `✓ ${result.written.join(", ")} written to ${result.dir}${result.removed.length ? `; removed ${result.removed.length} other files` : ""}. Restart the eBUSd app.`;
            setupStatus.className = "hint ok";
          } catch (err) { setupStatus.textContent = `deploy failed: ${err.message}`; setupStatus.className = "hint err"; }
        } }, "Deploy setup"),
        h("button", { onclick: () => { for (const [name, text] of Object.entries(files.files)) download(name, text, "text/csv"); } }, "Download")) : null,
      setupStatus));
    // full compiled set
    const fullStatus = h("div", { class: "hint" });
    const fullSubdir = h("input", { type: "text", value: "", placeholder: "subfolder (optional)", size: 14 });
    append(pane, h("div", { class: "block" }, h("h3", {}, "All compiled files"),
      h("div", { class: "hint" }, outputs ? `${Object.keys(outputs).length} compiled files (the complete tree with the manufacturer folders, as ebusd's scan expects it).` : "compile first"),
      outputs ? h("div", { class: "row" }, h("span", { class: "mono" }, deployDir), "/", fullSubdir, h("button", { onclick: async () => {
        if (!confirm(`Write ${Object.keys(outputs).length} files to ${deployDir}${fullSubdir.value ? "/" + fullSubdir.value : ""}?`)) return;
        try {
          const result = await api.post("api/deploy", { files: outputs, subdir: fullSubdir.value.trim(), clean: false });
          fullStatus.textContent = `✓ ${result.written.length} files written to ${result.dir}. Restart the eBUSd app with --configpath=${result.dir}.`;
          fullStatus.className = "hint ok";
        } catch (err) { fullStatus.textContent = `deploy failed: ${err.message}`; fullStatus.className = "hint err"; }
      } }, "Deploy all compiled files")) : null, fullStatus));
    // Home Assistant entities
    const messages = setup.haMessages(entries);
    const circuits = [...new Set(messages.map((m) => m.circuit))];
    const controller = h("select", { onchange: () => renderYaml() }, h("option", { value: "" }, "auto"), circuits.map((c) => h("option", { value: c }, c)));
    const yamlPre = h("pre");
    const optionsPre = h("pre");
    const renderYaml = () => {
      yamlPre.textContent = included.length ? generateHaYaml(messages, { controller: controller.value || undefined }) : "# include definitions in the setup first";
      optionsPre.textContent = included.length ? generateEbusdOptions(messages, `${deployDir}${subdir.value ? "/" + subdir.value : ""}`) : "";
    };
    renderYaml();
    append(pane, h("div", { class: "block" }, h("h3", {}, "Home Assistant climate and water heater (configuration.yaml)"),
      h("div", { class: "hint" }, "ebusd's MQTT integration publishes every field as its own entity; the climate and water_heater entities combine the zone and hot water messages of the setup, under the names of my config. Check the topics against your --mqtttopic and the entity values against your controller."),
      h("div", { class: "row" }, h("label", {}, "controller circuit"), controller, h("button", { class: "small", onclick: () => copyText(yamlPre.textContent) }, "copy YAML")), yamlPre,
      h("div", { class: "row", style: "margin-top:8px" }, h("label", {}, "eBUSd app options for the setup"), h("button", { class: "small", onclick: () => copyText(optionsPre.textContent) }, "copy")), optionsPre));
    // raw log for ebus-evidence
    const tl = app.views.timeline;
    const toLocal = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
    const from = h("input", { type: "datetime-local", value: toLocal(tl ? tl.t0 : Date.now() - 3600e3) });
    const to = h("input", { type: "datetime-local", value: toLocal(tl ? tl.t1 : Date.now()) });
    const broken = h("input", { type: "checkbox" });
    const own = h("input", { type: "text", value: settings.own_address || "31", size: 3, title: "ebusd's own address on this bus (--address)", onchange: () => this.saveOwnAddress(own.value) });
    append(pane, h("div", { class: "block" }, h("h3", {}, "ebusd raw log for ebus-evidence"),
      h("div", { class: "hint" }, "The recorded telegrams as ebusd message-mode raw log (--lograwdata), the input of ", h("a", { href: "https://github.com/MarcelT87/ebus-evidence", target: "_blank" }, "ebus-evidence"),
        ": run `ebus-evidence doctor --raw FILE --profile hw5103-open-evidence`, `import --raw FILE` and `export` on another computer to produce a verified evidence bundle for cross-installation research. Only complete, correct telegrams are exported unless ticked."),
      h("div", { class: "row" }, from, "–", to,
        h("button", { class: "small", onclick: () => { if (tl) { from.value = toLocal(tl.t0); to.value = toLocal(tl.t1); } } }, "timeline window"),
        h("button", { class: "small", onclick: () => { const db = app.status?.db; if (db?.first_ms) { from.value = toLocal(db.first_ms); to.value = toLocal(db.last_ms + 1000); } } }, "whole recording"),
        h("label", {}, broken, " include broken telegrams"), h("label", {}, "own address ", own),
        h("button", { class: "primary", onclick: () => {
          const f = new Date(from.value).getTime(), t = new Date(to.value).getTime();
          if (!(f < t)) return toast("invalid time range", "err");
          window.open(`api/export/rawlog?from=${f}&to=${t}&own=${encodeURIComponent(own.value)}${broken.checked ? "&all=1" : ""}`, "_blank");
        } }, "Download raw log"))));
  }

  async saveOwnAddress(value) {
    const address = String(value).trim().toLowerCase();
    if (!/^[0-9a-f]{2}$/.test(address)) return toast("own address must be a hex byte, e.g. 31", "err");
    try { app.settings = await api.put("api/settings", { own_address: address }); } catch (err) { toast(err.message, "err"); }
  }

  // -- ebus-evidence profile checks -----------------------------------------------------------------

  renderEvidence() {
    const pane = this.el.panes.evidence;
    pane.replaceChildren();
    const settings = app.settings || {};
    const profileText = h("textarea", { class: "yaml", placeholder: "paste an ebus-evidence profile (YAML) here, or load the example" });
    profileText.value = settings.evidence_profile || "";
    const own = settings.own_address || "31";
    const addresses = h("input", { type: "text", size: 18, value: settings.ui?.evidenceAddresses ?? `f1=${own}`,
      title: "addresses as the profile names them → addresses on this bus, e.g. f1=31 when the profile's author ran ebusd as f1 and yours is 31" });
    const status = h("div", { class: "hint" });
    const body = h("div", { class: "body" });
    const run = async () => {
      try {
        await this.loadLibs();
        const profile = this.tsp.yaml.load(profileText.value);
        if (!profile || !Array.isArray(profile.checks)) throw new Error("the profile has no checks list");
        const tl = app.views.timeline;
        const from = tl.t0, to = tl.t1;
        const addressMap = parseAddressMap(addresses.value);
        status.textContent = "loading the telegrams of the window…";
        const { telegrams } = await api.get(`api/telegrams/distinct?from=${Math.floor(from)}&to=${Math.ceil(to)}&limit=50000`);
        this.evidenceRun = { run: runProfile(profile, telegrams, (app.settings?.own_address || own), addressMap), from, to };
        const ui = { ...(app.settings?.ui || {}), evidenceAddresses: addresses.value };
        app.settings = await api.put("api/settings", { evidence_profile: profileText.value, ui }).catch(() => app.settings);
        status.textContent = `profile ${this.evidenceRun.run.profile} v${this.evidenceRun.run.version ?? "?"}: ${profile.checks.length} checks over ${telegrams.length} distinct telegrams from ${fmt.dateTime(from)} to ${fmt.time(to)}${Object.keys(addressMap).length ? `, addresses ${Object.entries(addressMap).map(([a, b]) => `${a}→${b}`).join(" ")}` : ""}`;
        status.className = "hint";
        renderRun();
      } catch (err) { status.textContent = `evidence check failed: ${err.message}`; status.className = "hint err"; }
    };
    const renderRun = () => {
      body.replaceChildren();
      if (!this.evidenceRun) return;
      const { run, from, to } = this.evidenceRun;
      const table = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "check"), h("th", {}, "match"), h("th", {}, "seen"), h("th", {}, "first / last"), h("th", {}, "values"), h("th", {}, "responses"))),
        h("tbody", {}, run.checks.map((c) => h("tr", {},
          h("td", {}, h("b", {}, c.id), h("div", { class: "muted" }, c.description)),
          h("td", { class: "mono", style: "white-space:normal" }, describeMatch(c.match, run.addressMap)),
          h("td", {}, c.distinct ? `${fmt.count(c.occurrences)} (${c.distinct} distinct)` : h("span", { class: "muted" }, "none")),
          h("td", { class: "mono" }, c.distinct ? `${fmtTime(c.first_ms)}\n${fmtTime(c.last_ms)}` : ""),
          h("td", {}, h("div", { class: "values" }, [...c.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, n]) => h("span", { title: `${n}×` }, `${v} ×${n}`))), c.decodeErrors ? h("div", { class: "err" }, `${c.decodeErrors} decode errors`) : null),
          h("td", {}, h("div", { class: "values" }, [...c.responses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, n]) => h("span", { title: `${n}×` }, `${r.length > 24 ? r.slice(0, 22) + "…" : r} ×${n}`))))))));
      append(body, table, h("div", { class: "row", style: "padding:8px 10px" },
        h("button", { onclick: () => download(`evidence-summary-${run.profile}.json`, JSON.stringify(summaryJson(run, from, to), null, 2), "application/json") }, "Download summary (JSON)"),
        h("span", { class: "hint" }, "A summary for discussion; the verified bundle comes from ebus-evidence itself (see Export).")));
    };
    append(pane, h("div", { class: "bar" },
      h("button", { class: "small", onclick: async () => { try { profileText.value = await (await fetch("evidence/hw5103-open-evidence.yaml")).text(); } catch (err) { toast(err.message, "err"); } } }, "load example profile (hw5103)"),
      h("label", { title: addresses.title }, "addresses ", addresses),
      h("button", { class: "primary small", onclick: run }, "Run checks on the timeline window"), status),
      h("div", { class: "block" },
        h("div", { class: "hint" }, "Profiles of ", h("a", { href: "https://github.com/MarcelT87/ebus-evidence", target: "_blank" }, "ebus-evidence"),
          " describe telegrams the research is looking at (source, target, command, request, value decoding). Running them here shows what your bus carries for each check; share the exported raw log through ebus-evidence for a verified contribution. ",
          "Addresses are per installation: a profile written where ebusd ran as f1 names f1 as the source of ebusd's requests, so map it to your own address (the eBUSd app's --address, 31 unless changed). Device addresses only need mapping when a device of the same kind sits at another address in your installation."),
        profileText), body);
    renderRun();
  }
}
