import { describe, expect, it, vi } from 'vitest';
import { dispatchBrowserMidiTransportControl } from '../../src/audio/BrowserMidiSyncControl';

describe('Browser MIDI sync runtime fail-closed policy', () => {
  it.each([
    ['start', 'FA Start'],
    ['stop', 'FC Stop'],
  ] as const)('disables sync before %s can alter playback when a phrase appears', (status, label) => {
    let mode: 'off' | 'all' | 'rhythm' = 'all';
    let playback: 'playing' | 'stopped' = 'playing';
    const startAll = vi.fn(() => { playback = 'playing'; });
    const stopAll = vi.fn(() => { playback = 'stopped'; });
    const startRhythm = vi.fn();
    const stopRhythm = vi.fn();
    const disableSync = vi.fn(() => { mode = 'off'; });

    const dispatch = dispatchBrowserMidiTransportControl(mode, status, true, true, {
      disableSync,
      startAll,
      stopAll,
      startRhythm,
      stopRhythm,
      canStopAll: () => true,
    });

    expect(label).toMatch(/FA|FC/);
    expect(dispatch).toBe('disabled');
    expect(mode).toBe('off');
    expect(startAll).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    expect(startRhythm).not.toHaveBeenCalled();
    expect(stopRhythm).not.toHaveBeenCalled();
    expect(playback).toBe('playing');
  });
});
