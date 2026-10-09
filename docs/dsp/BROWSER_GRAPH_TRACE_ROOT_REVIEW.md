# Browser graph trace scope correction

This review measures one existing software-only trace window. It does not qualify
the current product, the 30-minute stress gate, hardware latency, or driver XRUNs.
The original stress run and its continuity failures remain unchanged.

The Chromium 149.0.7827.55 capture at
`bench/results/browser_graph_32fx_pilot_20261010T014700Z_30min` used the older
32-processor module `f670c0dacdc0e7175f8ce821b1040bf1f39eabdce15673d16f5a00212d0b79c6`.
The earlier summary reported only Worklet callback timing and left graph timing
unmeasured. Its raw trace actually contains complete graph-render slices.

The exact Chromium release tag resolves to commit
`3188f8a607ae7e067593be8aab7f02d2451fec07`. The downloaded, hashed source files
and tag metadata are in
`bench/results/browser-graph-trace-reanalysis-20261009T220400Z`.
In `realtime_audio_destination_handler.cc`, the render trace starts at line 206
and encloses pre-render tasks, upstream graph pulling, automatic pull nodes,
post-render tasks, output volume handling and sample-frame advancement.
This is a graph scope; it is wider than a single Worklet's process callback.

Source: [Chromium graph-render implementation](https://chromium.googlesource.com/chromium/src/+/refs/tags/149.0.7827.55/third_party/blink/renderer/modules/webaudio/realtime_audio_destination_handler.cc).

The streaming analyzer matches both process ID and thread ID. It uses each
complete graph slice's own duration, without adding nested child durations.
All 28,242 complete Worklet slices in window 01 fit inside the 3,138 complete
graph slices; each graph slice contains nine Worklet callbacks. The trace
reports no event loss. An incomplete boundary slice is retained in phase counts
and excluded from timing rather than assigned a fabricated duration.

At the recorded AudioContext rate of 48 kHz, every measured graph slice reports
128 frames, giving a nominal graph quantum of 2,666.667 microseconds.

| Scope | Count | P50 us | P95 us | P99 us | P99.9 us | Max us |
|---|---:|---:|---:|---:|---:|---:|
| Complete graph render | 3,138 | 2,710 | 4,091 | 4,576 | 5,405 | 5,743 |
| Complete Worklet callback | 28,242 | 26 | 825 | 1,099 | 1,256 | 1,885 |

There are 1,622 graph slices above the nominal quantum, 3,036 above 60% of it,
and 2,322 above 80% of it. This traced window does not pass the requested timing
thresholds. Its 325 MB uncompressed trace and broad instrumentation introduce
substantial observer overhead; these numbers do not establish the untraced
product's performance or the cause of an audible glitch.

`AudioDestination::RequestRender` is measured separately. The source loops over
render quanta and also handles resampling and FIFO writes. Its `frames_to_render`
counts device-rate FIFO frames; those cannot be assigned the AudioContext rate
when the device rate is unknown. The accepted v2 result therefore leaves request
deadlines and overrun counts null. Any optional device-rate-based calculation in
the analyzer is only a nominal rendered-work budget, not proof of a device
callback deadline; FIFO slack and `frames_requested` require separate analysis.

Source: [Chromium render-request and FIFO implementation](https://chromium.googlesource.com/chromium/src/+/refs/tags/149.0.7827.55/third_party/blink/renderer/platform/audio/audio_destination.cc).

The original exploratory `browser-graph-trace-window01-root.json` is preserved.
Its request deadlines incorrectly assumed that context and device sample rates
were equal; those request fields are superseded and must not be used for
acceptance. `browser-graph-trace-window01-root-v2.json` is the reviewed result.
The graph measurements agree between both revisions. The analyzer's three
regressions check parent-versus-child scope, process isolation, unknown device
rate, actual quantum sizes, streaming chunk boundaries and missing frame data.

Reproduce the reviewed result with a new output path:

```powershell
python scripts/analyze-browser-audio-trace.py `
  bench/results/browser_graph_32fx_pilot_20261010T014700Z_30min/traces/window-01.trace.json.gz `
  --sample-rate 48000 --output <new-result.json>
python scripts/tests/test_browser_audio_trace.py
```

Future stress runs must retain raw graph-render traces with actual frame counts,
distinguish graph execution from device request scheduling, limit observer load,
and validate continuity independently. A sampled-window distribution is not a
continuous 30-minute distribution, and the original 57 gaps and 61 duplicate
callbacks still prevent Gate 7 qualification.
