# Official Display Matrix

Status: **PARTIAL**. The table below records what official Roland/BOSS sources establish about screens and indicators, with unconfirmed details retained as UNKNOWN. No physical hardware observation has been performed.

## Play Screen variations

The Owner’s Manual p. 8 numbers the seven Play Screen variations. The order below follows those diagram numbers; the manual says left/right arrows switch variations but does not define a forward direction or wrap behavior.

| Diagram number | Screen | Evidence | Status |
|---:|---|---|---|
| 1 | MEMORY NUMBER | Owner’s Manual p. 8 | OFFICIAL_CONFIRMED |
| 2 | TRACK STATUS | Owner’s Manual p. 8 | OFFICIAL_CONFIRMED |
| 3 | LOOP TRACKS | Owner’s Manual p. 8 | OFFICIAL_CONFIRMED |
| 4 | LOOP STATUS | Owner’s Manual p. 8 | OFFICIAL_CONFIRMED |
| 5 | LOOP LEVEL | Owner’s Manual p. 8 | OFFICIAL_CONFIRMED |
| 6 | INPUT FX | Owner’s Manual p. 8 | OFFICIAL_CONFIRMED |
| 7 | TRACK FX | Owner’s Manual p. 8 | OFFICIAL_CONFIRMED |

**UNKNOWN:** Whether the physical unit treats right as next/forward, whether navigation wraps, and whether there are any version-specific variations beyond the seven shown.

## FX Play layout (visual review 2026-11-14)

Owner’s Manual p. 8 visually confirms that INPUT FX and TRACK FX display four horizontal effect-type blocks, corresponding left-to-right to A–D. The explicit ON/OFF callouts on the INPUT FX diagram identify inverse/light-background blocks as ON and ordinary/dark-background blocks as OFF. This is a status display, not four rows of software READY/ACK diagnostics. Long abbreviations can occupy two lines *within* a column.

The common header contains Memory identity and tempo; unmodeled lock/phantom indicators must not be invented. `TRACK FX-A` is legible in the diagram, but the meaning of that trailing letter remains UNKNOWN here: BANK and FX TARGET are distinct parameters, and the diagram alone does not resolve this.

Parameter Guide pp. 30–33 defines configurable Play-screen KNOB FUNC assignments. Its printed defaults are 1=MEMORY, 2/3=OFF (p. 30), 4=MFX REVERB (p. 33). Four FX columns do not establish a one-column/one-encoder editing contract. Unsupported assignments must remain unavailable; ENTER still opens MIXER, not a software FX shortcut.

Sources: [Owner p. 8](https://static.roland.com/assets/media/pdf/RC-505mk2_eng02_W.pdf#page=8), [Parameter Guide p. 30](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf#page=30). Evidence class: OFFICIAL_CONFIRMED for structure, ON/OFF and configurable knobs; UNKNOWN for the Play suffix. No physical observation.

## MIXER pages

Current Owner’s Manual eng04 p. 8 shows four MIXER groups and says arrows switch pages. ENTER from Play opens MIXER. This supersedes the older eng02 three-group diagram; see [versioned visual review](lcd-layout-matrix-20261114.md).

| Page | Channel groups shown | Evidence | Status |
|---:|---|---|---|
| 1 | MIC1 / MIC2 / INST1 / INST2 IN | Owner’s Manual p. 8 | OFFICIAL_CONFIRMED |
| 2 | TRACK1 / TRACK2 / TRACK3 / TRACK4 | Owner eng04 p. 8 | OFFICIAL_CONFIRMED |
| 3 | MAIN / SUB1 / SUB2 / LOOP OUT | Owner eng04 p. 8 | OFFICIAL_CONFIRMED |
| 4 | RHYTHM / PHONES / MASTER OUT | Owner eng04 p. 8 | OFFICIAL_CONFIRMED |

The manual says turning knobs changes levels and pushing input knobs mutes. Stereo-link settings can change which channels appear. Exact return behavior from each MIXER page is not fully diagrammed; see the control matrix.

## Track and FX indicators

| Indicator | Official meaning | Evidence | Status |
|---|---|---|---|
| Track button lit/unlit | A lit track button means a phrase exists; unlit means no phrase. Current-track identity is a separate display indication. | Owner’s Manual pp. 5, 8 | OFFICIAL_CONFIRMED |
| REC/PLAY/DUB/STOP | Default REC red, PLAY green, DUB yellow in the Owner’s Manual; Parameter Guide v1.3 calls the default DUB color amber. STOP is unlit. Colors are configurable. | Owner’s Manual p. 5; Parameter Guide v1.3 p. 33 | OFFICIAL_CONFIRMED |
| AUTO REC standby | REC/PLAY rapidly blinks before recording starts on detected input; blink color is unspecified. | Parameter Guide v1.3 p. 4 | OFFICIAL_CONFIRMED / color UNKNOWN |
| Fade/loop stop pending | REC/PLAY blinks until playback stops in STOP MODE FADE/LOOP; blink color and exact cadence are unspecified. | Parameter Guide v1.3 p. 2 | OFFICIAL_CONFIRMED / color UNKNOWN |
| Undo/redo state | REC/PLAY green indicates undo available, red indicates redo available, off indicates neither. | Owner’s Manual p. 9 | OFFICIAL_CONFIRMED |
| FX A–D | Red means effect on; pink marks the current operable/editable effect while on; unlit means off. Pink is not explicitly documented as meaning the editor screen is open. Selected bank is blue in bank selection. | Owner’s Manual pp. 4–5 | OFFICIAL_CONFIRMED |
| Loop Indicator modes | STATUS, LOOP POSITION, LEVEL. The guide’s table names no-phrase/stopped, phrase/stopped, recording, overdubbing, and playback, and includes unlit/lit/blink, tempo, loop-position, and playback-level indications. The text extraction does not preserve the exact pictogram-to-state mapping. | Parameter Guide v1.3 p. 30 | Modes and described concepts OFFICIAL_CONFIRMED; detailed patterns UNKNOWN |

## Official sources

- Roland, *RC-505mkII Owner’s Manual*, English, https://static.roland.com/assets/media/pdf/RC-505mk2_eng02_W.pdf
- Roland, *RC-505mkII Parameter Guide*, English, Version 1.3, https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf
- BOSS, *RC-505mkII Loop Station* product page, https://www.boss.info/global/products/rc-505mk2/
- BOSS official top-panel photo, https://static.roland.com/products/rc-505mkii/images/rc-505mkii_top_gal.jpg
