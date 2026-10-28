# Web MIDI external phase investigation — 2026-10-29

## Scope and official behavior

This change adds an opt-in, diagnostic-only projection of MIDI Start (FA) into the current Browser AudioContext frame timeline. It does not alter Transport, playback, REC/STOP, captured PCM, or project data. The MIDI Clock button remains disconnected by default and requires explicit connection plus one selected input.

The MIDI Association's MIDI 1.0 message summary defines Timing Clock (F8) as 24 messages per quarter note. Roland's RC-505mkII Parameter Guide says MIDI Sync Clock can follow MIDI IN/USB clock; its START setting controls what starts on a MIDI Start message (OFF, ALL tracks plus rhythm, or RHYTHM). Roland's control guide says MIDI Start (FA) starts all tracks and tempo cannot be switched during recording. These semantics mean F8 rate can establish tempo, while FA denotes a transport start event; relative F8 pulse phase alone is not a downbeat.

Sources: [MIDI 1.0 message summary](https://midi.org/summary-of-midi-1-0-messages), [RC-505mkII Parameter Guide v1.3](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf), [RC-505mkII MIDI control guide](https://static.roland.com/assets/media/pdf/RC-505mk2_eng01_W.pdf).

## Implemented

- The selected source's one-byte FA is now observed separately from F8. FA resets relative F8 phase acquisition, matching a new transport start.
- On FA, the controller samples the current AudioContext clock and asks the existing guarded performance-time mapper for a frame estimate. UI labels it read-only and diagnostic-only; if no valid running context/anchor exists, the frame estimate remains unavailable.
- Source switch/disconnect and any AudioContext state transition clear the candidate FA frame and relative phase. The candidate also expires after one second without another selected-source FA/F8 event. Unselected source messages remain ignored.
- Unit coverage verifies selected-source filtering, exact FA mapping, phase reset, AudioContext interruption invalidation, and disconnect clearing. E2E coverage exercises synthetic FA+F8 messages while asserting Transport tempo/state/master-phase revision do not change.

## Why this does not drive audio/recording yet

The existing audio-frame capture scheduler is owned by the Browser loop-synchronized master track. `Transport.establishMasterPhaseOrigin()` rejects any track other than its selected master and requires an existing master loop length. `TrackAudio` also guards quantized REC reservations by master identity, LOOP SYNC state, capture readiness, and a phase revision. Reusing that phase field for an external FA origin would conflate the loop master with external transport, and changing BPM while recording conflicts with Roland's documented behavior.

The current MIDI→audio mapper is a diagnostic affine projection from Web MIDI `timeStamp` to sampled `AudioContext.currentTime`; its 250 ms UI polling cadence and available anchor precision have not been validated for sample-accurate REC scheduling. The UI projection proves only that a timestamp can be estimated on the current context timeline. It is not an acknowledged worklet start frame, a capture reservation, playback synchronization, or hardware-latency result.

Safe live integration still needs a separate external transport owner with explicit enable/disable, exact source/context generation ownership, context interruption and source-loss invalidation wired to any outstanding capture reservations, a timestamp mapping accuracy bound justified for the target browser/audio clock, and AudioWorklet frame acknowledgements for start/stop. Until then all Transport/recording side effects remain prohibited and default-off.

## Verification

Passed in this worktree:

- `vitest run tests/unit/midiClockInputController.spec.ts tests/unit/midiAudioFrameMapper.spec.ts` — 20 tests passed.
- `playwright test tests/e2e/browser-midi-clock-monitor.spec.ts` — 2 tests passed, including the assertion that FA+F8 leaves Transport unchanged.
- `vue-tsc -b` — passed.

The E2E uses synthetic Web MIDI messages in Chromium. It verifies UI and non-mutation boundaries, not real device timing or sample-accurate frame synchronization.
