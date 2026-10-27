#!/usr/bin/env bash
# Build www/vendor/ebusd-check.wasm from the ebusd sources with zig (wasm32-wasi), see README.md.
# usage: build.sh EBUSD_SRC_DIR [OUT_FILE]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=$1 out=${2:-"$here/../../www/vendor/ebusd-check.wasm"}
ZIG=${ZIG:-"python3 -m ziglang"}
lib=$src/src/lib/ebus
$ZIG c++ -target wasm32-wasi -O2 -std=c++11 -fno-exceptions -DHAVE_CONFIG_H -DHAVE_CONTRIB \
  -I"$here/shim" -I"$src/src" \
  "$lib/result.cpp" "$lib/symbol.cpp" "$lib/filereader.cpp" "$lib/datatype.cpp" "$lib/data.cpp" \
  "$lib/message.cpp" "$lib/stringhelper.cpp" "$lib"/contrib/*.cpp "$src/src/lib/utils/clock.cpp" \
  "$here/src/log.cpp" "$here/src/pthread_stub.cpp" "$here/src/main.cpp" \
  -Wl,--strip-all -o "$out"
ls -la "$out"
