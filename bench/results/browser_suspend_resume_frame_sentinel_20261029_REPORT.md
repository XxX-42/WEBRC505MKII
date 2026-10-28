# Chromium suspend/resume frame sentinel — 2026-10-29

## Finding

Three low-disturbance Chromium trials on source HEAD `7eeca3c3d01f03db510e250c574125838237295e` each showed the same pair of frame events during a 100-cycle suspend/resume run: a repeated 128-frame block (`deltaFrames = -128`) immediately followed by a 128-frame forward gap (`deltaFrames = +128`). The context-global sentinel and the production Browser input-capture worklet reported identical frame ranges in every trial. This distinguishes the observed event from a capture-node-only callback gap: both worklets see the shared AudioContext frame timeline anomaly.

The production worklet's existing `input-frame-discontinuity` protection remains unchanged. The repeated block is conservatively skipped; the following unavailable 128-frame interval invalidates readiness and rejects/aborts any capture that intersects it. Do not shift capture start frames or relax this guard to conceal the discontinuity.

## Runs

All runs used Playwright Chromium `145.0.7632.6`, a requested 44.1 kHz context, a generated 997 Hz oscillator as capture input, and a zero-gain destination. They ran in a separate headless Chromium page served from localhost, with no microphone permission or physical audio device. The production capture worklet is loaded with test-only instrumentation inserted in memory. Both sentinels write into a preallocated `SharedArrayBuffer` ring using atomic stores; their `process()` methods allocate no objects and send no port messages. No production file was edited.

| Run | Context callbacks | Capture callbacks | Matched events | Result |
|---|---:|---:|---|---|
| `browser_suspend_resume_frame_sentinel_20261029.json` | 772 | 772 | `-128`, then `+128` | Shared context timeline discontinuity |
| `browser_suspend_resume_frame_sentinel_20261029_repeat.json` | 648 | 648 | `-128`, then `+128` | Shared context timeline discontinuity |
| `browser_suspend_resume_frame_sentinel_20261029_confirmation.json` | 579 | 579 | `-128`, then `+128` | Shared context timeline discontinuity |

Each capture callback saw non-silent oscillator input. In every run, the repeated callback and the following forward gap had exactly matching frame starts, block lengths, and deltas in both sentinels. At 44.1 kHz, 128 frames correspond to about 2.90 ms. These are observations from this Chromium build and test configuration; they do not establish that other browsers, devices, or timing conditions behave the same way.

## Reproduction tool

From the repository root, run:

```powershell
node bench/run_browser_suspend_resume_frame_sentinel.mjs --cycles 100 --output bench/results/my-sentinel-run.json
```

The JSON records source HEAD, browser version, the instrumented capture source SHA-256, callback frame ranges, lifecycle boundaries, and an automatic classification. `SHARED_CONTEXT_TIMELINE_DISCONTINUITY` means both worklets observed the same jump; `CAPTURE_NODE_ONLY` means only the capture worklet did; `CONTEXT_GLOBAL_ONLY` means only the independent sentinel did.

## Limits

This software-only probe establishes that, in the recorded Chromium runs, the production capture worklet and a separate worklet read the same repeated and skipped AudioContext frame ranges. It does not identify why Chromium repeated or skipped those frame numbers, prove suspend/resume alone caused them, measure physical device XRUNs, establish audible output behavior, or predict results on other browser versions or devices.
