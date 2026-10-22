# Native performance engineering, 2026-10-21

## Scope and acceptance

Fresh GNU C++ Release builds on cloud Linux. This is the real NativeAudioCore callback using the repository's device-free RtAudio test adapter, **not a physical ASIO/WASAPI stream**. Hardware latency, driver over/underruns and hardware XRUNs are **HARDWARE_BLOCKED**. CPU callback deadline exceedances are reported separately and must not be renamed XRUNs.

Functional correctness and performance are separate gates. A callback scenario can return functional PASS while performance FAIL. Performance PASS requires p99 < 50% of buffer budget, max < 80%, and zero observed CPU deadline exceedances. Budget = buffer frames / sample rate: at 48 kHz, 64/128/256 frames provide 1.333/2.667/5.333 ms. Shared cloud scheduling is not hard-real-time acceptance.

## Fresh profile and iterative decisions

1. Baseline gprof found PREAMP's triode operation 22.17% self, its processing loop 18.56%, and frame-parameter creation 4.12%. ROBOT pitch analysis was 12.71%. Gprof is an instrumented diagnostic, includes preparation/warmup, and is not the source of uninstrumented callback timings. Compiler aliases can misattribute some samples (notably the apparent oscillator destructor); do not interpret those symbols as actual callback destruction.
2. **Accepted:** reuse exact frame parameters when all six smoothed controls are unchanged. Smoothers still advance every frame, and reset invalidates the cache. Clean ABBA p50 improvement: 7.69% in the initial isolated comparison.
3. **Rejected and reverted:** mirror PREAMP FIR rings to eliminate wrap branches. ABBA p50 regressed 1.61%; no extra FIR storage remains.
4. Post-round-two profile still put the triode operation at 27.91% self. **Accepted:** retain the previous oversample's exactly rounded ADAA antiderivative. Invalidate on parameter changes and the small-delta fallback. The calculation order, nonlinear transfer, threshold, smoothing and 4x oversampling are unchanged. Isolated incremental p50 improvement was 7.21% (this comparison used the common mirrored-ring intermediate on both sides; final combined A/B uses only accepted changes).
5. Post-accepted-change profile: triode 23.70%, PREAMP loop 22.89%, ROBOT tracker 14.46%. **Rejected and reverted:** force-inline ADAA, p50 regression 5.20%.
6. **Rejected and reverted:** mirrored ROBOT/YIN detector rings, p50 improvement 2.33%, below the approximately 3% acceptance threshold and requiring permanent extra per-instance storage. No detector changes remain.
7. A repeated final profile still identifies PREAMP (24.21% loop + 21.83% triode), ROBOT tracking (13.49%) and Signalsmith spectrum processing (7.14%) as residual cost. Two consecutive follow-on safe hypotheses failed the gain criterion. This is not proof that all software bottlenecks or worst-case topologies are exhausted. A further catalog-dispatch hypothesis was subsequently evaluated below. Approximate tanh/log, reassociated floating-point reductions, reduced oversampling and the existing experimental ADAA algebra were not enabled because they change the accepted numerical/audio behavior.

Individual decisions and raw timings are in native-round1/round2/round3-abba.json, native-inline-abba.json and native-detector-abba.json. Earlier native-round1-exploratory-contended.json is explicitly exploratory and superseded, not accepted timing evidence.

## Correctness evidence

- Fresh final-v2 Release suite: 46/46 passed after final production edits, 10.09 s. See final-v2/native-tests.txt; predecessor native-tests-final.txt is retained. Assertions stay enabled in test executables.
- Original PREAMP source from baseline dd7dbea and final PREAMP emit byte-identical expanded deterministic PCM: SHA-256 0335262669f2b74ef2e240627d3467b30fd4eb553d32c26647dd1cb4c03ade70. The probe includes 44.1/48 kHz, all five models, gain/tone automation, immediate/ramped changes, reset, variable blocks, silence, near-zero/DC, impulses and distinct stereo signals. Exactness was tested on this compiler/platform, not asserted for all architectures.
- New testStereoIsolationWithAutomatedControls compares each stereo channel exactly against its independent L-only/R-only processor during model/gain ramps at both sample rates.
- Existing callback gates include testNativeFiveTrackStereoMixAndTrackCommands, testNativePerTrackCatalogControlsAndIndependentOutput, and testNativeTwentySlotChainsMatchIndependentOrderedReferencesAt64Frames. Existing PREAMP tests cover supported rates, latency, alias suppression, variable block invariance, extra channels, control smoothing/reset and tracked allocations.
- Matrix scenarios check active/nonfaulted FX slots, expected final recording/playback/overdub states, finite output, and non-silent/stereo output for playback and overdub. Record-only monitoring is off and can correctly produce silence; the harness instead verifies the exact recorded frame count. These checks complement, rather than replace, the isolated channel/track tests.

## Matrix methodology

216 final-build cells: 44.1/48 kHz × 64/128/256 buffers × one/five tracks × mono/stereo input × playback/record/overdub × FX off/heavy/realistic. Output remains stereo. Each cell warms 1,000 callbacks then measures 300 callbacks; short-tail estimates are screening evidence, not a long-duration guarantee. Record cells use 60-second preallocated storage to avoid silently filling the loop during measurement.

Heavy per-track chain: PREAMP → distortion → ROBOT → reverb, four slots on each active track. Realistic chain: chorus → fractional delay → dynamics → reverb. The heavy mixed chain is a measured stress topology, **not a proven exhaustive maximum across the catalog**. Record/overdub routes retain their real processing semantics; no forced playback-FX processing is substituted.

Timer excludes output validation/hash bookkeeping. Loop input is deterministic and L/R-distinct for stereo. Hashes are checked across A/B variants. The final runner writes binary/source SHA-256, compiler/flags, UTC timestamps and scheduling scope to native-environment.json and per-run records. Raw final matrix and combined ABBA files preserve all percentile/max/deadline data and independent functional/performance gates.

Allocation counters intercept C++ operator new/new[] only. They do not prove zero malloc, aligned allocation, foreign-library allocations or frees. Baseline allocation/RSS fields are null when not instrumented, not invented zeroes. Browser GC, postMessage and long-task metrics are inapplicable here; hardware driver counters, process CPU%, startup timing and uninstrumented metrics are null with reasons. Peak RSS is Linux process high-water RSS and includes preparation, not just the callback.

## Coverage boundaries

- Native reverse transport is explicitly **UNSUPPORTED_NATIVE_TRANSPORT** in the existing API; its reverse flag is a KeepPitch fallback hint, not reverse playback. This is not a hardware limitation.
- The portable callback harness does not run actual HTTP/JSON communication on the same engine. Soak control polling calls getStatus; this is not misrepresented as HTTP coverage.
- The separately built native_bridge_host_simulation runs real same-engine HTTP/JSON with a synthetic callback thread. The full response-aware HTTP suite passed, including callback-acknowledged live edits and independent per-track MIDI queues. Its fake backend is not physical-device or deadline evidence.
- Physical-device launch, loopback latency, XRUN-free driver behavior and listening acceptance require the real target device. No local deployment was claimed.

## Reproduction

Configure native-mvp/engine-cpp with CMAKE_BUILD_TYPE=Release and NATIVE_PORTABLE_TESTS_ONLY=ON; build and run ctest. Build opt-in targets native_performance_matrix, native_performance_soak, native_preamp_ab_probe and native_per_track_fx_bench. No fast-math flags are used. A separate -pg CMAKE_CXX_FLAGS/CMAKE_EXE_LINKER_FLAGS build produces the diagnostic profiles.

bench/run_native_performance_matrix.py accepts preserved baseline, parameter-cache and final Release executable paths and output directory. Keep the harness identical for the compared workload, pause other task-team timing/build jobs, and retain binary hashes. The standalone PREAMP reference probe can compile the baseline header/source with current unchanged dsp_primitives.cpp and native_preamp_ab_probe.cpp, then compare its stdout PCM byte-for-byte against the final target.

HTTP simulation build uses NATIVE_BRIDGE_SIMULATION_ONLY=ON and RTAUDIO_API_ALSA=OFF on this Linux host without ALSA development libraries. This disables a backend irrelevant to the fake-device host, not a production audio backend feature.

Run bash bench/replay_native_performance.sh /absolute/fresh/work-directory for a clean baseline dd7dbea archive overlaid only with the final benchmark definitions/sources, a current final-source build, byte-exact PCM comparison, ABBA, full coverage and a wall-clock-paced 600-second soak. This does not rely on the ephemeral /tmp binaries from this session. Set CMAKE to the CMake executable if needed.


## Additional catalog-dispatch hypothesis (rejected)

Whole-block PREAMP/DIST/reverb overrides reduced PREAMP diagnostic calls from 1,920,000 to 30,000, but its self-CPU remained approximately 24%. A first ABBA appeared 3.88% faster on mean (2.28% median); reverse-order BAAB instead regressed mean 3.76% and median 2.85%. Pooled across eight runs the mean gain was approximately 0.12%, not a reproducible 3% improvement. The overrides were reverted. Exact 4,330,800-byte catalog PCM matched SHA-256 3ddf2497488033b4ca546a934916eb145d88a3bee706b799239a32ac2b6b26bf across both sample rates, mono/stereo/extra channels, automation, bypass, reset and 5,001-frame calls crossing the base class's 4,096-frame boundary. Reducing call count alone was not treated as a performance win. See native-block-abba.json, native-block-confirmation.json and native-gprof-block.txt.

## Completed matrix and combined A/B

The retained cache-only production candidate passed all 216 functional cells. The independent performance gate passed 150 and failed 66: FX-off 65/72, heavy mixed FX 25/72, realistic FX 60/72. No samples or failures were removed. Zero intercepted C++ new/new[] allocations were observed in these callbacks. Combined baseline-to-final ABBA showed mean 8.09%, median 8.80%, p95 5.71% and p99 4.38% improvement. These are paired-run averages, not an absolute hardware guarantee. Heavy tails still miss the requested target; even some no-FX cells fail, consistent with shared-host scheduling effects, but no scheduler trace establishes a unique cause. The software performance target is not fully met.


## Cross-runtime transfer audit

Browser DIST's previous-antiderivative cache does not transfer to Native DIST: native_distortion_processor.cpp uses a direct tanh at each 4x oversample followed by FIR reconstruction, not an ADAA difference that recomputes the previous primitive. No equivalent duplicate antiderivative exists. Approximate tanh/saturation or a different antialiasing filter would change audio behavior and was not adopted. Native's accepted PREAMP cache was transferred in the other direction for separate Browser evaluation.

## Supplemental routing and pitch coverage

Six additional final-build scenarios at 44.1/48 kHz, 64 frames and five tracks exercise four input FX, four shared output FX, twenty per-track FX, audible rhythm voices, and either pitch off, LiveMonoKeepPitch or LivePolyPhaseVocoder. Each measures 2,000 callbacks after 1,000 warmup callbacks. All six functional gates pass, including live input FX peak, healthy active slots, rhythm voice activity and active pitch status where selected. All six strict performance gates fail; no scope is mislabeled hardware-blocked. Zero intercepted callback new/new[] allocations were observed. See native-supplements.json.

Final rebuild repeated the complete 46-test suite and exact PREAMP/catalog PCM probes after the rejected whole-block candidate was removed. The retained 216-cell matrix already used this same accepted production DSP; its default scenarios were not silently replaced with supplemental ones.

## Release LTO/IPO hypothesis (rejected)

A separate GNU 14.2 Release build enabled CMAKE_INTERPROCEDURAL_OPTIMIZATION=ON, retaining -O3, ordinary floating-point semantics and all oversampling. PREAMP and catalog PCM probes remained byte-exact, as did callback hashes. Isolated ABBA nevertheless regressed mean 1.64%, median 1.21%, p95 3.17% and p99 13.82%. The noisy maximum improved but does not establish a repeatable throughput gain. LTO was not enabled in production. See native-lto-abba.json; bench/compare_native_candidate.py replays the comparison with separate normal and IPO executable paths.

The retained production candidate has multiple independently measured, rejected post-optimization safe hypotheses, including whole-block dispatch and IPO. This is bounded convergence for the evaluated unchanged-audio candidates, not exhaustive optimality and not a passing performance target.

## HTTP and existing benchmark follow-through

The original full HTTP simulation test failed on a BrokenPipe while uploading a >1 MiB body to a malformed expectedContentRevision query. Both production host and original test are unchanged from dd7dbea. The host explicitly sends an early 400 before reading the body (native_bridge_host.cpp around lines 829–834). The Python urllib sender can still be transmitting when that connection closes. bench/run_native_http_simulation.py uses HTTPConnection and, only after BrokenPipe, reads the actual response rather than assuming success or status 400. Every original assertion remains in force. The complete suite passed with this response-aware transport; both original failure and final passing logs are retained. No production HTTP protocol or test assertion was weakened.

Existing native_audio_bench and native_per_track_fx_bench (all-banks, 100 warmup/500 measured callbacks) also completed successfully during the co-loaded soak phase. Their raw timings are retained for reproducibility but are not isolated A/B or hardware budget evidence.

## Full catalog short-signal sanity

The opt-in native_catalog_sanity_sweep enumerates the actual 52 factory descriptors (rather than assuming the Browser catalog count), both sample rates, default/all-min/all-max parameter vectors and silence/impulse/sine/L-only/R-only/asymmetric stereo. Each measured signal is 4,096 frames, only 92.88 ms at 44.1 kHz or 85.33 ms at 48 kHz. Metrics are peak, RMS, DC, L/R correlation, nonfinite frames, processing faults and declared latency. Bypass is checked after resetting its ramp and against the declared delayed dry path, not incorrectly against unaligned immediate input. FREEZE receives two seconds of capture prewarming. External MIDI/source-aware transport activation remains UNEXERCISED_ACTIVE_PATH in this generic sweep; separate existing MIDI/transport tests and actual HTTP assertions cover those routes, not a generic active-audio guarantee.

The first experimental bypass assertion incorrectly compared a ramping, latency-compensated dry path to immediate input. That harness assertion was corrected before the retained run; it was not a DSP modification. Final short-signal results and coverage limitations are in native-catalog-sanity.jsonl and native-catalog-sanity-summary.json. Simultaneous all-min/all-max vectors are not an exhaustive per-parameter or all-combinations quality proof, and short initialization does not prove long-tail stability or listening quality.

The factory coverage is 52 × 2 rates × 3 vectors × 6 signals = 1,872 cases. BEAT SHIFT (Browser id beat-shift, source index 52) is the one source catalog entry outside this factory sweep because Native implements it through source-aware loop transport. Name mapping normalizes underscores/hyphens and filter prefixes; Browser DELAY maps to Native fractional_delay. Some Native sourceIndex metadata is deliberately unknown. FREEZE mode 1 rejection reflects an advertised numeric maximum outside the supported discrete list [0], not a hardware limitation. Maximum raw output peak was 4 at extreme settings; top peak and absolute-DC cases are retained in the summary. Finite output is not called complete audio-quality acceptance. This final-only sweep is not a full-catalog baseline A/B; unchanged source plus the exact PREAMP/catalog probes delimit the optimization evidence.

A separate 12-case legal-discrete FREEZE-max supplement selects the greatest implemented discrete value (mode=0, freeze=1), retaining the original 1,872 cases and unsupported-mode rejection evidence. Both rates and all six signals passed after two-second capture prewarming. The harness now prioritizes DSP nonfinite/fault/bypass failures ahead of parameter rejection, so rejected configuration cannot conceal a DSP fault; original rows had zero such faults. The final passing response-aware HTTP run reported earlyResponseRecoveries=[], so the recovery branch itself was not exercised in that run. All original real-response status/body assertions did run and pass.

## Real-wall stability checkpoint

The uninterrupted 1,800-second co-loaded soak started 2026-10-21 12:13:16 UTC. Its independent 600.003-second checkpoint passed: 225,001 callbacks, 6,000 commands, 750 FX changes, zero queue rejection/state errors/nonfinite frames/intercepted callback new/new[] allocations, 15,717,495 stereo-distinct frames and RSS 7,630,848 bytes. The same process continued without reset to its successful 1,800-second terminal result. This checkpoint is a functional stability result, not an isolated timing or physical XRUN pass.

## Thirty-minute real-wall terminal result

The cache-only production binary completed uninterrupted from 12:13:16.156 to 12:43:16.170 UTC: 1,800 wall seconds, 675,001 callbacks, 18,000 commands and 2,250 FX changes. Functional PASS: zero queue rejections, state errors, nonfinite frames and intercepted callback new/new[] allocations; 47,262,098 stereo-distinct frames. Process CPU time was 430.498 s, averaging 23.9165% of one CPU. RSS at the 30-second settled point was 7,561,216 bytes, final 7,663,616 (+102,400), maximum 7,733,248. Ten-second memory/CPU samples are retained; small page-scale fluctuations are not proof of a universal absence of memory leaks or uninstrumented allocation. Heap bytes are not instrumented.

This was deliberately co-loaded with Browser final tests/simulated stress, Native HTTP/sanity/existing benchmarks and candidate compilation/correctness. It observed 4,796 CPU deadline exceedances, a 76.9274 ms maximum, approximate p50/p95/p99 of 537/1,563/2,309 microseconds. These are retained without claiming isolated timing or physical XRUN acceptance. Soak control polling was direct getStatus, not HTTP on this soak engine; the separate full HTTP simulation test exercised HTTP with its own actual synthetic callback engine. Native reverse remains unsupported by the transport API. See native-soak-1800s.json and its independent checkpoint file.

## Additional exact-order/repeated-value hypotheses

ROBOT contiguous-span traversal preserved ordered double accumulation and exact callback PCM at both sample rates, but eight forward/reverse runs averaged by per-run statistic improved mean only 1.56% and median 2.11%, while p99 regressed 4.62% and max regressed 105.33%. It was rejected; no outliers were dropped.

A general PREAMP repeated-small-midpoint result cache preserved full and signed-zero/nonfinite-recovery PCM. Its heavy callback mean improved 1.90%, median only 0.13%; standalone changing stereo sine regressed 3.66%, despite silence improving 18.30%. The general cache was rejected, not justified by selectively reporting silence. Instrumented hits were 317/10,240,000 calls for changing sine and 10,239,992/10,240,000 for silence. A narrower exact positive-zero identity was then prepared for independent evaluation; it is not the general cache. Candidate patches, raw ABBA, hit counts and explicit edge probe are retained.

## Final-v2 source freeze (13:14 UTC)

The final production candidate additionally accepts the exact positive-zero
small-delta identity and the conservative, return-value-ABI-preserving grouped
frame-parameter reuse. No oversampling, precision, nonlinear function, signal
history, smoothing, stereo path, or five-track topology was reduced.
The grouped automation pinned point estimate is +3.0468%, not a high-confidence
claim of >=3% across environments; unpinned automation was +6.39%. Steady heavy
binary results differ by environment and must not be causally attributed to
parameter arithmetic. The in-place ABI-changing variant remains rejected.

A new final-base profile showed triode 21.78%, PREAMP loop 20.00%, ROBOT detector
14.65%, Signalsmith spectrum 7.92%. The apparent destructor symbol remains
unverified profiler attribution, not an actual destructor optimization target.
Two subsequent final-base candidates were independently rejected:
- Narrow model-only primitive invalidation: CPU-0 automation +2.68% / -3.13%
  by order, -0.11% aggregate; silence regressed in both orders.
- Exact-order ROBOT contiguous spans: forward mean +2.86% but opposite-order
  reversal; eight-run mean -1.98%, p50 -2.45%, mean(run p99) -3.81%.
Both preserve PCM; performance rejection is not an audio correctness failure.
This closes these measured reasonable-risk hypotheses, not a claim that all
software optimization opportunities have been exhausted.

Statistics labelled gainPercent or historical pooledGainPercent are ratios of
arithmetic means of per-run statistics. In particular, p99 is mean(run p99),
NOT a quantile computed over pooled callback samples. Callback timing arrays
were not retained. Pinned and unpinned measurements are separate environments.

All final-v2 build, PCM, unit, HTTP, matrix and soak artifacts are regenerated
under final-v2/. Prior 216-cell and 1800-second results remain predecessor
evidence, not final-source acceptance.

### Corrected final-v2 build-provenance error

The first attempted final-v2 run used a default CMake all build. This rebuilt the
final DSP library, tests and host but did not relink the EXCLUDE_FROM_ALL opt-in
benchmark/probe executables. Its candidate binary SHA matched the predecessor.
That attempted ABBA/partial matrix and its asserted final-source PCM evidence
are INVALID_STALE_BENCH_BINARY; the initially announced +12.84% mean is withdrawn.
The complete attempt is retained in invalid-stale-bench-final-v2/ with INVALID.json.
It was interrupted before any final soak started.

The opt-in targets were explicitly rebuilt at 13:18:50 UTC. The resulting
matrix SHA 784a57c23ad714df80114d61c64d0a22409d1058d5d3b6c73c8d0d32c0caf36a
equals the independently built accepted conservative-ABI candidate. All final
gates and timing are rerun under final-v2/ using these verified executables.
This failure is a measurement/build provenance error, not evidence of a DSP
regression. Reproduction scripts explicitly name all required opt-in targets.

## Verified final-v2 results (new executable, CPU 0)

After the explicit-target correction, original dd7dbea and final production
executables were compared with the same current harness, Release flags and
CPU-0 affinity. Exact PCM matched. ABBA arithmetic-mean-of-run-statistics gains:
mean 11.54%, p50 10.52%, p95 13.71%, mean(run p99) 23.36%, mean(run max) 37.82%.
No callback samples or outliers were removed. These are this environment's
point estimates, not a physical-device or cross-platform guarantee.

The verified final 216 cells passed all functional gates but only 170 strict
performance gates; 46 failed. FX off passed 71/72, heavy 32/72, realistic 67/72.
There were 1,628 CPU deadline exceedances (1,624 heavy), not hardware XRUNs.
The worst p99 was 628.76% of its buffer budget. All six supplemental
input/shared/rhythm/pitch cells passed functional gates and failed performance
gates. Intercepted callback C++ new/new[] counts were zero within their stated
scope. Performance acceptance is FAIL, despite the measured speedup.

Fresh final Release tests again passed 46/46 (9.96 s). Explicitly relinked
PREAMP and catalog probes exactly matched the original baseline. Full final
HTTP assertions passed, with no early-response recovery branch observed.
The final 52-factory sweep produced 1,860 PASS and 12 PARAMETER_REJECTED cases
(the unsupported FREEZE mode=1 descriptor maximum), zero processing faults
and nonfinite frames; the separate legal FREEZE maximum passed 12/12.
Peak/DC diagnostics are retained and are not a listening/aliasing quality pass.

The final 1,800-second same-process soak began 13:23:43.900997 UTC.
The final catalog sweep co-loaded only 13:23:43.873–13:23:47.546 UTC; later
lightweight reporting/manifest checks are not isolated callback acceptance.
The independent 600-second checkpoint and 1,800-second terminal outcome are
reported separately once each actually completes.

Reproducibility guard: build_native_verified.py explicitly builds all opt-in
targets, verifies CMake source/build rules and source/header→object→library→
binary freshness, and writes SHA inventories. replay_native_performance.sh
uses it for both revisions. A negative fixture with old executables and new
objects/libraries was correctly rejected. Runner source hashes alone are
declarations; optional --build-manifest verifies candidate binding. Final-v2's
independently checked binding is documented in native-verified-build-manifest.json
and native-build-binding-verification.json. Invalid predecessor measurements
remain archived rather than relabelled.

The final-v2 600.003-second checkpoint passed: 225,001 callbacks, 6,000 commands,
750 FX changes, zero queue/state/nonfinite/intercepted-new errors, 15,843,363
stereo-distinct frames, RSS 7,655,424 bytes. This is a checkpoint of the same
continuing 1,800-second process, not its terminal result.

Manifest validation additionally requires buildBindingVerified=true and both
PREAMP source and header SHA matches. Only specific validated path/SHA pairs
receive a true per-run binding flag; an unvalidated round1 stays false.
Negative tests verify stale executables, wrong header, unverified manifest and
round1 labelling without running an audio benchmark.

## Final-v2 30-minute terminal result

The final verified production binary completed uninterrupted from
2026-10-21 13:23:43.900997 to 13:53:43.911419 UTC: 1,800 actual wall seconds,
675,001 callbacks, 18,000 commands and 2,250 FX switches. Functional PASS,
exit 0: zero queue rejection, state errors, nonfinite frames and intercepted
callback C++ new/new[] allocations; 47,345,957 stereo-distinct frames.

Process CPU was 421.971 seconds (23.4428% of one CPU). RSS at the 30-second
settled point was 7,585,792 bytes, final 7,688,192 (+102,400), maximum 7,757,824.
All 180 ten-second memory/CPU samples are retained; the final minute is
approximately 7,688,192 bytes with an 8 KiB fluctuation. Heap telemetry is
unavailable; this is not proof of zero malloc, foreign allocation or all leaks.

The co-loaded soak observed 5,336 CPU deadline exceedances and a 42.2175 ms
maximum callback; approximate histogram p50/p95/p99 were 440/1651/2477 us.
These observations remain visible but are neither isolated performance
acceptance nor physical-driver XRUN counters. The independently measured
216+6 performance gates still fail as documented above.

The terminal binary SHA is
8433c2e8117b75fa5e4224f3c41995f9503d3b5b27d9f336a32e3b41f841985a;
production PREAMP source SHA is
6810f9807c6148b9bb31235c4d3a29a1d0898fca196b1d41581f71b7505d79d8.
Both exactly match the verified final build manifest. The 600-second checkpoint
and 1,800-second final JSON are from the same process without a reset.
Final artifacts are in final-v2/, including native-soak-summary.json and full
native-soak-1800s.json. Predecessor results and the invalid stale-binary attempt
remain separately archived. No physical device validation or deployment is claimed.
