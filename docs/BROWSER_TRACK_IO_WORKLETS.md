# Browser track I/O worklets

Browser overdub DSP and loopback latency capture run in `public/worklets/browser-track-io.js`, separate from the existing recording-capture worklet. Neither path falls back to `ScriptProcessorNode` when AudioWorklet is unavailable.

Overdub copies the selected mono loop into the worklet once, then applies input, loop-relative playback position, reverse wrapping, round-trip latency compensation, and the configured Browser recording offset there. The worklet returns changed sample indices and values through a three-slot pool of fixed 16,384-frame transfer buffers. The UI thread only copies those completed patches into the persistent `AudioBuffer`; it does not perform real-time DSP. If all patch buffers are in flight, the worklet drops those input frames rather than diverging its loop mirror from the track buffer, and reports the bounded overflow when overdub stops.

Loopback capture preallocates a one-second mono buffer in the worklet, passes input through to the existing muted sink, and transfers the captured buffer back once. Both processors use the arrays' actual frame lengths, so their callbacks do not assume 128 frames. No buffers are allocated or grown in render callbacks.

If AudioWorklet setup fails, overdub returns the track to `PLAYING`, leaves its existing playback source connected, and exposes the reason through `TrackAudio.overdubDiagnostic` and the track strip. Loopback rejects with an explicit error and reports the failure in Browser audio status. These are the degraded paths; there is no main-thread audio callback fallback.
