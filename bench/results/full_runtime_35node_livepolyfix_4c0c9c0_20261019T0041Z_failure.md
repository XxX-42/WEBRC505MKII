# 35-node full-runtime soak: interrupted by diagnostic capacity

- Run ID: `full_runtime_35node_livepolyfix_4c0c9c0_20261019T0041Z`
- Source commit: `4c0c9c0d272d683c467fca8fe46c1cb78fc25646`
- Browser: Google Chrome for Testing headless shell 154.0.8037.57; sandbox requested; no added launch flags
- Profile: production `full-runtime`; five tracks, 20 private A–D FX, four input FX, four shared FX, five LIVE_POLY routes, rhythm, real recording/overdub/history operations
- Requested: one uninterrupted 1,800-second wall run, 44.1 kHz, 30-second operation cadence, observer disabled
- Started: `2026-10-19T00:41:50.270Z`; graph ready with 35/35 worklet processors at `2026-10-19T00:41:58.071Z`
- Terminated: `2026-10-19T01:08:45.309Z`, after 1,607.254 measured seconds. This is not a completed 30-minute result.
- Terminal error: `Timed out waiting for Track 2 real overdub worklet` during operation 53

## Evidence and diagnosis

The persisted progress has 96 instrumented nodes at termination: 28 FX, 14 Signalsmith, one rhythm, nine looper, and 43 overdub nodes. The harness defines `MAX_SLOTS = 96`, stores every created node in `state.nodes`, and never retires/reuses a slot. Its `AudioWorkletNode` proxy rejects construction when `slot >= MAX_SLOTS`, before it calls the underlying browser constructor. The workload had completed 52 operations (nine record/restore operations and 43 overdub operations) and was attempting the next overdub. The exact count is `35 initial + (9 records × one looper and one replacement Signalsmith node) + 43 overdub nodes = 96`. Thus the expected overdub AudioWorkletNode was not created: the run hit the harness instrumentation ceiling, rather than merely failing to observe a successfully created node. This diagnosis is based on both source order and the node/operation counts in the raw progress file.

The harness instrumentation is cumulative: the 14 Signalsmith entries are not 14 simultaneous live processors. The progress data shows callbacks stopped on retired pitch nodes while replacement nodes continued. At interruption, active leases were not directly exposed by the harness, so exact lease count is not measured.

The run did not meet the audio-clock progression requirement: AudioContext advanced 1,469.068 seconds / 1,607.254 measured wall seconds (91.40%). The raw file records one exception count on `rc505-rhythm-processor#35`, 174 estimated missing callback quanta, no `processorerror` event, and no non-finite output. The current instrumentation stores only the exception count, not the thrown error message or stack. These callback estimates are not hardware XRUN measurements.

All 52 completed operations passed their functional checks: nine stereo record operations restored LIVE_POLY, and 43 overdub undo/redo operations restored exact PCM SHA-256 values. The failing 53rd operation did not complete. Output sampling remained non-silent for all 32,144 polls and found zero non-finite output samples.

## Reproducibility files

- `full_runtime_35node_livepolyfix_4c0c9c0_20261019T0041Z.status.json` (SHA-256 `13440e93612f60b84e03db530db76b917084c2662f564aba7ca9af0d372e97e3`)
- `full_runtime_35node_livepolyfix_4c0c9c0_20261019T0041Z.progress.json` (SHA-256 `1fb02076dd3fa263dd3daf8b0bc594a5472b60c7c547d07a08c2af134e1ec986`)

There is no final result JSON because the runner terminated on the operation timeout. Preserve the full raw progress and status files with this report. Do not call this run a 30-minute PASS or a completed 30-minute soak.
