# Recovered Browser YIN confirmation: new fixture, not recovered raw results

Status: executed successfully on 2026-10-22 at approximately 04:20 UTC in the recovered workspace, exit 0. New raw samples are in browser-main-global-ab.json; console output is in browser-main-global-ab.log. The newly measured direct baseline-to-combined reductions were 50.4744% (ABBA: 149.5239335 ms to 74.052562 ms) and 49.2771% (BAAB: 151.749281 ms to 76.971616 ms). All pre-timing parity and active-path assertions passed. These results cover this Node fixture only.

Run only after this script and both bundle fixtures have been checkpointed and the parent grants an exclusive CPU window:

```
NO_TIMING=1 node bench/experiments/benchmark_recovered_browser_yin.mjs docs/performance/20261022-recovery/browser-main-global-check.json
node bench/experiments/benchmark_recovered_browser_yin.mjs docs/performance/20261022-recovery/browser-main-global-ab.json
```

This fixture executes unmodified standalone production worklet IIFEs in the Node main global using `vm.runInThisContext`, not a separate VM global. It temporarily mocks AudioWorkletProcessor, registerProcessor, sampleRate and currentFrame, then restores prior global descriptors. Five independent active/wet ROBOT kernels run at 48 kHz stereo, 128 frames/block, pitch 7, formant 0, mix 1 and explicit bypassed false. This is not Chrome, a full Browser mixer graph, the external Signalsmith host adapter, or a realtime callback/hardware deadline test.

Baseline fixture is `git show 6bf4a2c:public/worklets/fx-processor.js`. Candidate fixture is copied from the fresh recovered build. Runtime SHA-256 assertions bind both and require current generated production bundle equality. Deterministic precomputed harmonic stereo input banks use five frequencies (147, 196, 220, 330, 440 Hz) and repeat after 32768 frames with a phase discontinuity, so they are not continuous pure tones. Both versions receive the same input objects. Input mutation is checked.

Before timing, 131072 frames per kernel are checked bit-for-bit against baseline, including all emitted ordered messages. Every output must be finite, with positive output and output-minus-dry energy, positive PSOLA mode/message counts, the expected processed-frame count, and bypass false. Unit tests separately cover recursive state, resets, mode transitions and poisoned scratch; this worklet fixture does not claim full internal scratch byte equality.

Timing uses 1024 warmup blocks for each new version runner, followed by six rounds of ABBA and six of BAAB. Each sample processes 512 blocks. Each order retains 12 baseline and 12 candidate raw samples, including slow ones. Median is the average of the middle two values. Gains are per-order direct baseline-to-combined ratios; no addition of isolated gains, cross-fixture pooling or timing-threshold filtering. Instrumented correctness precedes timing, and there are no per-sample PCM checks in the measured loop. The worklet's normal message allocation remains included, with a lightweight mock port counter (no real IPC).

This is a newly authored reproducible confirmation harness after environment loss. Old raw samples and old profile are unavailable; historical results must not be substituted for this run. No new optimization candidates are introduced here.

## Separate candidate-only profile (executed successfully)

```
PROFILE_ONLY=1 node bench/experiments/benchmark_recovered_browser_yin.mjs docs/performance/20261022-recovery/browser-main-global-profile-proof.json
```

This mode repeats the same parity/active validation before profiling, then constructs a new candidate runner and warms it for 1024 blocks. A local Node Inspector session enables V8 CPU sampling at 1000 microseconds only around 16384 candidate blocks. Baseline processing, module loading, input construction, parity assertions and warmup are outside the sampled interval. Only Inspector callback bookends may remain in the profile. No Inspector network port is opened. Raw CPU profile and separate proof JSON are written without overwriting A/B raw data. Self-sample shares identify remaining work, not an A/B gain or a realtime deadline result.


New profile completed on 2026-10-22 around 04:23 UTC, exit 0: 2182 leaf samples. Controller analyzePitch (bundle line 5121) 25.1604%, Live detector analyzeFrame (line 4529) 20.1192%, core processBlock (line 10488) 23.3272%, LiveMono processor.process (line 4746) 20.0733%, synthesizePitchGrain (line 4839) 8.0202%, GC 1.6040%. Harness execute accounted for 0.2291%. See separate proof/raw files; these shares are not new performance-gain measurements.

## Deterministic noise negative/control workload (executed successfully)

WORKLOAD=noise selects independent seeded uniform LCG input per track/channel instead of harmonic input; seed, initial per-channel states, hash and all configuration are saved. Its 32768-frame bank repeats, so this is bounded pseudorandom noise, not an infinitely long white-noise process. Run WORKLOAD=noise node bench/experiments/benchmark_recovered_browser_yin.mjs; default output gains a -noise suffix and does not overwrite harmonic A/B data.

This workload keeps all active/wet checks, nonzero output and output-minus-input energy, exact PCM/messages and expected frame counts. It requires fallback mode events, not PSOLA events. During correctness only, each candidate detector's final-needed CMND entry is poisoned with NaN before every block. A finite overwrite proves a full lag scan reached that endpoint. Positive full-scan counts are required for both controller and Live detector on every track; counts represent observed blocks, not necessarily every analysis. Noise-mode timing uses fresh, uninstrumented runners with the identical ABBA/BAAB protocol. No production source or processing mode is altered. Signalsmith mode is reported honestly: its external host adapter is not part of this worklet-kernel fixture.

Noise confirmation completed 2026-10-22 around 04:27 UTC, exit 0: ABBA 132.818756 to 101.4525805 ms (23.6158%); BAAB 132.3021495 to 101.720217 ms (23.1152%). All active/wet, PCM/messages, frames and full-scan poisoning checks passed. All five tracks reported zero PSOLA events and one Signalsmith mode event, as expected for this unvoiced fixture; the external Signalsmith host adapter remains out of scope. Full-scan counts per track: [{"controller": 506, "liveDetector": 542}, {"controller": 506, "liveDetector": 542}, {"controller": 506, "liveDetector": 542}, {"controller": 506, "liveDetector": 542}, {"controller": 506, "liveDetector": 542}].
