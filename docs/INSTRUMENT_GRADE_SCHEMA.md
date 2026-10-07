# Instrument-grade audio JSON schema v1

The canonical TypeScript contract, validator, and gate live in [`src/audio/instrumentGradeMetrics.ts`](../src/audio/instrumentGradeMetrics.ts). The validator checks exact object keys and never coerces, completes, or upgrades imported evidence.

## Report sections

- `run`: actual start/end timestamps and duration, gate version, system under test (`webrc505-project-worklet`, `native-project`, `web-audio-bypass-baseline`, or `offline-fx-benchmark`), and assertion-version identifiers.
- `hardware`: selected input/output endpoint identities; nullable hardware interface clock, processing graph clock, and render quantum. `null` means unknown or not applicable, never zero.
- `pathEvidence`: whether the analog loopback was actually confirmed, its routing description, and evidence references for each leg of the chain. A configured route alone does not confirm that a probe arrived.
- `metrics`: RTL, input, output, jitter, aggregate and per-action trigger, overdub alignment, render quantum, FX latency, callback, XRUN, and loop drift values.
- `software`: an optional runtime snapshot and an optional independent 96 kHz / 128-frame profile.

## Measurement fields

Each scalar/distribution/drift value carries `provenance`, `sampleCount`, `measuredAt`, `device`, `sampleRateHz`, `evidenceRef`, and `anchorRef`. Provenance is one of `physical-loopback`, `software-diagnostic`, `driver-reported`, `estimated`, or `unknown`. For unknown measurements, numeric values and metadata are `null`, sample count is zero, and the dashboard shows `UNKNOWN`.

`metrics.jitter` is a scalar in milliseconds. `metrics.triggerByAction` must contain all four keys: `REC`, `PLAY`, `STOP`, and `FX`; each carries its own distribution. `metrics.fxLatency` uses unique `effectId` values and stores `firstArrival`, `peak`, and `tail` as separately evidenced scalars.

`metrics.xrun` adds `coverageSeconds`, `coverageScope`, `callbackDeadlineMs`, `physicalSampleMarkerContinuous`, and `hardwareDropoutEvidenceRef`. `metrics.loopDrift` adds `maxAbs`, `slopeMsPerMinute`, and `nonAccumulating`.

The optional `software.runtimeSnapshot` is a diagnostic snapshot of the current worklet API. It contains `sampleRate`, `quantumFrames`, `renderedFrame`, `underruns`, `commandQueueDepth`, `loopFrames`, `recordingFrames`, `trackStates`, `trackPositions`, `outputMonitorEnabled`, `backendMode`, `lastAckSequence`, `commandOverruns`, `processDeadlineMisses`, `deadlineMetricAvailable`, `inputDropoutBlocks`, `trackCapacityOverruns`, `maxTrackFrames`, and `trackCapacityFrames`. Five-track arrays are required. A null `processDeadlineMisses` means that browser runtime has no callback-deadline metric; these counters do not establish physical hardware XRUN coverage.

`software.callback96kProfile` is a separate measured run fixed at 96,000 Hz and 128 frames, with its duration, callback distribution, XRUN evidence, and exact input/output device IDs. The validator rejects a different sample rate or quantum and rejects device IDs that differ from the report's selected devices.

## Evidence references

Runners emit a JSON report plus a sibling `.trace.json` file. Store a portable trace filename or relative evidence URI in `evidenceRef`; an import should not depend on a machine-specific absolute path. Preserve full raw correlation samples and timing anchors in the trace. The dashboard shows provenance, sample count, timestamp, device, sample rate, and evidence reference so that a number is reviewable in context.
