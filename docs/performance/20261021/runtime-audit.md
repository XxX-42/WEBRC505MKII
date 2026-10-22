# Runtime path audit (source review, not a timing result)

## Native

The tested entry is NativeAudioCore::audioCallback → handleAudioCallback → processNativeTracksForCallback. Its visible top-level code drains fixed command queues, calls DSP/track processing, and publishes atomic status. It does not directly take controlMutex_, commandProducerMutex_ or loopSnapshotMutex_. These mutexes occur in control/snapshot APIs elsewhere in native_audio_core.cpp; a textual occurrence is not evidence of a callback lock. This is not a proof that every transitive library call is allocation/lock-free.

Existing callback status accounting increments xrunsOrDropouts_ for a nonzero RtAudio status. Separate-device input/output routes also count software queue overflow/underflow. The direct device-free matrix passes status=0 and does not exercise a driver, so hardware XRUN remains null, not a measured zero. Real callback timing is measured around the production entry by the benchmark; synthetic RtAudio's fixed sleep is not eligible for realtime acceptance.

Transport commands can reset pitch processors and execute state transitions. Steady-state timing alone does not establish transition budgets; the separate lifecycle soak is necessary and its measured load/environment must be retained.

## Browser

The recording processor allocates its typed-array pool during construction and posts pooled PCM messages. The overdub processor has reusable patch messages/transfer lists and startup arrays; exceptional startup/error paths can create diagnostic messages. The offline stress counts source postMessage calls and typed-array payload sizes through a mock port. That is not actual structured-clone/IPC transport measurement or a proof of zero Worklet allocations.

useTrackStripState.ts still polls syncTrackUi every 50 ms for each mounted track. In particular it reconstructs renderer-engine arrays and a Set, plus reads capabilities and diagnostics. The interval is cleared in onUnmounted. This is a potential P2 allocation/reactivity candidate, not a profiled bottleneck: the current environment cannot execute the real browser/UI trace. No speculative UI rewrite or claimed CPU gain is included in this batch.

The legacy AudioEngine tracks[0] facade methods were separately checked for callers (facade-audit.md). Production track UI uses track-aware paths; unused legacy methods remain documented debt rather than an unbounded rewrite.

## Remaining measurements

Actual browser Worklet scheduling, GC pauses, main-thread long tasks, meter/UI contention, five TrackAudio lifecycle leaks, port-transfer bytes and live browser memory require supported browser execution. These are software environment gaps, not HARDWARE_BLOCKED. Physical driver status, loopback latency and real device continuity are separate hardware acceptance items.
