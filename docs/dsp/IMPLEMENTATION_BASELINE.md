# DSP Implementation Baseline

Audit date: 2026-10-16
Repository: `XxX-42/WEBRC505MKII`, default branch `main`
Baseline commit: `646514ebda24a1e330a486375c4a270824397683`

## Scope and verification

This is the checked-out repository baseline, not a claim that the project already implements the full dual-runtime contract. The project README describes a Vue 3 + TypeScript browser looper prototype. The native target is explicitly an MVP. The contract and the clean-room algorithms are in the supplied implementation package; Roland factory DSP topology, factory rhythm note events, and drum samples are not present in the repository or package.

Environment observed for this audit: Linux x86-64, 9 CPUs reported by `nproc`, Node 24.19.0, npm 11.9.0, GCC 14.2.0. `npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/rc505-npm-cache` installed the lockfile dependencies. Baseline checks passed: `npm run build`; `npm run test:unit` (4 files, 8 tests). These checks use mock Web Audio/native bridge coverage; no physical audio device or end-to-end acoustic latency was measured.

## Current audio paths

### Browser

- `src/audio/AudioEngine.ts` selects between Browser and Native engines and currently reports Browser support for five tracks, rhythm, and FX.
- `src/audio/BrowserAudioEngine.ts` creates an `AudioContext` with `latencyHint: 'interactive'` and a requested 44.1 kHz rate, loads `/worklets/looper-processor.js`, and owns the input/output FX anchors, track mixer, master gain, and rhythm engine.
- `src/audio/TrackAudio.ts` records through the looper AudioWorklet, then stores and plays a completed `AudioBuffer` with `AudioBufferSourceNode`. Overdub still uses `createScriptProcessor(4096, 1, 1)` and performs sample-loop writes in the ScriptProcessor callback.
- `public/worklets/looper-processor.js` is attached per recording operation. Its `process()` callback allocates a new `Float32Array` for every captured block and appends it to a growing JS array; stopping concatenates all chunks into another `Float32Array`. This is a real-time allocation/GC and memory-copy risk, not a preallocated recording store.
- The Browser mixer does not instantiate a central worklet DSP graph. The existing worklet only passes input through and buffers record data; track playback, track FX, master routing, and rhythm are regular Web Audio nodes/objects.
- FX execution is primarily Web Audio node graphs in `src/audio/fx/*`. Existing dynamic A-D routing instantiates only `FILTER`, `DELAY`, `REVERB`, `SLICER`, or `PHASER`; fixed `FXChain` also has compressor/filter/delay/reverb. This is not a single shared DSP graph and does not cover the 53-entry contract.
- `src/audio/RhythmEngine.ts` has only `ROCK`, `TECHNO`, and `METRONOME`; its 16-step pattern scheduler uses `window.setTimeout`, creates oscillator/noise/buffer/filter/gain nodes per hit, and uses `Math.random`. It is not sample-frame scheduled and does not use a fixed voice pool.
- `src/audio/AudioEngine.ts` and the UI report Browser buffer length as 128 frames. This is a UI/default assumption; no generic DSP callback was found to test arbitrary render quantum lengths.

### Native

- `native-mvp/engine-cpp/src/native_audio_core.cpp` opens RtAudio streams and feeds `LooperCore::process`. WASAPI can use separate input/output callbacks joined by bounded SPSC queues; ASIO uses a duplex callback when available.
- Native controls advertise `NATIVE V1: TRACK 1 ONLY`; the TypeScript capability facade explicitly disables Native FX, reverse, rhythm, and beat feedback. The Native MVP is not a 5-track / 4-FX runtime.
- `NativeAudioCore` uses mutexes for control/lifecycle methods, a preallocated looper and fixed queues for callbacks. The split WASAPI path passes a large fixed `AudioBlock` through an SPSC queue; callback stack/copy cost needs measurement. No callback-level allocation counter, block-time percentile report, or 30-minute stress test exists in the checked-in tests.
- CMake pins RtAudio 6.0.1, cpp-httplib 0.16.3, and nlohmann/json 3.11.3 via `FetchContent`; Windows-only backend linkage means this Linux cloud build is not an end-to-end Native device test.

## Existing feature inventory

Present in code: Browser five-track UI and recording/playback, overdub, clear, reverse, quantized record start/stop hooks, master/slave transport timing, device selection, monitoring controls, loopback test scaffolding, and limited Browser FX/rhythm prototypes. Native: one-track record/play/overdub/clear through a bridge, with explicit capability disclosure.

Not found in executable audio code during the baseline source audit: an FX registry for 53 algorithms; four-FX sample-accurate A-D DSP graphs; Native five-track routing/FX; sample-accurate browser/native rhythm engine; 240-entry pattern metadata index; 16 differentiated kit implementations; explicit `LIVE_MONO` / `LIVE_POLY` / `HQ_RENDER` pitch engines; FDN8/FDN16 main reverb; ADAA/oversampled distortion; or full memory/undo/redo/bounce/export/MIDI implementations. `src/components/panel/CenterMainPanel.vue` visibly labels its UNDO/REDO control a placeholder, and `src/core/types.ts` contains bounce configuration data without a matched render/route engine. These features must not be described as already preserved or passed until verified in source and tests.

## Realtime risks and current test gaps

1. Browser overdub uses deprecated ScriptProcessor with a 4096-frame callback; this is not a low-latency AudioWorklet path.
2. Browser rhythm timing depends on a main-thread timer and creates Web Audio nodes for events.
3. Browser FX are assembled as ordinary Web Audio nodes and mostly lack the required DSP formulas, stable IDs, serialized state, and parameter metadata.
4. Browser buffer and latency reporting is hard-coded to 128 frames rather than derived from actual render arrays.
5. Native capability is deliberately limited to one track without FX/rhythm. Existing callback behavior is not tested at 64 frames on hardware.
6. Existing automated suite has 8 unit tests across four files and mocks audio devices/bridge behavior. No DSP primitive golden tests, FX registry tests, rhythm drift tests, objective pitch/reverb/alias tests, whole-graph timing distributions, allocation instrumentation, or long-duration stress artifacts were present at baseline.

## Baseline acceptance boundary

The passing Vite build and 8 unit tests only establish that the current UI/state prototype compiles and its small mocked tests pass. They do not establish algorithm coverage, callback safety, audio quality, XRUN-free operation, AudioWorklet end-to-end behavior, Native device behavior, or 30-minute reliability. No latency, P99/P99.9, CPU, acoustic, or hardware measurements are available at this baseline.
