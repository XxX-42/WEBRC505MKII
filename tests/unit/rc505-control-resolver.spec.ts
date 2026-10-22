import { describe, expect, it } from 'vitest';
import { resolveRc505FxSlot, resolveRc505TrackControls, type Rc505TrackControlInput } from '../../src/ui/rc505/Rc505ControlStateResolver';

const base: Rc505TrackControlInput = { state: 'EMPTY', hasPhrase: false, selected: false, available: true, ready: true, layer: 'NORMAL', history: { canUndo: false, canRedo: false, busy: false } };
describe('Classic hardware control semantics', () => {
  it('TRACK lamp reports a committed phrase independently of selection and recording', () => {
    expect(resolveRc505TrackControls({ ...base, selected: true }).track).toMatchObject({ ledOn: false, selected: true });
    expect(resolveRc505TrackControls({ ...base, hasPhrase: true }).track).toMatchObject({ ledOn: true, ledColor: 'green', selected: false });
    expect(resolveRc505TrackControls({ ...base, state: 'RECORDING' }).track.ledOn).toBe(false);
  });
  it.each([['RECORDING', 'red'], ['PLAYING', 'green'], ['OVERDUBBING', 'yellow'], ['STOPPED', 'off'], ['EMPTY', 'off']])('resolves %s transport to %s', (state, color) => {
    expect(resolveRc505TrackControls({ ...base, state }).record.ledColor).toBe(color);
  });
  it('does not invent shared per-track FX application or alias missing Mark actions', () => {
    expect(resolveRc505TrackControls(base).fx).toMatchObject({ enabled: false, ledOn: false, hardwareRole: 'TRACK_FX_APPLY' });
    const layer = resolveRc505TrackControls({ ...base, layer: 'UNDO_REDO' });
    expect(layer.track).toMatchObject({ enabled: false, hardwareRole: 'MARK_SET' });
    expect(layer.fx).toMatchObject({ enabled: false, hardwareRole: 'MARK_CLEAR' });
    expect(layer.stop).toMatchObject({ enabled: false, hardwareRole: 'MARK_BACK' });
    expect(layer.record.enabled).toBe(false);
  });
  it('keeps the specific input warm-up reason on a disabled record control', () => {
    const reason = 'Shared input capture pre-roll is warming.';
    expect(resolveRc505TrackControls({ ...base, recordReady: false, recordUnavailableReason: reason }).record)
      .toMatchObject({ enabled: false, unavailableReason: reason });
  });
  it('reports confirmed Undo and Redo capability with the layer-specific colors', () => {
    expect(resolveRc505TrackControls({ ...base, layer: 'UNDO_REDO', history: { canUndo: true, canRedo: false, busy: false } }).record).toMatchObject({ hardwareRole: 'UNDO', ledColor: 'green', enabled: true });
    expect(resolveRc505TrackControls({ ...base, layer: 'UNDO_REDO', history: { canUndo: false, canRedo: true, busy: false } }).record).toMatchObject({ hardwareRole: 'REDO', ledColor: 'red', enabled: true });
    expect(resolveRc505TrackControls({ ...base, layer: 'UNDO_REDO', history: { canUndo: true, canRedo: false, busy: true } }).record).toMatchObject({ enabled: false, ledOn: false });
  });
  it('separates FX operational focus, actual activation, and confirmed bank identity', () => {
    expect(resolveRc505FxSlot({ enabled: true, active: false, selected: true, layer: 'EDIT' }).ledOn).toBe(false);
    expect(resolveRc505FxSlot({ enabled: true, active: true, selected: false, layer: 'NORMAL' }).ledColor).toBe('red');
    expect(resolveRc505FxSlot({ enabled: true, active: true, selected: true, layer: 'EDIT' }).ledColor).toBe('pink');
    expect(resolveRc505FxSlot({ enabled: true, active: true, selected: true, layer: 'BANK_SELECT', appliedBank: false }).ledOn).toBe(false);
    expect(resolveRc505FxSlot({ enabled: true, active: false, selected: false, layer: 'BANK_SELECT', appliedBank: true }).ledColor).toBe('blue');
  });
});
