# Native AUTO REC validation checkpoint — 2026-11-14

Implementation contract: [native-auto-rec-contract.md](native-auto-rec-contract.md).

## Scope

This adds the Native software provider for AUTO REC SW/SENS, callback-confirmed standby and sample-offset triggering, exact-generation cancellation, take-bound conditional STOP, and semantic Memory persistence. Default settings and older Memory files remain OFF / 50. Existing REC ACTION completion is reused. Unsupported target LOOP SYNC / MEASURE arming is rejected explicitly; it must not bypass detection through the ordinary scheduled-record path. Configuration remains editable independently of whether a selected track can currently arm.

`raw-peak-dbfs-v1` deliberately matches the Browser software approximation, not measured Roland detector behavior. Hardware threshold mapping, cadence and physical latency remain unverified.

## Evidence at this checkpoint

- Production build/type check PASS; six exact license artifacts verified.
- Latest combined targeted unit run: AUTO REC 22/22 and semantic Memory 34/34, **56/56 PASS**.
- Actual Classic UI simulation journeys: **2/2 PASS**, zero retries, unchanged default timeout; high-threshold standby/cancel leaves no PCM, low-threshold input triggers a take that stops and exports finite PCM. These focused journeys preceded the final rejection-recovery and combination guards; a complete final-source E2E run remains required.
- Real HTTP simulation Memory script PASS: prepared/committed AUTO REC settings are installed, armed import rejects without altering an existing track's PCM or project revision, and an old Memory restores OFF / 50. There is no single HTTP Memory-capture endpoint; capture guards are frontend/unit evidence.
- Current Native source Portable Debug ALL build and **55/55 CTest PASS**, 121.69s; Debug assertions are active. The separate prepared-bank Memory test is covered by the simulation suite and HTTP test, not by the portable main.
- Simulation Release + HQ ALL build and **17/17 CTest PASS**, 67.38s.
- Simulation host SHA256: `9b97b4d4ed16630231c34f50432b0cd344c52d93861c510e641e4b8e85b8d412`.
- Native core source SHA256: `1e4f2dbaa83b0d133b33acaae745e4f9b3aa688f74682b1a1a9db25b74927f62`.
- [AUTO REC callback sampling](native-auto-rec-performance-20261114.json): Release, 48kHz/64 frames, 3000 callbacks in each of five sequential cases. OFF / ON-unarmed / one armed / five armed / single-track last-frame trigger P99 were 44.5 / 41.3 / 60.3 / 41.5 / 43.4 microseconds. No sampled CPU-budget exceedance or tracked ordinary `new/new[]` allocation occurred. The graph otherwise has empty tracks, not a five-track FX performance workload. This is one non-interleaved, device-free run; it does not measure all allocation mechanisms, runtime locks, driver XRUNs, or physical latency. Budget exceedances are reported by the harness, not used to suppress results.
- Fresh complete frontend run: **2931/2931 PASS**, zero failures or pending tests. JSON receipt: `rc505-autorec-final-unit-green-20261114.json` (local test artifacts). Final complete E2E is running; this checkpoint is not release or hardware acceptance.

## Failures and corrections retained

- Initial callback testing exposed an assertion checked after a new generation correctly cleared the prior cancel receipt; moved the assertion before re-arm while retaining the stale-scan rejection test. A diagnostic test process was stopped before its cause was proven; no pass was inferred from that interrupted run. Subsequent runs directed CRT diagnostics to stderr and retained assertions.
- Independent review fixed stale scanned generations, publish-order/claim races, conditional STOP take binding, explicit 409 recovery and asynchronous receipt cleanup preserving other owners. Generic HTTP 400 remains unknown because host serialization can fail after mutation.
- Simulation ALL initially failed because unit tests inherited the independently threaded simulation RtAudio header. A separate no-hardware support library fixes dependency selection without removing tests, stubbing gates or disabling warnings.
- First simulation CTest was 15/17: Memory attempted preparation before queued rhythm settings were callback-acknowledged; the rhythm provenance test raced the live phase clock. Tests now wait for the actual callback ACK and gate the test-only simulation clock for a fresh phase snapshot, preserving the original rejection assertions.
- First complete frontend run was **2884 passed / 47 failed** across 232 files (276.01s). Seven legacy bridge test doubles omitted the new unresolved-AUTO-REC receipt query, interrupting status/FX ACK installation. The doubles now explicitly report no outstanding receipt; production behavior and original ACK assertions are unchanged. Focused reruns of the seven files pass **80/80**; a fresh complete run is still required.
- STOP/CLEAR now return their Native promises through both Classic and Tech controllers and surface synchronous/asynchronous failures without automatic retry. The reviewed targeted controller suites passed 41/41. A bridge-level lost-cancel regression passes with the AUTO REC suite (23/23): reconciliation only reads status, and an explicit user retry retains the same host/intent/generation. This is simulated protocol evidence, not a real-network or hardware test.

## Remaining gates

Final full E2E, loaded-graph performance regression and current-source local startup remain to be recorded. AUTO REC scanning/triggering has a focused software sample, not whole-instrument performance acceptance. Zero tracked callback allocation in targeted tests does not prove runtime zero locks or physical XRUN behavior. No real RC-505 device, hardware Golden Master, calibrated LED measurements or physical loopback is claimed.
