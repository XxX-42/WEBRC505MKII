# Browser Bounce

The Browser implementation has a REC-level BOUNCE SW, per-destination TRACK BOUNCE IN and five independent BOUNCE TRACK source switches. The current destination is excluded from its own source mask. The controls are in the Classic LCD; Native remains unavailable until it has an actual audio provider. Roland describes the source and destination selection in its [Bounce instructions](https://support.roland.com/hc/en-us/articles/4410019121051-RC-505mkII-How-do-I-mix-and-record-playback-sound-from-multiple-tracks).

The Browser shared input-capture worklet mixes selected stereo playback sources with the target's selected raw or processed input, including overdub startup backfill. An active session retains its initial source mask; the setter rejects edits while any track is recording, armed or overdubbing. Memory records all authored switches and defaults them to OFF for older envelopes.

Source signals are currently taken at `playbackSourceOutput`, before the source track's private and shared Track FX. Roland's public instructions do not establish the exact internal tap, gain or clipping behavior; this is an engineering implementation and is not proof of hardware audio equivalence. Actual RC-505 hardware comparison is still required.

`tests/e2e/browser-input-capture.spec.ts` exercises the Classic LCD switches, a second playing track, the target recording, stereo PCM output and the active-session edit lock. Worklet and Memory cases are covered by the Browser Bounce, shared capture and Browser Memory unit tests.
