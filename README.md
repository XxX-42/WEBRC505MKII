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

## License and third-party components

First-party WebRC-505MKII source is distributed under the GNU General Public License, version 3 or (at your option) any later version; see [`LICENSE`](LICENSE). The project includes separately licensed third-party components. Their upstream licenses and notices are preserved and are not replaced by the project license; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the component notices shipped under `public/THIRD_PARTY/`.

The historical generated code snapshots (`2025_WebRC505MKII_v2_code_only.md`, `project_code_full.md`, and `project_code.zip`) may reproduce third-party material from the snapshot date. Keep any component-specific copyright notices and license terms included with that material; the root project license does not relicense third-party code.
