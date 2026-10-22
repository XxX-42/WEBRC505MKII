# Full-runtime harness capacity and callback diagnostic

Run ID: `full_runtime_cap112_rhythm_diag_e22e423_20261019T0118Z`

- Base commit: `e22e4233248c9f9f8c28b710fb0cd9db7987b93e`
- Browser-run harness source diff SHA-256: `e5f36de36c3c2632135adf4290d6285a5639040bd9cc4c0185aaacbd6d61935f`
- Browser: Google Chrome for Testing headless shell `154.0.8037.57`, sandbox requested, no extra launch flags
- Graph: production `BrowserAudioEngine`, 5 tracks, 20 private A–D FX, 4 input FX, 4 shared FX, 5 LIVE_POLY routes, Rhythm, real recording/overdub/undo/redo operations
- Requested/actual sample rate: 44.1 kHz
- Requested duration: 360.051 seconds; started `2026-10-19T01:18:47.580Z`
- Operation cadence: 30 seconds; 11 operations planned and all 11 completed
- Instrumentation capacity: 112 cumulative nodes; exact plan peak 48 for this short run and 104 for the 1,800-second/30-second-cadence run
- Test-only instrumentation `SharedArrayBuffer`: 89,005,960 bytes (84.883 MiB), included as browser memory and scheduling overhead; excluded from app memory budgets

## Outcome

The harness-capacity failure was removed: the run created all 48 planned nodes without a construction rejection. Two stereo record replacements completed without overflow or dropped frames; nine overdub/undo/redo operations restored their exact PCM hashes. Final node accounting showed 48 cumulative creations, with 5 active Signalsmith LIVE_POLY nodes and 2 retired Signalsmith nodes. The runtime WASM lease ledger showed 5 processors / 5 LIVE_POLY, no pending leases, and no unconfirmed releases.

The Browser software progression gate **failed**: AudioContext advanced 339.963356 seconds over 360.050610 seconds wall time (94.421%), below the 95% minimum of 342.048079 seconds. Callback errors, instrumentation errors, estimated missing callbacks, non-finite output samples, and construction failures were all zero. The previously observed Rhythm callback exception did not recur in this 360-second diagnostic; that is not evidence that its cause was repaired.

This is a short software-side diagnostic, not a 30-minute acceptance run, a hardware/XRUN measurement, or a sound-quality result. Per-worklet timing was ineligible because the AudioWorklet clock resolved to the coarse `Date.now()` fallback.

## Callback detail capture check

`node bench/tests/instrument-register-processor-exception-check.mjs` passed. It injects a synthetic throwing Rhythm processor into the test-only instrumentation wrapper, verifies that the original exception still propagates, and checks that one bounded message contains the processor name, slot, exception type, message, stack, and callback-error count. This validates the test harness reporting path only; it does not reproduce or explain the prior production Rhythm exception.

## Capacity and evidence files

The runner preflight rejects a 1,800-second run with a 2-second cadence because its planned 1,070 cumulative slots exceed the bounded 112-slot capacity. The requested 30-second cadence fits the 104-slot planned peak.

- Failure JSON SHA-256: `82239238ce04c1f891bef545b9245aa0295ed081116790899d8a51aa42a29745`
- Progress JSON SHA-256: `425f187d49a981b99dee876983526d3e277ecefd613498a51a4120f62b4cd3f8`
- Status JSON SHA-256: `0beabe758e382e3960970503ab647cdd47824fb80ab2b159722ea9deb36af5da`
