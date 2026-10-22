# Official FX interface alignment: staged implementation

Source: BOSS RC-505mkII Parameter Guide v1.3+, printed pages 34–43.
The machine-readable specification contains 53 effect families / 55 variants / 267 parameter rows. This is a document inventory, not a claim that all controls are implemented.

## Checkpoint boundary

2026-10-22 UTC, dot cloud only. No push, user-machine deployment or hardware audio/XRUN acceptance.

- Browser functional source rows: 252; source-mode-limited: 3; unsupported: 12.
- This checkpoint integrates the separately validated fourth Browser and Native batches. Later source-routing work is excluded until independently validated.
- Native functional source rows: 249; partial_live_stream: 1; unsupported: 17. Published interface: 50 effects / 258 DSP controls plus 2 routing selectors.
- Browser historical core group: 501 passed; meter/routing group: 111 passed. New per-control audio group: 258 passed; source/tempo/boundary/legacy TrackAudio group: 60 passed. These focused counts overlap the full suite and are not added together.
- Native portable CTest: 52/52 passed. Simulation: 5/5 passed, including full legacy HTTP and 258 official DSP control live updates plus the 2 explicit variant selectors.
- Fourth-checkpoint full Vitest: 176 files / 2,013 tests passed in 34.40 seconds. Production build passed, including vue-tsc, AudioWorklet bundle, Vite and required license verification. A previous exact-message test missing the new BPM field was corrected without altering DSP.
- Input/shared Track panels in both layouts now expose implemented official controls alongside preserved dedicated legacy editors. Panel-focused group: 40 tests passed. Native applies remain ACK-aware.
- Cloud production-preview startup: root app shell and bundled JavaScript served HTTP 200 on loopback. This is cloud startup only, not user-machine deployment.

MEAS propagation is now verified for non-4/4. Browser BEAT SHIFT/VINYL now use actual shared Track A loop sources, limited to supported playback modes; private chains reject these controls. Native VINYL in this checkpoint still reads bounded live history and is not source-aware loop playback. Unknown manufacturer MODE/phrase/pattern tables, independent VOCODER carrier routing, Memory archive FX inclusion, complete MIDI assignments, physical latency/sound/XRUN and real user-machine deployment remain separate gaps. No old test count is represented as a new full acceptance.

Native counted-delay storage is preallocated for 51 seconds, 18.68 MiB per instance at 48 kHz. The 16th half-note repeat at 40 BPM arrives at 48 seconds, with no 17th repeat. See native-validation.md for dependency provenance, test logs and real-time constraints. PREAMP/DYNAMICS presets and voice models are independently authored, not measured Roland factory models. Last four Track-only effects admit official controls only in Track A under the implemented MULTI bank mode; legacy extension-only routes are preserved.

## Compatibility and truthful boundaries

- All official fields use an additive `official_` namespace. Existing project IDs, units, authored extension parameters, and old projects retain their meaning.
- Official control ranges/choices come from the guide. The 0–100 cutoff/rate/depth transfer curves are authored software mappings, not measured Roland DSP laws.
- Undocumented intermediate tempo choices, MODE 1/2 algorithms, and P1–P30 AUTO RIFF phrase contents are not invented. Unsupported parameters are absent from operational UI, not empty knobs.
- DELAY FEEDBACK is a repeat count, not a feedback-gain percentage. Browser and Native DELAY, PANNING DELAY, REVERSE DELAY, and MOD DELAY use counted repeat paths.
- The manual prints 500 ms as all three reverb PRE DELAY defaults. This is retained as documented, not asserted as device-verified.
- Native ACK means accepted control state, not a hardware audio-quality result. All hardware sound parity, XRUN, physical latency, and user-machine deployment remain unverified.
- Existing slot-local storage/recovery can retain new numeric fields. Memory/project archive does not yet include FX state; no claim of Memory export completion.
- No push, force-push, user-device access, or user-UI replacement is part of this checkpoint.

Browser source-aware controls, reversed rising reverb, independent pattern gating and official 40–300 BPM bounds are described in validation-summary.md. Browser message-thread ring expansion is not a strict allocation-free real-time guarantee.

### Complete Native authored snapshots and reset safety

The editor sends `replaceParameters: true` only when the host advertises
`nativeFx.catalogParameterReplacement: true`. Raw bridge clients that omit the
flag retain patch semantics. Older patch-only hosts remain usable with legacy
controls, but official control writes are refused rather than falsely claiming a
full snapshot/reset was applied. `parameterSchemaVersion` remains 1; capability
negotiation is independent of descriptor layout.

On a capable host, changing existing keys or adding keys remains live. Removing
an authored key while audio runs is rejected with `Stop Native audio` and the
editor reports NOT APPLIED / pending restart. It does not automatically stop the
engine. Applying while stopped reconstructs the processor from the replacement
snapshot, restoring omitted defaults and clearing obsolete variant state. This
conservative boundary avoids allocating/replacing DSP objects in a running audio
callback and avoids inventing conditional defaults.

An actual published-host schema fixture now checks every official family and
variant through the public Native editor adapter, including the formerly missing
HRM AUTO (M) selector label. Control defaults, IDs and domain acceptance are
checked against the real host metadata, not only handwritten UI fixtures.
