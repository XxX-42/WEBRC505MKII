# Full-runtime browser stress harness checkpoint

Status: diagnostic smoke **FAILED**; this is not the required 30-minute run.

## Harness and topology

The `full-runtime` profile instantiates the production `BrowserAudioEngine`, five `TrackAudio` loops, the production per-track `BrowserTrackFxChain`, `RhythmEngine`, and Signalsmith `LIVE_POLY`. The persistent graph contains exactly 35 instrumented AudioWorklet nodes:

- 28 `rc505-fx-processor` nodes: five tracks × four private A–D slots, four input FX, and four shared/postmix FX
- 5 `signalsmith-stretch` nodes, one for each active track
- 1 `rc505-rhythm-processor`
- 1 `rc505-browser-block-meter`

The profile uses deterministic synthetic stereo PCM and generated stereo input. It does not access a microphone or other user device. During sufficiently long measurements, it runs production recording/overdub plus PCM undo/redo operations and records their results. The Vue LCD UI and physical audio hardware are not part of this harness.

## Smoke command

```sh
node bench/run_browser_audio_worklet_stress.mjs \
  --profile full-runtime \
  --duration-seconds 5 \
  --operation-interval-seconds 2 \
  --browser /tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell \
  --output bench/results/full_runtime_smoke_20261018T1819Z.json
```

The runner launched Google Chrome for Testing headless shell 154.0.8037.57 with Playwright 1.58.2 and `chromiumSandbox: true`. No sandbox-disabling launch arguments were added. The browser page and production graph initialized successfully; all 35 worklet nodes registered and reported ready.

## Observed result

Run status and progress are preserved in `full_runtime_smoke_20261018T1819Z.status.json` and `full_runtime_smoke_20261018T1819Z.progress.json`.

- Result: **FAIL**. AudioContext advanced 3.454 seconds during 5.022 seconds wall time (68.8%), below the existing 95% threshold of 4.771 seconds. Context state was still `running` at the end.
- The output analyser observed changing, non-silent samples in 101/101 polls; no non-finite samples were observed, and peak level was 2.224 linear.
- All 35 nodes were ready. Callback errors: 0; frame-discontinuity-derived missing-callback estimates: 0; processor errors: 0. The observed audio sample frames nevertheless advanced substantially slower than wall time, so these zero error counters do not negate the failed progression guard.
- This five-second run was a harness smoke. No record/overdub operation was scheduled because the harness intentionally leaves at least 25 seconds after an operation for its asynchronous lifecycle to complete.
- This is not a 30-minute stress result, not a full Vue application test, not device/hardware XRUN measurement, and not an audio-quality acceptance result.

The first five-second result establishes a full-load software-rendering failure; subsequent labeled controls below examine the major contributors without changing the 95% threshold.

## Follow-up diagnostics (same checkout, 2026-10-18)

These are separate short controls, not full-load acceptance. Each run uses the same CfT 154 headless shell and synthetic input. There are no record/overdub operations in these windows.

| Profile | Active worklets | Context advance / wall | Result |
| --- | ---: | ---: | --- |
| Full 35-node graph, preflight measurement | 35: 28 FX + 5 LIVE_POLY + rhythm + block-meter | 7.062 / 10.001 s (70.6%) | FAIL, below 95% |
| Full 35-node graph, preflight measurement | 35: same as above | 3.579 / 5.050 s (70.9%) | FAIL, below 95% |
| Full 35-node graph, callback measurement | 35: same as above | 3.727 / 5.050 s (73.8%) | FAIL, below 95% |
| FX-heavy control, LIVE_POLY omitted | 30: 28 FX + rhythm + block-meter | 8.417 / 10.050 s (83.8%) | FAIL, below 95% |
| Shared/input FX + LIVE_POLY control; private A–D omitted | 15: 8 FX + 5 LIVE_POLY + rhythm + block-meter | 10.048 / 10.050 s (99.98%) | Clock guard PASS for this reduced diagnostic only |
| Shared/input FX control; private A–D and LIVE_POLY omitted | 10: 8 FX + rhythm + block-meter | 10.031 / 10.050 s (99.81%) | Clock guard PASS for this reduced diagnostic only |

These comparisons implicate the active per-track effect load, with further slowdown when the five LIVE_POLY processors are combined with it. They do not isolate an individual algorithm or establish that the browser has a stable hardware deadline. The full 35-node graph still fails. The relevant status, progress, failure JSON, and successful diagnostic JSON are committed beside this report with unique timestamps.

The full-graph callback-timing diagnostic could not measure individual callback cost: AudioWorklet `performance.now()` is unavailable in this CfT environment. Its `Date.now()` fallback observed only one positive 1 ms step in 4,097 reads (4,095 zero steps); the harness therefore marks P50/P95/P99/P999/deadline timings ineligible and suppresses them. The context-advance comparison is a coarse software-rendering ratio, not a substitute for those timings.

## Relative FX kernel diagnostic

`bench/microbench_browser_fx_worklet.mjs` runs the actual checked-in `public/worklets/fx-processor.js` processor in a Node VM with a synthetic stereo block. The 2026-10-18 run is preserved in `fx_worklet_node_vm_microbench_20261018T1831Z.json` and includes the source SHA-256. Highest relative single-node costs were DIST 0.936× audio duration, GATE REVERB 0.901×, PHASER 0.893×, TAPE ECHO 0.806×, FDN8 REVERB 0.751×, PREAMP 0.697×, and CHORUS 0.640×. These are direct-kernel CPU ratios in this Node VM; they exclude browser scheduling, the multi-node graph, Signalsmith, and device callbacks. They are useful for hotspot selection only and cannot pass a real-time gate.
