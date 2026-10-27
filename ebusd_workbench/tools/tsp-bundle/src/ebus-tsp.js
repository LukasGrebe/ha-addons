// Browser entry: compile eBUS TypeSpec sources to ebusd CSV files, fully in memory.
import * as compiler from "@typespec/compiler";
import { libs } from "../gen/libs.js";
import { createVirtualHost, ROOT } from "./host.js";
import jsYaml from "js-yaml";

/** YAML parser (js-yaml, a dependency of the eBUS TypeSpec library), e.g. for ebus-evidence profiles. */
export const yaml = { load: (text) => jsYaml.load(text), dump: (obj) => jsYaml.dump(obj, { lineWidth: 120 }) };

export const versions = Object.fromEntries(Object.entries(libs).map(([n, l]) => [n, l.version]));

const EMITTER = "@ebusd/ebus-typespec";
const OUT_DIR = "/out";

/**
 * @param {Record<string,string>} files  project files, paths relative to the project root
 * @param {object} [opts]
 * @param {string} [opts.entry="main.tsp"]  entry file (relative)
 * @param {string} [opts.translations]  translation YAML file (relative), e.g. "de.yaml"
 * @param {boolean} [opts.withMinMax=true]
 * @param {string} [opts.withAttrs]
 * @param {boolean} [opts.includes]
 * @returns {Promise<{ok:boolean, outputs:Record<string,string>, diagnostics:Array, logs:Array}>}
 */
export async function compileEbusTsp(files, opts = {}) {
  const logs = [];
  const host = createVirtualHost(compiler, libs, files, { log: (l) => logs.push(l) });
  const entry = `${ROOT}/${opts.entry ?? "main.tsp"}`;
  const emitterOptions = {};
  if (opts.translations) emitterOptions.translations = `${ROOT}/${opts.translations}`;
  if (opts.withMinMax !== undefined) emitterOptions.withMinMax = opts.withMinMax;
  if (opts.withAttrs) emitterOptions.withAttrs = opts.withAttrs;
  if (opts.includes) emitterOptions.includes = true;
  const program = await compiler.compile(host, entry, {
    emit: [EMITTER],
    additionalImports: [EMITTER],
    outputDir: OUT_DIR,
    options: { [EMITTER]: emitterOptions },
    warningAsError: !!opts.warningAsError,
  });
  const diagnostics = program.diagnostics.map((d) => {
    const loc = safeLocation(d);
    return { severity: d.severity, code: d.code, message: d.message, ...loc };
  });
  const prefix = `${OUT_DIR}/${EMITTER}/`;
  const outputs = {};
  for (const [path, content] of host.outputs) {
    const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path.replace(/^\/out\//, "");
    outputs[rel] = content;
  }
  return { ok: !program.hasError(), outputs, diagnostics, logs };
}

function safeLocation(d) {
  try {
    const loc = compiler.getSourceLocation(d.target, { locateId: true });
    if (!loc || !loc.file) return {};
    const { line, character } = loc.file.getLineAndCharacterOfPosition(loc.pos);
    return { file: loc.file.path.replace(`${ROOT}/`, ""), line: line + 1, col: character + 1 };
  } catch {
    return {};
  }
}
