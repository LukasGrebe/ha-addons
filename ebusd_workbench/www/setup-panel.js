// My setup: the column on the right. ebusd's own choice (what it does today with its own
// definitions) plus your changes: what you added from other sources or the hidden ones, what you
// took out, what you renamed. Then everything else that fits the bus and could be added, how the
// setup shows up in Home Assistant, and the ways to save it: the CSV files for the eBUSd app
// (deploy or download), the climate and water heater entities, the eBUSd app options.
import { api, app, append, bus, fmt, h, toast } from "./app.js";
import { messageColors } from "./colors.js";
import { accessKind, describeConditions, kindSuffix } from "./compare.js";
import { generateEbusdOptions, generateHaYaml } from "./hayaml.js";
import { MINE, setup } from "./setup.js";

const STATUS_HELP = {
  active: "ebusd's choice with this source (file chosen by the scan, condition met)",
  variant: "from a file of another device variant: ebusd would not load it, but it decodes the recorded telegrams",
  conditional: "its condition was not met by the recorded telegrams, but it decodes them",
  hidden: "in the file ebusd loads, but another definition takes precedence",
  error: "matches the telegram but cannot decode it (wrong length or values)",
  companion: "not seen on the bus: the counterpart of a seen definition (usually for writing)",
  custom: "your own definition",
};
const STATUS_ORDER = { active: 0, custom: 1, hidden: 2, conditional: 3, variant: 4, error: 5, companion: 6 };

function download(name, text, type = "text/plain") {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("copied"); } catch { toast("copy failed: select the text and copy it", "err"); }
}

const msgChip = (circuit, name, extra = "") => { const c = messageColors(circuit, name); return h("span", { class: "chip-msg", style: `color:${c.text};background:${c.background};border-color:${c.border}` }, `${circuit ? circuit + " " : ""}${name}${extra}`); };
const srcBadge = (m) => h("span", { class: `tbadge ${m.source === MINE ? "custom" : m.source === "release" ? "" : "src"}`, title: `from ${m.sourceLabel || m.source}` }, m.source === MINE ? "mine" : m.sourceLabel || m.source);

export class SetupPanel {
  constructor(root) {
    this.root = root;
    this.filter = "";
    this.open = { baseline: false, others: false, ha: false };
    this.status = null;
    bus.on("decodes-changed", (reason) => { if (reason !== "progress") this.render(); });
    bus.on("setup-changed", () => this.render());
    bus.on("status", () => this.render());
    this.render();
  }

  get entries() { return app.decoder?.entries || []; }

  sourceLabels() { return Object.fromEntries((app.decoder?.sources() || []).map((s) => [s.id, s.label])); }

  /** What was sourced where: the sources, the devices and every included definition with how it fared. */
  manifest(included) {
    const d = app.decoder;
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
    return {
      generator: `ebusd Config Workbench ${app.status?.version || ""}`.trim(),
      created: new Date().toISOString(),
      note: "Which definitions this installation uses and where each one comes from. Written next to the CSV files; ebusd ignores it.",
      sources: (d?.sources() || []).filter((s) => s.enabled !== false).map((s) => ({ id: s.id, label: s.label, kind: s.kind, head: s.head || null, title: s.title || null, url: s.url || null })),
      devices: d?.devices() || {},
      recording: { distinct_telegrams: d?.telegrams.size || 0, from: iso(app.status?.db?.first_ms), to: iso(app.status?.db?.last_ms) },
      own_definitions: app.settings?.custom?.trim() ? app.settings.custom : undefined,
      changes: { added: setup.data.added, removed: setup.data.removed, circuits: setup.data.circuits },
      definitions: included.map((m) => {
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

  /** The files a deploy or download writes: the CSV files of the setup and the record of its sources. */
  deployFiles() {
    const entries = this.entries;
    const included = setup.includedEntries(entries);
    if (!included.length) return { files: {}, sources: [] };
    const result = setup.files(entries, this.sourceLabels());
    return { files: { ...result.files, "workbench-setup.json": `${JSON.stringify(this.manifest(included), null, 2)}\n` }, sources: result.sources };
  }

  render() {
    const root = this.root;
    const entries = this.entries;
    const included = setup.includedEntries(entries);
    const baseline = setup.baselineKeys(entries);
    const changes = setup.changes(entries);
    const nChanges = changes.added.length + changes.removed.length + changes.renamed.length + changes.circuits.length;
    const primaryLabel = app.decoder?.source(app.decoder.primary)?.label || "ebusd's definitions";
    root.replaceChildren(
      h("div", { class: "head" }, h("b", {}, "My setup"), h("span", { class: "muted" }, `${fmt.count(included.length)} definitions`)),
      h("div", { class: "hint pad8" }, `What this installation uses: ebusd's own choice (${fmt.count(baseline.length)} definitions of ${primaryLabel} fit your bus)${nChanges ? ` and your ${nChanges} change${nChanges === 1 ? "" : "s"}` : ", nothing changed yet"}. Pick definitions in the scratchpad or below; the names are what ebusd publishes once the files are saved for the eBUSd app.`),
      this.changesSection(changes, entries),
      this.baselineSection(included, changes, entries, primaryLabel),
      this.othersSection(included, entries),
      this.haSection(included, entries),
      this.exportSection(included, entries));
  }

  /** Your changes against ebusd's choice, each with a way back. */
  changesSection(changes, entries) {
    const items = [];
    for (const m of changes.added) items.push(h("div", { class: `item ${m.write ? "write" : ""}` }, h("div", { class: "line" },
      h("span", { class: "ok", title: "added to the setup" }, "+"), msgChip(setup.circuitOf(m), setup.exportName(m), kindSuffix(m)), srcBadge(m), h("span", { class: `badge ${m.status}`, title: STATUS_HELP[m.status] }, m.status),
      m.errors ? h("span", { class: "warn", title: `fails on ${m.errors} of ${m.distinct} recorded variants` }, "⚠") : null,
      h("span", { style: "margin-left:auto" }), h("button", { class: "small", title: "take it out again", onclick: () => setup.include(m.key, false, entries) }, "✕")),
      m.examples?.[0] ? h("div", { class: "mono muted example" }, m.examples[0].slice(0, 100)) : null));
    for (const m of changes.removed) items.push(h("div", { class: "item removed" }, h("div", { class: "line" },
      h("span", { class: "err", title: "taken out of ebusd's choice" }, "−"), msgChip(m.circuit, m.name, kindSuffix(m)), h("span", { class: "muted" }, "taken out"),
      h("span", { style: "margin-left:auto" }), h("button", { class: "small", title: "put it back", onclick: () => setup.include(m.key, true, entries) }, "↩"))));
    for (const m of changes.renamed) {
      const fields = Object.entries(setup.data.names[m.key]?.fields || {});
      items.push(h("div", { class: "item" }, h("div", { class: "line" },
        h("span", { class: "accent", title: "renamed" }, "✎"), msgChip(m.circuit, m.name), setup.exportName(m) !== m.name ? h("span", { class: "export" }, `→ ${setup.exportName(m)}`) : null,
        fields.length ? h("span", { class: "muted" }, fields.map(([a, b]) => `${a}→${b}`).join(", ")) : null,
        h("span", { style: "margin-left:auto" }), h("button", { class: "small", title: "the upstream names again", onclick: () => { setup.rename(m, m.name); for (const [field] of fields) setup.renameField(m, field, field); } }, "↩"))));
    }
    for (const [from, to] of changes.circuits) items.push(h("div", { class: "item" }, h("div", { class: "line" }, h("span", { class: "accent" }, "✎"), h("span", {}, "circuit "), h("span", { class: "mono" }, from), " → ", h("span", { class: "mono" }, to), h("span", { style: "margin-left:auto" }), h("button", { class: "small", onclick: () => setup.renameCircuit(from, from) }, "↩"))));
    if (changes.unknownAdded) items.push(h("div", { class: "hint pad8" }, `${changes.unknownAdded} added definition${changes.unknownAdded === 1 ? "" : "s"} of a source that is not loaded right now`));
    return h("div", { class: "changes" },
      h("div", { class: "section-head" }, h("b", {}, "Your changes"), h("span", { class: "muted" }, ` ${items.length}`), h("span", { style: "margin-left:auto" }), items.length ? h("button", { class: "small", title: "back to ebusd's own choice: additions, removals and names", onclick: () => { if (confirm("Back to ebusd's own choice? Your additions, removals, picks and names are forgotten (your own definition lines stay).")) setup.reset(); } }, "reset") : null),
      items.length ? h("div", { class: "list" }, items) : h("div", { class: "hint pad8" }, "None yet. Pick a card in the scratchpad, or add from the list below: what you add, take out or rename shows up here."));
  }

  /** ebusd's own choice, by circuit, folded: the bulk that needs no attention. */
  baselineSection(included, changes, entries, primaryLabel) {
    const added = new Set(changes.added.map((m) => m.key));
    const base = included.filter((m) => !added.has(m.key));
    const groups = new Map();
    for (const m of base) {
      const circuit = setup.circuitOf(m);
      if (!groups.has(circuit)) groups.set(circuit, []);
      groups.get(circuit).push(m);
    }
    const list = h("div", { class: "list" });
    for (const [circuit, defs] of [...groups.entries()].sort()) {
      const original = defs[0].circuit;
      const circuitInput = h("input", { type: "text", value: circuit, size: 8, title: `circuit name in my config (MQTT topic ebusd/<circuit>/…); upstream: ${original}`, onchange: () => setup.renameCircuit(original, circuitInput.value) });
      append(list, h("div", { class: "circuit" }, h("b", {}, "circuit "), circuitInput, circuit !== original ? h("span", { class: "muted" }, ` (upstream ${original})`) : null, h("span", { class: "muted", style: "margin-left:auto" }, `${defs.length} definitions`)));
      for (const m of defs.sort((a, b) => setup.exportName(a).localeCompare(setup.exportName(b)) || (a.write ? 1 : 0) - (b.write ? 1 : 0))) {
        const colors = messageColors(m.circuit, m.name);
        const exportName = setup.exportName(m);
        append(list, h("div", { class: `item ${m.write ? "write" : ""}`, title: `${m.file} (${m.sourceLabel || m.source})\n${STATUS_HELP[m.status] || ""}` },
          h("div", { class: "line" },
            h("span", { class: "chip-msg", style: `color:${colors.text};background:${colors.background};border-color:${colors.border}` }, exportName, kindSuffix(m)),
            exportName !== m.name ? h("span", { class: "muted", title: "upstream name" }, m.name) : null,
            m.errors ? h("span", { class: "warn", title: `fails on ${m.errors} of ${m.distinct} recorded variants` }, "⚠") : null,
            h("span", { style: "margin-left:auto" }),
            h("button", { class: "small", title: "take out of the setup", onclick: () => setup.include(m.key, false, entries) }, "✕")),
          m.examples?.[0] ? h("div", { class: "mono muted example" }, m.examples[0].slice(0, 100)) : null));
      }
    }
    if (!base.length) append(list, h("div", { class: "hint pad8" }, entries.length ? "ebusd uses none of the definitions that fit your bus (no device file for your devices?)." : app.decoder?.build ? "No definition matched the recording yet." : "Waiting for definitions…"));
    return h("details", { class: "baseline", open: this.open.baseline, ontoggle: (e) => { this.open.baseline = e.target.open; } },
      h("summary", {}, h("b", {}, `ebusd's choice: ${fmt.count(base.length)}`), h("span", { class: "muted" }, ` definitions of ${primaryLabel}, by circuit`)),
      list);
  }

  /** Everything else that fits the bus: hidden definitions, other variants, other sources, counterparts. */
  othersSection(included, entries) {
    const current = new Set(included.map((m) => m.key));
    const others = entries.filter((m) => !current.has(m.key));
    const q = this.filter.trim().toLowerCase();
    const hideFailing = !!app.settings?.ui?.hideFailing;
    const rows = others.filter((m) => !(hideFailing && m.errors > 0 && !m.companion) && (!q || `${m.circuit} ${m.name} ${setup.exportName(m)} ${m.file} ${m.sourceLabel} ${describeConditions(m)}`.toLowerCase().includes(q)))
      .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.zz.localeCompare(b.zz) || a.circuit.localeCompare(b.circuit) || a.name.localeCompare(b.name));
    const plausible = others.filter((m) => m.errors === 0 && m.ok > 0 && !["error", "companion"].includes(m.status));
    const counterparts = others.filter((m) => m.status === "companion" && m.companionOf.some((k) => current.has(k)));
    const search = h("input", { type: "search", placeholder: "filter: circuit, name, file, source", value: this.filter, oninput: () => { this.filter = search.value; this.render(); } });
    return h("details", { class: "others", open: this.open.others, ontoggle: (e) => { this.open.others = e.target.open; } },
      h("summary", {}, h("b", {}, `Also fits your bus: ${fmt.count(others.length)}`), h("span", { class: "muted" }, " definitions not in the setup")),
      h("div", { class: "row pad8" },
        h("button", { class: "small", disabled: !plausible.length, title: "also the hidden definitions and the ones of other sources that decode every recorded telegram they match without error", onclick: () => setup.setIncluded([...setup.includedKeys(entries), ...plausible.map((m) => m.key)], entries) }, `+ ${plausible.length} plausible`),
        h("button", { class: "small", disabled: !counterparts.length, title: "the write (and other direction) definitions belonging to included ones; they were not seen on the bus. Writing to a device with a definition of another variant can be harmful: include only what you are sure about.", onclick: () => setup.setIncluded([...setup.includedKeys(entries), ...counterparts.map((m) => m.key)], entries) }, `+ ${counterparts.length} counterparts`)),
      h("div", { class: "row pad8" }, search),
      h("div", { class: "list" }, rows.slice(0, 400).map((m) => h("div", { class: `item ${m.write ? "write" : ""}`, title: `${m.file} (${m.sourceLabel || m.source})${m.condition ? `\nonly when ${describeConditions(m)}` : ""}\n${STATUS_HELP[m.status] || ""}` },
        h("div", { class: "line" },
          h("button", { class: "small", title: "add to the setup", onclick: () => setup.include(m.key, true, entries) }, "+"),
          msgChip(m.circuit, m.name, kindSuffix(m)), srcBadge(m), h("span", { class: `badge ${m.status}` }, m.status),
          h("span", { class: "muted", style: "margin-left:auto" }, m.companion ? "not seen" : m.errors ? h("span", { class: m.ok ? "warn" : "err" }, `${m.ok} ok, ${m.errors} ✗`) : h("span", { class: "ok" }, `${fmt.count(m.occurrences)} ok`))),
        m.examples?.[0] ? h("div", { class: "mono muted example" }, m.examples[0].slice(0, 100)) : null)),
      rows.length > 400 ? h("div", { class: "hint pad8" }, `showing 400 of ${rows.length}: narrow the filter`) : null));
  }

  /** How the setup shows up in Home Assistant: the entities ebusd's MQTT discovery makes, and the climate/water heater YAML. */
  haSection(included, entries) {
    const messages = setup.haMessages(entries);
    const circuits = [...new Set(messages.map((m) => m.circuit))];
    const yamlPre = h("pre", {});
    const controller = h("select", { onchange: () => { yamlPre.textContent = generateHaYaml(messages, { controller: controller.value || undefined }); } }, h("option", { value: "" }, "auto"), circuits.map((c) => h("option", { value: c }, c)));
    yamlPre.textContent = included.length ? generateHaYaml(messages) : "# include definitions in the setup first";
    const entities = [];
    for (const m of included) {
      const fieldOf = setup.fieldMap(m);
      for (const field of Object.values(fieldOf)) entities.push({ name: `${setup.circuitOf(m)} ${setup.exportName(m)} ${field}`, topic: `ebusd/${setup.circuitOf(m)}/${setup.exportName(m)}`, write: m.write, field });
    }
    return h("details", { class: "ha", open: this.open.ha, ontoggle: (e) => { this.open.ha = e.target.open; } },
      h("summary", {}, h("b", {}, "In Home Assistant"), h("span", { class: "muted" }, ` ${fmt.count(entities.length)} entities`)),
      h("div", { class: "hint pad8" }, "ebusd's MQTT discovery (mqtt-hassio.cfg of the eBUSd app) makes a sensor, number or select per field, named after the circuit, message and field; what you rename in the scratchpad is renamed there. Composite climate and water heater entities are made by hand with the YAML below."),
      h("div", { class: "list entities" }, entities.slice(0, 300).map((e) => h("div", { class: `item ${e.write ? "write" : ""}` }, h("span", {}, e.name), h("span", { class: "mono muted", title: e.topic }, e.field))),
        entities.length > 300 ? h("div", { class: "hint pad8" }, `and ${entities.length - 300} more`) : null),
      h("div", { class: "row pad8" }, h("label", { class: "muted" }, "climate and water heater YAML for configuration.yaml · controller circuit "), controller, h("button", { class: "small", onclick: () => copyText(yamlPre.textContent) }, "copy YAML")),
      yamlPre);
  }

  exportSection(included, entries) {
    const settings = app.settings || {};
    const deployDir = app.status?.deploy_dir || "/share/ebusd/config";
    const files = this.deployFiles();
    const subdir = h("input", { type: "text", value: settings.deploy_subdir || "", placeholder: "subfolder (optional)", size: 12, onchange: () => api.put("api/settings", { deploy_subdir: subdir.value.trim() }).then((s) => { app.settings = s; }).catch((err) => toast(err.message, "err")) });
    const clean = h("input", { type: "checkbox", checked: true });
    const status = this.status ? h("div", { class: `hint pad8 ${this.status.cls}` }, this.status.text) : null;
    const target = () => `${deployDir}${subdir.value.trim() ? "/" + subdir.value.trim() : ""}`;
    const preview = h("pre", { style: "display:none" });
    const fileList = h("div", { class: "files" }, Object.entries(files.files).map(([name, text]) => h("a", { href: "#", class: "mono", title: "show", onclick: (e) => { e.preventDefault(); const same = preview.textContent === text && preview.style.display === ""; preview.textContent = text; preview.style.display = same ? "none" : ""; } }, name)));
    return h("div", { class: "exports" },
      h("div", { class: "row" }, h("b", {}, "Save for the eBUSd app")),
      h("div", { class: "hint" }, included.length ? `${fmt.count(included.length)} definitions from ${files.sources.length} files, one CSV file per circuit, conditions removed so that ebusd loads them for this installation without the scan. workbench-setup.json records what was sourced where.` : "Nothing to save yet."),
      fileList, preview,
      h("div", { class: "row" }, h("span", { class: "mono muted", title: "the deploy folder of the app configuration" }, deployDir), "/", subdir, h("label", { class: "muted", title: "remove other .csv/.inc files in that folder so that ebusd does not load stale definitions" }, clean, " remove other files")),
      h("div", { class: "row" },
        h("button", { class: "primary small", disabled: !included.length, onclick: async () => {
          if (!confirm(`Write ${Object.keys(files.files).length} files (${Object.keys(files.files).join(", ")}) to ${target()}${clean.checked ? " and remove other definition files there" : ""}?`)) return;
          try {
            const result = await api.post("api/deploy", { files: files.files, subdir: subdir.value.trim(), clean: clean.checked });
            this.status = { text: `✓ ${result.written.join(", ")} written to ${result.dir}${result.removed.length ? `; removed ${result.removed.length} other files` : ""}. Add --configpath=${result.dir} to the eBUSd app options and restart it.`, cls: "ok" };
          } catch (err) { this.status = { text: `deploy failed: ${err.message}`, cls: "err" }; }
          this.render();
        } }, "Deploy to eBUSd"),
        h("button", { class: "small", disabled: !included.length, onclick: () => { for (const [name, text] of Object.entries(files.files)) download(name, text, name.endsWith(".json") ? "application/json" : "text/csv"); } }, "Download"),
        h("button", { class: "small", disabled: !included.length, title: "the eBUSd app options for the setup: --configpath and the MQTT filter so that discovery publishes its messages", onclick: () => copyText(generateEbusdOptions(setup.haMessages(entries), target())) }, "copy eBUSd options")),
      status);
  }
}
