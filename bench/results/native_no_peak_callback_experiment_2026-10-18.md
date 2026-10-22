# Native callback peak-scan experiment (2026-10-18)

## Change under test

`NativeEffectProcessor::processInPlace()` retains its existing peak-returning behavior. The callback-only `NativeEffectBank::processInPlaceNoPeak()` path invokes the same DSP/state updates while omitting each processor's final absolute-peak scan and the bank's final peak scan. Native callback call sites discard the former peak result, so the new route does not remove a consumed meter value.

Code inspection predicts fewer output scans (up to one per active processor plus one per bank). No CPU profiler attribution was collected, so this is a source-level opportunity, not a measured hotspot attribution.

The per-track catalog test compares metered and no-peak banks bit-for-bit over eight sequential 64-frame stereo blocks for all 51 per-track insert IDs in A–D, checks finite output and exact public peak values, and checks no allocations in the no-peak processing calls. It passed in the full native suite.

## Measurement setup

- Source HEAD: `f7bee1d0360fe46f3a586094bec42076df433cf9`, tree `5c5963e83cb30dab121fc886935969d678acfddb`
- Workload: five synthetic 300-second stereo loop buffers, 20 per-track FX slots, 100,000 measured 64-frame callbacks at 48 kHz, 5,000 warmup callbacks
- Build: Linux x86_64, GCC 14.2.0, CMake 4.4.4, Release `-O3 -DNDEBUG`
- Clock: `std::chrono::steady_clock`; outputs are portable CPU callback simulation only, with no audio device or hardware XRUN measurement
- Baseline binary SHA256: `d7965be30a917ee8b54e36d6aa04a287bc57efff08c9855c4bc8fe464c7169c6`
- No-peak binary SHA256: `0ef76405db80fa7b99a61272e11ff8f310ad0319ab4af1b62500dcc92a1aef5e`
- No-peak patch SHA256 recorded by benchmark: `d31d5715f50a7e3e588483ed91d63022b8f950a6d929976d9fdba494626c80df`

Serial runs were interleaved A/B/A/B/A/B/A in one environment. Each raw JSON and metadata sidecar is retained beside this report. The benchmark stores per-run summary statistics, not callback-level distributions; medians below are medians of per-run statistics, not pooled quantiles.

| Run | Variant | Mean ms | P50 ms | P95 ms | P99 ms | P99.9 ms | Max ms | >1.333 ms callbacks |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 20261018T1645Z | Baseline | 0.482 | 0.452 | 0.658 | 0.975 | 2.612 | 10.497 | 532 |
| 20261018T1652Z | No-peak | 0.466 | 0.444 | 0.619 | 0.812 | 2.439 | 17.314 | 284 |
| 20261018T165755Z | Baseline | 0.489 | 0.457 | 0.685 | 1.021 | 2.542 | 4.946 | 556 |
| 20261018T165943Z | No-peak | 0.542 | 0.483 | 0.848 | 1.618 | 3.363 | 48.199 | 1,513 |
| 20261018T170112Z | Baseline | 0.481 | 0.451 | 0.657 | 0.960 | 2.580 | 35.472 | 557 |
| 20261018T170234Z | No-peak | 0.472 | 0.447 | 0.633 | 0.846 | 2.495 | 22.612 | 379 |
| 20261018T170352Z | Baseline | 0.509 | 0.458 | 0.727 | 1.504 | 3.928 | 28.614 | 1,216 |

Across-run median of the available per-run statistics: baseline vs no-peak mean 0.4856 vs 0.4717 ms; P99 0.9978 vs 0.8462 ms; P99.9 2.5960 vs 2.4950 ms; deadline misses 556.5 vs 379. The sample is small and has substantial host-scheduling outliers in both variants (baseline max up to 35.472 ms; no-peak max up to 48.199 ms). These results do not establish causality or acceptance.

## Result and gate status

The exact-output and no-allocation checks pass. The portable timing evidence is inconclusive. Contract performance targets remain FAIL/UNMET: every no-peak run's P99.9 exceeds the 1.067 ms target, P99 is not consistently at or below 0.8 ms, and the callback deadline is still exceeded. The run does not measure actual hardware XRUNs. No full-device, 30-minute full-load, or hardware timing pass is claimed.

An early 1644Z raw file is empty despite its sidecar stating exit code 0, and an 165624Z attempt was interrupted before producing data; neither is included. Their files are retained and must not be interpreted as measurements.

## Browser timing boundary

The CfT headless-shell smoke at `bench/results/browser_audio_worklet_f7bee1d_20261018T1648Z.json` ran a 10-node production-worklet graph for 10 seconds at 48 kHz: 37,508 callbacks, no estimated gaps, and no non-finite output. Its worklet scope did not expose `performance.now()`, and the available `Date.now()` clock changed by 1 ms across 4,096 samples. It therefore provides a functional smoke only; Browser P99/P99.9 CPU timing and the full 30-minute supported-load stress remain unmeasured on this tree.

## Verification

- Native portable Debug build: succeeded
- Native portable CTest: 46/46 passed serially
- Browser unit suite: 907/907 passed
- Strict Rubber Band-enabled Playwright E2E, using the explicit Native no-audio simulation host and verified CfT headless shell: 84/84 passed
- Release all-target build separately encountered an unchanged `looper_core_tests.cpp` `NDEBUG`/`-Werror` unused-variable compilation failure; the complete Debug build and suite passed
