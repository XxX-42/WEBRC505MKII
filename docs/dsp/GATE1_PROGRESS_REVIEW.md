# Shared DSP review: Gate 1 in progress

This is an intermediate review, not an acceptance report. Gate 0 has passed; no runtime gate has passed. Native, Browser/WASM, and catalog/spatial work run concurrently using `gpt-6-luna` with `max` reasoning. The coordinator reviews source, measurement methods, and independently reproduces completed batches.

## Accepted partial evidence

- `46889cf`: control/dynamics, oversampled nonlinearity and shelves, with independent Native CTest 3/3 and immutable raw records. See `CONTROL_NONLINEAR_ROOT_REVIEW.md` for measured filter delay, the preserved over-deadline run, and scope limits.
- `21365e8`: the initial WASM interface, compiled-source manifest, Native/Node fixtures, and a real AudioWorklet interface probe. Its accepted 1024-callback probe processes one mono biquad at 128 frames/48 kHz through a software sink. It does not qualify the five-track graph or all primitives. See `WASM_INTERFACE_ROOT_REVIEW.md` for trace archives, rejected runs, and timing attribution.
- Both commits are pushed to `codex/instrument-grade-audio-20261007`. Generated WASM and local build output remain reproducible artifacts rather than completed product integration.

## Additional accepted functional and standalone evidence

`df038ca` has independent combined shared-core Native CTest 5/5, a later final pitch assertion 1/1, fresh pinned-Emscripten pitch tests, and an immutable Native parent snapshot build with CTest 6/6. `f647ac9` adds fresh spatial timing arrays with independently recomputed quantiles/source hashes and the corrected standalone Rubber Band comparison. See `SPATIAL_PITCH_ROOT_REVIEW.md` and `RUBBERBAND_ROOT_REVIEW.md` for their actual scope. A newly reported immutable LLVM 23.1.3 AddressSanitizer 5/5 pass is awaiting coordinator log/manifest review; the earlier concurrent-source run remains stale.

## Source review still requiring full qualification

FFT/spatial and pitch modules have accepted partial functional evidence. Longer cross-runtime PCM fixtures, a reviewed sanitizer archive, complete callback allocation coverage and all-module timing distributions remain required. Native 64 frames and Browser actual output-array quantum remain separate measurement configurations.

Spatial review caught and requested fixes for convolution size overflow, frequency-unit confusion in spectral freeze, grain-window edge normalization, reverse capture/play cadence, drum modal amplitude normalization, and voice-pool discontinuities. The current absolute-frame reverse design removes the unequal capture/play cadence, but its startup transition and repeated voice stealing still need quantitative coverage. Timing archives that contain only percentiles and source hashes collected after running an external executable cannot establish full source/build provenance or raw callback acceptance.

Pitch review requires bounds before floating-point-to-integer conversion, explicit failed-prepare behavior, fixed-seed provenance, preallocated finite-input/output sanitation, and inactive graph staging. Offline buffer PSOLA is not a live route. A mode enum does not implement or qualify LIVE_MONO, LIVE_POLY, and HQ_RENDER. The complete live detector/resynthesis path needs measured buffering, observation/onset latency, quality, and CPU tails; direct known-F0 setters do not test live tracking.

## Rubber Band measurement correction

Rubber Band v4.0.0 is evaluated only in an external TEMP harness; its GPL/commercial licensing boundary is not changed and it is not linked to the product. Preliminary process/retrieve timing is distinct from hardware delay and full-graph timing.

The coordinator independently calibrated the first harness's autocorrelation/parabolic frequency estimator on a perfect 8192-sample sine at 587.329535834815 Hz, 48 kHz, amplitude 0.62, starting at source frame 48000. It returned 587.469882729 Hz, a +0.413642-cent bias. Its approximate residual calculation reported -25.106 dB on this ideal sine. Thus preliminary approximately +0.43-cent R3 errors and residual values near that floor do not prove library quality. The expression `rms^2 - amplitude^2/2` assumes finite-segment sine/cosine orthogonality and is not an exact least-squares residual.

The expanded corrected archive now calibrates the estimator, fits sine/cosine/DC jointly, computes the residual directly, retains every chronological section and tests final tail draining. Coordinator recomputation passes. Its measured finalization spikes, delay-trimmed length differences, correlated stereo fixture and standalone scope remain explicit limits; see `RUBBERBAND_ROOT_REVIEW.md`. Earlier records remain excluded from quality acceptance.

## Remaining acceptance work

All F01-F29 target paths, parameter smoothing, switching, resets, malformed inputs, stable memory and raw per-callback tails require evidence. Official FX control extraction remains fail-closed until its source geometry/defaults are reviewed. Full FX registries, actual rhythm patterns/16 kits, full Native/Web integration, and 30-minute integrated stress remain required later gates. Hardware end-to-end latency and device XRUN are unmeasured under the user's software-only scope. Existing application features and pre-existing user edits remain preserved.
