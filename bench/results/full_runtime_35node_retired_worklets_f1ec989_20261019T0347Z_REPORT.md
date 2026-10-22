# Full-runtime retired-worklet soak (failed)

- Run ID: `full_runtime_35node_retired_worklets_f1ec989_20261019T0347Z`
- Tested tree: `f1ec9892f4cc2624fd798720b2e2696ef95c4b6e`
- Command: `node bench/run_browser_audio_worklet_stress.mjs --profile full-runtime --duration-minutes 30 --sample-rate-hz 44100 --operation-interval-seconds 30 --browser /tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell --output bench/results/full_runtime_35node_retired_worklets_f1ec989_20261019T0347Z.json`
- Browser: Google Chrome for Testing headless shell 154.0.8037.57, actual AudioContext 44.1 kHz
- Measurement: 2026-10-19 03:47:09.873Z–04:17:09.924Z, 1,800.050345 s. Browser measurement completed, but test result is **FAIL**.
- Workload: full production BrowserAudioEngine + five TrackAudio tracks, 20 active private A–D FX, four input FX, four shared-track FX, five LIVE_POLY processors, production RhythmEngine. 35 initial nodes; 59 operations at 30 s intervals (10 record/clear/restore cycles and 49 overdub/undo/redo cycles), all completed. 104 instrumented node slots observed; peak capacity 104/112. Test-only instrumentation SAB was 84.8827 MiB.

## Results

- AudioContext advanced 1,780.053333 s of the 1,800.050345 s wall interval (98.8891%); the software progression guard passed. This is not device timing or hardware XRUN evidence.
- Output sentinel passed: 294,846,464 values inspected, 0 non-finite, non-silent poll ratio 1.0. This is software-rendered headless output, not acoustic quality or physical output.
- All 20 private FX coverage checks passed. All 59 scheduled operations completed without an operation exception.
- Worklet callback coverage failed. Eight dynamic-node aggregate entries failed because one or more active intervals failed: 11 LIVE_POLY one-quantum intervals (128 expected frames) and one overdub interval. Ten of the 11 one-quantum LIVE_POLY intervals recorded zero callback/output frames; one recorded 128 frames while the callback delta remained zero. Do not treat these as ineligible without establishing lifecycle/frame semantics.
- The overdub interval was slot 45, Track 3, frames 12,032,384–12,046,848: 14,464 expected, 13,696 observed (107 callbacks), 94.6903%; the 768-frame difference is six 128-frame quanta. Its ACK/stop operation succeeded, but this coverage interval did not meet the 95% threshold.
- Callback exceptions and processor errors: 0. Final callback accounting estimated 35 missing callbacks/4,480 frames, one 128-frame estimate on each of 35 currently live nodes (30 persistent graph nodes plus five LIVE_POLY nodes). Across those counters there were 35 frame rewinds and 70 discontinuities. This accounting is separate from the 12 active-interval failures above and requires follow-up; it is not a zero-gap result.
- Worklet clock was `Date.now()` fallback with 1,000 μs resolution; exact callback CPU percentiles and deadline timing are ineligible/unmeasured. No hardware device/XRUN measurement was made.

## Evidence files

- `full_runtime_35node_retired_worklets_f1ec989_20261019T0347Z.status.json` — terminal state and runner summary; state `failed` at 04:17:12.100Z.
- `full_runtime_35node_retired_worklets_f1ec989_20261019T0347Z.progress.json` — final counters, lifecycle inventory, all 59 operations and FX coverage.
- `full_runtime_35node_retired_worklets_f1ec989_20261019T0347Z.failure.json` — full browser diagnostic and terminal failure detail.

SHA-256:

- status: `57edf7683d3ac525645eae4446bcfa32809af12555310b5f6905583945ed15ed`
- progress: `05d70f4a84a5e06094b83fa4d184c219a27b7923a80aba5d7444fa2cb3e7f457`
- failure: `6d77bb01651e4a167f210f227877d37939a13c116c118f84666a9a5b82975581`

The runner did not produce the requested `.json` success file because coverage failure produced the `.failure.json` terminal artifact instead. Failure evidence is preserved; no threshold was lowered.
