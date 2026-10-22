# Dynamic worklet coverage: zero-frame classification

Source parent: `9d645fee76dec3f0bb22861d2f30732e59e76041`.

## Harness change

Dynamic callback intervals with no expected audio frames are now explicitly `NOT_EVALUATED`; their observed frames remain visible for diagnostics but are excluded from the coverage numerator and denominator. Slot aggregation evaluates only positive-frame intervals. It remains a failure when no positive interval exists, and every positive interval must still independently pass the 95% floor and all existing callback-error, termination, ACK, snapshot, and missing-frame checks. Persistent graph nodes retain the existing full-window calculation.

Unit cases verify a zero-span interval beside a passing interval does not poison it, an empty or zero-only set does not pass, and real positive-duration gaps still fail. The 95% threshold is unchanged.

## Verification

- `npm run test:unit`: 139 files, 1,034 passed.
- `npm run build`: passed; Vite emitted its existing large-main-chunk and stale-browser-data warnings.
- `node --check bench/browser_audio_worklet_stress_page.js`: passed.
- Focused `tests/unit/browser-worklet-active-intervals.spec.ts`: 14/14 passed.
- The strict application E2E suite was not rerun in this harness-only batch.

## Current real-Chromium multi-operation diagnostic

Run `shared_input_batch512_zero_eval_36node_20261019T1310Z` used Google Chrome for Testing 154.0.8037.57, a real Chromium AudioContext at 44.1 kHz, 95.008 seconds wall time, five active tracks, all 20 private A–D FX, five LIVE_POLY processors, four Input and four shared FX processors, and 36 initial instrumented nodes including the persistent input tap. This matches the prior 12:45 run’s sample rate, profile, operation cadence and declared graph topology. Test instrumentation used approximately 84.9 MiB of shared memory. No build or other benchmark was run concurrently by this worker; the run did not sample host-wide process load, so external contention cannot be excluded or inferred as the cause of this result.

The run failed acceptance: AudioContext advanced 74.188 seconds of 95.008 wall seconds (78.086%), below the unchanged 95% progression guard. The record operation captured 25,344 stereo frames exactly over its requested half-open interval with zero dropped/overflow frames. Overdub captured and applied all 12,800 requested `[R,S)` frames exactly, with contiguous ordered patch ranges, zero drops/overflow and exact undo/redo hashes. First active overdub processing was 896 frames (20.317 ms) after R; tap backfill recovered those PCM frames. The ACK arrived 512 frames after requested S; the run applied no post-S frames, so the post-stop journal rollback path was not exercised. Callback coverage was 12,288/13,312 frames (92.308%), below 95%; 896 frames are the measured start delay and an additional 128-frame gap remains to explain. This is a real callback-coverage failure, not evidence that zero-frame aggregation passed in this run (no zero-frame interval occurred).

The raw current-run `failure.json`, `progress.json`, and `status.json` are retained next to this report. This was a 95-second diagnostic, not the 30-minute full-run acceptance and not physical hardware/XRUN evidence.
