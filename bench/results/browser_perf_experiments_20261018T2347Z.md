# Browser performance diagnostics, 2026-10-18

## Scope and status

- Repository HEAD: `b78c55d6bcbe95974cbf21afa86ef18f8761381a` (`codex/rc505-recovery-20261018`)
- The tracked `src/audio/fx/dsp/BrowserFxDspCore.ts` and `public/worklets/fx-processor.js` are restored to this HEAD. No candidate is enabled or accepted.
- All timing data below is diagnostic only. No physical endpoint or hardware XRUN counter is available. The Browser full-runtime acceptance gate remains failed.

## Candidate 1: constructor-selected scalar dispatch

`bench/experiments/browser_fx_dispatch_candidate_20261018T2342Z.patch` reproduces the unaccepted candidate. A focused differential test was run while the candidate was enabled: 13 scalar fallback algorithms, mono/stereo, variable block lengths, parameter changes, bypass, and reset were bit-identical to the original string-switch reference (13/13 tests passed). The test source is preserved at `bench/experiments/browser_fx_scalar_dispatch_equivalence_test.source.txt` and is not an active suite test.

Node VM same-process A/B/B/A tests were mixed. For the longer run at 1024 blocks, estimated kernel-time reductions were PHASER +4.81%, DISTORTION −7.84%, GATE REVERB +1.04%, REVERB −2.66%, CHORUS −5.63% (positive means faster). `npm run build` passed with the candidate. The inconsistent per-algorithm results do not establish a gain.

A full 35-worklet CfT 154.0.8037.57 run at 44.1 kHz produced these AudioContext progression ratios in A/B/B/A order (baseline, candidate, candidate, baseline): 81.11%, 83.32%, 89.12%, 88.09%. All four failed the 95% context-progression guard. The rise by run order makes the apparent small candidate advantage inconclusive. Each run had 35/35 ready nodes, zero callback errors, zero non-finite output samples, zero estimated missing callbacks/frames, and no direct timing deadline metric (`deadlineMisses` was null). These runs are not proof of improvement or XRUN-free hardware operation.

## Candidate 2: cached Phaser Nyquist ceiling

`bench/experiments/browser_phaser_maxfreq_candidate_20261018T2344Z.patch` hoists the unchanged `Math.min(3000, sampleRate * 0.45)` calculation from the per-sample Phaser routine to core construction. Output RMS and focused FX/worklet tests (57/57) passed. A 2048-block same-process Node VM A/B/B/A PHASER kernel run was slower: baseline mean realtime ratio 0.8753, candidate 0.9394, a −7.32% kernel-time reduction (regression). It is rejected.

## Actual Chromium trace

The trace uses the production full-runtime Browser harness with all 35 worklet processors ready, CfT 154.0.8037.57, 44.1 kHz, and a 6-second measurement request. Chrome tracing captured 37,495 `AudioWorkletProcessor::Process` events and 1,072 V8 ProfileChunk events without trace data loss. The V8 sample group contains worklet bundle frames; source-level self-sample counts among 20,513 non-idle samples included `processReverb` 3,118, generic `processBlock` 2,632, `equalPowerFadeOutGain` 2,121, `processDistortionSample` 1,879, `equalPowerFadeInGain` 784, `processPhaser` 751, and `processChorus` 704. Signalsmith wasm indices 48/49 had 1,100/630 samples but were not symbolized. Samples identify function families, not individual AudioWorkletNode instances.

The profiling run is intrusive: AudioContext advanced only 3.120 seconds in 6.051 seconds wall time, so it is a diagnostic failure, not an untraced realtime result. Chrome callback events reported a median 85 µs thread CPU duration and 352 µs p99, but those values are traced and not acceptance measurements. The large trace is retained separately; only the compact summary is committed.

- Raw trace: `bench/results/browser_worklet_trace_35node_20261018T2347Z.json` (91,751,774 bytes, SHA256 `67803ad5411bb3bbf60b97dcdaf427852bd9802ad8a1b3605aa61c49930f6fb7`)
- Gzip raw trace: `bench/results/browser_worklet_trace_35node_20261018T2347Z.json.gz` (4,138,817 bytes, SHA256 `16a23e5e7a784f700ff9e1ab068b08d4cde8fd2a9063975e0ae9b93121e24224`)
- Compact summary: `bench/results/browser_worklet_trace_35node_summary_20261018T2347Z.json`
- Reproduction/analysis entry points: `bench/profile_browser_audio_worklet_graph.mjs`, `bench/summarize_browser_worklet_trace.mjs`

## Next evidence-driven target

The trace puts equal-power fade gain functions among the top sampled FX-bundle frames in the full graph. Before changing DSP, investigate an instance-local cache keyed by the exact per-sample mix/bypass position. It must preserve the existing gain arithmetic on all position changes, be bit-exact for dynamic automation and reset/mode changes, allocate nothing in `process()`, and show a same-browser controlled profile improvement. Existing REVERB/DISTORTION fastpaths are not reimplemented by this experiment.
