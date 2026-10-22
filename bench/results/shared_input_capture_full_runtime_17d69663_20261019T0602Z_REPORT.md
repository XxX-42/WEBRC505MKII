# Shared Browser input-capture diagnostic

Source baseline: `17d69663bd27ed65c893a7ed5afde4a74f5230c9` (`codex/rc505-recovery-20261018`)
Date: 2026-10-19 UTC

This diagnostic adds an opt-in synthetic input route through the production `BrowserAudioEngine` shared capture tap and a result checker for exact frame-range acknowledgements. It does not change production runtime code. Synthetic stereo oscillators replace the already-authorized input stream only inside the benchmark; no microphone, device, or permission request is used.

## Tap-on run

```sh
node bench/run_browser_audio_worklet_stress.mjs --duration-seconds 60 --profile full-runtime --operation-interval-seconds 30 --diagnostic-shared-input-capture --browser /tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell --output bench/results/shared_input_capture_full_runtime_record_17d69663_20261019T0602Z.json
```

- Google Chrome for Testing headless shell 154.0.8037.57, Node v24.19.0, 44.1 kHz, 60.001 s wall time.
- Topology was 36 initial instrumented worklets: unchanged 35-node full-runtime graph plus one persistent shared input-capture worklet. Cumulative node creation was 37 after the timed recording/restore; the output records 31 persistent, one retired, and five active processors at end.
- The test-only instrumentation allocated 84.8865 MiB of SharedArrayBuffer. It is not application audio memory and can affect scheduling.
- One production `TrackAudio` clear/record/restore operation completed. The tap acknowledged exactly `[1515776, 1539712)`: 23,936 stereo frames, zero dropped frames, zero overflows, one `RECORD_COMPLETE`.
- AudioContext progression was 59.4808 s / 60.0011 s = 99.1328%, above the unchanged 95% software progression guard. The output sentinel passed. Estimated missing callbacks and callback errors were zero.
- The input-tap callback timer was `Date.now()` with zero positive-resolution samples across the probe. Tap per-callback CPU, P99/P99.9, and deadline eligibility are therefore **NOT MEASURED**.

Raw outputs: `shared_input_capture_full_runtime_record_17d69663_20261019T0602Z.json`, `.progress.json`, `.status.json`.

## Matched no-tap baseline

```sh
node bench/run_browser_audio_worklet_stress.mjs --duration-seconds 60 --profile full-runtime --operation-interval-seconds 30 --browser /tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell --output bench/results/shared_input_capture_full_runtime_baseline_17d69663_20261019T0603Z.json
```

- Same pinned source, browser, sample rate, profile, timed operation cadence, and instrumentation; 35 initial worklets and 37 cumulative nodes.
- The run terminated with the existing callback-coverage failure. The recorder was asked to capture 30,336 frames but processed 29,568: 768 missing frames (six 128-frame quanta), 97.4684% coverage, zero callback errors, zero recording overflow/drop reports. The output signal sentinel passed.
- AudioContext advanced 59.3357 s in 60.0496 s wall time (about 98.81%). That software clock result does not cure the recorder coverage failure.

Raw outputs: `shared_input_capture_full_runtime_baseline_17d69663_20261019T0603Z.failure.json`, `.progress.json`, `.status.json`.

## Setup smoke and scope

A 5.0506 s preflight setup smoke completed on the tap-enabled 36-node graph, advancing AudioContext by 5.1432 s. Preflight does not collect acceptance callback counts or run a timed record, so it is only evidence that the graph could be prepared.

The tap-on record and no-tap baseline were one sequential A/B pair, not randomized/repeated ABBA. They differ by the extra persistent tap and use separate browser runs; the observed context-progress ratios are not evidence of tap CPU benefit or regression. The exact capture result supports this single recording case only. It is not a 30-minute Gate, does not measure precise callback timing, does not demonstrate audio quality, and does not measure hardware output or hardware XRUNs.

The runner now rejects tap diagnostics when LIVE_POLY/private FX are disabled, a direct source is added, or more than one timed recording is planned. This keeps this run’s topology and single-capture scope explicit.

## Overdub design notes for the next slice

The tap is a plausible shared input source, but the existing API is a recording-session/chunk-transfer interface rather than an arbitrary overdub input stream. TrackAudio's current overdub owns a fresh `rc505-overdub-processor`, initializes loop PCM and patch buffers, then activates/connects it. The worklet interprets `OVERDUB_INIT.startFrame` as the playback loop epoch, not the user’s request frame. Reusing the shared tap must therefore preserve two distinct coordinates:

1. input capture request boundary `R` (exact half-open frame range);
2. target loop epoch `E` (existing playback phase anchor).

For input frame `f`, place its patch at `mod(f - E, loopFrames)` only for `f >= R`; never move `E` to `R` merely to hide a late trigger. If a message arrives after `R`, a bounded pre-roll ring is required to backfill `[R, receivedFrame)`; otherwise reject/report a gap instead of silently shifting the start. STOP must also use an explicit request frame `S` and clip transferred patches to `[R,S)` so late chunks cannot add post-stop audio. The merge must remain stereo, preserve existing overdub feedback semantics, wait for `OVERDUB_STOPPED.patchesSent` and all corresponding patches before source retirement, and make one history entry for the whole overdub session.

The existing shared tap has one bounded ring / capture coordinator and per-track capture sessions with chunk pools; it is not currently exposed to the overdub processor as a zero-copy stream. A session can capture post-Input-A–D-FX audio for the duration, but delivering it to the separate overdub worklet introduces chunk transfer and initialization latency. This could be less steady CPU than five always-running standby overdub worklets, but adds copying/transfer, pool ownership, possible input-to-loop alignment work, and recording/overdub arbitration. It does not inherently reproduce a TrackAudio playback loop's track-FX/rhythm/feedback route. A safe next step is a bounded, frame-tagged tap-to-overdub patch prototype with per-track exclusivity and an explicit loop epoch; profile it against the current one-worklet-per-active-overdub path before choosing it. Do not add five standbys by default.

## Raw evidence SHA-256

```text
33038564b008860fdb9e1bbb331fa8d0fd3564c6c701b6d8564b87c8064eaa4d  bench/browser_audio_worklet_stress_page.js
c6cf8eee9ad518fd4e64a8080c0da8ce44e7e3924d3b6df39eec7cf4e0f4f937  bench/run_browser_audio_worklet_stress.mjs
7b7b08fb9d82d16af1c394b3023e5299f2a4a5462fa22d203ab8e42027b8dd71  bench/results/shared_input_capture_full_runtime_record_17d69663_20261019T0602Z.json
b7a6b728b6d072087fc8b142be93581e20b5d85fe3d439d374a4b96c01136cdb  bench/results/shared_input_capture_full_runtime_record_17d69663_20261019T0602Z.progress.json
cbea69fbcc4f0c32c7e2bca1dc5adc7f9af95853a3f44e9a7329e73b632705b9  bench/results/shared_input_capture_full_runtime_record_17d69663_20261019T0602Z.status.json
fa9a2f3552cdbad723c5cf02483aa4cb141ec93b9d43ac1f134014a9f5f221b4  bench/results/shared_input_capture_full_runtime_baseline_17d69663_20261019T0603Z.failure.json
7d1981c598ba56c924a3e0025f6366fd28f291577323ee37d32d04053de27ff9  bench/results/shared_input_capture_full_runtime_baseline_17d69663_20261019T0603Z.progress.json
6269f864db401a6657c7217adabf6aead73f539242edaf8ae1c8df6e3badf695  bench/results/shared_input_capture_full_runtime_baseline_17d69663_20261019T0603Z.status.json
45118fb7acdcbdb5aba65cd209a7dc9309de377b3bea659feac16f1902caba98  bench/results/shared_input_capture_full_runtime_smoke_17d69663_20261019T0601Z.json
1080a8b9c99eedb2d9d359a88deb3887f2661f37310b9e255c441808aa6ef62e  bench/results/shared_input_capture_full_runtime_smoke_17d69663_20261019T0601Z.progress.json
ca3185d69da7da1b7dd9c3f8b0e1bdad67fc26dea50b03c5a4bf334004f85607  bench/results/shared_input_capture_full_runtime_smoke_17d69663_20261019T0601Z.status.json
```
