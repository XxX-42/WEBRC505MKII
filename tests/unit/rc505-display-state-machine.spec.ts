import { describe, expect, it } from 'vitest';
import { createRc505DisplayState, getRc505RootItems, reduceRc505DisplayState } from '../../src/ui/rc505/Rc505DisplayStateMachine';
import type { Rc505DisplayAction, Rc505DisplayState } from '../../src/ui/rc505/rc505DisplayTypes';

function send(state: Rc505DisplayState, ...actions: Rc505DisplayAction[]): Rc505DisplayState {
  return actions.reduce(reduceRc505DisplayState, state);
}

describe('RC-505 Classic LCD state machine', () => {
  it('opens the OUTPUT category for its partial software routing editor', () => {
    const state = send(createRc505DisplayState(), { type: 'OPEN_ROOT', root: 'menu' }, { type: 'ENCODER_PRESS', encoderIndex: 1 });
    expect(state.view).toEqual({ kind: 'editor', target: 'menu', category: 'output', pageIndex: 0, pageCount: 1 });
    expect(getRc505RootItems('menu').find(item => item.id === 'input')?.reason).toBeTruthy();
  });
  it('keeps identical renderer page-count reports idempotent instead of retriggering reactive editors', () => {
    const state = send(createRc505DisplayState(), { type: 'OPEN_EDITOR', target: 'memory', category: 'name' },
      { type: 'EDITOR_PAGE_COUNT', count: 3 });
    expect(send(state, { type: 'EDITOR_PAGE_COUNT', count: 3 })).toBe(state);
  });
  it('wraps the seven PLAY variants and the three MIXER pages independently', () => {
    let state = createRc505DisplayState();
    state = send(state, { type: 'PAGE', direction: -1 });
    expect(state.view).toEqual({ kind: 'play', pageIndex: 6 });

    state = send(state, { type: 'ENTER' }, { type: 'PAGE', direction: 1 });
    expect(state.view).toEqual({ kind: 'mixer', pageIndex: 1 });
    state = send(state, { type: 'PAGE', direction: 1 }, { type: 'PAGE', direction: 1 });
    expect(state.view).toEqual({ kind: 'mixer', pageIndex: 0 });
  });

  it('enters MIXER from PLAY, leaves MIXER ENTER in place, and exits to the saved PLAY index', () => {
    let state = send(createRc505DisplayState(), { type: 'PAGE', direction: 1 }, { type: 'PAGE', direction: 1 }, { type: 'ENTER' });
    expect(state.view).toEqual({ kind: 'mixer', pageIndex: 0 });
    expect(send(state, { type: 'ENTER' }).view).toEqual({ kind: 'mixer', pageIndex: 0 });
    state = send(state, { type: 'EXIT' });
    expect(state.view).toEqual({ kind: 'play', pageIndex: 2 });
  });

  it('keeps LOOP root pages wrapped and routes a pressed encoder to the matching supported editor', () => {
    let state = send(createRc505DisplayState(), { type: 'PAGE', direction: 1 }, { type: 'OPEN_ROOT', root: 'loop' });
    expect(state.view).toEqual({ kind: 'loop-root', pageIndex: 0, selectedIndex: 0 });
    state = send(state, { type: 'PAGE', direction: -1 });
    expect(state.view).toEqual({ kind: 'loop-root', pageIndex: 1, selectedIndex: 4 });
    state = send(state, { type: 'ENCODER_PRESS', encoderIndex: 0 });
    expect(state.view).toEqual({ kind: 'editor', target: 'track-fx', category: 'track-fx', pageIndex: 0, pageCount: 1 });
    state = send(state, { type: 'EXIT' }, { type: 'EXIT' });
    expect(state.view).toEqual({ kind: 'play', pageIndex: 1 });
  });

  it('shows unsupported menu categories with reasons and wraps the menu category pages', () => {
    let state = send(createRc505DisplayState(), { type: 'OPEN_ROOT', root: 'menu' });
    const menuItems = getRc505RootItems('menu');
    expect(menuItems.map((item) => item.label)).toEqual(['INPUT', 'OUTPUT', 'MIXER', 'CTL FUNC', 'ASSIGN', 'USB', 'MIDI', 'SETUP', 'FACTORY RESET']);
    expect(menuItems.find((item) => item.id === 'factory-reset')?.reason).toContain('not implemented');

    state = send(state, { type: 'PAGE', direction: -1 });
    expect(state.view).toEqual({ kind: 'menu-root', pageIndex: 2, selectedIndex: 8 });
    state = send(state, { type: 'ENCODER_PRESS', encoderIndex: 0 });
    expect(state.view).toEqual({ kind: 'menu-root', pageIndex: 2, selectedIndex: 8 });
    expect(state.notice).toContain('Factory reset is not implemented');
  });

  it('routes the supported MENU MIXER item without opening a track', () => {
    let state = send(createRc505DisplayState(), { type: 'OPEN_ROOT', root: 'menu' }, { type: 'ENCODER_PRESS', encoderIndex: 2 });
    expect(state.view).toEqual({ kind: 'mixer', pageIndex: 0 });
    state = send(state, { type: 'ENTER' }, { type: 'EXIT' });
    expect(state.view).toEqual({ kind: 'menu-root', pageIndex: 0, selectedIndex: 2 });
  });

  it('replaces repeated roots and editor targets without growing the return stack', () => {
    let state = send(createRc505DisplayState(),
      { type: 'OPEN_EDITOR', target: 'track', category: 'track' },
      { type: 'OPEN_EDITOR', target: 'track-fx', category: 'track-fx' },
      { type: 'OPEN_ROOT', root: 'menu' },
      { type: 'OPEN_ROOT', root: 'loop' },
      { type: 'OPEN_ROOT', root: 'loop' });
    expect(state.view).toEqual({ kind: 'loop-root', pageIndex: 0, selectedIndex: 0 });
    expect(state.returnStack).toEqual([
      { kind: 'play', pageIndex: 0 },
      { kind: 'editor', target: 'track-fx', category: 'track-fx', pageIndex: 0, pageCount: 1 },
    ]);

    state = send(state, { type: 'OPEN_EDITOR', target: 'rhythm', category: 'rhythm' });
    state = send(state, { type: 'OPEN_EDITOR', target: 'input-fx', category: 'input-fx' });
    expect(state.view).toEqual({ kind: 'editor', target: 'input-fx', category: 'input-fx', pageIndex: 0, pageCount: 1 });
    expect(state.returnStack).toHaveLength(3);
  });

  it('requires an explicit CONFIRM action and records acceptance or cancellation', () => {
    const pending = send(createRc505DisplayState(), { type: 'REQUEST_CONFIRMATION', prompt: 'Apply changes?' });
    expect(pending.view).toEqual({ kind: 'confirm', prompt: 'Apply changes?' });
    const accepted = send(pending, { type: 'CONFIRM', accepted: true });
    expect(accepted.view).toEqual({ kind: 'play', pageIndex: 0 });
    expect(accepted.lastConfirmation).toBe('accepted');
    const cancelled = send(pending, { type: 'EXIT' });
    expect(cancelled.lastConfirmation).toBe('cancelled');
  });
});
