# LIVE_POLY reuse / PCM-history lifecycle fix

## Cause reproduced on the pre-fix source

The 35-worklet Browser full-runtime run recorded at `gain_cache_35node_undo_diagnostic_58d1142_20261019T0022Z.progress.json` failed its second dynamic operation while restoring Track 1 after accepted PCM undo. At the 15-second wait deadline, Track 1 was STOPPED with valid stereo PCM, no busy history/recording, `canRedo=true`, LIVE_POLY enabled but inactive, and the existing node retained. The playback and pitch-start promises were still pending. Port trace showed `stop` ACK and then `disposeWasmMemory` ACK, followed by pending `dropBuffers`, `stop`, another `dropBuffers`, and `addBuffers` RPCs. This established that the reuse path had retired its Signalsmith instance and then tried to reuse the closed/disposed port.

## Code change

`TrackAudio` now removes only the LIVE_POLY edge to its track FX input when stopping/reusing a node. Only Web Audio's expected `InvalidAccessError` for an already-absent edge is ignored; other disconnect exceptions propagate. True node retirement and stale initialization cancellation explicitly await `releaseWasmMemory()` instead of treating an unqualified disconnect as a graph edit. Disposal waits for the current buffer-reset request before releasing the lease.

The stress page's RPC/method observation is now opt-in with `--diagnostic-observe-live-poly-playback`; ordinary full-runtime runs do not wrap playback methods or MessagePort callbacks.

## Verification

- `npm run build` passed; third-party notices verified in `dist`
- `npm run test:unit`: 137 files, 948 tests passed
- `NATIVE_BRIDGE_SIMULATION_EXECUTABLE=/tmp/rc505-native-e2e-simulation/native_bridge_host_simulation PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell npm run test:e2e:rubberband`: 90/90 passed, single worker, real Google Chrome for Testing headless shell 154.0.8037.57 and explicit no-audio Native simulation host
- `trackAudioPitch.spec.ts`: stop→play node reuse, PCM undo/redo reuse, clear/disposal lease release, and unexpected disconnect propagation covered
- `node --check` passed for both stress scripts

## Full-runtime stress evidence

Every run used the production BrowserAudioEngine/TrackAudio graph, 35 worklet processors, five LIVE_POLY tracks, 20 private A–D inserts, four input inserts, four shared inserts and Rhythm at 44.1 kHz. These are software-side checks, not hardware/XRUN results.

- `livepoly_fix_35node_15s_58d1142_20261019T0033Z.failure.json`: 35/35 ready; 14.257/15.027 seconds AudioContext advance (94.875%, FAIL; minimum 95%). No state operation ran because the harness requires more than 25 seconds remaining before starting one.
- `livepoly_fix_35node_30s_58d1142_20261019T0034Z.failure.json`: rapid 2-second operation cadence; clear/record/LIVE_POLY restore and overdub/undo/redo completed with exact PCM hashes, but AudioContext advance was 28.288/30.017 seconds (94.24%, FAIL).
- `livepoly_fix_35node_90s_58d1142_20261019T0034Z.failure.json`: original 30-second cadence and 15-second history wait, diagnostic observer enabled. Clear/record, LIVE_POLY restore and exact-hash overdub/undo/redo passed; measured AudioContext advance was 84.753/90.001 seconds (94.17%, FAIL).
- `livepoly_fix_35node_90s_production_observeroff_20261019T0038Z.failure.json`: same 90-second workload with diagnostic observer disabled. Both state operations and exact PCM hashes passed; AudioContext advance was 83.853/90.050 seconds (93.12%, FAIL).

The full-runtime callback CPU timing metric remains ineligible in this browser: AudioWorklet `performance.now()` is unavailable, while `Date.now()` had 1 ms resolution, so callback timing quantiles are suppressed. All reported estimated missing callbacks and callback errors were zero in these runs; that does not override the independent AudioContext progression failure.

Raw `.failure.json`, `.progress.json`, and `.status.json` files are retained alongside this report. The 30-minute rerun is still pending.
