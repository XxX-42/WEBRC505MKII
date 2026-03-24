# Phase 4 Status Update: Track Filter UI Has Moved Beyond Fader Hijacking

## Summary

This document replaces the earlier Phase 4 note that described filter control through temporary fader hijacking.

That description is no longer current.

The project has already moved to a dedicated-control layout:

- The track fader is now reserved for level control
- Filter control is handled by dedicated `FREQ` and `RES` knobs
- The track `FX` button toggles the filter state without reassigning the fader

## Current implementation

Relevant file:

- `src/components/TrackUnit.vue`

Current track UI behavior:

1. `LEVEL` fader always controls track volume.
2. `FREQ` knob controls filter frequency.
3. `RES` knob controls filter resonance.
4. `FX` button enables or disables the track filter.
5. `TRACK` button controls reverse playback.

## Why the old Phase 4 document became outdated

The earlier Phase 4 implementation used fader hijacking as a transitional UI strategy:

- FX active: fader controlled filter
- FX inactive: fader controlled volume

That approach was acceptable as an experiment, but it introduced two design problems:

- Volume and filter could not be adjusted independently
- Mode switching created unnecessary UI complexity

The current dedicated-knob layout resolves both issues and is closer to the intended hardware-style interaction model.

## Current technical mapping

### Filter state

- `toggleFilterMode()` toggles `trackAudio.fxChain.setFilterEnabled(...)`
- The enabled state is also mirrored to `trackAudio.track.filterEnabled`

### Frequency control

- `updateFilterFreq()` maps knob range `0-100` to filter value `0.0-1.0`
- The mapped value is passed to `trackAudio.fxChain.setFilterParam('frequency', ...)`

### Resonance control

- `updateFilterRes()` maps knob range `0-10` to a normalized resonance value
- The mapped value is passed to `trackAudio.fxChain.setFilterParam('resonance', ...)`

### Volume control

- `updateLevel()` now only updates `trackAudio.track.playLevel`
- The fader no longer participates in filter-mode switching

## Status assessment

Phase 4 should now be read as:

- Filter audio logic is integrated
- Filter UI is no longer in transitional mode
- The old "Phase 5 will replace fader hijacking with knobs" statement has already been superseded by the current codebase

## Recommended follow-up

The remaining work is no longer "replace hijacking with knobs". That part is already done.

The more relevant next steps are:

1. Keep phase documents synchronized with actual implementation changes.
2. Add runtime verification for fast FX toggling and parameter changes.
3. Continue refining transport, loop sync, and device-management stability.
