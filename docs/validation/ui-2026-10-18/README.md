# 26_27_WebRC UI integration validation

Baseline: `8f473b34d7bd4561503db707e241351e249c40ac`. Scope: the existing Browser and Native audio implementations, their UI bridges, and a scalable RC-505mkII faceplate. No new DSP algorithms or physical loopback latency measurements are included.

The panel reference is the [BOSS owner manual, pages 4–5](https://static.roland.com/assets/media/pdf/RC-505mk2_eng02_W.pdf), cross-checked against the official product photography. The face uses a fixed 1520×846 coordinate system and real DOM controls. The inventory is 41 buttons, 7 knobs and 5 faders; viewport scaling does not change that inventory.

## Runtime entry points

- Browser: `http://127.0.0.1:4173/?audio=browser&ui=classic`
- Native: `http://127.0.0.1:4173/?audio=native&ui=classic`
- Real regular Native bridge: `http://127.0.0.1:17755/health`

This machine reserves the Windows TCP range containing 5173, and binding that port returns EACCES. The launcher selected 4173 without changing Windows exclusions or terminating unrelated processes. `npm run dev:all -- -SkipBuild` successfully reused the verified project UI and real host. Normal `npm run dev:all` can build the real host with the installed MSVC and Ninja.

## Implemented behavior

- Browser starts with a trusted START AUDIO click, 15-second resume and worklet waits, and a separate 20-second microphone wait. Denial/timeout retains output readiness, exposes CONNECT INPUT, and cleans up late streams.
- Native ordinary requests have 5-second deadlines. A timed-out write performs one bounded status read and never replays the write. The acknowledged state is retained alongside the timeout error.
- REC/PLAY, STOP, all-track transport, output gain where supported, per-track levels where supported, FX and rhythm use existing engine interfaces. Long STOP holds clear after 1500 ms; cancelled presses cancel the timer.
- MENU, LOOP, FX EDIT and RHYTHM EDIT open pages inside the central LCD. The Classic faceplate has no floating editor or drawer. PAGE changes subpages within the selected category; the four screen knobs address the displayed fields. Mouse, touch and keyboard can edit the actual LCD fields. ENTER executes a selected command or focuses its field; EXIT/Escape returns. Errors/pending edits take priority over a success display.
- Track FX controls follow the selected shared or independent track target. The old shared-bank per-track apply flags did not route audio and are explicitly unavailable. Independent A–D catalog chains remain editable through the real target interface.
- Unsupported Undo/Redo, storage actions and Native gain/reverse controls retain explicit disabled semantics and reasons. Tech remains available from Settings; changing the skin keeps the audio engine instance.

## Evidence boundary

Browser capture acceptance uses Chromium's virtual microphone with real AudioContext/AudioWorklet processing, as requested. It does not prove a physical microphone route or hardware latency. This baseline's Browser recorder stores mono loops; this UI change does not add stereo recording DSP.

Native acceptance uses the regular WASAPI host built with `NATIVE_BRIDGE_SIMULATION_ONLY=OFF`, `NATIVE_PORTABLE_TESTS_ONLY=OFF`, and Release mode. ASIO and Native HQ rendering are disabled in this build. The configured local WASAPI endpoints, observed states, frame counts and diagnostic counters are recorded separately. The run establishes functional command and audio-buffer behavior; XRUN-free performance, independently heard playback, RC-505mkII hardware fidelity and physical round-trip latency are not certified.

All 52 pre-existing untracked local research/test files were preserved and matched their external backup SHA-256 manifest. They are excluded from the UI commit.

## Readability correction

The original replica used several 6–9 px faceplate labels even at 100% zoom. Main hardware labels, buttons and track states now use approximately 12 px, LCD session names 14 px and the main value 24 px. Compact LCD secondary fields use 11 px with a two-column, two-row parameter layout and 14 px values. The LCD frame grows 12 px within the available panel gap during editing so the two parameter rows and status row do not overlap. External status text uses 13 px. Long hardware labels wrap within the existing control coordinates. Initial/FIT scaling stops at 80%; smaller windows scroll within the viewport. Manual zoom remains available.

Active/pressed buttons now use a color-filled cap, bright edge and soft static glow, rather than only a dot or inner ring. REC/PLAY/DUB follow the existing engine state in red/green/amber. Enabled Input FX is blue and Track FX pink; a selected but bypassed FX slot has a thin outline rather than the full enabled glow. STOP uses the same held/cancelled state as its long-press handler and lights ice-white for both keyboard and pointer holds. Disabled controls remain dim. This is a visual treatment, not a calibrated measurement of hardware LED colors.

## Physical key routing check

On the running Browser and regular Native pages, pressing each tested track's **FX** key opened `TRACK FX` inside the central LCD; pressing its **TRACK** key opened that track's settings page in the same LCD. The Browser Track 1 and Native Track 2 routes all had zero open drawers or dialogs. The Native FX target selector showed Track 2 selected and all five host-supported loop tracks as choices. This check used editor navigation only; Browser audio remained stopped, and Native Tracks 1 and 2 remained stopped with their recorded loops preserved.

- [Browser Track 1 FX LCD](browser-lcd-fx-final.png)
- [Browser Track 1 settings LCD](browser-lcd-track.png)
- [Native Track 2 FX LCD](native-lcd-fx-final.png)
- [Native Track 2 settings LCD](native-lcd-track-final.png)
- [Physical key routing receipt](lcd-physical-key-route-check.json)

The Browser page is left at `START AUDIO` because this acceptance turn was restricted to virtual input. The separate Playwright capture check supplies Chromium's virtual microphone and exercises recording, playback and overdub through the real Browser audio graph.

## Real Native functional run

[Runtime observations](native-runtime.json) and [the actual faceplate screenshot](native-real.png) document the regular WASAPI run. The selected endpoints were Realtek microphone-array input and VoiceMeeter AUX output at 48 kHz / 128 frames. Track 2 completed record → stop → play → overdub → stop using physical replica controls. Its resulting stereo loop contained 1,221,632 frames. Rhythm start/stop changed the acknowledged Native state. Track 1 and Track 2 remain stopped and preserved.

The observed XRUN counter stayed at 1749 during the short transport/rhythm sequence (delta 0); the nonzero cumulative count and short duration do not establish a sustained realtime pass. The reported 2.667 ms input plus 2.667 ms output latency is a driver estimate, not a measured physical round trip.

The run also exposed an actual UI integration defect: applying the same configuration to an already-running host restarts that host automatically, so saved FX type replacement was still rejected while running. The explicit UI restart path now stops and waits for the bridge acknowledgment before configuration and FX synchronization, then starts again. [Restart evidence](native-fx-restart.json) confirms Input A = PHASER and the two preserved loop PCM hashes matched before/after restart. [Active FX evidence](native-fx-active.json) records the physical A button enabling the effect; the keyboard macro changed from 0 to 1 percent and was then restored to 0/Bypass. These files establish command/acknowledgment behavior, not the effect's acoustic quality.

Confirmation uses an accessible dialog inside the Classic LCD, with Cancel, Continue, Escape and the physical ENTER/EXIT keys. Tech retains an in-page dialog. Both have focus containment and focus return. This avoids the blocking browser-native confirm that previously interrupted the test page.

The final LCD integration additionally exposes explicit FX target/slot/type/amount/active fields; named parameters call the same effect-specific sanitizers/serializers as the existing detailed editor. Track KeepPitch and WAV fields use the already-mounted track controllers rather than creating duplicate looper controllers. The compatibility Tech interface retains its existing detailed controls and is tested separately from Classic LCD navigation.
