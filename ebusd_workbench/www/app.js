// ebusd Config Workbench UI: one page, no modes. The bus (recorded telegrams on a timeline) on the
// left, the scratchpad below it (every definition that fits the selected message, from every
// source, to compare, tune and pick), the setup of this installation on the right (what is
// chosen, how it looks in Home Assistant, save for ebusd), the sources at the top and the less
// frequent things (settings, research) at the bottom. This module is the shell: API helper,
// status bar with the activity of the app, the views and the event bus between them.
import { Timeline } from "./timeline.js";
import { MessagesView } from "./messages.js";
import { Decoder } from "./decoder.js";
import { setup } from "./setup.js";
import { Builder, SourcesStrip } from "./sources.js";
import { Scratchpad } from "./scratchpad.js";
import { SetupPanel } from "./setup-panel.js";
import { Extras } from "./extras.js";

// All URLs are relative: the app is served through Home Assistant ingress under a prefix.
export const api = {
  async call(method, path, body, options = {}) {
    const headers = {};
    let payload;
    if (body !== undefined) {
      if (options.raw) {
        headers["Content-Type"] = "text/plain; charset=utf-8";
        payload = body;
      } else {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
    }
    // the device may be busy (the Home Assistant proxy answers 502/503/504 then): reads are tried again
    const attempts = method === "GET" ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(path, { method, headers, body: payload, cache: "no-store", signal: options.signal });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
        if (!response.ok) {
          const err = new Error((data && data.error) || `${response.status} ${response.statusText || "(the device did not answer in time)"}`);
          err.status = response.status;
          throw err;
        }
        return data;
      } catch (err) {
        if (err.name === "AbortError" || options.signal?.aborted) throw err;
        const transient = [502, 503, 504].includes(err.status) || err instanceof TypeError;
        if (!transient || attempt >= attempts) throw err;
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt * attempt));
      }
    }
  },
  get: (path, options) => api.call("GET", path, undefined, options),
  post: (path, body) => api.call("POST", path, body ?? {}),
  put: (path, body, options) => api.call("PUT", path, body, options),
  del: (path) => api.call("DELETE", path),
};

export function toast(message, kind = "info", ms = 4000) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") el.className = value;
    else if (key === "style") el.style.cssText = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "html") el.innerHTML = value;
    else if (value !== null && value !== undefined && value !== false) el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return el;
}

/** Append children to an element, skipping null/undefined/false (unlike Element.append). */
export function append(el, ...children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return el;
}

const pad = (n) => String(n).padStart(2, "0");
export const fmt = {
  hex: (n) => (n === null || n === undefined ? "--" : n.toString(16).padStart(2, "0")),
  time(ms, withMs = false) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` + (withMs ? `.${String(d.getMilliseconds()).padStart(3, "0")}` : "");
  },
  date(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },
  dateTime: (ms, withMs = false) => `${fmt.date(ms)} ${fmt.time(ms, withMs)}`,
  duration(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return "?";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
    if (ms < 3600_000) { const m = Math.round(ms / 60_000); return `${m} min`; }
    if (ms < 86400_000) { const hours = Math.floor(ms / 3600_000); const m = Math.round((ms % 3600_000) / 60_000); return m ? `${hours} h ${m} min` : `${hours} h`; }
    const days = Math.floor(ms / 86400_000); const hours = Math.round((ms % 86400_000) / 3600_000);
    return hours ? `${days} d ${hours} h` : `${days} d`;
  },
  bytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  },
  count: (n) => Number(n || 0).toLocaleString(),
};

// a tiny event bus for the views (bus <-> scratchpad <-> setup)
export const bus = {
  handlers: {},
  on(name, fn) { (this.handlers[name] ??= []).push(fn); },
  emit(name, data) { for (const fn of this.handlers[name] ?? []) fn(data); },
};

export const app = { status: null, settings: null, views: {}, decoder: null, builder: null, compileState: null, api };
window.workbench = app;  // for debugging and tests

/** What the app is busy with, in one place: fetching sources, compiling, reading the recording, decoding, loading the window. */
export function activity() {
  const parts = [];
  let fraction = null;
  for (const s of app.status?.sources?.sources || []) if (s.busy) parts.push(`${s.busy.what}… ${fmt.duration(Date.now() - s.busy.since * 1000)}`);
  if (app.compileState?.busy) parts.push(app.compileState.text);
  const st = app.decoder?.status();
  if (st?.progress) { parts.push(st.progress); fraction = st.fraction; }
  const tl = app.views.timeline;
  if (tl?.loading) parts.push(`loading telegrams ${fmt.time(tl.loading.from).slice(0, 5)}–${fmt.time(tl.loading.to).slice(0, 5)}`);
  const error = st?.error || app.compileState?.error || null;
  return { parts, fraction, st, error };
}

export function updateActivity() {
  const el = document.getElementById("activity");
  if (!el) return;
  const { parts, fraction, st, error } = activity();
  el.replaceChildren();
  el.className = "activity";
  if (parts.length) {
    el.classList.add("busy");
    const bar = h("div", { class: `progress ${fraction === null || fraction === undefined ? "indeterminate" : ""}` }, h("div", { style: fraction === null || fraction === undefined ? "" : `width:${Math.max(3, Math.round(fraction * 100))}%` }));
    append(el, h("span", { class: "spinner" }), h("span", { class: "text" }, parts.join(" · ")), bar);
  } else if (error) {
    el.classList.add("err");
    append(el, h("span", { class: "text", title: error }, error));
  } else if (st?.build) {
    append(el, h("span", { class: "text muted", title: `${st.build.summary}\n${st.decoded} of ${st.telegrams} distinct telegrams decoded with every source; store: ${st.store}` },
      `${fmt.count(st.definitions)} definitions fit your bus · ${fmt.count(st.known)} of ${fmt.count(st.telegrams)} telegrams known to ebusd`));
  }
}

function updateStatusBar() {
  const s = app.status;
  const bar = document.getElementById("status");
  bar.replaceChildren();
  if (!s) return;
  const db = s.db;
  const dbState = !db.exists ? "err" : db.has_telegram_table ? "ok" : "warn";
  const dbText = !db.exists ? "no database" : db.has_telegram_table ? `${fmt.count(db.telegrams)} telegrams` : "no telegrams yet";
  bar.appendChild(h("span", { class: `chip ${dbState}`, title: `${db.path}\n${fmt.bytes(db.size)}${db.first_ms ? `\nrecorded ${fmt.dateTime(db.first_ms)} – ${fmt.dateTime(db.last_ms)}` : ""}` }, dbText));
  const ha = s.ha;
  const haState = !ha.configured ? "warn" : ha.connected ? "ok" : "err";
  const haText = !ha.configured ? "HA: not available" : ha.connected ? `HA: ${ha.entities.length} entities` : "HA: disconnected";
  bar.appendChild(h("span", { class: `chip ${haState}`, title: ha.last_error || "state changes of the entities picked in the settings are drawn as flags in the events lane" }, haText));
  bar.appendChild(h("a", { class: "help", href: "https://github.com/LukasGrebe/ha-addons/blob/main/ebusd_workbench/DOCS.md", target: "_blank", rel: "noopener", title: "documentation" }, "?"));
  updateActivity();
}

export async function refreshStatus() {
  try {
    app.status = await api.get("api/status");
    app.settings = app.status.settings;
    updateStatusBar();
    bus.emit("status", app.status);
  } catch (err) {
    console.error(err);
  }
  return app.status;
}

/** The two views of the bus: the list of messages (the default) and the timeline. The choice is remembered. */
function bindBusViews() {
  const buttons = document.querySelectorAll("#bus-views button");
  const show = (name) => {
    for (const b of buttons) b.classList.toggle("active", b.dataset.view === name);
    document.getElementById("messages").style.display = name === "table" ? "" : "none";
    document.getElementById("timeline").style.display = name === "timeline" ? "" : "none";
    try { localStorage.setItem("workbench.busView", name); } catch { /* ignore */ }
    if (name === "timeline") app.views.timeline?.onShow?.(); else app.views.messages?.schedule?.();
  };
  for (const b of buttons) b.addEventListener("click", () => show(b.dataset.view));
  let saved = "table";
  try { saved = localStorage.getItem("workbench.busView") || "table"; } catch { /* ignore */ }
  show(saved === "timeline" ? "timeline" : "table");
}

/** The handle between the bus and the scratchpad: drag it to give either more room; the height is remembered. */
function bindPadResize() {
  const pad = document.getElementById("pad"), handle = document.getElementById("pad-handle"), left = handle.parentElement;
  try { const saved = Number(localStorage.getItem("workbench.padHeight")); if (saved >= 120) pad.style.setProperty("--pad-h", `${saved}px`); } catch { /* storage may be unavailable */ }
  let drag = null;
  handle.addEventListener("mousedown", (e) => { drag = { y: e.clientY, h: pad.offsetHeight }; e.preventDefault(); });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const max = Math.max(160, left.clientHeight - 160);
    const height = Math.round(Math.max(120, Math.min(max, drag.h + drag.y - e.clientY)));
    pad.style.setProperty("--pad-h", `${height}px`);
    drag.last = height;
    app.views.timeline?.render();
  });
  window.addEventListener("mouseup", () => {
    if (drag?.last) { try { localStorage.setItem("workbench.padHeight", String(drag.last)); } catch { /* ignore */ } }
    drag = null;
  });
}

async function main() {
  await refreshStatus();
  setup.load();
  app.decoder = new Decoder();
  app.builder = new Builder();
  app.views.sources = new SourcesStrip(document.getElementById("sources"));
  app.views.messages = new MessagesView(document.getElementById("messages"));
  app.views.timeline = new Timeline(document.getElementById("timeline"));
  app.views.pad = new Scratchpad(document.getElementById("pad"), app.views.messages);
  bindBusViews();
  app.views.setup = new SetupPanel(document.getElementById("setup"));
  app.views.extras = new Extras(document.getElementById("extras"));
  bindPadResize();
  bus.on("status", (status) => { setup.load(); app.builder.onStatus(status); updateActivity(); });
  bus.on("compile-state", (state) => { app.compileState = state; updateActivity(); });
  bus.on("decodes-changed", () => updateActivity());
  bus.on("activity", () => updateActivity());
  const poll = async () => { await refreshStatus(); setTimeout(poll, (app.status?.sources?.sources || []).some((s) => s.busy) ? 2000 : 10_000); };
  setTimeout(poll, 10_000);
  // the browser-side copy of the recording and its decodings; the views listen to "decodes-changed"
  app.decoder.init().then(() => app.builder.onStatus(app.status)).catch((err) => { console.error(err); toast(`store failed: ${err.message}`, "err", 8000); });
  setInterval(updateActivity, 1000);
}

// the page (not a test importing the modules in Node)
if (document.getElementById("bus")) main().catch((err) => { console.error(err); toast(`failed to start: ${err.message}`, "err", 10000); });
