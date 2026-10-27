// The less frequent things, at the bottom of the page in one section that folds open: research
// with ebus-evidence (profile checks over the recording, the raw log export), the browser store
// and pasted telegrams, the settings (Home Assistant entities to watch, telegram grouping) and
// what this app is.
import { api, app, append, bus, fmt, h, toast } from "./app.js";
import { SettingsView } from "./settings.js";
import { describeMatch, fmtTime, parseAddressMap, runProfile, summaryJson } from "./evidence.js";

function download(name, text, type = "text/plain") {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}

export class Extras {
  constructor(root) {
    this.root = root;
    this.evidenceRun = null;
    this.build();
    bus.on("decodes-changed", (reason) => { if (reason !== "progress") this.updateStore(); });
    bus.on("status", () => this.updateStore());
  }

  section(title, hint, body, { open = false, cls = "" } = {}) {
    return h("details", { class: `xs ${cls}`, open }, h("summary", {}, h("b", {}, title), hint ? h("span", { class: "muted" }, ` ${hint}`) : null), h("div", { class: "xs-body" }, body));
  }

  build() {
    const aboutRoot = h("div");
    this.settings = new SettingsView(aboutRoot);
    this.storeBox = h("div", { class: "hint" });
    append(this.root,
      this.section("Advanced", "research with ebus-evidence, the browser store, pasted telegrams, settings, about this app",
        h("div", { class: "xs-parts" },
          h("div", {}, h("h3", {}, "Research with ebus-evidence"), this.evidencePanel()),
          h("div", {}, h("h3", {}, "Browser store and pasted telegrams"), this.advancedPanel()),
          h("div", {}, h("h3", {}, "Settings and about"), aboutRoot))));
    this.updateStore();
  }

  // -- the browser store -------------------------------------------------------------------------------

  updateStore() {
    const el = this.storeBox;
    const st = app.decoder?.status();
    if (!st) { el.textContent = ""; return; }
    if (st.progress) { el.textContent = st.progress; return; }
    if (!st.build) { el.textContent = `${fmt.count(st.telegrams)} distinct telegrams in the browser store; waiting for definitions to decode them.`; return; }
    const per = st.build.sources.map((s) => `${s.label}: ${fmt.count(s.definitions)} definitions fit, ${fmt.count(s.known)} telegrams known${s.loaded?.errors ? ` (${s.loaded.errors} file errors)` : ""}`).join("; ");
    el.textContent = `${fmt.count(st.telegrams)} distinct telegrams (${fmt.count(st.decoded)} decoded with every source); ${per}${st.lastSync ? `; synced ${fmt.time(st.lastSync)}` : ""} (store: ${st.store}).`;
  }

  advancedPanel() {
    const input = h("textarea", { rows: 3, class: "rawcsv", placeholder: "telegrams to decode by hand, one per line: QQZZPBSBNNDD/NNDD, e.g. 1008b5110101/0938…" });
    return h("div", {},
      h("div", { class: "hint" }, "Every distinct telegram of the recording is kept in this browser (IndexedDB) and decoded with every source as it arrives, in Web Workers running ebusd's message library. Another browser decodes the recording again but sees the same setup."),
      this.storeBox,
      h("div", { class: "row" },
        h("button", { class: "small", title: "decode the whole recording again with every source", onclick: async () => { const d = app.decoder; if (!d?.build) return; await d.dropSources(d.sources().map((s) => s.id)); await d.setBuild(d.build); } }, "decode again"),
        h("button", { class: "small", title: "forget the browser-side copy of the recording and its decodings (the database and the sources are not touched)", onclick: async () => { if (confirm("Forget the browser store (telegrams, decodings)? It is rebuilt from the database.")) await app.decoder.reset(); } }, "reset store")),
      h("div", { class: "hint", style: "margin-top:8px" }, "Telegrams pasted here (as in ebusctl grab or the telegram log) are decoded like recorded ones and counted as not seen:"),
      input,
      h("div", { class: "row" }, h("button", { class: "small", onclick: () => { const lines = input.value.split("\n").filter((l) => l.trim()); if (!lines.length) return; app.decoder.addManual(lines).then(() => { input.value = ""; toast(`${lines.length} telegrams added`); }); } }, "Decode these too")));
  }

  // -- ebus-evidence ---------------------------------------------------------------------------------------

  evidencePanel() {
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
        const tsp = await app.builder.loadCompiler();
        const profile = tsp.yaml.load(profileText.value);
        if (!profile || !Array.isArray(profile.checks)) throw new Error("the profile has no checks list");
        const from = new Date(fromInput.value).getTime(), to = new Date(toInput.value).getTime();
        if (!(from < to)) throw new Error("invalid time range");
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
      const { run: r, from, to } = this.evidenceRun;
      const table = h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", {}, "check"), h("th", {}, "match"), h("th", {}, "seen"), h("th", {}, "first / last"), h("th", {}, "values"), h("th", {}, "responses"))),
        h("tbody", {}, r.checks.map((c) => h("tr", {},
          h("td", {}, h("b", {}, c.id), h("div", { class: "muted" }, c.description)),
          h("td", { class: "mono", style: "white-space:normal" }, describeMatch(c.match, r.addressMap)),
          h("td", {}, c.distinct ? `${fmt.count(c.occurrences)} (${c.distinct} distinct)` : h("span", { class: "muted" }, "none")),
          h("td", { class: "mono" }, c.distinct ? `${fmtTime(c.first_ms)}\n${fmtTime(c.last_ms)}` : ""),
          h("td", {}, h("div", { class: "values" }, [...c.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, n]) => h("span", { title: `${n}×` }, `${v} ×${n}`))), c.decodeErrors ? h("div", { class: "err" }, `${c.decodeErrors} decode errors`) : null),
          h("td", {}, h("div", { class: "values" }, [...c.responses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([x, n]) => h("span", { title: `${n}×` }, `${x.length > 24 ? x.slice(0, 22) + "…" : x} ×${n}`))))))));
      append(body, table, h("div", { class: "row" },
        h("button", { onclick: () => download(`evidence-summary-${r.profile}.json`, JSON.stringify(summaryJson(r, from, to), null, 2), "application/json") }, "Download summary (JSON)"),
        h("span", { class: "hint" }, "A summary for discussion; the verified bundle comes from ebus-evidence itself, from the raw log below.")));
    };
    // raw log export
    const toLocal = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
    const db0 = app.status?.db;
    const fromInput = h("input", { type: "datetime-local", value: toLocal(db0?.first_ms || Date.now() - 3600e3) });
    const toInput = h("input", { type: "datetime-local", value: toLocal(db0?.first_ms ? db0.last_ms + 1000 : Date.now()) });
    const broken = h("input", { type: "checkbox" });
    const ownInput = h("input", { type: "text", value: own, size: 3, title: "ebusd's own address on this bus (--address)", onchange: () => this.saveOwnAddress(ownInput.value) });
    return h("div", {},
      h("div", { class: "hint" }, "Profiles of ", h("a", { href: "https://github.com/MarcelT87/ebus-evidence", target: "_blank", rel: "noopener" }, "ebus-evidence"),
        " describe telegrams the research is looking at. Running one here shows what your bus carries for each check. Addresses are per installation: a profile written where ebusd ran as f1 names f1 as the source of ebusd's requests, so map it to your own address (31 in the eBUSd app unless changed)."),
      h("div", { class: "row" },
        h("button", { class: "small", onclick: async () => { try { profileText.value = await (await fetch("evidence/hw5103-open-evidence.yaml")).text(); } catch (err) { toast(err.message, "err"); } } }, "load example profile (hw5103)"),
        h("label", { class: "muted", title: addresses.title }, "addresses ", addresses),
        h("button", { class: "primary small", onclick: run }, "Run checks on the time range"), status),
      h("div", { class: "row" }, h("b", {}, "Time range"), fromInput, "–", toInput,
        h("button", { class: "small", onclick: () => { fromInput.value = toLocal(Date.now() - 3600e3); toInput.value = toLocal(Date.now()); } }, "last hour"),
        h("button", { class: "small", onclick: () => { const db = app.status?.db; if (db?.first_ms) { fromInput.value = toLocal(db.first_ms); toInput.value = toLocal(db.last_ms + 1000); } } }, "whole recording")),
      profileText, body,
      h("div", { class: "row", style: "margin-top:10px" }, h("b", {}, "ebusd raw log for ebus-evidence"), h("span", { class: "hint" }, "the recorded telegrams as ebusd message-mode raw log (--lograwdata); run ebus-evidence doctor / import / export on another computer for a verified bundle")),
      h("div", { class: "row" }, h("span", { class: "muted" }, "the time range above"),
        h("label", { class: "muted" }, broken, " include broken telegrams"), h("label", { class: "muted" }, "own address ", ownInput),
        h("button", { class: "small", onclick: () => {
          const f = new Date(fromInput.value).getTime(), t = new Date(toInput.value).getTime();
          if (!(f < t)) return toast("invalid time range", "err");
          window.open(`api/export/rawlog?from=${f}&to=${t}&own=${encodeURIComponent(ownInput.value)}${broken.checked ? "&all=1" : ""}`, "_blank");
        } }, "Download raw log")));
  }

  async saveOwnAddress(value) {
    const address = String(value).trim().toLowerCase();
    if (!/^[0-9a-f]{2}$/.test(address)) return toast("own address must be a hex byte, e.g. 31", "err");
    try { app.settings = await api.put("api/settings", { own_address: address }); } catch (err) { toast(err.message, "err"); }
  }
}
