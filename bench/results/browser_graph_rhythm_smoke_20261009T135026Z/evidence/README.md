# Browser clean-room rhythm integration smoke

This is a software-only short smoke from an immutable copy of the Browser source and the matching shared-DSP build inputs. It does not qualify callback deadlines or the requested 30-minute integrated stress scenario.

- App source snapshot: source-snapshot.json, 97 files; sourceAssetSet SHA-256 8e286209a074ef792ac6808e06f8859d026868dc8b023d771c6f2dc32dca0e59.
- Exact shared-DSP build inputs and artifact: wasm-build-snapshot/; Emscripten 6.0.10; module SHA-256 c6d4b49ba34aa579aba31d975b024708ac67bea8c1ae3a86aabe7441003e201; module sourceSet SHA-256 7b955f0bc281c2210628d9414cb6aa42e3482fd37a6e13eeecc1f3cce96892b6.
- Smoke result SHA-256 $smokeHash; its browser response captured HTTP 200, 525893 bytes, and the same module SHA.
- Result: 64/64 assertions passed on Chromium 149.0.7827.55, 48 kHz, observed quantum 128. Clean-room kind 121 rendered nonzero PCM on both channels. Memory A→B→A and the subsequent reload restored preset {patternIndex:0,kitIndex:7} and all five tracks' stereo PCM hashes exactly.
- Deadline P99/max and full-render-thread timing were unavailable in this smoke; no RT deadline conclusion follows from these assertions.
- The earlier pre-fix harness failure is preserved separately at ../browser_graph_rhythm_smoke_20261009T134923Z/evidence/harness-failure-validationConfig.json (SHA-256 $failureHash) and was caused by the page-local smoke result missing its alidationConfig member.
- Verifier source SHA-256 $helperHash. From repository root run: 
ode bench/results/browser_graph_rhythm_smoke_20261009T135026Z/scripts/verify-browser-rhythm-smoke-snapshot.mjs bench/results/browser_graph_rhythm_smoke_20261009T135026Z.
- Source manifest SHA-256 $manifestHash.