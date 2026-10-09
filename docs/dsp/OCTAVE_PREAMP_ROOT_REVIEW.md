# OCTAVE and PREAMP standalone checkpoint

Root reviewed the frozen compiler inputs and independently reran all three archived Release executables. The compiler is MSVC 19.29.30159.0 (VS2019 toolset 14.29.30133). Original artifact indices are unchanged. Indexed artifacts pass SHA-256 verification: OCTAVE 26/26, impulse audit 24/24, PREAMP 27/27. The respective captures contain 9, 10 and 11 inputs; the audit includes a derived, instrumented OCTAVE source. Every canonical captured source matches the working tree. Root reruns are not independent recompilations; producer logs and before/after manifests identify the compiled inputs. `root-review.json` records the root verification and log hashes.

## OCTAVE 28

The adapter processes left and right independently with an STFT phase vocoder, preallocated storage and bounded automation. At 48 kHz, default window 2048 / hop 256, the aligned timeline is 2048 frames (42.6667 ms), while the first thresholded wet impulse sample is frame 257 due to startup/window spread. These are different metrics. A 500 ms gated tone extends to 538.667 ms.

At +12 semitones, 220/330 Hz inputs produce 439.999669/660.000019 Hz; at -12, 880/660 Hz inputs produce 439.999772/330.000077 Hz. Wrong-channel ratios range from 7.04e-9 to 5.58e-8. Warmed unity reconstruction error is 5.96e-8; 64/128/256 partitions produce identical PCM. The bounded 64-event callback fixture records zero allocations/frees.

The separate instrumented impulse audit captures raw wet values before the output guard and compares warmed cases to identical no-impulse baselines. All six cases have zero nonfinite samples and zero clipping. For impulse L=.9 / R=-.65, cold unity raw energy is .692204 versus warmed impulse-delta energy 1.23250. Cold -12 energy is .301789 versus warmed delta .560964; cold +12 is 1.23250 versus warmed delta 2.54400. Raw absolute maximum in these fixtures is 1.46468. This exposes a cold-start/transient limitation; it is not a transient-quality pass.

The phase-vocoder primitive still uses spectral-bin interpolation without transient phase locking or formant preservation. This experimental adapter does not satisfy the final Pitch-quality contract merely because frequency, channel isolation and bounded execution pass.

## PREAMP 23

PREAMP implements x4 WDF diode saturation (or separately selectable ADAA cubic), four tone sections, actual per-channel partitioned cabinet IR convolution, and a smoothed mix against aligned dry audio. It is a clean-room implementation, not Roland DSP. Reconstruction controls remain distinct from official UI parameter contracts.

At 48 kHz with 64-frame cabinet partitions and a neutral IR, the integer dry-alignment anchor and wet impulse peak are frame 86 (1.79167 ms). Thresholded wet onset is frame 73 (1.52083 ms). The x4 nonlinear filter has frequency-dependent group delay; frame 86 is not a universal pure-delay or hardware end-to-end measurement. The anchor is partition 64 plus nearest-integer low-frequency shaper delay 22.

The bass +10/-10 dB fixture at 90 Hz yields a 4.96893 response ratio, two real cabinet IR variants differ by .110846 RMS, and 64/128/256 callback partitions produce identical PCM. The bounded-event callback fixture records zero allocations/frees.

## Qualification boundary

These are standalone adapters and source/evidence commits. Factory, Native host, Browser WASM/product placement, official parameter UI validation, listening quality and realtime deadlines are separate integration gates. No full-graph P99/P99.9, 30-minute stress, zero-XRUN or hardware latency claim is made here. The ongoing implementation goal remains active.
