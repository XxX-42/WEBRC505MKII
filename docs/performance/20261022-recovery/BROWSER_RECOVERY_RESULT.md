# Browser YIN exact optimization: independently recovered validation

Date: 2026-10-22 UTC. This report describes fresh evidence generated after the original uncommitted artifacts became unavailable, not recovered old benchmark samples.

## Changes and correctness

The two production TypeScript changes add preallocated contiguous Float32 analysis scratch and stop CMND computation after the selected first trough has its required right interpolation neighbor. Float64 accumulation order and existing Float32 stores remain unchanged. Later calls overwrite every needed scratch prefix; unused scratch tails may differ. No quality mode, sample rate, analysis hop, grain algorithm or algorithmic delay was reduced.

Independent baseline fixtures came from commit 6bf4a2c. The old ROBOT fixture imports its own old LiveMono implementation. Formal regression covers rates, long tones, resets, formant fallback/re-entry, detector thresholds, NaN poisoning, exact PCM and recursive state, explicitly excluding dead scratch tails. Fresh validation: targeted 5 files / 43 tests passed; fresh npm build passed; post-build full unit suite 152 files / 1129 tests passed. These counts overlap and must not be added together.

At 48 kHz, added Float32 scratch payload is 2740 bytes per ROBOT instance (1624 controller + 1116 embedded detector), or 13700 bytes for five instances, excluding object headers. Allocation occurs at construction, not per sample.

## Fresh actual-bundle measurements

Standalone unmodified production worklet IIFEs execute in Node's main global, with mocked worklet registration/ports. Five active/wet independent ROBOT kernels, 48 kHz stereo, 128-frame blocks, pitch 7, formant 0, mix 1, bypass false. Each deterministic input bank repeats every 32768 frames. Harmonic input has phase discontinuities at bank boundaries; noise is seeded pseudorandom input, not microphone data.

Each workload first passed 131072 frames per kernel of exact PCM bytes and ordered messages, positive output and output-minus-input energy, exact processed-frame counts and active-path assertions. Noise additionally asserts wet current/target = 1 and proves both detectors reached their final needed lag by poisoning that entry before each correctness block; fresh timing runners are not instrumented.

Each order has six rounds, with 12 baseline and 12 combined samples, 512 blocks/sample and 1024 warmup blocks/version. Every slow sample is retained. Medians use the middle-pair average.

| Workload / order | Baseline median ms | Combined median ms | Direct reduction |
|---|---:|---:|---:|
| Harmonic ABBA | 149.5239335 | 74.052562 | 50.4744% |
| Harmonic BAAB | 151.749281 | 76.971616 | 49.2771% |
| Noise ABBA | 132.818756 | 101.4525805 | 23.6158% |
| Noise BAAB | 132.3021495 | 101.720217 | 23.1152% |

These are reductions in processing work under this fixture, not reductions in audio latency. Noise stayed in fallback mode (zero PSOLA events on all tracks); the actual external Signalsmith adapter is not measured. No isolated improvement percentages were added together.

## Fresh remaining-hotspot profile

Candidate-only V8 CPU sampling at 1 ms enclosed 16384 warmed candidate blocks. Baseline execution, source loading, input generation, correctness and warmup were outside the sampled interval. Of 2182 leaf samples: controller YIN 25.1604%, embedded Live YIN 20.1192%, core processBlock 23.3272%, LiveMono process 20.0733%, grain synthesis 8.0202%, GC 1.6040%; the harness execute loop was 0.2291%. The two YIN analyses still account for about 45.28%. Sample shares are not performance-improvement measurements and do not prove all useful optimization is exhausted.

## Evidence and limits

- Implementation and raw-data protocol: BROWSER_AB_DESIGN.md; bench/experiments/benchmark_recovered_browser_yin.mjs.
- Fresh validation: browser-validation.json, browser-targeted.log, browser-build.log, browser-post-build-unit.log.
- Harmonic raw: browser-main-global-ab.json and .log.
- Noise raw: browser-main-global-ab-noise.json and browser-main-global-noise.log.
- Profile: browser-main-global-profile-proof.json, matching .cpuprofile and browser-main-global-profile.log.
- Baseline worklet SHA256: ef9eee02f79425b2c2b3dbb68c64e70638896c449a8294c3e69493a089d350ab.
- Rebuilt optimized worklet SHA256: d438eb0dbcefd1eb6ba2f5052f598d66cc277139f9b5d45bab8831ae96e1c8d5.

This is not a real Chrome AudioWorklet run, full Browser mixing graph, user-device deployment, hardware audio-quality test, XRUN test, or proof of callback-deadline budgets. Cloud HTTP startup is recorded separately and is not user-local deployment. Existing build warnings remain disclosed in the validation logs. Production UI was not modified. Future optimization needs separate controlled evidence; this batch does not claim every P0/P1 or every latency/quality limit is solved.
