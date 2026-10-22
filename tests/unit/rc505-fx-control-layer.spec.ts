import { describe, expect, it } from 'vitest';
import { createRc505FxControlState, reduceRc505FxControl as step } from '../../src/ui/rc505/Rc505FxControlStateMachine';
describe('RC505 FX secondary layers', () => {
  it('ordinary slots only toggle, never open an editor', () => {
    expect(step(createRc505FxControlState(), { type: 'SLOT', slot: 'B' }).effects).toEqual([{ type: 'TOGGLE', slot: 'B' }]);
  });
  it('single EDIT opens the current object on release', () => {
    const down = step(createRc505FxControlState(), { type: 'EDIT_DOWN' });
    expect(down.effects).toEqual([]);
    expect(step(down.state, { type: 'EDIT_UP' })).toMatchObject({ state: { layer: 'EDIT', editHeld: false }, effects: [{ type: 'OPEN_EDITOR' }] });
  });
  it('EDIT+slot consumes the fallback and does not toggle', () => {
    const down = step(createRc505FxControlState(), { type: 'EDIT_DOWN' }).state;
    const chord = step(down, { type: 'SLOT', slot: 'C' });
    expect(chord.effects).toEqual([{ type: 'OPEN_EDITOR', slot: 'C' }]);
    expect(step(chord.state, { type: 'EDIT_HOLD' }).state.layer).toBe('EDIT');
    expect(step(chord.state, { type: 'EDIT_UP' }).effects).toEqual([]);
  });
  it('hold enters Bank Select, slot selects bank, EDIT exits with no toggle or editor', () => {
    const held = step(step(createRc505FxControlState(), { type: 'EDIT_DOWN' }).state, { type: 'EDIT_HOLD' }).state;
    expect(held.layer).toBe('BANK_SELECT');
    const released = step(held, { type: 'EDIT_UP' });
    expect(released.effects).toEqual([]);
    expect(step(released.state, { type: 'SLOT', slot: 'D' }).effects).toEqual([{ type: 'APPLY_BANK', slot: 'D' }]);
    const exited = step(released.state, { type: 'EDIT_DOWN' });
    expect(step(exited.state, { type: 'EDIT_UP' })).toMatchObject({ state: { layer: 'NORMAL' }, effects: [] });
  });
  it('cancel prevents a delayed hold or release from performing an action', () => {
    const cancelled = step(step(createRc505FxControlState(), { type: 'EDIT_DOWN' }).state, { type: 'CANCEL' }).state;
    expect(step(cancelled, { type: 'EDIT_HOLD' }).state.layer).toBe('NORMAL');
    expect(step(cancelled, { type: 'EDIT_UP' }).effects).toEqual([]);
  });
});
