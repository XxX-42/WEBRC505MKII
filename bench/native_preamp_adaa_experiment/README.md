# PREAMP constant-cancelled ADAA arithmetic experiment

This folder contains an opt-in numerical experiment for Native PREAMP. The production/reference arithmetic remains the existing implementation by default. `NATIVE_PREAMP_EXPERIMENTAL_STABLE_ADAA` defaults to `OFF`; enabling it compiles the algebraically constant-cancelled antiderivative difference for comparison. The two expressions are mathematically equivalent in real arithmetic but differ in float rounding. This is not a sound-quality acceptance and is not evidence of hardware real-time performance.

## Reproduce

From the repository root, use a CMake installation with CTest beside it. Optional `JSON_SRC` can point at a previously fetched nlohmann/json source tree to keep CMake from fetching dependencies again.

```sh
CMAKE_BIN=/path/to/cmake CTEST_BIN=/path/to/ctest \
JSON_SRC=/path/to/nlohmann_json-source \
JOBS=2 TEST_JOBS=1 \
bash bench/native_preamp_adaa_experiment/run_evaluation.sh /tmp/preamp-adaa-run
```

The script records its source commit, compiler/tool versions, both CTest runs, compiler binaries and hashes, numerical-oracle output, matrix raw/metadata, and an A/B/B/A callback-simulation run. The script intentionally reports portable Linux CPU simulation only. It does not claim a physical audio device, end-to-end UI, hardware XRUN result, or subjective sound-quality pass.

## Included checks

- `preamp_matrix_fixture.cpp`: paired baseline/candidate PCM for 2,094 cases: 2,016 tones (six rates: 8, 22.05, 44.1, 48, 96, and 192 kHz; five models; three gains; four FFT bins; five amplitudes), 72 DC/edge/clamp cases, and six dynamic parameter sequences. It exercises variable block sizes and records 4,392,960 floats per implementation. The chosen tones and deterministic edge cases are characterization fixtures, not perceptual coverage.
- `analyze_preamp_matrix.py`: frame-aligned PCM differences and tone-bin/harmonic/folded-alias characterization. It requires NumPy and checks metadata and finite outputs.
- `numerical_oracle.cpp` and `threshold_grid.cpp`: compare float arithmetic with a double-precision antiderivative oracle over deterministic random production-shaped slopes/biases, near-threshold deltas, and clamp edges.
- `run_evaluation.sh`: OFF and ON Release builds plus full CTest, paired matrix capture and ABBA portable callback benchmark.

## 2026-10-18 local evaluation (source HEAD `be1a159`)

Both variants built in fresh Release CMake trees and passed the full portable CTest suite: 46/46 with the experiment OFF and 46/46 with it ON. Test assertions remain enabled in Release. The source used for the matrix was then changed only to add the OFF-by-default CMake option and conditional implementation. A new v4 capture reproduced the prior v3 captures byte-for-byte: baseline PCM SHA-256 `cebc0a0b618fca187cadf7166ccc38f7f046dcb6860c69a2547184a3b5590fb1`, candidate PCM SHA-256 `3d31c314cb95f3900d37e5bafe338243453d32d9bcf8fcdc721daac47c07ce4d`, and both metadata SHA-256 `82c9108c75e38d2062485f4fed92c10d97478d987d351d7a8e67e37361692456`. All 2,094 cases were finite. Across the matrix, difference RMS was `5.47336411e-05` and peak absolute sample difference was `0.00273537636`.

The direct arithmetic oracle found lower numerical error for the candidate on its sampled inputs (RMS `0.000584203` to `0.000377992`, about 35.3% lower); this is a numerical-stability observation only. Output samples are not bit-identical, and these tests do not establish inaudibility or acceptance.

A portable 48 kHz, 64-frame CPU callback A/B/B/A run on five tracks with all 20 private FX enabled showed mixed tails and deadline misses. Baseline runs: 503 and 316 callbacks over the 1.333 ms hard deadline; candidate runs: 392 and 470. The mean of the two run means was about 475.2 us baseline and 452.4 us candidate, while both variants had P999 above the hard deadline. Thus the real-time simulation remained FAIL; do not infer hardware or end-to-end acceptance.

Raw files and per-run JSON are retained separately from Git because the PCM evidence is large. See the accompanying evidence manifest for exact file hashes and paths. No listening panel, perceptual threshold, or hardware device was used.
