export type Rc505LedColor = 'off' | 'red' | 'green' | 'yellow' | 'pink' | 'blue' | 'white' | 'purple' | 'cyan';
export type Rc505ControlLayer = 'NORMAL' | 'UNDO_REDO';
export type Rc505FxControlLayer = 'NORMAL' | 'EDIT' | 'BANK_SELECT';
export interface Rc505ResolvedControlState {
  enabled: boolean;
  selected: boolean;
  ledOn: boolean;
  ledColor: Rc505LedColor;
  hardwareRole: string;
  unavailableReason: string;
  /** Never invent a frequency where the hardware documentation gives none. */
  blink?: 'UNVERIFIED';
}
