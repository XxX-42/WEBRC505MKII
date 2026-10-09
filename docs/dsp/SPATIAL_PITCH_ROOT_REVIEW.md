# Spatial and pitch shared-core review

The coordinator independently built the combined shared library with MSVC 19.29.30159 and ran all five CTest entries on 2026-10-09: primitives, control/dynamics, nonlinear, spatial/temporal, and pitch. **5/5 passed** against a stable source fingerprint `0ece4c18fa94...` in an isolated TEMP build. A subsequently added identity-PSOLA residual assertion was rebuilt and independently passed in the Native pitch target, **1/1**, without repeating the unchanged benchmark.

The final pitch test source was also independently compiled with pinned Emscripten 6.0.10, SIMD, `-fno-exceptions -fno-rtti`, fixed 64 MiB memory and Node execution. It passed. This functional test is not an AudioWorklet timing run or Native/WASM PCM parity qualification for the entire graph.

## Measured signal behavior

The real YIN-to-streaming-PSOLA fixture covers onset, deterministic noise, 82.3 Hz, a glide, 997.3 Hz, and offset at 48 kHz. A first voiced estimate arrives 1663 samples after input onset. The resynthesis buffer is 1800 samples (37.5 ms); detected output onset occurs at frame 5901 versus input onset 4096, a fixture-specific difference of 1805 samples (37.604 ms). Output last-active frame is 67360 versus input offset 65536, a difference of 1824 samples (38 ms). These onset thresholds are neither an impulse group-delay measurement nor hardware round-trip latency.

Stable shifted tones measured 102.885 and 1246.63 Hz, for targets 102.875 and 1246.625 Hz. The analysis window is 2048 samples. Its conservative window-plus-buffer budget is 3848 samples (80.167 ms); this sum is not reported as measured end-to-end latency. The separate test configuration with maximum pitch period 512 reports 1536 samples of resynthesis buffering. The seeded Signalsmith configuration with block/interval 512/128 reports 256 input and 256 output latency samples; the three quality routes still need full integration, actual latency/quality sweeps and deadline admission.

Spatial tests exercise independent FFT/DFT agreement, matrix convolution against direct convolution, normalized Hadamard transforms, FDN decay/correlation, deterministic granular edges, several Hann WOLA overlap settings, non-bin freeze tones, 130 overlapping reverse segments with distinct stereo input, platter motion, four drum families, and fixed pools. Callback new/delete guards cover 64/128/256 frames. The initial reverse switch is faded, and the mixed drum pool uses fixed headroom, idle-slot preference and a bounded steal tail. Full-effect switching/voice quality and Browser runtime behavior remain separate acceptance work.

## Raw timing evidence and limits

The fresh immutable records are `bench/results/native_primitives_20261009T113047393Z_0ece4c18fa94.json` and `bench/results/native_nonlinear_20261009T113047393Z_0ece4c18fa94.json`. The initial primitive stack's 20,000 measured 64-frame/48 kHz calls give P99 39.9 microseconds, P99.9 63.3 microseconds and maximum 233.2 microseconds; its deadline is 1333.333 microseconds. This stack does not exercise every newly added module, four effects per track, the actual device callback, or the full five-track graph. Older runs and their outliers remain preserved. Source fingerprint changes in unrelated test inputs do not convert this stack into a whole-library benchmark.

Initial spatial percentile-only archives have provisional provenance; their capture method is being replaced by fresh TEMP compilation with before/after source hashes and chronological timing arrays. They are not used to pass a performance gate.

## AddressSanitizer is not passed

The independent MSVC AddressSanitizer build compiled every target, then its first test stalled at startup with near-zero CPU. The coordinator stopped only the owned TEMP test and CTest process after 111.60 seconds. The run failed; no sanitizer pass is claimed. An independent minimal MSVC ASan program exits with `0xC0000142`, and the installed Emscripten host clang lacks `clang_rt.asan_dynamic.lib`. The first sanitizer recipe also replaced MSVC default flags and omitted `/EHsc`; the revised recipe must include it, bound preflight/test execution and record unavailable-runtime outcomes explicitly. Alternative usable sanitizer evidence remains required.

## Scope of acceptance

This batch is shared-core functional evidence only. Gate 1 stays in progress: long cross-runtime PCM parity, all-module raw performance, sanitizer/static checks, and actual Browser integration remain outstanding. No FX registry, rhythm kit, quality tier or full-system stress gate is passed by these tests. Hardware/device latency and XRUN remain unmeasured under the software-only scope.
