# Native follow-up: exact zero-state optimization and rejected hypotheses

Baseline is `eb60b801e3842e72d5584d191b00e68d6fc3caed`, not the older initial performance baseline. All measurements are device-free cloud CPU measurements; no physical XRUN, loopback latency or listening claim is made.

## Accepted: right-channel pristine positive-zero shortcut

PREAMP previously processed its silent right channel even for mono input. A reset right channel receiving only positive zero has zero filter/previous-input histories and takes the exact existing nonlinear positive-zero identity. Skipping it cannot discard a tail because the shortcut is irrevocably disabled after any nonzero or negative-zero right input, until an explicit reset. All parameter smoothers still advance every frame. Ring rotation of all-zero arrays is observationally equivalent when the first active sample arrives. Nonfinite input is still sanitized before the decision. This is not an epsilon test, silence detector, or tail truncation.

The raw-stream probe covers 75 configurations: 5 rates (8/44.1/48/96/192 kHz), 5 models, and 3 signal/edge scenarios, with mono/stereo/extra channels, arbitrary block boundaries, reset, parameter ramps, NaN/infinity/negative zero/subnormal and first nonzero onset. Both PCM streams match byte for byte. The production unit regression independently compares the optimized right path to the unskipped left-channel algorithm.

CPU-0 ABBA and BAAB microbenchmarks show average per-run mean time reductions:
- Mono automation 21.74%; mono sine 22.03%; mono silence 50.96%.
- Stereo automation −0.16%; stereo sine −1.87%; stereo silent right path 44.48%.

Mono automation/sine improve in both run orders (21–23%). Nonzero stereo changes reverse direction by order and are not evidence of a repeatable speedup or a proven regression. These are PREAMP-kernel figures, not whole five-track graph gains; the actual mono input bank and whole graph are separately verified below. No change to sample rate, oversampling, filter coefficients, algorithm latency or audio arithmetic is introduced.

## Rejected: FIR ring traversal split

Splitting three PREAMP FIR loops into contiguous spans preserved ordered multiply/add PCM but yielded mixed performance: automation +3.59%, sine −1.08%, silence −12.82%. It is not accepted. This differs from the previously rejected mirrored-ring approach: state dimensions and write count were unchanged. Source patch and raw results are retained.

## Rejected: SSE2 ordered YIN difference squares

The experimental ROBOT path computed two double-precision difference squares in SSE2 but accumulated each lane in the original scalar order, without horizontal reduction, cadence/window/threshold changes or FMA. A scalar fallback is retained for unsupported targets and FMA-target builds. Robot tests plus 18 audio/status-trace scenarios (44.1/48/96 kHz, mono/stereo, all three formant policies) match exactly. Forced-scalar compilation and the same trace comparison pass; this is not a physical ARM test.

However, whole-core 48 kHz/64-frame/five-track heavy comparisons found only −0.15% and +0.30% mean changes in ABBA/BAAB. Mean(run p50) regressed about 1.3–1.45%. Tail quantile changes are noisy and cannot rescue the candidate. It is not merged. Raw A/B rows, hashes and rejected patch remain available.

## Reproduction and evidence

- `bench/native_preamp_pristine_probe.cpp`: raw PCM transition/edge probe.
- `bench/native_preamp_channel_bench.cpp` and `bench/compare_native_preamp_channels.py`: CPU-0 mono/stereo micro ABBA/BAAB.
- `bench/native_robot_ordered_probe.cpp`: raw PCM plus pitch/confidence/voiced/mode/fallback/latency trace.
- `bench/compare_native_candidate_ordered.py`: CPU-0 whole-core A/B with explicit order.
- `candidate-artifacts.json`: screening source/object/binary/PCM hashes. Accepted production builds require the separate comprehensive explicit-target build manifest; screening hashes alone do not certify final source.

## Integrated right-only verification

A fresh baseline source archive and a fresh current-source Release build were independently configured. Explicit matrix, soak and benchmark targets passed the version-1 comprehensive depfile source/header → object → archive → executable dependency guard (including referenced sources outside the engine root and declared system headers), with SHA-256 manifests retained. The final native unit suite passed 46/46 tests. This count is unit tests, not performance-budget cells.

Actual Input-bank PREAMP-only, 48 kHz / 64 frames, 8,000 callbacks, CPU-0 ABBA and BAAB: mono mean(run mean) improved 19.53%, mean(run p50) improved 18.38%. Stereo mean changed −2.21%, while mean(run p50) was effectively unchanged (−0.015%). All PCM hashes match; Input FX peak is nonzero and tracked C++ callback allocations are zero. This graph has one playing track, no Track FX and only Input PREAMP; it is not the full five-track heavy graph.

The full stereo-heavy graph remains over budget. Its ABBA mean change was +0.33% and BAAB −2.61%; mean(run p50) changed −0.43% / −1.72%. These do not establish a ≥3% benefit. PCM hashes match in both orders. Tail quantiles fluctuate and are not claimed as stable improvements.

## Post-change profile and bounded next hypothesis

Instrumented mono-sine PREAMP sampling attributes approximately 49.80% self time to ADAA triode and 48.94% to processInPlace. Mono-silence still executes 61,440,000 ADAA calls on the left channel, while the pristine right channel is skipped. These are gprof-instrumented diagnostics, not admission timings. This supports one final, narrowly scoped experiment extending the exact positive-zero fixed-point shortcut to the left channel; its outcome is recorded separately. No claim is made that stereo-heavy P0 is solved or that every possible future optimization is exhausted.

## Rejected: left-channel pristine extension

After the right-only post-profile, a left-channel equivalent was screened, not merged. The expanded 100-configuration full-PCM probe is byte-identical to the original baseline (SHA-256 2c4ddc7a8127b0a83474a16163b6ef90b30b5ce1373628588c5537ae88c5575f). Relative to accepted right-only, CPU-0 ABBA+BAAB aggregate mean changes are mono automation −3.003%, mono sine −1.026%, stereo automation +0.434%, stereo sine −1.159%. Fully pristine positive-zero silence improved about 98%, but this edge-case benefit does not justify the nonzero workload cost. Mono automation was −0.20% / −5.65% by order, so the exact regression magnitude is noisy, not a universal constant. The conservative disposition is rejection, not a claim of proven global regression. The production left path remains unchanged.

The bounded follow-up has rejected both an exact ordered-YIN SSE2 whole-core candidate (two orders below 3% mean gain) and the post-profile left-pristine extension (no repeatable active-workload gain). This supports stopping these specific candidate families, not claiming all software P0/P1 budgets are met or that no future architectural improvement is possible. Stereo-heavy PREAMP/ROBOT workloads remain software P0. Physical driver/XRUN and real user deployment remain outside these cloud tests.

## Final functional soak provenance

The final right-only source is frozen for a fresh 600-second real-wall, device-free Native soak. Its runner now accepts an optional comprehensive build manifest, requires version 1 with nonempty dependency records, and checks the binary plus all dependency/object/archive bindings both before and after execution. Legacy calls remain explicitly unverified. Seven short stub tests pass, covering valid binding, legacy/no manifest, missing binding version, empty dependencies, changed executable and mid-run dependency mutation. These stub tests are not audio tests.

The 600-second soak is co-loaded with other correctness/build work and is functional stability only. No isolated latency, physical underrun, XRUN or user-machine deployment acceptance may be inferred. Its completed result is recorded in final-soak-600s.json; absence of that completed file means the soak is not yet passed.

Completed final-source soak, 18:45:51–18:55:52 UTC: 600.003 real-wall seconds, 225,001 callbacks, 6,000 commands, 750 FX changes; zero state errors, nonfinite frames, rejected commands and tracked C++ callback allocations. Pre/post build binding verified. Settled RSS was 7,573,504 bytes and final RSS 7,548,928 bytes. There were 1,424 CPU-budget exceedances under co-load; these are not physical XRUNs, and this run does not establish a latency budget pass. See final-soak-600s.json.

## Fresh final-source matrix acceptance (not reused history)

After the final 600-second soak, all other task-team CPU work stopped. CPU 0 ran the full 216-cell matrix with 1,000 warmup and 300 measured callbacks per cell, followed by all 6 Input/shared/rhythm/pitch supplements with 2,000 measured callbacks each. Current-source results are 216/216 functional PASS, 168 strict performance PASS and 48 FAIL; all 6 supplements are functional PASS but strict performance FAIL. Tracked C++ callback allocations are zero. The strict conjunctive rule is p99 < 50% of callback period, maximum < 80%, and zero CPU-budget exceedances. These fresh results replace historical budget counts for this final source, but unpaired cross-time differences are not proof of a regression or improvement.

The version-1 complete dependency and binary inventories were identical before and after the matrix/supplements. Raw current acceptance evidence is in final-matrix/native-matrix.json, final-supplements.json and final-acceptance-summary.json; final-post-matrix-manifest.json records the closing verification. Cloud scheduling maxima remain noisy, and physical driver/XRUNs are not measured. Residual software P0 therefore remains open despite the exact mono Input PREAMP optimization and successful functional stability.
