# Native Lagrange4 inline candidate: ABBA evidence

## Candidate and decision

The candidate in `3b02c94ffeac2c615fa750f6467ed86e20ca5155` moved the existing stateless `lagrange4` polynomial to the header, preserving the order of operations and replacing `finiteOrZero(fraction)` with its equivalent finite check. A 175,692-case bitwise oracle and the full portable CTest suite passed. The experiment did not show a reliable benefit in the no-pitch full 20-slot workload, and results varied materially by mode and run. The inline implementation is therefore withdrawn from production after this test; the previous out-of-line function is restored. The oracle and measurements are retained.

## Workload and thresholds

Same portable Native callback simulation as the smoother ABBA report: Linux CPU only, five 300-second stereo loops, 20 per-track A–D FX slots, 48 kHz / 64 frames, 5,000 warmup and 100,000 measured callbacks, mono 330 Hz input, stereo output, no input FX slots. LIVE_POLY mode targets only Track 1 at +7 semitones. No physical audio device or hardware XRUN test was used.

The hard callback deadline is 1.333 ms; stricter Native goals are P99 <= 0.800 ms and P99.9 <= 1.067 ms. Each table entry is its own run, not a pooled percentile.

## Results

| Mode | Run | Implementation | Mean ms | P95 ms | P99 ms | P99.9 ms | Max ms | >1.333 ms | Hash |
|---|---|---|---:|---:|---:|---:|---:|---:|---|
| Off | A1 | Out-of-line | 0.477 | 0.664 | 0.939 | 2.668 | 11.273 | 434 | `0x4098664398b58278` |
| Off | B1 | Inline | 0.514 | 0.770 | 1.313 | 2.719 | 11.108 | 956 | `0x4098664398b58278` |
| Off | B2 | Inline | 0.519 | 0.775 | 1.355 | 3.600 | 93.426 | 1034 | `0x4098664398b58278` |
| Off | A2 | Out-of-line | 0.536 | 0.845 | 1.646 | 3.584 | 12.829 | 1545 | `0x4098664398b58278` |
| LIVE_POLY Track 1 +7 | A1 | Out-of-line | 0.539 | 0.811 | 1.423 | 3.213 | 21.850 | 1143 | `0x21687c733d9a51ea` |
| LIVE_POLY Track 1 +7 | B1 | Inline | 0.508 | 0.727 | 1.104 | 2.751 | 20.552 | 674 | `0x21687c733d9a51ea` |
| LIVE_POLY Track 1 +7 | B2 | Inline | 0.492 | 0.667 | 0.985 | 2.720 | 19.326 | 562 | `0x21687c733d9a51ea` |
| LIVE_POLY Track 1 +7 | A2 | Out-of-line | 0.497 | 0.686 | 1.026 | 2.773 | 12.644 | 624 | `0x21687c733d9a51ea` |

The candidate’s output hashes match the previous implementation for both workloads, so the sampled callback outputs are bit-identical. However, the no-pitch candidate does not improve consistently and has a large scheduler outlier; LIVE_POLY looks better in this sequence, but that mode-specific result is not enough to establish a stable overall gain. P99/P99.9 goals and hard-deadline misses remain unmet. No quality approval or hardware result follows from this portable test.

## Raw evidence

- No-pitch ABBA: `bench/results/native_lagrange_abba_20261019T1351Z/`
- LIVE_POLY ABBA: `bench/results/native_lagrange_pitch_abba_20261019T1357Z/`
- Baseline binary SHA256: `679771c74e23bfe912ef78a69bafe581d9cd1710becb176de9bac21e38cc3c31`
- Candidate binary SHA256: `2f570f1751ffdb0a3a5678fab186deb2a97b096ddd4bbb3e0e99b7dd93bb2fe0`
