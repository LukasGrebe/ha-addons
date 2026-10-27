# Build tools for the browser components

The Workbench does the heavy lifting in the browser. Two generated files in `../www/vendor/`
make that possible; they are committed so that Supervisor can build the app on the device
without Node.js or a C++ toolchain.

| File | Content | Built by |
|---|---|---|
| `ebus-tsp.js` | [TypeSpec compiler](https://typespec.io) and the [eBUS TypeSpec library](https://github.com/john30/ebus-typespec) (the emitter that turns `.tsp` into ebusd CSV) with an in-memory file system, plus js-yaml for evidence profiles | `tsp-bundle/` |
| `ebusd-check.js` | loader that runs the WebAssembly below with an in-memory file system ([browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim)) | `tsp-bundle/` |
| `ebusd-check.wasm` | ebusd's own message library (`src/lib/ebus` of [john30/ebusd](https://github.com/john30/ebusd): CSV parsing, data types, message lookup and decoding) compiled to WebAssembly with a small `main` that loads CSV files and decodes telegrams, like `ebusd --checkconfig --inject`; `--candidates` lists every definition matching a telegram with its CSV line and siblings, and the scan file selection per device | `wasm/` |

## TypeSpec bundle

```bash
cd tools/tsp-bundle
npm ci
npm run build          # writes ../../www/vendor/ebus-tsp.js and ebusd-check.js
```

Update `@typespec/compiler` and `@ebusd/ebus-typespec` together in `package.json`: the library
pins the compiler version it works with (`peerDependencies`).

## ebusd WebAssembly

Needs [zig](https://ziglang.org) (0.14, also available as `pip install ziglang`) and the ebusd
sources of the release the eBUSd app runs:

```bash
git clone --depth 1 --branch 26.1 https://github.com/john30/ebusd.git /tmp/ebusd
ZIG="python3 -m ziglang" tools/wasm/build.sh /tmp/ebusd   # writes www/vendor/ebusd-check.wasm
```

`wasm/src/main.cpp` is the entry point (JSON lines on stdout), `wasm/src/log.cpp` replaces
ebusd's logger (stderr instead of syslog) and `wasm/src/pthread_stub.cpp` provides the mutex
functions of the single-threaded WASI libc. `wasm/loader.js` is the browser side.

Usage of the binary, e.g. with [wasmtime](https://wasmtime.dev):

```bash
wasmtime --dir /path/to/csv::/config www/vendor/ebusd-check.wasm -- --file=vaillant/08.bai.csv 1008b5110101/09000080ffff0000ff00
```
