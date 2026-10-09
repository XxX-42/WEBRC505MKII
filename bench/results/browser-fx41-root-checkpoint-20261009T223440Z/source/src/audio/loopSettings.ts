import type { LoopSyncMode, QuantizeMode, TempoSyncMode } from '../core/types';

/** Browser sample-clock settings captured with a project Memory. */
export interface LoopEngineSettings {
  bpm: number;
  masterTrackId: number | null;
  loopSyncMode: LoopSyncMode;
  tempoSyncMode: TempoSyncMode;
  quantize: QuantizeMode;
}

export type LoopEngineSettingsPatch = Partial<LoopEngineSettings>;

export function validateLoopEngineSettings(value: LoopEngineSettings): void {
  if (!Number.isFinite(value.bpm) || value.bpm < 40 || value.bpm > 300) {
    throw new RangeError('BPM must be between 40 and 300.');
  }
  if (value.masterTrackId !== null && (!Number.isInteger(value.masterTrackId) || value.masterTrackId < 1 || value.masterTrackId > 5)) {
    throw new RangeError('Master track id must be null or from 1 through 5.');
  }
  if (!['IMMEDIATE', 'MEASURE', 'LOOP LENGTH'].includes(value.loopSyncMode)) {
    throw new TypeError('Loop sync mode is invalid.');
  }
  if (!['PITCH', 'XFADE'].includes(value.tempoSyncMode)) {
    throw new TypeError('Tempo sync mode is invalid.');
  }
  if (!['OFF', 'MEASURE'].includes(value.quantize)) {
    throw new TypeError('Quantize mode is invalid.');
  }
}
