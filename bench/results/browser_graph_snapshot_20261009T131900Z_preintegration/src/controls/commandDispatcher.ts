export type AudioControlCommand =
  | { type: 'record-track'; trackId: number }
  | { type: 'stop-track'; trackId: number }
  | { type: 'clear-track'; trackId: number }
  | { type: 'play-all' }
  | { type: 'stop-all' }
  | { type: 'toggle-transport' }
  | { type: 'undo'; trackId?: number }
  | { type: 'redo'; trackId?: number }
  | { type: 'mark'; trackId?: number }
  | { type: 'mark-back'; trackId?: number }
  | { type: 'mark-clear'; trackId?: number }
  | { type: 'rec-back'; trackId?: number }
  | { type: 'bounce'; trackId?: number }
  | { type: 'load-memory'; memoryId: number }
  | { type: 'set-track-level'; trackId: number; value: number }
  | { type: 'set-track-pan'; trackId: number; value: number }
  | { type: 'set-track-fx-send'; trackId: number; enabled: boolean }
  | { type: 'set-tempo'; value: number };

export type ControlSource = 'cc' | 'note' | 'foot' | 'expression';
export type ControlTrigger = 'press' | 'release' | 'value';

export type ControlInputEvent =
  | { source: 'keyboard'; id: string; shiftKey?: boolean }
  | { source: 'cc' | 'note' | 'foot' | 'expression'; id: string; channel?: number | null; number: number; value: number; deviceId?: string };

export interface ControlAssignment {
  source: ControlSource;
  channel: number | null;
  number: number;
  trigger: ControlTrigger;
  command: AudioControlCommand['type'];
  trackId: number;
  /** Explicit memory target for an Assign Memory command; legacy rows use number + 1. */
  memoryId?: number;
}

export interface ControlDispatcherState {
  version: 1;
  assignments: Array<ControlAssignment | null>;
}

export const CONTROL_ASSIGNMENT_COUNT = 16;
export const CONTROL_ASSIGNMENTS_STORAGE_KEY = 'webrc505_control_assignments_v1';

const TRACK_ACTIONS = new Set<AudioControlCommand['type']>([
  'record-track',
  'stop-track',
  'clear-track',
  'undo',
  'redo',
  'mark',
  'mark-back',
  'mark-clear',
  'rec-back',
  'bounce',
  'set-track-level',
  'set-track-pan',
  'set-track-fx-send',
]);

export function createDefaultControlAssignments(): Array<ControlAssignment | null> {
  return Array.from({ length: CONTROL_ASSIGNMENT_COUNT }, () => null);
}

function isControlAssignment(value: unknown): value is ControlAssignment {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ControlAssignment>;
  return (candidate.source === 'cc' || candidate.source === 'note' || candidate.source === 'foot' || candidate.source === 'expression')
    && (candidate.channel === null || (Number.isInteger(candidate.channel) && candidate.channel! >= 1 && candidate.channel! <= 16))
    && Number.isInteger(candidate.number)
    && candidate.number! >= 0
    && candidate.number! <= 127
    && (candidate.trigger === 'press' || candidate.trigger === 'release' || candidate.trigger === 'value')
    && typeof candidate.command === 'string'
    && ['record-track', 'stop-track', 'clear-track', 'play-all', 'stop-all', 'toggle-transport', 'undo', 'redo', 'mark', 'mark-back', 'mark-clear', 'rec-back', 'bounce', 'load-memory', 'set-track-level', 'set-track-pan', 'set-track-fx-send', 'set-tempo'].includes(candidate.command)
    && Number.isInteger(candidate.trackId)
    && candidate.trackId! >= 1
    && candidate.trackId! <= 5
    && (candidate.memoryId === undefined || (Number.isInteger(candidate.memoryId) && candidate.memoryId >= 1 && candidate.memoryId <= 99));
}

/** Shared runtime validator so project import and dispatcher updates accept the same command set. */
export function assertControlState(value: unknown): asserts value is ControlDispatcherState {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid control dispatcher state');
  const state = value as Partial<ControlDispatcherState>;
  if (state.version !== 1 || !Array.isArray(state.assignments) || state.assignments.length !== CONTROL_ASSIGNMENT_COUNT) {
    throw new TypeError('Invalid control dispatcher state');
  }
  state.assignments.forEach((assignment) => {
    if (assignment !== null && !isControlAssignment(assignment)) throw new TypeError('Invalid control assignment');
  });
}

export function loadControlAssignments(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): Array<ControlAssignment | null> {
  const empty = createDefaultControlAssignments();
  if (!storage) return empty;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CONTROL_ASSIGNMENTS_STORAGE_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return empty;
    return empty.map((_, index) => isControlAssignment(parsed[index]) ? parsed[index]! : null);
  } catch {
    return empty;
  }
}

export interface ControlDispatcherOptions {
  run: (command: AudioControlCommand) => void | Promise<void>;
  syncExternalClock?: (bpm: number, beatOrdinal: number) => void | Promise<void>;
  onError?: (error: unknown) => void;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/**
 * One command path for the hardware-style controls, keyboard shortcuts and MIDI.
 * The injected run function is the only place that needs to know the audio engine.
 */
export class ControlCommandDispatcher {
  private readonly runCommand: ControlDispatcherOptions['run'];
  private readonly syncExternalClock: ControlDispatcherOptions['syncExternalClock'];
  private readonly onError: ControlDispatcherOptions['onError'];
  private readonly storage: ControlDispatcherOptions['storage'];
  private readonly lastMidiValues = new Map<string, number>();
  private readonly midiClockPulses = new Map<string, { count: number; lastBeatAt: number | null; beatOrdinal: number }>();
  public readonly assignments: Array<ControlAssignment | null>;

  constructor(options: ControlDispatcherOptions) {
    this.runCommand = options.run;
    this.syncExternalClock = options.syncExternalClock;
    this.onError = options.onError;
    this.storage = options.storage === undefined
      ? (typeof localStorage === 'undefined' ? null : localStorage)
      : options.storage;
    this.assignments = loadControlAssignments(this.storage);
  }

  dispatch(command: AudioControlCommand): Promise<void> {
    try {
      return Promise.resolve(this.runCommand(command)).catch((error: unknown) => {
        this.onError?.(error);
      });
    } catch (error) {
      this.onError?.(error);
      return Promise.resolve();
    }
  }

  setAssignment(index: number, assignment: ControlAssignment | null): void {
    if (!Number.isInteger(index) || index < 0 || index >= CONTROL_ASSIGNMENT_COUNT) {
      throw new RangeError(`Control assignment index must be between 0 and ${CONTROL_ASSIGNMENT_COUNT - 1}`);
    }
    if (assignment && !isControlAssignment(assignment)) {
      throw new TypeError('Invalid control assignment');
    }
    this.assignments[index] = assignment ? { ...assignment } : null;
    this.persistAssignments();
  }

  getState(): ControlDispatcherState {
    return {
      version: 1,
      assignments: this.assignments.map((assignment) => assignment ? { ...assignment } : null),
    };
  }

  setState(state: ControlDispatcherState): void {
    assertControlState(state);
    state.assignments.forEach((assignment, index) => {
      this.assignments[index] = assignment ? { ...assignment } : null;
    });
    this.persistAssignments();
  }

  handleKeyboardEvent(event: KeyboardEvent): boolean {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return false;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return false;

    const key = event.key.toLowerCase();
    const handled = this.handleControlInput({ source: 'keyboard', id: key, shiftKey: event.shiftKey });
    if (handled) event.preventDefault();
    return handled;
  }

  handleControlInput(input: ControlInputEvent): boolean {
    if (input.source === 'keyboard') {
      const key = input.id.toLowerCase();
      if (key === ' ') {
        this.dispatch({ type: 'toggle-transport' });
        return true;
      }
      if (/^[1-5]$/.test(key)) {
        const trackId = Number(key);
        this.dispatch(input.shiftKey ? { type: 'stop-track', trackId } : { type: 'record-track', trackId });
        return true;
      }
      if (key === 'z') {
        this.dispatch({ type: 'undo' });
        return true;
      }
      if (key === 'y') {
        this.dispatch({ type: 'redo' });
        return true;
      }
      if (key === 'm') {
        this.dispatch({ type: 'mark' });
        return true;
      }
      if (key === 'b') {
        this.dispatch({ type: 'bounce' });
        return true;
      }
      return false;
    }

    const eventSource = input.source;
    const deviceId = input.deviceId ?? 'external';
    const channel = input.channel ?? 1;
    const sourceKey = `${deviceId}:${eventSource}:${channel}:${input.number}`;
    const previousValue = this.lastMidiValues.get(sourceKey) ?? 0;
    const incomingValue = (eventSource === 'foot' || eventSource === 'expression') && input.value > 0 && input.value <= 1
      ? Math.round(input.value * 127)
      : input.value;
    const value = Math.max(0, Math.min(127, Math.round(incomingValue)));
    this.lastMidiValues.set(sourceKey, value);
    let matched = false;

    this.assignments.forEach((assignment) => {
      if (!assignment || assignment.number !== input.number) return;
      if (assignment.channel !== null && assignment.channel !== channel) return;
      const sameSource = assignment.source === eventSource
        || (eventSource === 'cc' && (assignment.source === 'foot' || assignment.source === 'expression'))
        || (eventSource === 'note' && assignment.source === 'foot');
      if (!sameSource) return;

      const isExpression = assignment.source === 'expression'
        || (assignment.source === 'cc' && assignment.trigger === 'value');
      const isFoot = assignment.source === 'foot';
      if (isExpression && (eventSource !== 'cc' && eventSource !== 'expression')) return;
      if (isExpression && assignment.command !== 'set-track-level' && assignment.command !== 'set-track-pan' && assignment.command !== 'set-tempo') return;
      if (!isExpression && (assignment.command === 'set-track-level' || assignment.command === 'set-track-pan' || assignment.command === 'set-tempo')) return;
    if (assignment.source === 'expression' && assignment.trigger !== 'value') return;
    if (isFoot && assignment.trigger === 'value') return;
    if (assignment.command === 'set-track-fx-send' && assignment.trigger === 'value') return;

      const pressed = eventSource === 'note' ? value > 0 : value >= 64;
      const wasPressed = eventSource === 'note' ? previousValue > 0 : previousValue >= 64;
      if (assignment.trigger === 'press' && (!pressed || (eventSource !== 'note' && wasPressed))) return;
      if (assignment.trigger === 'release' && (pressed || !wasPressed)) return;
      if (assignment.trigger === 'value' && !isExpression) return;

      matched = true;
      this.dispatch(this.assignmentCommand(assignment, value));
    });
    return matched;
  }

  handleMidiMessage(data: ArrayLike<number>, timestamp = Date.now(), deviceId = 'default'): void {
    if (data.length < 1) return;
    const status = data[0]!;

    if (status === 0xf8) {
      this.handleMidiClock(timestamp, deviceId);
      return;
    }
    if (status === 0xfa || status === 0xfb) {
      if (status === 0xfa) this.midiClockPulses.set(deviceId, { count: 0, lastBeatAt: null, beatOrdinal: 0 });
      this.dispatch({ type: 'play-all' });
      return;
    }
    if (status === 0xfc) {
      this.midiClockPulses.set(deviceId, { count: 0, lastBeatAt: null, beatOrdinal: 0 });
      this.dispatch({ type: 'stop-all' });
      return;
    }

    const kind = status & 0xf0;
    const channel = (status & 0x0f) + 1;
    const number = data[1];
    const value = data[2] ?? 0;
    if (number === undefined) return;

    if (kind === 0xc0) {
      this.dispatch({ type: 'load-memory', memoryId: Math.max(1, Math.min(99, number + 1)) });
      return;
    }

    if (kind === 0xb0) {
      this.handleControlInput({ source: 'cc', id: String(number), channel, number, value, deviceId });
      return;
    }
    if (kind === 0x90 || kind === 0x80) {
      const noteValue = kind === 0x80 ? 0 : value;
      this.handleControlInput({ source: 'note', id: String(number), channel, number, value: noteValue, deviceId });
    }
  }

  /*
   * Input sources that do not arrive as MIDI can use handleControlInput too.
   * Footswitch events use press/release assignments; expression events use value assignments.
   */
  private handleMidiClock(timestamp: number, deviceId: string): void {
    const state = this.midiClockPulses.get(deviceId) ?? { count: 0, lastBeatAt: null, beatOrdinal: 0 };
    state.count += 1;
    if (state.count === 24) {
      state.count = 0;
      state.beatOrdinal += 1;
      if (state.lastBeatAt !== null) {
        const intervalMs = timestamp - state.lastBeatAt;
        const bpm = Math.round((60000 / intervalMs) * 1_000) / 1_000;
        if (intervalMs > 0 && bpm >= 40 && bpm <= 300) {
          if (!this.syncExternalClock) {
            this.onError?.(new Error('MIDI Clock sync is unavailable in the active audio engine.'));
          } else {
            try {
              void Promise.resolve(this.syncExternalClock(bpm, state.beatOrdinal)).catch((error: unknown) => this.onError?.(error));
            } catch (error) {
              this.onError?.(error);
            }
          }
        }
      }
      state.lastBeatAt = timestamp;
    }
    this.midiClockPulses.set(deviceId, state);
  }

  private assignmentCommand(assignment: ControlAssignment, midiValue: number): AudioControlCommand {
    if (assignment.command === 'set-tempo') {
      return { type: 'set-tempo', value: Math.round(40 + midiValue / 127 * 260) };
    }
    if (assignment.command === 'set-track-level') {
      return { type: 'set-track-level', trackId: assignment.trackId, value: Math.round(midiValue / 127 * 200) };
    }
    if (assignment.command === 'set-track-pan') {
      return { type: 'set-track-pan', trackId: assignment.trackId, value: Math.round(midiValue / 127 * 100 - 50) };
    }
    if (assignment.command === 'set-track-fx-send') {
      return { type: 'set-track-fx-send', trackId: assignment.trackId, enabled: assignment.trigger !== 'release' };
    }
    if (TRACK_ACTIONS.has(assignment.command)) {
      return { type: assignment.command, trackId: assignment.trackId } as AudioControlCommand;
    }
    if (assignment.command === 'load-memory') {
      return { type: 'load-memory', memoryId: assignment.memoryId ?? Math.max(1, Math.min(99, assignment.number + 1)) };
    }
    return { type: assignment.command } as AudioControlCommand;
  }

  private persistAssignments(): void {
    this.storage?.setItem(CONTROL_ASSIGNMENTS_STORAGE_KEY, JSON.stringify(this.assignments));
  }
}
