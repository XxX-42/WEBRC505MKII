# Compressor software optimization measurements

This comparison isolates the compressor change. It uses the project’s actual `CompressorFX` and AudioWorklet processor in Chromium 149, with synthetic signals and software-only output. It does not measure an audio device, DAC/ADC path, physical round-trip latency, callback deadlines, or XRUNs. The instrument-grade report therefore remains `NOT_VERIFIED` for hardware gates.

The old `DynamicsCompressorNode` implementation added a fixed 6 ms signal delay. At 48 kHz that was 288 frames; the existing baseline also measured 5.99 ms at 44.1 kHz and 6.00 ms at 96 kHz. This matches the Web Audio specification’s documented internal 6 ms delay for `DynamicsCompressorNode` ([specification](https://www.w3.org/TR/webaudio-1.1/#DynamicsCompressorNode)). The replacement uses a zero-lookahead `AudioWorkletProcessor` and returned the first active-path sample at the scheduled input frame in OfflineAudioContext at all three rates.

The comparison reports are [the pre-change baseline](measurements/compressor-dynamics-baseline-20261007.json) and [the post-change software report](measurements/compressor-worklet-20261007.json). Their raw traces sit beside the reports. The baseline source hash was `E99A3D4A60A91FEE581115ED3C230B094B944ECADF0BB7F1B6E38558A4890B82`; the updated CompressorFX and processor hashes are recorded in the post-change trace. Those hashes identify the code used for each run; after the Worklet run, only explanatory comments were added to CompressorFX.ts for the bypass and parameter smoothing constants. The post-change run uses Chromium 149.0.7827.55, synthetic AudioBufferSourceNode signals, 48 kHz live AudioContext capture, and `setSinkId({ type: 'none' })`; it makes no `getUserMedia` or device-enumeration calls.

| Check | Old built-in node | Worklet result |
| --- | ---: | ---: |
| Active-path first arrival at 48 kHz | 6.000 ms / 288 frames | 0 ms / 0 frames |
| Peak offset at 48 kHz | 6.000 ms | 0 ms |
| High-to-low gain response, amount 50% | 4.900 dB | 22.509 dB |
| Low-level reference gain, amount 50% | +4.418 dB | −0.330 dB |
| Strong-input gain, amount 50% | −0.482 dB | −22.839 dB |
| Stereo-linked gain difference, strong left / weak right | 5.3×10⁻⁸ dB | 1.3×10⁻⁷ dB |
| Amount 0, -4.44 dBFS steady tone | Not measured in the baseline run | 0.000 dB gain change |
| Amount 50%, -60 dBFS tone below knee | Not measured in the baseline run | 0.000 dB gain change |
| Bypass impulse max sample error | 0 | 0 |
| Attack response t63 / t90 | Masked by the built-in node’s look-ahead | 2 ms / 9 ms |
| Release response t63 / t90 | Not measured in the baseline run | 486 ms / 851 ms |
| Non-finite samples / clipped samples | 0 / 0 in this diagnostic | 0 / 0 |

The Worklet’s 48 kHz OfflineAudioContext test awaited `CompressorFX.initialize()`, checked `isReady === true` and `backend === 'audio-worklet'`, then enabled it and checked `active === true` before starting any signal. This prevents the dry fallback from being mistaken for a measured compressor. A 1-sample, unity-amplitude impulse at 2 s produced its first output at the same frame, with peak amplitude 0.994. The impulse’s immediate pass-through is expected without look-ahead; the following gain-response measurement shows the compressor engaging over its attack interval.

The static/dynamic profile used amount 50% (threshold −30 dB, ratio 10.5:1, 30 dB knee), a 1 kHz tone, strong left input at 0.6 peak, weak right input at 0.02 peak, and a low-level reference at 0.01. The steady compression difference was 22.509 dB on both channels, and the channel gain difference was below 0.000001 dB. A separate −60 dBFS signal remained unchanged below the knee; amount 0 also remained unity at a −4.44 dBFS level. The new path has no automatic makeup gain. This is a deliberate timbre and level change from the built-in node: in this test the old node raised the low-level reference by 4.418 dB and left the strong signal at −0.482 dB relative to its input, while the Worklet kept the reference near unity and reduced the strong signal by 22.839 dB. The 6 ms latency improvement therefore does not preserve the old output loudness or compression curve; adding makeup gain would also change the newly verified unity-below-knee behavior.

The reported attack and release times describe the measured output gain curve for that signal step, not a buffer delay or direct readout of the detector envelope. The configured attack is 3 ms and release is 250 ms. Release t63/t90 spans 486/851 ms because the test measures gain recovery over the compressor’s nonlinear knee and ratio curve. The bypass path uses a 1 ms exponential time constant (about 3 ms to 95%); the impulse test starts well after setup and does not count that transition as signal latency.

The live Chromium check used a running 48 kHz AudioContext, the real CompressorFX worklet, a synthetic stereo AudioBufferSourceNode, and a second AudioWorklet tap to copy output samples. The `setSinkId({ type: 'none' })` request succeeded. The capture covered 1,673 blocks with zero sample-frame gaps. It independently reproduced the 0-frame impulse arrival, 22.509 dB reduction, stereo-linked gain, 2 ms/9 ms attack response, and 486 ms/851 ms gain release. Because the tap transfers blocks to the page for analysis, this check does not establish callback timing or realtime deadline headroom.

The earlier Node VM phase benchmark’s P99 and Max are synthetic `process()`-loop timing results, not browser AudioWorklet callback latency; see [the software worklet report](measurements/software-worklet-20261007.json). No result here substitutes CPU or Worklet timing for physical audio latency or XRUN evidence.

Browser integration also passed the synthetic software smoke at Chromium 149: COI/SAB were available, the BrowserAudioEngine became ready, and all 19 smoke assertions passed. Engine readiness follows `Promise.all` over its input, output, and five track FX chains, each awaiting compressor initialization.
