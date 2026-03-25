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

## Notes

- This repository snapshot is documentation-heavy; some older phase docs no longer match the latest UI implementation.
- Audio behavior depends on browser support for Web Audio, microphone permissions, and output-device APIs such as `setSinkId`.
- `test:e2e` uses mocked browser audio and native-bridge shims for repeatable UI verification. Real audio/device validation remains a manual check.
