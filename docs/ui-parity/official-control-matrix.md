# Official Control Matrix

Status: **PARTIAL**. This document records official-source evidence for Classic UI parity and explicitly retains unresolved hardware details. No physical RC-505mkII observation has been performed in this task, and no hardware behavior is marked verified by observation.

## Evidence labels

- **OFFICIAL_CONFIRMED** — directly stated or shown in an official Roland/BOSS manual or product source.
- **HARDWARE_OBSERVED** — personally verified on a physical RC-505mkII. None recorded.
- **INFERRED** — reasonable implementation interpretation, not explicit official wording.
- **UNKNOWN** — the cited official sources do not establish the behavior.

## Controls and navigation

| Control / behavior | Evidence and source | Status | Parity implication / limit |
|---|---|---|---|
| MENU opens the system menu | Owner’s Manual p. 4; menu hierarchy and categories p. 17 | OFFICIAL_CONFIRMED | Menu root exists. Exact behavior when MENU is pressed from every sub-screen is not fully specified. |
| MENU categories | Owner’s Manual p. 17: INPUT, OUTPUT, MIXER, CTL FUNC, ASSIGN, USB, MIDI, SETUP, FACTORY RESET | OFFICIAL_CONFIRMED | Category names are sourced; full nested contents are outside this matrix. |
| LOOP opens memory editing | Owner’s Manual pp. 4, 13 | OFFICIAL_CONFIRMED | LOOP is the memory-edit entry point described by the manual. |
| LOOP edit categories | Owner’s Manual p. 13: TRACK, REC, PLAY, INPUT FX, TRACK FX, RHYTHM, NAME | OFFICIAL_CONFIRMED | Category labels are sourced. Knob push selects an item; arrows move among parameter pages; EXIT is used to return to Play. |
| ENTER confirms; ENTER from Play opens MIXER | Owner’s Manual p. 4 | OFFICIAL_CONFIRMED | The direct Play-to-MIXER transition is explicit. Other ENTER destinations depend on the current UI item. |
| EXIT returns to the previous screen | Owner’s Manual p. 4 | OFFICIAL_CONFIRMED | General rule is explicit. The manual does not enumerate a complete return-edge graph for every possible entry route and nested state. |
| Repeated EXIT returns to Play from MENU and LOOP editing | Owner’s Manual pp. 13, 17–18 | OFFICIAL_CONFIRMED | These procedures explicitly say to press EXIT repeatedly to return to Play. Exact number of presses and behavior from every intermediate screen remain unspecified. |
| Cursor and parameter navigation | Owner’s Manual p. 4; LOOP and MENU procedures pp. 13, 17–18 | OFFICIAL_CONFIRMED | K/J arrows move the cursor or pages as described. Turning knobs changes values; holding a knob while turning makes larger changes. |
| Encoder/knob press | Owner’s Manual pp. 4, 13, 17–18 | OFFICIAL_CONFIRMED | Push is used to select/enter in the documented MENU/LOOP procedures, and some parameters require push-to-edit. No universal encoder-press action or generic “change screen number” behavior is documented. |
| MIXER page navigation and controls | Owner’s Manual p. 8 | OFFICIAL_CONFIRMED | ENTER from Play opens MIXER; arrows switch its three pages; turning knobs changes levels; pushing input knobs mutes. Stereo-link settings can change which channels are shown. |
| Play-screen variation navigation | Owner’s Manual p. 8, numbered Play Screen diagram | OFFICIAL_CONFIRMED | Diagram numbers seven variations; left/right arrows switch variations. The diagram establishes displayed order. It does not specify which arrow is “next” or whether navigation wraps. |
| Track lamp means phrase exists | Owner’s Manual p. 5; current-track marker is separately shown on p. 8 | OFFICIAL_CONFIRMED | Lit/unlit phrase-exists state must not be conflated with which track is currently selected. |
| STOP held for at least 2 seconds clears a track | Owner’s Manual p. 5 | OFFICIAL_CONFIRMED | The manual explicitly gives a 2-second hold. |
| REC/PLAY/DUB/STOP default LED colors | Owner’s Manual p. 5; Parameter Guide v1.3 p. 33 | OFFICIAL_CONFIRMED | Owner’s Manual describes REC red, PLAY green, DUB yellow, STOP unlit. Parameter Guide names the default DUB color AMBER and allows configurable colors. Preserve the source terminology discrepancy rather than silently equating it. |
| Configurable track-button LED colors | Parameter Guide v1.3 p. 33 | OFFICIAL_CONFIRMED | Available colors are OFF, RED, GREEN, AMBER, BLUE, PURPLE, CYAN, WHITE. Default role colors include REC red, PLAY green, DUB amber, STOP off, and BLANK/no phrase off. |
| AUTO REC standby indication | Parameter Guide v1.3 p. 4 | OFFICIAL_CONFIRMED | With AUTO REC on, pressing REC/PLAY makes the button blink rapidly; when performance input begins, it lights and recording starts. Standby blink color and exact blink cadence are not specified. Classic Browser renders red at a 500ms period as an explicitly labeled engineering approximation, and only while `autoRecArmed` is true. |
| Delayed stop indication | Parameter Guide v1.3 p. 2 | OFFICIAL_CONFIRMED | In STOP MODE FADE/LOOP, REC/PLAY blinks until playback stops; another STOP stops immediately. Blink color/pattern details are unspecified. |
| Quantized recording completion indication | Parameter Guide v1.3 p. 4 | UNKNOWN | QUANTIZE can align recording completion to a measure, but the cited parameter description does not specify a distinct REC/PLAY LED color or pattern while waiting for that completion. |
| Undo/redo secondary control layer | Owner’s Manual pp. 5, 9 | OFFICIAL_CONFIRMED | When UNDO/REDO is lit: FX = MARK CLEAR, TRACK = MARK SET, STOP = MARK BACK, REC/PLAY = UNDO/REDO. In this mode REC/PLAY green means undo available, red means redo available, off means neither. |
| FX A–D slot layout and bank selection | Owner’s Manual pp. 4–5; Parameter Guide v1.3 pp. 5–6; official BOSS product page | OFFICIAL_CONFIRMED | Four banks A–D each expose four effect slots A–D; each slot is assigned an Input FX or Track FX type and settings within a memory. A–D presses control their assigned effects according to TOGGLE or MOMENT mode. Holding EDIT while pressing a slot opens that slot’s editor. Holding EDIT enters bank selection; the selected bank is blue. Exact assignments vary by memory; no long-hold duration is specified. |
| FX slot lamp state | Owner’s Manual pp. 4–5 | OFFICIAL_CONFIRMED | Red means the effect is on; pink identifies the currently operable/editable effect while on; unlit means off. Pink is documented as an operable/editable-slot indication; the manual does not say it means the edit screen is open. Per-track FX buttons lit/unlit indicate application of that track’s effect. |
| FX switch action mode | Parameter Guide v1.3 pp. 5–6 | OFFICIAL_CONFIRMED | Slot switches can be configured as TOGGLE or MOMENT. |
| Loop Indicator modes | Parameter Guide v1.3 p. 30 | OFFICIAL_CONFIRMED | Modes are STATUS, LOOP POSITION, and LEVEL. The guide’s table identifies no-phrase/stopped, phrase/stopped, recording, overdubbing, and playback states, and shows unlit/lit/blink, tempo, loop-position, and playback-level indications. |
| Exact Loop Indicator LED patterns | Parameter Guide v1.3 p. 30 | UNKNOWN | The text extraction does not preserve the table’s per-state pictogram mapping clearly enough to assign every LED pattern. Keep detailed status-to-pattern assignments unresolved unless the official figure is visually decoded or hardware is observed. |
| Return destinations from every MENU/MIXER/LOOP-edit substate | Owner’s Manual pp. 4, 13, 17–18 | UNKNOWN | “EXIT returns to the previous screen” and repeated EXIT-to-Play are documented, but a complete state-by-state return graph is not. |
| FX EDIT long-hold threshold | Owner’s Manual pp. 4–5 | UNKNOWN | “Press and hold EDIT” is stated without a duration. A 1500 ms UI threshold is an engineering choice, not official hardware evidence. |

## Explicit UI decisions (not hardware evidence)

| Decision | Classification | Note |
|---|---|---|
| Right arrow advances through the seven Play variations and wraps after TRACK FX | INFERRED / user specification | Official p. 8 gives the seven numbered screens and says arrows switch variations, but does not define forward direction or wrap. |
| FX EDIT long press threshold = 1500 ms | INFERRED / engineering choice | No official duration was found. |
| STOP clear hold threshold = 2000 ms | OFFICIAL_CONFIRMED | Matches the Owner’s Manual p. 5 “2 seconds” instruction. |
| AUTO REC armed LED styling = red, 500ms period | ENGINEERING_APPROXIMATION | Official Parameter Guide p. 4 confirms rapid blinking while armed, but does not specify color or cadence. This approximation is scoped to an explicit AutoRec-armed state, not generic quantized REC_STANDBY. |

## Official sources

1. Roland, *RC-505mkII Owner’s Manual*, English, https://static.roland.com/assets/media/pdf/RC-505mk2_eng02_W.pdf
2. Roland, *RC-505mkII Parameter Guide*, English, Version 1.3, https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf
3. BOSS, *RC-505mkII Loop Station* product page, https://www.boss.info/global/products/rc-505mk2/
4. BOSS official top-panel photo, https://static.roland.com/products/rc-505mkii/images/rc-505mkii_top_gal.jpg
