# Browser equal-power gain-cache candidate

## Candidate and correctness

`BrowserFxDspCore` now caches the two equal-power coefficients for the current wet/mix position and the current bypass position. A coefficient pair is recomputed by the unchanged `equalPowerFadeOutGain` / `equalPowerFadeInGain` helpers whenever its exact position changes. Initial `NaN` keys force the first computation; no cache allocation occurs in `processBlock`. The positions are pure control values and do not depend on sample rate or DSP state. Reset does not need special invalidation: equal positions always yield the same helper outputs.

The new unit test processes 2,048 stereo frames per algorithm, one frame at a time, and compares the cache against an oracle that invalidates both cache keys on every frame. It includes wet-mix automation, bypass on/off ramps, a one-frame bypass transition, and reset. Nine representative algorithms passed with bit-identical left/right PCM. Actual CfT 154 OfflineAudioContext renders also compared baseline commit `f1c69af` against this candidate for REVERB, PHASER, CHORUS and DISTORTION (six measured renders per effect), all bit-identical. A separate automated REVERB sequence changes mix at 0.25/0.55/0.85/1.15 seconds and applies 701/911-frame bypass ramps; all six measured renders were bit-identical.

## Build and regression suites

- `npm run build`: passed; rebuilt the production AudioWorklet from `src/audio/fx/dsp/BrowserFxDspCore.ts` and verified bundled license notices
- `npm run test:unit`: 944/944 tests in 137 files passed
- `NATIVE_BRIDGE_SIMULATION_EXECUTABLE=/tmp/rc505-native-e2e-simulation/native_bridge_host_simulation PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell npm run test:e2e:rubberband`: 90/90 serial Chromium E2E tests passed with the explicit no-audio Native simulation enabled

## Same-browser full application graph

The test runner uses CfT 154.0.8037.57 and the production BrowserAudioEngine / TrackAudio graph: five tracks, all 20 private A–D effects, five LIVE_POLY nodes and rhythm, at 44.1 kHz. Measurements are software AudioContext progression and output sentinels, not callback CPU deadlines or physical audio/XRUN tests. Callback P99/P99.9 are unavailable in this headless AudioWorklet global because `performance.now()` is absent and `Date.now()` has 1 ms resolution.

| Run | Wall | AudioContext advance | 95% progression check | Callbacks | Errors / estimated gaps | Output sentinel |
|---|---:|---:|---|---:|---|---|
| 10s A1 baseline | 10.050s | 7.700s | FAIL | — | 0 / 0 | — |
| 10s B1 cache | 10.050s | 9.755s | PASS | 117,669 | 0 / 0 | pass |
| 10s B2 cache | 10.050s | 9.898s | PASS | 119,335 | 0 / 0 | pass |
| 10s A2 baseline | 10.051s | 8.667s | FAIL | — | 0 / 0 | — |
| 10s A1 baseline, repeat | 10.001s | 9.186s | FAIL | — | 0 / 0 | — |
| 10s B1 cache, repeat | 10.050s | 9.529s | FAIL (by 0.019s) | — | 0 / 0 | — |
| 10s B2 cache, repeat | 10.001s | 9.015s | FAIL | — | 0 / 0 | — |
| 10s A2 baseline, repeat | 10.051s | 7.967s | FAIL | — | 0 / 0 | — |
| 30s A1 baseline | 30.050s | 25.240s | FAIL | — | 0 / 0 | — |
| 30s B1 cache | 30.050s | 29.185s | PASS | 351,921 | 0 / 0 | pass |
| 30s B2 cache | 30.050s | 28.587s | PASS | 344,708 | 0 / 0 | pass |
| 30s A2 baseline | 30.050s | 24.509s | FAIL | — | 0 / 0 | — |

This is encouraging evidence that the production-sized graph advances more frames with the cache, but 10-second results are variable and callback timing remains ineligible. The 30-second A/B/B/A sequence passed the software progression guard for both candidate runs and failed both baseline runs. This is not a 30-minute stress pass, precise callback-deadline acceptance, hardware endpoint evidence, or an overall realtime Gate pass. A single full-duration candidate soak remains pending.

## Offline kernel timing context

Single-effect OfflineAudioContext timing is diagnostic only. Across six renders, mean baseline/candidate realtime ratios were: REVERB 0.06648/0.05657, PHASER 0.05402/0.05143, CHORUS 0.03068/0.02758, DISTORTION 0.06523/0.05973. These are not live callback or full-graph performance claims. The automated REVERB mean was 0.04833/0.04762, a small difference within expected browser timing variability.

## Remaining limits

- A single 30-minute full 35-node Browser soak is still required; callback CPU P99/P99.9 and hardware/XRUN instrumentation remain unavailable
- No sound-quality change is intended; the cache preserves the exact helper results and mixing order, and all tested output hashes matched
- The already committed CfT trace remains a diagnostic locator for gain helper work; tracing overhead makes it unsuitable for acceptance timing
