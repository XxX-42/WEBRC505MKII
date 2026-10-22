# PREAMP candidate with selected Native LIVE_POLY active

This is a separate serial ABBA diagnostic of the PREAMP per-frame parameter reuse candidate committed as `621db8f00e898d8c0c426fc37054f09f49e234ca`. It uses the same portable Native callback benchmark as the no-pitch test, with the selected pitch route enabled using `--pitch=live-poly --pitch-track=1 --pitch-semitones=7`. The measured warmup confirmed `pitchRouteActive=true` and `pitchFallbackReason=none` in every run. Five synthetic tracks and all twenty private A–D FX slots are active; input is mono synthetic, output stereo, no Input FX is configured. The PREAMP slot is in the existing full topology. This remains a Linux CPU callback simulation without an RtAudio device or hardware acceptance.

Commands, in serial order, are recorded in each `.meta` file. A uses `/tmp/native_per_track_fx_bench_A_baseline_0ffe10c`, B uses `/tmp/native_per_track_fx_bench_B_candidate_fb3bd75`. Their SHA-256 values are in `binary-sha256.txt`; compiler/build flags are GCC 14.2.0, `-O3 -DNDEBUG`, C++17, from the same Release build family as the no-pitch ABBA. Parameters are 48 kHz, 64 frames, 5,000 warm-up callbacks, 100,000 measured callbacks, 5 × 300-second stereo loops, and selected track 1 shifted by +7 semitones. The callback deadline is 1.333 ms; target thresholds are P99 <= 0.800 ms and P99.9 <= 1.067 ms.

| Run | Mean | P99 | P99.9 | Max | >1.333 ms hard deadline |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 baseline | 518.027 us | 1.285 ms | 3.467 ms | 28.168 ms | 932 |
| B1 candidate | 481.338 us | 1.018 ms | 2.654 ms | 8.772 ms | 594 |
| B2 candidate | 484.304 us | 1.081 ms | 2.641 ms | 44.947 ms | 642 |
| A2 baseline | 496.435 us | 1.007 ms | 2.606 ms | 10.526 ms | 479 |

All runs emitted the same finite-output hash, `0x21687c733d9a51ea`, and all requested output samples were produced. The two candidate runs have lower mean latency than A1/A2, but A2 also improved substantially over A1, so this short ABBA is not conclusive evidence of a stable tail improvement. Both candidate runs miss the P99 and P99.9 contract targets and have hard-deadline misses. The real-time gate remains FAIL. Results do not cover all possible pitch target tracks, Input FX, native audio-device scheduling, or hardware XRUN behavior.
