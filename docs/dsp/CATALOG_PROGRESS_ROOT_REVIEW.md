# Catalog evidence progress review — 2026-10-10

Gate 0 remains passed. Gate 1 is in progress; Gates 2–7 remain unpassed. Catalog references, source files and standalone test passes cannot establish complete Native/Browser behavior, musical quality, callback deadlines or the required stress acceptance.

The pending catalog update adds source/test/review references for each exact F01–F29 entry. All 29 explicitly retain `not_qualified_in_target_paths` and `qualifiedInTargetPaths: false`; each lists remaining target-path requirements. Several older root reviews cover adjacent primitives or narrower snapshots, which the entries state explicitly. The validator checks those references exist and that preserved rejected benchmark JSON still matches its recorded SHA. This validates evidence bookkeeping rather than the algorithms or Gates.

Review found three referenced clean-room rhythm files were present locally but untracked. The generator was also untracked. This checkpoint preserves the exact four source files, without regenerating the compiled table or changing its fingerprint:

| Source | SHA-256 |
|---|---|
| `dsp/spec/build_cleanroom_rhythm.py` | `1ce5bd1321e218368bcb2747a2b4e3e14b9c5dcd8a0c5ffe0f52699b58dbc6df` |
| `dsp/spec/cleanroom_rhythm_patterns.json` | `d0c9efa799f2a48193c426e2f5cb54182c6f564da6a8f90c7070785654b89115` |
| `dsp/spec/cleanroom_kit_profiles.json` | `af2315cd8bba5d60a8b7125ef7afef4f8bb359ebdd9475bda617e6129468c3f0` |
| `dsp/spec/validate_cleanroom_rhythm.py` | `07a4e0ff1ac4e6566bfb750687e773c001d17c655439d0ed3c19989ad0dce59d` |

`python dsp/spec/validate_cleanroom_rhythm.py` passes the original 240 event-source structures, their four variations, meter/swing bounds, 16 distinct procedural profiles, source CSV pins and the exact fingerprints embedded in `cleanroom_rhythm_data.cpp`. It is a structural/provenance check. These are original reconstructions using public labels; they contain no factory audio or MIDI. The original JSON status strings describe their generator-era reference capture and are kept immutable because compiled table getters expose their exact hashes. Later runtime integration is evidenced separately.

The reviewed Native checkpoint `97d9e81` contains 41 executable shared-factory FX and five independent stereo tracks in its software core. The root repeated the unfiltered 28-test suite from the pinned copied-source build. Its startup-history API is distinct from alignment latency; full finite-history coverage is undergoing a later revision. See `docs/validation/20261010/native-startup-warmup-delta-root-review.json`. This does not establish the Native bridge/UI control surface, full official parameter mapping, driver XRUNs or complete history/project features.

The Browser capture archived in `0fc081c` uses the 32-FX WASM asset (`45e9cb35064cef526730c0f3ca0ac11b164a9c20a03766291182a0019755af04`) and a causal serial-warmup implementation. Its tested copied-source tree is `aa382c0` plus seven Browser overlays; it is not the entire later repository HEAD containing the newer Native core. That quiet build/unit capture passed 32 files / 200 tests. The archived concurrent-load run retains its timeout failures. Browser v2 configured-create/history and cleanup changes are still being paired with a new module; old assets do not qualify those changes. See `docs/validation/20261010/browser-serial-warmup-root-review.json`.

The nine-kind musical adapter checkpoint `fecccf4` has a separate root-repeated standalone test pass, typed bounded MIDI events, stereo external carrier processing and tested rollback behavior. It is not yet a factory/host route and does not increase the 41/32 runtime counts. The independent R2/R3 and Signalsmith comparison now retains corrected mode windows and a broad spectral reanalysis; it passes no musical-quality or real-time Gate. Root reports are `docs/validation/20261010/musical-fx-adapter-root-review.json` and `docs/validation/20261009/rubberband-independent-root-review.json`.

The prior 30-minute Browser stress capture retains timeline gaps and GC evidence and is not an acceptance pass. Native integrated 30-minute stress remains missing. Hardware measurements remain untested under the user's software-only scope. All explicit requirements remain in the active full implementation objective.
