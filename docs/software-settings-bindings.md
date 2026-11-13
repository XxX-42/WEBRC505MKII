# Software settings provider bindings

Official source: [BOSS RC-505mkII Parameter Guide v1.3](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf), printed page 4, verified 2026-10-23.

REC ACTION selects Recording to Overdubbing to Playback, or Recording to Playback to Overdubbing. Browser and capable Native hosts bind this to their recording and overdub providers.

QUANTIZE OFF starts a take immediately. Browser MEASURE uses its established master-loop transport grid; rhythm-only and MIDI quantization are not claimed. Capable Native hosts expose OFF and MEASURE with a valid Native Rhythm measure source, with additional LOOP SYNC restrictions.

Browser and capable Native hosts provide Auto Rec sensitivity and Bounce source selection. Native Auto Rec cannot arm with LOOP SYNC or MEASURE quantization; its detector is a software approximation, not a verified hardware threshold mapping. Native Bounce takes pre-insert track playback; hardware FX placement remains unverified. Physical routing, independent hardware outputs, and phantom power are not represented by the software mixer.

Browser and capable Native hosts provide per-track DUB MODE (OVERDUB, REPLACE1, REPLACE2), including Classic controls and Memory settings. Native waits for callback-applied readback. Browser provides track PAN. PAN-capable Native hosts expose L50–CENTER–R50 with renderer-applied revision readback; Classic displays confirmed values and disables unavailable hosts. Native semantic Memory preserves the five PAN settings. The stereo law follows Web Audio as an engineering compatibility choice, not a measured Roland law. See [Native PAN contract](native-pan-contract.md). These software paths do not establish physical audio parity.

Software mixer MAIN scales loop playback and rhythm. Software monitoring bypasses MAIN. MASTER scales final software output including monitoring. Track levels scale each track playback independently before the shared sum. Both providers expose immutable `getMixerState()` snapshots and validated `setMixerLevel()` writes (0-200). Native reports `mixerLevels` in channel order MAIN, MASTER, tracks 1-5; an older bridge without this field reports unavailable.

Browser PCM-history tests exercise OFF/MEASURE start scheduling, measure-aligned PCM completion and the REC/DUB state and provider handoff. Mixer tests exercise independent Browser AudioParams and track binding. Native callback tests exercise independent PCM amplitude and track isolation. These are software tests, not physical measurements.
