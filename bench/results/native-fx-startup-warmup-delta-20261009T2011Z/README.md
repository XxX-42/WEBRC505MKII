Native FX startup warmup API delta — copied-source verification

This archive links a five-file overlay to the immutable 41-ready source snapshot at `bench/results/native-fx41-copied-closure-20261009T193630570Z/`. Reconstruct by copying that base `source-snapshot/` tree and replacing the five files listed in `delta-manifest.json` with the matching files in `delta/`. The resulting 1,415-file tree is pinned by `post-overlay-source-manifest.json` (`sourceSetSha256` in `evidence/compiler-closure-delta.v1.json`).

The copied tree was built in Release with VS 2019 MSVC toolset 14.29.30133, compiler 19.29.30159.0, CMake 4.4.2, NMake. The unfiltered CTest run passed 28/28 (14.82 s); no hardware device was opened. The compiler closure delta records 66 actual translation units, 478 dependency inputs (149 copied-source and 329 external toolchain inputs), and hashes for 109 preserved `.obj/.exe/.lib/.exp` outputs. Build/test logs and CMake state are under `evidence/`.

The initial build log filename `native-verify-showincludes.log` was inherited from the launcher but is not an include-trace log; its faithful copy is labeled `native-verify-copied-source-build-ctest.log`. The supplemental `-showIncludes` attempt is retained separately and is not used as the dependency-closure proof.

The five source hashes are in `delta-manifest.json`. The comment referring to the 19 ms speaker model as “FourByTwelve” is a known non-semantic label mismatch; actual selector is EightByTwelve. This delta reports PREAMP’s prepared-instance startup warmup separately from fixed alignment latency. Startup-history bounds for other finite-history processors are still under implementation; no general “settled” or all-effects click-free claim follows from this archive.

This is a partial Native copied-source verification, not a 53-effect completion or Gate pass. It says nothing about device XRUNs or hardware output. Do not modify files in this sealed evidence archive; create a new revision directory for later work.
