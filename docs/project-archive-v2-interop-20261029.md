# ProjectArchive v2 original tempo metadata and codec interop

Date: 2026-10-29  
Baseline: `f922b9375dda33995b99ac4fc33bf74dae4648f7`  
Scope: TypeScript and C++ ProjectArchive codecs only; no TrackAudio changes.

## Format and compatibility

- V2 adds a required `originalTempoBpm` key to every nonempty track manifest. Its value is a finite number from 40 through 300 BPM, or `null` when unknown.
- V1 track manifests retain their exact old key set. Both decoders continue to read v1 and normalize its unrecorded tempo to null. They reject the v2 key in a v1 manifest, reject a missing key in v2, and reject out-of-range values.
- TypeScript export remains v1 by default. V2 requires `encodeProjectArchive(project, { version: 2 })`; attempting to export a known non-null tempo as v1 fails instead of silently dropping it.
- C++ `encodeProjectArchive` writes v2. C++ decoding supports strict v1 and v2 manifests. The shared field is archive metadata, not proof that Native captured or knows a track's original tempo.

## Implementation

- TypeScript codec types, validation, v1/v2 decoder, default-v1 encoder, and explicit v2 encoder are in `src/audio/projectArchive.ts`.
- Native C++ codec data model, strict versioned decoder, and v2 encoder are in `native-mvp/engine-cpp/include/project_archive_codec.hpp` and `native-mvp/engine-cpp/src/project_archive_codec.cpp`.
- Unit fixtures cover v1 exact-schema export/read, v1 tempo normalization to null, v2 known and null tempo, malformed values, missing fields, and strict rejection of cross-version schema changes.
- A file-based two-way interop harness checks TypeScript-produced v2 in C++ and C++-produced v2 in TypeScript: `scripts/test-project-archive-interop.mjs`, `tests/interop/projectArchiveInterop.ts`, and `native-mvp/engine-cpp/tests/project_archive_codec_interop.cpp`.

## Verification

- `npx vue-tsc -b`: passed.
- `npm run test:unit -- --run tests/unit/projectArchive.spec.ts`: 15 passed.
- CMake Release build of `project_archive_codec_tests` and `project_archive_codec_interop`: passed with MSVC 2019 strict warnings.
- `ctest --test-dir native-mvp/build-archive-codec -C Release -R '^project_archive_codec_tests$' --output-on-failure`: passed.
- `npm run test:archive:interop -- native-mvp/build-archive-codec/Release/project_archive_codec_interop.exe`: both TS→C++ and C++→TS v2 directions passed, including PCM and known/null BPM assertions.

## Limits

The codec-level interoperability is proven by the harness. The Native project-memory load/save and live recording paths have not been migrated to persist or populate `originalTempoBpm`; they must continue using the default v1 exporter until that app-level path is independently wired and verified. This work does not claim Native live metadata capture or end-to-end Native v2 completion.
