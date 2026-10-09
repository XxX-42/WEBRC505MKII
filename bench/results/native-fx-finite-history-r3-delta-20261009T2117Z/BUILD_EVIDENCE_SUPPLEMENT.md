# R3 copied-build evidence supplement

This supplement completes the compiler-input record for the copied-source R3 run. It does not rewrite `source-manifest.json`, `build-evidence.json`, the CTest log, or any earlier measurement record. The authoritative source snapshot is the 162-file `source-snapshot/` plus the eight exact overlays recorded by `source-manifest.json`; its source-set SHA-256 is `86c96ac534cf6b12d7b0c481a68b914c13fad38dba82f7467bf4edfa9cd0f9b7`.

The copied build used the source snapshot under this archive and passed the full Native CTest set: 28/28, 34.29 seconds. The build log is `native-verify-copied.log`; CTest output and CMake cache are copied under `evidence/`. Hardware was not opened.

`build-evidence-tu-supplement.json` maps all 66 actual `Building CXX object` records from the build log to their source `.cpp` rules in generated `build.make` files. It identifies 64 unique translation-unit source files, hashes each, and stores byte-identical copies in `evidence/translation-units/`. The list includes `RtAudio.cpp`, `rtaudio_c.cpp`, and `apinames.cpp`; these `.cpp` files are deliberately recorded separately because MSVC `.obj.d` dependency files do not list the translation unit itself. The canonical unique-TU source-set digest is `6633fd9cdd010f31b5fae538915ae65e506fc13e5398c7de959897093f0f8f95` using the canonicalization documented in that JSON.

All 107 build outputs recorded by the original build-evidence file (`.obj`, `.lib`, `.exe`, and related outputs) are copied and re-hashed under `evidence/binaries/`. The supplement links each source output-relative path to its archived copy and SHA-256.

The exact compiler metadata comes from the copied build's `CMakeFiles/4.4.2/CMakeCXXCompiler.cmake`: MSVC 19.29.30159.0, VS2019 toolset directory 14.29.30133. CMake/CTest paths, versions, and hashes are recorded in the supplement. The original build-evidence JSON's null compiler identity fields remain untouched; use this supplement for the completed compiler identity and TU mapping.

FetchContent source trees were mirrored from the machine's existing cache after the build, so this record does not claim that their hashes were captured before compilation. The 1,259 files in those trees match byte-for-byte and hash-for-hash the previously accepted Native source snapshot; all three dependency trees are copied under `dependency-snapshot/`, and the supplement records each file comparison. This is post-build provenance corroboration, not a pre-build freeze.
