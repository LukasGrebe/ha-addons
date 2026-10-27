// Definitions: the git repository with TypeSpec sources, an editor, compile (TypeSpec -> CSV in
// the browser), decode (recorded telegrams against every matching definition, with ebusd's message
// library in the browser), a setup of the definitions that fit this installation, exports (CSV
// files for the eBUSd app, Home Assistant entities, ebusd raw log for ebus-evidence) and
// ebus-evidence profile checks.
import { api, app, append, bus, fmt, h, toast, refreshStatus } from "./app.js";
import { messageColors, telegramValue, valueColors } from "./colors.js";
import { generateEbusdOptions, generateHaYaml } from "./hayaml.js";
import { describeMatch, fmtTime, runProfile, summaryJson } from "./evidence.js";

const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const VIEWS = [["editor", "Editor"], ["results", "Decoded"], ["setup", "Setup"], ["export", "Export"], ["evidence", "Evidence"]];
const CSV_HEADER = "type,circuit,name,comment,qq,zz,pbsb,id,*name,part,type,divisor/values,unit,comment";
const STATUS_HELP = {
  active: "ebusd uses this definition for this installation (file chosen by the scan, condition met)",
  variant: "definition from a file of another device variant (ebusd would not load it); it decodes the recorded telegrams",
  conditional: "definition whose condition was not met by the recorded telegrams; it decodes them nevertheless",
  hidden: "definition in the file ebusd loads, but another definition takes precedence",
  error: "definition matches the telegram but cannot decode it (wrong length or values)",
  companion: "not seen on the bus: the counterpart of a seen definition (same name, other direction, usually for writing)",
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
    this.outputs = null;
    this.compiled = null;
    this.telegrams = [];
    this.telegramWindow = null;
    this.results = null;
    this.model = null;
    this.selectedOutputs = null;
    this.setup = app.settings?.setup || {};
    this.layers = [];
    this.view = "editor";
    this.evidenceRun = null;
    this.build();
    bus.on("test-window", ({ from, to }) => { bus.emit("show-tab", "definitions"); this.loadWindowTelegrams(from, to); });
    bus.on("test-telegrams", (list) => { bus.emit("show-tab", "definitions"); this.setTelegrams(list); this.runTest(); });
    bus.on("status", (status) => { if (status.repo?.exists !== this.repo?.exists) this.refresh(); });
    this.refresh();
  }

  onShow() { if (!this.repo) this.refresh(); }

  // -- layout ----------------------------------------------------------------------

  build() {
    const el = (this.el = {});
    el.repo = h("div", { class: "repo" });
    el.tree = h("div", { class: "tree" });
    el.left = h("div", { class: "left" }, el.repo, el.tree);

    el.subtabs = h("div", { class: "subtabs" }, VIEWS.map(([id, label]) => h("button", { "data-view": id, class: id === this.view ? "active" : "", onclick: () => this.showView(id) }, label, h("span", { class: "count" }))));
    el.panes = {};
    for (const [id] of VIEWS) el.panes[id] = h("div", { class: `pane ${id === this.view ? "active" : ""}` });
    this.buildEditor();
    el.center = h("div", { class: "center" }, el.subtabs, ...Object.values(el.panes));

    el.build = h("div", { class: "build" });
    el.right = h("div", { class: "right" }, el.build);
    this.root.appendChild(h("div", { class: "defs" }, el.left, el.center, el.right));
    this.renderBuild();
    this.renderResults();
    this.renderSetup();
    this.renderExport();
    this.renderEvidence();
  }

  showView(id) {
    this.view = id;
    for (const button of this.el.subtabs.querySelectorAll("button")) button.classList.toggle("active", button.dataset.view === id);
    for (const [key, pane] of Object.entries(this.el.panes)) pane.classList.toggle("active", key === id);
    if (id === "export") this.renderExport();
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
    el.textarea = h("textarea", { spellcheck: "false", placeholder: "Open a .tsp file from the tree on the left, or clone a repository first." });
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
    append(el.panes.editor, el.editorBar, el.editor, el.diff);
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
    this.loadLayers();
  }

  // -- layers: community pull requests compiled on top of the checkout ---------------------------

  async loadLayers() {
    if (!this.repo?.exists) { this.layers = []; this.renderLayers(); return; }
    try {
      const { layers } = await api.get("api/repo/layers?dir=src");
      this.layers = layers;
    } catch (err) { console.warn(err); this.layers = []; }
    this.renderLayers();
  }

  enabledLayers() {
    const enabled = app.settings?.ui?.layersEnabled || {};
    return this.layers.filter((l) => l.fetched && enabled[l.ref] !== false).map((l) => l.ref);
  }

  async setLayerEnabled(ref, on) {
    const ui = { ...(app.settings?.ui || {}) };
    ui.layersEnabled = { ...(ui.layersEnabled || {}), [ref]: on };
    try { app.settings = await api.put("api/settings", { ui }); } catch (err) { toast(err.message, "err"); }
    this.renderLayers();
  }

  async addLayer(spec) {
    if (!spec.trim()) return;
    this.layerStatus.textContent = `fetching ${spec}…`;
    try {
      const layer = await api.post("api/repo/layers", { ref: spec.trim() });
      this.layerStatus.textContent = `fetched ${layer.ref}: ${layer.head?.subject || ""}`;
      await this.loadLayers();
    } catch (err) { this.layerStatus.textContent = `fetching ${spec} failed: ${err.message}`; }
  }

  async removeLayer(ref) {
    try { await api.del(`api/repo/layers/${encodeURIComponent(ref)}`); await this.loadLayers(); } catch (err) { toast(err.message, "err"); }
  }

  renderLayers() {
    const box = this.layerBox;
    if (!box) return;
    box.replaceChildren();
    const enabled = app.settings?.ui?.layersEnabled || {};
    for (const layer of this.layers) {
      const check = h("input", { type: "checkbox", checked: layer.fetched && enabled[layer.ref] !== false, disabled: !layer.fetched, onchange: () => this.setLayerEnabled(layer.ref, check.checked) });
      const title = layer.fetched ? `${layer.head.short} ${layer.head.subject} — ${layer.head.author}, ${layer.head.date.slice(0, 10)}` : "not fetched";
      append(box, h("label", { title, style: "display:flex;gap:6px;align-items:center;padding:1px 0" }, check,
        h("span", { class: "mono" }, layer.ref),
        h("span", { class: "muted", style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, layer.fetched ? `${layer.changes.length} files: ${layer.head.subject}` : "not fetched"),
        layer.fetched && !layer.common_history ? h("span", { class: "warn", title: "no common history with the checkout (shallow clone?): every difference counts as a change" }, "!") : null,
        h("a", { href: "#", class: "muted", title: "re-fetch", onclick: (e) => { e.preventDefault(); this.addLayer(layer.ref); } }, "↻"),
        h("a", { href: "#", class: "err", title: "remove", onclick: (e) => { e.preventDefault(); this.removeLayer(layer.ref); } }, "✕")));
    }
    if (!this.layers.length) append(box, h("div", { class: "hint" }, "none yet — e.g. 660 (HMU HW5103), 598 (VWZIO), 604"));
  }

  async repoAction(action, body, label) {
    const button = this.el.repo.querySelector(`button[data-action="${action}"]`);
    if (button) button.disabled = true;
    try {
      this.repo = await api.post(`api/repo/${action}`, body);
      toast(`${label || action} done`);
      await this.refresh();
      refreshStatus();
    } catch (err) {
      toast(`${label || action} failed: ${err.message}`, "err", 8000);
      if (button) button.disabled = false;
    }
  }

  renderRepo() {
    const r = this.repo || {};
    const box = this.el.repo;
    box.replaceChildren();
    if (!r.exists) {
      const url = h("input", { type: "text", placeholder: "https://github.com/<you>/ebusd-configuration.git", value: app.status?.repo_url || "" });
      append(box, h("h2", {}, "Definitions repository"),
        h("div", { class: "hint" }, `No git repository in ${r.dir || "the app config folder"} yet. Clone your fork of ebusd-configuration (HTTPS; set a token in the app configuration to push) or start empty.`),
        h("div", { class: "row" }, url),
        h("div", { class: "row" },
          h("button", { class: "primary", "data-action": "clone", onclick: () => this.repoAction("clone", { url: url.value.trim() }, "clone") }, "Clone"),
          h("button", { "data-action": "init", onclick: () => this.repoAction("init", {}, "init") }, "Start empty")));
      return;
    }
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
      this.refresh();
      refreshStatus();
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
    open.then(() => {
      this.showPane("editor");
      const ta = this.el.textarea;
      const lines = ta.value.split("\n");
      const offset = lines.slice(0, Math.max(0, line - 1)).reduce((sum, l) => sum + l.length + 1, 0);
      ta.focus();
      ta.setSelectionRange(offset, offset + (lines[line - 1] || "").length);
      ta.scrollTop = Math.max(0, (line - 6) * 18);
    });
  }

  // -- build panel: compile and decode --------------------------------------------------

  renderBuild() {
    const box = this.el.build;
    box.replaceChildren();
    const settings = app.settings || {};
    const tspFiles = this.tree.filter((e) => e.path.endsWith(".tsp") && e.type !== "dir").map((e) => e.path);
    const yamlFiles = this.tree.filter((e) => /\.ya?ml$/.test(e.path) && e.type !== "dir").map((e) => e.path);
    const entryValue = tspFiles.includes(settings.compile?.entry) ? settings.compile.entry : tspFiles.find((p) => p.endsWith("main.tsp")) || tspFiles[0] || "";
    this.entry = h("select", {}, tspFiles.map((p) => h("option", { value: p, selected: p === entryValue }, p)));
    this.translations = h("select", {}, h("option", { value: "" }, "no translation"), yamlFiles.map((p) => h("option", { value: p, selected: p === settings.compile?.translations }, p)));
    this.compileStatus = h("div", { class: this.compiled ? (this.compiled.ok ? "hint ok" : "hint err") : "hint" }, this.compiled ? this.compiled.summary : "TypeSpec → CSV runs in your browser; the device is not involved.");
    this.diagnostics = h("div", { class: "diag" });
    this.outputList = h("div", { class: "outputs" });
    this.layerBox = h("div", { class: "outputs" });
    this.layerStatus = h("div", { class: "hint" });
    const layerInput = h("input", { type: "text", placeholder: "PR number or branch", size: 14, onkeydown: (e) => { if (e.key === "Enter") { this.addLayer(layerInput.value); layerInput.value = ""; } } });
    append(box, h("h3", {}, "1 · Compile"),
      h("div", { class: "row" }, h("label", {}, "entry"), this.entry),
      h("div", { class: "row" }, h("label", {}, "i18n"), this.translations),
      h("div", { class: "hint", title: "Pull requests of the upstream repository (or branches) are fetched and their changed files are compiled on top of your checkout, without merging. Decoded definitions show where they come from." }, "community layers (pull requests on top of the checkout):"),
      this.layerBox,
      h("div", { class: "row" }, layerInput, h("button", { class: "small", onclick: () => { this.addLayer(layerInput.value); layerInput.value = ""; } }, "+ add"), this.layerStatus),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => this.compile() }, "Compile")),
      this.compileStatus, this.diagnostics, this.outputList);
    this.renderLayers();

    this.telegramInput = h("textarea", { rows: 4, style: "width:100%;font-family:var(--mono);font-size:11px", placeholder: "one telegram per line: QQZZPBSBNNDD/NNDD, e.g. 1008b5110101/0938…\nor take the distinct telegrams of the timeline window" });
    this.telegramInput.value = this.telegrams.map((t) => `${t.master}${t.slave ? "/" + t.slave : ""}`).join("\n");
    this.candidatesCheck = h("input", { type: "checkbox", checked: true, title: "list every definition that matches a telegram, also ones ebusd would not use" });
    this.testStatus = h("div", { class: "hint" });
    append(box, h("h3", {}, "2 · Decode recorded telegrams"),
      h("div", { class: "row" },
        h("button", { onclick: () => { const tl = app.views.timeline; this.loadWindowTelegrams(tl.t0, tl.t1); } }, "from timeline window"),
        h("button", { class: "primary", onclick: () => this.runTest() }, "Decode"),
        h("label", {}, this.candidatesCheck, " all candidates")),
      this.telegramInput, this.testStatus,
      h("div", { class: "hint" }, "Results, the setup of this installation and the exports are in the tabs of the middle column."));
    this.renderOutputs();
  }

  async loadLibs() {
    if (!this.tsp) {
      this.compileStatus.textContent = "loading the TypeSpec compiler…";
      this.tsp = await import("./vendor/ebus-tsp.js");
    }
    if (!this.check) {
      const { createEbusdCheck } = await import("./vendor/ebusd-check.js");
      this.check = await createEbusdCheck("vendor/ebusd-check.wasm");
    }
  }

  async compile(entryPath = null) {
    const entry = entryPath || this.entry.value;
    if (!entry) return toast("no .tsp file to compile", "err");
    const translations = this.translations.value;
    const root = entry.includes("/") ? entry.slice(0, entry.indexOf("/")) : "";
    const entryRel = root ? entry.slice(root.length + 1) : entry;
    const translationsRel = translations && translations.startsWith(root ? root + "/" : "") ? (root ? translations.slice(root.length + 1) : translations) : "";
    const t0 = performance.now();
    try {
      await this.loadLibs();
      this.compileStatus.textContent = "loading sources…";
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
      this.compileStatus.textContent = `compiling ${entry} (${Object.keys(files).length} files${layers.length ? `, layers ${layers.join(", ")}` : ""})…`;
      const options = { entry: entryRel, translations: translationsRel || undefined };
      const result = await this.tsp.compileEbusTsp(files, options);
      let baseOutputs = null, baseFiles = null;
      const layerFiles = {};
      if (result.ok && layers.length) {
        // the checkout alone, to tell which definitions the layers add
        this.compileStatus.textContent = "compiling the checkout without layers for comparison…";
        const base = await api.get(`api/repo/sources?dir=${encodeURIComponent(root)}`);
        applyEditor(base.files);
        baseFiles = base.files;
        const baseResult = await this.tsp.compileEbusTsp(base.files, options);
        baseOutputs = baseResult.ok ? baseResult.outputs : {};
        for (const ref of layers) layerFiles[ref] = (await api.get(`api/repo/layers/files?ref=${encodeURIComponent(ref)}&dir=${encodeURIComponent(root)}`)).files;
      }
      const ms = Math.round(performance.now() - t0);
      const errors = result.diagnostics.filter((d) => d.severity === "error").length;
      this.outputs = result.ok ? result.outputs : null;
      this.selectedOutputs = null;
      this.compiled = { entry, root, ok: result.ok, diagnostics: result.diagnostics, ms, layers, origins: sources.origins || {}, originLayers: sources.origin_layers || {}, conflicts: sources.conflicts || [], baseOutputs, baseFiles, layerFiles,
        summary: result.ok ? `✓ ${Object.keys(result.outputs).length} files in ${ms} ms${layers.length ? ` with ${layers.join(", ")}` : ""}${result.diagnostics.length ? `, ${result.diagnostics.length} warnings` : ""}${sources.conflicts?.length ? `; ${sources.conflicts.length} files changed by several layers (last wins)` : ""}` : `✗ ${errors} errors, ${result.diagnostics.length - errors} warnings (${ms} ms)` };
      this.compileStatus.textContent = this.compiled.summary;
      this.compileStatus.className = result.ok ? "hint ok" : "hint err";
      this.diagnostics.replaceChildren(...result.diagnostics.slice(0, 100).map((d) => h("div", { class: d.severity, title: d.code || "",
        onclick: () => d.file && this.goTo(root ? `${root}/${d.file}` : d.file, d.line || 1) },
        `${d.file ? `${d.file}:${d.line || "?"} ` : ""}${d.message}`)));
      this.renderOutputs();
      app.settings = await api.put("api/settings", { compile: { entry, translations } }).catch(() => app.settings);
      if (result.ok && this.telegrams.length) this.runTest();
    } catch (err) {
      console.error(err);
      this.compileStatus.textContent = `compile failed: ${err.message}`;
      this.compileStatus.className = "hint err";
    }
  }

  renderOutputs() {
    const list = this.outputList;
    list.replaceChildren();
    if (!this.outputs) return;
    const names = Object.keys(this.outputs).sort();
    const selected = this.selectedOutputs || new Set(names);
    this.selectedOutputs = selected;
    append(list, h("div", { class: "hint" }, `compiled files (tick the ones to load for decoding; ${names.length} total):`));
    for (const name of names) {
      const check = h("input", { type: "checkbox", checked: selected.has(name), onchange: () => { check.checked ? selected.add(name) : selected.delete(name); } });
      append(list, h("label", {}, check, h("span", { class: "mono" }, name), h("span", { class: "size" }, `${this.outputs[name].split("\n").length - 1} lines`)));
    }
  }

  async loadWindowTelegrams(from, to) {
    try {
      const { telegrams } = await api.get(`api/telegrams/distinct?from=${Math.floor(from)}&to=${Math.ceil(to)}&limit=20000`);
      this.telegramWindow = { from, to };
      this.setTelegrams(telegrams);
      this.testStatus.textContent = `${telegrams.length} distinct telegrams from ${fmt.dateTime(from)} to ${fmt.time(to)}`;
      if (this.outputs) this.runTest();
    } catch (err) { toast(err.message, "err"); }
  }

  setTelegrams(list) {
    // in order of first appearance: ebusd evaluates conditions ([Ehp_heatpumptype=3] etc.) against
    // the telegrams decoded before, so the ones setting a condition must come first
    this.telegrams = list.filter((t) => t.master).sort((a, b) => (a.first_ms || 0) - (b.first_ms || 0));
    this.telegramInput.value = this.telegrams.map((t) => `${t.master}${t.slave ? "/" + t.slave : ""}`).join("\n");
  }

  parseTelegramInput() {
    const known = new Map(this.telegrams.map((t) => [`${t.master}${t.slave ? "/" + t.slave : ""}`, t]));
    return this.telegramInput.value.split("\n").map((l) => l.trim().toLowerCase().replace(/\s+/g, "")).filter((l) => l && !l.startsWith("#"))
      .map((line) => {
        const t = known.get(line);
        const [master, slave] = line.split("/");
        return { line, master, slave: slave || null, n: t?.n || 1, status: t?.status || "ok", first_ms: t?.first_ms, last_ms: t?.last_ms };
      });
  }

  async runTest() {
    const inputs = this.parseTelegramInput();
    if (!inputs.length) return toast("no telegrams to decode: take them from the timeline window or paste some", "err");
    if (!this.outputs) {
      if (!this.compiled) await this.compile();
      if (!this.outputs) return;
    }
    try {
      await this.loadLibs();
      const all = Object.keys(this.outputs);
      const chosen = [...this.selectedOutputs].filter((n) => all.includes(n));
      const args = chosen.length === all.length ? [] : chosen.filter((n) => n.endsWith(".csv")).map((n) => `--file=${n}`);
      if (this.candidatesCheck.checked) args.push("--candidates");
      this.testStatus.textContent = `decoding ${inputs.length} telegrams with ${chosen.length} files…`;
      const t0 = performance.now();
      const result = await this.check({ files: this.outputs, args, stdin: inputs.map((i) => i.line).join("\n") + "\n" });
      const ms = Math.round(performance.now() - t0);
      const loaded = result.results.find((r) => r.loaded) || {};
      const scan = (result.results.find((r) => r.scan) || {}).scan || {};
      const decoded = result.results.filter((r) => "input" in r);
      this.results = { inputs, decoded, loaded, scan, stderr: result.stderr, ms, exitCode: result.exitCode };
      this.buildModel();
      const found = decoded.filter((r) => r.found).length, errors = decoded.filter((r) => r.found && r.result !== "ok").length;
      const hidden = this.model.filter((m) => m.status !== "active" && m.status !== "companion").length;
      const bySource = {};
      for (const r of decoded) if (r.used) bySource[this.originOf(r.used.file, r.used.name)] = (bySource[this.originOf(r.used.file, r.used.name)] || 0) + 1;
      const sources = Object.entries(bySource).map(([s, n]) => `${s} ${n}`).join(", ");
      this.testStatus.textContent = `${loaded.messages ?? 0} definitions loaded${loaded.errors ? ` (${loaded.errors} file errors)` : ""}; ${decoded.filter((r) => r.used).length} of ${decoded.length} telegrams known to ebusd (${sources})${found !== decoded.filter((r) => r.used).length ? `, ${found} with all files` : ""}, ${errors} decode errors; ${this.model.filter((m) => m.status === "active").length} definitions in use, ${hidden} more candidates; ${ms} ms`;
      this.testStatus.className = loaded.errors || result.exitCode ? "hint err" : "hint ok";
      this.renderResults();
      this.renderSetup();
      this.renderExport();
      if (this.view === "editor") this.showView("results");
    } catch (err) {
      console.error(err);
      this.testStatus.textContent = `decode failed: ${err.message}`;
      this.testStatus.className = "hint err";
    }
  }

  // -- model: the definitions that match the recorded telegrams ----------------------------------

  /** Where a decoded definition comes from: "base" (the checkout) or the layer that added it. */
  originOf(file, name) {
    const c = this.compiled;
    if (!c || !c.layers?.length) return "base";
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const base = c.baseOutputs?.[file];
    if (base !== undefined && new RegExp(`(^|\n)(\\[[^\\]]*\\])?[rwu]+,[^,\n]*,[^,\n]*,${escaped},`).test(base)) return "base";
    // the TypeSpec source the compiled file comes from; the first layer whose version of it names the
    // definition while the checkout's does not added it
    const source = file.endsWith(".inc") ? file.slice(0, -4) + "_inc.tsp" : file.replace(/\.csv$/, ".tsp");
    const word = new RegExp(`\\b${escaped}\\b`);
    const inBase = word.test(c.baseFiles?.[source] || "");
    for (const ref of c.originLayers[source] || []) {
      if (!inBase && word.test(c.layerFiles[ref]?.[source] || "")) return ref;
    }
    // definitions can also come from an included file (_inc.tsp) a layer changed
    for (const ref of c.layers) {
      for (const [path, layers] of Object.entries(c.originLayers)) {
        if (layers.includes(ref) && word.test(c.layerFiles[ref]?.[path] || "") && !word.test(c.baseFiles?.[path] || "")) return ref;
      }
    }
    if (c.originLayers[source]?.length) return c.originLayers[source].length === 1 ? c.originLayers[source][0] : c.originLayers[source].join("+");
    const dir = file.includes("/") ? file.slice(0, file.indexOf("/") + 1) : "";
    const inDir = [...new Set(Object.entries(c.origins).filter(([p]) => p.startsWith(dir)).map(([, l]) => l))];
    return inDir.length === 1 ? inDir[0] : "layers";
  }

  buildModel() {
    const { inputs, decoded, scan } = this.results;
    const byInput = new Map(decoded.map((r) => [r.input, r]));
    const entries = new Map();
    const names = new Map();
    const idLengths = {};
    const scanFileOf = (zz) => scan[zz]?.file || "";
    const inScanFile = (file, zz) => !file.includes("/") || file === scanFileOf(zz);
    for (const input of inputs) {
      const r = byInput.get(input.line);
      if (!r) continue;
      const candidates = r.candidates ? r.candidates.slice() : (r.found ? [{ ...r, selected: true }] : []);
      // what ebusd itself would use: the file chosen by the scan (or a root file), condition met, longest ID
      const usable = candidates.filter((c) => c.available && inScanFile(c.file, c.zz));
      const used = usable.length ? usable.reduce((best, c) => (c.idlen > best.idlen ? c : best), usable[0]) : null;
      r.used = used;
      if (used) {
        names.set(input.master, `${used.circuit} ${used.name}`);
        const key = used.zz + used.pbsb;
        idLengths[key] = Math.max(idLengths[key] || 0, used.idlen);
      }
      const keyOf = (c) => `${c.file}|${c.circuit}|${c.name}|${c.write ? "w" : ""}${c.passive ? "u" : ""}`;
      const entryOf = (c) => {
        const key = keyOf(c);
        let entry = entries.get(key);
        if (!entry) {
          entry = { key, circuit: c.circuit, name: c.name, file: c.file, condition: c.condition || "", write: !!c.write, passive: !!c.passive,
            zz: c.zz, qq: c.qq, pbsb: c.pbsb, idlen: c.idlen, csv: c.csv, available: c.available, distinct: 0, occurrences: 0, ok: 0, errors: 0,
            used: 0, examples: [], fields: new Set(), first_ms: null, last_ms: null, source: this.originOf(c.file, c.name), companion: true, companionOf: new Set() };
          entries.set(key, entry);
        }
        return entry;
      };
      for (const c of candidates) {
        const entry = entryOf(c);
        entry.companion = false;
        for (const sibling of c.siblings || []) entryOf(sibling).companionOf.add(entry.key);
        entry.distinct++;
        entry.occurrences += input.n;
        if (c.result === "ok") entry.ok++; else entry.errors++;
        if (c === used) entry.used++;
        if (c.fields) for (const f of Object.keys(c.fields)) entry.fields.add(f);
        if (c.result === "ok" && entry.examples.length < 3 && c.text && !entry.examples.includes(c.text)) entry.examples.push(c.text);
        if (input.first_ms) entry.first_ms = entry.first_ms === null ? input.first_ms : Math.min(entry.first_ms, input.first_ms);
        if (input.last_ms) entry.last_ms = entry.last_ms === null ? input.last_ms : Math.max(entry.last_ms, input.last_ms);
      }
    }
    for (const entry of entries.values()) {
      entry.companionOf = [...entry.companionOf];
      if (entry.companion) {
        // not seen on the bus itself: the counterpart (usually for writing) of a seen definition
        entry.status = "companion";
        entry.fields = [...entry.fields];
        continue;
      }
      entry.status = entry.used > 0 ? "active" : entry.ok === 0 ? "error" : !entry.available ? "conditional" : !inScanFile(entry.file, entry.zz) ? "variant" : "hidden";
      entry.fields = [...entry.fields];
    }
    // a companion inherits the fields of the definitions it belongs to (same name, other direction)
    for (const entry of entries.values()) {
      if (entry.companion && !entry.fields.length) entry.fields = [...new Set(entry.companionOf.flatMap((k) => entries.get(k)?.fields || []))];
    }
    this.model = [...entries.values()].sort((a, b) => a.zz.localeCompare(b.zz) || a.circuit.localeCompare(b.circuit) || a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
    if (!Array.isArray(this.setup.included)) this.setup.included = this.model.filter((m) => m.status === "active").map((m) => m.key);
    bus.emit("names", names);
    bus.emit("idlengths", idLengths);
    this.setCount("results", decoded.length);
    this.setCount("setup", `${this.setup.included.length}/${this.model.length}`);
  }

  includedEntries() {
    const included = new Set(this.setup.included || []);
    return (this.model || []).filter((m) => included.has(m.key));
  }

  saveSetup() {
    clearTimeout(this.setupTimer);
    this.setupTimer = setTimeout(async () => {
      try { app.settings = await api.put("api/settings", { setup: { included: this.setup.included, circuits: this.setup.circuits || {}, updated: new Date().toISOString() } }); } catch (err) { toast(err.message, "err"); }
    }, 500);
    this.setCount("setup", `${this.setup.included.length}/${this.model?.length || 0}`);
  }

  // -- decoded telegrams ---------------------------------------------------------------------

  renderResults() {
    const pane = this.el.panes.results;
    pane.replaceChildren();
    if (!this.results) {
      append(pane, h("div", { class: "empty" }, "Compile the definitions and decode the telegrams of a timeline window (right column) to see which definitions match your bus."));
      return;
    }
    const filter = h("select", { onchange: () => renderTable() },
      h("option", { value: "all" }, "all telegrams"), h("option", { value: "unknown" }, "unknown to ebusd"), h("option", { value: "candidates" }, "with other candidates"),
      h("option", { value: "errors" }, "decode errors"));
    const search = h("input", { type: "search", placeholder: "filter: hex, circuit, name", oninput: () => renderTable() });
    const body = h("div", { class: "body" });
    append(pane, h("div", { class: "bar" }, filter, search, h("span", { class: "hint" }, `${this.results.decoded.length} distinct telegrams; colours as in the timeline`),
      this.results.stderr.length ? h("span", { class: "err" }, `${this.results.stderr.length} messages from ebusd`) : null), body);
    const renderTable = () => {
      const q = search.value.trim().toLowerCase();
      const byInput = new Map(this.results.decoded.map((r) => [r.input, r]));
      const rows = this.results.inputs.map((i) => ({ ...i, r: byInput.get(i.line) })).filter(({ line, r }) => {
        if (filter.value === "unknown" && r?.used) return false;
        if (filter.value === "candidates" && !(r?.candidates?.length > (r?.used ? 1 : 0))) return false;
        if (filter.value === "errors" && !(r?.used && r.used.result !== "ok")) return false;
        if (q && !line.includes(q) && !(r?.candidates || []).some((c) => `${c.circuit} ${c.name}`.toLowerCase().includes(q))) return false;
        return true;
      });
      const table = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "n"), h("th", {}, "telegram"), h("th", {}, "ebusd uses"), h("th", {}, "decoded"), h("th", {}, "other candidates"))),
        h("tbody", {}, rows.slice(0, 1500).map(({ line, master, slave, n, status, r }) => {
          const used = r?.used;
          const others = (r?.candidates || []).filter((c) => c !== used);
          return h("tr", {},
            h("td", {}, fmt.count(n)),
            h("td", { class: "mono", title: line }, swatch(telegramValue(master, slave, status, app.settings), status), line.length > 40 ? line.slice(0, 38) + "…" : line),
            h("td", {}, !r ? h("span", { class: "muted" }, "—") : r.error ? h("span", { class: "err" }, r.error) : !used ? h("span", { class: "warn" }, "unknown") : chip(used.circuit, used.name, used.write ? " (w)" : "")),
            h("td", { class: "mono", style: "white-space:normal" }, used ? (used.result === "ok" ? used.text : h("span", { class: "err" }, used.result)) : ""),
            h("td", { class: "cand" }, others.slice(0, 6).map((c) => h("span", { style: "margin-right:4px", title: `${c.file}${c.condition ? " " + c.condition : ""}: ${c.result === "ok" ? c.text : c.result}` },
              chip(c.circuit, c.name, c.write ? " (w)" : ""), c.result !== "ok" ? h("span", { class: "err" }, " ✗") : null)), others.length > 6 ? ` +${others.length - 6}` : null));
        })));
      body.replaceChildren(table, rows.length > 1500 ? h("div", { class: "hint", style: "padding:6px 10px" }, "showing the first 1500 telegrams") : null);
      if (this.results.stderr.length) append(body, h("div", { class: "log", style: "margin:8px 10px" }, this.results.stderr.slice(0, 50).join("\n")));
    };
    renderTable();
  }

  // -- setup: the definitions for this installation --------------------------------------------

  renderSetup() {
    const pane = this.el.panes.setup;
    pane.replaceChildren();
    if (!this.model) {
      append(pane, h("div", { class: "empty" }, "Decode the telegrams of a timeline window first. This tab then lists every definition that matched them and lets you pick the ones for your installation."));
      return;
    }
    const included = new Set(this.setup.included || []);
    const statusFilter = h("select", { onchange: () => renderTable() }, h("option", { value: "all" }, "all definitions"), h("option", { value: "active" }, "used by ebusd"),
      h("option", { value: "other" }, "hidden: other file / condition"), h("option", { value: "companion" }, "counterparts not seen (write)"), h("option", { value: "included" }, "included in the setup"));
    const search = h("input", { type: "search", placeholder: "filter: circuit, name, file", oninput: () => renderTable() });
    const summary = h("span", { class: "hint" });
    const setIncluded = (keys) => { this.setup.included = [...keys]; this.saveSetup(); renderTable(); };
    const body = h("div", { class: "body" });
    append(pane, h("div", { class: "bar" }, statusFilter, search,
      h("button", { class: "small", onclick: () => setIncluded(this.model.filter((m) => m.status === "active").map((m) => m.key)) }, "include what ebusd uses"),
      h("button", { class: "small", title: "also the hidden definitions that decode every recorded telegram without error", onclick: () => setIncluded([...this.setup.included, ...this.model.filter((m) => m.errors === 0 && m.ok > 0 && !["error", "companion"].includes(m.status)).map((m) => m.key)]) }, "+ plausible hidden ones"),
      h("button", { class: "small", title: "the write (and other direction) definitions belonging to included ones; they were not seen on the bus. Writing to a device with a definition of another variant can be harmful.", onclick: () => { const inc = new Set(this.setup.included); setIncluded([...inc, ...this.model.filter((m) => m.status === "companion" && m.companionOf.some((k) => inc.has(k))).map((m) => m.key)]); } }, "+ counterparts of included"),
      h("button", { class: "small", onclick: () => setIncluded([]) }, "clear"), summary), body);
    const renderTable = () => {
      const q = search.value.trim().toLowerCase();
      const current = new Set(this.setup.included || []);
      const rows = this.model.filter((m) => {
        if (statusFilter.value === "active" && m.status !== "active") return false;
        if (statusFilter.value === "other" && (m.status === "active" || m.status === "error" || m.status === "companion")) return false;
        if (statusFilter.value === "companion" && m.status !== "companion") return false;
        if (statusFilter.value === "included" && !current.has(m.key)) return false;
        return !q || `${m.circuit} ${m.name} ${m.file} ${m.condition}`.toLowerCase().includes(q);
      });
      summary.textContent = `${current.size} of ${this.model.length} definitions included (${this.model.filter((m) => m.status === "active").length} used by ebusd, ${this.model.filter((m) => !["active", "error", "companion"].includes(m.status)).length} hidden, ${this.model.filter((m) => m.status === "error").length} not fitting, ${this.model.filter((m) => m.status === "companion").length} counterparts not seen)`;
      const tbody = h("tbody");
      let device = null;
      for (const m of rows) {
        if (m.zz !== device) {
          device = m.zz;
          const s = this.results.scan[device];
          append(tbody, h("tr", { class: "device" }, h("td", { colspan: 8 }, `device ${device}`, s ? h("span", { class: "muted" }, ` — ${s.manufacturer} ${s.ident} SW${s.sw} HW${s.hw}: ebusd loads ${s.file || "no file (none of the files matches the identification)"}`) : h("span", { class: "muted" }, " — no identification seen (scan telegram 0704 missing in the window)"))));
        }
        const check = h("input", { type: "checkbox", checked: current.has(m.key), onchange: () => { check.checked ? current.add(m.key) : current.delete(m.key); this.setup.included = [...current]; this.saveSetup(); summary.textContent = summary.textContent.replace(/^\d+/, String(current.size)); } });
        append(tbody, h("tr", {},
          h("td", {}, check),
          h("td", {}, h("span", { class: `badge ${m.status}`, title: STATUS_HELP[m.status] }, m.status), m.write ? h("span", { class: "badge write", title: "write definition: sends values to the device" }, "write") : null),
          h("td", {}, chip(m.circuit, m.name, m.passive ? " (u)" : "")),
          h("td", { class: "mono", title: m.file }, m.file.replace(/^.*\//, ""), m.source !== "base" ? h("span", { class: "badge", style: "margin-left:4px", title: "added or changed by this layer" }, m.source) : null),
          h("td", { class: "mono" }, m.condition),
          h("td", { title: `${m.distinct} distinct telegrams, ${m.occurrences} on the bus` }, m.companion ? h("span", { class: "muted" }, "not seen") : `${fmt.count(m.occurrences)} (${m.distinct})`),
          h("td", {}, m.companion ? "" : m.errors ? h("span", { class: m.ok ? "warn" : "err" }, `${m.ok} ok, ${m.errors} ✗`) : h("span", { class: "ok" }, "ok")),
          h("td", { class: "mono", style: "white-space:normal", title: m.examples.join("\n") }, m.examples[0] ? m.examples[0].slice(0, 90) : "")));
      }
      body.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "setup"), h("th", {}, "status"), h("th", {}, "message"), h("th", {}, "file"), h("th", {}, "condition"), h("th", {}, "seen"), h("th", {}, "decode"), h("th", {}, "example"))), tbody));
    };
    renderTable();
  }

  /** The circuit a definition gets in the setup (renamed, e.g. vwz -> vwzio, if configured). */
  circuitOf(m) {
    const renames = this.setup.circuits || {};
    return renames[m.circuit] || m.circuit;
  }

  /** A definition's CSV line with the setup's circuit name. */
  csvOf(m) {
    const circuit = this.circuitOf(m);
    if (circuit === m.circuit) return m.csv;
    const comma = m.csv.indexOf(",");
    const next = m.csv.indexOf(",", comma + 1);
    return m.csv.slice(0, comma + 1) + circuit + m.csv.slice(next);
  }

  /** CSV files for the eBUSd app with the included definitions, one per circuit, conditions removed. */
  setupFiles() {
    const files = {};
    const sources = new Set();
    for (const m of this.includedEntries()) {
      const name = `${(this.circuitOf(m) || "misc").toLowerCase().replace(/[^a-z0-9_.-]/g, "_")}.csv`;
      if (!files[name]) files[name] = [];
      files[name].push(m);
      sources.add(m.file);
    }
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const out = {};
    for (const [name, list] of Object.entries(files)) {
      list.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name) || (a.write ? 1 : 0) - (b.write ? 1 : 0));
      const lines = [CSV_HEADER, `# generated by eBUSd Workbench ${stamp} for this installation from ${[...new Set(list.map((m) => m.file))].join(", ")}`];
      let source = null;
      for (const m of list) {
        if (m.source !== source) {
          source = m.source;
          lines.push(source === "base" ? "# from the checkout" : `# from layer ${source}${this.layers.find((l) => l.ref === source)?.head ? ` (${this.layers.find((l) => l.ref === source).head.subject})` : ""}`);
        }
        lines.push(this.csvOf(m));
      }
      out[name] = lines.join("\n") + "\n";
    }
    return { files: out, sources: [...sources] };
  }

  // -- export -----------------------------------------------------------------------------------

  renderExport() {
    const pane = this.el.panes.export;
    pane.replaceChildren();
    const settings = app.settings || {};
    const deployDir = app.status?.deploy_dir || "/share/ebusd/config";
    const included = this.includedEntries();
    const setup = included.length ? this.setupFiles() : { files: {}, sources: [] };
    // circuit names: the MQTT topics are ebusd/<circuit>/<name>, so they can be adapted here
    const circuitRows = [...new Set(included.map((m) => m.circuit))].sort().map((circuit) => {
      const input = h("input", { type: "text", value: (this.setup.circuits || {})[circuit] || circuit, size: 10, onchange: () => {
        this.setup.circuits = { ...(this.setup.circuits || {}) };
        if (input.value.trim() && input.value.trim() !== circuit) this.setup.circuits[circuit] = input.value.trim().replace(/[^A-Za-z0-9_.-]/g, "_"); else delete this.setup.circuits[circuit];
        this.saveSetup(); this.renderExport();
      } });
      return h("span", { class: "group" }, chip(circuit, ""), " → ", input);
    });
    // setup CSV
    const preview = h("pre", { style: "display:none" });
    const list = h("div", { class: "outputs" }, Object.entries(setup.files).map(([name, text]) => h("label", { style: "cursor:pointer", onclick: () => { preview.textContent = text; preview.style.display = ""; } },
      h("span", { class: "mono" }, name), h("span", { class: "size" }, `${text.split("\n").length - 2} definitions`))));
    const subdir = h("input", { type: "text", value: settings.deploy_subdir || "", placeholder: "subfolder (optional)", size: 14 });
    const clean = h("input", { type: "checkbox", checked: true });
    const setupStatus = h("div", { class: "hint" });
    append(pane, h("div", { class: "block" }, h("h3", {}, "Definitions of this installation"),
      included.length ? h("div", { class: "hint" }, `${included.length} definitions from ${setup.sources.length} compiled files, grouped by circuit; conditions removed so that ebusd loads them for this installation without the scan. ebusd then needs --configpath=${deployDir}${subdir.value ? "/" + subdir.value : ""} and no --scanconfig (or an empty vaillant/ folder).`)
        : h("div", { class: "hint" }, "No definitions included yet: decode telegrams and tick definitions in the Setup tab."),
      circuitRows.length ? h("div", { class: "row" }, h("label", { title: "circuit names as used in the MQTT topics ebusd/<circuit>/<name>; e.g. vwz → vwzio" }, "circuits"), ...circuitRows) : null,
      list, preview,
      included.length ? h("div", { class: "row", style: "margin-top:6px" }, h("span", { class: "mono" }, deployDir), "/", subdir, h("label", {}, clean, " remove other .csv/.inc files there"),
        h("button", { class: "primary", onclick: async () => {
          if (!confirm(`Write ${Object.keys(setup.files).length} files to ${deployDir}${subdir.value ? "/" + subdir.value : ""}${clean.checked ? " and remove other definition files there" : ""}?`)) return;
          try {
            const result = await api.post("api/deploy", { files: setup.files, subdir: subdir.value.trim(), clean: clean.checked });
            setupStatus.textContent = `✓ ${result.written.join(", ")} written to ${result.dir}${result.removed.length ? `; removed ${result.removed.length} other files` : ""}. Restart the eBUSd app.`;
            setupStatus.className = "hint ok";
          } catch (err) { setupStatus.textContent = `deploy failed: ${err.message}`; setupStatus.className = "hint err"; }
        } }, "Deploy setup"),
        h("button", { onclick: () => { for (const [name, text] of Object.entries(setup.files)) download(name, text, "text/csv"); } }, "Download")) : null,
      setupStatus));
    // full compiled set
    const fullStatus = h("div", { class: "hint" });
    const fullSubdir = h("input", { type: "text", value: "", placeholder: "subfolder (optional)", size: 14 });
    append(pane, h("div", { class: "block" }, h("h3", {}, "All compiled files"),
      h("div", { class: "hint" }, this.outputs ? `${Object.keys(this.outputs).length} compiled files (the complete tree with the manufacturer folders, as ebusd's scan expects it).` : "compile first"),
      this.outputs ? h("div", { class: "row" }, h("span", { class: "mono" }, deployDir), "/", fullSubdir, h("button", { onclick: async () => {
        if (!confirm(`Write ${Object.keys(this.outputs).length} files to ${deployDir}${fullSubdir.value ? "/" + fullSubdir.value : ""}?`)) return;
        try {
          const result = await api.post("api/deploy", { files: this.outputs, subdir: fullSubdir.value.trim(), clean: false });
          fullStatus.textContent = `✓ ${result.written.length} files written to ${result.dir}. Restart the eBUSd app with --configpath=${result.dir}.`;
          fullStatus.className = "hint ok";
        } catch (err) { fullStatus.textContent = `deploy failed: ${err.message}`; fullStatus.className = "hint err"; }
      } }, "Deploy all compiled files")) : null, fullStatus));
    // Home Assistant entities
    const circuits = [...new Set(included.map((m) => this.circuitOf(m)))];
    const controller = h("select", { onchange: () => renderYaml() }, h("option", { value: "" }, "auto"), circuits.map((c) => h("option", { value: c }, c)));
    const yamlPre = h("pre");
    const optionsPre = h("pre");
    const renderYaml = () => {
      const messages = included.map((m) => ({ circuit: this.circuitOf(m), name: m.name, write: m.write, passive: m.passive, fields: m.fields }));
      yamlPre.textContent = included.length ? generateHaYaml(messages, { controller: controller.value || undefined }) : "# include definitions in the setup first";
      optionsPre.textContent = included.length ? generateEbusdOptions(messages, `${deployDir}${subdir.value ? "/" + subdir.value : ""}`) : "";
    };
    renderYaml();
    append(pane, h("div", { class: "block" }, h("h3", {}, "Home Assistant climate and water heater (configuration.yaml)"),
      h("div", { class: "hint" }, "ebusd's MQTT integration publishes every field as its own entity; the climate and water_heater entities combine the zone and hot water messages of the setup. Check the topics against your --mqtttopic and the entity values against your controller."),
      h("div", { class: "row" }, h("label", {}, "controller circuit"), controller, h("button", { class: "small", onclick: () => copyText(yamlPre.textContent) }, "copy YAML")), yamlPre,
      h("div", { class: "row", style: "margin-top:8px" }, h("label", {}, "eBUSd app options for the setup"), h("button", { class: "small", onclick: () => copyText(optionsPre.textContent) }, "copy")), optionsPre));
    // raw log for ebus-evidence
    const tl = app.views.timeline;
    const toLocal = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
    const from = h("input", { type: "datetime-local", value: toLocal(tl ? tl.t0 : Date.now() - 3600e3) });
    const to = h("input", { type: "datetime-local", value: toLocal(tl ? tl.t1 : Date.now()) });
    const broken = h("input", { type: "checkbox" });
    const own = h("input", { type: "text", value: "31", size: 3, title: "ebusd's own address (--address)" });
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

  // -- ebus-evidence profile checks -----------------------------------------------------------------

  renderEvidence() {
    const pane = this.el.panes.evidence;
    pane.replaceChildren();
    const profileText = h("textarea", { class: "yaml", placeholder: "paste an ebus-evidence profile (YAML) here, or load the example" });
    profileText.value = app.settings?.evidence_profile || "";
    const status = h("div", { class: "hint" });
    const body = h("div", { class: "body" });
    const run = async () => {
      try {
        await this.loadLibs();
        const profile = this.tsp.yaml.load(profileText.value);
        if (!profile || !Array.isArray(profile.checks)) throw new Error("the profile has no checks list");
        const tl = app.views.timeline;
        const from = this.telegramWindow?.from ?? tl.t0, to = this.telegramWindow?.to ?? tl.t1;
        status.textContent = "loading the telegrams of the window…";
        const { telegrams } = await api.get(`api/telegrams/distinct?from=${Math.floor(from)}&to=${Math.ceil(to)}&limit=50000`);
        this.evidenceRun = { run: runProfile(profile, telegrams), from, to };
        app.settings = await api.put("api/settings", { evidence_profile: profileText.value }).catch(() => app.settings);
        status.textContent = `profile ${this.evidenceRun.run.profile} v${this.evidenceRun.run.version ?? "?"}: ${profile.checks.length} checks over ${telegrams.length} distinct telegrams from ${fmt.dateTime(from)} to ${fmt.time(to)}`;
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
          h("td", { class: "mono", style: "white-space:normal" }, describeMatch(c.match)),
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
      h("button", { class: "primary small", onclick: run }, "Run checks on the timeline window"), status),
      h("div", { class: "block" },
        h("div", { class: "hint" }, "Profiles of ", h("a", { href: "https://github.com/MarcelT87/ebus-evidence", target: "_blank" }, "ebus-evidence"),
          " describe telegrams the research is looking at (source, target, command, request, value decoding). Running them here shows what your bus carries for each check; share the exported raw log through ebus-evidence for a verified contribution."),
        profileText), body);
    renderRun();
  }
}
