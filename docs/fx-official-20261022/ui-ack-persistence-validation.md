# Native official-control acknowledgement and persistence

Validated 2026-10-22 in the cloud CPU environment, CPU affinity 0–5. No user-device deployment, hardware sound-quality claim, or remote push.

- Full frontend regression: **180 files / 2097 tests PASS**, 49.08 seconds.
- Targeted acknowledgement, replacement and persistence regression: **4 files / 21 tests PASS**.
- TypeScript and production build pass, including AudioWorklet build and six license-file checks.
- Independent read-only review found the initial pending-restart/active-toggle edge case; the final revision closes it and its amount/clear-slot variants.

## Correctness contract

The expected host acknowledgement now comes from the same canonical Native parameter builder as the submission, including the actual typed STEP SLICER sequence. Equality remains exact for authored controls. Only host-derived official BPM and measure length are excluded; STEP SLICER's legacy BPM is excluded only when the user did not author it.

Input and shared Track banks, and private-track controls, persist named overrides only after acknowledgement. A `requiresRestart` rejection preserves the pending reset; a later explicit stop/restart acknowledgement saves the empty override map. Ordinary amount/active changes retain this pending map and rebase the expected snapshot instead of replaying older persisted overrides. Clearing/changing the effect cancels obsolete pending state. Definite unsupported-host rejection does not later resurrect the rejected edit.

These tests establish the control/host-acknowledgement/localStorage path, not device-output audio, exported Memory archive support, or full MIDI assignment coverage. Native source-aware transport changes underway separately are not included in this checkpoint.
