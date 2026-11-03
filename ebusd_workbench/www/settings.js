// Settings: Home Assistant entities to log, and information about the app.
import { api, app, append, bus, fmt, h, toast, refreshStatus } from "./app.js";

export class SettingsView {
  /** @param options {entities, info}: which panels to show (all by default) */
  constructor(root, options = {}) {
    this.root = root;
    this.options = { entities: true, info: true, ...options };
    this.build();
    bus.on("status", () => this.renderInfo());
  }

  onShow() { this.render(); }

  build() {
    const el = (this.el = {});
    el.entities = h("div", { class: "panel" });
    el.info = h("div", { class: "panel" });
    const o = this.options;
    this.root.appendChild(h("div", { class: "settings" }, o.entities ? el.entities : null, o.info ? el.info : null));
    this.render();
  }

  render() {
    if (this.options.entities) this.renderEntities();
    if (this.options.info) this.renderInfo();
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
      h("div", { class: "hint" }, "State changes of these entities are stored in the telegram database (table ha_state) next to the telegrams, e.g. the circulation pump switch or a thermostat. Notes made with the log command of the eBUSd terminal (table event) are shown as markers."),
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

  renderInfo() {
    const box = this.el.info;
    const s = app.status;
    if (!s || !this.options.info) return;
    box.replaceChildren(h("h2", {}, "About"),
      h("dl", { class: "kv about" },
        h("dt", {}, "version"), h("dd", {}, s.version),
        h("dt", {}, "database"), h("dd", {}, `${s.db.path} (${s.db.exists ? `${fmt.bytes(s.db.size)}, ${fmt.count(s.db.telegrams)} telegrams, ${fmt.count(s.db.events)} events` : "missing"})`),
        h("dt", {}, "recorded"), h("dd", {}, s.db.first_ms ? `${fmt.dateTime(s.db.first_ms)} – ${fmt.dateTime(s.db.last_ms)}` : "nothing yet"),
        h("dt", {}, "sources"), h("dd", {}, `${s.sources?.dir || ""} (${(s.sources?.sources || []).map((x) => x.id).join(", ") || "none"}; language ${s.sources?.language || "en"})`),
        h("dt", {}, "deploy folder"), h("dd", {}, s.deploy_dir || ""),
        h("dt", {}, "uptime"), h("dd", {}, fmt.duration(s.uptime_s * 1000))),
      h("p", { class: "hint" }, "Compiling pull requests and decoding telegrams run in this browser tab (ebusd's own message library as WebAssembly); the app on the device serves the recording and fetches the sources from GitHub. ",
        h("a", { href: "https://github.com/LukasGrebe/ha-addons/blob/main/ebusd_workbench/DOCS.md", target: "_blank" }, "Documentation")));
  }
}
