import { describe, expect, it } from 'vitest';
import { createRc505DisplayState, reduceRc505DisplayState as step } from '../../src/ui/rc505/Rc505DisplayStateMachine';

describe('official WRITE/CLEAR LCD flow', () => {
  const open = () => step(step(createRc505DisplayState(), { type: 'PAGE', direction: 1 }), { type: 'OPEN_MEMORY_WRITE', slot: 23 });
  it.each([0, 1, 2, 3])('encoder %i chooses the official WRITE/CLEAR half', encoderIndex => {
    const state = step(open(), { type: 'ENCODER_PRESS', encoderIndex });
    expect(state.view).toEqual({ kind: 'memory-write', operation: encoderIndex < 2 ? 'write' : 'clear', slot: 23, busy: false });
  });
  it('selects 01–99 with any encoder, requires ENTER, and consumes duplicate events while executing', () => {
    let state = step(open(), { type: 'ENCODER_PRESS', encoderIndex: 0 });
    state = step(state, { type: 'ENCODER_ROTATE', encoderIndex: 3, delta: 200 });
    expect(state.view).toMatchObject({ slot: 99, busy: false });
    state = step(state, { type: 'ENCODER_ROTATE', encoderIndex: 1, delta: -200 });
    expect(state.view).toMatchObject({ slot: 1 });
    state = step(state, { type: 'ENTER' });
    for (const action of [{ type: 'ENTER' }, { type: 'EXIT' }, { type: 'PAGE', direction: 1 }, { type: 'ENCODER_PRESS', encoderIndex: 3 }] as const) {
      expect(step(state, action)).toBe(state);
    }
    expect(step(state, { type: 'MEMORY_COMPLETE', success: true }).view).toEqual({ kind: 'play', pageIndex: 1 });
  });
  it('cancels without changing the previous Play page and preserves the operation after a failure', () => {
    expect(step(open(), { type: 'EXIT' }).view).toEqual({ kind: 'play', pageIndex: 1 });
    let state = step(step(open(), { type: 'ENCODER_PRESS', encoderIndex: 2 }), { type: 'ENTER' });
    state = step(state, { type: 'MEMORY_COMPLETE', success: false, message: 'STORAGE FULL' });
    expect(state).toMatchObject({ view: { kind: 'memory-write', operation: 'clear', slot: 23, busy: false }, notice: 'STORAGE FULL' });
  });
});
