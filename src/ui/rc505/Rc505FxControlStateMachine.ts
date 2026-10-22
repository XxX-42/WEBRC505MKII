import type { Rc505FxControlLayer } from './rc505ControlTypes';
export type Rc505FxSlot = 'A' | 'B' | 'C' | 'D';
export interface Rc505FxControlState { layer: Rc505FxControlLayer; editHeld: boolean; consumed: boolean }
export type Rc505FxEvent = { type: 'EDIT_DOWN' | 'EDIT_UP' | 'EDIT_HOLD' | 'CANCEL' } | { type: 'SLOT'; slot: Rc505FxSlot };
export type Rc505FxEffect = { type: 'TOGGLE' | 'APPLY_BANK'; slot: Rc505FxSlot } | { type: 'OPEN_EDITOR'; slot?: Rc505FxSlot };
export const createRc505FxControlState = (): Rc505FxControlState => ({ layer: 'NORMAL', editHeld: false, consumed: false });

export function reduceRc505FxControl(state: Rc505FxControlState, event: Rc505FxEvent): { state: Rc505FxControlState; effects: Rc505FxEffect[] } {
  switch (event.type) {
    case 'EDIT_DOWN': return { state: { layer: state.layer === 'BANK_SELECT' ? 'NORMAL' : state.layer, editHeld: true, consumed: state.layer === 'BANK_SELECT' }, effects: [] };
    case 'EDIT_HOLD': return { state: state.editHeld && !state.consumed ? { ...state, layer: 'BANK_SELECT', consumed: true } : state, effects: [] };
    case 'EDIT_UP': {
      const open = state.editHeld && !state.consumed;
      return { state: { layer: open ? 'EDIT' : state.layer, editHeld: false, consumed: false }, effects: open ? [{ type: 'OPEN_EDITOR' }] : [] };
    }
    case 'CANCEL': return { state: { ...state, editHeld: false, consumed: false }, effects: [] };
    case 'SLOT':
      if (state.layer === 'BANK_SELECT') return { state, effects: [{ type: 'APPLY_BANK', slot: event.slot }] };
      if (state.editHeld) return { state: { ...state, layer: 'EDIT', consumed: true }, effects: [{ type: 'OPEN_EDITOR', slot: event.slot }] };
      return { state, effects: [{ type: 'TOGGLE', slot: event.slot }] };
  }
}
