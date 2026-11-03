// The less frequent things, at the bottom of the page in one section that folds open: the browser
// store, the settings (Home Assistant entities to watch) and what this app is.
import { app, append, bus, fmt, h } from "./app.js";
import { SettingsView } from "./settings.js";

export class Extras {
  constructor(root) {
    this.root = root;
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
      this.section("Advanced", "the browser store, settings, about this app",
        h("div", { class: "xs-parts" },
          h("div", {}, h("h3", {}, "Browser store"), this.storePanel()),
          h("div", {}, h("h3", {}, "Settings and about"), aboutRoot))));
    this.updateStore();
  }

  updateStore() {
    const el = this.storeBox;
    const st = app.decoder?.status();
    if (!st) { el.textContent = ""; return; }
    if (st.progress) { el.textContent = st.progress; return; }
    const per = st.sources.filter((s) => s.enabled && !s.error).map((s) => `${s.label}: ${fmt.count(s.definitions)} fit`).join("; ");
    el.textContent = `${fmt.count(st.telegrams)} distinct telegrams in the browser (${fmt.count(st.decoded)} decoded with ${st.sources.find((s) => s.id === st.primary)?.label || "ebusd's definitions"}, ${fmt.count(st.known)} known to ebusd); ${per}${st.lastSync ? `; read ${fmt.time(st.lastSync)}` : ""} (store: ${st.store}).`;
  }

  storePanel() {
    return h("div", {},
      h("div", { class: "hint" }, "Every distinct telegram of the recording is kept in this browser (IndexedDB) with what every definition decodes from it, in Web Workers running ebusd's message library. Another browser reads the recording again but sees the same setup."),
      this.storeBox,
      h("div", { class: "row" },
        h("button", { class: "small", title: "decode everything again with the sources as they are", onclick: () => app.decoder?.decodeAgain() }, "decode again"),
        h("button", { class: "small", title: "forget the browser-side copy of the recording and its decodings (the recording and the sources are not touched)", onclick: async () => { if (confirm("Forget the browser store (telegrams, decodings)? It is read again from the recording.")) await app.decoder.reset(); } }, "reset store")));
  }
}
