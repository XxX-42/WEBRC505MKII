# Native Rhythm recording quantization

## Supported slice

Native supports Rhythm-phased recording and measure-boundary stop on tracks enabled for
LOOP SYNC. Synchronized playback is unavailable because the host does not retain
phase provenance for track PCM. A track must be empty when LOOP SYNC is enabled. REC ACTION must be
REC->PLAY, REC QUANTIZE must be MEASURE, Native Rhythm must be running with a
stable callback-published measure phase, and REVERSE, 1SHOT, Bounce, overdub,
and MIDI Sync are unsupported. REC QUANTIZE OFF with any LOOP SYNC track is
rejected because its exact stop-length behavior is not implemented. The
RC-505 guide lists Rhythm, an existing synchronized track, and MIDI Sync as
alternative phase sources; this implementation uses Native Rhythm only and
does not estimate phase from BPM or the UI clock.

With LOOP SYNC on, MEASURE schedules the record start at the next Native
Rhythm measure. Stopping a recording schedules the stop at the next Native
Rhythm measure. Scheduled transitions return the callback-applied frame, and
Native publishes the finalized PCM frame count from the loop store. The
hardware's REC QUANTIZE OFF immediate-start plus measure-length stop behavior
is not implemented, so the Native UI and host reject OFF whenever any LOOP
SYNC track is enabled.
Native reports finalized PCM frame counts, but does not retain the per-track
phase provenance needed to align a later playback start. All synchronized PLAY
requests are therefore rejected. A cancelled or stale scheduled start does not
clear any incumbent loop; a scheduled REC is accepted only for an empty track.

While a synchronized take is recording or its scheduled start is pending, the
host rejects Native Rhythm configuration changes, audio reconfiguration, and
engine stop so the phase cannot be invalidated through these controls. If a
stable phase becomes unavailable, STOP uses an explicit callback-acknowledged
emergency path. It stops at the next processed callback and retains the PCM
captured so far; that emergency take may not end on a measure boundary. The
engine cannot be stopped until the synchronized recording is finalized.

The Classic Memory editor exposes REC QUANTIZE only while the Native Rhythm
phase is available. LOOP SYNC and REC QUANTIZE settings are included in Native
Memory capture and restored with the archive. Setting changes are read back
before the UI accepts them. Rhythm scheduling requests retain their revision,
phase epoch, host incarnation and intent ID so a lost response can be
reconciled or cancelled without replaying the operation.

This slice captures the actual PCM frame count but does not assign the
hardware's AUTO phrase measure count, manually selected LOOP LENGTH, phase
recovery from an existing synchronized phrase, MIDI clock phase, STOP MODE,
Auto Rec, or REC->DUB. Existing PCM is preserved. Imported or edited loops
remain unavailable for synchronized playback until per-track phase provenance
is retained.

## Roland behavior

The [RC-505mkII Parameter Guide v1.3+](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf)
says REC QUANTIZE applies only to LOOP SYNC tracks. It documents three
conditions that enable loop quantization: Rhythm is on, an already-recorded
LOOP SYNC track exists, or MIDI Sync is on. These are alternate sources, not
an exclusive source selection. OFF starts recording immediately and aligns
the take length to the measure; MEASURE aligns the recording start. The guide
also documents LOOP LENGTH separately: AUTO derives the phrase length from the
first recorded phrase, while manual values specify a measure count.

## Evidence boundary

Callback-frame scheduling, exact software PCM length, setting readback,
cancellation, and Memory round-trips are software-path evidence. They do not
establish device timing, physical RC-505 behavior, acoustic latency, or
long-run drift. Existing LOOP SYNC/MIDI phase sources and playback behavior
remain unavailable in Native.
