# Independent Rubber Band R2/R3 pitch-shift evaluation

This is a standalone Windows x64 evaluation of Rubber Band Library 4.0.0, built from upstream commit 1d95888bec3ae0a17c0c4af791810d5a63f6bc35. It runs the real-time RubberBandStretcher in its R2 and R3 engines at 48 kHz stereo with fixed 64, 128, and 256 frame calls, pitch scales 1.0, 0.5, and 0.25, and a 1.0 time ratio. It does not alter the product build, DSP registry, or adapter.

The tone tests reuse the exact 55, 110, 220, and 880 Hz stereo input PCM and the archived 0.5x Signalsmith candidate output PCM from octave-signalsmith-models-candidate-20261009T194342Z. The same analysis routine measures Rubber Band and those four stored Signalsmith outputs. The Signalsmith archive contains no paired 0.25x output or callback timing distribution, so those comparisons are unavailable. Separate 3-second fixtures cover an identity impulse and gated stereo notes with short transients. Each Rubber Band run saves its complete pre-trim stereo output in float32 little-endian form.

For each stretcher, the harness reads getPreferredStartPad, getStartDelay, the deprecated getLatency alias, and getSamplesRequired; it prepends the reported zero pad and removes the reported delay for aligned duration and tone analysis. The impulse case separately records raw onset, peak, and peak offset after subtracting pad and reported delay. This distinguishes the API alignment estimate from measured impulse behaviour.

results/callback-timing.csv stores every process/retrieve wall-clock duration in original order, including startup and the final input call. Per-run P50/P99/P99.9/max and counts above 60%, 80%, and 100% of each actual input block budget are in results.jsonl and recomputed in manifest.json. The callback measurement includes process() and retrieval into preallocated planar output buffers. Global C++ new and delete counters are enabled around those calls; this does not intercept C malloc, Windows heap APIs, locks, or waits. No timing spikes are removed.

## Build and license

Run capture.ps1 in PowerShell to build and run the preserved evaluator. rubberband-v4.0.0-source.tar is generated from the pinned upstream commit; its corresponding extracted source tree and GPL COPYING file are included here. The build uses the bundled Rubber Band DSP code with its built-in FFT and resampler, MSVC 19.29.30159, Meson 1.12.1, and Ninja 1.13.2. The exact logs, static library, object files, evaluator executable, source hashes, and PCM artifacts are indexed by SHA256SUMS.txt.

Rubber Band is licensed under GPL version 2 or later when received from the upstream repository. Upstream separately offers commercial licences for proprietary redistribution. This archive is an evaluation copy and grants no additional right to incorporate or distribute the library in a proprietary product. See the upstream licence terms at https://breakfastquay.com/rubberband/license.html and commercial licence page at https://breakfastquay.com/technology/license.html. No Rubber Band file is placed in the product source tree.

## Limits

These results describe one software-only machine and one standalone harness. They do not establish live device callback safety, system-wide heap/lock freedom, Native/Web parity, a final-quality pitch algorithm, or product suitability. The timing numbers use steady_clock wall duration; scheduler and host interference remain in the maxima. No audio hardware was opened.
