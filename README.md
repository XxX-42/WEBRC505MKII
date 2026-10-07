# WebRC-505MKII v2

Browser-based loop station prototype inspired by the BOSS RC-505MKII. The project is built with Vue 3 + TypeScript + Vite and focuses on real-time loop recording, quantized track sync, track/input FX routing, and hardware-style UI.

## Current status

The prototype is buildable and the main interaction flow is present:

- 5-track looper UI with per-track record, stop, reverse, level, and filter controls
- Master/slave loop logic with BPM inference from the first recorded track
- Quantized slave recording start/stop aligned to measure boundaries
- Input FX and Track FX slot routing from the top panel
- Audio input/output selection, loopback latency test, and THRU monitoring safety prompts
- Hardware-style transport, beat indication, and RC-505-inspired visual system

## Key files

- `src/audio/AudioEngine.ts`: audio context, device management, monitoring, top-level FX routing
- `src/audio/TrackAudio.ts`: per-track recording, playback, overdub, reverse, quantization hooks
- `src/core/Transport.ts`: BPM, clock, beat/measure events, master-track timing
- `src/components/TopPanel.vue`: input/track FX slot UI and persistence
- `src/components/TrackUnit.vue`: per-track controls and track-level FX interaction

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

Test and verification:

```bash
npm run test:unit
npm run test:e2e
npm run test:ci
```

If Playwright's expected browser is unavailable, `WEBRC_CHROMIUM_PATH` can point
to an existing Chrome/Chromium executable. `WEBRC_E2E_PORT` changes the dedicated
UI test server port (default 5175).

Native build verification and CPU benchmarks (Windows/MSVC):

```powershell
npm run native:verify
npm run native:benchmark
```

The verification scripts write builds, objects, and benchmark results under the
Windows temporary directory. CPU benchmark results do not certify physical audio
latency or hardware stability.

## Realtime hosting requirements

The browser realtime engine uses `AudioWorklet` and `SharedArrayBuffer`. Serve it
over HTTPS (localhost is suitable for development) and return both headers on the
document:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite development and preview servers include these headers. A production host
must configure them independently; the generated static files cannot set HTTP
headers. Check `window.crossOriginIsolated === true` before testing audio. External
resources also need permission compatible with the embedder policy.

The performance dashboard distinguishes physical measurements, driver reports,
software diagnostics, and unknown values. UI tests use audio mocks; their results
cannot establish `INSTRUMENT_GRADE_PASS`.

Run the actual browser engine with a synthetic source and silent software sinks:

```powershell
npm run audio:smoke:browser
npm run audio:benchmark:software
```

The smoke checks five-track recording, playback, overdub, monitoring, filter
mapping, and calibration invalidation. The offline benchmark writes a report
that the dashboard can import. Neither run measures hardware RTL. See
[measurement gates and current evidence](docs/INSTRUMENT_GRADE_AUDIO.md).

With the development server running, reproduce the separate effect benchmark:

```powershell
npm run audio:benchmark:fx -- --base-url http://127.0.0.1:5173 --repeats 5
```

It imports the project's actual effects into independent offline audio contexts.
First arrival, peak, tail, and render duration are separate columns; offline
render duration does not measure realtime callbacks or hardware latency.

```powershell
npm run audio:benchmark:worklet
```

This runs the real processor source in a synthetic Node/V8 host and checks the
shared protocol, frame scheduling, and CPU cost. Its optional accelerated
sample-timeline test cannot certify a 30-minute physical run or hardware XRUNs.
The converter requires a completed accelerated phase run. Save that run's raw
JSON and import it as a software diagnostic dashboard report:

```powershell
npm run audio:benchmark:worklet -- --phase-minutes 30 --phase-yield-blocks 256 --phase-yield-ms 20
npm run audio:report:worklet -- --input <raw-results.json> --out <report.json>
```

The [software measurement snapshot](docs/AUDIO_SOFTWARE_RESULTS_20261007.md)
records measured values, current limits, and the decision to omit hardware tests.

## Notes

- This repository snapshot is documentation-heavy; some older phase docs no longer match the latest UI implementation.
- Audio behavior depends on browser support for Web Audio, microphone permissions, and output-device APIs such as `setSinkId`.
- `test:e2e` uses mocked browser audio and native-bridge shims for repeatable UI verification. Real audio/device validation remains a manual check.
