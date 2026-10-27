// Definitions: the git repository with TypeSpec sources, an editor, compile (TypeSpec -> CSV in
// the browser), test (decode recorded telegrams with ebusd's message library in the browser)
// and deploy (write the CSV files for the eBUSd app).
import { api, app, append, bus, fmt, h, toast, refreshStatus } from "./app.js";

const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

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
    this.results = null;
    this.selectedOutputs = null;
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
    el.path = h("span", { class: "path muted" }, "no file open");
    el.save = h("button", { class: "primary small", disabled: true, onclick: () => this.save() }, "Save");
    el.editorBar = h("div", { class: "editor-bar" }, el.path,
      h("button", { class: "small", onclick: () => this.compile(this.file) , title: "compile with the open file as entry" }, "Compile this file"),
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
    el.center = h("div", { class: "center" }, el.editorBar, el.editor, el.diff);
    el.build = h("div", { class: "build" });
    el.right = h("div", { class: "right" }, el.build);
    this.root.appendChild(h("div", { class: "defs" }, el.left, el.center, el.right));
    this.renderBuild();
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
    this.el.editor.style.display = which === "editor" ? "" : "none";
    this.el.diff.style.display = which === "diff" ? "" : "none";
    if (which === "diff") { this.el.path.textContent = title; this.el.save.disabled = true; }
  }

  // -- files -------------------------------------------------------------------------

  renderTree() {
    const tree = this.el.tree;
    tree.replaceChildren();
    if (!this.repo?.exists) return;
    const entries = this.tree;
    const children = new Map();
    for (const entry of entries) {
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
          h("span", { class: "ico" }, isDir ? (this.openDirs.has(entry.path) ? "▾" : "▸") : entry.type === "link" ? "↪" : "·"), name,
          !isDir && entry.size !== undefined && depth === 0 ? "" : null);
        tree.appendChild(node);
        if (isDir && this.openDirs.has(entry.path)) render(entry.path, depth + 1);
      }
    };
    render("", 0);
    if (!entries.length) tree.appendChild(h("div", { class: "empty" }, "empty repository"));
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
      const ta = this.el.textarea;
      const lines = ta.value.split("\n");
      const offset = lines.slice(0, Math.max(0, line - 1)).reduce((sum, l) => sum + l.length + 1, 0);
      ta.focus();
      ta.setSelectionRange(offset, offset + (lines[line - 1] || "").length);
      ta.scrollTop = Math.max(0, (line - 6) * 18);
    });
  }

  // -- build panel ---------------------------------------------------------------------

  renderBuild() {
    const box = this.el.build;
    box.replaceChildren();
    const settings = app.settings || {};
    const tspFiles = this.tree.filter((e) => e.path.endsWith(".tsp") && e.type !== "dir").map((e) => e.path);
    const yamlFiles = this.tree.filter((e) => /\.ya?ml$/.test(e.path) && e.type !== "dir").map((e) => e.path);
    const entryValue = tspFiles.includes(settings.compile?.entry) ? settings.compile.entry : tspFiles.find((p) => p.endsWith("main.tsp")) || tspFiles[0] || "";
    this.entry = h("select", {}, tspFiles.map((p) => h("option", { value: p, selected: p === entryValue }, p)));
    this.translations = h("select", {}, h("option", { value: "" }, "no translation"), yamlFiles.map((p) => h("option", { value: p, selected: p === settings.compile?.translations }, p)));
    const compileButton = h("button", { class: "primary", onclick: () => this.compile() }, "Compile");
    this.compileStatus = h("div", { class: "hint" }, this.compiled ? this.compiled.summary : "TypeSpec → CSV runs in your browser; the device is not involved.");
    this.diagnostics = h("div", { class: "diag" });
    this.outputList = h("div", { class: "outputs" });
    append(box, h("h3", {}, "1 · Compile"),
      h("div", { class: "row" }, h("label", {}, "entry"), this.entry),
      h("div", { class: "row" }, h("label", {}, "i18n"), this.translations, compileButton),
      this.compileStatus, this.diagnostics, this.outputList);

    this.telegramInput = h("textarea", { rows: 5, style: "width:100%;font-family:var(--mono);font-size:11px", placeholder: "one telegram per line: QQZZPBSBNNDD/NNDD, e.g. 1008b5110101/0938...\nor take the distinct telegrams of the timeline window" });
    this.telegramInput.value = this.telegrams.map((t) => `${t.master}${t.slave ? "/" + t.slave : ""}`).join("\n");
    this.testStatus = h("div", { class: "hint" });
    this.resultBox = h("div", { class: "results" });
    this.unknownOnly = h("input", { type: "checkbox", onchange: () => this.renderResults() });
    append(box, h("h3", {}, "2 · Test against recorded telegrams"),
      h("div", { class: "row" },
        h("button", { onclick: () => { const tl = app.views.timeline; this.loadWindowTelegrams(tl.t0, tl.t1); } }, "from timeline window"),
        h("button", { class: "primary", onclick: () => this.runTest() }, "Decode"),
        h("label", {}, this.unknownOnly, " unknown only")),
      this.telegramInput, this.testStatus, this.resultBox);

    this.subdir = h("input", { type: "text", value: settings.deploy_subdir || "", placeholder: "subfolder (optional)", size: 14 });
    this.clean = h("input", { type: "checkbox" });
    this.deployStatus = h("div", { class: "hint" });
    this.deployList = h("div", { class: "hint" });
    append(box, h("h3", {}, "3 · Deploy for eBUSd"),
      h("div", { class: "row" }, h("label", {}, "folder"), h("span", { class: "mono" }, app.status?.deploy_dir || ""), h("span", {}, "/"), this.subdir),
      h("div", { class: "row" }, h("label", {}, this.clean, " remove other files there"), h("button", { class: "primary", onclick: () => this.deploy() }, "Deploy compiled files")),
      this.deployStatus, this.deployList);
    this.renderOutputs();
    this.renderResults();
    this.loadDeployed();
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
      const { files } = await api.get(`api/repo/sources?dir=${encodeURIComponent(root)}`);
      if (this.file && this.dirty) {
        const rel = root ? (this.file.startsWith(root + "/") ? this.file.slice(root.length + 1) : null) : this.file;
        if (rel) files[rel] = this.el.textarea.value;
      }
      this.compileStatus.textContent = `compiling ${entry} (${Object.keys(files).length} files)…`;
      const result = await this.tsp.compileEbusTsp(files, { entry: entryRel, translations: translationsRel || undefined });
      const ms = Math.round(performance.now() - t0);
      const errors = result.diagnostics.filter((d) => d.severity === "error").length;
      this.outputs = result.ok ? result.outputs : null;
      this.selectedOutputs = null;
      this.compiled = { entry, root, ok: result.ok, diagnostics: result.diagnostics, ms,
        summary: result.ok ? `✓ ${Object.keys(result.outputs).length} files in ${ms} ms${result.diagnostics.length ? `, ${result.diagnostics.length} warnings` : ""}` : `✗ ${errors} errors, ${result.diagnostics.length - errors} warnings (${ms} ms)` };
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
    append(list, h("div", { class: "hint" }, `compiled files (tick the ones to load for the test; ${names.length} total):`));
    for (const name of names) {
      const check = h("input", { type: "checkbox", checked: selected.has(name), onchange: () => { check.checked ? selected.add(name) : selected.delete(name); } });
      append(list, h("label", {}, check, h("span", { class: "mono" }, name), h("span", { class: "size" }, `${this.outputs[name].split("\n").length - 1} lines`)));
    }
  }

  async loadWindowTelegrams(from, to) {
    try {
      const { telegrams } = await api.get(`api/telegrams/distinct?from=${Math.floor(from)}&to=${Math.ceil(to)}&limit=2000`);
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
    const counts = new Map(this.telegrams.map((t) => [`${t.master}${t.slave ? "/" + t.slave : ""}`, t.n || 1]));
    return this.telegramInput.value.split("\n").map((l) => l.trim().toLowerCase().replace(/\s+/g, "")).filter((l) => l && !l.startsWith("#"))
      .map((line) => ({ line, n: counts.get(line) || 1 }));
  }

  async runTest() {
    const inputs = this.parseTelegramInput();
    if (!inputs.length) return toast("no telegrams to decode: paste some or take them from the timeline", "err");
    if (!this.outputs) {
      if (!this.compiled) await this.compile();
      if (!this.outputs) return;
    }
    try {
      await this.loadLibs();
      const all = Object.keys(this.outputs);
      const chosen = [...this.selectedOutputs].filter((n) => all.includes(n));
      const args = chosen.length === all.length ? [] : chosen.filter((n) => n.endsWith(".csv")).map((n) => `--file=${n}`);
      this.testStatus.textContent = `decoding ${inputs.length} telegrams with ${chosen.length} files…`;
      const t0 = performance.now();
      const result = await this.check({ files: this.outputs, args, stdin: inputs.map((i) => i.line).join("\n") + "\n" });
      const ms = Math.round(performance.now() - t0);
      const loaded = result.results.find((r) => r.loaded) || {};
      const decoded = result.results.filter((r) => "input" in r);
      this.results = { inputs, decoded, loaded, stderr: result.stderr, ms, exitCode: result.exitCode };
      const names = new Map();
      for (const r of decoded) if (r.found) names.set(r.input.split("/")[0], `${r.circuit ? r.circuit + " " : ""}${r.name}`);
      bus.emit("names", names);
      const found = decoded.filter((r) => r.found).length, errors = decoded.filter((r) => r.found && r.result !== "ok").length;
      this.testStatus.textContent = `${loaded.messages ?? 0} message definitions loaded${loaded.errors ? ` (${loaded.errors} file errors)` : ""}; ${found} of ${decoded.length} telegrams known, ${errors} decode errors, ${ms} ms`;
      this.testStatus.className = loaded.errors || result.exitCode ? "hint err" : "hint ok";
      this.renderResults();
    } catch (err) {
      console.error(err);
      this.testStatus.textContent = `test failed: ${err.message}`;
      this.testStatus.className = "hint err";
    }
  }

  renderResults() {
    const box = this.resultBox;
    box.replaceChildren();
    if (!this.results) return;
    const { inputs, decoded, stderr } = this.results;
    const byInput = new Map(decoded.map((r) => [r.input, r]));
    const rows = inputs.map((i) => ({ ...i, r: byInput.get(i.line) })).filter((x) => !this.unknownOnly.checked || !x.r?.found);
    const table = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "n"), h("th", {}, "telegram"), h("th", {}, "message"), h("th", {}, "decoded"))),
      h("tbody", {}, rows.slice(0, 1000).map(({ line, n, r }) => h("tr", {},
        h("td", {}, fmt.count(n)),
        h("td", { class: "mono", title: line }, line.length > 44 ? line.slice(0, 42) + "…" : line),
        h("td", {}, !r ? h("span", { class: "muted" }, "—") : r.error ? h("span", { class: "err" }, r.error) : !r.found ? h("span", { class: "warn" }, "unknown") : h("span", { class: "ok" }, `${r.circuit ? r.circuit + " " : ""}${r.name}${r.write ? " (w)" : ""}${r.passive ? " (passive)" : ""}`)),
        h("td", { class: "mono", style: "white-space:normal" }, r?.found ? (r.result === "ok" ? r.text : h("span", { class: "err" }, r.result)) : "")))));
    append(box, table);
    if (stderr.length) append(box, h("div", { class: "log" }, stderr.slice(0, 50).join("\n")));
  }

  async deploy() {
    if (!this.outputs) return toast("compile first", "err");
    const subdir = this.subdir.value.trim().replace(/^\/+|\/+$/g, "");
    const names = Object.keys(this.outputs);
    const target = `${app.status?.deploy_dir || ""}${subdir ? "/" + subdir : ""}`;
    if (!confirm(`Write ${names.length} files to ${target}${this.clean.checked ? " and remove other .csv/.inc files there" : ""}?`)) return;
    try {
      const result = await api.post("api/deploy", { files: this.outputs, subdir, clean: this.clean.checked });
      this.deployStatus.textContent = `✓ ${result.written.length} files written to ${result.dir}${result.removed.length ? `, ${result.removed.length} removed` : ""}. Use --configpath=${result.dir} in the eBUSd app and restart it.`;
      this.deployStatus.className = "hint ok";
      app.settings = await api.put("api/settings", { deploy_subdir: subdir }).catch(() => app.settings);
      this.loadDeployed();
    } catch (err) {
      this.deployStatus.textContent = `deploy failed: ${err.message}`;
      this.deployStatus.className = "hint err";
    }
  }

  async loadDeployed() {
    try {
      const d = await api.get("api/deploy");
      this.deployList.textContent = d.exists && d.files.length
        ? `currently deployed: ${d.files.length} files, newest ${fmt.dateTime(Math.max(...d.files.map((f) => f.mtime_ms)))}`
        : "nothing deployed yet";
    } catch { /* ignore */ }
  }
}
