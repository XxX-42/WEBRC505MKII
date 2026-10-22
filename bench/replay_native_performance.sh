#!/usr/bin/env bash
# Rebuild both revisions with the SAME current benchmark harness, outside the repo.
set -euo pipefail
SOURCE=$(git rev-parse --show-toplevel)
BASELINE=${BASELINE:-dd7dbea}
WORK=${1:?Usage: bench/replay_native_performance.sh /absolute/empty/work-directory}
CMAKE=${CMAKE:-cmake}
CPU=${CPU:-0}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
if [[ -e "$WORK/baseline-source" || -e "$WORK/final-build" ]]; then
  echo 'Use a fresh work directory; existing builds are not overwritten.' >&2
  exit 1
fi
mkdir "$WORK/baseline-source"
git -C "$SOURCE" archive "$BASELINE" | tar -x -C "$WORK/baseline-source"
ENGINE=native-mvp/engine-cpp
# Only the opt-in benchmark target definitions and their source are overlaid.
# Baseline production DSP headers/sources remain byte-for-byte from BASELINE.
cp "$SOURCE/$ENGINE/CMakeLists.txt" "$WORK/baseline-source/$ENGINE/CMakeLists.txt"
for file in native_benchmark_access.hpp native_performance_matrix.cpp native_performance_soak.cpp native_preamp_ab_probe.cpp native_catalog_ab_probe.cpp native_catalog_sanity_sweep.cpp; do
  cp "$SOURCE/$ENGINE/tests/$file" "$WORK/baseline-source/$ENGINE/tests/$file"
done
"$CMAKE" -S "$WORK/baseline-source/$ENGINE" -B "$WORK/baseline-build" -DCMAKE_BUILD_TYPE=Release -DNATIVE_PORTABLE_TESTS_ONLY=ON
python3 "$SOURCE/bench/build_native_verified.py" --cmake "$CMAKE" --source "$WORK/baseline-source/$ENGINE" --build "$WORK/baseline-build" --manifest "$WORK/baseline-build-manifest.json"
"$CMAKE" -S "$SOURCE/$ENGINE" -B "$WORK/final-build" -DCMAKE_BUILD_TYPE=Release -DNATIVE_PORTABLE_TESTS_ONLY=ON
python3 "$SOURCE/bench/build_native_verified.py" --cmake "$CMAKE" --source "$SOURCE/$ENGINE" --build "$WORK/final-build" --manifest "$WORK/final-build-manifest.json"
"$WORK/baseline-build/native_preamp_ab_probe" > "$WORK/baseline.pcm"
"$WORK/final-build/native_preamp_ab_probe" > "$WORK/final.pcm"
cmp "$WORK/baseline.pcm" "$WORK/final.pcm"
"$WORK/baseline-build/native_catalog_ab_probe" > "$WORK/baseline-catalog.pcm"
"$WORK/final-build/native_catalog_ab_probe" > "$WORK/final-catalog.pcm"
cmp "$WORK/baseline-catalog.pcm" "$WORK/final-catalog.pcm"
cd "$SOURCE"
python3 bench/run_native_performance_matrix.py --baseline "$WORK/baseline-build/native_performance_matrix" --candidate "$WORK/final-build/native_performance_matrix" --matrix "$WORK/final-build/native_performance_matrix" --output "$WORK/results" --cpu "$CPU" --baseline-source-root "$WORK/baseline-source" --build-manifest "$WORK/final-build-manifest.json"
python3 bench/run_native_supplements.py "$WORK/final-build/native_performance_matrix" "$WORK/results/native-supplements.json" "$CPU"
# Explicitly wall-clock paced. This is a stability test, not a physical stream.
python3 bench/run_native_soak.py "$WORK/final-build/native_performance_soak" "$WORK/results/native-soak.json" 600
