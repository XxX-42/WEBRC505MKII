# Remaining Browser software work, not a hardware-only backlog

## What the final profile actually says

The final Node V8 profile contains 7,013 samples. Self samples are processBlock 1,758 (25.1%), processReverb 1,168 (16.7%), processPhaser 492 (7.0%), DIST logCosh3 262 (3.7%), processChorus 257 (3.7%), and Lagrange read helper 249 (3.6%). Sampling attribution is affected by JIT inlining; these are not additive whole-app percentages, and processBlock includes orchestration, smoothing, sanitation and mixing rather than one proven bottleneck.

The original-to-final matrix has five independent FX instances, not five full track graphs with four FX each. Thus the 41–52% kernel reductions do not establish an admitted 20-FX graph or UI/IPC headroom.

## Why the remaining work is not another free exact cache

- FDN Reverb updates sixteen modulated delay lines across stereo every sample. Phase, interpolated read position, damping history and feedback state change continuously. Reusing old interpolation coefficients/output or downsampling modulation would change samples and possibly long feedback tails. The exact contiguous-read and invariant-hoist candidates were tested twice on final source and remained below 3%; their patches/raw results were retained, not promoted.
- Phaser computes quadrature LFO position and per-stage tangent coefficients each sample. Caching per block or updating at a lower control rate changes modulation/filter trajectories. An exact cache would usually miss because phase advances; only a proved invariant can safely be moved.
- Remaining PREAMP/DIST logCosh work computes the primitive at the new input. The prior-input primitive and exact bias invariants are already cached. A lookup table, polynomial approximation or lower oversampling is an algorithm/quality change, not this batch's bit-exact optimization.
- Chorus reads multiple changing fractional delays with per-voice feedback. Sharing voice state or replacing Math.sin with a recurrence can change rounding, drift or stereo phase. Such changes need a different numerical/quality contract, not a hidden assumption that finite output suffices.

## Candidate disposition and remaining measurement needs

| Candidate | Scope and risk | Required gate before accepting |
|---|---|---|
| Hoist immutable algorithm dispatch outside the processBlock frame loop | Tested and rejected: reversed-order gains regressed, bundle +11%; see completed experiment below | Full catalog PCM and exceptional/transition parity passed; repeated ABBA did not confirm a useful gain. Real Chrome profile remains unavailable |
| Consolidate invariant stage/voice constants and array-shape guards | Small candidates; current type/length guards protect reset and unsupported configurations, so unchecked indexing must not weaken behavior | Object.is exceptional-value tests, dynamic stage/voice changes and exact PCM; reject below repeatable ~3% |
| Actual track graph pooling/lifecycle/port measurements | P0 measurement gap, not evidence of an observed leak. Mock port payload counts do not measure browser transfer or allocation cost | Supported browser trace of creation/disposal, queue pressure, real transfers/GC and actual AudioWorklet callback distributions |
| UI 50 ms polling allocation reduction | Source audit sees rebuilt arrays/Set; no measured main-thread bottleneck yet, so currently P2 hypothesis | Main-thread long-task/GC/reactivity trace, state freshness tests, no UI overwrite |
| Cross-platform SIMD/Wasm or different nonlinear/interpolation implementation | Larger architectural/quality tradeoff, not an exact-cache follow-up | Independently defined numerical and audible tolerance, latency/antialiasing/null tests, real-engine compatibility and baseline regression matrix |

No claim is made that all reasonable software candidates have been exhausted. The current supported environment blocks actual browser execution, but not every possible offline prototype. This is a quantified phase delivery with explicit remaining work, not global stopping condition B or C.

## Follow-on dispatch experiment completed

The previously unmeasured block-specialization candidate has now been tested, not merely left as a next-step suggestion. It mechanically specialized four immutable algorithm paths, retained generic fallback, and passed 48 affected full-stream PCM cells, 1,656 all-catalog cases, and 128 exceptional/transition cases (6,144 blocks). However, its initial Reverb +5.49% / Phaser +3.34% gains reversed to −3.10% / −2.81% in reverse-order confirmation; Gate Reverb also regressed. The bundle grew 60,194 bytes (~11%). The candidate was rejected for non-repeatable benefit and unjustified code-generation/size cost. Production source stayed unchanged. Raw candidate source patch, generation script, parity and both timing orders are retained.
