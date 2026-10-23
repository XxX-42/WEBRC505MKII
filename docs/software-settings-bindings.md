# Software settings provider bindings

Official source: [BOSS RC-505mkII Parameter Guide v1.3](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf), printed page 4, verified 2026-10-23.

REC ACTION selects Recording to Overdubbing to Playback, or Recording to Playback to Overdubbing. Browser binds this to existing recorded PCM publication and the overdub capture provider. Native explicitly reports this capability unavailable.

QUANTIZE OFF starts a take immediately. MEASURE waits for the measure boundary where an existing master grid is available. Both retain existing measure-aligned recording completion. Browser currently uses its established master-loop transport grid; rhythm-only and MIDI quantization are not claimed. Native does not expose these recording options.

Auto Rec sensitivity and Bounce source selection are explicitly unavailable: neither provider currently binds these fields to an input detection or bounce PCM path. Physical routing, independent hardware outputs, and phantom power are not represented by the software mixer.

Software mixer MAIN scales loop playback and rhythm. Software monitoring bypasses MAIN. MASTER scales final software output including monitoring. Track levels scale each track playback independently before the shared sum. Both providers expose immutable `getMixerState()` snapshots and validated `setMixerLevel()` writes (0-200). Native reports `mixerLevels` in channel order MAIN, MASTER, tracks 1-5; an older bridge without this field reports unavailable.

Browser PCM-history tests exercise OFF/MEASURE start scheduling, measure-aligned PCM completion and the REC/DUB state and provider handoff. Mixer tests exercise independent Browser AudioParams and track binding. Native callback tests exercise independent PCM amplitude and track isolation. These are software tests, not physical measurements.
