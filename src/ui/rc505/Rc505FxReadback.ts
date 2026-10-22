import type { NativeCatalogFxSlotRuntime } from '../../audio/NativeAudioEngine';

export type NativeFxReadbackStatus = Pick<NativeCatalogFxSlotRuntime,
  'acknowledged' | 'acknowledgedEffectId' | 'appliedBypassed' | 'pendingApply' |
  'pendingRestart' | 'outcomeUnknown' | 'processingFaulted' | 'controlFaulted' | 'error'>;

export interface NativeFxReadback {
  type: string;
  activeLabel: 'ON' | 'OFF' | '—';
  state: 'ACK' | 'UNKNOWN' | 'RESTART' | 'PENDING' | 'ERROR' | 'UNAVAILABLE';
  disabled: boolean;
  reason: string;
}

/** Read only confirmed runtime values; desired UI slot values are never inputs. */
export function resolveNativeFxReadback(
  status: NativeFxReadbackStatus | null,
  labelForEffectId: (id: string) => string = (id) => id,
): NativeFxReadback {
  const unavailable = (state: NativeFxReadback['state'], reason: string): NativeFxReadback => ({
    type: '—', activeLabel: '—', state, disabled: true, reason,
  });
  if (!status) return unavailable('UNAVAILABLE', 'Native FX runtime status is unavailable.');
  if (status.outcomeUnknown) return unavailable('UNKNOWN', status.error || 'The Native FX write outcome is unknown.');
  if (status.pendingRestart) return unavailable('RESTART', status.error || 'Restart Native audio to apply the requested FX.');
  if (status.processingFaulted || status.controlFaulted) {
    return unavailable('ERROR', status.error || (status.processingFaulted
      ? 'The Native FX processor faulted.' : 'The Native FX control application failed.'));
  }
  if (status.pendingApply) return unavailable('PENDING', status.error || 'Waiting for Native FX application acknowledgement.');
  if (status.error) return unavailable('ERROR', status.error);
  if (!status.acknowledged) return unavailable('PENDING', 'Waiting for Native FX application acknowledgement.');
  if (typeof status.appliedBypassed !== 'boolean') {
    return unavailable('UNAVAILABLE', 'Native FX bypass acknowledgement is unavailable.');
  }
  const id = status.acknowledgedEffectId;
  return {
    type: id ? labelForEffectId(id) : 'EMPTY',
    activeLabel: id && !status.appliedBypassed ? 'ON' : 'OFF',
    state: 'ACK', disabled: false, reason: '',
  };
}
