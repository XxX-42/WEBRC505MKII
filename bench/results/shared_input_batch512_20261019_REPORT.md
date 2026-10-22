# Shared input / overdub batch checkpoint

Source baseline: `85adf19c970b9bf3613284fff1e72b575d61bdbd` (recovery checkout)

## Changes in this checkpoint

- Browser overdub production path batches outgoing shared-input patches at 512 frames, approximately 11.6 ms at 44.1 kHz. STOP flushes any pending partial range immediately at the requested frame; the 16,384-frame transfer buffer is not used as the routine update interval.
- The processor reuses the oldest partial patch before allocating an empty slot. This preserves sequence/range order with variable render block sizes.
- On bounded transfer-pool overflow, the host tries to restore the complete pre-overdub PCM while preserving earlier history. If restoration is unavailable, it reports the failure, prevents later patches from changing PCM, and leaves Undo as a fallback. Duplicate terminal messages cannot turn failed restoration into a reported success.
- Test-only stress instrumentation records overdub stop commands, patch ranges, error messages, and diagnostic state.

## Verification on this source tree

- `npm run test:unit`: 1,033 tests passed across 139 files.
- `npm run build`: passed (TypeScript, worklet bundle, Vite build, third-party notice check).
- Strict browser/Native-simulation suite: 93/93 passed with `npm run test:e2e:rubberband`, one worker, CfT Chrome 154.0.8037.57, Rubber Band HQ host simulation explicitly enabled.
- Native HTTP simulation CTest: 1/1 passed; this is a fake no-audio host test, not Native hardware/audio acceptance.
- Focused worklet and PCM-history tests: 72/72 passed.

## Full-runtime diagnostic (not an acceptance pass)

Run `shared_input_batch512_reordered_36node_20261019T1245Z`, Google Chrome for Testing 154.0.8037.57, real Chromium AudioContext, 44.1 kHz, 95.044 s wall time, five tracks, all 20 private A-D FX active, 36 initially instrumented worklet nodes (the former 35-node graph plus the persistent shared input tap). Test instrumentation used 84.88 MiB SharedArrayBuffer and can affect scheduling. This is not a 30-minute Gate 7 run and not physical-device/XRUN evidence.

AudioContext advanced 93.826 s during 95.045 s wall time (0.987 ratio). The record operation captured 34,689 stereo frames at the exact requested half-open interval with zero dropped/overflow frames. Overdub requested `[R,S) = [2,873,728, 2,890,880)`, captured and applied all 17,152 requested frames exactly, with ordered contiguous patch ranges, zero drops/overflow, and exact PCM undo/redo hashes. The processor's first active callback began 768 frames (17.415 ms) after R; tap pre-roll/backfill recovered the requested PCM, so capture coverage passes while callback-start latency remains. STOP ACK arrived at frame 2,891,392, 512 frames after requested S; the host clipped to S, and this run had no already-applied post-S journal tail to exercise rollback.

Overall callback-coverage acceptance failed. The overdub's request-to-terminal window expected 17,664 frames and observed 16,768 (94.9275%, below the 95% requirement). The measured 768-frame startup gap accounts for most of this; a separate 128-frame deficit remains to diagnose. A zero-frame Signalsmith active interval was also reported as failed by the current aggregator even though it had no eligible frames. Correcting the zero-frame classification is deferred to a separate checkpoint; no threshold or positive-duration gap rule is relaxed here. A run with no eligible interval must still fail.

The final run’s raw status, progress, and failure artifacts are retained alongside this report as `shared_input_batch512_reordered_36node_20261019T1245Z.{status,progress,failure}.json`. The immediately preceding patch-order diagnostic run is also retained as `shared_input_batch512_patchtrace_20261019T1243Z.{status,progress,failure}.json`; it captured the variable-block ordering failure addressed by this change.
