# WEBRC505MKII performance engineering, 2026-10-21

**Phase delivery. Final-source matrix and 30-minute real-wall functional soak are complete. Strict whole-app realtime acceptance remains unachieved; publication and real-browser/device gaps are explicit.**

## Baseline and preservation

The original clean local checkout was f1d0ea72e4a2109db253f68c6b2b477c8ea7ed11. GitHub main was verified as c4adc8970375873f28c6f137ea1369131d92aef4, including two newer UI commits. Independent branch `perf/rc505-20261021` merged that remote history without conflict, producing the test baseline dd7dbea3502993d9167c4af16aef5dce98577c9e. No force push or main overwrite is part of this work. The existing stale bundle origin was preserved, and the actual GitHub remote was separately named `github`.

The commit containing this report is the code/evidence batch. Evidence captured before that commit identifies the baseline HEAD plus exact dirty-worktree source and binary hashes; it must not be read as testing the baseline without modifications.

## Largest measured bottlenecks

1. Native PREAMP repeated frame-parameter derivation and previous-oversample ADAA primitive evaluation.
2. Browser PREAMP/DIST repeated exact primitive and invariant calculations.
3. Browser PHASER and MOD DELAY/TAPE ECHO clamp helpers in sampled hot paths.
4. Browser FDN reverb interpolation/mixing and remaining per-sample math.
5. Native residual PREAMP nonlinear processing, ROBOT pitch tracking and Signalsmith spectrum work.

Profiles are diagnostic samples, not comparable wall-time percentages across runs or proof of an exhaustive catalog maximum. Browser samples are from Node executing the production bundle, not a real browser thread.

## Actual production changes

- Native: exact steady-frame parameter cache and previous rounded ADAA primitive cache, with reset/parameter/small-delta invalidation. Also includes a strict +0 tiny-midpoint identity and ABI-preserving grouped frame-parameter refresh. No oversampling, filter, transfer function or precision reduction.
- Browser: alias-safe settled-bypass TypedArray copy; exact PREAMP primitive/bias/frame caches; exact DIST primitive/fuzz-constant caches; equivalent nonzero in-range clamp fast paths; exact TAPE ECHO previous primitive cache. General NaN, signed-zero, infinite and reversed-bound behavior retains original fallback semantics.
- No UI rewrite, speculative polling change, approximate transcendental, reduced antialiasing or quality-mode downgrade.
- Harnesses and reports add per-quantum/callback statistics, independent functional versus performance gates, source hashes, catalog sanity, long-wall soak and reproducible runners.

## Before/after

See [before-after.md](before-after.md) and [before-after.json](before-after.json) for every staged comparison and the final 72-cell original-to-final VM distribution matrix. Incremental gains must not be added.

Final original-to-final Node VM median reductions at 48 kHz, stereo and five independent FX instances: bypass 49.87%, PREAMP 41.16%, DIST 45.36%, PHASER 38.26%, MOD DELAY 52.21%, TAPE ECHO 51.69%. These are not measured browser callback improvements.

Final Native CPU0-affinity ABBA is 48 kHz/64 frames, stereo, five tracks, each PREAMP→DIST→ROBOT→Reverb. Mean of run means is 1.392065 → 1.231405 ms (11.54% lower); mean of run p99 is 2.859230 → 2.191385 ms (23.36% lower, not pooled callback p99). Worst max is 19.4275 → 13.6708 ms. Whole callback budget is 1.333 ms; p99 50% target is 0.667 ms and max 80% target 1.067 ms. Strict performance gate remains FAIL. All four runs have the same PCM hash. Two runs per variant, 5000 callbacks plus 1000 warmup each.

A stale benchmark-link issue was detected: CMake default all omitted EXCLUDE_FROM_ALL benchmark targets. The invalid final-v2 attempt is preserved separately and withdrawn. The final numbers above use explicitly rebuilt binary SHA 784a57c2…, independently checked against build provenance.

## Fresh regression evidence

- Production build: PASS, including typecheck, rebuilt worklet, Vite bundle and six exact license-file checks.
- Full unit: 150 files, 1,103 tests PASS, 44.95 seconds in the co-loaded functional phase.
- Final Native Release: 46/46 PASS, 9.96 seconds; original/final PREAMP and catalog probes are byte-identical.
- Full Playwright: 101 cases attempted, all blocked at Chromium startup, zero assertions executed. This is E2E_ENVIRONMENT_BLOCKED, not 101 app regressions and not a pass.
- Final-source Native callback matrix: 216 functional PASS; independent timing gate 170 PASS / 46 FAIL, 1628 CPU deadline exceedances retained. Six additional input/shared FX + rhythm + mono/poly pitch scenarios are functional PASS and timing FAIL.
- Native all-factory initialization sweep: 1,872 cells, 1,860 PASS and 12 explicit unsupported FREEZE mode-1 parameter rejections. This covers 52 factories; the 53rd catalog entry BEAT SHIFT is source-aware transport, not a factory insert. This is output-finite initialization, not complete sound-quality or internal-nonfinite acceptance; raw peak reaches 4 at extreme settings.
- Native HTTP: original full run hit a client BrokenPipe while sending a >1 MiB request already rejected by the unchanged host. Response-aware transport preserves every original assertion; the entire rerun passes. That successful run reports earlyResponseRecoveries=[], so the BrokenPipe recovery branch itself was not exercised. Both logs are retained, and no production protocol was changed.
- Browser final 72-cell full-stream PCM matrix: all bit-exact, finite and stereo-preserved.
- Corrected canonical-parameter FX sanity: 46 effects, 1,656 cases, zero internal non-finite/bypass failures and zero changed PCM hashes against baseline; 51 peak/DC diagnostic flags remain quality review, not automatic acceptance. Eight long-memory effects additionally ran 16 ten-second maximum-parameter cases, all exact and finite/bypass PASS, one diagnostic flag.
- Browser 30-minute simulated-audio stress: old run invalidated for missing overdub oldValues pool and missing active-path assertions. Corrected runner completed 1,800 simulated seconds in 317.386 wall seconds: 86,400,000 recorded and overdub frames, 586,958 patches, STOP acknowledged, zero overflow/sequence errors and zero internal non-finite counts across eight FX. This is not 30 minutes of real-wall Browser execution. Final-source Native real-wall 600-second checkpoint passed: 225,001 callbacks, 6,000 commands, 750 FX changes, zero queue/state/output-nonfinite/tracked-new faults. The same process completed 1,800 seconds (13:23:43.900997–13:53:43.911419 UTC): 675,001 callbacks, 18,000 commands, 2,250 FX changes, zero functional faults. Settled-to-final RSS grew 102,400 bytes, not proof of whole-app leak freedom. All 5,336 CPU deadline exceedances and 42.2175 ms maximum are retained, not hardware XRUNs. The old-source 30-minute soak is archived and not reused. The initial short catalog test co-load is documented; soak timings are not isolated performance acceptance.

## Realtime acceptance

**Browser: NOT_VERIFIED. Native: FAIL for the requested full stress target.**

Browser real AudioWorklet percentiles, main-thread long tasks, GC/IPC, whole-app lifecycle and real device counters are unavailable. Synchronous VM distributions must not be used to claim browser realtime admission. Native software measurements explicitly retain failed deadlines and shared-host tails. `cpuBudgetExceedances` is not a driver XRUN counter. Ordinary C++ new/new[] was tracked; malloc/aligned allocation/frees were not.

## Git and deployment

The batch is saved on the independent performance branch. Publishing status must be reported separately from local commit: no push is claimed without a verified remote ref. At report preparation, push was blocked by the execution authorization gate; no alternate transport was used to bypass it.

`node bench/verify_cloud_preview.mjs` starts cloud Vite production preview, fetches the HTML and linked assets (all HTTP 200), records hashes and closes the server. This is a bounded cloud startup smoke, not a persistent public app or browser UI test. User-device deployment remains **LOCAL_DEPLOY_BLOCKED** under the cloud-only scope.

## Remaining P0/P1 and bounded convergence

Native heavy graphs and supplemental live-pitch routes still exceed the requested budget. Browser actual callback/UI/GC/IPC behavior remains a software-environment gap. Native reverse transport is unsupported, not a hardware blocker. Extreme-level/DC diagnostics require interpretation; finite output alone is not quality approval.

Multiple measured reasonable-risk candidates were rejected: mirrored FIR/detector storage, forced inlining, catalog whole-block dispatch, and Release LTO/IPO. LTO preserved PCM but regressed mean 1.64% and p99 13.82%; production flags are unchanged. On the final Browser source, repeated contiguous Lagrange and invariant-hoist candidates were exact but below 3% in consecutive isolated rounds. This supports bounded convergence for the evaluated unchanged-audio DSP candidates, not proof of global condition A, B or C across the whole app.

## Hardware-only acceptance and next highest-value work

Physical audio/MIDI endpoints, real driver underrun/overflow/XRUN, hardware loopback latency, acoustic/stereo continuity and listening validation are HARDWARE_BLOCKED. See [HARDWARE_ACCEPTANCE.md](HARDWARE_ACCEPTANCE.md).

See [remaining-browser-work.md](remaining-browser-work.md) for residual profile attribution, limits of further exact caching and separately evaluated/rejected software candidates. The highest-value next software measurement is a supported real-browser execution environment: run the complete E2E suite and actual AudioWorklet/main-thread/GC/port trace, then rank the remaining real graph hotspots. It is not appropriate to guess UI changes or claim device realtime compliance from the Node/portable harnesses.

Details: [browser-performance.md](browser-performance.md), [native-report.md](native-report.md), [coverage-boundaries.md](coverage-boundaries.md), [runtime-audit.md](runtime-audit.md), and raw JSON/profile/log files.
