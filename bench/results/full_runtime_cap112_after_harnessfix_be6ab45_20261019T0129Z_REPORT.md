# Browser full-runtime stress: 35-node graph, 30 minutes

## Run identity
- Run ID: `full_runtime_cap112_after_harnessfix_be6ab45_20261019T0129Z`
- Source HEAD: `be6ab4534b6154f95a0391d40f368a460db116c5`
- Start: 2026-10-19T01:29:16.011Z; terminal: 2026-10-19T01:59:27.930Z
- Browser: Google Chrome for Testing 154.0.8037.57 headless shell; sandbox requested; no extra launch arguments
- Profile: `full-runtime`, 44.1 kHz requested and actual, 1,800.0505 s measured wall duration
- Operation interval: 30 s; instrumentation capacity 112 worklet nodes; planned dynamic peak 104
- Test-only callback instrumentation used a 89,005,960-byte (84.883 MiB) SharedArrayBuffer

## Workload and functional result
- Production BrowserAudioEngine graph: five tracks, 20 private A–D track FX, 4 input FX, 4 shared track FX, five LIVE_POLY Signalsmith routes, and Rhythm; full configuration is captured in the failure JSON.
- All 59/59 scheduled recording/overdub operations completed: 10 stereo clear/record/restore operations and 49 overdub/undo/redo operations.
- Every overdub undo/redo restored the recorded exact PCM SHA-256 values. Recordings reported zero overflow and dropped frames.
- The test-only output sentinel passed (99.993% non-silent polls; 99.997% changed-window polls). Its analyser pump forces software-graph rendering in headless mode; this does not prove physical output continuity or acoustic quality.
- At terminal: 104 cumulative instrumented nodes (30 persistent graph nodes, 69 retired dynamic nodes, 5 active LIVE_POLY); Signalsmith ledger had 5 active LIVE_POLY leases, 20 MiB reserved, 5.625 MiB measured, no pending or unconfirmed releases.

## Gate result: FAIL
- AudioContext advanced 1,647.3513 s during 1,800.0505 s wall time: 91.5169%.
- Required minimum was 95% (1,710.0480 s); shortfall 62.6967 s.
- AudioContext remained in `running` state; this is a software-side progression guard.
- One callback exception was captured at 2026-10-19T01:30:24.312Z in Rhythm slot 34, callback index 18,226, currentFrame 2,596,224: `RangeError: renderBlock must advance monotonically on the absolute sample-frame timeline`. Stack and full diagnostics are in the failure JSON.
- Across 104 instrumented worklets: 35,998,057 callback invocations, 4,607,751,296 output frames, 333 estimated missing callbacks / 42,624 missing frames, 667 frame discontinuities including 334 frame rewinds, 1 callback error, 0 instrumentation errors. These estimates do not establish hardware XRUNs.
- No callback deadline P99/P99.9 result: all worklet timing sources fell back to non-monotonic 1 ms `Date.now()` resolution, so timing-budget eligibility was false.
- Physical audio devices, hardware XRUN counters, and acoustic quality were not tested.

## Preserved artifacts
- `.failure.json`: complete terminal diagnostic, workload, operations, callback metrics, and exception stack.
- `.progress.json`: final progress/lifecycle snapshot.
- `.status.json`: runner configuration and terminal state.
