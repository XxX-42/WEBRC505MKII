# Current Release Verification - 2026-03-26

## Summary

This document is the current release snapshot for the working tree that will be pushed to `origin/main`.

The release includes:

- recent browser/native capability disclosure updates
- track upper-deck control wiring
- transport beat-indicator fixes
- new unit and mock-E2E test foundations

## Known defects

- Native audio remains a v1 bridge MVP: Track 1 only, no track FX, no reverse, no rhythm, no beat feedback.
- Loop halo progress still uses approximate playback-position math and can drift from the true playback head after resume/reverse.
- Browser audio correctness still depends on real-device verification; automated tests only validate state flow and UI behavior.

## Browser manual verification

1. Start the app with `/?audio=browser`.
2. Confirm the capability badge reads `BROWSER: FULL TRACK CONTROLS`.
3. Verify `LEVEL`, `FX`, `FREQ`, `RES`, and `TRACK` on Track 1 are interactive.
4. Record a first loop and confirm BPM inference updates the transport display.
5. Verify beat indication flashes while transport is active.
6. Verify slave-track record start/stop waits for measure boundaries.
7. Toggle THRU and confirm the warning prompt appears.

## Native manual verification

1. Start `native_bridge_host`.
2. Start the app with `/?audio=native`.
3. Confirm the capability badge reads `NATIVE V1: TRACK 1 ONLY`.
4. Confirm Track 2-5 show unavailable reasons.
5. Confirm Track FX, Rhythm, and Beat remain visible but disabled with reasons.
6. Verify Track 1 record/stop/play still functions through the bridge.

## Automated coverage

- `npm run build`
- `npm run test:unit`
- `npm run test:e2e`

Automated tests cover capability snapshots, transport events, TrackUnit state wiring, and mock-browser/native UI flows.

## Not covered automatically

- real microphone permissions
- real monitoring/feedback behavior
- real loopback latency
- actual hardware device routing
