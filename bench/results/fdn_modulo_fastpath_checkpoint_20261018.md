# FDN modulo fast-path checkpoint

Date: 2026-10-18 (UTC)
Source base: `bf605c72b2185b29e40a56014a6f87b8836b61fd`

## Change and exact-output checks

The common four-point Lagrange delay read now folds its already-bounded negative read index with one add instead of `%`; the early-reflection ring uses the same one-correction rule. Every call site bounds the integer delay below the allocated ring length, making the single correction equivalent to positive modulo. No filter coefficients, DSP state updates, delay values or accumulation order changed. The Browser AudioWorklet bundle was rebuilt from the TypeScript source.

`tests/unit/browser-fdn-modulo-fast-path.spec.ts` covers 48 and 96 kHz, both REVERB and GATE REVERB, 100,003 stereo frames (covering repeated FDN and early-ring wraps), variable blocks `[128, 257, 7, 4096, 1, 64]`, and two parameter changes at exact frame boundaries. Expected output hashes were captured before this change on the distortion-optimized baseline:

- 48 kHz REVERB: `c6e594d6b645d030fee4bb79ec3cb417da711fd455c688f0bc9d5da4923d1cc1`
- 48 kHz GATE REVERB: `f67ecec263e7d3de2c4b1887d1cb21a956557c787c0110fbc8e618d3c6139964`
- 96 kHz REVERB: `eb2a8aa2c6b7ee42f3ac550beacc40d1be1a6ee58889ed6667ee3cf6d123d237`
- 96 kHz GATE REVERB: `6fd2feb2511a36ee1608a213822738940248ee7e5f3355a832a45c36f0781d1e`

Focused test: 4/4 passed. Build passed. Full unit suite on this source passed 914/914 in 131 files. Strict Rubber Band-enabled E2E passed 84/84 serially using Chrome for Testing 154.0.8037.57 and the explicitly configured test-only no-audio Native simulation host. The suite validates software behavior, not Native hardware.

## Relative Browser timing

Raw files: `browser_fx_fdnsafe_reverb_ABBA_20261018T1903Z.json` and `browser_fx_fdnsafe_gate_reverb_ABBA_20261018T1903Z.json`. Each is Chrome for Testing 154.0.8037.57, OfflineAudioContext, 48 kHz, one effect processor, six seconds per render, three ABBA rounds. The baseline bundle is `bf605c7` worklet SHA-256 `7873d4c07355d57acf2915922d35a9ffcd49b61b39fa70e10efc41f92dce945b`; candidate bundle SHA-256 is `73450a14bc1dcc781a787d9408173b7cc1a889530d39b6af1f162232ced2962a`.

- REVERB mean render/realtime ratio: `0.080861` baseline → `0.078594` candidate (~2.8% lower).
- GATE REVERB mean render/realtime ratio: `0.076261` → `0.071469` (~6.3% lower).
- For each algorithm, all six baseline/candidate runs had one identical stereo output SHA-256 and identical RMS, with all samples finite.

These are offline single-effect render ratios, not live callback timing, deadline or XRUN results, and not hardware acceptance. Their ratios must not be summed to estimate a multi-slot graph.

## Full graph preflight

`full_runtime_35node_after_fdnmod_20261018T1908Z.failure.json` and associated `.status.json`/`.progress.json` preserve the diagnostic. The 35-node full-runtime 44.1 kHz preflight requested 10 seconds; headless Chrome remained `running` but AudioContext advanced only `7.605` seconds in `10.050` wall seconds (`75.7%`, below the `95%` minimum). The run failed. A polled output-signal sentinel passed, but callback timing was not measured in this preflight and the sentinel is not device-output evidence. This one result does not pass the full-load performance gate and does not attribute the remaining deficit to any single algorithm.
