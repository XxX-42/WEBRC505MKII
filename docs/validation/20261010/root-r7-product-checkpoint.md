# R7 product checkpoint — not a release acceptance

The default module now contains 53 registered FX and the matching musical-context/profile-aware APIs. Both production Worklets and their Browser/Native consumers are included together. The 90 source fingerprints were checked against live files and Git index bytes before committing. WASM SHA-256: `3cbabce3f7ed0a0d4db512388152422ec97cd24b0682ec19902ef2189b3078e3`; source-set SHA-256: `c9e7797a9d046dc9bba1b48429ceb80cd67e8198c0334f57ad746fbe30b92e0f`.

Independent root validation:

- Full Vitest run with two workers: 270 passed, one failed because the launch omitted `WEBRC_SHARED_DSP_SOURCE_SET_SHA256`. That fixture passed when rerun with the actual module and source-set identifiers. All 271 tests were exercised successfully across those runs; the full invocation itself did not exit successfully. Logs: `root-r7-full-vitest-r2-limited-workers.log`, `root-r7-actual-worker-r3.log`.
- Earlier unrestricted-worker run: two existing timeouts and an omitted-WASM fixture; retained in `root-r7-full-vitest.log`. Test timeout thresholds were not increased.
- Unfiltered Native CTest independent rerun: 36/36 passed, 40.51 seconds, log `root-native36-rerun.log`. This reran the existing live-tree build; it was not a fresh immutable-source compilation.
- Asset verifier: 90/90 source fingerprints and module/build pin match.
- Actual WASM factory/process smoke: 53/53 passed; this is kernel coverage, not complete browser graph or real-time acceptance.

Outstanding blockers: HRM MANUAL HQ preparation still exceeds the configured 48 MiB ledger and is rejected; complete Chrome product graph validation is pending; Native Undo/Redo, Reverse, full PCM Memory, WAV endpoints and Bounce remain incomplete; a new 30-minute whole-product real-time run has not passed. Physical input-to-output latency has not been measured. The separate WAV codec prototype is not yet registered in the Native product build.

No new algorithms or noncritical timbre optimization are authorized by the current priority list. Subsequent HRM changes require a new paired source/module build and new acceptance evidence.
