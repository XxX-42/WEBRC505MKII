# Browser 41 checkpoint: independent review

The frozen Browser product builds and passes its software behavior checks. It is a partial checkpoint; the full DSP, Pitch quality, and integrated realtime Gates remain open.

| Evidence | Result | Scope |
|---|---|---|
| Full Vitest run | 34 files / 223 tests PASS | Frozen app, single worker, 394.25 seconds |
| Type check + production build | PASS | `vue-tsc -b`, Vite 7.2.4, pinned asset guard |
| Long recording regression | 14 tests PASS | Original 185-second stereo recording assertions retained at 16/48 kHz; timeout changed to 180 seconds |
| Real Chromium smoke | 74 assertions PASS | Chromium 149.0.7827.55, 48 kHz, actual 128-frame calls, same-context synthetic input, sink=none |
| Root asset check | VERIFIED | All 77 raw build-input SHA values and actual served 743,642-byte WASM identity |

The real browser checks include independent left/right recording signatures on all five tracks, Input FX affecting recorded PCM, Track FX ports, Master FDN tail and DC-to-dry transition, and Memory A/B/A stereo restoration. The looper control-buffer references now use the shared DSP object. Master FX history needed for startup is accounted separately from its alignment delay, including serial chains.

The full suite and browser smoke were executed by the Browser agent against the frozen copy; Root read the raw logs, verified source closure and hashes, and independently ran the Node asset guard. Root did not repeat the full 394-second suite. The initial browser smoke failed because its imported stress driver was missing; that log and the successful rerun are both preserved. The successful JSON still contains two COEP blocked-resource errors. The full build also retains bundle-size and stale compatibility-data warnings.

The original 27-row overlay inventory was incomplete: six added source/test files were missing. Root detected this and verified the additive 33-row v2 inventory. Its canonical SHA is `ddd1855cee0144e8bd88b066d46c427be5f32105ac30e11007eb15ab76f525ba`. The original file was preserved. The source capture originally counted 188 files: 187 are product inputs; one is a capture explanation README, absent from the product. The archive labels that README explicitly as evidence.

The exact source ZIP, 33 overlays, complete 77-file WASM input set, runtime and unit/config/helper inputs, original capture manifest, logs and raw JSON are under `bench/results/browser-fx41-root-checkpoint-20261009T223440Z`. There are 236 distinct archived product paths. The checker verifies raw bytes for all pinned WASM inputs; it accepts only CRLF/LF differences for the remaining Git sources and reports their count. This is needed because the preserved base ZIP contains checkout bytes, not necessarily the raw base Git blob bytes.

```powershell
python scripts/review-browser-fx41-checkpoint.py --archive bench/results/browser-fx41-root-checkpoint-20261009T223440Z --repo . --revision HEAD
```

The product WASM SHA is `eb567831965c6194890e602f12a0999773e04eb46f8e22b4330d1424b13017dc`; its source-set SHA is `44afa10f105ef624066ff762173e33e2caf33013d343789462faa8e043f34e0d`. Exact flags, compiler identity, pins and all source hashes are retained in its build manifest.

This checkpoint carries Pitch Worker scaffolding with synthetic unit coverage, not completed HQ-render product or PCM-quality acceptance. Newer Native 50-processor registry, Host carrier/MIDI work, Native UI/control protocol and real software HTTP checks remain in parallel development outside this frozen scope. Neither kernel times nor the sink=none smoke certify hardware latency, callback deadline safety, 30-minute continuity, all 53 FX quality, or the complete implementation task. User aggregate.py and generated code-only Markdown changes were preserved and excluded from staging.
