// Web Worker running ebusd's message library (ebusd-check.wasm) off the UI thread. The compiled
// definition files are sent once per compile and kept here; every decode request carries only
// the telegram lines.
import { createEbusdCheck } from "./vendor/ebusd-check.js";

let check = null;
let files = {};
let filesId = null;

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "files") {
      files = msg.files;
      filesId = msg.id;
      self.postMessage({ reqId: msg.reqId, ok: true });
      return;
    }
    if (msg.type === "decode") {
      if (!check) check = await createEbusdCheck(new URL("./vendor/ebusd-check.wasm", self.location.href).href);
      if (msg.filesId !== undefined && msg.filesId !== filesId) throw new Error("definition files out of date in the worker");
      const result = await check({ files: msg.files || files, args: msg.args || [], stdin: msg.stdin || "" });
      self.postMessage({ reqId: msg.reqId, ok: true, result });
      return;
    }
    throw new Error(`unknown request ${msg.type}`);
  } catch (err) {
    self.postMessage({ reqId: msg.reqId, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
