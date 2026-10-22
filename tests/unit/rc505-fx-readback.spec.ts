import { describe, expect, it } from 'vitest';
import { resolveNativeFxReadback, type NativeFxReadbackStatus } from '../../src/ui/rc505/Rc505FxReadback';

const confirmed: NativeFxReadbackStatus = {
  acknowledged: true, acknowledgedEffectId: 'delay', appliedBypassed: false,
  pendingApply: false, pendingRestart: false, outcomeUnknown: false,
  processingFaulted: false, controlFaulted: false, error: '',
};

describe('Native FX display readback', () => {
  it('shows only acknowledged effect identity and applied bypass, with optional labels', () => {
    expect(resolveNativeFxReadback(confirmed)).toEqual({ type: 'delay', activeLabel: 'ON', state: 'ACK', disabled: false, reason: '' });
    expect(resolveNativeFxReadback({ ...confirmed, appliedBypassed: true }, () => 'DELAY'))
      .toMatchObject({ type: 'DELAY', activeLabel: 'OFF', state: 'ACK' });
  });
  it('shows an acknowledged empty slot as EMPTY/OFF even when bypass is false', () => {
    expect(resolveNativeFxReadback({ ...confirmed, acknowledgedEffectId: null }))
      .toMatchObject({ type: 'EMPTY', activeLabel: 'OFF', state: 'ACK' });
  });
  it.each([
    [{ pendingRestart: true, error: 'Restart required' }, 'RESTART', 'Restart required'],
    [{ pendingApply: true }, 'PENDING', 'Waiting for Native FX application acknowledgement.'],
    [{ outcomeUnknown: true, pendingApply: true, error: 'Response lost' }, 'UNKNOWN', 'Response lost'],
    [{ processingFaulted: true }, 'ERROR', 'The Native FX processor faulted.'],
    [{ controlFaulted: true }, 'ERROR', 'The Native FX control application failed.'],
    [{ error: 'Rejected' }, 'ERROR', 'Rejected'],
    [{ acknowledged: false }, 'PENDING', 'Waiting for Native FX application acknowledgement.'],
    [{ appliedBypassed: null }, 'UNAVAILABLE', 'Native FX bypass acknowledgement is unavailable.'],
  ] as const)('hides effect and activation when runtime is not confirmed (%s)', (patch, state, reason) => {
    expect(resolveNativeFxReadback({ ...confirmed, ...patch }, () => 'REQUESTED TYPE'))
      .toEqual({ type: '—', activeLabel: '—', state, disabled: true, reason });
  });
  it('does not invent values when no runtime status exists', () => {
    expect(resolveNativeFxReadback(null)).toEqual({
      type: '—', activeLabel: '—', state: 'UNAVAILABLE', disabled: true,
      reason: 'Native FX runtime status is unavailable.',
    });
  });
});
