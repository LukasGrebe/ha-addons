// eBUSd Workbench UI: shell, API helper, status bar, tabs.
import { Timeline } from "./timeline.js";
import { Definitions } from "./definitions.js";
import { SettingsView } from "./settings.js";
import { Decoder } from "./decoder.js";
import { setup } from "./setup.js";

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
    const response = await fetch(path, { method, headers, body: payload, cache: "no-store" });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
    if (!response.ok) throw new Error((data && data.error) || `${response.status} ${response.statusText}`);
    return data;
  },
  get: (path) => api.call("GET", path),
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
  count: (n) => n.toLocaleString(),
};

// a tiny event bus for the views (timeline <-> definitions)
export const bus = {
  handlers: {},
  on(name, fn) { (this.handlers[name] ??= []).push(fn); },
  emit(name, data) { for (const fn of this.handlers[name] ?? []) fn(data); },
};

export const app = { status: null, settings: null, views: {}, decoder: null };
window.workbench = app;  // for debugging and tests

function updateStatusBar() {
  const s = app.status;
  const bar = document.getElementById("status");
  bar.replaceChildren();
  if (!s) return;
  const db = s.db;
  const dbState = !db.exists ? "err" : db.has_telegram_table ? "ok" : "warn";
  const dbText = !db.exists ? "no database" : db.has_telegram_table ? `${fmt.count(db.telegrams)} telegrams` : "no telegrams yet";
  bar.appendChild(h("span", { class: `chip ${dbState}`, title: `${db.path}\n${fmt.bytes(db.size)}` }, dbText));
  const ha = s.ha;
  const haState = !ha.configured ? "warn" : ha.connected ? "ok" : "err";
  const haText = !ha.configured ? "HA: not available" : ha.connected ? `HA: ${ha.entities.length} entities` : "HA: disconnected";
  bar.appendChild(h("span", { class: `chip ${haState}`, title: ha.last_error || "" }, haText));
  const repo = s.repo;
  const repoText = !repo.exists ? "no repository" : `${repo.branch || "?"}${repo.changes?.length ? ` · ${repo.changes.length} changed` : ""}${repo.ahead ? ` ↑${repo.ahead}` : ""}${repo.behind ? ` ↓${repo.behind}` : ""}`;
  bar.appendChild(h("span", { class: `chip ${repo.exists ? (repo.changes?.length ? "warn" : "ok") : ""}`, title: repo.dir || "" }, repoText));
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

function showTab(name) {
  for (const button of document.querySelectorAll("#tabs button")) button.classList.toggle("active", button.dataset.tab === name);
  for (const section of document.querySelectorAll("main .tab")) section.classList.toggle("active", section.id === `tab-${name}`);
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  app.views[name]?.onShow?.();
}

async function main() {
  await refreshStatus();
  setup.load();
  app.decoder = new Decoder();
  app.views.timeline = new Timeline(document.getElementById("tab-timeline"));
  app.views.definitions = new Definitions(document.getElementById("tab-definitions"));
  app.views.settings = new SettingsView(document.getElementById("tab-settings"));
  document.getElementById("tabs").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-tab]");
    if (button) showTab(button.dataset.tab);
  });
  bus.on("show-tab", showTab);
  showTab(["timeline", "definitions", "settings"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "timeline");
  setInterval(refreshStatus, 10_000);
  // the browser-side copy of the recording and its decodings; the views listen to "decodes-changed"
  app.decoder.init().catch((err) => { console.error(err); toast(`store failed: ${err.message}`, "err", 8000); });
}

// the page (not a test importing the modules in Node)
if (document.getElementById("tabs")) main().catch((err) => { console.error(err); toast(`failed to start: ${err.message}`, "err", 10000); });
