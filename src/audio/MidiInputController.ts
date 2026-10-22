/**
 * Explicitly opt-in Web MIDI input for note messages.
 *
 * The module does not access `navigator` during evaluation. Browser permission
 * is requested only by `connect()`, and device names/IDs are never inspected
 * or exposed. The short-lived input references needed for event listeners are
 * released by `disconnect()`.
 */

export type MidiInputState =
  | 'disconnected'
  | 'runtime-unavailable'
  | 'connecting'
  | 'connected'
  | 'unsupported'
  | 'permission-denied'
  | 'error';

export interface MidiNoteEvent {
  readonly channel: number;
  readonly note: number;
  readonly velocity: number;
  readonly noteOn: boolean;
  readonly timeStampMs: number;
}

/** Structural Web MIDI event types keep tests independent of browser objects. */
export interface MidiMessageEventLike {
  readonly data: ArrayLike<number>;
  readonly timeStamp: number;
}

export interface MidiInputLike {
  addEventListener(type: 'midimessage', listener: (event: MidiMessageEventLike) => void): void;
  removeEventListener(type: 'midimessage', listener: (event: MidiMessageEventLike) => void): void;
}

export interface MidiInputMapLike {
  forEach(callback: (input: MidiInputLike) => void): void;
}

export interface MidiAccessLike {
  readonly inputs: MidiInputMapLike;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

/** Returns undefined when Web MIDI is unavailable. Injectable for deterministic tests. */
export type MidiAccessRequester = () => Promise<MidiAccessLike> | undefined;

export interface MidiInputControllerOptions {
  /** Optional 1-based MIDI channel filter. Omit it to receive all channels. */
  readonly channel?: number;
  readonly onStateChange?: (state: MidiInputState) => void;
  readonly requestMIDIAccess?: MidiAccessRequester;
}

function requestBrowserMidiAccess(): Promise<MidiAccessLike> | undefined {
  // Keep the browser global lookup inside this function: importing or
  // constructing a controller must never prompt for MIDI access.
  if (typeof navigator === 'undefined') return undefined;

  const midiNavigator = navigator as unknown as {
    requestMIDIAccess?: () => Promise<MidiAccessLike>;
  };
  if (typeof midiNavigator.requestMIDIAccess !== 'function') return undefined;
  return midiNavigator.requestMIDIAccess.call(navigator);
}

function isPermissionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

/**
 * A small Web MIDI note input adapter. Call `connect()` in response to an
 * explicit user action, then call `disconnect()` when the input is no longer
 * needed.
 */
export class MidiInputController {
  private readonly requestAccess: MidiAccessRequester;
  private readonly channelFilter?: number;
  private readonly onNote: (event: MidiNoteEvent) => void;
  private readonly onStateChange?: (state: MidiInputState) => void;
  private stateValue: MidiInputState = 'disconnected';
  private access?: MidiAccessLike;
  private readonly inputs = new Map<MidiInputLike, (event: MidiMessageEventLike) => void>();
  private readonly heldNotesByInput = new Map<MidiInputLike, Map<string, { channel: number; note: number; count: number }>>();
  private connectGeneration = 0;
  private connectionPromise?: Promise<MidiInputState>;

  private readonly handleStateChange = (): void => {
    if (this.access) this.syncInputs();
  };

  constructor(onNote: (event: MidiNoteEvent) => void, options: MidiInputControllerOptions = {}) {
    const channel = options.channel;
    if (channel !== undefined && (!Number.isInteger(channel) || channel < 1 || channel > 16)) {
      throw new RangeError('MIDI channel must be an integer from 1 through 16');
    }
    this.onNote = onNote;
    this.channelFilter = channel;
    this.onStateChange = options.onStateChange;
    this.requestAccess = options.requestMIDIAccess ?? requestBrowserMidiAccess;
  }

  get state(): MidiInputState {
    return this.stateValue;
  }

  /** Request access and begin listening. Permission is never requested implicitly. */
  connect(): Promise<MidiInputState> {
    if (this.access) return Promise.resolve(this.stateValue);
    if (this.connectionPromise) return this.connectionPromise;

    let accessRequest: Promise<MidiAccessLike> | undefined;
    try {
      accessRequest = this.requestAccess();
    } catch (error) {
      this.setState(isPermissionError(error) ? 'permission-denied' : 'error');
      return Promise.resolve(this.stateValue);
    }

    if (!accessRequest) {
      this.setState('unsupported');
      return Promise.resolve(this.stateValue);
    }

    const generation = ++this.connectGeneration;
    this.setState('connecting');

    let pending: Promise<MidiInputState>;
    pending = Promise.resolve(accessRequest)
      .then((access) => {
        if (generation !== this.connectGeneration) return this.stateValue;
        try {
          this.attachAccess(access);
          this.setState('connected');
        } catch (error) {
          this.releaseAccess();
          this.setState(isPermissionError(error) ? 'permission-denied' : 'error');
        }
        return this.stateValue;
      })
      .catch((error: unknown) => {
        if (generation === this.connectGeneration) {
          this.setState(isPermissionError(error) ? 'permission-denied' : 'error');
        }
        return this.stateValue;
      })
      .finally(() => {
        if (this.connectionPromise === pending) this.connectionPromise = undefined;
      });

    this.connectionPromise = pending;
    return pending;
  }

  /** Stop listening and release the current access/input references. */
  disconnect(): void {
    // Invalidates an in-flight permission request so it cannot reconnect later.
    this.connectGeneration += 1;
    this.connectionPromise = undefined;
    this.releaseAllHeldNotes();
    this.releaseAccess();
    this.setState('disconnected');
  }

  /** Release current held keys while retaining the granted MIDI connection. */
  releaseHeldNotes(): void {
    this.releaseAllHeldNotes();
  }

  private attachAccess(access: MidiAccessLike): void {
    this.access = access;
    access.addEventListener('statechange', this.handleStateChange);
    this.syncInputs();
  }

  private releaseAccess(): void {
    const access = this.access;
    if (access) access.removeEventListener('statechange', this.handleStateChange);
    for (const [input, listener] of this.inputs) {
      input.removeEventListener('midimessage', listener);
    }
    this.inputs.clear();
    this.heldNotesByInput.clear();
    this.access = undefined;
  }

  private syncInputs(): void {
    const access = this.access;
    if (!access) return;

    const currentInputs = new Set<MidiInputLike>();
    access.inputs.forEach((input) => currentInputs.add(input));

    for (const [input, listener] of this.inputs) {
      if (!currentInputs.has(input)) {
        this.releaseNotesForInput(input);
        input.removeEventListener('midimessage', listener);
        this.inputs.delete(input);
        this.heldNotesByInput.delete(input);
      }
    }

    for (const input of currentInputs) {
      if (!this.inputs.has(input)) {
        const listener = (event: MidiMessageEventLike): void => this.parseMessage(event, input);
        input.addEventListener('midimessage', listener);
        this.inputs.set(input, listener);
        this.heldNotesByInput.set(input, new Map());
      }
    }
  }

  private parseMessage(event: MidiMessageEventLike, input: MidiInputLike): void {
    const data = event?.data;
    if (!data || typeof data.length !== 'number' || data.length !== 3) return;

    const status = data[0];
    const note = data[1];
    const rawVelocity = data[2];
    if (
      typeof status !== 'number' || !Number.isInteger(status) || status < 0x80 || status > 0xff ||
      typeof note !== 'number' || !Number.isInteger(note) || note < 0 || note > 127 ||
      typeof rawVelocity !== 'number' || !Number.isInteger(rawVelocity) || rawVelocity < 0 || rawVelocity > 127 ||
      !Number.isFinite(event.timeStamp)
    ) {
      return;
    }

    const messageType = status & 0xf0;
    if (messageType !== 0x80 && messageType !== 0x90) return;

    const channel = (status & 0x0f) + 1;
    if (this.channelFilter !== undefined && channel !== this.channelFilter) return;

    const noteOn = messageType === 0x90 && rawVelocity > 0;
    const noteEvent: MidiNoteEvent = {
      channel,
      note,
      velocity: rawVelocity / 127,
      noteOn,
      timeStampMs: event.timeStamp,
    };
    const key = `${channel}:${note}`;
    const inputNotes = this.heldNotesByInput.get(input);
    if (!inputNotes) return;
    if (noteOn) {
      const heldOnInput = inputNotes.get(key);
      const wasHeldAnywhere = this.isNoteHeldAnywhere(key);
      inputNotes.set(key, { channel, note, count: (heldOnInput?.count ?? 0) + 1 });
      // Aggregate duplicate held notes across devices so one device's
      // release cannot stop a note still held by another input.
      if (!wasHeldAnywhere || heldOnInput) this.onNote(noteEvent);
      return;
    }

    const heldOnInput = inputNotes.get(key);
    if (heldOnInput && heldOnInput.count > 1) heldOnInput.count -= 1;
    else if (heldOnInput) inputNotes.delete(key);
    const stillHeld = this.isNoteHeldAnywhere(key);
    if (!stillHeld) this.onNote(noteEvent);
  }

  private isNoteHeldAnywhere(key: string): boolean {
    for (const notes of this.heldNotesByInput.values()) {
      if ((notes.get(key)?.count ?? 0) > 0) return true;
    }
    return false;
  }

  private releaseAllHeldNotes(): void {
    for (const input of this.heldNotesByInput.keys()) this.releaseNotesForInput(input);
  }

  private releaseNotesForInput(input: MidiInputLike): void {
    const notes = this.heldNotesByInput.get(input);
    if (!notes || notes.size === 0) return;
    const timeStampMs = typeof performance !== 'undefined' && Number.isFinite(performance.now())
      ? performance.now()
      : 0;
    const released = [...notes.entries()];
    notes.clear();
    for (const [key, note] of released) {
      if (this.isNoteHeldAnywhere(key)) continue;
      this.onNote({
        channel: note.channel,
        note: note.note,
        velocity: 0,
        noteOn: false,
        timeStampMs,
      });
    }
  }

  private setState(state: MidiInputState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.onStateChange?.(state);
  }
}
