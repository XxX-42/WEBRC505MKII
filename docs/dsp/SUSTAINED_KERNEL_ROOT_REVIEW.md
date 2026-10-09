# Sustained Native kernel review

Root independently verified `native_dsp_sustained_r7_20261009T142352Z`:
240 archived input files, 249 indexed archive files, all 577,808 chronological
timings and 196 stage summaries. SHA-256, lengths, nearest-rank percentiles,
maxima, stage continuity and hard-deadline counts match. The reusable command
is `python scripts/verify-native-sustained-snapshot.py bench/results/native_dsp_sustained_r7_20261009T142352Z`.

The 240-file source inventory is a broad snapshot that also includes older
benchmark archives. Its 148-file C++/CMake/script subset is a source-superset
fingerprint, not a list of 148 compiled translation units. Both fingerprints
were independently reproduced from manifest-order UTF-8 `path=sha256` rows,
joined with LF and no final LF. Raw report SHA-256 is
`335fed6a71eef1083dc31dc6c3e7cefbe462e2e87c673d10a7e4511c4a0b0e62`.

The run used Ryzen 9 5900HX, Windows 10.0.26200, MSVC 1929 Release, 48 kHz and
64-frame software calls. Each of 49 cases has 256 startup, 1,024 warmup,
10,000 steady and 512 flush calls. Generation/scans/reporting are outside the
timed interval; steady-clock timer overhead is included. Operator `new` counts
are zero in the measured processing region. This does not prove absence of
every allocator, every lock, or Browser callback-thread GC.

| Steady kernel | P99 / P99.9 / max (microseconds) | Calls above 1.333333 ms |
| --- | --- | ---: |
| Linked stereo compressor | 8.3 / 36.6 / 318.5 | 0 |
| 4x ADAA nonlinear | 150.4 / 1000.5 / 5182.3 | 6 |
| 4096-tap convolver | 160.0 / 329.4 / 2604.1 | 1 |
| 32 active grains | 236.5 / 409.8 / 3781.9 | 2 |
| YIN 2048, analysis every 32 callbacks | 285.8 / 442.1 / 537.0 | 0 |
| YIN 2048, analysis every callback | 578.6 / 1224.3 / 6130.6 | 9 |
| Spectral freeze | 282.7 / 347.2 / 489.8 | 0 |

There are **20 hard-deadline exceedances** across all stages: the table's 18
steady calls plus two YIN warmup calls. YIN every-callback P99.9 exceeds the
80% target. A functional 49-case PASS must not be described as strict realtime
PASS. Cadencing analysis reduces typical load but does not itself implement
an incremental bounded analysis algorithm.

The 32-grain case reaches all 32 slots, and the convolver uses a 4096-tap IR.
Two separate reducer states process left/right. Eight current registry adapters
are included; this does not test all 53 FX, the four newer performance adapters,
or actual LIVE_MONO/LIVE_POLY/HQ_RENDER routes. A single kernel's execution time
is neither algorithmic signal delay nor hardware round-trip latency. Each
steady slice is about 13.33 seconds of simulated audio, not a 30-minute full
product graph stress run. Gates 1–7 remain unqualified by this evidence.
