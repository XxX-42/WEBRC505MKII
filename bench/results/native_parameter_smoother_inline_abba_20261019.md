# Native ParameterSmoother inline candidate: ABBA evidence

## Change under test

At base revision `c1eceda0c73cd7cbc5b17bb142fae826f9d63d21`, `ParameterSmoother::next()` was an out-of-line function called in per-sample DSP loops. The candidate moves its body verbatim into `include/dsp_primitives.hpp` as an inline member and removes only the out-of-line definition. Arithmetic, casts, state transitions, ramp length, and endpoint behavior are unchanged.

`dsp_primitives_tests` now compares 50,000 samples against a reference implementation of the previous contract while exercising dynamic targets, ramp lengths, resets, skips, NaN, and infinity. Each returned float and current/target state is compared bit-for-bit.

## Build and correctness checks

- CMake 4.2.0, GCC 14.2.0, Release build, `-O3 -DNDEBUG -std=c++17 -Wall -Wextra -Wpedantic -Werror`.
- Test targets add `-UNDEBUG`; verified from `dsp_primitives_tests.dir/flags.make` so assertions remained enabled.
- `NATIVE_PORTABLE_TESTS_ONLY=ON`, Rubber Band HQ disabled, experimental PREAMP ADAA disabled.
- Full portable build succeeded; CTest passed 46/46 (`ctest --test-dir /tmp/rc505-native-current-be1a --output-on-failure -j1`).
- Both old and candidate binaries produced identical FNV-1a hashes for each workload: dry `0x4098664398b58278`; selected-track LIVE_POLY `0x21687c733d9a51ea`.

## Workload and limits

The benchmark is a portable Linux CPU simulation of the Native core callback, not a real RtAudio device or hardware test. It records five synthetic stereo loops (300 s capacity each), configures all 20 private per-track A–D FX slots with the IDs saved in each JSON fixture, then measures 100,000 callbacks at 48 kHz / 64 frames after 5,000 warmup callbacks. Input is one mono 330 Hz sine; output is stereo. No Input FX slot is configured. The poly mode targets only Track 1 at +7 semitones. Each run verified zero catalog slot faults, all 12.8 million output samples finite, and an active LIVE_POLY route with no fallback.

The output hash is computed after each callback’s stopwatch is stopped. `steady_clock` observed minimum positive quantum was 20 ns. Percentiles below are per-run values, not pooled percentiles.

For interpretation, the callback hard deadline is 1.333 ms. The stricter Native budget goals are P99 <= 0.800 ms and P99.9 <= 1.067 ms. A deadline miss, P99/P99.9 target failure, and physical-device XRUN are distinct measures.

## Results

All values are milliseconds except hard-deadline misses and hashes.

| Mode | Run | Mean | P50 | P95 | P99 | P99.9 | Max | >1.333 ms | Output hash |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| off, old | A1 | 0.512 | 0.466 | 0.748 | 1.148 | 3.247 | 25.454 | 723 | `0x4098664398b58278` |
| off, inline | B1 | 0.485 | 0.451 | 0.677 | 0.974 | 2.887 | 13.594 | 546 | `0x4098664398b58278` |
| off, inline | B2 | 0.486 | 0.452 | 0.680 | 0.965 | 2.578 | 21.215 | 494 | `0x4098664398b58278` |
| off, old | A2 | 0.497 | 0.462 | 0.699 | 1.030 | 2.589 | 12.967 | 560 | `0x4098664398b58278` |
| LIVE_POLY Track 1 +7, old | A1 | 0.501 | 0.463 | 0.713 | 1.070 | 2.963 | 14.711 | 612 | `0x21687c733d9a51ea` |
| LIVE_POLY Track 1 +7, inline | B1 | 0.520 | 0.476 | 0.746 | 1.206 | 3.330 | 45.920 | 817 | `0x21687c733d9a51ea` |
| LIVE_POLY Track 1 +7, inline | B2 | 0.511 | 0.470 | 0.736 | 1.124 | 2.948 | 28.558 | 681 | `0x21687c733d9a51ea` |
| LIVE_POLY Track 1 +7, old | A2 | 0.536 | 0.485 | 0.785 | 1.349 | 3.629 | 30.065 | 1026 | `0x21687c733d9a51ea` |

The no-pitch candidate was lower than its adjacent old run on mean, P95, P99, P99.9, maximum, and hard-deadline miss count in both ABBA comparisons. Output samples remained bit-identical. This is a promising improvement for the measured no-pitch portable topology, not a gate pass: candidate P99 still exceeds 0.800 ms, P99.9 exceeds 1.067 ms, and there are hundreds of callbacks above the hard deadline.

With LIVE_POLY selected on Track 1, results were mixed: B1 regressed versus A1, while B2 improved versus A2. The small aggregate change is not reliable evidence of a pitch-mode speedup. P99/P99.9 goals and hard deadlines still fail. No real hardware XRUN result is available.

## Raw runs and binaries

- No-pitch ABBA: `bench/results/native_smoother_abba_20261019T1332Z/`
- LIVE_POLY ABBA: `bench/results/native_smoother_pitch_abba_20261019T1338Z/`
- Binary SHA256 (old out-of-line): `ace37803eb172cd4560ed7c3418bb06ea72a9833dd456a60747ca19a3eca7a1f`
- Binary SHA256 (candidate inline): `679771c74e23bfe912ef78a69bafe581d9cd1710becb176de9bac21e38cc3c31`
