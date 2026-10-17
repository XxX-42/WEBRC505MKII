# Native per-track FX callback simulation, 2026-10-17

This is a portable Linux CPU simulation, not a real audio-device or hardware test. The executable prepares five 300-second stereo loop buffers at 48 kHz (576,000,000 bytes, under the selected 768 MiB loop-storage budget), records synthetic material into each, configures 20 representative per-track FX (A–D across five tracks), warms up 5,000 blocks, then measures 100,000 64-frame callbacks. The callback deadline is 1,333,333 ns.

Build: CMake 4.4.4, GCC 14.2.0, Release (`-O3 -DNDEBUG`), portable-only host, Rubber Band HQ disabled. No competing build, test, or benchmark ran in this task during the timed benchmark; external host scheduling/contention was not isolated. Clock: `std::chrono::steady_clock`, observed minimum positive step 20 ns.

Results: P50 0.446 ms, P95 0.630 ms, P99 0.836 ms, P99.9 2.355 ms, maximum 20.520 ms. 301/100,000 callbacks exceeded deadline. All 12.8 million output samples were finite, peak 1.0, and no per-track slot reported a processing fault. Full process elapsed 79.15 s; measured callback loop 47.03 s.

The strict callback timing gate does not pass: P99 is under deadline, but P99.9 and the over-deadline count fail. `ru_maxrss` increased from 567,072 KiB to 608,032 KiB (+40,960 KiB), but this Linux high-water statistic includes the loop store and runtime; it is not PSS or exact FX allocation attribution. The container reports an AMD EPYC 9V74 model and 9 hardware-concurrency threads; contention and device behavior remain unmeasured.

See the adjacent JSON for raw metrics, exact FX workload, configuration, and limitations. No XRUN, hardware latency, acoustic output, subjective quality, or end-to-end device acceptance is claimed.
