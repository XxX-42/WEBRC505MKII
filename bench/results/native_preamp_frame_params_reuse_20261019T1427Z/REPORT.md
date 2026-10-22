# Native PREAMP per-frame parameter reuse

## Change

The PREAMP processor now calculates channel-invariant parameters once per input frame, after the same six smoother advances as before. The calculated values are reused by left/right processing: nonlinear-stage slopes and bias functions, common gain, tone/model/level gains, and interpolated cabinet coefficients. Per-channel state and sample accumulation order are unchanged; the tone expression retains its original multiplication grouping. The implementation adds only bounded stack data, with no per-frame heap allocation. The experimental stable-ADAA option remains OFF by default.

Source SHA-256:

- `native-mvp/engine-cpp/include/native_preamp_processor.hpp`: `5dbd459c2567650b700f9b63e2a6d543dd1f549e03c29e4c43d0494da81f0a93`
- `native-mvp/engine-cpp/src/native_preamp_processor.cpp`: `489c36387c25c837e27d920c07ab5d5a12900293d4ce9323d1f71ed746f7bd0e`

## Correctness and build checks

The retained deterministic oracle is `oracle.cpp`, and `validate-oracle.sh` rebuilds the baseline source/header from commit `fb3bd757e8cf77697dcb2fc1661669279fb4378e` and the candidate source using identical compiler flags, then diffs per-case output hashes. It passed bitwise for all 18 combinations: 8,000, 22,050, 44,100, 48,000, 96,000, and 192,000 Hz, each with 1, 2, and 3 channels. Cases include deterministic low-amplitude and full-scale signals, variable chunk sizes, parameter ramps and configuration/model changes.

Reproduce the oracle from the repository root with:

```sh
bench/results/native_preamp_frame_params_reuse_20261019T1427Z/validate-oracle.sh fb3bd757e8cf77697dcb2fc1661669279fb4378e
```

The current Release build was rebuilt with CMake 4.2.0 and C++ flags `-O3 -DNDEBUG -std=c++17 -Wall -Wextra -Wpedantic -Werror`. `ctest --test-dir /tmp/rc505-native-profiler-uninstrumented-0ffe10c --output-on-failure` passed 46/46. The opt-in `NATIVE_PREAMP_EXPERIMENTAL_STABLE_ADAA=1` translation unit also compiled with the same warning/error flags; this compile-only check does not qualify that experimental sound path.

## Callback ABBA

All four raw JSON runs and timestamps are retained here. A runs use baseline commit `0ffe10c`; B runs use the candidate source. Both executables use GCC 14.2.0, `-O3 -DNDEBUG`, the same portable callback benchmark and parameters: 48 kHz, 64 frames, 5,000 warm-ups, 100,000 measured callbacks, 5 loop tracks with 300-second stereo capacity, and all 20 private A–D FX slots configured. There is mono synthetic input and stereo output, no pitch processing, and no input FX. This is a portable Linux CPU callback simulation, not an RtAudio device or hardware test. Host was Linux 6.18.55 x86_64 with 9 reported hardware threads; timing used `steady_clock` with 20 ns observed quantum. Individual binary SHA-256: A `24bbf679d676f248950b3a242e4eaba85648872a1e1db64a7842bbb41f917205`; B `750ff8d0ef9b8842d436217d40b3adeda77be03d64af23fa4dea838e1cced25e`.

| Run | Mean | P99 | P99.9 | Max | >1.333 ms hard deadline |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 baseline | 522.128 us | 1.490 ms | 3.373 ms | 43.616 ms | 1,263 |
| B1 candidate | 466.965 us | 1.064 ms | 2.526 ms | 8.465 ms | 538 |
| B2 candidate | 469.316 us | 1.126 ms | 2.753 ms | 10.172 ms | 595 |
| A2 baseline | 526.152 us | 1.547 ms | 3.742 ms | 23.588 ms | 1,335 |

All runs produced the same finite-output hash, `0x4098664398b58278`. Averaging the two runs per variant (not a pooled callback distribution), candidate mean time is 10.7% lower; candidate P99/P99.9 averages are also lower. The contract targets remain P99 <= 0.800 ms, P99.9 <= 1.067 ms, and a hard callback deadline of 1.333 ms. Candidate runs still miss the P99 and P99.9 targets and include 538/595 hard-deadline misses, so the real-time gate remains FAIL. This limited topology result does not establish pitch-enabled, input-FX, hardware, or full-product acceptance.

Raw benchmark evidence: `ABBA-{A1,B1,B2,A2}-*.json` and adjacent timestamp metadata.
