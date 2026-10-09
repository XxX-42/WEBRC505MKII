# Software validation evidence — 2026-10-09

This directory keeps reproducible, source-linked software evidence for the RC-505 work. The current software checks pass: build/type-check, lint, 176/176 unit tests across 29 files, Playwright E2E 4/4, Chromium Worklet smoke 57/57 and Bounce smoke 21/21. These runs use software-generated input and silent outputs; they do not qualify hardware latency or strict real-time performance.

## Reproduction commands

Run from the repository root. If Playwright does not find its installed browser automatically, set its executable explicitly in PowerShell:

```powershell
$env:WEBRC_CHROMIUM_PATH = 'C:\Users\user1000\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe'
```

| Command | What it exercises | Evidence boundary |
|---|---|---|
| `npx vitest run tests/unit/timeStretch.spec.ts` | Imports the production `public/worklets/time-stretch-core.js` ESM directly. | Verifies PCM/pitch/phase behavior; it does not measure an audio callback deadline. |
| `npx vitest run tests/unit/loadTrackState.spec.ts` | Runs the real `BrowserRealtimeRuntime` and `TrackAudio` against the Worklet harness, including state publication and playing imported stereo PCM after clear/reload. | Synthetic buffers and harness scheduling; not a browser callback or device test. |
| `npx vitest run tests/unit/coreAudioBehaviors.spec.ts` | Runs the production Worklet source through the core-audio harness for state, recording, transport and PCM assertions. | Accelerated software processing. Do not convert frames processed into a wall-clock or hardware-stability claim. |
| `npx playwright test tests/e2e/app.spec.ts tests/e2e/project-memory.spec.ts` | Opens the UI in Playwright Chromium. The app fixture in `tests/e2e/initMocks.js` mocks WebAudio/backend behavior; the Memory spec exercises the browser's IndexedDB store directly. | The controlled Chromium UI E2E run passed 4/4; these are UI/storage checks, not the live audio graph. An earlier under-load 2/4 timeout run is retained in the TEMP error-context archive. |
| `npm run audio:smoke:project-mix` | Uses Chromium's real `AudioEngine`, `ProjectService`, renderer, capture Worklet and registered FX graphs for offline/realtime Bounce. | The 2026-10-09 06:18 UTC run passed 21/21. Synthetic oscillator input only; contexts request `sinkId: none`, route output to private silent destinations, and no media becomes audible. See the immutable [raw JSON](project-mix-smoke-20261009T061812261Z.json) and [23-source hash manifest](project-mix-smoke-20261009T061812261Z.manifest.json). |
| `npm run audio:smoke:browser` | Exercises the real browser runtime and Worklet graph with software-generated media streams. | The latest layout-v4 Chromium run passes 57/57 assertions; see [the raw report](browser-realtime-smoke-20261009T061812658Z.json) and [source/hash manifest](browser-realtime-smoke-20261009T061812658Z.manifest.json). It covers live five-track KeepPitch PCM, Memory A→B→A reload, fractional clock/quantized REC, output gates and four-channel dry/wet isolation. It uses synthetic oscillators and `sinkId: none`; it does not open physical input or certify speaker/headphone output. The 05:59 run remains historical at its original filename. |
| `npm run audio:benchmark:worklet -- --realm same-realm --realm-probe` | Evaluates the production Worklet source with synthetic buffers in Node/V8. Other supported modes include VM realms. | The current raw timing samples and summary are preserved under [the Worklet diagnostic bundle](worklet-bench-20261009T055725581Z-53f516c7/manifest.json). This same-realm software diagnostic is not browser callback timing or hardware qualification. Keep its misses, startup costs and long-tail spikes visible; cross-realm VM measurements can be distorted by realm boundaries. |
| `npm run build`, `npm run lint`, `npm run test:unit -- --run --maxWorkers=2`, `npm run test:e2e` | Integrated type/build, lint, unit and UI checks. | Final controlled results: build/type-check passed (142 modules; 473.86 kB / 137.19 kB gzip), lint passed, units 176/176 across 29 files (102.34 s), and E2E 4/4 (19.8 s). The earlier 168/169 stopped-clock fixture failure, a 169/169 previous snapshot and the high-contention 171/176 run with five timeouts are kept as historical outcomes in [final-checks.json](final-checks.json); they are not current results. |

## Reading timing evidence

Treat unavailable deadline fields as unknown. When a runtime snapshot reports `deadlineMetricAvailable: false` or `processDeadlineMisses: null`, this means no callback-deadline metric was available; it does not mean zero deadline misses. The latest browser smoke explicitly reports deadline telemetry as NA, so it establishes no zero-XRUN claim. Node/V8 `process()` timing and accelerated frame counts are useful diagnostics, not browser callback or physical XRUN measurements. A same-realm diagnostic is still software-only and is not hardware certification.

The current same-realm Node/V8 diagnostic is not strict-real-time qualified. It reports five-track 8-layer KeepPitch P99/max of 2.081/4.571 ms, a 14.906 ms startup block with one startup miss, 11 warmup misses per 2,000 callbacks and 9 measured misses per 3,000. With active overdub the P99/max is 2.341/8.651 ms, startup is 6.876 ms with one startup miss, and misses are 5/2,000 warmup and 13/3,000 measured. The 103-segment-per-track normal-playback case has P99 0.129 ms but a 4.712 ms max and 3/3,000 measured misses. These synthetic `process()` measurements include startup and long-tail overruns; do not label them browser XRUNs or hardware timing. Runtime deadline telemetry in the Chromium smoke is unavailable, not zero.

Software-only Bounce checks establish properties of generated PCM under their tested graph and inputs. `sinkId: none`, a silent destination, and muted media protect against audible output; they do not measure intent-to-analog latency. Physical capture/output latency, device routing, XRUNs and continuous hardware stability remain unverified unless a separate, explicitly instrumented hardware run is performed.

## Current limits

The native backend exposes Track 1; five-track behavior is available through the browser backend. The FX registry retains all six types: Compressor, Delay, Filter, Phaser, Reverb and Slicer. The 512 MiB figure is the realtime shared PCM storage budget, not a whole-process RAM ceiling. Memory recall, Bounce and rollback can temporarily materialize additional `AudioBuffer` copies, and the workflow has no disk spill path. The same-realm Worklet timing report has deadline misses and long-tail spikes, so strict real-time performance is not qualified. No physical audio device was opened for the evidence in this directory.

## Source and artifact identity

The latest layout-v4 browser Worklet smoke raw JSON is [browser-realtime-smoke-20261009T061812658Z.json](browser-realtime-smoke-20261009T061812658Z.json); its manifest binds the report to all six source hashes and the raw JSON SHA-256. Earlier 05:59 and 05:53 runs remain historical with their original names and manifests. The current same-realm Node benchmark's complete JSON, per-process CSV, summary CSV and repro command are preserved in [its evidence bundle](worklet-bench-20261009T055725581Z-53f516c7/manifest.json). The latest Bounce raw JSON is [project-mix-smoke-20261009T061812261Z.json](project-mix-smoke-20261009T061812261Z.json), with a 23-file source manifest at [project-mix-smoke-20261009T061812261Z.manifest.json](project-mix-smoke-20261009T061812261Z.manifest.json); the prior `core-749d3f63` result is historical. Do not edit raw JSON/CSV after a run; create a new uniquely named artifact for each rerun.

The final browser smoke recorded these six source hashes, and they match the measured files:

| File | SHA-256 | Use / qualification |
|---|---|---|
| Browser smoke script (`scripts/browser-realtime-smoke.mjs`) | `244FF8345F8CD697C0626B1194306F2F2A2518B18A4FC1CFE4B25ADE7BA50919` | Recorded in the final browser report. |
| `src/audio/BrowserAudioEngine.ts` | `D43E12403603EA2AC3C5E9DB3F80371882E5C7D0AE193D9052A9040594A0C8BE` | Recorded in the latest browser report. |
| `src/audio/browserRealtimeProtocol.ts` | `B005E5A8FE2DD9EB61B0EABF8CCF6DBD93D225780683C4F6B0B46CDAFCE5073A` | Recorded in the final browser report. |
| `src/audio/BrowserRealtimeRuntime.ts` | `14144A23FFAE503B643B54E9C6926CDAE929DD861845D8F55E294B3AB872A536` | Recorded in the latest browser report. |
| `public/worklets/looper-processor.js` | `4B24344D0E339DBCB4E886BEAC1F0D89C68B341E213098E0CB557AC386BF849A` | Same Worklet source hash as the archived same-realm Node diagnostic. |
| `public/worklets/time-stretch-core.js` | `749D3F63B2856071E32067531A22D8F3DC086C914206352ABCF9F837E80C9F91` | Shared PV core hash in both current Chrome and Node evidence. |

The Bounce bundle separately records `scripts/project-mix-smoke.mjs` SHA-256 `4078B9700596DC08A622D348F85F0CBAAC24E0ECA4B5E4A901B99912E329040A`. The Worklet bundle records the protocol, Worklet, PV core and benchmark runner hashes in its manifest.

These hashes describe the observed worktree snapshot, not future edits. Any source change invalidates conclusions that depend on that source; record fresh hashes with each new result.

## Preserve failures and provenance

Keep every failed or superseded raw output. Do not replace a failed run with a passing file under the same name, edit a result's status, or delete timing samples that explain a failure. Use a new filename for each attempt and retain its original status, timestamps, command, browser/runtime identity, source hashes and relevant logs. The earlier [`project-mix-smoke.json`](project-mix-smoke.json), 05:53 browser report, and all failure traces remain historical artifacts; the final browser report, Bounce result and Node diagnostic are distinct immutable runs.
