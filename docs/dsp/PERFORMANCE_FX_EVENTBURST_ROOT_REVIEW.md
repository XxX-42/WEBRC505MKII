# BeatRepeat event-burst review

The root reviewer independently verified the six archived input files, their byte
counts and SHA-256 values, all five before/after/archive fingerprints, the raw
result hash, both 20,000-entry timing series, nearest-rank percentiles and deadline
exceedance counts. The original result and archive were not rewritten.

Capture: `shared/dsp/benchmarks/results/native-performance-fx-eventburst-20261009T144617906Z.json`.
Raw SHA-256: `59870ab311b309425515717a9ac5bf52f5db9b511c7d00ab19e5ffa768da4e77`.
Source fingerprint: `b58e079a9d47829a69e0b8014c86e6c85e3b1f2a43ef829905eb392458f11258`.
The fingerprint hashes sorted UTF-8 `path:sha256:bytes\n` records, including the
last newline. The manifest records the actual MSVC compiler, flags and machine.

| Isolated 48 kHz / 64-frame BeatRepeat | Observed |
| --- | ---: |
| Timed calls | 20,000 |
| Ordered control events per call | 64, one per sample |
| P50 | 6.1 microseconds |
| P99 | 15.9 microseconds |
| P99.9 | 60.2 microseconds |
| Maximum | 324.1 microseconds |
| Calls above 60% / 80% / 100% deadline | 0 / 0 / 0 |
| Reported maximum capture-copy frames per call | 64 |
| Processor rejections | 0 |

The measurement surrounds `processBlock()` and includes clock-read overhead.
Input generation, counters and serialization are outside that interval. The
separate empty clock-pair series is retained; its median is zero at this timer's
resolution, and no overhead was subtracted. Process CPU ticks cover the entire
loop, including input generation, and are not per-call CPU measurements.

The renderer is warmed before this series. The 64-event scenario mixes Active,
TempoBpm, SubdivisionBeats, Feedback and Wet. It is one specific isolated scenario,
not proof that every possible event sequence has the same timing. The aggregate
copy high-water is independently checked against the raw report; the report does
not provide a per-callback copy-count series. The source implements bounded
incremental capture rather than copying an entire repeat period in one callback.

This capture represents 26.67 seconds of simulated audio processed faster than
real time. It does not qualify the full Native graph, Browser/WASM, audio device
latency, XRUN behavior, 30-minute stress or output sound quality. No Gate is passed
by this isolated result.

Reproduce the evidence checks:

```powershell
python scripts/verify-performance-fx-capture.py shared/dsp/benchmarks/results/native-performance-fx-eventburst-20261009T144617906Z.json
```

The archived build command records the original absolute TEMP paths. To rebuild
on another machine, use the capture script with the current compiler installation
and record a new result; do not replace this historical raw result.
