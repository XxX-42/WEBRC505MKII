# Remaining real-device acceptance (not a claim of completion)

## Separate blockers
- `E2E_ENVIRONMENT_BLOCKED`: this executor's Chromium cannot create required local Unix sockets. All 101 current E2E cases failed before browser launch completed. This is an execution environment limitation, not a sound-card limitation and not evidence of 101 application regressions.
- `LOCAL_DEPLOY_BLOCKED`: no authorized user-computer execution is used. A cloud same-process Vite HTTP smoke is not a deployment on the user's Windows machine.
- `HARDWARE_BLOCKED`: there is no physical audio interface, physical loopback, MIDI hardware, or supported real-device driver in the cloud test path. Device-free Native DSP timing is not driver callback or XRUN acceptance.

## Minimal physical-device checklist after software environment is usable
1. Build the exact reported commit in Release on the intended Native target. Record OS, CPU/power mode, browser version, driver/backend, audio-interface model/firmware, device rate, and actual accepted buffer size. Do not substitute requested size for observed size.
2. At 44.1/48 kHz and supported 64/128/256-frame buffers, collect callback start/end timestamps, CPU usage, deadline misses, driver underrun/XRUN counters and actual sample count. If the backend exposes no counter, record null with that reason, never zero.
3. Run mono/stereo, one/five independent loop tracks; record, playback and overdub, with no FX, realistic FX and worst measured FX chains. Include UI meters, rhythm and real bridge traffic on the same engine. Check five different sources, L-only/R-only, live pitch modes, reverse where actually supported, and WAV stereo/interleave.
4. Collect loopback latency, peak/RMS/DC and listening captures. No pops, unexplained DC/peaks, missing samples, channel collapse/crosstalk, or altered loop history. Compare against the exact software baseline with authored controls unchanged; do not lower oversampling, FX quality, channels, or track count to pass.
5. Run 10 minutes and preferably 30–60 minutes of record/play/overdub/stop/reverse/FX/clear/re-record. Record memory slope, node/timer/listener counts, CPU drift, drops/overflow/XRUN, state errors and MIDI events. Unsupported operations are coverage gaps, not passes.
6. Compute budget = frames / actualRate * 1000 ms. At 48 kHz: 64 = 1.333333 ms, 128 = 2.666667 ms, 256 = 5.333333 ms. Target p99 < 50% of budget, max preferably < 80%, no normal-workload drops/overflow/XRUN. Report each failed or unavailable gate separately.

The software runners and machine-readable reports in this directory establish only their explicitly named scopes. They cannot certify Roland fidelity, acoustic quality, device latency, or strict real-time hardware readiness.
