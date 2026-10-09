# Independent pitch evaluation and measurement review

The adjacent immutable captures preserve Rubber Band 4.0.0 R2/R3 research sources, build outputs, 72 PCM outputs, 165,861 callback timing rows, and the corrected stable-window audit. Their original SHA256SUMS indexes match all copied bytes. Rubber Band remains independent evaluation material; this checkpoint does not add it to product builds. Its copied upstream licensing notices remain in upstream-source.

The root review recomputes every recorded nearest-rank percentile and overrun, verifies all PCM shapes and finite samples, checks both input channels against the exact source bytes, and independently derives the six impulse timelines. It adds a 1–200 Hz Hann spectrum search because the preceding target ±3 Hz projection search hit its boundary. A dominant spectral component is not automatically a perceived fundamental; one-second windows retain their resolution limit.

The original comparison crossed Signalsmith mode changes and incorrectly stated that quarter-octave PCM was absent. The separate earlier v1 additive audit selected a different diagnostic PCM and remains superseded in the local research-input directory. Those originals were not overwritten. The copied v2 uses the correct mode-changing output, and the root JSON records its remaining bounded-search and tautological input-check limitations, then verifies the actual Rubber Band input bytes independently.

Recorded timings include startup, final-input processing, raw maxima and overruns. They were captured while other builds overlapped without process-load metadata, so they do not qualify real-time performance. No timing benchmark or hardware measurement was run for this review. The recorded post-trim length differences are not an exact-duration pass, and the harness did not save terminal available() status. No Native/Browser full-graph, musical-quality, or real-time Gate passes in this checkpoint.

From the repository root, reproduce the read-only review with:

```powershell
python bench/results/rubberband-independent-root-review-20261009T202500Z/root-review.py --rubberband-root bench/results/rubberband-r2r3-independent-20261009T195900Z --audit-root bench/results/rubberband-r2r3-additive-stable-window-audit-v2-20261009T201400Z --output tmp/rubberband-root-review-reproduced.json
```

The producer archives retain original absolute provenance paths; the reviewer resolves their copied inputs in this repository. The complete external compiler/SDK closure was not proven by this research capture.
