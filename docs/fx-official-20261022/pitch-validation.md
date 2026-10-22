# Browser dedicated pitch-control validation

Date: 2026-10-22. Scope: seven Browser adapters and their dedicated pitch/analyzer DSP. This is a functional clean-room parameter interface, not a claim of Roland firmware, algorithm, transfer-curve, latency, preset, or sound equivalence.

## Coverage

26 functional official controls are declared in `src/audio/fx/dsp/OfficialPitchParameters.ts`:

- TRANSPOSE: TRANS (-12..12 semitones).
- PITCH BEND: PITCH (-3..4 octaves), BEND (0..100). Target is PITCH × 12 × BEND/100 semitones, an absolute bend position, not the legacy timed-sweep parameter. Only explicitly opted-in live nodes accept -36..48 semitones; existing live/offline pitch APIs retain their previous bounds.
- ROBOT: NOTE (pitch class 0..11) and FORMANT. NOTE selects a fixed MIDI 60+class target (C4..B4), not source-relative semitone transposition. This reference octave is authored: the manual specifies C..B but does not specify an octave.
- HRM MANUAL: VOICE, FORMANT, PAN, KEY, D.LEVEL, HRM LEVEL. A monophonic pitch analyzer drives one diatonic voice. Signed third/fourth/fifth/sixth choices follow the selected key's major-scale degrees; relative minor labels share the same notes. OCT choices are exact ±12 semitones. UNISON uses authored +0.08-semitone detuning. Legacy two fixed-interval voices remain unchanged when the official path is not enabled.
- HRM AUTO (M): VOICE, FORMANT, PAN, HRM MODE, KEY, D.LEVEL, HRM LEVEL. AUTO selects tones from received MIDI pitch classes. LOW/HIGH select the closest lower/higher chord tone, LOWER/HIGHER the next tone. HYBRID intersects these tones with KEY, with a key-scale fallback when disjoint. These are explicit clean-room voicing rules, not proprietary Roland chord detection. No MIDI notes means no generated harmony.
- OCTAVE: OCTAVE selects -12, -24, or both independent pitch voices; OCT.LEVEL controls their additive level without attenuating dry audio.
- AUTO RIFF: TEMPO, HOLD, ATTACK, LOOP, KEY, BALANCE. TEMPO's authored manual curve is 2 × 0.025^(value/100) seconds per step; documented negative-beat selections follow current BPM. HOLD captures bounded periodic stereo source audio so wet audio persists after input silence. ATTACK adds a 30-ms-decay loudness accent at phrase starts, not a rise-time control. LOOP repeats the existing authored eight-step phrase. KEY uses major-scale intervals relative to a nearby tonic. BALANCE controls latency-aligned wet/dry gain; hold/attack do not process the dry branch.

FORMANT's shared authored law is official value × 12/50 semitones of spectral-envelope shift, with Signalsmith pitch compensation enabled. PAN maps -50..50 to -1..1. Direct/harmony levels map 0..100 to independent linear gains. These control laws are functional approximations, not measured hardware laws.

## Explicitly unsupported

Five official control rows are not advertised as implemented:

- MODE 1/2 for TRANSPOSE, PITCH BEND, ROBOT and OCTAVE: these select unpublished previous/new Roland algorithms. Signalsmith or the YIN/PSOLA clean-room combination is not silently relabelled MODE 1 or MODE 2.
- AUTO RIFF PHRASE P1..P30: the guide does not publish their note/rhythm contents. No authored pattern is passed off as P1 or another official phrase.

Direct attempts to set these controls fail closed, including controls set before asynchronous initialization finishes. Unsupported selections cannot silently recover merely because another valid parameter is set.

## Verification

The current focused regression command passes **18 test files, 184 tests**, including 46 new official-control, snapshot and default-initialization tests. `vue-tsc` and `git diff --check` also pass. The earlier concurrent integration failures (unsolicited BPM forwarding to non-tempo adapters and an obsolete legacy-only catalog assertion) have been fixed in the integrating host/tests.

All seven adapters retain accepted official control identities in their scalar snapshots, after legacy fields. JSON restore must apply these entries in legacy-then-official order, so official controls are authoritative where units overlap. A first valid official setter initializes all supported, encodable published defaults once, then applies the requested value; unsupported MODE/PHRASE and unknown defaults are excluded. For example, the default manual harmony is +3RD and the default bend range is +4OCT. Later official edits do not reset previously selected values. The five direct `setAmount` adapters replay their official overlay after the legacy macro; AUTO RIFF also snapshots its BPM. Direct legacy setters retain their existing behavior, so hosts mixing legacy edits with an active official overlay must reapply the overlay as the shared chain/engine now does.

Seven roundtrip cases compare effective worklet configure state, direct/wet/voice gains, pan and pitch scheduling after fresh-node recreation and identical detector events. They do not serialize live detector, held-MIDI, delay, waveform or DSP history. Seven additional cases verify the exact published defaults and non-resetting later edits; five verify direct macro precedence.

```sh
npx vitest run tests/unit/official-pitch-controls.spec.ts tests/unit/official-pitch-extended-range.spec.ts tests/unit/official-auto-riff-controls.spec.ts tests/unit/browser-per-track-fx.spec.ts tests/unit/browser-transpose-fx.spec.ts tests/unit/browser-pitch-bend-fx.spec.ts tests/unit/browser-robot-fx.spec.ts tests/unit/browser-robot-dsp.spec.ts tests/unit/browser-robot-worklet.spec.ts tests/unit/browser-manual-harmonist-fx.spec.ts tests/unit/browser-octave-fx.spec.ts tests/unit/browser-hrm-auto-fx.spec.ts tests/unit/browser-hrm-auto-dsp.spec.ts tests/unit/browser-hrm-auto-worklet.spec.ts tests/unit/pitch-stretch.spec.ts tests/unit/browser-auto-riff-dsp.spec.ts tests/unit/auto-riff-parameters.spec.ts tests/unit/signalsmith-formant-schedule.spec.ts
npx vue-tsc -b --pretty false
git diff --check
```

Evidence includes real DSP/worklet MIDI/scale targets, variable-block processing, wet HOLD audio continuing during input silence, ATTACK envelope changes, adapter pan/gain/pitch scheduling, unsupported-control rejection and unchanged legacy routing. The four extended-range tests additionally use the actual Signalsmith WASM at the 24-ms live configuration to verify finite, non-silent -36/+48-semitone target-frequency output and FORMANT spectral-envelope movement. Mocked host-graph tests are not presented as physical audio-device validation.

No hardware A/B listening, microphone/device test, performance admission for maximum concurrent voices, or hardware MODE/preset equivalence is claimed. Mono-F0 analysis does not support polyphonic source tracking. Adapter scalar snapshot recovery is tested; no new hardware Memory functionality, FX project-archive persistence, or MIDI CC/ASSIGN compatibility is promised by this work. No push or deployment was performed by the pitch worker.
