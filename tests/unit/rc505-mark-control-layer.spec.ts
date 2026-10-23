import { describe, expect, it } from 'vitest';
import { resolveRc505TrackControls, type Rc505TrackControlInput } from '../../src/ui/rc505/Rc505ControlStateResolver';

const input = (): Rc505TrackControlInput => ({ state: 'STOPPED', hasPhrase: true, selected: true,
  available: true, ready: true, layer: 'UNDO_REDO', history: { canUndo: true, canRedo: false, busy: false },
  mark: { supported: true, exists: false, canSet: true, canClear: false, busy: false, unavailableReason: null } });

describe('confirmed Mark controls in the secondary layer', () => {
  it('exposes SET/CLEAR independently from Undo, with BACK explicitly unavailable', () => {
    const state = input();
    let controls = resolveRc505TrackControls(state);
    expect(controls.record).toMatchObject({ enabled: true, hardwareRole: 'UNDO', ledColor: 'green' });
    expect(controls.track).toMatchObject({ enabled: true, hardwareRole: 'MARK_SET', ledOn: false });
    expect(controls.fx.enabled).toBe(false);
    state.mark = { ...state.mark!, exists: true, canSet: false, canClear: true };
    controls = resolveRc505TrackControls(state);
    expect(controls.track.enabled).toBe(false);
    expect(controls.fx).toMatchObject({ enabled: true, hardwareRole: 'MARK_CLEAR', ledOn: false });
    expect(controls.stop).toMatchObject({ enabled: false, hardwareRole: 'MARK_BACK' });
    expect(controls.stop.unavailableReason).toMatch(/not yet verified/);
  });
  it('blocks conflicting operations until the asynchronous Mark operation is confirmed', () => {
    const state = input();
    state.mark!.busy = true;
    let controls = resolveRc505TrackControls(state);
    expect([controls.record, controls.track, controls.fx, controls.stop].every(control => !control.enabled)).toBe(true);
    state.mark!.busy = false;
    state.operationPending = true;
    controls = resolveRc505TrackControls(state);
    expect([controls.record, controls.track, controls.fx, controls.stop].every(control => !control.enabled)).toBe(true);
  });
  it('does not enable unsupported hosts or infer an LED from selection', () => {
    const state = input();
    state.mark = undefined;
    expect(resolveRc505TrackControls(state).track).toMatchObject({ enabled: false, selected: true, ledOn: false });
    state.layer = 'NORMAL';
    state.fxApplySupported = false;
    state.fxApplied = null;
    expect(resolveRc505TrackControls(state).fx).toMatchObject({ enabled: false, ledOn: false });
  });
  it('uses the backend Mark capability instead of inheriting stopped-only Undo restrictions', () => {
    const state = input();
    state.state = 'PLAYING';
    state.history.busy = true;
    const controls = resolveRc505TrackControls(state);
    expect(controls.track.enabled).toBe(true);
    expect(controls.record.enabled).toBe(false);
  });
});
