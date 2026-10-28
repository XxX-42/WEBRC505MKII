import type { BrowserMidiSyncMode } from './AudioEngineInterface';

export type BrowserMidiTransportStatus = 'clock' | 'start' | 'stop';
export type BrowserMidiControlDispatch = 'ignored' | 'continue' | 'dispatched' | 'disabled';

export const BROWSER_MIDI_PENDING_START_TIMEOUT_MS = 1_000;

export interface BrowserMidiPendingStart {
  readonly sourceKey: string;
  readonly expiresAtMs: number;
}

export type BrowserMidiPendingStartCancellation =
  | 'expired'
  | 'stop'
  | 'source-changed'
  | 'disabled'
  | 'disconnected'
  | 'recording'
  | 'loops';

export type BrowserMidiPendingStartResult =
  | { readonly action: 'none'; readonly pending: null }
  | { readonly action: 'pending'; readonly pending: BrowserMidiPendingStart }
  | { readonly action: 'started'; readonly pending: null }
  | { readonly action: 'cancelled'; readonly pending: null; readonly reason: BrowserMidiPendingStartCancellation };

/**
 * A Start that arrives before the selected source has established a stable
 * clock may wait briefly for evidence. It never estimates or schedules an
 * audio-frame position; callers execute playback immediately when it resolves.
 */
export function armBrowserMidiPendingStart(sourceKey: string, timestampMs: number): BrowserMidiPendingStart {
  return Object.freeze({ sourceKey, expiresAtMs: timestampMs + BROWSER_MIDI_PENDING_START_TIMEOUT_MS });
}

export function updateBrowserMidiPendingStart(
  pending: BrowserMidiPendingStart | null,
  observation: {
    readonly status: 'clock' | 'stop' | 'stale' | 'state';
    readonly sourceKey: string | null;
    readonly selectedSourceKey: string | null;
    readonly timestampMs: number;
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly hasRecordingTrack: boolean;
    readonly hasCommittedLoops: boolean;
    readonly hasStableClockEvidence: boolean;
  },
): BrowserMidiPendingStartResult {
  if (!pending) return { action: 'none', pending: null };
  if (!observation.enabled) return { action: 'cancelled', pending: null, reason: 'disabled' };
  if (!observation.connected) return { action: 'cancelled', pending: null, reason: 'disconnected' };
  if (observation.hasRecordingTrack) return { action: 'cancelled', pending: null, reason: 'recording' };
  if (observation.hasCommittedLoops) return { action: 'cancelled', pending: null, reason: 'loops' };
  if (observation.selectedSourceKey !== pending.sourceKey
    || (observation.sourceKey !== null && observation.sourceKey !== pending.sourceKey)) {
    return { action: 'cancelled', pending: null, reason: 'source-changed' };
  }
  if (observation.status === 'stop') return { action: 'cancelled', pending: null, reason: 'stop' };
  if (observation.status === 'stale' || observation.timestampMs >= pending.expiresAtMs) {
    return { action: 'cancelled', pending: null, reason: 'expired' };
  }
  if (observation.status === 'clock' && observation.hasStableClockEvidence) {
    return { action: 'started', pending: null };
  }
  return { action: 'pending', pending };
}

export interface BrowserMidiTransportActions {
  disableSync(): void;
  startAll(): void;
  stopAll(): void;
  startRhythm(): void;
  stopRhythm(): void;
  canStopAll(): boolean;
}

/**
 * Dispatches selected-source MIDI transport control. A committed Browser loop
 * disables control before FA/FC can touch playback; it deliberately leaves
 * current track and rhythm playback alone.
 */
export function dispatchBrowserMidiTransportControl(
  mode: BrowserMidiSyncMode,
  status: BrowserMidiTransportStatus,
  hasCommittedLoops: boolean,
  hasFreshClockEvidence: boolean,
  actions: BrowserMidiTransportActions,
): BrowserMidiControlDispatch {
  if (mode === 'off') return 'ignored';
  if (hasCommittedLoops) {
    actions.disableSync();
    return 'disabled';
  }
  if (status === 'clock') return 'continue';
  if (!hasFreshClockEvidence) return 'ignored';

  if (status === 'start') {
    if (mode === 'all') actions.startAll();
    actions.startRhythm();
    return 'dispatched';
  }

  if (mode === 'all') {
    if (!actions.canStopAll()) return 'dispatched';
    actions.stopAll();
  }
  actions.stopRhythm();
  return 'dispatched';
}
