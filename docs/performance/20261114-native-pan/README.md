# Native PAN software callback measurement, 2026-11-14

Device-free MSVC 2019 x64 Release portable matrix. No real audio device or WASAPI host was started. This is CPU callback timing, not a hardware XRUN measurement. A callback's 64-frame budget at 48 kHz is 1.33333 ms. Each run measures 3000 callbacks after the harness warmup. Dynamic PAN uses five control-side CAS writes alternating +25/-25 before every measured callback, and checks all five applied values and revisions afterward; those control and status operations are outside timing and allocation tracking.

Identical center arguments, in order baseline/new/new/baseline:

`48000 64 5 0 3000 playback 2 live-mono none mixed default preamp`

Dynamic new-only arguments:

`48000 64 5 0 3000 playback 2 live-mono pan mixed default preamp`

| Run | Mean ms | P99 ms | P99.9 ms | Max ms | CPU budget exceedances | Callback allocations | Output hash |
|---|---:|---:|---:|---:|---:|---:|---|
| baseline 1 | 1.31057 | 1.8906 | 3.3804 | 6.2778 | 1056 | 0 | 9419360501582919113 |
| new 1 | 1.24418 | 1.9678 | 2.0886 | 2.1527 | 416 | 0 | 9419360501582919113 |
| new 2 | 1.26373 | 1.9038 | 2.0229 | 2.0685 | 496 | 0 | 9419360501582919113 |
| baseline 2 | 1.44090 | 2.1379 | 4.1064 | 16.0395 | 1476 | 0 | 9419360501582919113 |
| new dynamic PAN | 1.34856 | 1.8865 | 2.0472 | 2.1137 | 1160 | 0 | 6574020952305615774 |

All runs reported initial MXCSR 8096 and effective MXCSR 8119. Center output hashes match. The two baseline runs varied substantially, including the largest maximum; this small ABBA sample does not establish a precise performance delta. All workloads exceeded the nominal CPU deadline on many callbacks. Dynamic PAN is a different workload and its output hash is not expected to match center. Raw outputs are the adjacent JSON files.

SHA-256:

- Baseline executable: `39B945AB511F55A531855CFCD70843687C2C3DC59215AB50F380792E8A255B24`
- New executable: `CF0F4DB571D4F3EC5332FB2809C5C47AB6B1D5D0944AA35B0D3B7986D0E07A1D`
- Baseline `native_audio_core.cpp`: `1E4F2DBAA83B0D133B33ACAAE745E4F9B3AA688F74682B1A1A9DB25B74927F62`
- New `native_audio_core.cpp`: `3540D62AA19DFA475B0A7C95FEA120782DD3A25103E667E3E4315DE1F66D3B4F`
- Baseline matrix source: `CA0D1442DA4A4B573DCA9EE8DA02D8E24BA506D8E15FE8869A1CB80C7B91260C`
- New matrix source: `2217FC134F425428AE26259ECF6305EB5BCA63CCE907221F2239A97223549337`
