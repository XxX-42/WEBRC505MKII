import { describe, expect, it } from 'vitest';
import { createRc505DisplayState, getRc505RootItems, getRc505RootPage, getRc505RootPageCount, getRc505RootPageStart, reduceRc505DisplayState } from '../../src/ui/rc505/Rc505DisplayStateMachine';
import { RC505_MIXER_PAGES, type Rc505DisplayAction, type Rc505DisplayState } from '../../src/ui/rc505/rc505DisplayTypes';

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
  it('wraps the seven PLAY variants and the four current MIXER pages independently', () => {
    expect(RC505_MIXER_PAGES.map(page => page.id)).toEqual(['inputs', 'tracks', 'outputs', 'master']);
    expect(RC505_MIXER_PAGES[1]!.channels).toEqual(['TRACK1', 'TRACK2', 'TRACK3', 'TRACK4']);
    let state = createRc505DisplayState();
    state = send(state, { type: 'PAGE', direction: -1 });
    expect(state.view).toEqual({ kind: 'play', pageIndex: 6 });

    state = send(state, { type: 'ENTER' }, { type: 'PAGE', direction: 1 });
    expect(state.view).toEqual({ kind: 'mixer', pageIndex: 1 });
    state = send(state, { type: 'PAGE', direction: 1 }, { type: 'PAGE', direction: 1 }, { type: 'PAGE', direction: 1 });
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
    expect(state.view).toEqual({ kind: 'loop-root', pageIndex: 1, selectedIndex: 3 });
    state = send(state, { type: 'ENCODER_PRESS', encoderIndex: 0 });
    expect(state.view).toEqual({ kind: 'editor', target: 'input-fx', category: 'input-fx', pageIndex: 0, pageCount: 1 });
    state = send(state, { type: 'EXIT' }, { type: 'EXIT' });
    expect(state.view).toEqual({ kind: 'play', pageIndex: 1 });
  });

  it('shows unsupported menu categories with reasons and wraps the menu category pages', () => {
    let state = send(createRc505DisplayState(), { type: 'OPEN_ROOT', root: 'menu' });
    const menuItems = getRc505RootItems('menu');
    expect(menuItems.map((item) => item.label)).toEqual(['INPUT', 'OUTPUT', 'MIXER', 'CTL FUNC', 'ASSIGN', 'USB', 'MIDI', 'SETUP', 'FACTORY RESET']);
    expect(menuItems.find((item) => item.id === 'factory-reset')?.reason).toContain('not implemented');

    state = send(state, { type: 'PAGE', direction: -1 });
    expect(state.view).toEqual({ kind: 'menu-root', pageIndex: 2, selectedIndex: 7 });
    state = send(state, { type: 'ENCODER_PRESS', encoderIndex: 1 });
    expect(state.view).toEqual({ kind: 'menu-root', pageIndex: 2, selectedIndex: 8 });
    expect(state.notice).toContain('Factory reset is not implemented');
  });

  it('routes the supported MENU MIXER item without opening a track', () => {
    let state = send(createRc505DisplayState(), { type: 'OPEN_ROOT', root: 'menu' }, { type: 'ENCODER_PRESS', encoderIndex: 2 });
    expect(state.view).toEqual({ kind: 'mixer', pageIndex: 0 });
    state = send(state, { type: 'ENTER' }, { type: 'EXIT' });
    expect(state.view).toEqual({ kind: 'menu-root', pageIndex: 0, selectedIndex: 2 });
  });

  it('opens the supported Loop Indicator setting from MENU > SETUP', () => {
    const state = send(createRc505DisplayState(), { type: 'OPEN_ROOT', root: 'menu' },
      { type: 'PAGE', direction: -1 }, { type: 'ENCODER_PRESS', encoderIndex: 0 });
    expect(state.view).toEqual({ kind: 'editor', target: 'menu', category: 'setup', pageIndex: 0, pageCount: 1 });
    expect(send(state, { type: 'EXIT' }).view).toEqual({ kind: 'menu-root', pageIndex: 2, selectedIndex: 7 });
  });

  it('uses explicit LOOP 3+4 and MENU 3+4+2 groups, with empty encoders unable to enter another page', () => {
    expect(Array.from({ length: getRc505RootPageCount('loop') }, (_, page) => getRc505RootPage('loop', page).map(item => item.label)))
      .toEqual([['TRACK', 'REC', 'PLAY'], ['INPUT FX', 'TRACK FX', 'RHYTHM', 'NAME']]);
    expect(Array.from({ length: getRc505RootPageCount('menu') }, (_, page) => getRc505RootPage('menu', page).map(item => item.label)))
      .toEqual([['INPUT', 'OUTPUT', 'MIXER'], ['CTL FUNC', 'ASSIGN', 'USB', 'MIDI'], ['SETUP', 'FACTORY RESET']]);
    expect([0, 1, 2].map(page => getRc505RootPageStart('menu', page))).toEqual([0, 3, 7]);
    const first = send(createRc505DisplayState(), { type: 'OPEN_ROOT', root: 'loop' });
    expect(send(first, { type: 'ENCODER_PRESS', encoderIndex: 3 })).toBe(first);
    const fourth = send(first, { type: 'ENCODER_ROTATE', encoderIndex: 0, delta: 3 });
    expect(fourth.view).toEqual({ kind: 'loop-root', pageIndex: 1, selectedIndex: 3 });
    expect(send(fourth, { type: 'ENCODER_PRESS', encoderIndex: 3 }).view).toMatchObject({ kind: 'editor', category: 'name' });
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
