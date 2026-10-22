import { reactive, readonly } from 'vue';
import type { Rc505ControlLayer, Rc505FxControlLayer } from '../ui/rc505/rc505ControlTypes';
type ControlErrorScope = 'general' | 'input-fx' | 'track-fx';

const state = reactive({
  controlLayer: 'NORMAL' as Rc505ControlLayer,
  fxLayers: { input: 'NORMAL', track: 'NORMAL' } as Record<'input' | 'track', Rc505FxControlLayer>,
  fxBusy: { input: false, track: false },
  error: '',
  errorDetail: '',
  errorScope: 'general' as ControlErrorScope,
});

export function useRc505Controls() {
  return {
    state: readonly(state),
    toggleUndoLayer() { state.controlLayer = state.controlLayer === 'NORMAL' ? 'UNDO_REDO' : 'NORMAL'; state.error = ''; state.errorDetail = ''; state.errorScope = 'general'; },
    setFxLayer(location: 'input' | 'track', layer: Rc505FxControlLayer) { state.fxLayers[location] = layer; },
    setFxBusy(location: 'input' | 'track', busy: boolean) { state.fxBusy[location] = busy; },
    reportError(message: string, detail = message, scope: ControlErrorScope = 'general') { state.error = message; state.errorDetail = detail; state.errorScope = scope; },
    errorFor(context: 'play' | 'input-fx' | 'track-fx' | 'other') {
      return state.errorScope === 'general' || context === 'play' || context === state.errorScope ? state.error : '';
    },
    clearError(scope: ControlErrorScope) { if (state.errorScope === scope) { state.error = ''; state.errorDetail = ''; } },
    reset() { state.controlLayer = 'NORMAL'; state.fxLayers.input = 'NORMAL'; state.fxLayers.track = 'NORMAL'; state.fxBusy.input = false; state.fxBusy.track = false; state.error = ''; state.errorDetail = ''; state.errorScope = 'general'; },
  };
}
