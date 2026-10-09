# Finite-history FX correction and root review

The shared 41-FX checkpoint separates input-history startup requirements from fixed dry-path alignment memory. Native graph admission now budgets alignment storage with `fxAlignmentUpperBoundSamples`, rather than using a potentially multi-second startup history as an alignment delay. Distortion ordinal 24's 22-frame alignment is included. Tests prepare all 41 executable processors at 24, 48, 96 and 192 kHz and check prepared history/alignment against their declared bounds.

Scatter's delay ring now carries absolute frame-generation tags. A requested frame that has already been overwritten returns zero and increments a bounded diagnostic counter. Grain admission reserves the entire read trajectory, including negative playback speed and interpolation support, so supported trajectories do not depend on overwritten data. The regression uses independent, nonperiodic left/right signals for more than four seconds, an independent PCM reference, a deterministic maximum-scatter case and different callback partitions. Ring memory admission includes the generation tags.

The startup bounds cover finite feed-forward histories, including delay, reverse segments, chorus, pitch windows and performance effects. They describe how much actual input history is needed when warming a new graph. They are not hardware round-trip latency, and finite early-reflection history does not establish convergence of recursive reverb feedback. Variable/mixed latency processors retain their distinct latency contracts.

One earlier full-suite failure was a test dereferencing a candidate `unique_ptr` after the host had accepted and moved it. The test captures the candidate byte count before staging. The corrected copied-source suite and an independent root repeat both pass all 28 tests. These passes do not establish musical quality, callback deadlines or the full 53-FX implementation.

The frozen build is `bench/results/native-fx-finite-history-r3-delta-20261009T2117Z`. It contains 162 copied source/build/vendor inputs, based on `7b56238` with eight explicit overlays. Its source-set SHA-256 is `86c96ac534cf6b12d7b0c481a68b914c13fad38dba82f7467bf4edfa9cd0f9b7`. Nine non-overlay checkout files differ from raw Git blobs only by LF/CRLF conversion; the actual compiled bytes are preserved. Later working-tree context/factory changes are outside this checkpoint.

Root verification covers:

- 1,755 archived payloads, with size and SHA-256 verification before and after review.
- All 66 logged object compilations, their generated source rules, 64 unique translation-unit sources and copied source bytes.
- All 66 MSVC dependency files and their exact normalized union of 414 header paths.
- All 107 archived build outputs, matched to the original copied-source build before and after testing.
- 1,259 FetchContent source files, matched to the previously accepted Native source snapshot. They were captured after compilation; this is corroboration, not a pre-build dependency freeze.
- MSVC 19.29.30159.0, VS2019 toolset 14.29.30133, the compiler/tool hashes and actual Release flags.
- An unfiltered root CTest repeat: 28/28 PASS, 29.47 seconds. Raw output is preserved in `docs/validation/20261010/root-native-finite-history-r3-ctest.log`.

The original TU supplement's aggregate digest cannot be reproduced from its individual records. It remains unchanged. The separate correction in `bench/results/native-fx-finite-history-r3-tu-digest-correction-20261009T213600Z` explicitly lowercases slash-separated paths and hashes sorted `path|sha256` records with an LF after every record. Root reproduces the corrected digest `42087c5d788f26b9237d82fbff01007032ea26317e03f24270b813ef4b5203b7` and verifies every individual TU/object hash. The original dependency manifest also retains hashes of 84 nested `.git` metadata files; those local metadata files are excluded from Git publication and the final payload index.

Run `python scripts/review-native-finite-history-r3.py` to verify archived evidence and the saved root test results. `--local` additionally checks the original build and installed SDK inputs; `--run-tests` repeats the copied-source CTest suite and requires that original build and toolchain. The machine-readable review is `docs/validation/20261010/native-finite-history-r3-root-review.json`.

Gate 1 remains in progress. Full Native/Browser FX routing, all 53 FX, Pitch profiles, project/history preservation, musical quality, full graph timing and the required 30-minute stress acceptance remain separate requirements. Hardware latency is untested under the user's software-only scope.
