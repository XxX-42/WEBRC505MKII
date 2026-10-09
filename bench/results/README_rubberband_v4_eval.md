# Rubber Band v4 standalone evaluation

`native_rubberband_v4_expanded_utf8_20261009T113353739Z.json` is the strict UTF-8 machine-readable archive for a TEMP-only comparison. It records raw, unsorted per-call timings and four pitch-shift quality scenes for six configurations. Its SHA256 is `BBFBC9AD7EF92CA53B0B0472880AD7CAE546639BBD4AF5FF6E61FC9C68419524`. Python's strict UTF-8 decoder and JSON parser both pass.

The original measurement bytes are preserved, unchanged, as `native_rubberband_v4_expanded_20261009T113353739Z.raw.cp936`, SHA256 `C923F09BFD0C8224A68F87CF434194DD474B434ACD46067C40DED2708C0E9FB9`. It was emitted using CP936 because the OS metadata contained localized text. The UTF-8 archive was decoded strictly as CP936, validated as JSON, then serialized as UTF-8 with additional archive-encoding, original-byte-hash, and corrected-measurement-status fields. The raw `.cp936` file is provenance only; use the UTF-8 `.json` file for machine processing.

## Provenance and reproduction

- Upstream: [Rubber Band Library](https://github.com/breakfastquay/rubberband), checked out at v4.0.0 commit `1d95888bec3ae0a17c0c4af791810d5a63f6bc35`.
- License: upstream GPL-2.0-or-later, with a separate commercial license. This evaluation was standalone; no Rubber Band source, library, or binary is linked into the product or copied into this repository, and the project license was not changed.
- Local pinned checkout: `C:\Users\user1000\AppData\Local\Temp\webrc-rubberband-v400-source`.
- Local static library: `C:\Users\user1000\AppData\Local\Temp\webrc-rubberband-v400-source\build-msvc-x64\rubberband-static.lib`, SHA256 `2114875b64bd8de17ede3583dccc226571710c77889c88a7800f7dfc5ad8c626`.
- Local harness: `C:\Users\user1000\AppData\Local\Temp\webrc-rubberband-v400-source\rubberband_v4_expanded.cpp`, SHA256 `5EE5385387BD6C663338AF79ECDE2766B6DE1D6FF830F3216480DA4919399B43`. Combined source/harness fingerprint recorded in the JSON: `583403e2e88383cbc726b76b10b1f81d65934e4943cf52b56858f8caef5821d8`.
- Future-safe harness copy: `C:\Users\user1000\AppData\Local\Temp\webrc-rubberband-v400-source\rubberband_v4_expanded_utf8.cpp`, SHA256 `8eaa527488b3b6496df6fa8253fab9198fbaca235b7d5a1ce40b72b9b231d991`. It emits JSON metadata using ASCII-safe escaping and was compile-checked, but it did not generate the archived measurements above.
- Local executable: `C:\Users\user1000\AppData\Local\Temp\webrc-rubberband-v400-expanded.exe`; it and all GPL build files remain outside the repository.
- Build: Visual Studio 2019 Build Tools, MSVC 19.29.30159, release optimization 3, static library, built-in FFT and resampler, upstream tests disabled; harness `/O2 /std:c++17 /EHsc /MD`. The machine, OS, source commit, library hash, compiler flags, and source fingerprint are also in the JSON.

To reproduce on the same host, build the pinned upstream checkout with those settings, then compile and run the future-safe TEMP harness copy against that static library. It emits ASCII-safe JSON metadata and contains the same scene generation, call timing, finalization, frequency estimation, and residual-fit code. The original harness hash above identifies the source used for this measurement; it emitted localized OS metadata in CP936. Both harness copies are intentionally kept outside this product repository because they evaluate GPL-licensed code.

## Measurement scope

All scenes use 48 kHz stereo input, 144,000 frames (3 seconds), and a +5 semitone shift. The scenes are 440 Hz, fractional-bin 437.3 Hz, a 220/277.1826/329.6276 Hz chord, and a gated 440 Hz transient. The right channel is 0.7 times the left. Tone frequency is estimated with a Hann-windowed coarse scan followed by minimization of the exact least-squares residual for sinusoid(s) plus DC. An ideal-tone calibration is included with each scene.

R2/R3 Stretcher configurations process 64-frame blocks (1.333 ms nominal budget), include all pad/startup/warmup/steady/final calls, set `final=true` on the final audio block, then drain available output. R3 LiveShifter uses its actual 512-frame block (10.667 ms nominal budget), with startup and steady calls retained and zero-input flush calls reported separately. Raw timings are measured around processing and output retrieval; the JSON includes every chronological sample, counts over the nominal block budget, reported algorithmic delay, submitted/output frame counts, and trimmed-length deltas.

Steady per-call timing summaries from this one Windows run:

| Configuration | Block | Reported delay | Steady P99 | Steady P99.9 | Steady max | Over-budget calls across all sections |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| R2 standard | 64 | 768 samples (16.00 ms) | 673.2 µs | 873.7 µs | 1,061.2 µs | 3 |
| R2 short | 64 | 384 samples (8.00 ms) | 312.3 µs | 369.4 µs | 420.1 µs | 2 |
| R3 standard | 64 | 1,535 samples (31.98 ms) | 1,064.6 µs | 1,388.3 µs | 1,403.5 µs | 6 |
| R3 short | 64 | 959 samples (19.98 ms) | 1,134.1 µs | 1,446.2 µs | 1,516.5 µs | 6 |
| R3 Live short | 512 | 2,411 samples (50.23 ms) | 1,304.9 µs | 1,642.3 µs | 1,642.3 µs | 0 |
| R3 Live medium | 512 | 2,923 samples (60.90 ms) | 1,935.6 µs | 2,617.8 µs | 2,617.8 µs | 0 |

These are standalone library measurements on one machine. They do not establish 64-frame LiveShifter performance, device callback behavior, Native/Web parity, XRUN safety, or a production mode selection. No hardware audio stream was opened. The earlier pointer-bug run and the earlier non-finalized limited run remain in TEMP and are excluded from this archive.
