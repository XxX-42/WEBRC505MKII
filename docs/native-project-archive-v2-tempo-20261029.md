# Native ProjectArchive v2 tempo metadata lifecycle

Date: 2026-10-29  
Base: `1b3110c` (ProjectArchive v2 codecs with v1 as the default C++ export)  
Scope: Native archive import/export metadata plumbing; no TrackAudio changes.

## Behavior

- Native status advertises `projectArchiveV2Supported: true`. The TypeScript Native exporter chooses v2 only when that capability is explicitly present; an older host with the field absent keeps the v1 export path.
- The Native track metadata route returns `originalTempoBpm`, including explicit `null`, from the same callback-pinned snapshot as frame count, sample rate, and content revision. The TypeScript exporter carries it only into v2 and verifies that the PCM snapshot revision still matches.
- Native import accepts codec-validated v1 and v2. It preallocates candidate PCM and candidate tempo bits on the control thread. At the callback boundary it validates the same transaction generation, swaps all five PCM stores, then publishes all five tempo values before acknowledging `Committed`. A failed preflight or a stale generation preserves the incumbent PCM and tempo values.
- Per-track tempo state uses five fixed `atomic<uint64_t>` slots with a compile-time lock-free requirement. Import callback work adds no allocation or lock. V1 import replaces every track's tempo metadata with unknown.
- Native-created recordings remain unknown. The callback clears tempo metadata when a new live recording begins and when a track clears; no BPM detector or capture-time provenance is claimed. Overdub preserves the existing original take tempo.
- Track undo/redo history carries before/after tempo bits with the existing loop metadata and PCM state. Clearing an imported loop makes it unknown; undo restores the imported BPM; redo clears it again.
- The TypeScript and C++ codecs still export v1 by default. V2 is explicit at the codec layer, and the Native TypeScript exporter opts in only from the new host capability.

## Verification

- CMake Release build of `native_memory_tests`, `native_bridge_host_simulation`, `project_archive_codec_tests`, and `project_archive_codec_interop`: passed with MSVC 2019.
- `native_memory_tests.exe`: passed. New lifecycle coverage imports v2 known tempo, checks callback-pinned metadata/revision, checks clear/undo/redo, confirms fresh Native REC stays null, and confirms v1 replacement clears known metadata.
- `native_bridge_http_simulation_test.py`: passed with the synthetic no-hardware callback host. It confirms the capability field, v1/v2 HTTP archive import, callback commit ACK, original tempo metadata response, and null BPM for a live Native recording. This is functional simulation evidence, not physical-device audio evidence.
- `npm run build`: passed, including `vue-tsc -b` and the production Vite build.
- `npm run test:unit -- tests/unit/projectArchive.spec.ts`: 15 tests passed.
- `npm run test:archive:interop -- <project_archive_codec_interop.exe>`: TypeScript→C++ and C++→TypeScript v2 archive interchange passed.
- `project_archive_codec_tests.exe`: passed.

## Limits

- `originalTempoBpm` is preserved only when an archive already contains a valid known value. Native does not infer BPM from recorded audio and does not attach Transport BPM to new recordings.
- The metadata describes the source take tempo. It does not prove phase alignment, loop-boundary alignment, overdub phase, or LIVE_POLY/MIDI follow behavior.
- Export requires a running Native host with the advertised v2 capability and a stable callback snapshot. Older hosts remain on v1 and cannot preserve known v2 tempo metadata.
