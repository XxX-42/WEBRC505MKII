# Browser FX control steady-state fast path

Date: 2026-10-18 UTC
Source base: `10a4edac186ace9d6a64e5413c573275f2e00798`
Candidate worklet SHA-256: `ba4a23b498345f39813881760b5f0ce1fa5d7626c9d3d81f0dc0ed28926e9199`

## Implementation

`BrowserFxDspCore.advanceControls()` still visited 36 exponential smoothers on every sample even after every target had converged exactly. It now caches a steady state only after a 16-sample scan confirms all 36 smoothers and both waveform crossfades have reached their terminal values, and after a time-variant coefficient refresh has occurred. When steady, the path skips those per-sample smoother calls and derived-value calculations while continuing the existing coefficient-refresh countdown. New parameter messages and reset invalidate the cache. Retaining the countdown preserves coefficient-update phase when parameter automation resumes.

No audio history, filter/reverb coefficient, parameter ramp, or sample-processing state is skipped. The unit differential runs the old smoother path as an oracle and requires bit-identical outputs across irregular blocks, active and retargeted ramps, reset, a control change after a steady interval, reverb coefficient refreshes, and the tremolo waveform crossfade.

## Verification

- `npm run build`: passed (TypeScript, AudioWorklet bundle, Vite production build, third-party notice verification).
- `npm run test:unit -- --reporter=dot`: 916/916, 131 files.
- Strict `npm run test:e2e:rubberband` with the pinned CfT 154 browser and explicit no-audio Native simulation host: 84/84 serial.
- Six 48 kHz CfT 154 offline single-effect ABBA tests, 6 seconds per render and 3 rounds. Every algorithm had identical baseline/candidate output hashes, finite samples, and identical RMS. Mean render/realtime ratios:
  - REVERB: 0.077542 → 0.064344 (17.0% lower)
  - GATE REVERB: 0.067892 → 0.055631 (18.1% lower)
  - DIST: 0.080494 → 0.066189 (17.8% lower)
  - CHORUS: 0.036200 → 0.027819 (23.2% lower)
  - DELAY: 0.023994 → 0.014453 (39.8% lower)
  - PHASER: 0.060989 → 0.055197 (9.5% lower)

These OfflineAudioContext numbers are single-effect kernel diagnostics, not callback timing, whole-graph performance, deadline, XRUN, or hardware acceptance. Raw runs are in `browser_fx_control_steady_*_ABBA_*.json`.

## Full 35-node runtime preflight

The application graph was run at 44.1 kHz with all five tracks, 20 private A–D FX, four input FX, four shared FX, five LIVE_POLY nodes, and the RhythmEngine. The 10-second context-progression preflight failed the existing 95% minimum: 9.36635 / 10.05009 seconds = 93.20%. All 35 nodes were ready, processor errors were zero, and the overlapping AnalyserNode sentinel passed with 99.10% non-silent windows. The sentinel is not evidence of endpoint continuity or physical output. Timing P99/P999 and hard callback-deadline checks remained ineligible because AudioWorklet `performance.now()` is unavailable and the `Date.now()` fallback has 1 ms resolution. No device XRUN data was collected.

A same-rate 44.1 kHz preflight A/B/B/A sequence (old worklet from base commit, then candidate) also failed in every run. AudioContext advance ratios were A1 69.51%, B1 80.19%, B2 88.46%, A2 72.52%. The mean of the two baseline runs was 71.02%; the mean of the two candidate runs was 84.32%, but these four values are descriptive only: progression changed materially over run order and does not establish a causal gain. All detailed `.failure.json`, `.progress.json`, and `.status.json` evidence is preserved under the `full_runtime_35node_controlsteady_*_20261018T1921Z` names. The guard is still failing; this is not the 30-minute acceptance run.
