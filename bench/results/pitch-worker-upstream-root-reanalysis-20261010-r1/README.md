# Independent Pitch Worker PCM reanalysis

This additive capsule preserves every raw input read by the Root comparator:60 finite Float32 little-endian mono sidecars (six fixtures, two channels, original input/Worker/CABI full/upstream chunked/upstream exact), plus the process-plan and declared comparator reports.

Root recomputed metrics with math.fsum, validated raw hashes, unique fixture identities, contiguous input/output processing partitions bounded to8192frames, full process-plus-flush length, and exact crop offsets. All six Worker stereo crops equal direct C ABI bytes. Largest Worker-versus-chunked-upstream max-absolute sample difference:0.00029125437140464783. Largest single-call-exact versus chunked-upstream difference:0.02587217092514038. The two upstream call schedules must not be described as byte-identical.

The original1.5x low endpoint energy occurs in the upstream same-schedule output too; this removes evidence for a separate Worker cropping omission. It does not establish perceptual endpoint quality, absence of upstream edge artifacts, or a universal RMS acceptance threshold.

Reproduce the independent numerical review from this directory:

```text
python review-pitch-worker-pcm.py .
```

Root replayed this copied capsule and compared its full JSON output with the original Root review. This is reanalysis of captured outputs, not a compiler/Worker execution rerun, real Browser graph test, hardware latency measurement, or Pitch Gate4 acceptance. Original executor driver/build/source-capture evidence remains in browser-pitch-exact-cabi-20261010T234000Z-r3, which is a separate artifact. The exact WASM module/source-input checkpoint is already captured in browser-context50-root-kernel-20261010-r1 (commit a854901). No live DSP, public WASM, or source pin is installed by this change.
