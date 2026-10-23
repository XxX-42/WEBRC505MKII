export type Rc505DisplayEditorTarget = 'menu' | 'memory' | 'track' | 'input-fx' | 'track-fx' | 'rhythm' | 'settings';

export type Rc505PlayScreenId =
  | 'memory-number'
  | 'track-status'
  | 'loop-tracks'
  | 'loop-status'
  | 'loop-level'
  | 'input-fx'
  | 'track-fx';

export const RC505_PLAY_SCREENS: ReadonlyArray<{ id: Rc505PlayScreenId; label: string }> = [
  { id: 'memory-number', label: 'MEMORY NUMBER' },
  { id: 'track-status', label: 'TRACK STATUS' },
  { id: 'loop-tracks', label: 'LOOP TRACKS' },
  { id: 'loop-status', label: 'LOOP STATUS' },
  { id: 'loop-level', label: 'LOOP LEVEL' },
  { id: 'input-fx', label: 'INPUT FX' },
  { id: 'track-fx', label: 'TRACK FX' },
];

export type Rc505MixerPageId = 'inputs' | 'outputs' | 'master';

export const RC505_MIXER_PAGES: ReadonlyArray<{ id: Rc505MixerPageId; label: string; channels: readonly string[] }> = [
  { id: 'inputs', label: 'INPUT MIXER', channels: ['MIC1', 'MIC2', 'INST1', 'INST2'] },
  { id: 'outputs', label: 'OUTPUT MIXER', channels: ['MAIN', 'SUB1', 'SUB2', 'LOOP'] },
  { id: 'master', label: 'MASTER MIXER', channels: ['RHYTHM', 'PHONES', 'MASTER'] },
];

export type Rc505DisplayRoot = 'loop' | 'menu';

export interface Rc505DisplayRootItem {
  id: string;
  label: string;
  target?: Rc505DisplayEditorTarget | 'mixer';
  reason?: string;
}

export const RC505_LOOP_ROOT_ITEMS: readonly Rc505DisplayRootItem[] = [
  { id: 'track', label: 'TRACK', target: 'track' },
  { id: 'rec', label: 'REC', target: 'memory' },
  { id: 'play', label: 'PLAY', target: 'memory' },
  { id: 'input-fx', label: 'INPUT FX', target: 'input-fx' },
  { id: 'track-fx', label: 'TRACK FX', target: 'track-fx' },
  { id: 'rhythm', label: 'RHYTHM', target: 'rhythm' },
  { id: 'name', label: 'NAME', target: 'memory' },
];

export const RC505_MENU_ROOT_ITEMS: readonly Rc505DisplayRootItem[] = [
  { id: 'input', label: 'INPUT', reason: 'Input routing settings are not exposed by the current audio controller.' },
  { id: 'output', label: 'OUTPUT', target: 'menu' },
  { id: 'mixer', label: 'MIXER', target: 'mixer' },
  { id: 'ctl-func', label: 'CTL FUNC', reason: 'Controller and function assignment are not exposed by the current audio controller.' },
  { id: 'assign', label: 'ASSIGN', reason: 'Assign settings are not exposed by the current audio controller.' },
  { id: 'usb', label: 'USB', reason: 'USB settings are not exposed by the current audio controller.' },
  { id: 'midi', label: 'MIDI', reason: 'MIDI settings are not exposed by the current audio controller.' },
  { id: 'setup', label: 'SETUP', reason: 'Setup options are not modeled by the current audio controller.' },
  { id: 'factory-reset', label: 'FACTORY RESET', reason: 'Factory reset is not implemented in this build.' },
];

export type Rc505DisplayView =
  | { kind: 'play'; pageIndex: number }
  | { kind: 'mixer'; pageIndex: number }
  | { kind: 'loop-root' | 'menu-root'; pageIndex: number; selectedIndex: number }
  | { kind: 'editor'; target: Rc505DisplayEditorTarget; category: string; pageIndex: number; pageCount: number }
  | { kind: 'confirm'; prompt: string }
  | { kind: 'memory-write'; operation: 'choose' | 'write' | 'clear'; slot: number; busy: boolean };

export interface Rc505DisplayState {
  view: Rc505DisplayView;
  returnStack: readonly Rc505DisplayView[];
  notice: string;
  lastConfirmation: 'accepted' | 'cancelled' | null;
}

export type Rc505DisplayAction =
  | { type: 'PAGE'; direction: -1 | 1 }
  | { type: 'ENTER' }
  | { type: 'EXIT' }
  | { type: 'OPEN_ROOT'; root: Rc505DisplayRoot }
  | { type: 'OPEN_EDITOR'; target: Rc505DisplayEditorTarget; category: string }
  | { type: 'ENCODER_ROTATE'; encoderIndex: number; delta: number }
  | { type: 'ENCODER_PRESS'; encoderIndex: number }
  | { type: 'ENCODER_PRESS_ROTATE'; encoderIndex: number; delta: number }
  | { type: 'EDITOR_PAGE_COUNT'; count: number }
  | { type: 'REQUEST_CONFIRMATION'; prompt: string }
  | { type: 'CONFIRM'; accepted: boolean }
  | { type: 'OPEN_MEMORY_WRITE'; slot: number }
  | { type: 'MEMORY_COMPLETE'; success: boolean; message?: string }
  | { type: 'CLEAR_NOTICE' };
