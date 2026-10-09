# Native five-track stereo core review

Root independently reviewed the standalone software core/host snapshot
`bench/results/native_stereo_pan_20261009T142245Z` on 2026-10-09. Its ten
compiler inputs retain exact bytes; the source-set SHA-256 is
`4d5057fbf7033a944a14d5eb0d8ea296f03a4c3c331902335bcaa88e64cc7c14`.
Canonical input is each manifest row's UTF-8 `path`, NUL, file SHA-256, LF,
in path order. Root also checked the ten earlier TEMP source copies and ran
both resulting test executables independently: each exited 0.

The core stores five separate interleaved stereo loops. Stereo input channels
remain independent; the host duplicates a one-channel input into left/right.
It adapts variable callback lengths to chunks of at most 64 frames. Recording,
playback and additive overdubbing operate on the two samples at each loop
frame separately. Disabling a track input route writes silence while recording
continues on the same timeline. The callback uses fixed scratch storage and
a bounded command queue; the host allocation guard passed.

The new regression fixtures record five distinct left/right signatures through
the host, solo each track and check identity without cross-track contamination.
Stereo panning follows the Browser's stereo panner behavior: center preserves
both input levels; hard left sums into left; hard right sums into right. This
fixes the earlier mono equal-power formula that attenuated both stereo channels
at center. Mono duplication is tested separately. Mute/start/stop/clear and
monitor gates use finite 10 ms fades at 48 kHz.

This evidence qualifies the stated standalone core checks only. Native bridge,
frontend and complete CMake integration are separate changes under review.
The new Native core has no Replace 1/2, Undo/Redo, marked history, Rec Back,
project/Memory or Bounce implementation. It must not be described as matching
the Browser's existing history and project features. No physical device or
bridge server was started. Full graph deadline distributions, XRUNs, pitch,
all FX and 30-minute stress acceptance remain pending; no runtime Gate passes
because of these two standalone tests.
