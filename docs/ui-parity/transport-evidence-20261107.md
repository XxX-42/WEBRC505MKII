# Recording and group-transport evidence — 2026-11-07

## Official boundary

Sources checked on this date: [Parameter Guide, version 1.3+, pp. 3–4](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf),
[Owner's Manual, p. 4](https://static.roland.com/assets/media/pdf/RC-505mk2_eng02_W.pdf).

`OFFICIAL_CONFIRMED`:

- Recording quantization does not govern overdubbing or playback.
- Loop synchronization has distinct immediate, measure-boundary and
  configured-loop-length start modes. Recording length alignment is separate
  from the start decision.
- Disabling recording-start quantization does not remove synchronized
  recording-end length adjustment.
- Automatic recording first arms on the record control, then captures after
  input passes its sensitivity condition. Sensitivity ranges from 1 to 100,
  with default 50.
- The panel's group control starts tracks together, or stops them when a track
  is already playing or recording. Assigned variants may handle fades
  differently.

`UNKNOWN`: physical sensitivity-to-amplitude transfer, detector tap/channel
aggregation, exact standby blink frequency, pre-trigger history, and the
interaction priority of automatic onset with each synchronization mode.
Do not infer these from the software's engineering defaults.

## Repository observations

These are implementation facts at integrated source `f4e9f99`, not Roland
rules. Later development branches need their own verification.

| Observation | Source | Consequence |
|---|---|---|
| Native rejects synchronized recording with quantization disabled because end-length adjustment is not implemented | [`setRecordPlaySettings` and `setTrackLoopSync`](../../src/audio/NativeAudioEngine.ts) | A provider limitation; do not describe it as a hardware dependency |
| Native synchronized playback requires current PCM phase provenance and a stable Rhythm measure source | [`getRhythmSyncPlayAvailability`](../../src/audio/NativeAudioEngine.ts) | Keep the safety checks until additional phase providers are implemented |
| The track model defines three synchronization modes; the audited capture/play paths do not dispatch on that property | [`LoopSyncMode`](../../src/core/types.ts), [`TrackAudio`](../../src/audio/TrackAudio.ts) | Merely storing a mode does not implement its timing |
| Integrated Native group operations reject enabled synchronized tracks | [`playAllTracks` / `stopAllTracks`](../../src/audio/NativeAudioEngine.ts) | The isolated non-synchronized batch work does not close this gap |

## Required implementation evidence

Keep start mode, recording-start quantization and recording-end alignment as
separate inputs to the eventual scheduling contract. Tests must observe actual
captured PCM and playback sample frames, not only selected LCD values. Include
nonzero measure origins, fractional cumulative frame boundaries, input on one
stereo side, cancellation, tempo/phase changes and retained incumbent PCM.

A future group implementation must cover mixed synchronization settings and
each supported start/stop mode. Unsupported combinations need a precise reason;
removing the existing guards is not implementation evidence.
