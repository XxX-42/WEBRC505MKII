# DIST fast-path checkpoint

Date: 2026-10-18 (UTC)
Source base: `ec2d0379a0f446e461633d45a7d33748d32040ac`

## Change

The Browser DIST 4x FIR loop now stores duplicated circular-history samples in a contiguous window, removes per-tap wrap/zero checks, and limits interpolation to the nonzero taps for each polyphase branch. DSP equations and accumulation order are retained. The shipped AudioWorklet bundle is rebuilt from `BrowserFxDspCore.ts`.

## Exact-output regression

`tests/unit/browser-distortion-fir-fast-path.spec.ts` uses deterministic stereo multitone/noise/transient input, irregular block sizes, and two midstream drive/mode changes. It checks finite output, the pre-change SHA-256, RMS, and 16-sample algorithmic latency at three sample rates:

- 8 kHz: `14d03b93168813e5d5ff102b6f228c05951ea559683ee64a7d05cdbf9464f5ca`
- 44.1 kHz: `a19593734213afbf63c72a33abbb2206593e4ee21a2d0e3b8d19ba0104905f4d`
- 96 kHz: `a2203f8dc58f945ce3dad3f31f894cdac52d8924c22231e0ce80c1eca6d6d9d5`

Focused test result on the checkpoint tree: 3/3 passed. The full unit suite previously passed 910/910, build and generated-worklet checks passed, and strict Rubber Band-enabled E2E passed 84/84 with one worker. The E2E used the explicit test-only no-audio Native simulation host; it is not a hardware test. The Browser was official Chrome for Testing 154.0.8037.57 with sandbox requested.

## Relative single-effect timing

Raw data: `browser_fx_distortion_ABBA_20261018T1850Z.json`. Official CfT 154.0.8037.57, 44.1 kHz OfflineAudioContext, one DIST processor, six seconds per run, three ABBA rounds. Baseline worklet SHA-256 is `b3d8913872fab74b2c28b116b8fe2418093578648952a0e48fae1c1c8c736c40`; candidate SHA-256 is `7873d4c07355d57acf2915922d35a9ffcd49b61b39fa70e10efc41f92dce945b`.

Every baseline and candidate rendering had identical output SHA-256 `c2d0d76a405948cc83bdd5d9948adb20195a105fa0231bc62a8778da3a8a7df7`, identical RMS `0.2938247615886678`, and finite samples. Mean single-node render/realtime ratio was 0.075164 baseline and 0.068297 candidate (about 9.1% lower); medians were 0.076317 and 0.067383. Timing surrounds `OfflineAudioContext.startRendering()` and is not live callback timing, an XRUN/deadline result, an aggregate FX-chain measure, or device/hardware acceptance.

## Full-graph diagnostic failure

Raw evidence: `full_runtime_35node_after_distortion_20261018T1851Z.failure.json` and its `.status.json`. A 10-second, 44.1 kHz, 35-node full-runtime preflight in CfT 154.0.8037.57 remained in `running` state but advanced AudioContext time only 6.783 seconds in 10.000 seconds, below the required 9.500 seconds; the run failed. The output sentinel observed non-silent finite signal, but this does not repair the insufficient clock advancement. This is a preflight failure, not a callback-timing or physical-output measurement. It does not establish that DIST caused the failure, and it does not pass the full-load performance gate.

No native hardware or physical audio path was exercised. Distortion objective sound-quality admission remains separate from exact-output regression and this timing diagnostic.
