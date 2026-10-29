# Native LOOP SYNC and recording quantization

## Current Native capability

Native LOOP SYNC and REC QUANTIZE controls remain unavailable. The Native bridge
now exposes a narrow Rhythm-measure scheduling command, but the Classic editor
keeps both controls disabled and `nativeRecordPlay.quantizeAvailable` remains
false. No write can silently fall back to immediate recording while claiming
quantization.

Native publishes a read-only Rhythm phase snapshot containing the callback
sample frame, phase epoch, origin, measure ordinal and boundaries, and meter.
The snapshot comes from the callback-owned Rhythm timeline; a bounded lock-free
atomic publication lets status readers reject an unstable snapshot without
making the callback wait. Rhythm reconfiguration and runtime reset advance the
phase epoch. An internal callback scheduler now accepts REC/STOP against the
published next Rhythm measure boundary, then applies the Looper transition
before the exact sample in a callback block. Each request is tied to both the
Rhythm epoch and applied tempo revision. Cancellation and dispatch race through
one atomic state transition; an epoch/settings change, missed frame, cancellation,
or rejected Looper transition receives a distinct status. Track commands,
history pins, and project imports are held out while a scheduled transition is
pending. The callback path uses fixed storage and does not allocate or lock.

This is a limited software command path, not a complete Native feature. The
bridge reports `nativeRhythmFrameScheduling.available: true` for the explicitly
bounded next-measure command only. It accepts an empty-track REC with REC ACTION
set to REC->PLAY and a STOP on a recording track. It intentionally rejects
1SHOT and REVERSE. The UI does not call this path yet. Track status still does not
provide a recording-origin frame plus persisted measure metadata from which a
second track's phrase phase can be recovered, and MIDI Sync is not a verified
phase source. BPM or a callback frame counter alone is not evidence of a measure
boundary. Scheduled REC also rejects enabled or unapplied Bounce settings so a
take cannot start before its Bounce input is prepared.

## Roland behavior that informs a future implementation

The [RC-505mkII Parameter Guide v1.3+](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf)
describes LOOP SYNC as using memory tempo or a synchronized track for recording
and playback. Its MEASURE mode starts at a measure and adjusts recorded track
length in measure units; LOOP LENGTH mode uses the configured loop length. The
guide describes TEMPO SYNC separately as changing playback speed, with PITCH or
XFADE behavior.

REC QUANTIZE applies only to recording and only on LOOP SYNC tracks. MEASURE
aligns the recording start to a measure. OFF starts immediately, while stop
still aligns the take to the measure length of an existing LOOP SYNC track or
Rhythm. The documented grid sources are running Rhythm, an already-recorded
LOOP SYNC track, or MIDI Sync.

The guide describes REVERSE and 1SHOT separately, but does not specify their
interaction with LOOP SYNC recording quantization. Native must not infer that
those combinations are supported from the availability of reverse or one-shot
playback controls. Until their interaction is documented and an implementation
has evidence for it, synchronized recording must fail closed when either mode
is active.

## Requirements before enabling Native controls

- Publish one authoritative phase source and its revision. For Rhythm, expose
  the callback-owned measure origin and meter; for an existing synchronized
  track, retain its recording-origin frame and measure-count/length metadata;
  for MIDI Sync, consume and validate a clock phase rather than only BPM or
  observed pulse count.
- Schedule REC start and stop against that phase in the audio callback, with
  requested, applied, cancelled, and faulted acknowledgements tied to the same
  phase/settings revision. A main-thread timer or a command acknowledged only
  at an arbitrary callback boundary is not quantized recording.
- Keep the bridge capability disabled until the above internal Rhythm scheduler
  is integrated with the user command path and all supported REC ACTION,
  history, import, and multi-track cases have explicit evidence.
- Preserve incumbent PCM if a scheduled start/stop becomes stale, is cancelled,
  or loses its phase source. Do not silently fall back to immediate recording
  while reporting quantization as enabled.
- Establish supported and unsupported combinations for reverse and 1SHOT from
  documented behavior or explicit software/hardware evidence before enabling
  those modes with LOOP SYNC.
- Validate software callback scheduling separately from device timing,
  physical RC-505 behavior, acoustic latency, and long-run drift. Do not call a
  callback-frame schedule hardware sample-accurate without matching evidence.

The Browser implementation and its narrower phase constraints are documented
in [BROWSER_LOOP_SYNC.md](BROWSER_LOOP_SYNC.md). Its software-path tests do not
validate the Native callback or physical hardware.
