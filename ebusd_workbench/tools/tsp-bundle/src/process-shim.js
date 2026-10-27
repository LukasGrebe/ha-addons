// Minimal `process` for libraries that probe the environment at load time.
export const process = globalThis.process ?? {
  env: {},
  platform: "browser",
  argv: [],
  cwd: () => "/",
  versions: {},
  stdout: { isTTY: false },
  stderr: { isTTY: false },
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
};
