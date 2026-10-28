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
  /** Distinguishes observed semantics from an explicit visual approximation. */
  blink?: 'UNVERIFIED' | 'ENGINEERING_APPROXIMATION';
  /** Period used only when the state explicitly calls for a rendered blink. */
  ledBlinkPeriodMs?: number;
}
