# AudioWorklet frame coordinate and PCM continuity probe — 2026-10-29

## Result

The PCM instrumented probe captured one shared frame coordinate discontinuity in run B and two valid runs with no discontinuity (runs C and D), each with 100 suspend/resume cycles. All ran against source HEAD `d1f8fccd2ba3113a27b591a96b4dadcd4791212c` in Playwright Chromium `145.0.7632.6` at 44.1 kHz.

Run B observed these consecutive callback ranges in both the independent context sentinel and the production capture worklet:

| Callback | Frame start | Frames | Delta from prior end |
|---|---:|---:|---:|
| Before | 17152 | 128 | — |
| Repeated coordinate | 17152 | 128 | -128 |
| Next | 17408 | 128 | +128 |

The full 128-sample mono PCM blocks are stored in `browser_suspend_resume_pcm_sentinel_20261029_runB.json`. The block marked 17152 a second time is not a copy of the first: maximum absolute difference is `0.6550`; RMS difference is `0.4656`. Fitting the known 997 Hz oscillator phase gives a `-0.67945 rad` advance between those blocks, versus the expected one-quantum advance of `-0.66736 rad` modulo 2π (error `-0.01209 rad`). The next block advances another quantum: the fitted error is `+0.03554 rad`; comparing the block before the repeated coordinate directly to the next block gives a two-quantum error of `+0.02345 rad`. These errors are within the ordinary contiguous-pair range from this run (median absolute `0.02983 rad`, maximum `0.04343 rad` across 587 pairs).

This is strong evidence that, for this generated signal in this Chromium run, the frame coordinate repeated while the input samples advanced normally. The subsequent frame coordinate jump therefore does not demonstrate that a source PCM interval was unavailable. The current capture guard would skip the differently valued overlap block, then invalidate readiness/abort on the forward coordinate gap. This observation supports a coordinate anomaly that can cause a false positive for missing *source PCM* in this synthetic setup; it does not justify changing the product guard without corroborating device evidence.

| Run | Cycles | Global / capture callbacks | Discontinuities | Complete PCM records | Result |
|---|---:|---:|---:|---:|---|
| `browser_suspend_resume_pcm_sentinel_20261029_runB.json` | 100 | 590 / 590 | matched `-128`, then `+128` | 590 / 590 | shared coordinate anomaly; new PCM under repeated coordinate |
| `browser_suspend_resume_pcm_sentinel_20261029_runC.json` | 100 | 590 / 590 | none | 590 / 590 | no anomaly reproduced |
| `browser_suspend_resume_pcm_sentinel_20261029_runD.json` | 100 | 603 / 603 | none | 603 / 603 | no anomaly reproduced |

## Method and limits

The benchmark injects test-only instrumentation into an in-memory copy of `public/worklets/browser-input-capture.js`; it does not edit the production worklet. A preallocated `SharedArrayBuffer` stores callback metadata and all raw mono input samples (up to 256 per callback). The AudioWorklet callback only atomically increments a counter, writes fixed metadata, and copies samples in a bounded loop; it allocates no arrays or objects and sends no messages. The independent sentinel stores frame coordinates in its own preallocated ring. The generated oscillator feeds the production capture worklet. A zero-gain destination is used; no microphone, physical output device, or hardware clock is involved.

The phase fit uses the known 997 Hz oscillator to test whether adjacent 128-sample blocks carry the expected one-quantum waveform advance. It is evidence about this synthetic source in this browser build, not proof of microphone sample identity, hardware clock continuity, audible behavior, or the cause of Chromium's coordinate anomaly. The PCM copy adds bounded work to the render callback and may affect event frequency. Two of three runs did not reproduce an anomaly. Product frame-gap protection was not changed.

Reproduce with:

```powershell
node bench/run_browser_suspend_resume_frame_sentinel.mjs --cycles 100 --output bench/results/my-pcm-sentinel-run.json
```
