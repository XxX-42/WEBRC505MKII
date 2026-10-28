import type { Rc505ControlLayer, Rc505LedColor, Rc505ResolvedControlState } from './rc505ControlTypes';
import type { TrackFxApplyStatus } from '../../audio/TrackFxApplyStatus';

/** AUTO REC is documented as blinking rapidly; the manual gives no cadence. */
export const RC505_AUTO_REC_LED_BLINK_PERIOD_MS = 500;

export interface Rc505TrackControlInput {
  state: string;
  hasPhrase: boolean | null;
  selected: boolean;
  available: boolean;
  ready: boolean;
  recordReady?: boolean;
  recordUnavailableReason?: string;
  autoRecArmed?: boolean;
  layer: Rc505ControlLayer;
  history: { canUndo: boolean; canRedo: boolean; busy: boolean; unavailableReason?: string };
  mark?: { supported: boolean; exists: boolean; canSet: boolean; canClear: boolean; busy: boolean; unavailableReason: string | null };
  operationPending?: boolean;
  /** Both recording and playback routes must have a matching render ACK. */
  fxApplied?: boolean | null;
  fxApplySupported?: boolean;
  fxUnavailableReason?: string;
  fxApplyState?: TrackFxApplyStatus;
}

function resolved(role: string, enabled: boolean, color: Rc505LedColor = 'off', selected = false, reason = ''): Rc505ResolvedControlState {
  return { enabled, selected, ledOn: color !== 'off', ledColor: color, hardwareRole: role, unavailableReason: enabled ? '' : reason };
}

export function resolveRc505TrackControls(input: Rc505TrackControlInput) {
  const ready = input.available && input.ready && !input.operationPending;
  if (input.layer === 'UNDO_REDO') {
    const mark = input.mark;
    const markReady = ready && mark?.supported === true && !mark.busy;
    const historyReady = ready && !input.history.busy && !mark?.busy && (input.history.canUndo || input.history.canRedo);
    const markReason = mark?.unavailableReason || 'MARK is not supported by this audio runtime.';
    return {
      record: resolved(input.history.canUndo ? 'UNDO' : input.history.canRedo ? 'REDO' : 'UNDO_REDO', historyReady,
        historyReady ? input.history.canUndo ? 'green' : 'red' : 'off', false,
        input.history.unavailableReason || 'No confirmed history step.'),
      track: resolved('MARK_SET', markReady && mark.canSet, 'off', input.selected, markReason),
      fx: resolved('MARK_CLEAR', markReady && mark.canClear, 'off', false, markReason),
      stop: resolved('MARK_BACK', false, 'off', false, 'MARK BACK hardware state transitions are not yet verified.'),
    };
  }
  const colors: Record<string, Rc505LedColor> = { RECORDING: 'red', PLAYING: 'green', OVERDUBBING: 'yellow' };
  const record = resolved('REC_PLAY', ready && input.recordReady !== false, colors[input.state] ?? 'off', false,
    input.recordUnavailableReason || 'Audio input or transport is not ready.');
  if (input.state === 'REC_STANDBY' && input.autoRecArmed === true) {
    // Red and 500ms are visual engineering approximations; only rapid blinking is official.
    record.ledColor = 'red';
    record.ledOn = true;
    record.ledBlinkPeriodMs = RC505_AUTO_REC_LED_BLINK_PERIOD_MS;
    record.blink = 'ENGINEERING_APPROXIMATION';
  } else if (input.state === 'REC_STANDBY' || input.state === 'REC_FINISHING') {
    record.blink = 'UNVERIFIED';
  }
  const fx = input.fxApplyState;
  const fxSupported = fx ? fx.available && !fx.pending && !fx.controlFaulted : input.fxApplySupported === true;
  const fxApplied = fx ? fx.available && !fx.controlFaulted && fx.applied : input.fxApplied === true;
  return {
    record,
    track: resolved('TRACK_EDIT', input.available, input.hasPhrase === true ? 'green' : 'off', input.selected, 'Track unavailable.'),
    fx: resolved('TRACK_FX_APPLY', ready && fxSupported,
      fxApplied ? 'red' : 'off', false, fx?.pending ? 'Waiting for both audio routes to confirm the FX switch.'
        : fx?.error || input.fxUnavailableReason || 'Per-track application of the shared Track FX is unavailable.'),
    stop: resolved('STOP_CLEAR', ready, 'off', false, 'Audio transport is not ready.'),
  };
}

export function resolveRc505FxSlot(input: { enabled: boolean; active: boolean; selected: boolean; layer: 'NORMAL' | 'EDIT' | 'BANK_SELECT'; appliedBank?: boolean; reason?: string }): Rc505ResolvedControlState {
  const bank = input.layer === 'BANK_SELECT';
  return resolved(bank ? 'FX_BANK_SELECT' : 'FX_TOGGLE', input.enabled,
    bank ? input.appliedBank ? 'blue' : 'off' : input.active ? input.selected ? 'pink' : 'red' : 'off',
    input.selected, input.reason ?? 'FX is unavailable.');
}
