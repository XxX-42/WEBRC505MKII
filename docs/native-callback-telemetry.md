# Native callback telemetry

`/v1/status.callbackTelemetry` separates actual callback observations from the retained legacy `xrunsOrDropouts` aggregate. Counters are lifetime diagnostics and survive `resetRuntimeStateLocked`; that control action increments `software.runtimeResetCount`, never a driver reset counter. Before callback observation, callback-derived counts and timing values are null. Producer rejection or control reset counts can be available before a callback when that event actually occurred.

Real driver fields require a successfully opened stream in the real RtAudio build and an observed callback. Setting `engineRunning` in a fixture does not establish provenance. Portable and HTTP simulation libraries compile with `NATIVE_CALLBACK_NO_HARDWARE`; their callback status flags can be tested, but `driver.inputOverflow`, `driver.outputUnderflow`, driver reset and global driver statistics remain null. Physical WASAPI/ASIO validation has not been performed here.

| Category | Actual observation |
|---|---|
| `statusFlags.inputOverflow` / `outputUnderflow` | RtAudio callback status bits 0x1 / 0x2, including explicitly simulated flags |
| `driver.inputOverflow` / `outputUnderflow` | Those flags restricted to callbacks from a real opened stream |
| `software.audioQueueOverflow` | Split-input callback cannot push its rendered AudioBlock |
| `software.audioQueueUnderflow` | Primed split-output callback cannot pop a rendered AudioBlock |
| `software.controlQueueReject` | Producer API rejects a bounded command/MIDI queue capacity operation; not an audio XRUN |
| `software.oversizeCallback` | Callback frames exceed the fixed 4096-frame processing capacity |
| `software.nonFiniteInput` / `nonFiniteOutput` | At least one non-finite sample in the bounded actual input/output callback buffer; event count, not sample count |
| `software.deadlineMiss` | Steady-clock duration exceeds that callback's own frames/sample-rate budget |

All three callback entrypoints have a stack-only scope, including null-output, unprimed and oversize early exits. Timing uses 512 preallocated atomic bins of 50 microseconds. The final bin is unbounded. The control thread derives P99/P99.9 upper bounds; a rank in the overflow bin returns null instead of an invented finite tail. Exact maximum and latest per-kind sample rates/buffer sizes are also reported. Duration includes input/output scans and processing, excluding atomic histogram publication. The lifetime histogram can span configurations and callback kinds. Status reads use independent atomic snapshots rather than a transactional pause.

The tests simulate each classification independently, retain the old aggregate semantics, exercise real gate/meter/committed-overdub MARK callbacks, and track C++ new/new[] plus delete/delete[] on the callback thread. A callback completes while another thread holds all three core mutexes. Malloc, aligned allocators and global mutex interception are not covered. No hardware reset, physical XRUN count, global driver statistic, or driver latency is inferred from these software tests.
