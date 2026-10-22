# Remaining Native work and acceptance risks

## Current final-v2 P0 budget evidence

The final-source CPU0 matrix is 170 performance PASS / 46 FAIL, with all 216 functional PASS; six supplements are functional PASS / performance FAIL. In heavy mode, 30/72 cells have mean >=50% budget, 27 have p50 >=50%, and three have mean >=100%. Heavy contributes 1624 of 1628 CPU deadline exceedances. Off and realistic means remain below50%, but tail failures persist. See final-v2/native-budget-failure-analysis.json. These are current admission results, not a matched comparison against the differently scheduled historical matrix.

## Historical predecessor P0 evidence (not final-source results)

- The isolated 216-cell matrix has 66 strict performance failures; the six added input/shared/rhythm/pitch stress cases also fail. Heavy mode is PREAMP → distortion → ROBOT → reverb on each of five tracks, not a proved catalog-wide maximum. Five independent nonlinear/analysis chains multiply work; this topology does not become inexpensive merely by eliminating wrapper calls.
- At 48 kHz/64 frames the entire callback budget is 1.333 ms, and the requested p99 ceiling is only 0.667 ms. Small buffers expose bursty analysis and scheduling tails. Even seven FX-off cells miss the strict gate. Shared-host interference is plausible but not proven as the sole cause; no samples were removed. These failures are CPU observations, not measured hardware XRUNs.
- Physical target-device Release profiling, driver counters, stereo loopback latency and listening acceptance remain HARDWARE_BLOCKED here. Re-run the same matrix on the actual target before deciding whether host scheduling or DSP dominates each tail. Do not increase buffers, lower oversampling or disable effects just to obtain a passing report.

## Historical predecessor profile-linked residual cost

The retained instrumented diagnostic profile attributes 24.21% self CPU to the PREAMP loop, 21.83% to its ADAA triode, 13.49% to ROBOT analysis, 7.14% to Signalsmith spectrum processing and 6.35% to distortion. Profile preparation/warmup and compiler alias attribution differ from the uninstrumented timed interval; the apparent oscillator destructor is not a verified destructor hotspot. These percentages locate candidates, not exact additive callback budgets.

PREAMP already caches unchanged control-derived frame parameters and the previous rounded antiderivative. Its remaining current-input antiderivative or small-delta tanh depends on changing audio samples. Native distortion uses direct 4x tanh, not Browser's duplicated ADAA primitive, so the Browser primitive cache has no equivalent to reuse. Whole-block dispatch, FIR ring mirroring, force-inlining, detector ring mirroring and Release IPO have measured negative or sub-3% results. Repeating those changes without a materially different hypothesis is not justified.

## P1: historical candidate list, now resolved where noted below

1. **Phase-resolved callback profiling on the actual target.** Separate steady playback, recording, overdub, parameter transitions and pitch-analysis callbacks. Add preallocated diagnostic timestamps or offline traces, then benchmark an uninstrumented build. Low audio-semantic risk, but instrumentation perturbs tails and must not be used as final acceptance. This establishes whether another optimization could materially improve the failing cells rather than only average CPU.
2. **ROBOT/YIN exact-order inner-loop layout.** The current lag/window loop repeatedly indexes a ring and performs ordered double-precision accumulation. A two-span contiguous traversal that preserves the exact sequence of additions may be tested without the previously rejected full mirrored-ring storage. This was subsequently measured on two bases and rejected; see final-v2 closure below. Gate with exact detector/PCM sequences, voiced/unvoiced transitions, 44.1/48 kHz, reset, variable blocks, then reversed-order ABBA. SIMD reductions, autocorrelation substitution or reassociation do not preserve the same rounding and need additional pitch/audio-quality gates.
3. **Repeated-input nonlinear fast path.** A narrowly keyed cache of exactly repeated input/previous-input/control tuples could help true silence or held DC. It is not a replacement for processing filter tails, and the changing-input heavy workload offers little reuse. Evaluate only after a trace demonstrates repeated tuples are material. Any cache must include small-delta branch validity, control changes and reset; exact PCM and noise/near-zero/impulse tests are mandatory. The general cache was subsequently rejected; the narrower +0 identity was accepted as documented below.
4. **Signalsmith work distribution and FFT implementation.** Determine whether the p99 failures coincide with spectrum-hop boundaries before changing buffering. Altering hop size, analysis cadence, window size, pitch tracking intervals or spreading analysis across callback boundaries can change latency, phase, state availability and stereo behavior. Those are not safe scheduling-only tweaks. An architecture-specific FFT/vector implementation may be worth evaluating, but requires exact or explicitly approved tolerance-based PCM, latency, spectral, transient and stereo gates on every supported target.
5. **Control-only cache invalidation refinement.** Avoiding PREAMP primitive invalidation for tone changes that do not affect the nonlinear curve was subsequently investigated during automation and rejected on the final grouped base, as documented below. It cannot explain steady-state heavy-chain failures because the existing cache already hits when controls are stable. Require exact automated-parameter PCM, not a steady-only speed claim.

## Changes requiring explicit quality/cross-platform acceptance

Approximate tanh/log, algebraically reformulated ADAA, reduced oversampling, fast-math, altered FIR/IIR coefficients, reduced pitch-analysis cadence and changed FFT/window schedules are excluded from the accepted unchanged-audio optimization batch. They may be engineering options only with measured aliasing, DC, transient, latency, pitch stability, stereo isolation and listening gates. ARM64/x86 and compiler-specific behavior cannot be inferred from this single GNU/Linux run.

The final-only 52-factory short-signal sweep records extreme peaks up to 4 and top absolute-DC cases. Finite output is not complete audio-quality acceptance. BEAT SHIFT uses a separate source-aware transport route; generic MIDI/source-active audio paths are not silently counted as covered. The 30-minute co-loaded state-machine soak addresses functional stability, not the missing isolated performance or hardware gates.

This is a bounded set of measured accepted/rejected hypotheses, not a claim that Native performance has been exhausted or that no further safe optimization exists.

The historical predecessor supplementary budget analysis sharpens the compute/scheduling distinction: among 72 heavy cells, 34 have mean >=50% of budget, 30 have median >=50%, and two have mean >=100%, with 1,513 CPU deadline exceedances. FX-off and realistic means are below50%; their failures arise in tails, without a scheduler trace proving the cause. See native-budget-failure-analysis.json. Following review, separate source copies of exact-order ROBOT span traversal and PREAMP repeated-midpoint caching were prepared for additional correctness and isolated A/B evaluation; they are not silently merged into the production candidate.

## Final-v2 measured closure, not exhaustion

The final whole-core profile still spends 21.78% in triode/ADAA, 20.00% in the
PREAMP sample loop, 14.65% in ROBOT detection, and 7.92% in Signalsmith spectral
processing. Those costs are real remaining work; heavy scenarios with sustained
mean/p50 over budget are not explained away as scheduler tails.

The previously proposed safe candidates are now measured:
- Positive-zero transfer identity is accepted only for demonstrated PREAMP
  silence benefit, with all histories and smoothers retained.
- Conservative grouped frame parameters are accepted with an automation
  CPU-0 point estimate of 3.0468%; environment-dependent binary gains remain
  separately reported. The in-place ABI-changing version was rejected.
- Shape-only primitive invalidation was rechecked on this grouped final base.
  Automation +2.68%/-3.13% by order, -0.11% aggregate; rejected.
- Exact-order ROBOT two-span detector reads were rechecked on this base and
  CPU 0. Eight-run mean -1.98%, p50 -2.45%, mean(run p99) -3.81%; rejected.
- General repeated nonlinear-input cache barely hits on changing input
  (317/10,240,000), adds comparisons/writes, and regressed sine. The useful
  positive-zero subcase is covered without state/cache overhead.

Remaining substantial changes are not substitutes for these exact identities:
changing detector cadence/window, spectral FFT scheduling or buffering changes
latency/transient behavior; replacing transcendental functions or vectorizing
reductions may change rounding and require numerical/audio parity gates on
multiple platforms; reducing nonlinear oversampling changes alias rejection.
Any such next iteration needs a new profile-linked design, explicit quality
and latency bounds, cross-platform validation, and physical-driver acceptance.
The present budget failure remains P0 even though these low-risk candidates
did not deliver reproducible additional >=3% gains.

## Verified final-v2 acceptance update

Using the corrected explicitly linked final binary on CPU 0, 46/216 matrix
cells and all six supplemental cells fail the strict performance gate:
FX off 1/72 failures, heavy 40/72, realistic 5/72. There are 1,628 measured CPU
deadline exceedances, including 1,624 heavy. Worst p99 is 628.76% of budget.
Heavy mean is at least 50% of budget in 30/72 cells; off/realistic means remain
below 50%, but their tail failures are retained. These figures supersede the
predecessor environment's counts without combining environments or dropping
samples. Original→final mean improvement is 11.54% in the verified final ABBA.
The invalid initial final-v2 attempt is archived with its stale-executable
provenance error and must not support an acceptance claim.

The verified final production source subsequently passed its uninterrupted
1,800-second functional soak (13:23:43.901–13:53:43.911 UTC), with zero tracked
queue/state/nonfinite/new errors. This closes the requested cloud functional
stability gate, not P0 performance or physical-device acceptance. The retained
5,336 co-loaded CPU deadline exceedances and 102,400-byte settled-to-final RSS
delta must not be relabelled as zero XRUNs or a universal absence of leaks.
