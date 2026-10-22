# Browser official voice controls

Source: BOSS RC-505mkII Parameter Guide, revision 04, firmware 1.3 and later, pages 36–38:
https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf

The controls and documented defaults below follow the extracted, visually verified table in `src/audio/fx/official/parameter-guide.json`. The algorithms, coefficient curves, equal-tempered pitch convention, oscillator implementations and quality limits are clean-room software choices. They do **not** establish Roland topology, factory timbre or perceptual equivalence.

## Additive API and routing

Each helper has `setOfficialParameters` accepting the numeric runtime values below. Existing `setParameters` and legacy parameter domains remain unchanged. An empty/all-undefined update is a no-op; the first nonempty official edit activates documented defaults. Every update is validated in full before mutation, including integer-step checks. Unknown fields and unsupported carrier-routing controls throw. Replaying unchanged official values preserves oscillator phase and envelope state.

The host initializes the supported official defaults, applies legacy parameters first and replays the official overlay last. BALANCE belongs to the host wet/dry path, not a second mix in these wet DSP helpers. The standalone OSC BOT `mix` remains its legacy API; the host supplies wet-only mixing to avoid applying BALANCE twice.

### ELECTRIC: BrowserElectricDsp

- SHIFT: integer −12…12, default 0; equal-tempered semitone transpose after scale selection.
- FORMANT: integer −50…50, default 0; preserves the carrier's F0 while moving resynthesis filter centers by 2^(FORMANT/50). Analysis centers remain fixed, moving the spectral envelope rather than relabeling oscillator pitch.
- SPEED: integer 0…10, default 5; pitch-correction time constant 0.2 × 0.005^(SPEED/10) seconds. Higher values correct faster; this curve is authored, not measured hardware behavior.
- STABILITY: integer −10…10, default 0; note-selection hysteresis 0…0.9 semitones. A candidate must improve distance to measured F0 by more than this margin before replacing the held note.
- SCALE: runtime 0 is CHROMATIC; runtime 1…12 is C…B major, with the same pitch classes as each relative minor. Nearest-note selection uses those actual pitch classes. Interior enharmonic labels are software display conventions, not a claim about undocumented hardware spelling.

The official mode is a dedicated pitch-correction/resynthesis path. It uses the existing decimated YIN voiced F0 tracker, an anti-aliased saw carrier and the shared channel vocoder. It does not reinterpret the provisional four-character bank as the official controls. The existing detector is intended for monophonic input around 55–1000 Hz; unaccepted/unvoiced material follows the existing host dry fallback. This is not polyphonic pitch correction.

### OSC VOC (M): BrowserOscVocCore

- CARRIER: runtime 0…4 = SAW, VINTAGE SAW, DETUNE SAW, SQUARE, RECT; default 0.
- TONE: integer −50…50, default 0; actual filterbank spectral tilt.
- ATTACK: integer 0…100, default 50; changes both MIDI voice attack and modulator band-envelope attack.
- OCTAVE: ordinal 0/1/2/3 = −2/−1/0/+1 octaves; documented default 0 octaves encodes as ordinal 2. Legacy `octave` continues to use semitones independently.
- MOD SENS: integer −50…50, default 0; gain into the analysis bank, not wet gain.
- RELEASE: integer 0…100, default 50; changes both MIDI note-off voice release and band-envelope release.

The existing bounded sample-frame MIDI scheduler, channel filtering, last-note priority, panic and block invariance remain intact. No MIDI note means no oscillator voice; the envelope cannot create a note by itself.

### OSC BOT: BrowserOscBotCore

- OSC: the same five oscillator choices, runtime 0…4, default 0.
- TONE, ATTACK, MOD SENS: same domains and defaults as OSC VOC (M).
- NOTE: software MIDI numbers 24…127, with C4 = MIDI 60. C1 = 24, C2/default = 36, G9 = 127. The note drives a real fixed-pitch oscillator, not the old per-band pattern bank. The published octave labels do not establish the hardware's MIDI-number convention.

The official mode does not inherit provisional legacy arpeggio patterns. NOTE may change without resetting oscillator phase. Oscillators are Nyquist-protected at 0.44 × sample rate, so extreme notes at low sample rates cannot retain their nominal frequency. This limitation is explicit rather than allowing aliasing or unstable coefficients.

### VOCODER: BrowserVocoderCore

Supported official controls are TONE (−50…50/default 0), ATTACK (0…100/default 50), and MOD SENS (−50…50/default 0), plus BALANCE in the host.

CARRIER's eleven physical input/track choices and CARRIER THRU remain **unsupported** because the Browser graph has no independent selected carrier bus. Neither an internal oscillator nor the modulator itself is represented as MIC1/2, INST1/2-L/R, or TRACK1…5. Existing legacy internal-carrier modes remain clearly separate. In particular, an empty selected track cannot honestly be emulated by an always-running internal oscillator.

VOCODER has no official FORMANT or RELEASE row in this manual. The reusable filterbank shaping method includes those internal operations only because ELECTRIC and OSC VOC (M) need them; the VOCODER official entry point rejects those keys.

## Shared audio laws

- SAW is a polyBLEP saw. VINTAGE SAW combines a rounded saw and fundamental with a different harmonic ratio. DETUNE SAW has three independent saw phases, center and ±7 cents. SQUARE is a 50%-duty polyBLEP pulse; RECT is a DC-corrected 25%-duty polyBLEP pulse. All five have genuinely different spectra, not aliases or enum-only changes.
- TONE applies up to ±6 dB/octave around 1 kHz, capped at ±18 dB per band. It weights the resynthesized bands and changes spectral balance.
- MOD SENS maps to ±18 dB before analysis, affecting the detected band envelopes.
- ATTACK is 0.25 ms × 256^(value/100): 0.25…64 ms, with 4 ms at default 50.
- RELEASE is 5 ms × 144^(value/100): 5…720 ms, with 60 ms at default 50.
- Analysis/carrier filters, envelope arrays, oscillator state and scheduler storage are allocated before rendering. The sample paths create no audio buffers, arrays or parameter objects. Reset preserves parameter settings but clears signal histories.

## Verification

`tests/unit/browser-official-voice-controls.spec.ts` covers all integer values and enum values, boundaries, invalid/NaN/fractional rejection, atomic updates, documented defaults, unchanged-value replay, all five carrier spectra, all official audio controls, real pitch/scale/hysteresis/formant behavior, absent carrier routing, finite hostile-input handling, deterministic reset and runtime allocation traps. Existing ELECTRIC, VOCODER, OSC VOC and OSC BOT suites remain regression tests for their unchanged legacy paths.
