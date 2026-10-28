import type { BrowserMidiSyncMode } from './AudioEngineInterface';

export type BrowserMidiTransportStatus = 'clock' | 'start' | 'stop';
export type BrowserMidiControlDispatch = 'ignored' | 'continue' | 'dispatched' | 'disabled';

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
