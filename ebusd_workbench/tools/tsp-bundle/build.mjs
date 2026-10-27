// Bundle the TypeSpec compiler and the eBUS TypeSpec library for the browser (www/vendor/ebus-tsp.js).
// Also bundles the WASI shim loader of ebusd-check.wasm (www/vendor/ebusd-check.js).
import { build } from "esbuild";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const LIBS = ["@typespec/compiler", "@ebusd/ebus-typespec"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function libRoot(name) {
  return join(here, "node_modules", name);
}

// Collect each library's .tsp files + package.json, and the JS modules its .tsp files import.
let gen = "";
const entries = [];
let n = 0;
for (const name of LIBS) {
  const root = libRoot(name);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files = { "package.json": JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main, tspMain: pkg.tspMain, exports: pkg.exports }) };
  const js = {};
  const tspFiles = walk(join(root, "lib")).filter((f) => f.endsWith(".tsp"));
  for (const f of tspFiles) {
    const rel = relative(root, f).split("\\").join("/");
    files[rel] = readFileSync(f, "utf8");
    for (const m of files[rel].matchAll(/^\s*import\s+"([^"]+\.js)"\s*;/gm)) {
      const target = relative(root, resolve(dirname(f), m[1])).split("\\").join("/");
      js[target] = true;
    }
  }
  if (pkg.main) js[pkg.main.replace(/^\.\//, "")] = true;
  const jsEntries = [];
  for (const rel of Object.keys(js)) {
    const id = `m${n++}`;
    const importPath = relative(join(here, "gen"), join(root, rel)).split("\\").join("/");
    gen += `import * as ${id} from "${importPath.startsWith(".") ? importPath : "./" + importPath}";\n`;
    jsEntries.push(`${JSON.stringify(rel)}: ${id}`);
  }
  entries.push(`${JSON.stringify(name)}: { version: ${JSON.stringify(pkg.version)}, files: ${JSON.stringify(files)}, js: { ${jsEntries.join(", ")} } }`);
}
gen += `export const libs = {\n${entries.join(",\n")}\n};\n`;
mkdirSync(join(here, "gen"), { recursive: true });
writeFileSync(join(here, "gen", "libs.js"), gen);

await build({
  entryPoints: [join(here, "src", "ebus-tsp.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  outfile: join(here, "..", "..", "www", "vendor", "ebus-tsp.js"),
  define: { "process.env.NODE_ENV": '"production"' },
  inject: [join(here, "src", "process-shim.js")],
  alias: { path: join(here, "src", "path-shim.js"), "node:path": join(here, "src", "path-shim.js") },
  logLevel: "info",
});

await build({
  entryPoints: [join(here, "..", "wasm", "loader.js")],
  nodePaths: [join(here, "node_modules")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  outfile: join(here, "..", "..", "www", "vendor", "ebusd-check.js"),
  logLevel: "info",
});
