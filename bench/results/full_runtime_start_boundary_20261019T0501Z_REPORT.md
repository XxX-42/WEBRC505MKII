# Full-runtime capture start-boundary smoke

Result: strict callback-coverage failure, retained as a diagnostic (not a 30-minute acceptance run)

- Run began at 2026-10-19 05:01 UTC; requested 45 real-wall seconds; Google Chrome for Testing headless shell 154.0.8037.57; requested and reported AudioContext rate 44.1 kHz; 35 instrumented production worklets in the full-runtime graph.
- Reproduction command: `node bench/run_browser_audio_worklet_stress.mjs --duration-seconds 45 --profile full-runtime --operation-interval-seconds 5 --browser /tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell --output bench/results/full_runtime_start_boundary_20261019T0501Z.json`
- The high-level request frame is captured immediately before `TrackAudio.startRecording()` or `triggerRecord()`. The command frame is sampled before the `START_RECORD` / `OVERDUB_INIT` port message. First active processing is read from the worklet-side coverage counter. Coverage remains anchored at the high-level request frame.
- Recorder, slot 35 / track 1: request frame 497024; command frame 497024; first active frame 497920. The observed start gap is 896 frames = 7 × 128-frame quanta = 20.317 ms at 44.1 kHz. It covered 33536 of 34432 expected frames (97.3978%); stop frame 531456 had one matching `RECORD_COMPLETE` acknowledgement.
- Overdub, slot 37 / track 1: request 718848; command 718848; first active 719744. Gap is 896 frames / 7 quanta / 20.317 ms. It covered 16384 of 17280 frames (94.8148%); stop frame 736128 had one matching `OVERDUB_STOPPED` acknowledgement.
- Overdub, slot 38 / track 2: request 942208; command 942336 (+128 frames); first active 942976 (+768 frames from request, 640 from command). It covered 15872 of 16640 frames (95.3846%), but still fails because the complete initial callback gap is independently a failure condition. Stop frame 958848 had one matching `OVERDUB_STOPPED` acknowledgement.
- These are AudioContext/worklet sample-frame observations; the independent clock is only visible at AudioWorklet quanta. This demonstrates software start-path delay under this headless Chromium workload. It is not hardware XRUN or physical-device dropout evidence. No acoustic quality or endpoint-continuity conclusion is made.
- The 30-second 05:00 smoke planned zero dynamic record/overdub operations and is not used here. This artifact is the 05:01 run with actual recording and overdub operations.

Raw failure JSON: `full_runtime_start_boundary_20261019T0501Z.failure.json` (496 KB). It contains the detailed worklet counters, coverage intervals, ACKs, browser/runtime metadata and strict failure reason.
