# Browser AudioWorklet stress run (2026-10-17)

Status: **Gate 7 software-functional subcheck passed**. This is not an overall Gate 7 pass and does not satisfy Native hardware, physical-device, acoustic, full-app, precise CPU-budget, or XRUN acceptance.

## Workload and environment

- Chromium: Google Chrome for Testing headless-shell 154.0.8037.57; Playwright 154.0.8037.57; Node v24.19.0
- Browser sandbox requested; runner recorded no `--no-sandbox`/setuid-sandbox disabling flag
- AudioContext requested and ran at 48,000 Hz
- Graph: four production Browser input FX, four production Browser shared Track A–D FX, one production Signalsmith LIVE_POLY track node, production RhythmEngine node; five looping synthetic track sources, separate synthetic input source
- A test-only pass-through AudioWorklet was inserted at the final bus and polled via AnalyserNode to keep headless software rendering observable. This is not a physical audio endpoint.
- Requested measurement: 1,800 real-wall seconds. Actual measured duration: 1,800.000675 seconds; runner elapsed 1,805.0 seconds including setup/cleanup.
- Raw browser result: `result.json`; runner output: `runner.log`; external process-memory checkpoints: `process-memory.csv` (CSV line endings normalized to LF after capture; recorded cell values are preserved).

## Verified software-functional results

- 10/10 instrumented processors ready; AudioContext stayed running and advanced 1,799.970667 seconds (ratio 0.9999833 to wall time)
- Each of the 10 production worklet nodes received 674,989 callbacks and 86,398,592 output frames; each callback-coverage ratio was 1.0
- Observed software-side callback/frame-gap estimates: 0; callback errors: 0; instrumentation errors: 0; non-finite output samples: 0
- Independent final-bus probe: 674,989 callbacks and 86,398,592 output frames
- Output sentinel: 36,001/36,001 polls non-silent, 36,000/36,000 windows changed; peak 0.4125 linear; sentinel passed
- V8 heap reported 13.4 MB at start and 11.9 MB at end (`performance.memory`)
- Summed process-tree RSS from 60-second samples (excluding the t=0 sample before Chromium spawned): 683,268–734,824 KiB, average 699,624 KiB. This is a rough sum of process RSS and can double-count shared mapped pages. From 120 seconds onward it ranged 683,268–702,976 KiB; it is not PSS or physical memory use.

## Limits and exclusions

- AudioWorklet callback timing used `Date.now()` with a 1,000 μs resolution floor. CPU quantiles and callback-deadline metrics are suppressed (`null`), and CPU-budget/P99/P99.9 acceptance is **unmeasured**, not passed with zeroes.
- Web Audio exposes no direct XRUN counter here; no hardware-device, driver, acoustic, dropout audibility, or sound-quality claim is made.
- This synthetic headless graph is not the complete Vue application or production device path and does not test recording/overdub/undo/redo/bounce, user audio, or physical output.
- Rhythm and loops use synthetic/clean-room sources, not factory Roland samples or hardware equivalence.
