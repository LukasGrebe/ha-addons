// Virtual in-memory CompilerHost for running the TypeSpec compiler in a browser.
// Layout: project files under /src, libraries under /src/node_modules/<name>.
export const ROOT = "/src";

function notFound(path) {
  const e = new Error(`File ${path} not found.`);
  e.code = "ENOENT";
  return e;
}

export function createVirtualHost(compiler, libs, projectFiles, logSink) {
  const { createSourceFile, getSourceFileKindFromExt, resolvePath } = compiler;
  const fs = new Map();
  const jsImports = new Map();
  const outputs = new Map();

  const abs = (p) => resolvePath(ROOT, p);
  for (const [name, lib] of Object.entries(libs)) {
    const base = `${ROOT}/node_modules/${name}`;
    for (const [rel, text] of Object.entries(lib.files)) fs.set(`${base}/${rel}`, text);
    for (const [rel, mod] of Object.entries(lib.js)) {
      fs.set(`${base}/${rel}`, "");
      jsImports.set(`${base}/${rel}`, mod);
    }
  }
  for (const [rel, text] of Object.entries(projectFiles)) fs.set(abs(rel), text);
  if (!fs.has(`${ROOT}/package.json`)) {
    fs.set(`${ROOT}/package.json`, JSON.stringify({
      name: "workbench",
      dependencies: Object.fromEntries(Object.entries(libs).map(([n, l]) => [n, l.version])),
    }));
  }

  return {
    outputs,
    async readUrl(url) { throw notFound(url); },
    async readFile(path) {
      path = abs(path);
      const text = fs.get(path);
      if (text === undefined) throw notFound(path);
      return createSourceFile(text, path);
    },
    async writeFile(path, content) {
      path = abs(path);
      outputs.set(path, content);
      fs.set(path, content);
    },
    async readDir(path) {
      path = abs(path);
      const names = new Set();
      for (const key of fs.keys()) {
        if (key.startsWith(path + "/")) {
          const rest = key.slice(path.length + 1);
          const i = rest.indexOf("/");
          names.add(i === -1 ? rest : rest.slice(0, i));
        }
      }
      return [...names];
    },
    async rm(path) {
      path = abs(path);
      for (const key of [...fs.keys()]) if (key === path || key.startsWith(path + "/")) fs.delete(key);
    },
    getLibDirs() { return [`${ROOT}/node_modules/@typespec/compiler/lib/std`]; },
    getExecutionRoot() { return `${ROOT}/node_modules/@typespec/compiler`; },
    async getJsImport(path) {
      path = abs(path);
      const mod = jsImports.get(path);
      if (mod === undefined) {
        const e = new Error(`Module ${path} not found`);
        e.code = "MODULE_NOT_FOUND";
        throw e;
      }
      return mod;
    },
    async stat(path) {
      path = abs(path);
      if (fs.has(path)) return { isDirectory: () => false, isFile: () => true };
      const prefix = path + "/";
      for (const key of fs.keys()) if (key.startsWith(prefix)) return { isDirectory: () => true, isFile: () => false };
      throw notFound(path);
    },
    async realpath(path) { return path; },
    getSourceFileKind: getSourceFileKindFromExt,
    logSink: logSink ?? { log: () => {} },
    mkdirp: async (path) => path,
    fileURLToPath: (url) => url.replace("inmemory:/", ""),
    pathToFileURL: (path) => "inmemory:/" + abs(path),
  };
}
