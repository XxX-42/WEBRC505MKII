# Browser worklet optimization, 2026-10-21

## Scope and evidence

Fresh baseline is branch HEAD dd7dbea. The exact production FX worklet is bundled with esbuild; source hashes accompany every A/B result. No sample-rate reduction, voice limit, interpolation downgrade, stereo collapse, quality-mode change, or history removal is allowed.

Actual Chromium /usr/bin/chromium was attempted with sandboxing enabled. Launch failed before graph creation because the environment disallowed its process-singleton Unix socket. The approved elevated launch then failed at environment setup (read-only session mount), not DSP execution. See browser-chromium-launch-failure.txt. No new Chrome callback trace, OfflineAudioContext measurement, browser XRUN result, KeepPitch acceptance, or hardware realtime result is claimed.

The fallback is fresh Node V8 CPU sampling of the exact bundled production worklet plus same-process ABBA. The initial sweep overlapped other compilation and is used only for hotspot selection, not acceptance of performance gains. Fresh profile ranks processBlock first (1827 self samples), processReverb second (1144), and the Lagrange reader at330. Gate reverb is the slowest measured effect in this diagnostic. Historical Chrome graph evidence corroborates reverb's importance, but is not a fresh result.

## Hypotheses

1. Preserve the exact four-point backward Lagrange polynomial and arithmetic order, but specialize the common contiguous read to avoid three ring wrap branches. Boundary reads retain the original fallback.
2. Hoist the shared Householder sum multiplier and input injection multiplier outside the eight FDN-line write loop. No arithmetic order changes within a sample/line.
3. Copy fully bypassed equal-shape channels using TypedArray.set instead of per-frame optional accesses. Keep the original path for partial/missing/mismatched channels and aliased buffers. Warm-history algorithms remain excluded from the bypass early return.

## Correctness and interpretation

The VM matrix checks all rendered output bytes, finite samples, left/right distinction, independent per-track signal, automation, bypass ramps, reset, and a silence tail. Equal source PCM SHA256 values establish bit identity for that stimulus, not perceptual acceptance for arbitrary audio. Multi-track here means independent FX instances, not production TrackAudio loop engines. Reverse-reverb is an effect scenario and must not be misreported as reversed-loop playback. KeepPitch remains outside this diagnostic.

The standalone bypass regression exercises567 algorithm/channel-length/shape combinations including mono upmix, missing/short inputs, in-place buffers, cross aliases, and overlapping views. It is an exact before/after byte comparison.

## Accepted production change

At this initial checkpoint, hypothesis3 was retained: the settled-bypass native channel copy. The production TypeScript and generated public worklet have the same source as the isolated final A/B candidate. Shared input/output backing buffers explicitly fall back to the original frame-wise loop. At this checkpoint no active DSP math changed. Later accepted exact caches and clamps are documented below.

Isolated ABBA uses4 rounds,16 alternating runs per scenario,10000 blocks per timed run,128frames/block. Results are synchronous Node worklet kernel wall time, not actual callback scheduling.

| Rate | Channels | Instances | Baseline ms | Candidate ms | Reduction |
|---|---:|---:|---:|---:|---:|
| 44100 | 1 | 1 | 20.089 | 12.745 | 36.56% |
| 44100 | 1 | 5 | 113.656 | 70.868 | 37.65% |
| 44100 | 2 | 1 | 26.024 | 14.541 | 44.12% |
| 44100 | 2 | 5 | 132.855 | 70.677 | 46.80% |
| 48000 | 1 | 1 | 19.344 | 12.104 | 37.43% |
| 48000 | 1 | 5 | 95.891 | 60.463 | 36.95% |
| 48000 | 2 | 1 | 25.782 | 13.767 | 46.60% |
| 48000 | 2 | 5 | 139.730 | 67.621 | 51.61% |

All8 final-source scenarios have identical full-stream PCM hashes, finite output, and preserved stereo distinction. Six new CI unit tests pass (browser-bypass-copy.spec.ts), covering exact values/signedzero/counters/clock, mono, missing/partial inputs, aliases, history exclusions, ramps, and parameter changes. Standalone alias/shape comparison passes630cases. The32scenario reverb/gate/reverse-reverb/bypass matrix also matches every byte, but used the candidate immediately before adding the conservative shared-output alias exclusion; its timing is deliberately ineligible. That extra exclusion is tested by both the final630case parity gate and the committed unit suite.

## Two post-optimization rounds

After accepting bypass-copy, ran a fresh full-kernel profile and then two isolated, same-source-base ABBA rounds (48kHz stereo,256blocks/pass,4ABBA rounds). Both retain exact PCM.

Contiguous Lagrange read: reverb -4.02% reduction, gate-reverb +1.25% reduction. Rejected, not retained.

FDN shared-multiply hoist: reverb -27.47% reduction, gate-reverb -4.49% reduction. Rejected, not retained.

The contiguous-read candidate is slower on reverb and its+1.25% gate-reverb change is below the approximately3% useful-gain threshold. The multiply-hoist candidate regresses both workloads. Both raw patches remain for reproducibility. Candidate reverb CPU profiles and raw baseline/final whole-kernel profiles are persisted beside this report. Sampling overhead means profile-pass times are diagnostic only; use the isolated ABBA files for decisions.

This supported only a provisional reverb-local stop after two concrete low-risk post-optimization candidates fail the gain threshold. It does not establish that every possible worklet optimization is exhausted, and it does not meet whole-application or hardware realtime acceptance. The final whole-kernel profile still identifies active processBlock/reverb as important residual work; a real Chromium scheduling profile is the next necessary measurement before a broader rewrite.

## Reproduction

Extract baseline public/worklets/fx-processor.js from dd7dbea into a temporary file. Build current public/worklets/fx-processor.js with npm run build:worklet. Run bench/compare_browser_worklet_vm_matrix.mjs BASELINE CANDIDATE OUTPUT with ALGORITHMS=bypass TRACKS=1,5 BLOCKS=10000 ROUNDS=4. MATRIX=1 selects the32scenario correctness workload. The .patch files describe the rejected candidates; apply them to the baseline DSP source before building an isolated bundle. For post-optimization reproduction, keep the accepted bypass copy and apply only the separate Lagrange/reverb method change. The actual Chromium OfflineAudioContext companion bench/compare_browser_worklet_matrix.mjs is ready for a socket-capable cloud environment, but was not runnable here.

## Supplemental per-quantum distributions

`bench/measure_browser_worklet_vm_quantiles.mjs` records numerical per-quantum durations in preallocated arrays around synchronous calls to the exact worklet. It reports mean/median/p95/p99/max for one or five sequential FX instances, plus process-level memory snapshots and deltas outside measured regions. It does not scan output, allocate harness arrays, or log inside a timed region. The timestamp cost remains included and an empty timestamp-pair distribution is reported separately. V8/internal DSP allocation is not inferred from this harness.

Actual browser callback percentiles and hardware XRUNs explicitly remain null. Memory is point-in-time process RSS/heap/external/ArrayBuffer usage, not peak memory or worklet allocation attribution. Do not equate these supplemental Node quantiles with hardware or browser realtime latency.

Run after other benchmarking/compilation has stopped:

BLOCKS=256 ROUNDS=2 node bench/measure_browser_worklet_vm_quantiles.mjs BASELINE.js public/worklets/fx-processor.js docs/performance/20261021/browser-quantum-distributions.json

The final default includes 72 scenarios over 44.1/48 kHz, mono/stereo, 1/5 FX instances, and bypass/reverb/gate-reverb/reverse-reverb/PREAMP/DIST/phaser/MOD DELAY/TAPE ECHO. `completed: true` identifies a fully completed report; partial checkpoints are not completion evidence.

## PREAMP profile-driven continuation (supersedes the earlier local stop)

Review correctly identified another remaining low-risk opportunity. Bundled PREAMP uses logCosh2 (320self samples in the first final whole-kernel profile); logCosh3 belongs to DISTORTION (636samples), not PREAMP. Two rejected reverb hypotheses were not exhaustion of software opportunities.

Previous antiderivative cache: 44100Hz/model0: 26.87% reduction, PCM exact=true; 44100Hz/model4: 29.34% reduction, PCM exact=true; 48000Hz/model0: 27.05% reduction, PCM exact=true; 48000Hz/model4: 25.59% reduction, PCM exact=true. Accepted.

Exact bias tanh/slope cache: 44100Hz/model0: 9.09% reduction, PCM exact=true; 44100Hz/model4: 12.82% reduction, PCM exact=true; 48000Hz/model0: 12.77% reduction, PCM exact=true; 48000Hz/model4: 18.09% reduction, PCM exact=true. Accepted.

Primitive cache invalidates when shape/bias changes, on reset, or when the tiny-delta direct branch bypasses primitive evaluation. It preserves the ADAA equation, threshold, oversampling, FIR/cabinet filters and smoothing. The bias/slope cache reuses exactly the same rounded functions only while shape and bias are equal. Gains are separate sequential A/B rounds and must not be presented as a directly measured combined percentage.

New CI test browser-preamp-antiderivative-cache.spec.ts passes2tests: exact double outputs against forced cache misses for all5models at44.1/48k, with model/gain automation, resets, tiny/silent inputs; and fewer primitive evaluations.


## Final profile-driven continuation and source freeze

Final bundle SHA256: `282599aef3b78183649b4269b6c140b35990cb02fa7f04bacdaaf7bb8c9455e9`.

The final source additionally retains these separately measured, exact-output changes. Each percentage is a sequential A/B comparison against its immediate predecessor, not additive and not a measured total application gain:

| Change | Isolated reduction | Evidence |
|---|---:|---|
| PREAMP exact frame-parameter caches | 3.24–9.21% | browser-preamp-frame-abba.json |
| DIST previous antiderivative cache | 16.57–37.57% | browser-distortion-primitive-abba.json |
| DIST constant fuzz bias tanh | 12.12–12.90% | browser-distortion-fuzz-constant-abba.json |
| Core exact in-range clamp | Phaser 39.47%, confirmation 37.04%; other controls −1.48% to +0.57% | browser-clamp-abba.json; browser-clamp-phaser-confirmation.json |
| MOD DELAY exact in-range clamp | 48.00–50.72% | browser-delay-clamp-abba.json |
| TAPE ECHO exact in-range clamp | 33.00–35.43% | browser-tape-clamp-abba.json |
| TAPE ECHO previous saturation primitive | 19.82–22.53% | browser-tape-primitive-abba.json |

The TAPE cells in browser-delay-clamp-abba.json are an unchanged negative control, not the TAPE clamp candidate. Clamp fallbacks retain each module's original min/max ordering. Signed zero, NaN, infinity, equal/reversed/NaN bounds are compared using Object.is, with 36,591 numerical cases across the three helpers. Primitive caches invalidate through tiny-delta paths, resets, parameter changes, disabled saturation, and interrupted DIST crossfades. Final targeted CI suite: 5 files, 16 tests passed, including silence/tiny-to-normal restoration and asymmetric channel swaps. No approximation, oversampling/filter reduction, oscillator recurrence, or tail truncation is retained.

### Final residual hotspot review

`browser-final-clamp-tape.cpuprofile` and its JSON summary are persisted. The 20-effect diagnostic profile's top five individual function self-sample counts are processBlock 1758, processReverb 1168, processPhaser 492, DIST logCosh3 262, and processChorus 257. Counts are samples, not exact durations. This follows `browser-final-all-caches.cpuprofile`, which exposed the high clamp costs and prompted the additional accepted rounds rather than an unsupported exhaustion claim.

Two review rounds: the all-caches profile identified and successfully removed exact clamp/primitive redundancy; the final clamp/TAPE profile no longer exposes that same redundant work. Remaining reverb interpolation and FDN arithmetic have two fresh rejected candidates above. Phaser's tangent/pow and chorus modulation/interpolation depend on evolving per-sample state; reusing stale coefficients or approximating functions changes output. DIST's remaining current-sample logCosh cannot reuse the prior sample without changing its ADAA equation. General processBlock specialization was subsequently implemented as an independent mechanical candidate and directly measured below; its initial gains reversed under BAAB, so it is rejected rather than left as an untested reasonable candidate. Historical dispatch and phaser-invariant trials also regressed, but are not counted as fresh final-source experiments.

The follow-up final-source trials below support a bounded measured-DSP stop, not global condition B or exhaustive software optimality. Actual browser scheduling, production loop playback Reverse/KeepPitch, endpoint/XRUN and hardware acceptance remain unverified. The final-source pair was actually rerun, with its evidence below.

### Final distribution and correctness evidence

The pre-clamp quantile run was deliberately interrupted at a completed scenario boundary to pursue the newly identified hotspot. `browser-quantum-intermediate-pre-clamp.json` is incomplete/intermediate, not final evidence; its expected EISDIR termination was a controlled harness stop, not a DSP failure. Final quantiles compare the original baseline against the frozen source above with 128 quanta/pass, 2 ABBA rounds (512 samples per version per scenario), warmup 128 quanta. P99 thus has limited tail resolution and remains an offline Node statistic.


### Two final-source isolated rejection rounds

After all accepted clamps and caches, both low-risk reverb candidates were rebuilt independently atop the frozen final source. Production files were not changed. Four ABBA rounds, 48 kHz stereo, 256 blocks/pass, one FX instance, and full 512-block PCM validation per scenario:

- Contiguous Lagrange common path: reverb +2.44%, gate-reverb +2.65%. Below the approximately 3% useful-gain criterion; rejected. Evidence: browser-final-post1-abba.json, browser-final-post1.cpuprofile, profile-summary and profile-kernels, plus patch.
- FDN shared multiply hoist: reverb +1.71%, gate-reverb −1.10%. Below criterion/regression; rejected. Evidence: browser-final-post2-abba.json, browser-final-post2.cpuprofile, profile-summary and profile-kernels, plus patch.

All four PCM hashes match exactly, with finite output and preserved stereo distinction. These are two consecutive final-source rounds without an accepted approximately 3% low-risk gain within the tested DSP range. The results near zero are cloud/JIT-sensitive, not proof that true effects are exactly those percentages. Earlier larger regressions are preserved, not overwritten. The production bundle remains unchanged at the final hash above.


### Completed final offline distributions

72/72 scenarios completed with all last-block finite diagnostics passing. Final-source hashes match the frozen bundle above. The following representative 48 kHz stereo five-instance figures time all five sequential synchronous VM calls, not actual callbacks or a hardware budget. Full results include means, medians, p95, p99, maxima, timestamp overhead, and process-memory snapshots.

| Effect | Baseline median ms | Final median ms | Median reduction | Baseline p99 ms | Final p99 ms |
|---|---:|---:|---:|---:|---:|
| bypass | 0.011848 | 0.005939 | 49.87% | 0.125439 | 0.078638 |
| reverb | 10.248182 | 9.620834 | 6.12% | 14.914004 | 13.854258 |
| gate-reverb | 10.821489 | 10.740286 | 0.75% | 16.244421 | 16.306158 |
| reverse-reverb | 15.906980 | 14.746055 | 7.30% | 28.796770 | 19.878181 |
| preamp | 7.912171 | 4.655630 | 41.16% | 14.545327 | 7.205218 |
| distortion | 10.989443 | 6.005107 | 45.36% | 15.027999 | 9.931041 |
| phaser | 11.748094 | 7.252962 | 38.26% | 22.165007 | 10.905938 |
| mod-delay | 5.470869 | 2.614477 | 52.21% | 9.054786 | 4.444383 |
| tape-echo | 9.949954 | 4.806401 | 51.69% | 14.262241 | 8.644252 |

These whole-change comparisons are not sums of stage gains. Effects without targeted accepted changes can still move due to clamp changes, JIT/code layout and cloud scheduling; do not interpret small incidental changes as a separately proven optimization. No actual-browser or hardware budget PASS is inferred.

### Completed final full-stream PCM gate

`browser-final-source-correctness-matrix.json`: 72/72 scenarios passed bit-exact output hashes, finite output, stereo distinction and configuration-error gates. Each scenario renders 65,536 frames with distinct per-instance signals, parameter automation, bypass ramps, reset, and silence tail. All nine algorithms, both sample rates, mono/stereo and one/five FX instances are represented. Baseline/final hashes exactly match the completed distribution run. This run was intentionally co-loaded with Native soak and root correctness, so its timing is explicitly ineligible for performance conclusions. It is not a production five-loop/KeepPitch or hardware audio gate.


## Immutable block-dispatch continuation: rejected

The processBlock hotspot was not dismissed merely as architectural. A fresh independent candidate selected a specialized block once per call for REVERB, GATE REVERB, PHASER and DIST. A mechanical generator copied the existing block body, substituted constructor-immutable algorithm comparisons with booleans, and selected the direct scalar method. Per-sample smoothing, detector/gate updates, dry delay, mix, sanitization, bypass ramps, phase and counters retain their original order. Generic routes retain the complete original body. The original production source and bundle were not modified.

Correctness passed: 48 affected-route full-stream cells (all three DIST modes, both rates, mono/stereo, one/five instances); 46-route/1,656-case canonical sanity with no changed PCM; and 128 exceptional/buffer/transition cases comprising 6,144 blocks. The small oracle includes generic and specialized routes, zero/short/missing/partial/aliased/overlapping buffers, NaN/infinity/±0 input, Object.is state checks, exact output bytes, interrupted ramps/mode changes, reset, gate gain, frame clock, counters and controls.

Isolated 48 kHz stereo ABBA (four rounds, 256 blocks/pass) initially measured reverb +5.49%, gate −2.00%, phaser +3.34%, DIST −0.43%, and unchanged generic LPF +2.71%. Reverse-order BAAB confirmation measured reverb −3.10%, gate −2.98%, phaser −2.81%. All PCM gates remain exact. Positive signals were not repeatable and are consistent with order/JIT/cloud noise. Candidate rejected rather than cherry-picking the positive order.

Bundle size rises from 545,084 to 605,278 bytes (+60,194, 11.0%), and the prototype adds 1,405 mechanically copied source lines. Fresh-context load/first-call/warmup diagnostics are recorded separately; they do not establish pure JIT cost or browser startup. Manual production duplication would be unacceptable; even a build-time single-source generator is not justified without repeatable benefit. No additional production soak is needed for this rejected, never-promoted candidate.

Reproduce with `bench/prepare_browser_block_dispatch_candidate.py`; raw candidate patch, metadata, ABBA/BAAB, startup, sanity, transition and full-stream reports are named `browser-block-dispatch-*`. These measurements extend the bounded software investigation, not hardware or whole-system acceptance.


## PREAMP strictly positive-zero identity continuation: rejected

A second independently tested remaining candidate replaced only the small-delta transfer's exact +0 midpoint with +0. It retained −0 and every nonzero midpoint on the original expression, and retained all invalidation, histories, oversampling, EQ, cabinet and smoothing work. The current cached bias tanh is identical to the positive-zero transfer numerator's tanh argument, and slope is positive. There was no entire-silence block skip.

Correctness: 120,000 stereo frames with Object.is double-output and history-state checks across all five models/two rates, ±0 silence, ramps/reset/tiny deltas and channel-swapped restoration; 20 full-stream PCM scenarios; 16 buffer/transition cases (768 blocks). All passed. The mixed-signal profile did not establish a large silence-specific tanh hotspot, so the hypothesis was directly measured rather than assumed useful from Native behavior.

Isolated 48 kHz stereo model4, four rounds/order, 512 blocks/pass: silence ABBA +0.68%, reverse BAAB −1.03%; tone ABBA −3.16%, BAAB +0.31%. Rejected for no repeatable approximately 3% gain. No 44.1 kHz performance confirmation or promotion was warranted. JS branch/function costs and surrounding FIR work are possible explanations, not separately proven causal attribution. Production source and final bundle hash remain unchanged; all previously completed final gates still match production.

Reproduction: `bench/prepare_browser_preamp_zero_candidate.py`, `bench/tests/browser_preamp_zero_parity.mjs`; raw patch, correctness, shape, ABBA/BAAB and decision evidence use the `browser-preamp-zero-*` prefix.


### Final bounded residual audit

The exact current production still matches `browser-final-clamp-tape.cpuprofile`; rejected candidates never changed it, so another identical-source profile is not required to relabel the old measurements as new. `browser-final-post1.cpuprofile` and `browser-final-post2.cpuprofile` accompany the two final-source reverb attempts. Remaining actionable hypotheses identified in that review have now been measured: reverb interpolation and invariant multiplication failed the useful-gain criterion; block dispatch failed reverse-order confirmation; PREAMP +0 identity failed silence and tone confirmation. These are rejected candidates, not pending implementation suggestions.

Remaining per-sample nonlinear/oscillator functions consume changing inputs. Replacing them with approximations or stale-value reuse would violate the exact-output premise; a new numerical-quality tradeoff would need separate scope and validation. This supports stopping within the profiled/measured Browser DSP scope, not claiming all software designs are optimal or that actual browser/device acceptance is complete. In particular, Native silence gains cannot be extrapolated to the Browser implementation.
