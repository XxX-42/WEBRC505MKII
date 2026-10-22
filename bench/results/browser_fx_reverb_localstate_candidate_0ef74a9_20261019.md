# Browser FDN local-state candidate, 2026-10-19

## Change and exact-output checks

In `BrowserFxDspCore.processReverb`, retain the thresholded damping state in a local variable, store that state once, derive the feedback value from it, and reuse it for output accumulation. The prior code wrote the damping state to `delayReadScratch`, read it back to derive feedback, and re-read the damping state for output. Both arrays are `Float64Array`, so replacing those round trips with the identical JavaScript `Number` does not bypass a Float32 rounding step. Arithmetic and summation order are unchanged. The final feedback value is still stored in `delayReadScratch` for the Householder write pass.

The new near-floor fixture uses 131,071 stereo frames of deterministic low-level excitation and variable block sizes. Its nonzero output peaks at `2.7899671245083207e-24` and has RMS `1.5695853670963377e-25`; it matches the pre-change worklet SHA-256 `6aa0d248bcb25db95374c5325230abce88403c598d3905a11b810ed510b862b0` exactly. Existing FDN golden tests also pass for Reverb and Gate Reverb at 48 and 96 kHz with irregular blocks and live parameter changes.

Validation on the candidate tree:

- `npm run build`: passed, including TypeScript, worklet bundling, Vite build, and bundled third-party notice verification
- `npm run test:unit`: 137 files, 955 tests passed
- Strict full Playwright E2E: 91/91 passed serially with Chrome for Testing headless shell 154.0.8037.57 and the explicit Native simulation host
- Targeted Chromium `OfflineAudioContext` test, 44.1 kHz, one stereo Reverb processor, ten repeated A/B/B/A rounds of 4-second audio: all 40 rendered outputs were finite and bit-identical across baseline and candidate. Baseline and candidate output hash: `b01932d0187dc4dfa877ecb088e6b16453bee322f2771b8e0d6f0168ad9f0af2`.

For that single-processor offline diagnostic, mean realtime ratio was 0.05673 baseline and 0.05336 candidate (about 5.94% lower); median ratio was 0.052725 and 0.04960 (about 5.93% lower). Paired results were variable: 8/10 candidate pairs were faster and 2/10 slower, including one noisy first pair. This is a provisional isolated-kernel signal only. It is not a live callback measurement, full-graph performance result, subjective quality assessment, hardware result, or acceptance-gate pass.

## Full-runtime gate and instrumentation notes

The most recent 30-minute full-runtime Chromium run at source commit `a600f2d` advanced its AudioContext clock by 92.86%, below the unchanged 95% software progression guard. It used a 112-slot callback probe with an 89,005,960-byte (84.883 MiB) SharedArrayBuffer. This allocation may affect memory/scheduling, but its size alone does not show that it caused the gate failure. The run did not produce eligible sub-millisecond callback quantiles because AudioWorklet `performance.now()` was unavailable and the `Date.now()` fallback was coarse.

An initial 90-second record-mode diagnostic on the candidate tree advanced AudioContext time by 89.748 of 90.000 seconds (99.72%) with zero callback errors, but the harness terminated at callback-coverage validation. The only failed descriptor was the initial `signalsmith-stretch#30`: the first scheduled recording/restore operation successfully replaced that LIVE_POLY processor after about 30 seconds, while the harness still required the retired initial node to cover the entire measurement window. The two logged PCM operations completed with exact PCM history hashes. This result is neither a performance pass nor a DSP regression. Its raw status, progress, and failure JSON are retained alongside this report.

The production full-runtime gate remains NOT PASSED for this candidate. Before future 35-node comparisons, callback coverage should be checked per active node interval across processor replacement, while also verifying there is no graph coverage gap at the replacement boundary. The 95% progression threshold remains unchanged.

## Reproduction

```sh
npm run build
npm run test:unit
NATIVE_BRIDGE_SIMULATION_EXECUTABLE=/tmp/rc505-native-e2e-simulation/native_bridge_host_simulation \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell \
npm run test:e2e:rubberband
node bench/benchmark_browser_fx_offline.mjs \
  --baseline-ref 0ef74a94ffbc654fb86bdfef214e97a34336110a \
  --algorithm reverb --sample-rate-hz 44100 --duration-seconds 4 --rounds 10 \
  --browser /tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell \
  --output bench/results/browser_fx_offline_reverb_localcache_candidate_10round_20261019T0306Z.json
```

The full-runtime 90-second failure artifacts use the `instrumentation_abba_0ef74a9_A1_record_20261019T0314Z` prefix.
