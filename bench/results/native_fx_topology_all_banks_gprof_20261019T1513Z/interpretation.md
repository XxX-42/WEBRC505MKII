# Native all-banks scoped gprof diagnostic

Run ID: `native_fx_topology_all_banks_gprof_20261019T1513Z`

- Source: `fd59f403225b62f85ef29dd9ccbf6b5a979e05e3`
- Started: 2026-10-19 15:13:25 UTC; finished: 15:15:09 UTC
- Build: Release, GCC 14.2.0, CMake 4.2.0, `-O3 -DNDEBUG -pg -fno-omit-frame-pointer -DNATIVE_BENCH_GPROF_CALLBACK_ONLY`, linker `-pg`
- Workload: 100,000 measured callbacks, 5,000 warmup, 48 kHz, 64 frames, five prepared 300-second synthetic stereo loops; 20 private per-track effects + 4 Input effects + 4 shared playback effects + rhythm
- Input: synthetic mono 330 Hz at 0.1 peak through the configured Input DSP; `inputMonitoringEnabled=false`
- Pitch: selected pitch processor off for this profile. The separate full-run report includes pitch off and single selected-track LIVE_POLY observations; Native does not run five parallel pitch processors.
- Backend: portable Linux NativeAudioCore CPU callback simulation. No RtAudio hardware, device/XRUN, or hardware acceptance evidence.
- Profile scope: gprof sampling enabled only for the measured callback loop; the profile includes callback work and harness bookkeeping. This is an instrumented diagnostic, not timing acceptance data.

The run observed 0.655 ms mean, 0.911 ms P95, 1.530 ms P99, 3.579 ms P99.9, and 27.709 ms maximum; 1,301/100,000 callbacks exceeded the 1.333 ms hard callback budget. It remains a timing FAIL. All 12,800,000/12,800,000 measured output samples were finite; all configured routes remained healthy, Input/shared fault count was zero, input monitoring remained disabled, and warmup observed a 0.175 peak after Input DSP and up to two active rhythm voices.

## Top flat-profile self samples

`gprof.txt` reports a 0.01-second sampling period. The highest listed self-time shares were:

- `NativeDistortionProcessor::processInPlace`: 10.42%
- `NativePreampProcessor::processInPlace`: 9.71%
- `antialiasedTriode`: 9.64%
- `NativeFdn16ReverbProcessor::processInPlace`: 5.74%
- `NativeRobotCore::PitchTracker::analyzeFrame`: 5.10%
- `NativeElectricProcessor::analyzePitchFrame`: 4.95%
- `SignalsmithStretch::processSpectrum`: 3.11%
- `NativeVocoderOscillator::processSample`: 2.98%
- `dsp::lagrange4`: 2.81%

These are diagnostic self-time samples in one instrumented run. Percentages across parent and child functions must not be added to infer non-overlapping wall cost, and this data does not establish algorithm quality or which subsystem causes the uninstrumented deadline misses.

## Attribution anomaly

The flat profile also assigns 10.15% / 4.12 seconds / 25.6 million calls to `NativeOscBotProcessor::~NativeOscBotProcessor`, with a call-graph arc from `NativeDistortionProcessor::processInPlace`. That attribution is unresolved: the all-banks setup does not configure OSC BOT, source inspection found no such call in the distortion processing path, and disassembly of `NativeDistortionProcessor::processInPlace` contains no call to the OSC BOT destructor. Preserve this entry as a profiler/call-graph anomaly; do not treat it as a real OSC BOT runtime cost or an optimization target without independent confirmation.

Raw `gmon.native_per_track_fx_bench.out`, normalized `gprof.txt` and exact compressed raw gprof text (`gprof.raw.txt.gz`), result JSON, platform/build/run metadata, and SHA-256 files are preserved in this directory. The uninstrumented full all-banks timing observations remain in the adjacent `...1506Z/` and `...1504Z/` directories and are reported separately in `native_fx_topology_matrix_20261019.md`.
