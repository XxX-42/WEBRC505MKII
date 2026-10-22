# RC-505mkII Classic UI parity

Overall: **PARTIAL**. A shared display/control layer now drives Browser and Native. This does not certify complete hardware emulation, physical audio loopback, or measured LED color.

## Baseline

- Remote main: `c4adc8970375873f28c6f137ea1369131d92aef4`.
- Integration base: `feat/official-fx-parameters-20261022`, `2dae0145e0645038a21d5196dfc782d5e9bd8a04`.
- Feature branch: `codex/rc505-classic-ui-parity-20261022`; isolated worktree, original local materials preserved.
- No DSP, audio callback, PCM, WAV renderer, or Native protocol changes. Audio-engine additions expose existing read-only phrase/FX state.

Sources: [control matrix](official-control-matrix.md), [display matrix](official-display-matrix.md), [classified evidence](official-evidence.json), [Owner’s Manual](https://static.roland.com/assets/media/pdf/RC-505mk2_eng02_W.pdf), [Parameter Guide](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf). No physical hardware observations were recorded. See [validation receipt](validation.json) for actual run counts.

## Dashboard

PASS means the stated software behavior is tested against cited semantics. It does not certify unsupported hardware functions or physical appearance.

| Domain | Status | Evidence + code + tests / limits |
|---|---|---|
| Physical layout | PARTIAL | [Official top view](https://static.roland.com/products/rc-505mkii/images/rc-505mkii_top_gal.jpg), [faceplate](../../src/components/panel/Rc505Face.vue), [viewport scenarios](../../tests/e2e/rc505-classic-parity.spec.ts). Existing 1520×846 geometry retained; ≤4px/≤5% measurement not performed. |
| REC/PLAY LEDs | PARTIAL | [Control matrix](official-control-matrix.md), [resolver](../../src/ui/rc505/Rc505ControlStateResolver.ts), [unit](../../tests/unit/rc505-control-resolver.spec.ts), [virtual-input transitions](../../tests/e2e/rc505-classic-parity.spec.ts). Red/green/yellow/off implemented. Official AUTO REC standby and delayed-stop blinking are not rendered; color/cadence and quantized-finish indication remain unresolved. |
| TRACK LED | PASS | [Phrase meaning](official-control-matrix.md), [resolver](../../src/ui/rc505/Rc505ControlStateResolver.ts), [unit](../../tests/unit/rc505-control-resolver.spec.ts), [phrase assertions](../../tests/e2e/rc505-classic-parity.spec.ts). Committed phrase differs from selection; unknown phrase does not light. Color is an engineering approximation. |
| Track FX LED | PARTIAL | [Control matrix](official-control-matrix.md), [resolver](../../src/ui/rc505/Rc505ControlStateResolver.ts), [unit](../../tests/unit/rc505-control-resolver.spec.ts). Editor cannot light lamp. Missing shared per-track gate means disabled control; private FX stays in Enhanced. |
| FX A–D | PARTIAL | [Control matrix](official-control-matrix.md), [state machine](../../src/ui/rc505/Rc505FxControlStateMachine.ts), [controls](../../src/components/panel/FxBankControls.vue), [unit](../../tests/unit/rc505-fx-control-layer.spec.ts), [browser](../../tests/e2e/rc505-classic-parity.spec.ts). TOGGLE mode implemented: ordinary press toggles only; EDIT/chord edits without toggling. Official MOMENT mode is not modeled. |
| FX Bank | PASS | [Control matrix](official-control-matrix.md), [store](../../src/ui/rc505/Rc505FxBankStore.ts), [ACK reconciliation](../../src/composables/useRc505FxBanks.ts), [failure tests](../../tests/unit/rc505-fx-bank.spec.ts), [browser](../../tests/e2e/rc505-classic-parity.spec.ts), [regular Native smoke](local-native-smoke.json). Four banks/group are a versioned software sidecar; blue only after four slots match. |
| UNDO layer | PARTIAL | [Control matrix](official-control-matrix.md), [resolver](../../src/ui/rc505/Rc505ControlStateResolver.ts), [strip](../../src/components/panel/TrackStrip.vue), [unit](../../tests/unit/rc505-control-resolver.spec.ts), [browser](../../tests/e2e/rc505-classic-parity.spec.ts). Secondary layer and Undo green/Redo red implemented. Mark disabled; global Undo lamp color unknown. |
| STOP/CLEAR | PASS | [Official ≥2 seconds](official-control-matrix.md), [controller](../../src/composables/useTrackStripState.ts), [timing/cancellation tests](../../tests/unit/useTrackStripState-stop.spec.ts), [browser](../../tests/e2e/rc505-classic-parity.spec.ts). 1999ms does not clear; 2000ms does; long release does not also stop. |
| Seven Play Screens | PASS | [Owner p8 / matrix](official-display-matrix.md), [state machine](../../src/ui/rc505/Rc505DisplayStateMachine.ts), [renderer](../../src/components/panel/CenterMainPanel.vue), [unit](../../tests/unit/rc505-display-state-machine.spec.ts), [browser](../../tests/e2e/rc505-classic-parity.spec.ts). Direction and wrap are user-specified. Unmodeled memory/level fields are unavailable. |
| MIXER | PARTIAL | [Three pages](official-display-matrix.md), [renderer](../../src/components/panel/CenterMainPanel.vue), [unit](../../tests/unit/rc505-display-state-machine.spec.ts), [browser](../../tests/e2e/rc505-classic-parity.spec.ts). Only real RHYTHM and MASTER APIs bound; MAIN not aliased to MASTER. |
| LOOP Edit | PARTIAL | [Categories](official-display-matrix.md), [types](../../src/ui/rc505/rc505DisplayTypes.ts), [renderer](../../src/components/panel/CenterMainPanel.vue), [unit](../../tests/unit/rc505-display-state-machine.spec.ts), [browser](../../tests/e2e/rc505-classic-parity.spec.ts). TRACK/FX/RHYTHM use existing controllers; REC/PLAY/NAME settings unavailable. |
| MENU | PARTIAL | [Categories](official-display-matrix.md), [types](../../src/ui/rc505/rc505DisplayTypes.ts), [unit](../../tests/unit/rc505-display-state-machine.spec.ts), [browser](../../tests/e2e/rc505-classic-parity.spec.ts). Nine hardware categories, one CTL FUNC item; unsupported settings show reasons. |
| Encoder Push | PASS | [Encoder actions](official-control-matrix.md), [primitive](../../src/components/ui/HardwareKnob.vue), [detents](../../src/ui/rc505/Rc505EncoderFields.ts), [primitive tests](../../tests/unit/hardwareControls.spec.ts), [detent tests](../../tests/unit/rc505-encoder-fields.spec.ts), [browser](../../tests/e2e/rc505-classic-parity.spec.ts). One modification channel/gesture; accessible mappings are engineering choices. |
| Loop Indicator | PARTIAL | [Modes/unknown patterns](official-control-matrix.md), [renderer](../../src/components/LoopHalo.vue), [tests](../../tests/unit/hardwareControls.spec.ts). Classic currently wires STATUS only; no invented LEVEL meter. Old animations remain Enhanced. |
| Classic / Enhanced | PASS | [Display hierarchy](official-display-matrix.md), [field filter](../../src/composables/useDeviceScreenEditor.ts), [Enhanced](../../src/components/EnhancedTools.vue), [unit](../../tests/unit/rc505-enhanced-boundary.spec.ts), [DOM separation](../../tests/e2e/rc505-classic-parity.spec.ts). Software archive/HQ WAV/Pitch/device/diagnostics remain outside Classic LCD. |
| LED photometry | UNMEASURED | No calibrated physical capture. CSS colors are engineering approximations; no official RGB or blink frequency asserted. |

## Interaction defaults and compatibility

- STOP hold: 2000ms (official minimum). FX EDIT hold: 1500ms (user-approved engineering default).
- Encoders: drag rotates; clean click presses; Shift-drag press/rotates; touch hold 350ms then drag; Space plus arrow keys press/rotates. The 4px threshold and 350ms timing are engineering defaults.
- Mechanical press changes displacement/shadow, not LED latch. Selection, logical activation, and LEDs are distinct.
- One display state machine and resolver serve both audio backends. Confirmation has explicit return context; unsupported Native actions stay disabled.
- Legacy four FX slots deep-copy into Bank A; B–D start empty. Requested/applied bank differ until confirmed. Storage corruption/failure disables banks and preserves live rows. Partial apply is neither auto-retried nor falsely shown as the old bank applied.
- Existing archive/IndexedDB/recovery formats are unchanged. Enhanced private FX selection cannot retarget Classic shared FX.
- Enhanced numeric fields keep a local edit draft across runtime polling. A focus session is bound to its actual input and page/track context; late events after navigation are ignored, change/blur commit at most once, and rejected edits return to confirmed values. See [draft regression tests](../../tests/unit/enhanced-number-draft.spec.ts).
- LCD focus follows the display return stack, including bounded-stack eviction. Error scopes keep an unrelated FX-bank error from hiding a rhythm failure; the LCD shows a short message while its title and Enhanced diagnostics retain details. See [error-scope tests](../../tests/unit/rc505-control-errors.spec.ts) and [Native rhythm tests](../../tests/unit/native-rhythm-ui.spec.ts).
- Native Play FX pages and slot LEDs share acknowledged readback. Empty slots remain off even when their bypass value is false. Pending/restart/unknown/error states hide unconfirmed values instead of falling back to the editable request. See [readback selector](../../src/ui/rc505/Rc505FxReadback.ts), [selector tests](../../tests/unit/rc505-fx-readback.spec.ts), and [Native LCD/ACK/LED integration](../../tests/e2e/native-classic-schema-parameters.spec.ts).
- A Native named edit can invalidate ACK before confirmed parameter rows arrive. Bank reconciliation retains the pending bank identity, clears its confirmed light immediately, and restores it only after all four slots match. Pending/rejected writes cannot persist a new profile or restore blue. See [ACK-order regressions](../../tests/unit/rc505-fx-bank.spec.ts).

## Local evidence and screenshots

Final unit run: **2397/2397**, 191 files, zero failures/skips. Type-check and production build passed. The complete browser run passed 103/108; corrective runs were 21/23, an unchanged initial-navigation rerun 1/1, and the final Native/Classic run 8/8. [Latest outcomes](e2e-latest-outcomes.json) record 108/108 unique cases passing across runs, with zero skips. This is explicitly not a single complete green run against final source. [Validation receipt](validation.json) preserves counts, report hashes, and screenshot hashes.

After the final Native LED binding changed to consume the same readback selector as the LCD, affected unit suites passed **34/34** and the expanded Native LED/parameter journey passed **1/1**. The latter uses a 60-second total test budget for cold development-page loading and both banks; individual operation/ACK limits are unchanged. Development-server cold navigation exceeded 30 seconds in a diagnostic run, so startup performance remains a follow-up item.

[Regular WASAPI receipt](local-native-smoke.json): 48kHz/128 frames, five tracks, RHYTHM volume 50→49→50 confirmed by HTTP state, FX EDIT hold and Bank A→empty B→A. This is control/ACK evidence, not recorded-audio or analog-loopback evidence. Automated HQ integration uses a separate no-audio simulation executable. Regular host has simulation OFF and optional HQ renderer unavailable.

Final local UI/host processes were verified to come from this worktree. The regular WASAPI session uses Realtek microphone-array input and VoiceMeeter Aux output; it does not verify RC-505 USB/analog hardware routing. Both 5173 Browser and Native tabs remain available for user testing, with COOP/COEP retained.

Browser acceptance uses virtual input, as requested. Physical recording content, end-to-end latency, and calibrated RC-505 LED observations remain untested. Saved final images are indexed by the validation receipt. Narrow windows retain at least 80% scale with warning/scroll; some lower controls begin below the viewport.

## Remaining gaps

- **P0 backend capability gaps:** Mark, per-track shared FX gate, full hardware Memory, track meters, FX MOMENT mode, and most routing/setup parameters.
- **P1:** perspective-corrected geometry measurement and calibrated LED capture.
- **UNKNOWN HARDWARE BEHAVIOR:** exact standby/finishing color/cadence, detailed Indicator patterns, global Undo lamp color, undocumented navigation/shortcut edges. No invented official values.
