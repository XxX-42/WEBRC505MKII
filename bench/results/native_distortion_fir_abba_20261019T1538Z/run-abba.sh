#!/usr/bin/env bash
set -euo pipefail
RUN_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE=/tmp/rc505-native-distortion-abba-dfb3476/native_per_track_fx_bench.baseline
CAND=/tmp/rc505-native-profiler-uninstrumented-0ffe10c/native_per_track_fx_bench
run_one() {
  local label="$1" bin="$2"
  printf '{"run":"%s","startedUtc":"%s","binarySha256":"%s","command":"%s --topology=all-banks --pitch=off --warmup-callbacks=5000 --measured-callbacks=100000"}\n' "$label" "$(date -u +%FT%TZ)" "$(sha256sum "$bin" | cut -d' ' -f1)" "$bin" > "$RUN_DIR/$label.started.json"
  set +e
  timeout 300s "$bin" --topology=all-banks --pitch=off --warmup-callbacks=5000 --measured-callbacks=100000 > "$RUN_DIR/$label.json" 2> "$RUN_DIR/$label.stderr"
  local rc=$?
  set -e
  printf '{"run":"%s","finishedUtc":"%s","exitCode":%d,"stderrBytes":%d}\n' "$label" "$(date -u +%FT%TZ)" "$rc" "$(wc -c < "$RUN_DIR/$label.stderr")" > "$RUN_DIR/$label.finished.json"
  if [[ "$rc" -ne 0 ]]; then echo "$label failed: $rc"; return "$rc"; fi
}
printf '{"runId":"native_distortion_fir_abba_20261019T1538Z","baselineCommit":"dfb347640cb1813471467b3defad033b47c489de","candidateCommit":"d668a64aa895de6723a3ca05c4d346d5c06c0da3","topology":"20 private FX + 4 input FX + 4 shared FX + rhythm","sampleRateHz":48000,"framesPerCallback":64,"warmupCallbacks":5000,"measuredCallbacks":100000,"input":"synthetic 330 Hz mono at 0.1 peak; Input FX active; monitoring off","pitch":"off","backend":"portable Linux CPU callback simulator; no RtAudio hardware","measurement":"unprofiled std::chrono::steady_clock callback timing"}\n' > "$RUN_DIR/run.json"
sha256sum "$BASE" "$CAND" > "$RUN_DIR/binaries.sha256"
printf 'Start UTC %s; CPU count %s; initial load %s\n' "$(date -u +%FT%TZ)" "$(getconf _NPROCESSORS_ONLN)" "$(cat /proc/loadavg)" > "$RUN_DIR/host.txt"
grep -m1 'model name' /proc/cpuinfo >> "$RUN_DIR/host.txt" || true
run_one A1 "$BASE"
run_one B1 "$CAND"
run_one B2 "$CAND"
run_one A2 "$BASE"
printf 'End UTC %s; final load %s\n' "$(date -u +%FT%TZ)" "$(cat /proc/loadavg)" >> "$RUN_DIR/host.txt"
