# Six-fix validation checkpoint — 2026-11-14

Base: `e94b9aae5026f1818196fadb96d1fca1ff520b33`.

## Changes

- Classic editor LCD uses three rows matching its rendered children; narrow-window warning no longer inherits a 280px vertical flex basis.
- STOP accepts detail-zero accessibility clicks through the existing short-press controller.
- Native pitch reset is decided at the common callback command boundary. An unrelated track does not reset a selected track's processor. Shared target 0 resets when the whole playback mix enters/leaves playback or its solo one-shot source explicitly restarts, preserving continuity while other members remain active.
- Native ALL uses observed status request age/RTT plus four callback blocks, rather than a fixed 500ms. Both raw and block-aligned lead above 250ms reject before POST; exact batch ACK/recovery remains required.
- Memory suppression retains user BPM intent until release. Archive BPM installation uses a separate internal-update hook.

## Current evidence

- Production build/type check: PASS; six exact license files verified.
- Targeted backend unit tests: 3 files, 71/71 PASS.
- Real-page Classic regression: 3/3 PASS (LCD geometry at 1920×1080 and 1366×768, narrow warning height, pointer/detail-zero STOP).
- Native ALL local simulation E2E: 1/1 PASS, 8.7s test / 13.2s suite, zero retries. Checks exact batch recovery, no writes on unsafe state, same-frame members and preserved PCM/parameters. The simulation executable predates the pitch change; this proves client scheduling/recovery only.
- Fresh VS2019 x64 Release device-free callback build: PASS. Final CTest `native_audio_callback_tests`: 1/1 PASS, 2.33s. Includes sample-by-sample pitch continuity across unrelated PLAY/STOP, split callbacks, scheduled helper, shared-mix member changes, and solo versus multi-member one-shot restart.
- Final callback test executable SHA256: `7e5e2a151f069f11539acdf976ddc7a77310a2005fab7cdafa62c94272f0aeda`.
- Complete unit run: 231 files, 2894/2894 PASS, zero failures or pending tests, 253.77s. JSON report SHA256: `00211429768c6796e913f2a97fa3b7d7bcad4ea039d4f653e51d430947e2b5db`.

## Failures retained

Initial UI assertions used an incorrect DOM/state-label assumption; corrected to actual geometry and RECORD text before the final passing run. The first fresh native callback run exposed a real shared-target reset regression; fixed and rerun successfully. No timeout increase was used.

## Boundaries

No matching RC-505/BOSS/Roland sound or present PnP endpoint was found in this round. No physical latency, XRUN, LED photometry or hardware sound-parity acceptance is claimed. This checkpoint does not prove complete E2E or overall 1:1 hardware parity.
