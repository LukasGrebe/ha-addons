// Settings: Home Assistant entities to log, telegram grouping, and information about the app.
import { api, app, append, bus, fmt, h, toast, refreshStatus } from "./app.js";

export class SettingsView {
  constructor(root) {
    this.root = root;
    this.build();
    bus.on("status", () => this.renderInfo());
  }

  onShow() { this.render(); }

  build() {
    const el = (this.el = {});
    el.entities = h("div", { class: "panel" });
    el.grouping = h("div", { class: "panel" });
    el.info = h("div", { class: "panel" });
    this.root.appendChild(h("div", { class: "settings" }, el.entities, el.grouping, el.info));
    this.render();
  }

  render() {
    this.renderEntities();
    this.renderGrouping();
    this.renderInfo();
  }

  async saveSettings(changes) {
    try {
      app.settings = await api.put("api/settings", changes);
      bus.emit("settings-changed");
      refreshStatus();
      this.render();
    } catch (err) { toast(err.message, "err"); }
  }

  renderEntities() {
    const box = this.el.entities;
    const settings = app.settings || { entities: [] };
    const ha = app.status?.ha || {};
    box.replaceChildren(h("h2", {}, "Home Assistant entities"),
      h("div", { class: "hint" }, "State changes of these entities are stored in the telegram database (table ha_state) and shown in the timeline, e.g. the circulation pump switch or a thermostat. Notes made with the log command of the eBUSd terminal (table event) are shown as markers."),
      !ha.configured ? h("div", { class: "warn" }, `Home Assistant API not available: ${ha.last_error || "not running as app"}`) : ha.connected ? h("div", { class: "ok" }, `connected, ${ha.events_logged || 0} changes logged since start`) : h("div", { class: "err" }, `not connected: ${ha.last_error || "connecting…"}`));
    const list = h("div", { class: "entity-list" });
    for (const entity of settings.entities) {
      append(list, h("div", { class: "ent" }, h("span", { class: "id" }, entity),
        h("span", { class: "name" }, this.names?.get(entity) || ""),
        h("button", { class: "small", onclick: () => this.saveSettings({ entities: settings.entities.filter((e) => e !== entity) }) }, "remove")));
    }
    if (!settings.entities.length) append(list, h("div", { class: "hint" }, "no entities yet"));
    const input = h("input", { type: "search", placeholder: ha.configured ? "search entities to add (e.g. pump)" : "entity id (e.g. switch.circulation_pump)" });
    const dropdown = h("div", { class: "list", style: "display:none" });
    let timer = null;
    const search = async () => {
      const q = input.value.trim();
      if (!q) { dropdown.style.display = "none"; return; }
      if (!ha.configured) return;
      try {
        const { entities } = await api.get(`api/ha/entities?q=${encodeURIComponent(q)}`);
        this.names = this.names || new Map();
        for (const e of entities) this.names.set(e.entity_id, e.name);
        dropdown.replaceChildren(...entities.slice(0, 50).map((e) => h("div", { onclick: () => { input.value = ""; dropdown.style.display = "none"; this.saveSettings({ entities: [...settings.entities, e.entity_id] }); } },
          h("span", { class: "id" }, e.entity_id), h("span", { class: "name" }, `${e.name} (${e.state})`))));
        if (!entities.length) dropdown.replaceChildren(h("div", { class: "muted" }, "no match"));
        dropdown.style.display = "block";
      } catch (err) { toast(err.message, "err"); }
    };
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 250); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.includes(".")) { e.preventDefault(); this.saveSettings({ entities: [...settings.entities, input.value.trim()] }); input.value = ""; dropdown.style.display = "none"; }
      if (e.key === "Escape") dropdown.style.display = "none";
    });
    append(box, list, h("div", { class: "picker" }, input, dropdown), h("div", { class: "hint" }, "Enter adds the typed entity id directly."));
  }

  renderGrouping() {
    const box = this.el.grouping;
    const settings = app.settings || { id_bytes: 1, id_overrides: {} };
    const overrides = { ...(settings.id_overrides || {}) };
    const select = h("select", { onchange: () => this.saveSettings({ id_bytes: Number(select.value) }) }, [0, 1, 2, 3, 4].map((n) => h("option", { value: n, selected: n === settings.id_bytes }, `${n} byte${n === 1 ? "" : "s"}`)));
    const rows = h("div", { class: "overrides" });
    const renderRows = () => {
      rows.replaceChildren(...Object.entries(overrides).sort().map(([pbsb, n]) => h("div", { class: "ov" }, h("span", { class: "mono" }, pbsb), h("span", {}, `${n} bytes`),
        h("button", { class: "small", onclick: () => { delete overrides[pbsb]; this.saveSettings({ id_overrides: overrides }); } }, "remove"))));
    };
    renderRows();
    const pbsb = h("input", { type: "text", placeholder: "pbsb or zzpbsb, e.g. b509 or 08b509", size: 10, maxlength: 6 });
    const len = h("input", { type: "number", min: 0, max: 8, value: 3 });
    box.replaceChildren(h("h2", {}, "Telegram grouping"),
      h("div", { class: "hint" }, "A timeline row is one source, destination, command (PBSB) and message ID. The ID is the first data bytes of the master part; the remaining bytes and the answer are the value. Rows whose value seems to change with every telegram usually need more ID bytes, rows mixing several registers fewer. Per command (PBSB) or per device and command (ZZPBSB); the timeline offers the lengths of the decoded definitions after a decode run."),
      h("div", { class: "row", style: "margin:8px 0" }, h("label", {}, "default ID length: "), select),
      h("h3", {}, "per command"), rows,
      h("h3", {}, "per message (rows split or combined with + and −)"),
      h("div", { class: "hint" }, `${Object.keys(settings.id_rules || {}).length} rule${Object.keys(settings.id_rules || {}).length === 1 ? "" : "s"}: the + and − buttons next to a row in the timeline split it at its next byte or combine it with its neighbours, only for the telegrams starting with that prefix. "rows like the definitions" in the timeline sets them from the decoded definitions.`),
      h("div", { class: "row", style: "margin:6px 0" },
        h("button", { class: "small", disabled: !Object.keys(settings.id_rules || {}).length, onclick: () => this.saveSettings({ id_rules: {} }) }, "clear all rules"),
        h("button", { class: "small", title: "1 byte by default, 3 for b509 and 6 for b524, no rules", onclick: () => { if (confirm("Reset the grouping of the timeline to the defaults?")) this.saveSettings({ id_bytes: 1, id_overrides: { b509: 3, b524: 6 }, id_rules: {} }); } }, "reset grouping to the defaults")),
      h("div", { class: "ov" }, pbsb, len, h("button", { class: "small", onclick: () => {
        const key = pbsb.value.trim().toLowerCase();
        if (!/^([0-9a-f]{4}|[0-9a-f]{6})$/.test(key)) return toast("command must be PBSB or ZZPBSB in hex", "err");
        overrides[key] = Number(len.value);
        this.saveSettings({ id_overrides: overrides });
      } }, "add")));
  }

  renderInfo() {
    const box = this.el.info;
    const s = app.status;
    if (!s) return;
    box.replaceChildren(h("h2", {}, "About"),
      h("dl", { class: "kv" },
        h("dt", {}, "version"), h("dd", {}, s.version),
        h("dt", {}, "database"), h("dd", {}, `${s.db.path} (${s.db.exists ? `${fmt.bytes(s.db.size)}, ${fmt.count(s.db.telegrams)} telegrams, ${fmt.count(s.db.events)} events` : "missing"})`),
        h("dt", {}, "recorded"), h("dd", {}, s.db.first_ms ? `${fmt.dateTime(s.db.first_ms)} – ${fmt.dateTime(s.db.last_ms)}` : "nothing yet"),
        h("dt", {}, "repository"), h("dd", {}, `${s.repo.dir}${s.repo.remote ? ` (${s.repo.remote})` : ""}`),
        h("dt", {}, "deploy folder"), h("dd", {}, s.deploy_dir || ""),
        h("dt", {}, "uptime"), h("dd", {}, fmt.duration(s.uptime_s * 1000))),
      h("p", { class: "hint" }, "Compiling TypeSpec and decoding telegrams run in this browser tab, the app on the device only serves files and the database. ",
        h("a", { href: "https://github.com/LukasGrebe/ha-addons/blob/main/ebusd_workbench/DOCS.md", target: "_blank" }, "Documentation")));
  }
}
