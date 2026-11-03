// Settings: the events next to the telegrams (which Home Assistant entities are watched, and how),
// the connection to Home Assistant with a test of its steps, and information about the app.
import { api, app, append, bus, fmt, h, toast, refreshStatus } from "./app.js";
import { defaultColor, defaultMode } from "./events.js";

const MODES = [["interval", "on/off stretches"], ["value", "value changes"]];

export class SettingsView {
  /** @param options {events, connection, info}: which panels to show (all by default) */
  constructor(root, options = {}) {
    this.root = root;
    this.options = { events: true, connection: true, info: true, ...options };
    this.testResult = null;
    this.build();
    bus.on("status", () => { this.renderConnection(); this.renderInfo(); });
    bus.on("events-changed", () => this.renderEvents());
  }

  onShow() { this.render(); }

  build() {
    const el = (this.el = {});
    el.events = h("div", { class: "panel" });
    el.connection = h("div", { class: "panel" });
    el.info = h("div", { class: "panel" });
    const o = this.options;
    this.root.appendChild(h("div", { class: "settings" }, o.events ? el.events : null, o.connection ? el.connection : null, o.info ? el.info : null));
    this.render();
  }

  render() {
    if (this.options.events) this.renderEvents();
    if (this.options.connection) this.renderConnection();
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

  /** Which entities are watched next to the telegrams, and how: on/off stretches or value changes, a name, a colour. */
  renderEvents() {
    const box = this.el.events;
    if (!box) return;
    const events = app.settings?.events || [];
    const ha = app.status?.ha || {};
    const recorded = new Map((app.events?.entities || []).map((e) => [e.entity, e.n]));
    box.replaceChildren(h("h2", {}, "Events next to the telegrams"),
      h("div", { class: "hint" }, "A switch or a binary sensor (the circulation pump, the burner, a heating request) is watched as on/off stretches: the list shows which messages arrived while it was on, the chart draws the stretches behind the values. Any other entity is watched as value changes. The changes are stored next to the telegrams (table ha_state); notes made with the log command of the eBUSd terminal (table event) are shown as well."));
    const list = h("div", { class: "entity-list" });
    const save = (next) => this.saveSettings({ events: next });
    const add = (entity, label = "") => { if (events.some((e) => e.entity === entity)) { toast(`${entity} is watched already`); return; } save([...events, { entity, mode: defaultMode(entity), on: "on", label: label || entity.split(".").slice(1).join(".").replace(/_/g, " "), color: defaultColor(entity) }]); };
    const update = (entity, patch) => save(events.map((e) => (e.entity === entity ? { ...e, ...patch } : e)));
    for (const ev of events) {
      const n = recorded.get(ev.entity);
      append(list, h("div", { class: "ent" },
        h("input", { type: "color", value: ev.color || defaultColor(ev.entity), title: "the colour of this event in the list and the charts", onchange: (e) => update(ev.entity, { color: e.target.value }) }),
        h("span", { class: "id", title: ev.entity }, ev.entity),
        h("input", { type: "text", class: "label", value: ev.label || "", placeholder: "name", title: "how the event is called in the list", onchange: (e) => update(ev.entity, { label: e.target.value.trim() }) }),
        h("select", { title: "on/off stretches: from the change to its on value until the next change away from it; value changes: every change as a point", onchange: (e) => update(ev.entity, { mode: e.target.value }) },
          MODES.map(([id, label]) => h("option", { value: id, selected: id === (ev.mode || defaultMode(ev.entity)) }, label))),
        (ev.mode || defaultMode(ev.entity)) === "interval" ? h("input", { type: "text", class: "onvalue", value: ev.on || "on", title: "the state that counts as on (on also means true, open, heating, running, …)", onchange: (e) => update(ev.entity, { on: e.target.value.trim() || "on" }) }) : null,
        h("span", { class: "name muted" }, n ? `${fmt.count(n)} changes recorded` : "nothing recorded yet"),
        h("button", { class: "small", title: "stop watching this entity (its recorded changes stay in the database)", onclick: () => save(events.filter((e) => e.entity !== ev.entity)) }, "remove")));
    }
    if (!events.length) append(list, h("div", { class: "hint" }, "nothing is watched yet: add the circulation pump, the burner, a heating request…"));
    // recorded by an earlier setting but not watched now: one click brings it back
    for (const [entity, n] of recorded) if (!events.some((e) => e.entity === entity)) append(list, h("div", { class: "ent muted" }, h("span", { class: "id" }, entity), h("span", { class: "name" }, `${fmt.count(n)} changes recorded, not watched`), h("button", { class: "small", onclick: () => add(entity) }, "watch")));
    const input = h("input", { type: "search", placeholder: ha.configured ? "search entities to watch (e.g. pump)" : "entity id (e.g. switch.circulation_pump)" });
    const dropdown = h("div", { class: "list", style: "display:none" });
    let timer = null;
    const search = async () => {
      const q = input.value.trim();
      if (!q) { dropdown.style.display = "none"; return; }
      if (!ha.configured) return;
      try {
        const { entities } = await api.get(`api/ha/entities?q=${encodeURIComponent(q)}`);
        dropdown.replaceChildren(...entities.slice(0, 50).map((e) => h("div", { onclick: () => { input.value = ""; dropdown.style.display = "none"; add(e.entity_id, e.name); } },
          h("span", { class: "id" }, e.entity_id), h("span", { class: "name" }, `${e.name} (${e.state})`))));
        if (!entities.length) dropdown.replaceChildren(h("div", { class: "muted" }, "no match"));
        dropdown.style.display = "block";
      } catch (err) { toast(err.message, "err"); }
    };
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 250); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.includes(".")) { e.preventDefault(); add(input.value.trim()); input.value = ""; dropdown.style.display = "none"; }
      if (e.key === "Escape") dropdown.style.display = "none";
    });
    append(box, list, h("div", { class: "picker" }, input, dropdown), h("div", { class: "hint" }, "Enter adds the typed entity id directly."));
  }

  /** The connection to Home Assistant: its state, a test of its steps, the log of its attempts. */
  renderConnection() {
    const box = this.el.connection;
    if (!box) return;
    const ha = app.status?.ha || {};
    const ago = (ms) => (ms ? `${fmt.duration(Math.max(0, Date.now() - ms))} ago` : "never");
    const state = !ha.configured ? h("div", { class: "warn" }, `not available: ${ha.last_error || "not running as a Home Assistant app"}`)
      : ha.connected ? h("div", { class: "ok" }, `connected since ${fmt.dateTime(ha.connected_since_ms || Date.now())} · last message ${ago(ha.last_message_ms)} · last pong ${ago(ha.last_pong_ms)} · ${ha.reconnects || 0} reconnects · ${(ha.entities || []).length} entities watched · ${fmt.count(ha.events_logged || 0)} changes logged since start`)
        : h("div", { class: "err" }, `not connected: ${ha.last_error || "connecting…"}${ha.last_error_ms ? ` (${fmt.dateTime(ha.last_error_ms)})` : ""}`);
    const result = this.testResult;
    const steps = result ? h("ul", { class: "ha-steps" }, result.steps.map((s) => h("li", { class: s.ok ? "ok" : "err" }, `${s.ok ? "✓" : "✗"} ${s.step}: ${s.detail}`))) : null;
    const testButton = h("button", { class: "small", title: "connect, authenticate, subscribe and ping once, apart from the running connection, and say which step fails", onclick: async () => {
      testButton.disabled = true;
      try { this.testResult = await api.post("api/ha/test"); } catch (err) { this.testResult = { ok: false, steps: [{ step: "request", ok: false, detail: err.message }] }; }
      this.renderConnection();
    } }, "test the connection");
    const log = (ha.log || []).slice().reverse();
    box.replaceChildren();
    append(box, h("h2", {}, "Home Assistant connection"),
      h("div", { class: "hint" }, `${ha.url || "ws://supervisor/core/websocket"} with the app's token; a quiet connection is pinged every 30 s`),
      state, h("div", { class: "row" }, testButton, result ? h("span", { class: result.ok ? "ok" : "err" }, result.ok ? "every step works" : "a step fails") : null), steps,
      log.length ? h("details", {}, h("summary", { class: "muted" }, `connection log (${log.length})`), h("pre", { class: "log ha-log" }, log.map(([ms, text]) => `${fmt.dateTime(ms)}  ${text}`).join("\n"))) : null);
  }

  renderInfo() {
    const box = this.el.info;
    const s = app.status;
    if (!s || !box || !this.options.info) return;
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
