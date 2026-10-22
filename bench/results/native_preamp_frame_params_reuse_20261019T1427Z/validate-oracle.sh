#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
BASELINE_REF="${1:-fb3bd757e8cf77697dcb2fc1661669279fb4378e}"
CXX="${CXX:-g++}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SOURCE_PATH=native-mvp/engine-cpp/src/native_preamp_processor.cpp
HEADER_PATH=native-mvp/engine-cpp/include/native_preamp_processor.hpp
git -C "$ROOT" show "$BASELINE_REF:$SOURCE_PATH" > "$TMP/native_preamp_processor_baseline.cpp"
mkdir -p "$TMP/baseline-include"
git -C "$ROOT" show "$BASELINE_REF:$HEADER_PATH" > "$TMP/baseline-include/native_preamp_processor.hpp"
FLAGS=(-O3 -DNDEBUG -std=c++17 -Wall -Wextra -Wpedantic -Werror)
INCLUDE=(-I "$ROOT/native-mvp/engine-cpp/include")
DSP="$ROOT/native-mvp/engine-cpp/src/dsp_primitives.cpp"
HARNESS="$ROOT/bench/results/native_preamp_frame_params_reuse_20261019T1427Z/oracle.cpp"

"$CXX" "${FLAGS[@]}" -I "$TMP/baseline-include" "${INCLUDE[@]}" "$HARNESS" "$TMP/native_preamp_processor_baseline.cpp" "$DSP" -o "$TMP/baseline"
"$CXX" "${FLAGS[@]}" "${INCLUDE[@]}" "$HARNESS" "$ROOT/$SOURCE_PATH" "$DSP" -o "$TMP/candidate"
"$TMP/baseline" > "$TMP/baseline.out"
"$TMP/candidate" > "$TMP/candidate.out"
diff -u "$TMP/baseline.out" "$TMP/candidate.out"
cat "$TMP/candidate.out"
printf 'bitwise-equivalent across all 18 sample-rate/channel cases\n'
