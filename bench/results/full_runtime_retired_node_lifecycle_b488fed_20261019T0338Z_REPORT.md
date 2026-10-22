# Retired recorder/overdub callback diagnostic

Status: focused 90-second real-Chromium AudioContext diagnostic; not the 30-minute acceptance run and not hardware/XRUN evidence.

## Causal finding

`TrackAudio.finishRecording()` and `finishOverdubNode()` already disconnect their input/output connections and close the MessagePort after the final recording completion or overdub patches/acknowledgement arrive. Both one-shot processors nevertheless returned `true` unconditionally from `process()`, keeping retired worklets scheduled. The change in this commit keeps the recorder’s passthrough alive until `STOP_RECORD`, then returns `false`; overdub remains alive through initialization and active rendering, posts its stop acknowledgement/final patches, then returns `false`. Invalid overdub initialization now retires the processor after sending its error.

## Matched workload snapshots

Both runs used CfT headless shell 154.0.8037.57, a real 44.1 kHz Chromium AudioContext, the production 35-worklet full-runtime graph, the same 90-second duration and 30-second operation cadence, with the same test-only SharedArrayBuffer callback observer (84.88 MiB reserved). The graph included five LIVE_POLY tracks, all 20 private A–D inserts, input/shared FX, and the real recorder/overdub paths. These are sequential diagnostics, not interleaved ABBA performance trials.

| Processor | Before: active frames | Before: callbacks outside active interval | After: active frames | After: callbacks outside active interval |
|---|---:|---:|---:|---:|
| looper-processor | 29,696 / 30,080 | 2,612,352 | 31,104 / 32,128 | 0 |
| rc505-overdub-processor | 15,616 / 15,616 | 1,329,792 | 16,000 / 16,512 | 512 |

The candidate run completed one stereo replacement recording (30,336 frames, 2 channels, no overflow) and one overdub/undo/redo operation. All tracked dynamic intervals and all 20 private inserts passed their 95% frame-coverage checks. AudioContext progression was 88.131/90.001 s = 97.92% (guard: 95%); output sentinel passed; zero callback errors and zero non-finite output. The remaining 512 overdub frames are a short teardown scheduling tail; this diagnostic doesn’t assign them a CPU-time cost.

Context progression is a software-side guard, not endpoint continuity. Callback CPU quantiles are not measured because the available worklet clock is too coarse. The prior run also passed the software progression/output checks; this change is specifically evidenced by the collapse in post-retirement callback frames, not by a claim of overall real-time acceptance.

## Reproduction

```sh
node bench/run_browser_audio_worklet_stress.mjs --profile full-runtime --duration-seconds 90 --sample-rate-hz 44100 --operation-interval-seconds 30 --browser /tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell --output bench/results/full_runtime_retired_node_lifecycle_b488fed_20261019T0338Z.json
```

Raw candidate: `full_runtime_retired_node_lifecycle_b488fed_20261019T0338Z.json` plus `.progress.json` and `.status.json`.

Pre-change comparison: `active_interval_coverage_record_90s_bc26ca0_20261019T0332Z.json` (committed in the preceding coverage checkpoint).
