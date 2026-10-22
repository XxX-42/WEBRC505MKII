# Native distortion duplicated-history FIR: independent ABBA replication

Date: 2026-10-19 UTC 15:38:31–15:44:29

Candidate commit: `d668a64aa895de6723a3ca05c4d346d5c06c0da3`
Baseline source: `dfb347640cb1813471467b3defad033b47c489de`
This is a second independent A1/B1/B2/A2 run sequence using the same pinned baseline and candidate executables as the first ABBA. Binary SHA256 values are in `binaries.sha256`; commands, start/finish timestamps, stderr, per-run JSON, and host/load metadata are preserved alongside this report.

## Protocol

Uninstrumented portable Linux CPU callback simulation; no RtAudio device or hardware acceptance. Each run used 5,000 warmup and 100,000 measured callbacks, 48 kHz, 64 frames/callback, all 20 private per-track FX + all four input FX + all four shared FX + rhythm active, pitch off, monitoring off. Synthetic 330 Hz mono input at 0.1 peak. Release binaries used `-O3 -DNDEBUG`; `std::chrono::steady_clock` showed a 20 ns observed quantum. Host: AMD EPYC 9V74, Linux 6.18.55, 9 visible CPUs. Load average moved from 0.03/0.36/0.45 at start to 1.00/0.83/0.64 at end. The order was serial A1, B1, B2, A2 with no builds or other benchmarks launched by this run.

## Results

| Run | Mean µs | P99 ms | P99.9 ms | Max ms | >1.333 ms | Output hash |
|---|---:|---:|---:|---:|---:|---|
| A1 baseline | 573.724 | 1.450239 | 3.814722 | 41.509963 | 1,179 | `0x47de4df7c580df98` |
| B1 candidate | 552.647 | 1.074355 | 2.815390 | 20.659589 | 615 | `0x47de4df7c580df98` |
| B2 candidate | 579.804 | 1.466324 | 3.172488 | 23.607092 | 1,284 | `0x47de4df7c580df98` |
| A2 baseline | 568.847 | 1.211100 | 2.916073 | 25.596624 | 818 | `0x47de4df7c580df98` |

Averages of per-run summaries (not pooled callback distributions): baseline vs candidate mean 571.286 vs 566.225 µs (-0.89%); P99 1.331 vs 1.270 ms (-4.53%); P99.9 3.365 vs 2.994 ms (-11.04%); average misses 998.5 vs 949.5 (-4.91%). B1 is faster than adjacent A1, but B2 is slower than adjacent A2; this matches the first ABBA's inconsistent adjacent-run direction. The mean improvement is small and the apparent tail/miss improvement remains sensitive to run variance and host drift. Do not call this a stable performance gain.

All four runs fail the Native acceptance targets: P99 ≤0.800 ms, P99.9 ≤1.067 ms, and hard maximum ≤1.333 ms. Each run records deadline misses, P99.9 above target, and a maximum far over the deadline. Output hashes are identical across baseline/candidate and both ABBA sequences.

## Correctness and memory

The FIR duplicated-history change preserves coefficient order, single-precision accumulation order, oversampling, smoothing, and latency; baseline-vs-candidate standalone oracle output was byte-identical across four rates, mono/stereo/three-channel passthrough, drive/mix settings, impulses, nonfinite/extreme inputs, irregular chunks, and a midstream automation ramp. Additional memory is exactly 976 bytes per processor (+488 bytes per processed channel, two processed channels maximum); third and later channels retain pass-through behavior. Full Release portable CTest was rerun after the candidate and passed 46/46 using:

`/tmp/rc505-cmake-tools/cmake/data/bin/ctest --test-dir /tmp/rc505-native-profiler-uninstrumented-0ffe10c --output-on-failure --parallel 1`

This is software simulation only; device timing and hardware XRUN behavior remain unmeasured.
