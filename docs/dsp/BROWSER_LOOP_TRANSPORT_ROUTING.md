# Browser loop transport routing status

BEAT SHIFT and VINYL FLICK currently use an experimental source-aware read-head in each `TrackAudio`. The shared Track A–D AudioWorklet adapter remains wired for catalog continuity but is forced to dry bypass, so these effects are not processed twice.

The source-aware reader runs before `TrackMix`. It is therefore enabled only when no earlier active Track A–D effect would need to run before it. A transport effect can occupy A, or the first active slot after empty or bypassed earlier slots. If an earlier slot is active, the transport effect stays dry and `BrowserAudioEngine.getTrackTransportStatus()` reports it under `unsupportedEffects` with the ordering reason.

This is not full Track-bank parity. The Browser still has a shared postmix A–D chain for ordinary effects, rather than a separate ordered 5-track × 4-slot FX chain. Exact interleaving of source-aware transport and ordinary effects for every track remains unsupported until that per-track chain is implemented. Treat the route as experimental and partial.

Per-track reverse, LIVE_MONO, and LIVE_POLY conflicts are exposed by the same status API through each track's `unavailableReason`. The source-aware read-head currently requires forward BufferSource playback without either live pitch route.
