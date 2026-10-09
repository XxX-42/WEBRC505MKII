# Shared rhythm renderer timing review

The coordinator independently verified the 110,000 chronological wall-clock samples in `shared/dsp/benchmarks/results/native-rhythm-20261009T132827446Z.json`, its raw SHA256 `d848369a0619f9845d7b9d970fb30f43b11797433792959a7733dfe5cd8df707`, and all 23 archived exact source/build inputs. Source archive fingerprint is `e40b4801ec0851f0c1b33ca13e19199bde275960ce8c172c463afb19a589f5e9`. Every scenario's block/frame sequence, P99/P99.9/max, budget exceedance counts and hard-miss flags recompute correctly. The fresh standalone MSVC 19.29 Release rhythm CTest passes; compiled translation units, commands and logs are retained in the adjacent `.snapshot` archive.

All times below are measured wall-clock execution in microseconds, at 48 kHz. Counts compare individual callbacks against 60%, 80% and 100% of their frame deadline; they are not percentages. Source-generated procedural patterns and instruments are clean-room reconstructions.

| Scenario | Frames | Samples | P99 µs | P99.9 µs | Max µs | Counts >60/80/100% |
|---|---:|---:|---:|---:|---:|---:|
| Sustained clean-room pattern | 64 | 50,000 | 124.8 | 237.9 | 1176.6 | 3 / 1 / 0 |
| Sustained clean-room pattern | 128 | 10,000 | 230.6 | 393.4 | 1667.1 | 1 / 0 / 0 |
| Sustained clean-room pattern | 256 | 10,000 | 503.8 | 688.0 | 1008.1 | 0 / 0 / 0 |
| Maximum event collisions | 64 | 10,000 | 153.6 | 196.4 | 536.2 | 0 / 0 / 0 |
| Maximum event collisions | 128 | 10,000 | 329.0 | 445.9 | 814.2 | 0 / 0 / 0 |
| Maximum event collisions | 256 | 10,000 | 737.4 | 1159.2 | 4189.0 | 1 / 0 / 0 |
| Fill/tempo/variation boundaries | 64 | 10,000 | 170.6 | 204.7 | 285.8 | 0 / 0 / 0 |

Frame deadlines are 1333.333/2666.667/5333.333 µs for 64/128/256 frames. This captured kernel run has zero hard-deadline exceedances; it does not measure production audio callbacks, hardware latency, device XRUN or the complete instrument. The 50,000-block primary fixture covers 66.667 seconds of simulated audio in an accelerated offline run, not a 30-minute real-time stress test. Runtime memory, complete target graphs, host integration and capture-time environment/contending-workload details still need qualification. Gate 1 and Gate 6 remain unpassed.

The earlier `native-rhythm-20261009T130541817Z` capture and its 22 exact inputs remain preserved. Coordinator recomputation confirms P99/P99.9/max 501.7/871.5/3850.5 µs at 128 frames, with 4/2/2 exceedances against 60/80/100% budgets. Its two hard misses at frames 318208 and 568832 did not coincide with bar or event boundaries. They remain measured failures; later results do not erase them. The separate `131006435Z` capture preserves an unusable Windows GetThreadTimes per-callback measurement. Its coarse 15.625 ms CPU accounting cannot qualify kernel CPU time. Intermediate smoke and failed postprocessing records are diagnostic, not promoted results.

The newer capture retains both wall-clock timings and QueryThreadCycleTime counts with a CPU-second calibration. Conversion to estimated nanoseconds has explicit DVFS/frequency limitations and is not a replacement for measured wall-clock deadline counts. The PowerShell postprocessor grew to approximately 14 GB after the timed run and was interrupted; Python finalized the preserved raw/source evidence. That tooling failure is recorded separately and is not renderer memory usage.

The raw data also includes fixed-seed per-kit numeric spectral/envelope proxies, sustained-polyphony metrics and brush-steal transition metrics. These provide functional evidence for original synthesis; they do not establish perceptual equivalence to factory kits or a completed listening/quality gate. Further product integration, state restoration, allocation coverage, full graph timing and 30-minute stress remain required.
