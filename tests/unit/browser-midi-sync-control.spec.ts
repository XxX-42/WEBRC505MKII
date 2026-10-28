import { describe, expect, it, vi } from 'vitest';
import {
  armBrowserMidiPendingStart,
  dispatchBrowserMidiTransportControl,
  updateBrowserMidiPendingStart,
  type BrowserMidiPendingStart,
} from '../../src/audio/BrowserMidiSyncControl';

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

  it('holds an early FA, starts exactly once on stable F8 evidence, and does not claim frame alignment', () => {
    let pending: BrowserMidiPendingStart | null = armBrowserMidiPendingStart('source-a', 100);
    const observe = (timestampMs: number, hasStableClockEvidence: boolean) => updateBrowserMidiPendingStart(pending, {
      status: 'clock', sourceKey: 'source-a', selectedSourceKey: 'source-a', timestampMs,
      enabled: true, connected: true, hasRecordingTrack: false, hasCommittedLoops: false, hasStableClockEvidence,
    });

    const acquiring = observe(125, false);
    expect(acquiring.action).toBe('pending');
    if (acquiring.action === 'pending') pending = acquiring.pending;

    const locked = observe(275, true);
    expect(locked.action).toBe('started');
    if (locked.action === 'started') pending = locked.pending;

    expect(updateBrowserMidiPendingStart(pending, {
      status: 'clock', sourceKey: 'source-a', selectedSourceKey: 'source-a', timestampMs: 300,
      enabled: true, connected: true, hasRecordingTrack: false, hasCommittedLoops: false, hasStableClockEvidence: true,
    }).action).toBe('none');
  });

  it.each([
    ['FC Stop', { status: 'stop' as const }],
    ['stale clock', { status: 'stale' as const }],
    ['source change', { selectedSourceKey: 'source-b' }],
    ['sync disabled', { enabled: false }],
    ['permission revoked', { connected: false }],
    ['recording begins', { hasRecordingTrack: true }],
    ['committed loop', { hasCommittedLoops: true }],
  ])('cancels pending FA on %s', (_reason, override) => {
    const pending = armBrowserMidiPendingStart('source-a', 100);
    const result = updateBrowserMidiPendingStart(pending, {
      status: 'state', sourceKey: null, selectedSourceKey: 'source-a', timestampMs: 200,
      enabled: true, connected: true, hasRecordingTrack: false, hasCommittedLoops: false, hasStableClockEvidence: false,
      ...override,
    });
    expect(result.action).toBe('cancelled');
  });

  it('expires a pending FA at its bounded one-second deadline', () => {
    const pending = armBrowserMidiPendingStart('source-a', 100);
    const result = updateBrowserMidiPendingStart(pending, {
      status: 'clock', sourceKey: 'source-a', selectedSourceKey: 'source-a', timestampMs: 1_100,
      enabled: true, connected: true, hasRecordingTrack: false, hasCommittedLoops: false, hasStableClockEvidence: false,
    });
    expect(result).toMatchObject({ action: 'cancelled', reason: 'expired' });
  });
});
