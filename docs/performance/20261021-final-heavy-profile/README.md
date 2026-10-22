# Final five-track stereo graph profile

## Method and binding

Exact source commit 85de65407377ad0efcbf99967e521db86f9f036d was archived into a fresh independent source tree and built Release with -pg on compile and link. Explicit benchmark targets passed version-1 source/header/object/archive/executable verification. The actual native_performance_matrix graph ran on CPU 0 at 48 kHz, 64 frames, five independent stereo tracks, each PREAMP → DIST → ROBOT → reverb, for 30,000 measured callbacks after preparation and warmup. No competing task-team CPU job ran. This is a full callback graph, not a PREAMP kernel.

Raw gprof call graph and flat profile are in gprof.txt. Build manifest, flags/logs, run output, binary/profile SHA and command are retained. gprof includes preparation/warmup and perturbs code/call overhead; its timings and budget exceedances are diagnostic only and are NOT new uninstrumented performance admission. The accepted current matrix/soak remain the preceding follow-up evidence.

## What costs time

Self sampled CPU: PREAMP loop 23.51%, PREAMP ADAA 22.58%, ROBOT tracker 13.35%, Signalsmith spectrum 7.43%, DIST loop 6.23%, PSOLA YIN 4.87%, reverb 3.54%. PREAMP inclusive is about 46.1%; ROBOT inclusive about 33.1%. Inclusive and self figures overlap and must not be added together. These locate sustained DSP compute, not only occasional scheduling tails.

Native track routing self is 0.16% and callback shell 0.04%; frame parameter creation occurred only 5 times. Command application/control functions have no resolved self samples at this 10 ms sample resolution. This gives no measured support for another broad parameter cache or command-dispatch rewrite as the next ≥3% target. It does not prove zero overhead.

Tracked callback C++ allocations are zero. There is no PMU cache-miss or scheduler/lock trace, so this profile cannot prove memory-bandwidth limits, absence of every allocator, or scheduler causes of maximum-latency failures. Physical hardware absence does not excuse the sustained software budget failure.

The 6.11% apparent NativeOscBot destructor remains suspect profiler attribution. Actual DIST processInPlace disassembly calls tanhf and a constprop processSample clone, not that destructor. Symbol and call extracts are retained; no destructive-object optimization is inferred from this misleading symbol.

## Redundant-looking work that is not safely removable

NativeRobotCore::processInterleaved (source lines 469–478) runs left/right PSOLA and Signalsmith each segment before selectProcessingMode chooses the audible branch. The call graph confirms both paths are substantial: Signalsmith wrapper inclusive about 12.6%, PSOLA path about 6.7% of profile time. This is a concrete persistent-state architecture cost. The unselected branch still updates its detector, synthesis, latency-alignment and transition histories; selecting it later depends on those histories. Directly skipping it is not an unchanged-PCM or unchanged-latency optimization. No such edit was made.

A future mode-aware state-advance/output-materialization split could be investigated, but it needs a specific proof of which state transitions can be maintained without rendering the unused output, then exact PCM/status tests through mode transitions, automation, transients and latency alignment. This profile does not supply that proof or authorize a quality-reduced shortcut. It is a design prerequisite, not a validated speedup.

## Bounded disposition

The fresh whole-graph profile confirms the same mathematical hotspots after right-pristine integration. Exact FIR rearrangement, frame/primitive reuse extensions, forced ADAA inline, ROBOT ring traversal and ordered SSE2 reductions have already been evaluated and rejected where below threshold or regressive; repeating them is not a new hypothesis. No additional concrete low-risk ≥3% candidate is established by this profile. The next meaningful step requires a new state-preserving ROBOT design or a separately justified numerical/architecture proposal with explicit correctness, latency and cross-platform gates. No production source was changed, and no matrix or soak was repeated for this diagnostic.

This closes the missing final-graph profile only. It does not declare software P0 resolved, all possible optimizations exhausted, or hardware/user-machine acceptance complete.

## Attribution and cold/warm limits

The gprof process lifetime includes track recording/setup and cold preparation, then 1,000 FX warmup callbacks and 30,000 measured callbacks. The 34,760 callback-shell calls include setup; 9,920,000 PREAMP process calls equal (30,000 + 1,000) × 64 × 5, and 317,440,000 ADAA calls include both stereo channels, oversampling and stages. These are instrumented call counts, not separate independent benchmark samples. The 450 process-lifetime operator-new calls include setup; they do not contradict the timed callback allocator counter of zero.

Shared libm/other shared-library functions are not comprehensively instrumented by this executable's -pg build. Their costs may be omitted or attributed imperfectly to surrounding native symbols; inlining and compiler clones also affect attribution. Therefore the profile supports DSP-family localization but does not independently quantify total tanh/log cost, a complete memory/system breakdown, or additive exact CPU fractions across libraries. Distortion clone/destructor attribution remains explicitly unresolved. The source and post-profile manifests match for dependency inventories and binary hashes.
