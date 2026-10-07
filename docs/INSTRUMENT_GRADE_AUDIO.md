# Instrument-grade audio measurement

For the software-only verification selected for this run, see [the 2026-10-07 results](AUDIO_SOFTWARE_RESULTS_20261007.md), the [strict-importable offline FX report](measurements/software-fx-20261007.json), and the [strict-importable Node Worklet report](measurements/software-worklet-20261007.json). The user stopped hardware testing; all physical acceptance fields remain unknown and the gate remains `NOT_VERIFIED`.

This report format separates physical round-trip measurements, software diagnostics, and unknown values. Import uses a strict schema validator: unsupported keys, missing action classes, an inferred latency, or an unknown encoded as `0` are rejected. Every measured value carries its provenance, sample count, timestamp, device, sample rate, evidence reference, and optional independent clock anchor. Unknown measurements use `null` values, `sampleCount: 0`, and null measurement metadata.

`Hardware RTL` is the total measured loop through the ADC, browser, project DSP, DAC, analog cable, and capture detector. `Input` and `Output` are separate display rows, but the total RTL is never divided between them. Their provenance may be `driver-reported` or `unknown` until independently timed. A browser latency hint, CPU render duration, half a round trip, or device-reported capture buffer is not a physical RTL measurement.

## Pass gates

The top-level status is `INSTRUMENT_GRADE_PASS` only when every item below has the required evidence. A measured value above a threshold is `FAIL`; missing or incomplete evidence is `NOT_VERIFIED`.

- The measured path is the WebRC505 project graph at 48,000 Hz and 128 frames, with evidence for the analog ADC → browser → project DSP → DAC → cable → ADC path. The simple Web Audio bypass baseline and the offline FX benchmark are diagnostic only.
- Hardware RTL is physical-loopback evidence with P50 **strictly below 10 ms** and P95 **at most 12 ms**. The separate P50 target of ≤10 ms does not satisfy the strict pass threshold by itself.
- Jitter is computed as `Hardware RTL P95 − P50` from the same trace, same sample count, device, sample rate, and measurement time; it must be **below 1 ms**.
- REC, PLAY, STOP, and FX each have a separate physical trigger result. Each action's **maximum intent-to-analog-capture delay must be below 5 ms**. Worklet acknowledgements and `AudioContext.currentTime` are not analog-arrival measurements.
- Overdub alignment uses the absolute error maximum and must be **≤1 ms**.
- Stability coverage is at least **1,800 seconds** with zero XRUNs. Evidence must include the actual callback deadline and a continuous physical sample marker or equivalent hardware dropout evidence; rendered-frame counters alone do not establish hardware continuity.
- Loop drift must have physical evidence for both the absolute maximum (**<1 ms**) and a regression slope supporting a non-accumulating result.

Input/output values are shown even when unknown, but they are not independent pass gates. This avoids inventing latency halves when only the total loop can be timed.

## Separate 96 kHz profile

The callback profile is **96,000 Hz / 128 frames** (a 1.333 ms frame interval), measured independently for at least 1,800 seconds with the same selected input and output device IDs. Its callback P99 must be below 0.8 ms, with zero XRUNs, a measured callback deadline, and continuous physical sample-marker coverage. It has its own `callback96kStatus`; its evidence does not replace the 48 kHz / 128-frame project-path run.

## RC-505mkII clock reporting

Keep interface, capture-stream, and processing-graph rates distinct. BOSS lists the RC-505mkII sampling frequency as 44.1 kHz. The browser may request a 48 kHz AudioContext and resample a 44.1 kHz USB capture stream; store both the reported interface clock and `MediaStreamTrack.getSettings()` values. The capture stream rate is not relabeled as the device's hardware clock. [BOSS RC-505mkII specifications](https://www.boss.info/global/products/rc-505mk2/)

The physical probe runner selects explicit RC-505mkII endpoints and records endpoint labels, capture settings, browser arguments, output sink ID, AudioContext output timestamps, and latency hints. It never infers a physical analog loopback from endpoint names or signal correlation: the current run must include `--confirm-physical-loopback` and a descriptive `--loopback-description`, and the selected endpoints must match SUB1 capture and MAIN render. Omitting either confirmation keeps Hardware RTL unknown. This per-run operator assertion must describe the cable and routing that are actually connected now; a prior route statement does not carry over to later runs.

## Runners

Run `node scripts/audio-benchmark-software.mjs --out <path>` for OfflineAudioContext diagnostics of the project's actual FX classes. It outputs a strict-importable report and a raw trace. The report contains 21 effect/rate rows over 105 renders at 44.1, 48, and 96 kHz. Per-effect and full-chain 48 kHz results, including Phaser and Slicer, are recorded in the linked software results document. The CPU render duration is descriptive only. No live device is opened.

Run `node scripts/worklet-benchmark.mjs --phase-minutes 30` for the Node/V8 process simulation, then `node scripts/audio-benchmark-import-worklet.mjs --input <raw-results.json> --out <report.json>` to create a strictly validated dashboard report. The accelerated sample timeline and Node deadline-miss counter remain software diagnostics, not browser callbacks or hardware XRUNs.

Run `node scripts/audio-benchmark-hardware.mjs --input-label SUB1 --output-label MAIN --probes 100 --url http://127.0.0.1:5173/ --out <path>` with the project Vite server running. The runner requires unique RC-505mkII endpoints, chooses the explicit MAIN sink, uses a bounded windowed chirp, and keeps capture disconnected from audible monitoring. It verifies the actual Chromium command line contains neither `--mute-audio` nor a fake media device. `--headed` selects visible full Chromium for backend diagnosis. A physical path can be asserted for that run only with `--confirm-physical-loopback --loopback-description "<currently connected analog route and routing settings>"`; endpoint matching and correlation alone never set `physicalLoopbackConfirmed`. Its `web-audio-bypass-baseline` can never pass the project DSP gate, even when it detects the physical loopback.

For Windows endpoint diagnosis, `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/audio-endpoint-diagnostic.ps1 -EndpointName MAIN -DurationSeconds 12 -OutputPath <path>` reads the RC-505 MAIN endpoint volume/mute, endpoint peak meter, and active session volume/mute. It never invokes a setter. The output meter is upstream of endpoint volume attenuation, so a peak confirms a stream reached the Windows render endpoint; it does not prove the DAC or analog connector produced that signal. [Microsoft IAudioMeterInformation reference](https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nn-endpointvolume-iaudiometerinformation)

Both runners write the report, a sibling `.trace.json`, and (for hardware runs) an inventory file under the requested output basename. They do not change the OS default device, endpoint volume, or RC-505 routing.

## Current diagnostic snapshot

The software runner produced 21 effect/rate rows from 105 renders. The detailed software report preserves the full 48 kHz FX first-arrival, peak, and tail results and the Node Worklet phase measurements. These are software diagnostics and are not hardware RTL.

The first verified full-Chromium hardware diagnostics used SUB1 capture and MAIN render. Headless and headed runs had the explicit MAIN sink selected and advancing AudioContext output timestamps, but found no correlated return. Authorized 0.03 and 0.05 full-scale diagnostics likewise found no correlated return. At the time, the capture summary analyzed channel 0 only; it does not establish that every capture channel lacked a return. The Windows MAIN render peak meter followed the requested probe amplitudes, and MAIN and Chrome session volume were 1.0 and unmuted. This proves the browser stream reached the Windows MAIN render endpoint, not the RC-505 DAC or analog connector.

The user clarified that the INST1 cable signal conductor is grounded and there is no MAIN analog return, then chose software-only work for this turn. Preserve the earlier reports as grounded-input/no-loopback diagnostics; their Hardware RTL and other physical acceptance metrics remain unknown. The saved headless-shell run remains invalid because Playwright had implicitly muted its audio. The hardware runner only exercises a Web Audio identity bypass; a physical project-graph runner for REC/PLAY/STOP/FX triggers, overdub alignment, and 30-minute hardware continuity has not been implemented or run. Do not treat any software report as satisfying those gates.
