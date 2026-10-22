#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
BASELINE_COMMIT="${BASELINE_COMMIT:-dfb347640cb1813471467b3defad033b47c489de}"
OUT_DIR="${OUT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
CXX="${CXX:-c++}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/baseline"
git -C "$REPO_ROOT" show "$BASELINE_COMMIT:native-mvp/engine-cpp/src/native_distortion_processor.cpp" > "$TMP_DIR/baseline/native_distortion_processor.cpp"
git -C "$REPO_ROOT" show "$BASELINE_COMMIT:native-mvp/engine-cpp/include/native_distortion_processor.hpp" > "$TMP_DIR/baseline/native_distortion_processor.hpp"
"$CXX" -O3 -DNDEBUG -std=c++17 -I"$TMP_DIR/baseline" -I"$REPO_ROOT/native-mvp/engine-cpp/include" \
  "$OUT_DIR/oracle.cpp" "$TMP_DIR/baseline/native_distortion_processor.cpp" \
  "$REPO_ROOT/native-mvp/engine-cpp/src/dsp_primitives.cpp" -o "$TMP_DIR/oracle-baseline"
"$CXX" -O3 -DNDEBUG -std=c++17 -I"$REPO_ROOT/native-mvp/engine-cpp/include" \
  "$OUT_DIR/oracle.cpp" "$REPO_ROOT/native-mvp/engine-cpp/src/native_distortion_processor.cpp" \
  "$REPO_ROOT/native-mvp/engine-cpp/src/dsp_primitives.cpp" -o "$TMP_DIR/oracle-candidate"
"$TMP_DIR/oracle-baseline" > "$TMP_DIR/baseline.bin"
"$TMP_DIR/oracle-candidate" > "$TMP_DIR/candidate.bin"
cmp "$TMP_DIR/baseline.bin" "$TMP_DIR/candidate.bin"
wc -c "$TMP_DIR/baseline.bin" "$TMP_DIR/candidate.bin"
sha256sum "$TMP_DIR/baseline.bin" "$TMP_DIR/candidate.bin"
echo 'baseline and candidate bitstreams are identical'
