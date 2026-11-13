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
- Portable Debug ALL and CTest previously passed 55/55; a final current-test-source rebuild/re-run is pending because the standalone Memory test received an additional callback ACK flush.
- Simulation Release + HQ ALL build and **17/17 CTest PASS**, 67.38s.
- Simulation host SHA256: `9b97b4d4ed16630231c34f50432b0cd344c52d93861c510e641e4b8e85b8d412`.
- Native core source SHA256: `1e4f2dbaa83b0d133b33acaae745e4f9b3aa688f74682b1a1a9db25b74927f62`.
- Complete frontend unit and final full E2E gates are pending. This checkpoint is not release or hardware acceptance.

## Failures and corrections retained

- Initial callback testing exposed an assertion checked after a new generation correctly cleared the prior cancel receipt; moved the assertion before re-arm while retaining the stale-scan rejection test. A diagnostic test process was stopped before its cause was proven; no pass was inferred from that interrupted run. Subsequent runs directed CRT diagnostics to stderr and retained assertions.
- Independent review fixed stale scanned generations, publish-order/claim races, conditional STOP take binding, explicit 409 recovery and asynchronous receipt cleanup preserving other owners. Generic HTTP 400 remains unknown because host serialization can fail after mutation.
- Simulation ALL initially failed because unit tests inherited the independently threaded simulation RtAudio header. A separate no-hardware support library fixes dependency selection without removing tests, stubbing gates or disabling warnings.
- First simulation CTest was 15/17: Memory attempted preparation before queued rhythm settings were callback-acknowledged; the rhythm provenance test raced the live phase clock. Tests now wait for the actual callback ACK and gate the test-only simulation clock for a fresh phase snapshot, preserving the original rejection assertions.

## Remaining gates

Fresh final portable CTest, complete frontend units, final full E2E, software real-time/performance regression and current-source local startup remain to be recorded. Zero callback allocation in targeted tests does not prove runtime zero locks or physical XRUN behavior. No real RC-505 device, hardware Golden Master, calibrated LED measurements or physical loopback is claimed.
