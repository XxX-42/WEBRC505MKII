# Native official-interface validation (2026-10-22)

## Current verified summary

All 53 Native effect families now expose supported official interfaces: 266 runtime descriptors, including two variant routing selectors. Reconciled against the 267 manual source rows, Native covers **252 functional rows + 4 partial-source-mode rows + 11 unavailable rows**. Indexed STEP LEVEL controls and variant-specific rows explain why runtime descriptor and manual-row counts differ. VINYL FLICK and BEAT SHIFT now use actual loop readheads, not a causal streaming-buffer substitute. Legacy 252 canonical descriptors and two compatibility aliases remain intact.

- Latest mono-spatial routing validation: **52/52 portable CTest targets**, 23.36 seconds; **5/5 simulation/HTTP targets**, 5.84 seconds. Both strict builds pass. All build/test processes were restricted to CPUs 0–5.
- Current actual HTTP schema: `../rc505-official-native-simulation-build/official-runtime-schema.json`, SHA-256 `94d17a653d3a27a7bef6e0c13404f365db1ed1c0fd0174aced28b045e6fee3a1`.
- Mono Input FX now preserve official stereo semantics after explicit opt-in. AUTO PAN, PANNING DELAY, CHORUS and an upstream-pan/STEREO ENHANCE chain have actual PCM regressions; legacy-only and tempo-only mono behavior remains unchanged.
- See the source-aware section and SCATTER ownership correction below for current audio, routing and lifecycle evidence. Earlier checkpoints below are retained as historical records, not the current coverage total.
- All DSP is independently authored. No device deployment, hardware sound equivalence, XRUN acceptance or real-time deadline result is claimed.

## Historical 44-family / 208-control batch

44 Native effect families advertise 208 official numeric controls. Of those, VINYL FLICK's single control is explicitly `partial_live_stream`, not source-aware track playback. The other controls are independently authored DSP implementations of documented interfaces, not a claim of factory sound parity. Earlier checkpoint evidence below remains historical.

- 50/50 strict portable CTest targets passed, 6.90 seconds.
- 5/5 headless simulation CTest targets passed, 4.61 seconds, including the complete legacy HTTP suite and official HTTP coverage for all 208 controls.
- No device execution, XRUN/real-time deadline acceptance, hardware listening comparison, or target-computer deployment was performed.

## Historical verified checkpoint

Checkpoint `cb77d32`: 16 algorithms, 75 advertised numeric official controls. Existing 252 legacy descriptors and two compatibility aliases are unchanged. This implements manual-interface compatibility with clean-room DSP. No hardware sound equivalence is claimed.

- Strict Release portable build completed with warnings treated as errors.
- All 47 portable CTest targets passed.
- New official-parameter tests cover an audible difference for each advertised control, meaningful conditional fixtures, all six distortion types, PHASER BI-PHASE, independent dry/effect levels, transport tempo changes, invalid-domain rejection, streaming chunk invariance, and allocation-free control updates/processing.
- Native live-queue test exercises every advertised official descriptor plus internal `official_bpm`. The BPM adapter is not listed as a hardware parameter.
- Headless host and its JSON status serializer compiled. Focused official HTTP schema/control test passed for the checkpoint (75 controls), including live updates, invalid tempo rejection, and rejection of unsupported RING MOD MODE.
- The full pre-existing HTTP simulation suite failed late at the >1 MiB invalid project archive upload with urllib `BrokenPipeError`, before receiving the expected missing-revision rejection. FX-specific assertions had already run. This is not represented as a passing whole-host test and remains an unrelated integration limitation to investigate.
- Device/audio-driver execution, hardware A/B equivalence, and real-device sound-quality acceptance were not tested. Simulation uses the repository's explicitly labelled fake audio adapter.

## Dependency provenance

Dependencies are cached outside the repository; no vendored dependency tree or system-wide installation was added.

- CMake 3.31.6, official PyPI `cmake` manylinux x86_64 wheel. SHA-256 `1c8b05df0602365da91ee6a3336fe57525b137706c4ab5675498f662ae1dbcec`. CMake's distributed BSD-style license and bundled notices, plus the wheel's Apache-2.0/BSD-3-Clause license files, remain in the dependency cache. Source: https://pypi.org/project/cmake/3.31.6/
- nlohmann/json v3.11.3, declared project dependency, official https://github.com/nlohmann/json tag commit `9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03`. Single header SHA-256 `9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6`; MIT license SHA-256 `86b998c792894ccb911a1cb7994f7a9652894e7a094c0b5e45be2f553f45cf14`.
- cpp-httplib v0.16.3, declared project dependency, official https://github.com/yhirose/cpp-httplib tag commit `af56b7ec0ba9d18b788ed064f76d936eb52c5db5`. Header SHA-256 `5a06594751ed82e60e22620dfb267479d0bac45d79aa5df5bddc4a51881b3a6f`; MIT license SHA-256 `4b45cbe16d7b71b89ae6127e26e0d90a029198ca5e958ad8e3d0b8bbed364d8b`.
- RtAudio 6.0.1, declared project dependency, official https://github.com/thestk/rtaudio tag commit `b4f04903312e0e0efffbe77655172e0f060dc085`. Permissive MIT-style license SHA-256 `73eb32613a621c134b33fbe3c661562dcf5f81f0558af13d483fc241eb21be7b`. Simulation configuration disables ALSA/Pulse/JACK because those development libraries are absent; it does not test hardware audio.

Reproduce portable: configure `native-mvp/engine-cpp` with `-DNATIVE_PORTABLE_TESTS_ONLY=ON -DCMAKE_BUILD_TYPE=Release -DFETCHCONTENT_SOURCE_DIR_JSON_SRC=<json-cache>`, then build and run `ctest --output-on-failure -j4`.

Reproduce headless: use `-DNATIVE_BRIDGE_SIMULATION_ONLY=ON`, the same JSON override, `FETCHCONTENT_SOURCE_DIR_HTTPLIB_SRC` and `FETCHCONTENT_SOURCE_DIR_RTAUDIO_SRC`, plus `-DRTAUDIO_API_ALSA=OFF -DRTAUDIO_API_PULSE=OFF -DRTAUDIO_API_JACK=OFF`. The focused contract is `native_official_fx_http_simulation`.

## Full portable checkpoint CTest log

```text
Internal ctest changing into directory: /workspace/scratch/2230ee2a4571/rc505-official-native-build
Test project /workspace/scratch/2230ee2a4571/rc505-official-native-build
      Start 12: native_robot_core_tests
      Start  1: native_official_fx_parameters_tests
      Start  6: native_fx_catalog_tests
      Start 23: native_catalog_route_tests
 1/47 Test #23: native_catalog_route_tests ..............   Passed    1.25 sec
      Start 21: native_audio_callback_tests
 2/47 Test  #6: native_fx_catalog_tests .................   Passed    1.37 sec
      Start  4: native_audio_pipeline_tests
 3/47 Test #21: native_audio_callback_tests .............   Passed    0.40 sec
      Start 38: native_tape_echo_processor_tests
 4/47 Test  #4: native_audio_pipeline_tests .............   Passed    0.36 sec
      Start 34: native_preamp_processor_tests
 5/47 Test #38: native_tape_echo_processor_tests ........   Passed    0.33 sec
      Start 43: native_radio_processor_tests
 6/47 Test #34: native_preamp_processor_tests ...........   Passed    0.28 sec
      Start  7: native_auto_riff_core_tests
 7/47 Test  #1: native_official_fx_parameters_tests .....   Passed    2.07 sec
      Start 11: native_hrm_auto_core_tests
 8/47 Test  #7: native_auto_riff_core_tests .............   Passed    0.18 sec
      Start 32: native_fdn16_reverb_processor_tests
 9/47 Test #11: native_hrm_auto_core_tests ..............   Passed    0.15 sec
      Start 25: native_poly_pitch_processor_tests
10/47 Test #43: native_radio_processor_tests ............   Passed    0.27 sec
      Start 30: native_flanger_processor_tests
11/47 Test #32: native_fdn16_reverb_processor_tests .....   Passed    0.14 sec
      Start  9: native_osc_voc_core_tests
12/47 Test #30: native_flanger_processor_tests ..........   Passed    0.11 sec
      Start 29: native_vinyl_flick_processor_tests
13/47 Test #25: native_poly_pitch_processor_tests .......   Passed    0.15 sec
      Start 27: native_phaser_processor_tests
14/47 Test  #9: native_osc_voc_core_tests ...............   Passed    0.09 sec
      Start 14: native_osc_bot_core_tests
15/47 Test #29: native_vinyl_flick_processor_tests ......   Passed    0.09 sec
      Start 19: native_isolator_processor_tests
16/47 Test #27: native_phaser_processor_tests ...........   Passed    0.09 sec
      Start 33: native_distortion_processor_tests
17/47 Test #14: native_osc_bot_core_tests ...............   Passed    0.07 sec
18/47 Test #19: native_isolator_processor_tests .........   Passed    0.04 sec
      Start 17: native_g2b_processor_tests
      Start 26: native_chorus_processor_tests
19/47 Test #33: native_distortion_processor_tests .......   Passed    0.05 sec
      Start 45: native_vibrato_processor_tests
20/47 Test #26: native_chorus_processor_tests ...........   Passed    0.04 sec
      Start 16: native_synth_processor_tests
21/47 Test #17: native_g2b_processor_tests ..............   Passed    0.04 sec
      Start 24: native_pitch_processor_tests
22/47 Test #45: native_vibrato_processor_tests ..........   Passed    0.04 sec
      Start  8: native_vocoder_core_tests
23/47 Test #16: native_synth_processor_tests ............   Passed    0.04 sec
      Start 41: native_mod_delay_processor_tests
24/47 Test #24: native_pitch_processor_tests ............   Passed    0.05 sec
      Start 46: native_rhythm_tests
25/47 Test  #8: native_vocoder_core_tests ...............   Passed    0.03 sec
      Start 13: native_hrm_auto_processor_tests
26/47 Test #13: native_hrm_auto_processor_tests .........   Passed    0.01 sec
      Start 44: native_sustainer_processor_tests
27/47 Test #41: native_mod_delay_processor_tests ........   Passed    0.03 sec
      Start 15: native_osc_bot_processor_tests
28/47 Test #46: native_rhythm_tests .....................   Passed    0.03 sec
      Start  5: project_archive_codec_tests
29/47 Test #44: native_sustainer_processor_tests ........   Passed    0.01 sec
30/47 Test #15: native_osc_bot_processor_tests ..........   Passed    0.01 sec
      Start 37: native_beat_scatter_processor_tests
      Start 35: native_beat_repeat_processor_tests
31/47 Test  #5: project_archive_codec_tests .............   Passed    0.01 sec
      Start 42: native_stereo_enhance_processor_tests
32/47 Test #35: native_beat_repeat_processor_tests ......   Passed    0.01 sec
      Start 31: native_dynamics_processor_tests
33/47 Test #37: native_beat_scatter_processor_tests .....   Passed    0.01 sec
      Start 10: native_osc_voc_processor_tests
34/47 Test #42: native_stereo_enhance_processor_tests ...   Passed    0.01 sec
      Start 36: native_roll_processor_tests
35/47 Test #10: native_osc_voc_processor_tests ..........   Passed    0.00 sec
      Start  2: looper_core_tests
36/47 Test #31: native_dynamics_processor_tests .........   Passed    0.01 sec
      Start 39: native_reverse_delay_processor_tests
37/47 Test  #2: looper_core_tests .......................   Passed    0.00 sec
      Start 40: native_panning_delay_processor_tests
38/47 Test #36: native_roll_processor_tests .............   Passed    0.01 sec
      Start 20: native_slow_gear_processor_tests
39/47 Test #39: native_reverse_delay_processor_tests ....   Passed    0.01 sec
      Start 22: native_freeze_processor_tests
40/47 Test #40: native_panning_delay_processor_tests ....   Passed    0.00 sec
      Start 18: native_manual_pan_processor_tests
41/47 Test #20: native_slow_gear_processor_tests ........   Passed    0.01 sec
      Start 28: native_autopan_processor_tests
42/47 Test #22: native_freeze_processor_tests ...........   Passed    0.00 sec
      Start 47: native_third_party_notices
43/47 Test #18: native_manual_pan_processor_tests .......   Passed    0.00 sec
      Start  3: dsp_primitives_tests
44/47 Test #28: native_autopan_processor_tests ..........   Passed    0.00 sec
45/47 Test #47: native_third_party_notices ..............   Passed    0.00 sec
46/47 Test  #3: dsp_primitives_tests ....................   Passed    0.00 sec
47/47 Test #12: native_robot_core_tests .................   Passed    4.29 sec

100% tests passed, 0 tests failed out of 47

Total Test time (real) =   4.29 sec
```

## Second checkpoint

31 algorithms expose 140 implemented official controls: the prior 16/75 plus REVERB, GATE REVERB, CHORUS, STEREO ENHANCE, SYNTH, G2B, ISOLATOR (34 controls), and eight pitch families (31 controls). All 48 portable CTest targets passed. The main suite directly demonstrates 109 controls and the separate voiced/MIDI fixtures cover the 31 pitch-family controls. The domain/bounds suite and live host-queue suite visit every advertised descriptor.

Native validation and first-opt-in documented defaults are generated by `native-mvp/engine-cpp/tools/generate-official-domains.cjs` from the actual shared TypeScript `officialParameterDomain` and `encodeOfficialValue`, with ES2022 iteration semantics. Run that command with `--check` to detect drift. Undocumented intermediate note values and fractional integer knobs are rejected; frequency controls accept exactly Float32 representations of documented 0.1 Hz steps. Unknown defaults stay unknown. Only a real official adjustable control initializes documented supported defaults once; `official_bpm` updates never opt legacy DSP into the official mode. Tests compare first-control-only initialization with explicit defaults and verify BPM-only updates leave all 23 non-pitch legacy algorithms unchanged.

Clean-room limitations: proprietary MODE 1/2 switches and AUTO RIFF P1–P30 phrases are not advertised. Robot NOTE uses an authored C4–B4 reference octave because the guide specifies pitch class only. HRM AUTO KEY is conditional on HYBRID and both modes require MIDI-held notes. AUTO RIFF retains one authored eight-step phrase. ELECTRIC FORMANT changes a pitch-tracked synthesized harmonic envelope, not a hardware-identical original-timbre correction. Native REVERB DENSITY changes normalized FDN excitation distribution without changing the stable feedback matrix. No cross-engine sound parity or hardware sound-quality acceptance is implied.

```text
Internal ctest changing into directory: /workspace/scratch/2230ee2a4571/rc505-official-native-build
Test project /workspace/scratch/2230ee2a4571/rc505-official-native-build
      Start  1: native_official_fx_parameters_tests
      Start  7: native_fx_catalog_tests
      Start 24: native_catalog_route_tests
      Start 13: native_robot_core_tests
 1/48 Test #24: native_catalog_route_tests ..............   Passed    1.30 sec
      Start 22: native_audio_callback_tests
 2/48 Test  #7: native_fx_catalog_tests .................   Passed    1.42 sec
      Start  5: native_audio_pipeline_tests
 3/48 Test #22: native_audio_callback_tests .............   Passed    0.45 sec
      Start 39: native_tape_echo_processor_tests
 4/48 Test  #5: native_audio_pipeline_tests .............   Passed    0.35 sec
      Start 35: native_preamp_processor_tests
 5/48 Test #35: native_preamp_processor_tests ...........   Passed    0.25 sec
      Start 44: native_radio_processor_tests
 6/48 Test #39: native_tape_echo_processor_tests ........   Passed    0.35 sec
      Start  8: native_auto_riff_core_tests
 7/48 Test #44: native_radio_processor_tests ............   Passed    0.29 sec
      Start 33: native_fdn16_reverb_processor_tests
 8/48 Test  #8: native_auto_riff_core_tests .............   Passed    0.23 sec
      Start 31: native_flanger_processor_tests
 9/48 Test #31: native_flanger_processor_tests ..........   Passed    0.11 sec
      Start 10: native_osc_voc_core_tests
10/48 Test #33: native_fdn16_reverb_processor_tests .....   Passed    0.15 sec
      Start 28: native_phaser_processor_tests
11/48 Test #10: native_osc_voc_core_tests ...............   Passed    0.07 sec
      Start 30: native_vinyl_flick_processor_tests
12/48 Test #28: native_phaser_processor_tests ...........   Passed    0.07 sec
      Start 15: native_osc_bot_core_tests
13/48 Test #30: native_vinyl_flick_processor_tests ......   Passed    0.08 sec
      Start 34: native_distortion_processor_tests
14/48 Test #15: native_osc_bot_core_tests ...............   Passed    0.07 sec
      Start 20: native_isolator_processor_tests
15/48 Test #34: native_distortion_processor_tests .......   Passed    0.04 sec
      Start 12: native_hrm_auto_core_tests
16/48 Test #20: native_isolator_processor_tests .........   Passed    0.04 sec
      Start 26: native_poly_pitch_processor_tests
17/48 Test #26: native_poly_pitch_processor_tests .......   Passed    0.19 sec
      Start 18: native_g2b_processor_tests
18/48 Test #12: native_hrm_auto_core_tests ..............   Passed    0.19 sec
      Start 25: native_pitch_processor_tests
19/48 Test #25: native_pitch_processor_tests ............   Passed    0.03 sec
      Start 17: native_synth_processor_tests
20/48 Test #18: native_g2b_processor_tests ..............   Passed    0.04 sec
      Start 27: native_chorus_processor_tests
21/48 Test #17: native_synth_processor_tests ............   Passed    0.03 sec
      Start 46: native_vibrato_processor_tests
22/48 Test #27: native_chorus_processor_tests ...........   Passed    0.03 sec
      Start  9: native_vocoder_core_tests
23/48 Test  #9: native_vocoder_core_tests ...............   Passed    0.03 sec
      Start 42: native_mod_delay_processor_tests
24/48 Test #46: native_vibrato_processor_tests ..........   Passed    0.04 sec
      Start 47: native_rhythm_tests
25/48 Test #47: native_rhythm_tests .....................   Passed    0.02 sec
      Start 45: native_sustainer_processor_tests
26/48 Test #42: native_mod_delay_processor_tests ........   Passed    0.03 sec
      Start 16: native_osc_bot_processor_tests
27/48 Test #16: native_osc_bot_processor_tests ..........   Passed    0.01 sec
      Start 38: native_beat_scatter_processor_tests
28/48 Test #45: native_sustainer_processor_tests ........   Passed    0.01 sec
      Start  6: project_archive_codec_tests
29/48 Test #38: native_beat_scatter_processor_tests .....   Passed    0.01 sec
30/48 Test  #6: project_archive_codec_tests .............   Passed    0.01 sec
      Start 32: native_dynamics_processor_tests
      Start 36: native_beat_repeat_processor_tests
31/48 Test #32: native_dynamics_processor_tests .........   Passed    0.01 sec
      Start 43: native_stereo_enhance_processor_tests
32/48 Test #36: native_beat_repeat_processor_tests ......   Passed    0.01 sec
      Start 37: native_roll_processor_tests
33/48 Test #37: native_roll_processor_tests .............   Passed    0.00 sec
      Start 11: native_osc_voc_processor_tests
34/48 Test #43: native_stereo_enhance_processor_tests ...   Passed    0.01 sec
      Start 40: native_reverse_delay_processor_tests
35/48 Test #11: native_osc_voc_processor_tests ..........   Passed    0.00 sec
      Start 21: native_slow_gear_processor_tests
36/48 Test #40: native_reverse_delay_processor_tests ....   Passed    0.00 sec
      Start 41: native_panning_delay_processor_tests
37/48 Test #21: native_slow_gear_processor_tests ........   Passed    0.00 sec
      Start 23: native_freeze_processor_tests
38/48 Test #41: native_panning_delay_processor_tests ....   Passed    0.00 sec
      Start  3: looper_core_tests
39/48 Test #23: native_freeze_processor_tests ...........   Passed    0.00 sec
      Start 19: native_manual_pan_processor_tests
40/48 Test  #3: looper_core_tests .......................   Passed    0.00 sec
      Start  4: dsp_primitives_tests
41/48 Test #19: native_manual_pan_processor_tests .......   Passed    0.00 sec
      Start 29: native_autopan_processor_tests
42/48 Test  #4: dsp_primitives_tests ....................   Passed    0.00 sec
      Start 48: native_third_party_notices
43/48 Test #29: native_autopan_processor_tests ..........   Passed    0.00 sec
      Start 14: native_hrm_auto_processor_tests
44/48 Test #48: native_third_party_notices ..............   Passed    0.00 sec
      Start  2: native_official_pitch_controls_tests
45/48 Test #14: native_hrm_auto_processor_tests .........   Passed    0.01 sec
46/48 Test  #2: native_official_pitch_controls_tests ....   Passed    0.25 sec
47/48 Test  #1: native_official_fx_parameters_tests .....   Passed    3.44 sec
48/48 Test #13: native_robot_core_tests .................   Passed    4.23 sec

100% tests passed, 0 tests failed out of 48

Total Test time (real) =   4.24 sec
```

## Rebuilt headless HTTP follow-up
The second-batch rebuilt host passed native_official_fx_http_simulation (1/1, 1.73 s), publishing and live-updating all 140 official controls. Illegal tempo values and unsupported MODE were rejected. This is cloud host validation, not physical hardware or user-machine deployment.

## Third batch: validated additions and explicit boundaries

Since the 31-family/140-control checkpoint, 13 families and 68 controls were added:

- DELAY, PANNING DELAY, REVERSE DELAY and MOD DELAY: 25 controls. FEEDBACK is a finite repeat count, 1–16, never a feedback percentage. The clean-room feed-forward tap law is 0.65^(repeat−1). TIME accepts only the generated source domain: numeric 1–2000 ms and the verified half/quarter/32nd-note values. There is no invented whole-note option. Independent D.LEVEL, E.LEVEL (up to 120), wet-only cuts and modulation depth have actual DSP paths.
- VOCODER, OSC VOC and OSC BOT: 17 controls. Authored oscillator waveforms, tone, envelopes, sensitivity, balance, fixed BOT note and VOC octave controls have audible tests. External MIC/INST/TRACK carrier-bus selection and carrier-through remain unsupported. The existing synthetic carrier is not misrepresented as external routing. OSC BOT C1–G9 uses MIDI 24–127, default C2=36.
- PREAMP and DYNAMICS: 14 controls. Nine authored amp profiles, nine speaker settings including bypass, five microphones, microphone distance/position, gain, compression, EQ and independent effect output; 19 distinct authored dynamics profiles and the −20…+20 macro. These share clean-room profile laws with Browser, not recovered factory presets. Unknown DYNAMICS TYPE factory default remains unknown; the initial software fallback is explicitly not a factory claim.
- REVERSE REVERB: seven controls. A short 0.15 s diffuser feeds an energy-normalized 128-tap rising kernel. GATE TIME shifts the start of the rising reverberation, TIME sets the growing kernel's duration, PRE DELAY is a real independent input delay, with wet-only cuts and independent levels. Tests demonstrate a rising envelope and the expected onset displacement. This is not merely reversed input followed by an ordinary decaying reverb.
- WARP, GRANULAR DELAY and VINYL FLICK: five controls. WARP LEVEL changes only wet gain while dry remains unity. GRANULAR TIME is density (80→1 Hz) and FEEDBACK is grain duration (10→1000 ms), not regeneration. The official branch preallocates 96 voices so 80 Hz × 1000 ms is not silently capped by the old 16-voice limit; the legacy branch keeps its original 16-voice budget. VINYL FLICK's 0…100 is an authored 0…2× bounded-history model; mono and stereo are audible, but it cannot read future track material. Its host descriptor publishes `semanticSupport: partial_live_stream` and the explicit limitation. Do not count it as complete source-aware transport support.

### Tempo, source scope and old-project compatibility

The internal, unadvertised `official_quarter_notes_per_measure` adapter accepts 0.125…128, default 4. Explicit project Transport meter is authoritative; rhythm-pattern selection does not overwrite it. Only MEAS rate/step-rate values −4/−8/−16 scale by this meter, and AUTO RIFF's documented MEAS tempo values use it too. TIME note values remain absolute quarter-note multiples regardless of meter. Neither meter nor BPM auxiliary updates activate official defaults or replace legacy mix settings. `official_bpm` is bounded at 40…300; the legacy BPM descriptors retain their existing domains.

Adding official descriptors initially exposed a legacy synchronization regression in the route test: Reverse Reverb stopped receiving its old rhythm BPM updates. The host now delivers both existing legacy and additive official tempo commands where needed. The legacy route suite passes again. The bounded queue reserves space for both commands before mutation.

The last four source effects (BEAT SCATTER, BEAT REPEAT, BEAT SHIFT and VINYL FLICK) reject any `official_*` request unless it is Track FX slot A under the current MULTI model. This check precedes queue and bank mutation. Extension-only configurations remain unchanged. Existing private-track source-aware restrictions for BEAT SHIFT/VINYL FLICK remain enforced. HTTP tests exercise input/B/private rejections and unchanged extension-only VINYL slot B.

### Capacity, allocation and validation limits

Each counted-delay instance preallocates 51 seconds of stereo Float32 history: approximately 18.68 MiB at 48 kHz or 74.71 MiB at 192 kHz. The full delay capacity is allocated during prepare, even when using its legacy controls; this has a material memory cost. At the legal 40 BPM minimum, half-note TIME is three seconds. Tests run all four delay modes with repeat counts 1, 2 and 16, verify the sixteenth repeat at 48 seconds, no seventeenth repeat, alternation where applicable, correct reversed segments, and clean reset epochs. Values below 40 BPM and unsupported TIME notes are rejected rather than accepted and truncated. Reset and callback parameter changes do not allocate.

The reverse-reverb rising kernel adds 11 seconds of stereo history, approximately 4.03 MiB at 48 kHz, plus diffuser/pre-delay state. Fixed buffers and bounded voice/tap counts are correctness mechanisms, not evidence of acceptable device CPU cost. No performance claim is made.

All 208 descriptors traverse the headless host's real command validation and live-update queue. The new dedicated amp/dynamics and vocoder suites cover audible controls/enums, bounds, defaults, non-finite rejection, stereo/mono handling, reset/chunk behavior and allocation tracking. The amp/dynamics worker additionally passed ASan/UBSan with LeakSanitizer disabled because the executor uses ptrace. Its independent baseline/current legacy PCM probe was byte-identical across four sample rates, legacy models and channel transitions: SHA-256 `e453939d4908fbf045f97b0caa4b2e97860c2f7f2e6148ffb349d9d7b249b637`. This does not substitute for hardware or perceptual validation.

The earlier full-HTTP limitation is resolved: the test client now reads the server's already-returned response when a rejected large request closes the upload early. It does not retry the request or skip error/status assertions. Both complete HTTP suites pass with the newly rebuilt host.

TAPE ECHO and ROLL variants, STEP SLICER, TWIST, FREEZE and BEAT source controls still require subsequent Native integration. Unsupported MODE/carrier/phrase controls remain rejected; no inert knobs were advertised to close a coverage count.

### Full third-batch portable log

```text
Internal ctest changing into directory: /workspace/scratch/2230ee2a4571/rc505-official-native-build
Test project /workspace/scratch/2230ee2a4571/rc505-official-native-build
      Start 26: native_catalog_route_tests
      Start 15: native_robot_core_tests
      Start  1: native_official_fx_parameters_tests
      Start  3: native_official_amp_dynamics_tests
      Start  9: native_fx_catalog_tests
      Start  2: native_official_vocoder_controls_tests
 1/50 Test  #2: native_official_vocoder_controls_tests ...   Passed    0.50 sec
      Start 24: native_audio_callback_tests
 2/50 Test #24: native_audio_callback_tests ..............   Passed    0.54 sec
      Start  7: native_audio_pipeline_tests
 3/50 Test #26: native_catalog_route_tests ...............   Passed    1.38 sec
      Start 41: native_tape_echo_processor_tests
 4/50 Test  #7: native_audio_pipeline_tests ..............   Passed    0.40 sec
      Start  4: native_official_pitch_controls_tests
 5/50 Test  #9: native_fx_catalog_tests ..................   Passed    1.62 sec
      Start 46: native_radio_processor_tests
 6/50 Test #41: native_tape_echo_processor_tests .........   Passed    0.35 sec
      Start 37: native_preamp_processor_tests
 7/50 Test  #4: native_official_pitch_controls_tests .....   Passed    0.34 sec
      Start 10: native_auto_riff_core_tests
 8/50 Test #46: native_radio_processor_tests .............   Passed    0.32 sec
      Start 35: native_fdn16_reverb_processor_tests
 9/50 Test #10: native_auto_riff_core_tests ..............   Passed    0.21 sec
      Start 33: native_flanger_processor_tests
10/50 Test #37: native_preamp_processor_tests ............   Passed    0.28 sec
      Start 14: native_hrm_auto_core_tests
11/50 Test #33: native_flanger_processor_tests ...........   Passed    0.11 sec
      Start 28: native_poly_pitch_processor_tests
12/50 Test #35: native_fdn16_reverb_processor_tests ......   Passed    0.20 sec
      Start 12: native_osc_voc_core_tests
13/50 Test  #3: native_official_amp_dynamics_tests .......   Passed    2.16 sec
      Start 30: native_phaser_processor_tests
14/50 Test #14: native_hrm_auto_core_tests ...............   Passed    0.21 sec
      Start 32: native_vinyl_flick_processor_tests
15/50 Test #12: native_osc_voc_core_tests ................   Passed    0.08 sec
      Start 17: native_osc_bot_core_tests
16/50 Test #30: native_phaser_processor_tests ............   Passed    0.09 sec
      Start 36: native_distortion_processor_tests
17/50 Test #28: native_poly_pitch_processor_tests ........   Passed    0.17 sec
      Start 22: native_isolator_processor_tests
18/50 Test #17: native_osc_bot_core_tests ................   Passed    0.07 sec
      Start 20: native_g2b_processor_tests
19/50 Test #36: native_distortion_processor_tests ........   Passed    0.05 sec
      Start 48: native_vibrato_processor_tests
20/50 Test #32: native_vinyl_flick_processor_tests .......   Passed    0.08 sec
      Start 27: native_pitch_processor_tests
21/50 Test #22: native_isolator_processor_tests ..........   Passed    0.04 sec
      Start 29: native_chorus_processor_tests
22/50 Test #27: native_pitch_processor_tests .............   Passed    0.03 sec
      Start 19: native_synth_processor_tests
23/50 Test #48: native_vibrato_processor_tests ...........   Passed    0.04 sec
      Start 11: native_vocoder_core_tests
24/50 Test #20: native_g2b_processor_tests ...............   Passed    0.05 sec
      Start 44: native_mod_delay_processor_tests
25/50 Test #11: native_vocoder_core_tests ................   Passed    0.03 sec
      Start 49: native_rhythm_tests
26/50 Test #44: native_mod_delay_processor_tests .........   Passed    0.02 sec
      Start 47: native_sustainer_processor_tests
27/50 Test #29: native_chorus_processor_tests ............   Passed    0.04 sec
      Start 18: native_osc_bot_processor_tests
28/50 Test #19: native_synth_processor_tests .............   Passed    0.04 sec
      Start 40: native_beat_scatter_processor_tests
29/50 Test #18: native_osc_bot_processor_tests ...........   Passed    0.01 sec
      Start 38: native_beat_repeat_processor_tests
30/50 Test #49: native_rhythm_tests ......................   Passed    0.02 sec
      Start  8: project_archive_codec_tests
31/50 Test #47: native_sustainer_processor_tests .........   Passed    0.02 sec
      Start 45: native_stereo_enhance_processor_tests
32/50 Test #40: native_beat_scatter_processor_tests ......   Passed    0.01 sec
      Start 34: native_dynamics_processor_tests
33/50 Test #38: native_beat_repeat_processor_tests .......   Passed    0.01 sec
      Start 39: native_roll_processor_tests
34/50 Test #45: native_stereo_enhance_processor_tests ....   Passed    0.01 sec
      Start 16: native_hrm_auto_processor_tests
35/50 Test  #8: project_archive_codec_tests ..............   Passed    0.01 sec
      Start 23: native_slow_gear_processor_tests
36/50 Test #34: native_dynamics_processor_tests ..........   Passed    0.01 sec
      Start 13: native_osc_voc_processor_tests
37/50 Test #39: native_roll_processor_tests ..............   Passed    0.01 sec
      Start 42: native_reverse_delay_processor_tests
38/50 Test #13: native_osc_voc_processor_tests ...........   Passed    0.00 sec
      Start 43: native_panning_delay_processor_tests
39/50 Test #23: native_slow_gear_processor_tests .........   Passed    0.01 sec
      Start 25: native_freeze_processor_tests
40/50 Test #42: native_reverse_delay_processor_tests .....   Passed    0.01 sec
      Start  5: looper_core_tests
41/50 Test #16: native_hrm_auto_processor_tests ..........   Passed    0.01 sec
      Start 21: native_manual_pan_processor_tests
42/50 Test #43: native_panning_delay_processor_tests .....   Passed    0.00 sec
      Start  6: dsp_primitives_tests
43/50 Test #25: native_freeze_processor_tests ............   Passed    0.00 sec
      Start 31: native_autopan_processor_tests
44/50 Test  #5: looper_core_tests ........................   Passed    0.00 sec
      Start 50: native_third_party_notices
45/50 Test #21: native_manual_pan_processor_tests ........   Passed    0.00 sec
46/50 Test  #6: dsp_primitives_tests .....................   Passed    0.00 sec
47/50 Test #31: native_autopan_processor_tests ...........   Passed    0.00 sec
48/50 Test #50: native_third_party_notices ...............   Passed    0.00 sec
49/50 Test #15: native_robot_core_tests ..................   Passed    4.42 sec
50/50 Test  #1: native_official_fx_parameters_tests ......   Passed    6.89 sec

100% tests passed, 0 tests failed out of 50

Total Test time (real) =   6.90 sec
```

### Full third-batch headless log

```text
Internal ctest changing into directory: /workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build
UpdateCTestConfiguration  from :/workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build/DartConfiguration.tcl
UpdateCTestConfiguration  from :/workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build/DartConfiguration.tcl
Test project /workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build
Constructing a list of tests
Done constructing a list of tests
Updating test list for fixtures
Added 0 tests to meet fixture requirements
Checking test dependency graph...
Checking test dependency graph end
test 1
    Start 1: project_archive_codec_tests

1: Test command: /workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build/project_archive_codec_tests
1: Working Directory: /workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build
1: Test timeout computed to be: 10000000
1: Project archive codec tests passed
1/5 Test #1: project_archive_codec_tests ..........   Passed    0.01 sec
test 2
    Start 2: native_bridge_http_simulation

2: Test command: /opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin/python3.12 "/workspace/scratch/2230ee2a4571/rc505-fx-parameters-20261022/native-mvp/engine-cpp/tests/native_bridge_http_simulation_test.py" "/workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build/native_bridge_host_simulation"
2: Working Directory: /workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build
2: Test timeout computed to be: 10000000
2: Native bridge HTTP simulation passed, including five-track status, selector validation, per-track recording, stereo snapshots, callback-acknowledged project archive import/cancel/status routes, OSC VOC absolute-frame MIDI routing/status, and HRM AUTO exact-slot MIDI route/status. The fake RtAudio callback source is synthetic and is not device, timing, XRUN, or audio-quality evidence.
2/5 Test #2: native_bridge_http_simulation ........   Passed    2.47 sec
test 3
    Start 3: native_official_fx_http_simulation

3: Test command: /opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin/python3.12 "/workspace/scratch/2230ee2a4571/rc505-fx-parameters-20261022/native-mvp/engine-cpp/tests/native_official_fx_http_simulation_test.py" "/workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build/native_bridge_host_simulation"
3: Working Directory: /workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build
3: Test timeout computed to be: 10000000
3: Native official HTTP descriptors/live controls passed (208 controls).
3/5 Test #3: native_official_fx_http_simulation ...   Passed    2.13 sec
test 4
    Start 4: native_third_party_notices

4: Test command: /workspace/scratch/2230ee2a4571/rc505-official-native-deps/cmake-py/cmake/data/bin/cmake "-DSIGNALSMITH_SOURCE_DIR=/workspace/scratch/2230ee2a4571/rc505-fx-parameters-20261022/native-mvp/engine-cpp/third_party/signalsmith" "-DRTAUDIO_SOURCE_DIR=/workspace/scratch/2230ee2a4571/rc505-official-native-deps/rtaudio-6.0.1" "-DHTTPLIB_SOURCE_DIR=/workspace/scratch/2230ee2a4571/rc505-official-native-deps/cpp-httplib-v0.16.3" "-DJSON_SOURCE_DIR=/workspace/scratch/2230ee2a4571/rc505-official-native-deps/json-v3.11.3" "-DPROJECT_LICENSE_SOURCE=/workspace/scratch/2230ee2a4571/rc505-fx-parameters-20261022/native-mvp/engine-cpp/../../LICENSE" "-DOUTPUT_DIR=/workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build" "-P" "/workspace/scratch/2230ee2a4571/rc505-fx-parameters-20261022/native-mvp/engine-cpp/tests/verify_native_distribution_notices.cmake"
4: Working Directory: /workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build
4: Test timeout computed to be: 10000000
4: -- Verified GPL project license and exact Native dependency license files at /workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build
4/5 Test #4: native_third_party_notices ...........   Passed    0.00 sec
test 5
    Start 5: apinames

5: Test command: /workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build/_deps/rtaudio_src-build/tests/apinames
5: Working Directory: /workspace/scratch/2230ee2a4571/rc505-official-native-simulation-build/_deps/rtaudio_src-build/tests
5: Test timeout computed to be: 10000000
5: API names by identifier (C++):
5: * 9 'dummy': 'Dummy'
5: API identifiers by name (C++):
5: * 'dummy': 9
5: API names by identifier (C):
5: * 9 'dummy': 'Dummy'
5: API identifiers by name (C):
5: * 'dummy': 9
5/5 Test #5: apinames .............................   Passed    0.00 sec

100% tests passed, 0 tests failed out of 5

Total Test time (real) =   4.61 sec
```


## Fourth Native checkpoint: explicit variants, slicers, FREEZE/TWIST

Validated 2026-10-22 UTC. Runtime coverage is now **50 effect families, 258 DSP control keys plus two `official_variant` routing selectors**. The added implementation corresponds to 42 manual parameter rows, not 50: STEP's single documented level row expands into 16 independently editable runtime keys, while shared TAPE/ROLL keys apply to both documented variants. VINYL remains `partial_live_stream` at this checkpoint; source-aware routing is not claimed here.

- **TAPE ECHO 1/2:** An explicit selector is required before official controls. Variant 1's repeat-rate scale uses `2000 * 0.0005^(x/100)` ms; variant 2 supports 1–2000 ms and the verified note choices, including a 3-second half note at 40 BPM. Three authored playback heads use 1x/2x/3x time and .55/.30/.15 weights, fixed 6-kHz damping, contractive saturation, and intensity `.95*x/100`. Variant 1 has wet-only bass/treble shelves (±20 dB); variant 2 has wet-only low/high cuts. D/E levels are independent; E reaches 120. These are authored transfer curves, not measured hardware sound.
- **ROLL 1/2:** A prepared live-history/snapshot reader implements selected divisions, finite repeat counts including exact 1/50/100 release, and variant-2 INF. Variant 1 accepts FEEDBACK as repeat count; variant 2 accepts REPEAT. TIME sync is independent of meter. ROLL's undocumented default remains an explicit software OFF fallback, not a claimed factory default.
- **STEP SLICER:** All 16 independent levels plus RATE, STEP MAX/LENGTH, DEPTH, compressor threshold/gain. The scalar editing alias and edit-index auxiliary are not advertised as extra audio knobs. Unequal step fixtures establish STEP MAX audibility.
- **PATTERN SLICER:** Six real controls without advertising unknown P01–P20 ROM. Uses the preserved existing authored software patterns; the helper's standalone neutral table is all-open. Both slicers use 2-ms gate smoothing and a linked 4:1 compressor, 5-ms attack/80-ms release. PATTERN attack gain is `1 + 3*(attack/100)*exp(-phase/.1)`. Pattern numbers are not identified as factory patterns.
- **FREEZE:** Actual capture on official FX activation, attack/decay/sustain and release after OFF. Time laws are A `2*1000^pct` ms, D `10*200^pct` ms, R `2*2500^pct` ms. A linear internal amplitude envelope and the bypass crossfade jointly shape the release; the held source is retained until release completes. OFF during pending capture cancels the capture. BALANCE is an independent linear direct/held mix. Legacy explicit `freeze` remains unchanged without official opt-in.
- **TWIST:** Official activation starts a real rotation-speed ramp; RISE spans 2–2000 ms. RELEASE FALL stops rotation on OFF; FADE continues rotating while the FALL time (2–5000 ms) fades output. FALL is intentionally conditional on FADE, as documented, and its audio test uses that condition. LEVEL controls wet gain with direct unity. The authored rotation law and legacy trajectory table are not hardware parity claims.

### Variant safety and runtime evidence

Generated Native domains now retain separate `tape_echo1/2` and `roll1/2` IDs. Host validation resolves the prospective selector before changing banks or queues, rejects fields from the other branch, then sends the selector before lexically earlier controls such as BASS. Control-thread variant shadows include accepted pending commands, avoiding both callback-state races and stale validation before the callback consumes an earlier selector. Re-selecting the current variant does not reset authored controls or audio history; switching variants clears incompatible branch state. Auxiliary BPM/meter updates never activate the official mode. Tests include rejection without explicit selection, rapid queued branch changes with no intervening callback, rejected-batch atomicity, and returning from variant 2 to variant 1 with BASS.

Actual HTTP capability evidence is saved outside the repository at `../rc505-official-native-simulation-build/official-runtime-schema.json`. This contains only FX schema metadata, no device information. Each variant control has `applicableVariants` and branch-specific `variantDomains`; selectors carry routing provenance. SHA-256: `1a2c9fbfed7fc529573beafd02176f43b8c23d65e6d8aa1f4875272e0a61d676`.

### Checks and limits

- Strict Release portable build: **52/52 CTest targets pass**, 21.71 seconds. Log: `../rc505-official-native-build/fourth-tests.log`.
- Full no-device bridge build: **5/5 CTest targets pass**, 5.10 seconds. Includes the full HTTP suite and all 260 runtime descriptors, both variant branches, live queued controls, invalid branch rejection, source-placement guards, and schema extraction. Log: `../rc505-official-native-simulation-build/fourth-tests.log`.
- The generic official matrix now establishes 155 individual audible controls (including real OFF/release fixtures); dedicated pitch/voice/amp and new slicer/tape/roll suites cover the other advertised controls. The generic matrix also tests exact domains and documented defaults across every advertised family/variant.
- Dedicated new helper suites: strict C++17 warnings-as-errors, exact boundaries/default activation, timing, reset, chunk invariance, and allocation tracker checks. TAPE/ROLL also pass ASan+UBSan; LeakSanitizer was not run because this ptrace environment cannot support it. All prepare/storage allocations occur outside callback processing. No hardware/device/XRUN or hardware-equivalence validation is implied.
- New TAPE storage adds approximately **3.30 MiB/instance at 48 kHz**, **13.18 MiB at 192 kHz** (9-second stereo history). New ROLL storage adds **2.20 MiB/instance at 48 kHz**, **8.79 MiB at 192 kHz** (two 3-second stereo banks). These are in addition to preserved legacy processor storage and are prepared even before official opt-in. No zero-cost memory claim is made.
- After the independent latency task's CPU partition was announced, build/test commands were pinned with `taskset -c 0-5`; the latency task owns separate CPUs. These CTest elapsed times are functional-test observations, not latency/throughput benchmark results.

## Review fixes: full-snapshot ownership and smoothing

- **FREEZE:** Once explicitly opted into official controls, synthetic legacy `freeze:0` and `mix_percent` values no longer release a held capture or corrupt official BALANCE. Official bypass/activation and BALANCE own those axes; legacy-only projects retain their previous behavior. Regression fixtures resend the full legacy macro plus named controls three times, compare the held audio against an unchanged reference, and verify exact dry output at BALANCE 0. BALANCE now honors the supplied smoothing frame count; held-stage SUSTAIN also honors its requested control ramp.
- **Catalog smoothing:** TAPE ECHO, ROLL, PATTERN SLICER and STEP SLICER now forward the base processor's resolved `rampFrames` to their official DSP helpers. Catalog-layer audio fixtures check the first sample and settled sample of actual 100-frame direct level, balance and compressor gain ramps, not only helper-level behavior.
- **Replacement protocol:** `POST /v1/native-fx/catalog-slot` accepts optional boolean `replaceParameters`; omission/false preserves the old patch contract. The host advertises `nativeFx.catalogParameterReplacement: true` while retaining `parameterSchemaVersion: 1`. True denotes a complete authored parameter map. While audio is running, removing any previously authored parameter returns HTTP 409 with `requiresRestart: Stop Native audio`; it does not enqueue edits or acknowledge a reset that did not occur. Parameter changes/additions still run live. Explicit variant changes can reset their old official branch live; omitted legacy controls still require stopping. Once stopped, complete replacement constructs a fresh processor, clearing omitted controls and official variant state. Auxiliary transport BPM/meter are not authored knob state. No automatic stop/restart is performed.
- Control-thread authored snapshots are allocated before queue/DSP mutation and committed by a no-throw map swap after acceptance; none of this allocation occurs in the callback. Core audio tests verify that deleting COMP GAIN while running is rejected, then stopped replacement genuinely returns the audio gain to its documented default. HTTP tests check removal/reset rejection, legacy patch compatibility, stopped replacement and strict boolean input. Variant tests verify that clearing the selector does not leave the old branch latched.
- **Validation:** All **52/52 portable CTest targets pass**, 26.18 seconds; all **5/5 simulation/HTTP targets pass**, 6.29 seconds. Logs: `../rc505-official-native-build/review-fixes-tests.log` and `../rc505-official-native-simulation-build/review-fixes-tests.log`. A subsequently strengthened FREEZE balance-transition assertion also passes the focused official-parameters test. Builds/tests remain pinned to CPUs 0–5. These elapsed times are not performance or hardware validation.
- The new actual HTTP schema is in `../rc505-official-native-simulation-build/official-runtime-schema.json`, now including the replacement capability. SHA-256: `f6885342808b3b8d0f3bee60ed8e55c3f735800c8f3026a89801f96066a3aa45`. Effect/parameter coverage is unchanged by these correctness fixes.

## Source-aware controls and remaining repeat/scatter rows (2026-10-22)

- Added BEAT REPEAT TYPE (FORWARD / REWIND / MIX) and LENGTH, and BEAT SCATTER LENGTH. Values use the exact generated manual domains, not a continuous negative-number range. SCATTER's documented 1/32-note length is an explicit official-mode opt-in; the legacy five-choice primitive domain is unchanged. THRU bypasses slicing/repetition. Factory SCATTER TYPE patterns remain unavailable rather than invented.
- Added `beat_shift` as the 53rd catalog entry, appending it without reordering the prior 52 entries or changing the 252 legacy canonical parameters / 2 compatibility aliases. TYPE and SHIFT now project to the existing finalized-loop transport readhead. FUTURE reads the actual future location in the stored loop; PAST reads the corresponding previous location. It is not a causal history-buffer approximation.
- Official VINYL FLICK likewise projects to the actual loop source: 0–100 maps to a 0–2x target speed, retaining the software's existing second-order motor/brake behavior. Sustained 2x is possible across arbitrary loop wraps. The existing legacy VINYL history processor remains unchanged for extension-only configurations. Official source mode passes through the later insert without applying that history processor a second time. FLICK advertises no additional generic parameter ramp; the existing motor law owns the speed trajectory. This is a clean-room interface model, not verified hardware mechanics.
- Source-only official fields require a source-capable context. A bare streaming catalog processor rejects them. The host permits the last four official FX only in Track slot A; source-only BEAT SHIFT/VINYL additionally require shared A in the currently implemented MULTI model; Input, slot B and private source-only inserts remain rejected before mutation. Source controls are explicitly `partial_source_modes`, not full-mode equivalence. Only finalized forward loop playback is supported; recording, overdubbing, LIVE pitch and reverse processing remain unsupported. The status is exposed at `nativeTracks[i].loopTransportStatus`, including `unsupportedPitchProcessing`.
- Each track retains its underlying transport control configuration while the shared official source overlay is active. Bypass, clearing, replacing, or leaving official mode restores all five underlying configurations. Manual transport changes made while an overlay is active are retained for restoration. Restoration crossfades from the current playback time; it does not rewind to a historical playback phase. Pitch conflicts fall back to the underlying configuration for the affected track and report an explicit unsupported status. No source-control allocation is introduced in the audio callback.
- Audio tests verify exact stereo FUTURE and PAST sample positions, THRU, live TYPE changes, all-five-track restoration and bypass/replace cleanup. A stored 10 Hz loop at FLICK 100 produces 20 Hz through more than 40 loop wraps, then reaches a stationary readhead at FLICK 0. Source audio matches across 13-frame and 127-frame callback chunks. The source callback test records zero allocations. SCATTER's exact 1/32 timing and longest whole-note timing are checked at 8, 48 and 192 kHz. HTTP tests exercise real recording / finalized / playing / overdubbing / pitch states, not schema mocks alone.
- **Validation:** All **52/52 portable CTest targets pass**, 21.81 seconds; all **5/5 simulation/HTTP targets pass**, 6.07 seconds. Logs: `../rc505-official-native-build/source-tests.log` and `../rc505-official-native-simulation-build/source-tests.log`; matching build logs are named `source-build.log`. All builds/tests remain on CPUs 0–5. These durations are functional-test wall time, not performance measurements. No physical device, hardware parity, XRUN or real-time deadline result is claimed. The earlier frozen 52-algorithm timing comparison must retain its original commit attribution; a pass-through insert benchmark cannot measure the source readhead work.
- The actual HTTP schema is `../rc505-official-native-simulation-build/official-runtime-schema.json`, SHA-256 `15b3333cc31251f38972afa2d9dfcfa78eb07f142bac712511a647703d2234a6`. It retains replacement capability and schema version 1, and now advertises 265 runtime official descriptors, including two variant routing selectors. The expected source-row coverage is 252 functional + 3 partial-source-mode + 12 unavailable rows out of 267; the shared coverage generator independently reconciles variant rows and the 16 indexed STEP LEVEL controls. The remaining unavailable rows are seven undocumented MODE definitions, AUTO RIFF factory PHRASE, two external carrier-source routes, factory PATTERN SLICER patterns, and factory SCATTER TYPE patterns.


## SCATTER official ownership correction (2026-10-22)

- Read-only review found that the official-mode ownership guard spelled the legacy key `sliceBeats`, while the actual accepted catalog key is `slice_beats`. Corrected that guard so a later complete legacy macro replay cannot overwrite official LENGTH. Legacy-only behavior and software-only SCATTER extensions remain unchanged.
- The new regression first failed on the old implementation's rendered-audio equality assertion, then passed with the one-key correction. It tests initial plus mid-playback macro replays, and mid-playback replay independently, for exact 1/32-note, quarter-note, whole-note and THRU settings. It compares actual stereo samples and verifies the first changed output sample occurs at the correct slice duration; THRU remains bit-identical to the dry signal.
- Focused official-parameter test: **1/1 pass**, 7.12 seconds. Full portable suite: **52/52 pass**, 21.92 seconds. Full simulation/HTTP suite: **5/5 pass**, 5.71 seconds. All run on CPUs 0–5. Evidence logs are `../rc505-official-native-build/scatter-ownership-red.log`, `scatter-ownership-focused.log`, `scatter-ownership-tests.log`, and `../rc505-official-native-simulation-build/scatter-ownership-tests.log`. Schema and coverage are unchanged by this correction.


## VOCODER TRACK1–5 same-block carrier checkpoint

One additional manual source row, CARRIER, is partially supported with its real TRACK1–5 choices. The descriptor advertises exactly numeric ordinals 6–10, default 6 (TRACK1), and `partial_source_modes`. Physical MIC/INST choices 0–5 and CARRIER THRU remain rejected. Every first official VOCODER opt-in requires an attached carrier context before materializing defaults. Legacy-only VOCODER retains its prior synthesized carrier and mono routing.

The audio callback previews only requested, finalized Playing loop sources. It copies a five-field playback cursor and uses the same reader math as real playback, including BeatShift, Vinyl motor/brake and transition fades. Preview neither processes nor advances the real looper. The tap is current-block, pre-FX and pre-LIVE-pitch; there is no previous-block carrier cache or inter-track processing-order dependency. Recording, overdubbing, stopped, empty, history-pinned and pitch-conflicted sources provide explicit zero arrays to VoiceInput, never its null-pointer modulator fallback. Carrier filter state is cleared when availability is lost. Mono input is duplicated to stereo for an official external-carrier VOCODER, preserving independently routed left/right carrier audio.

`nativeTracks[i].vocoderCarrierStatus` is an API diagnostic: `notRequested`, `ready`, `empty`, `stopped`, `unsupportedRecording`, `unsupportedOverdubbing`, `unsupportedPitchProcessing`, `historyPinned`, or `bufferUnavailable`. Stopped-engine/reset status is notRequested; oversized split-input callbacks publish bufferUnavailable for requested sources. This does not claim a new dynamic status UI.

Evidence:
- Preview and real playback are sample-identical at 8/48/192 kHz, mono/stereo storage, repeated previews and 1/13/127/4096-frame blocks; source state and playhead remain unchanged by preview. Off, BeatShift, Vinyl and transition/fade paths are covered.
- All five source tracks match an explicit VoiceInput PCM reference. Input routing is chunk-invariant at 13/127/4096 frames. Swapping private Track1/Track5 modulator/carrier roles produces the same PCM, independently of track order. Current-block reference audio rules out an added carrier block delay.
- Mono modulation with left-only and right-only stereo carriers matches independent PCM references; the other channel remains silent. Legacy mono remains mono.
- Empty, recording, stopped, overdubbing, pitch conflict, injected actual history-pin condition, and invalid buffer capacity exercise explicit wet silence. Clear, finalized-PCM import/restore, reprepare and replacement are covered. Existing history and project-import suites also pass; the carrier pin guard test itself is unit-level, not a hardware/concurrent history stress claim.
- Bare/unattached official controls and physical ordinals 0–5 reject before defaults; invalid controls and tempo broadcasts leave legacy PCM exactly unchanged. Legacy carrier/mix macro replay cannot override active official source/balance. Zero callback/control-processing allocations are asserted.
- HTTP verifies descriptor subset/default/limitation, rejection of physical controls for the correct domain reason without source activation, recording/playback/overdub/pitch state changes, stop cleanup and replacement.

Workspace logs: `../rc505-official-native-build/carrier-full-build.log`, `carrier-full-ctest.log`; `../rc505-official-native-simulation-build/carrier-build.log`, `carrier-http-ctest.log`. Current schema path and hash are in the summary above.

Resource boundary: five fixed stereo 4096-frame preview buffers add 160 KiB per NativeAudioCore, and the additional two 4096-frame carrier arrays add 32 KiB per catalog VOCODER instance. Requested playback readers run once for preview and once for real playback. The change adds bounded CPU work and memory; no hardware deadline, XRUN or performance-equivalence claim is made. LIVE pitch/reverse, recording/overdub carrier modes and physical input mappings remain unavailable, not synthesized approximations.


## Official mono-input spatial routing correction

The Input bank promotes a mono hardware source to two identical input channels whenever any selected catalog processor has explicitly activated its official parameters. This is a read-only query of the existing first-opt-in flag, including explicit variant selection; internal BPM/meter updates and rejected parameters do not activate it. The previous legacy MANUAL PAN stereo behavior is preserved. Other wholly legacy banks retain their original mono processing. This fixes mono AUTO PAN silently skipping its stereo-only pan computation and preserves the right-side output of official spatial delay/modulation algorithms.

Actual PCM tests cover:
- Mono-input AUTO PAN, PANNING DELAY and CHORUS equal their duplicated-stereo input references and produce distinct left/right audio.
- AUTO PAN RATE, DEPTH and WAVEFORM changes are audibly measurable on mono input; zero DEPTH settles to identical channels.
- STEREO ENHANCE is tested with stereo side information generated by an upstream AUTO PAN inside the same mono-input bank. Changing ENHANCE changes the PCM. The existing M/S model widens existing stereo information; no claim is made that it invents width from a perfectly identical-channel signal.
- All four representative legacy mono paths remain mono, with bit-identical PCM when internal BPM/meter broadcasts are added. Invalid official values do not activate stereo routing; an explicit ROLL variant does activate the official flag.
- These routes remain callback-allocation-free. Stereo promotion may process two DSP channels where legacy mono processed one; it is not a zero-cost optimization or a hardware deadline claim.

Final strict builds pass. Portable CTest: **52/52**, 23.36 seconds. Headless simulation/HTTP CTest: **5/5**, 5.84 seconds. Logs: `../rc505-official-native-build/mono-spatial-focused-build.log`, `mono-spatial-focused.log`, `mono-spatial-full-build.log`, `mono-spatial-full-ctest.log`; `../rc505-official-native-simulation-build/mono-spatial-build.log`, `mono-spatial-http-ctest.log`. All processes used CPUs 0–5. Runtime schema and coverage counts are unchanged from the carrier checkpoint.
