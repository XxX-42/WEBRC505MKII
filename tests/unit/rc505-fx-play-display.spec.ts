import { describe, expect, it } from 'vitest';
import { browserFxPlaySlot, nativeFxPlaySlot } from '../../src/ui/rc505/Rc505FxPlayDisplay';
import { resolveNativeFxReadback } from '../../src/ui/rc505/Rc505FxReadback';

describe('FX Play runtime display', () => {
  it('uses confirmed Browser state and documents which labels are engineering choices', () => {
    expect(browserFxPlaySlot('B', { type: 'DELAY', active: true, state: 'ready', error: null }))
      .toMatchObject({ confirmed: true, active: 'ON', displayType: 'DLY', labelSource: 'official-example' });
    expect(browserFxPlaySlot('A', { type: 'FILTER', active: false, state: 'ready', error: null }))
      .toMatchObject({ confirmed: true, active: 'OFF', displayType: 'FLT', labelSource: 'engineering' });
    expect(browserFxPlaySlot('D', { type: null, active: true, state: 'empty', error: null }))
      .toMatchObject({ confirmed: true, active: 'OFF', displayType: 'EMPTY' });
  });
  it.each([
    [undefined, 'UNAVAILABLE'],
    [{ type: 'DELAY', active: false, state: 'loading', error: null }, 'LOADING'],
    [{ type: 'DELAY', active: true, state: 'ready', error: 'Processor failed' }, 'ERROR'],
    [{ type: null, active: true, state: 'ready', error: null }, 'UNKNOWN'],
  ] as const)('never turns an unresolved Browser result into OFF (%s)', (runtime, state) => {
    expect(browserFxPlaySlot('A', runtime)).toMatchObject({ confirmed: false, active: 'UNKNOWN', displayType: '--', state });
  });
  it('keeps pending Native desired values out of the display', () => {
    expect(nativeFxPlaySlot('C', resolveNativeFxReadback({ acknowledged: true, acknowledgedEffectId: 'delay', appliedBypassed: false,
      pendingApply: true, pendingRestart: false, outcomeUnknown: false, processingFaulted: false, controlFaulted: false, error: '' })))
      .toMatchObject({ confirmed: false, active: 'UNKNOWN', displayType: '--', state: 'PENDING' });
  });
});
