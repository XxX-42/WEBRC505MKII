# Native Audio Core MVP

## Goal

Keep the current Web UI as the MVP shell and move only the realtime audio path into a native C++ engine.

## Build Native Host

```powershell
cmake -S native-mvp/engine-cpp -B native-mvp/build-v145 -G "Visual Studio 17 2022" -T v145 -A x64
cmake --build native-mvp/build-v145 --config Release --target native_bridge_host
native-mvp\build-v145\Release\looper_core_tests.exe
```

If `cmake` is not on `PATH`, use:

```powershell
D:\Applications\VisualStudio\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe -S native-mvp/engine-cpp -B native-mvp/build-v145 -G "Visual Studio 17 2022" -T v145 -A x64
```

## Run Native Host

```powershell
native-mvp\build-v145\Release\native_bridge_host.exe
```

The host binds to `http://127.0.0.1:17755`.

## Frontend

```powershell
npm install
npm run build
npm run dev
```

The Web UI will enter `NATIVE AUDIO UNAVAILABLE` if the host is not running. It will not fall back to the old Web Audio path.

## Realtime limits and measurements

The native MVP defaults to 48 kHz and 128 frames. A 96 kHz configuration is rejected by the native engine until trusted callback measurements establish P99 below that configuration's buffer deadline and zero callback XRUNs. A client-supplied flag does not open this gate.

Transport `Clear` and `Record` reset the valid sample lengths and playhead; they do not clear the full 300-second backing allocation. `prepare()` allocates and initializes storage only during stopped configuration.

The WASAPI split streams may report separate input and output buffering through `RtAudio::getStreamLatency()`. Those values are driver reports, not physical loopback latency. ASIO's single duplex report remains an aggregate. Physical round-trip latency stays unknown (`null`) until measured with a hardware loopback. Callback count skew is only a difference in callback counts; it does not measure sample-clock drift. Queue underruns, overruns, callback status faults, oversize callbacks, and dropped control commands are exposed separately.

Native v1 remains an MVP: it exposes track 1 only and does not support FX or reverse. Hardware loopback acceptance is still pending, so software tests and CPU microbenchmarks do not establish `INSTRUMENT_GRADE_PASS`.

For an offline native build and CTest run, use `scripts/native-verify.ps1`. It uses the cached dependency sources and writes build files plus MSVC `/Fo` object files under the system temporary directory. To get before/after P50/P95/P99/Max distributions for the 300-second Record/Clear and 5,000-sample core scenarios, run `scripts/native-benchmark.ps1`; by default it compares against commit `3738d94` and writes CSVs under `%TEMP%`. The benchmark is CPU-only and does not measure the device callback, hardware XRUNs, or physical RTL, so it cannot qualify 96 kHz.

The CPU-only before/after run against `3738d94` measured the 300-second command path at 48 kHz / 128 frames as follows (101 samples per action):

| Action | Before P50 / P95 / P99 / Max (µs) | After P50 / P95 / P99 / Max (µs) |
| --- | ---: | ---: |
| Record start | 1917.5 / 2328.8 / 2394.5 / 2435.8 | 0.000 / 0.100 / 0.100 / 0.100 |
| Clear | 1911.6 / 2417.9 / 2590.2 / 2606.8 | 0.000 / 0.100 / 0.100 / 0.100 |

The 0.000/0.100 µs post-change values are at or below this run's clock/printing resolution; 0.000 does not mean zero execution time, and these near-floor numbers should not be interpreted as a precise speedup. The result supports the constant-work reset change. The 5,000-sample `LooperCore::process()` measurements remained in the low-microsecond range and were noisy: at 48 kHz / 128 frames, before/after P50 was 1.1/1.9 µs (thru), 1.1/1.3 µs (record), 1.1/1.3 µs (playback), and 1.2/1.4 µs (overdub). This is a CPU microbenchmark, not an audio callback deadline or device measurement. Raw `before.csv`, `after.csv`, and `comparison.csv` were retained under `%TEMP%\webrc-native-bench-97f8947b8f684759baa66f300a46a4e5`.
