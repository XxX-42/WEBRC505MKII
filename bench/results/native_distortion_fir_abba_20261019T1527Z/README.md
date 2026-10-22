# Native distortion duplicated-history FIR candidate

Date: 2026-10-19 UTC
Baseline source: `dfb347640cb1813471467b3defad033b47c489de`

## Change under test

Native DIST previously performed a wrap test and conditional ring-index wrap for every interpolation/reconstruction tap. This candidate duplicates each fixed FIR history and mirrors every write; the FIR reads backwards through a contiguous duplicated span, preserving the same tap order and single-precision `sum += coefficient * sample` sequence. The 4× oversampling, 97-tap coefficients, 24-frame latency, control smoothing and all writes/state advances are unchanged. The callback adds no allocation or lock.

Each `ChannelState` grows by `(25 + 97) * sizeof(float) = 488` bytes. There are exactly two processed channel states, so processor size rises from 2,056 to 3,032 bytes (+976 bytes, verified with `sizeof`); at most two audio channels are processed. Extra channels still pass through unchanged.

## Exactness checks

`run-oracle.sh` reconstructs the baseline processor source/header from the baseline Git commit, builds both versions with GCC 14.2 and `-O3 -DNDEBUG -std=c++17`, and compares their output bitstreams. Each run covers 4 rates (8, 44.1, 48, 192 kHz), 3 channel counts (mono/stereo/3-channel pass-through), 3 drive settings (0/18/36 dB), 3 mix settings (0/50/100%), 12,037 frames per case, deterministic multitone/noise plus impulse/extreme/NaN/Inf inputs, irregular chunk sizes, and a mid-stream configuration ramp. Result: byte-for-byte equal, 10,420,704 bytes each, SHA256 `e40edcdedd5d52cddfa64632dc4f063b6a9905b8350f795609592a5ef376486b`. The temporary raw bitstreams were kept outside Git.

The existing Native distortion suite passed, including latency/dry-wet alignment, 4× alias reduction, non-finite input protection, chunk/reset equivalence, smoothing and allocation-free callback checks. Full Release portable CTest: 46/46 passed.

The all-banks smoke (5,000 warmup, 32 measured) also had the same output hash before and after: `0x12d2cbf121b5de2e`.

## Uninstrumented 28-slot + rhythm ABBA

One serialized A1/B1/B2/A2 sequence ran with no profiler or other build/benchmark task: 48 kHz, 64 frames/callback, 5,000 warmup + 100,000 measured callbacks, 20 private track FX + 4 Input FX + 4 shared FX + rhythm active, pitch off, monitoring disabled. Backend is portable Linux CPU callback simulation, not RtAudio/device or hardware acceptance. CPU: AMD EPYC 9V74; Linux 6.18.55; Release `-O3 -DNDEBUG`; `std::chrono::steady_clock`, observed 20 ns clock quantum. Individual outputs and start/finish markers are in this directory. Baseline executable SHA256: `7485d31ace4e97c4d9259ff58e4d82ee6240c7e629800b2b5b13f655d9a72f61`; candidate: `f0db2a7c636e531de38ee2ce27b9bb19abe15c539face55c535d9881cf89b7be`.

| Run | Mean ms | P99 ms | P99.9 ms | Max ms | >1.333 ms | Output hash |
|---|---:|---:|---:|---:|---:|---|
| A1 baseline | 0.553776 | 1.104832 | 2.895090 | 20.118573 | 651 | `0x47de4df7c580df98` |
| B1 candidate | 0.555634 | 1.107244 | 2.819217 | 16.594750 | 674 | `0x47de4df7c580df98` |
| B2 candidate | 0.552279 | 1.074094 | 2.706952 | 11.818525 | 605 | `0x47de4df7c580df98` |
| A2 baseline | 0.566791 | 1.169267 | 2.801642 | 28.678597 | 742 | `0x47de4df7c580df98` |

The run-level mean averages are 560.283 µs baseline vs. 553.956 µs candidate (1.13% lower); averages of per-run P99/P99.9 are 1.137/2.848 ms baseline and 1.091/2.763 ms candidate; mean deadline misses are 696.5 vs. 639.5. These are averages across two run summaries, not pooled percentiles. B1 is slightly slower than its adjacent A1 while B2 is faster than adjacent A2; the result is small and vulnerable to run-to-run drift. Retain only as a correctness-verified candidate pending a second independent ABBA before calling this a stable performance gain.

All four runs still fail Native targets (P99 ≤ 0.800 ms, P99.9 ≤ 1.067 ms, hard maximum ≤ 1.333 ms). No hardware/XRUN measurement was made.
