# Browser full-runtime Rhythm recovery check

## Run identity

- Source commit: `a600f2d31976727f2369d9dd929e6d056bbfa81e`
- Run ID: `full_runtime_rhythm_recovery_a600f2d_20261019T023025Z`
- Browser: Google Chrome for Testing 154.0.8037.57 headless shell, Chromium sandbox requested, no extra launch arguments
- Profile: production BrowserAudioEngine full-runtime graph, 44.1 kHz, 1,800.051 s wall time
- Start: `2026-10-19T02:30:31.368Z`; terminal: `2026-10-19T03:00:43.323Z`
- Workload: five tracks, 20 private A–D FX, four Input FX, four shared Track FX, five LIVE_POLY routes, Rhythm, 59 record/overdub-history operations every 30 s
- Test instrumentation: 112-slot callback probe with an 89,005,960-byte (84.883 MiB) SharedArrayBuffer; the extra RPC observer was disabled. Instrumentation can affect scheduling and is not application audio memory.

## Rhythm recovery result

- No Rhythm callback exception or processor error occurred; the previous `renderBlock must advance monotonically` exception did not recur.
- Rhythm slot 34 recorded 5 `currentFrame` rewind events. The production core rejects each overlapping block before the strict DrumVoicePool call and takes the muted-block path; strict DrumVoicePool monotonicity validation remains unchanged.
- The run does not record the exact frame immediately before/after each rewind or export worklet `timeline-rewind` / `timeline-recovered` message counts. The number of recovery episodes and the exact number of muted frames therefore remain unverified by this run. `missingFrames=640` is a separate positive-gap estimate and must not be attributed to the 5 rewinds.
- Unit tests cover stale, repeated, partial-overlap, cross-bar, tempo-reconfigured, and recovered blocks against an uninterrupted PCM reference; they verify status message emission and preserve strict pool behavior. A separate Chromium E2E confirms the production Rhythm worklet renders audible output on a running AudioContext.
- A stale block is muted without rewinding scheduler or voice state. Subsequent valid absolute frames resume; any silence/discontinuity is not replayed, so strict rhythm-audio continuity is not claimed.

## Full-runtime result

- Functional workload: 59/59 operations completed; all record/overdub undo/redo PCM hashes matched; no operation failed.
- Output sentinel: 36,002/36,002 polls non-silent; 0 non-finite output samples.
- Cumulative worklet lifecycle: 104 created (30 persistent graph, 69 retired dynamic, 5 active LIVE_POLY); no pending/unconfirmed Signalsmith lease releases.
- Callback instrumentation: 36,997,773 callbacks; 320 estimated missing callbacks and 40,960 estimated missing frames across the graph; 0 callback exceptions and 0 instrumentation errors. Rhythm specifically: 575,873 callbacks, 5 frame rewinds, 5 missing-callback estimate, 640 positive-gap missing-frame estimate, 10 frame discontinuities, 0 callback errors.
- AudioContext advanced 1,671.468 s of 1,800.051 s: 92.86%, below the unchanged 95% software progression gate (minimum 1,710.048 s). Overall Gate result: FAIL.
- Callback P99/P99.9 and deadline metrics: NOT MEASURED. AudioWorklet `performance.now()` was unavailable; `Date.now()` had 1 ms resolution and is not eligible for the sub-millisecond callback budget.
- This software test does not measure physical audio devices, hardware XRUN counters, or acoustic continuity.

## Artifacts

- `full_runtime_rhythm_recovery_a600f2d_20261019T023025Z.status.json`
- `full_runtime_rhythm_recovery_a600f2d_20261019T023025Z.progress.json`
- `full_runtime_rhythm_recovery_a600f2d_20261019T023025Z.failure.json`
