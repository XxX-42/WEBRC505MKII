#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
engine="$repo_root/native-mvp/engine-cpp"
script_dir="$repo_root/bench/native_preamp_adaa_experiment"
cmake_bin="${CMAKE_BIN:-cmake}"
ctest_bin="${CTEST_BIN:-$(command -v ctest || true)}"
if [[ -z "$ctest_bin" && -x "$(dirname "$cmake_bin")/ctest" ]]; then
  ctest_bin="$(dirname "$cmake_bin")/ctest"
fi
ctest_bin="${ctest_bin:-ctest}"
cxx="${CXX:-c++}"
python="${PYTHON:-python3}"
out="${1:-/tmp/native-preamp-adaa-eval-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$out"

common_args=(-DNATIVE_PORTABLE_TESTS_ONLY=ON -DNATIVE_ENABLE_RUBBERBAND_HQ=OFF -DCMAKE_BUILD_TYPE=Release)
if [[ -n "${JSON_SRC:-}" ]]; then
  common_args+=(-DFETCHCONTENT_SOURCE_DIR_JSON_SRC="$JSON_SRC")
fi

printf 'source_head=%s\n' "$(git -C "$repo_root" rev-parse HEAD)" > "$out/run_manifest.txt"
printf 'cmake=%s\ncxx=%s\npython=%s\n' "$($cmake_bin --version | head -1)" "$($cxx --version | head -1)" "$($python --version 2>&1)" >> "$out/run_manifest.txt"
printf 'measurement_scope=portable Linux CPU callback simulation; no device/hardware acceptance\n' >> "$out/run_manifest.txt"

for variant in baseline candidate; do
  build="$out/build-$variant"
  if [[ "$variant" == baseline ]]; then
    exp=OFF
  else
    exp=ON
  fi
  "$cmake_bin" -S "$engine" -B "$build" "${common_args[@]}" -DNATIVE_PREAMP_EXPERIMENTAL_STABLE_ADAA="$exp"
  "$cmake_bin" --build "$build" -j "${JOBS:-2}"
  "$cmake_bin" -E env CTEST_OUTPUT_ON_FAILURE=1 "$cmake_bin" --build "$build" --target native_per_track_fx_bench -j "${JOBS:-2}"
  "$cmake_bin" --build "$build" --target native_preamp_processor_tests -j "${JOBS:-2}"
  "$cmake_bin" -E env CTEST_OUTPUT_ON_FAILURE=1 "$ctest_bin" --test-dir "$build" --output-on-failure -j "${TEST_JOBS:-2}" | tee "$out/ctest-$variant.txt"
  sha256sum "$build/native_per_track_fx_bench" >> "$out/run_manifest.txt"
done

# Paired PREAMP outputs across the full supported sample-rate range.
"$cxx" -O3 -DNDEBUG -std=c++17 -Wall -Wextra -Wpedantic -Werror \
  -I "$engine/include" "$script_dir/preamp_matrix_fixture.cpp" \
  "$engine/src/dsp_primitives.cpp" "$engine/src/native_preamp_processor.cpp" \
  -o "$out/preamp_matrix_baseline"
"$cxx" -O3 -DNDEBUG -std=c++17 -Wall -Wextra -Wpedantic -Werror \
  -DNATIVE_PREAMP_EXPERIMENTAL_STABLE_ADAA=1 -I "$engine/include" \
  "$script_dir/preamp_matrix_fixture.cpp" "$engine/src/dsp_primitives.cpp" \
  "$engine/src/native_preamp_processor.cpp" -o "$out/preamp_matrix_candidate"
{ time -p "$out/preamp_matrix_baseline" "$out/quality-baseline.raw.f32" "$out/quality-baseline.tsv" > "$out/quality-baseline.stdout"; } 2> "$out/quality-baseline.time"
{ time -p "$out/preamp_matrix_candidate" "$out/quality-candidate.raw.f32" "$out/quality-candidate.tsv" > "$out/quality-candidate.stdout"; } 2> "$out/quality-candidate.time"
"$python" "$script_dir/analyze_preamp_matrix.py" \
  --baseline-raw "$out/quality-baseline.raw.f32" --baseline-tsv "$out/quality-baseline.tsv" \
  --candidate-raw "$out/quality-candidate.raw.f32" --candidate-tsv "$out/quality-candidate.tsv" \
  --output "$out/quality-summary.json" | tee "$out/quality-summary.txt"

"$cxx" -O3 -DNDEBUG -std=c++17 -Wall -Wextra -Wpedantic -Werror \
  "$script_dir/numerical_oracle.cpp" -o "$out/numerical-oracle"
"$out/numerical-oracle" | tee "$out/numerical-oracle.txt"
"$cxx" -O3 -DNDEBUG -std=c++17 -Wall -Wextra -Wpedantic -Werror \
  "$script_dir/threshold_grid.cpp" -o "$out/threshold-grid"
"$out/threshold-grid" | tee "$out/threshold-grid.txt"

# ABBA on the same preconfigured 48 kHz / five-track / 20-FX CPU workload.
run_bench() {
  local label="$1" variant="$2" binary="$out/build-$2/native_per_track_fx_bench"
  local start end rc
  start="$(date -u +%Y%m%dT%H%M%SZ)"
  printf 'run=%s variant=%s start=%s source_head=%s binary_sha256=%s\n' \
    "$label" "$variant" "$start" "$(git -C "$repo_root" rev-parse HEAD)" \
    "$(sha256sum "$binary" | cut -d' ' -f1)" > "$out/bench-$label.meta"
  if { time -p "$binary" > "$out/bench-$label.json"; } 2> "$out/bench-$label.time"; then rc=0; else rc=$?; fi
  end="$(date -u +%Y%m%dT%H%M%SZ)"
  printf 'end=%s exit=%s\n' "$end" "$rc" >> "$out/bench-$label.meta"
  return "$rc"
}
run_bench A1 baseline
run_bench B1 candidate
run_bench B2 candidate
run_bench A2 baseline

sha256sum "$out"/bench-*.json "$out"/quality-*.raw.f32 > "$out/sha256sums.txt"
printf 'evidence_dir=%s\n' "$out" >> "$out/run_manifest.txt"
printf 'evaluation complete; inspect reports and do not interpret as hardware or subjective sound-quality acceptance\n'
