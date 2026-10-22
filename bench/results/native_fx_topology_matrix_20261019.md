# Native FX topology benchmark extension (19 Oct 2026)

Purpose: make Native callback timing scenarios prove which banks are configured and actually routed. This is a portable CPU simulation, not an RtAudio/device or hardware test. Default invocation remains the existing five tracks × A–D private FX workload; the new scenarios are explicit opt-ins.

## Topology gates

- `baseline`: 20 active private per-track A–D FX, Input/shared banks empty, rhythm disabled
- `extended`: baseline + 1 active Input FX (`filter.lpf`) + 1 active shared playback FX (`chorus`) + rhythm enabled
- `all-banks`: baseline + 4 active Input FX (`filter.lpf`, `manual_pan`, `dynamics`, `radio`) + 4 active shared playback FX (`chorus`, `reverb`, `tape_echo`, `stereo_enhance`) + rhythm enabled

The all-banks graph is 28 catalog slots. A separate optional pitch route supports the Native single selected route; the full-pitch observation enables LIVE_POLY on track 1. The benchmark does not claim five concurrent independent Native pitch processors.

Every scenario feeds a synthetic nonzero 330 Hz mono input (0.1 peak) through the callback while Native input monitoring is disabled (`EngineConfig::monitoringEnabled=false`). With Input FX configured, it inspects the processor's post-callback scratch during warmup and requires nonzero output, proving the Input DSP path is active; this does not mean the input is audibly monitored. It verifies every configured processor ID, 48 kHz preparation, bypass state, and fault state. Rhythm scenarios require the rhythm engine enabled and observe at least one active generated voice during warmup. Current all-banks code also rechecks Input/shared processor health after the measured loop and exits nonzero on a fault. The 20 private tracks are checked before measurement and their callback fault status is checked afterward.

## Smoke evidence

`native_fx_topology_smoke_20261019T1454Z/` has the baseline, extended, and all-banks route smokes. They all passed. The extended route produced Input scratch peak 0.099 and reached 2 simultaneous rhythm voices; all-banks produced Input scratch peak 0.175 and reached 2 voices. The smoke uses only 256 measured callbacks and does not characterize timing. It predates the final after-measure health assertion.

`native_fx_topology_all_banks_smoke_20261019T1503Z/` reruns all-banks after that assertion. It passed with all 28 slots healthy after measurement, zero Input/shared faults, 0.100 source peak, 0.175 Input-stage output peak, 2 maximum observed active rhythm voices, and 32,768/32,768 finite measured output samples. This is a route/fault smoke, not a timing acceptance run.

`native_fx_topology_all_banks_smoke_20261019T1510Z/` reruns the all-banks smoke with an explicit runtime `inputMonitoringEnabled:false` field and assertion. It passed: the nonzero 0.100 input traversed the four Input DSP slots (post-Input scratch peak 0.175), rhythm reached 2 active voices, all routes remained healthy, Input/shared fault count was zero, and 32,768/32,768 output samples were finite. This remains a portable CPU route/fault smoke only.

## Full callback observations

All runs below use Release, 48 kHz, 64 frames/callback (hard callback budget 1.333 ms), five synthetic stereo 300-second loop tracks, 20 private FX, four Input FX, four shared FX, rhythm enabled, 5,000 warmup and 100,000 measured callbacks. Input is the same 0.1-peak synthetic sine. They use the portable CPU callback simulator. Native acceptance targets remain P99 ≤0.800 ms, P99.9 ≤1.067 ms, and hard maximum/deadline ≤1.333 ms; no result here passes the full real-time targets.

- `native_fx_topology_all_banks_20261019T1506Z/`: pitch off, final health-check harness. Mean 0.576 ms, P95 0.833 ms, P99 1.401 ms, P99.9 3.108 ms, max 26.162 ms; 1,104/100,000 callbacks exceeded 1.333 ms. 12.8M/12.8M output samples were finite; all routes remained healthy and all fault counts were zero.
- `native_fx_topology_all_banks_live_poly_20261019T1504Z/`: LIVE_POLY selected on track 1 (single Native pitch route), final health-check harness. Mean 0.646 ms, P95 1.129 ms, P99 2.223 ms, P99.9 4.755 ms, max 32.247 ms; 3,333/100,000 exceeded 1.333 ms. 12.8M/12.8M output samples were finite; pitch route was active with no fallback, all FX/rhythm routes remained healthy, and fault counts were zero.

The two timed runs above were collected before the harness began serializing the explicit `inputMonitoringEnabled` field. The measured callback body/topology and config default were already unchanged (`monitoringEnabled=false`); the follow-up 1510Z smoke directly verifies that status. These two timing runs are not a controlled pitch A/B comparison; no causal performance claim is made from their difference.

An earlier pair in `...1457Z/` and `...1458Z/` used the same callback graph before the final after-measure reporting assertions. Those show run-to-run timing spread, but do not assert post-measure Input/shared health and are not substituted for the final-harness results.

Full Native portable CTest on the final source tree: 46/46 passed. No hardware/XRUN result is available.
