// Run ebusd-check.wasm (ebusd's message library compiled to WebAssembly) with an in-memory
// file system, in the browser or in Node.
import { WASI, File, Directory, PreopenDirectory, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";

const encoder = new TextEncoder();

function buildTree(files) {
  const root = new Map();
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/").filter((p) => p && p !== ".");
    if (parts.some((p) => p === "..")) throw new Error(`invalid path ${path}`);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let sub = dir.get(part);
      if (!sub) { sub = new Map(); dir.set(part, sub); }
      if (!(sub instanceof Map)) throw new Error(`${path}: ${part} is a file`);
      dir = sub;
    }
    const bytes = typeof content === "string" ? encoder.encode(content) : content;
    dir.set(parts[parts.length - 1], new File(bytes, { readonly: true }));
  }
  const toDirectory = (map) => {
    const entries = new Map();
    for (const [name, value] of map) entries.set(name, value instanceof Map ? toDirectory(value) : value);
    return new Directory(entries);
  };
  return toDirectory(root).contents;
}

/**
 * @param {WebAssembly.Module|BufferSource|string} source compiled module, wasm bytes or URL
 * @returns {Promise<(options: {files: Record<string, string|Uint8Array>, args?: string[], stdin?: string}) => {exitCode: number, stdout: string[], stderr: string[], results: object[]}>}
 */
export async function createEbusdCheck(source) {
  let module;
  if (source instanceof WebAssembly.Module) module = source;
  else if (typeof source === "string") {
    const response = await fetch(source);
    module = WebAssembly.compileStreaming
      ? await WebAssembly.compileStreaming(response).catch(async () => WebAssembly.compile(await (await fetch(source)).arrayBuffer()))
      : await WebAssembly.compile(await response.arrayBuffer());
  } else module = await WebAssembly.compile(source);

  return async function run({ files, args = [], stdin = "" }) {
    const stdout = [], stderr = [], results = [];
    const fds = [
      new OpenFile(new File(encoder.encode(stdin))),
      ConsoleStdout.lineBuffered((line) => {
        stdout.push(line);
        if (line.startsWith("{")) {
          try { results.push(JSON.parse(line)); } catch { /* keep as plain text */ }
        }
      }),
      ConsoleStdout.lineBuffered((line) => stderr.push(line)),
      new PreopenDirectory("/config", buildTree(files)),
    ];
    const wasi = new WASI(["ebusd-check", ...args], [], fds, { debug: false });
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
    let exitCode;
    try {
      exitCode = wasi.start(instance);
    } catch (e) {
      stderr.push(`ebusd-check crashed: ${e && e.message ? e.message : e}`);
      exitCode = -1;
    }
    return { exitCode, stdout, stderr, results };
  };
}
