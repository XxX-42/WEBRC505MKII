# Device Hot-Swap Regression Checklist

## Scope

This checklist targets the highest-risk live audio paths:

- input device hot swap
- output device hot swap
- software monitoring (`THRU`)
- recording start/stop
- overdub start/stop
- transport `PLAY ALL / STOP ALL`

Run it with real hardware. Build success is not enough for these cases.

## Test Setup

- Browser: Chrome or Edge latest stable
- Audio path: 1 microphone, 1 headphone output, optional second microphone/audio interface
- Safety: use headphones first; do not start with speakers
- App state: hard refresh before each major group
- BPM: leave at default unless a case says otherwise
- Monitoring default: OFF

## Pass Criteria

- no browser crash
- no uncaught console error
- no stuck red/yellow track state
- no silent THRU when monitoring is ON
- no unexpected THRU when monitoring is OFF
- no duplicate monitoring or doubled signal after device swap
- no zombie recording that continues after stop/clear
- `PLAY ALL / STOP ALL` affects actual track playback, not only UI clock

## Core Matrix

### 1. Baseline Input Routing

1. Launch app with one input and one headphone output.
2. Enable `THRU`.
3. Speak into mic.
4. Change Input FX slot A type and parameter.
5. Bypass/unbypass the slot.

Expected:

- THRU is audible only when monitoring is ON
- Input FX changes are audible on THRU
- bypass/unbypass does not drop the input path
- no sudden full-volume jump

### 2. Baseline Recording With Monitoring Off

1. Disable `THRU`.
2. Record Track 1.
3. Stop recording.
4. Play back Track 1.

Expected:

- direct mic is not heard during recording
- recorded loop contains mic input
- playback is audible and loops normally
- track ends in `PLAYING` or `STOPPED` only, never stuck in recording state

### 3. Baseline Recording With Monitoring On

1. Enable `THRU`.
2. Record Track 1.
3. Sweep one Input FX parameter while recording.
4. Stop recording.
5. Play loop back.

Expected:

- THRU remains audible while recording
- recorded signal reflects processed input path
- stopping recording does not leave direct monitor doubled
- no click/pop beyond normal low-level transition noise

### 4. Overdub With Monitoring Off

1. Use an existing playing loop.
2. Disable `THRU`.
3. Enter overdub.
4. Add new material.
5. Exit overdub.

Expected:

- overdub writes into the loop
- loop remains in sync after exiting overdub
- no residual processor behavior after exit
- playback level is stable

### 5. Overdub With Monitoring On

1. Use an existing playing loop.
2. Enable `THRU`.
3. Enter overdub.
4. Change Input FX type mid-overdub.
5. Exit overdub.

Expected:

- live input stays audible
- overdub continues writing after FX type switch
- no total signal drop
- no permanent doubled monitoring after exit

### 6. Input Device Hot Swap While Idle

1. Start with Input Device A selected.
2. Speak and verify THRU.
3. Switch to Input Device B.
4. Speak again.
5. Switch back to default input.

Expected:

- app does not freeze
- THRU follows the newly selected device
- previous device does not remain audible
- settings UI and `THRU` button still reflect the same monitoring state

### 7. Input Device Hot Swap During Recording

1. Start recording on Track 1.
2. While recording, switch input device.
3. Continue speaking.
4. Stop recording.
5. Play back result.

Expected:

- no crash
- if continuity is not supported, the app fails gracefully rather than corrupting state
- recording can still be stopped cleanly
- track is not left in `RECORDING`, `REC_STANDBY`, or `REC_FINISHING`

Record separately:

- whether audio after the swap is captured
- whether the captured loop contains a gap
- whether stop behavior is immediate and stable

### 8. Input Device Hot Swap During Overdub

1. Start playback on a recorded loop.
2. Enter overdub.
3. Switch input device.
4. Continue speaking.
5. Exit overdub.

Expected:

- no crash
- overdub can still exit cleanly
- loop playback survives the swap
- no stuck yellow overdub state

### 9. Output Device Hot Swap While Monitoring On

1. Enable `THRU`.
2. Switch output from headphones device A to output device B.
3. Speak into mic.
4. Toggle monitoring OFF then ON again.

Expected:

- monitoring follows the active output route
- no stale audio on old output
- state remains synchronized between settings and transport bar
- no need to refresh app to recover audio

### 10. Output Device Hot Swap During Playback

1. Start one or more loops.
2. While playback is running, switch output device.
3. Press `STOP ALL`.
4. Press `PLAY ALL`.

Expected:

- playback continues or recovers cleanly on the new output
- `STOP ALL` actually stops audible tracks
- `PLAY ALL` resumes stopped tracks
- transport is not only changing UI state

### 11. Stop/Clear Boundaries During Quantized Recording

1. Create a master loop.
2. On another track, enter quantized record standby.
3. Press track stop before the measure boundary.
4. Repeat and instead long-press clear.

Expected:

- standby is cancelled cleanly
- no hidden recording begins later on the next measure
- clear leaves the track `EMPTY`
- no orphaned measure listener behavior

### 12. Stop/Clear Boundaries During Quantized Stop

1. Record a slave track.
2. Press record again so it enters quantized finish state.
3. Before boundary, press stop.
4. Repeat and press clear.

Expected:

- finish wait is cancelled cleanly
- no delayed stop fires after user already stopped/cleared
- track does not jump back to `PLAYING` unexpectedly

### 13. Global Stop While One Track Records And Another Overdubs

1. Track 1 playing.
2. Track 2 recording or waiting to finish.
3. Track 3 overdubbing.
4. Press `STOP ALL`.

Expected:

- overdub exits
- recording does not remain armed forever
- all audible playback stops
- transport and track states converge to a stable result

### 14. Monitoring State Synchronization

1. Turn `THRU` ON from transport bar.
2. Open settings modal.
3. Verify checkbox state.
4. Turn monitoring OFF in settings.
5. Verify `THRU` button state.

Expected:

- both controls show one source of truth
- no one-frame flip back to stale state
- confirmation flow only appears on enabling, not disabling

### 15. Input FX Stress While Monitoring And Recording

1. Enable `THRU`.
2. Start recording.
3. Rapidly change Input FX type across all slots.
4. Toggle slot active state repeatedly.
5. Stop recording.

Expected:

- no crash or audio graph lockup
- no permanent silence after rapid FX switching
- recording can still stop normally
- post-record playback remains valid

## Suggested Run Order

Run in this order to catch blockers early:

1. Baseline Input Routing
2. Baseline Recording With Monitoring Off
3. Baseline Recording With Monitoring On
4. Overdub With Monitoring Off
5. Overdub With Monitoring On
6. Input Device Hot Swap While Idle
7. Output Device Hot Swap While Monitoring On
8. Stop/Clear Boundaries During Quantized Recording
9. Stop/Clear Boundaries During Quantized Stop
10. Input Device Hot Swap During Recording
11. Input Device Hot Swap During Overdub
12. Output Device Hot Swap During Playback
13. Global Stop While One Track Records And Another Overdubs
14. Monitoring State Synchronization
15. Input FX Stress While Monitoring And Recording

## Failure Logging Template

Use one entry per failure:

```text
Case:
Environment:
Input device:
Output device:
Monitoring:
Track states before action:
Action:
Observed:
Expected:
Recovery action needed:
Reproducible:
Console errors:
```

## Current Risk Notes

Based on current code, the most important things to verify on real hardware are:

- input device hot swap during active recording may still create audible gaps even if state cleanup is stable
- output device switching depends on browser `setSinkId` support
- rapid FX switching during live input should be checked for short dropouts
- quantized recording cancel paths should be tested repeatedly, not once
