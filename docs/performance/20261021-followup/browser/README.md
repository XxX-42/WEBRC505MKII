# Browser follow-on: exact Gate Reverb coefficient cache

Scope: exact production FX worklet under Node VM, not an actual Chromium AudioWorklet callback or hardware XRUN measurement. The cloud browser exists, but its URL policy denied the local file test page. No security setting was changed and that denied route was not retried. Prior exec Chromium socket permissions and cross-namespace localhost limitations remain unresolved.

## New profile-linked candidate

The baseline Gate Reverb V8 profile has 8,184 samples, including 511 self samples (6.24%) in `updateGateReverbEnvelope`. The function recomputed the same threshold power and hold-sample rounding at every frame after its smoothers settled, and repeated a fixed-rate detector exponential. Release exponentials likewise repeated whenever the release control value was unchanged.

The candidate caches only these pure derived values. All three smoothers still advance every sample, and the exact original equations and operation order remain unchanged. All envelope, hold and release state still updates every sample. A NaN key never hits; +0/-0 yield the same derived coefficients under these specific equations. Reset may retain pure coefficient caches because they are keyed by the next actual smoother values, not by stale requested targets.

## Isolated ordered comparison

48 kHz, stereo, five independent Gate Reverb instances, 512 measured blocks per run, three ABBA or BAAB rounds (six runs per variant). These are independent FX kernels, not a full five-track product graph.

- ABBA median run duration: 5,697.569 ms → 5,324.672 ms, improvement 6.54%.
- BAAB median run duration: 6,061.231 ms → 5,827.232 ms, improvement 3.86%.
- Both comparisons capture all parity output bytes and report equal SHA-256 / zero difference.
- These percentages refer to median whole-run time, not callback p99 or an average of per-quantum timings. Host scheduling remains uncontrolled; no samples were discarded.

Raw timing data, baseline/candidate worklet snapshots, source patch and CPU profile are retained alongside this report. Correctness results are detailed below.

## Reproduction

Build candidate with `npm run build:worklet`. Use `bench/compare_browser_worklet_vm_matrix.mjs` with `ALGORITHMS=gate-reverb RATES=48000 CHANNELS=2 TRACKS=5 BLOCKS=512 ROUNDS=3`, once default ABBA and once `ORDER=BAAB`. Pass the baseline and candidate snapshots and output JSON path. `bench/experiments/verify_gate_cache_parity.mjs` adds full-stream control/reset/bypass cases.

Global remaining Browser issues are not closed: actual production graph callback distribution, main-thread/GC/IPC profiling and hardware latency/listening require the supported execution conditions listed in `browser-access.json`.

## Correctness results

- Full-stream baseline/candidate PCM: 16/16 cases bit-identical and finite, each ten seconds at 8/44.1/48/96 kHz, mono/stereo, default/extreme controls. Includes threshold/hold/release sweeps, invalid requested parameters, bypass ramps and resets. This is offline audio duration, not ten seconds of realtime execution per case.
- Targeted unit regression: 61/61 across core, shipped-worklet and new four-rate exact envelope-state tests. The first new 96 kHz test hit Vitest's 5-second timeout due to calling assertion-library code three times per sample. The original log is preserved. The test now compares the same per-sample values into one accumulated boolean and asserts at the end; neither sample coverage, timeout nor numerical tolerance was relaxed.
- No production UI, transport, sample rate, oversampling, coefficients, filter topology or gate trajectory was changed.

## Final constructor scope and re-profile

The timed candidate snapshot is `gate-cache-candidate.js`. The final source computes the fixed detector exponential only for Gate Reverb construction, avoiding new constructor work for unrelated algorithms. Gate Reverb arithmetic is unchanged. `gate-cache-final.js` is the rebuilt final Gate-only snapshot. It passed 16/16 additional 512-block full-stream cases and 4/4 envelope-state unit cases. The ten-second cases above apply to the earlier timed candidate, not this final hash.

The final V8 profile has 9,278 samples, with 267 (2.88%) attributed to `updateGateReverbEnvelope`, versus baseline 511/8,184 (6.24%). The remaining dominant self samples are `processReverb` (6,268), `readLagrange4FromBuffer` (1,318), and `processBlock` (963). These are profile attribution counts, not wall-time speedups or real-browser acceptance. Prior FDN/interpolation candidate failures remain applicable; no new approximation is introduced.

## Second candidate: identical LFO evaluation reuse

A standalone TREMOLO V8 baseline profile attributes 160/711 samples (22.50%) to pure `lfoValue`. TREMOLO and AUTO PAN called this pure function twice with identical waveform/phase/phase-step whenever their old and target waveforms matched. The candidate reuses that result only in this exact case. It still performs the original `old + (target - old) * blend` expression, and computes both evaluations during different-waveform transitions. There are no random or stateful calls inside this function.

First isolated comparisons: 48 kHz stereo, one independent instance, 256 blocks, two rounds (four timed runs per variant). TREMOLO median run improvement is 13.51% ABBA / 17.81% BAAB; AUTO PAN is 6.58% / 4.45%. All captured PCM bytes match. These small-kernel results must not be extrapolated to a five-track graph. These were preliminary screening results; the completed five-instance confirmation appears below.

Additional full-stream PCM passed 24/24 cases: TREMOLO/AUTO PAN, 44.1/48 kHz, mono/stereo, initial sine/triangle/square waveforms, waveform transitions, bypass ramps and reset. All 384-block outputs were hashed, finite and bit-identical. `lfo-candidate.js` contains both the verified Gate cache and this LFO reuse. `gate-cache-final.js` is the isolated LFO baseline.

Post-profile: `lfoValue` self samples are 88/620 (14.19%). `processBlock` is now 389/620; this broad dispatch/loop category is not itself evidence that another specific safe optimization will pay off. Prior block-dispatch negative findings are not superseded by it.

The short single-instance percentages above are candidate-screening evidence, not the final confirmed gain. The confirmation harness runs both ordered sequences in one process, warms each of five independent instances for 1,024 blocks, and measures ten rounds of 1,024 blocks each (20 measurements per variant per sequence and algorithm). It records every duration, environment, PCM hash and configuration error. The process is not pinned; host scheduling and CPU-frequency control remain external limitations. No samples are discarded.

## Five-instance confirmation and frozen result

- ABBA tremolo: median full-run 1591.502 ms → 1370.269 ms, 13.90% improvement.
- ABBA auto-pan: median full-run 1966.404 ms → 1877.209 ms, 4.54% improvement.
- BAAB tremolo: median full-run 1593.052 ms → 1375.899 ms, 13.63% improvement.
- BAAB auto-pan: median full-run 1969.329 ms → 1894.779 ms, 3.79% improvement.

All four scenarios have identical full-stream parity hashes, zero maximum difference, finite output and no configuration errors. Each reported median uses 20 measurements per variant. Exact source snapshots, per-run durations and final environment are in `lfo-confirm.json`; process/OS/allowed CPU set were also captured before the run in `lfo-confirm-environment.txt`. These confirm relative five-instance FX-kernel benefits, not a production five-loop graph or callback latency budget.

Browser code is frozen for this batch. No further CPU timing was started after this confirmation. The parent performs integrated build and full-unit regression on the combined Native/Browser change set.

Remaining actionable boundary: real Browser AudioContext/AudioWorklet scheduler, complete product graph callback p99/p99.9/max, main-thread/GC/IPC profile, device latency and XRUN cannot be established from this Node VM. They require a supported HTTP(S) test origin reachable by the cloud browser and an allowed instrumented browser execution path, or another authorized sandboxed browser environment. The denied file URL route was not retried. Current Reverb profile is dominated by FDN/interpolation; prior exact rearrangement candidates were non-beneficial, and changing these equations without new sound-quality/error evidence would not be an acceptable optimization. This batch does not certify overall software P0/P1 closure, the target budget, or hardware acceptance.

Snapshot caveat: `gate-cache.patch` records the first measured Gate candidate. `current-candidates.patch` records the final conditional Gate constructor plus accepted LFO reuse. `gate-cache-final.js` is the isolated Gate-only final snapshot; `lfo-candidate.js` is the combined frozen Browser worklet.
