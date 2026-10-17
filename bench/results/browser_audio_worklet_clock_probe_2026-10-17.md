# Browser AudioWorklet clock probe, 2026-10-17

A 10-second software-driven AudioContext run executed production FX, rhythm, and Signalsmith LIVE_POLY AudioWorklet nodes in Google Chrome for Testing headless shell 154.0.8037.57. It used a test-only AnalyserNode read pump; it did not use a physical output device or microphone. AudioContext advanced 10.0 seconds at 48 kHz, the synthetic signal sentinel passed, output had no non-finite samples, and the worklet reported 37,499 callbacks with zero estimated missing callbacks/frames and zero callback or instrumentation errors.

This browser's AudioWorkletGlobalScope has no `performance.now()`. Over 4,096 Date.now() deltas the probe saw one positive 1,000 µs step and 4,095 zero steps. P99, P99.9, CPU-budget, deadline, and XRUN metrics are therefore suppressed/unmeasured; the run cannot pass those gates. The observed callback totals and AudioContext progression are software-side functional evidence only, not physical-device continuity or hardware timing.

The raw JSON records the full graph, clock histograms, signal checks, exclusions, and runner flags. Chromium sandboxing remained requested and enabled; no sandbox-disabling flag was used.
