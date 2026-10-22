import { describe, expect, it, vi } from 'vitest';
import {
  MidiInputController,
  type MidiAccessLike,
  type MidiInputLike,
  type MidiInputMapLike,
  type MidiMessageEventLike,
} from '../../src/audio/MidiInputController';

class FakeMidiInput implements MidiInputLike {
  private readonly listeners = new Set<(event: MidiMessageEventLike) => void>();

  addEventListener(_type: 'midimessage', listener: (event: MidiMessageEventLike) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'midimessage', listener: (event: MidiMessageEventLike) => void): void {
    this.listeners.delete(listener);
  }

  emit(data: ArrayLike<number>, timeStamp: number): void {
    const event: MidiMessageEventLike = { data, timeStamp };
    for (const listener of this.listeners) listener(event);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeMidiInputMap implements MidiInputMapLike {
  constructor(private readonly inputs: Set<FakeMidiInput>) {}

  forEach(callback: (input: MidiInputLike) => void): void {
    this.inputs.forEach(callback);
  }
}

class FakeMidiAccess implements MidiAccessLike {
  private readonly stateListeners = new Set<() => void>();
  private readonly currentInputs = new Set<FakeMidiInput>();
  readonly inputs: MidiInputMapLike = new FakeMidiInputMap(this.currentInputs);

  constructor(inputs: FakeMidiInput[] = []) {
    inputs.forEach((input) => this.currentInputs.add(input));
  }

  addEventListener(_type: 'statechange', listener: () => void): void {
    this.stateListeners.add(listener);
  }

  removeEventListener(_type: 'statechange', listener: () => void): void {
    this.stateListeners.delete(listener);
  }

  replaceInputs(inputs: FakeMidiInput[]): void {
    this.currentInputs.clear();
    inputs.forEach((input) => this.currentInputs.add(input));
    for (const listener of this.stateListeners) listener();
  }

  get stateListenerCount(): number {
    return this.stateListeners.size;
  }
}

describe('MidiInputController', () => {
  it('requests access only after connect and parses note-on/off with 1-based channels', async () => {
    const input = new FakeMidiInput();
    const access = new FakeMidiAccess([input]);
    const requestAccess = vi.fn(() => Promise.resolve(access));
    const received: unknown[] = [];
    const controller = new MidiInputController((event) => received.push(event), {
      requestMIDIAccess: requestAccess,
    });

    expect(controller.state).toBe('disconnected');
    expect(requestAccess).not.toHaveBeenCalled();
    await expect(controller.connect()).resolves.toBe('connected');
    expect(requestAccess).toHaveBeenCalledOnce();

    input.emit([0x91, 60, 127], 12.5);
    input.emit([0x8f, 127, 64], 25);
    input.emit([0x9f, 0, 0], 31.25); // Velocity-zero note-on is note-off.
    input.emit([0xb0, 1, 64], 40); // Control change is ignored.
    input.emit([0x90, 60], 50); // Truncated message is ignored.
    input.emit([0x90, 128, 64], 55); // Out-of-range note is ignored.
    input.emit([0x90, 60, 64], Number.NaN); // Invalid timestamp is ignored.

    expect(received).toEqual([
      { channel: 2, note: 60, velocity: 1, noteOn: true, timeStampMs: 12.5 },
      { channel: 16, note: 127, velocity: 64 / 127, noteOn: false, timeStampMs: 25 },
      { channel: 16, note: 0, velocity: 0, noteOn: false, timeStampMs: 31.25 },
    ]);
  });

  it('optionally filters to the configured 1-based channel', async () => {
    const input = new FakeMidiInput();
    const access = new FakeMidiAccess([input]);
    const received: unknown[] = [];
    const controller = new MidiInputController((event) => received.push(event), {
      channel: 3,
      requestMIDIAccess: () => Promise.resolve(access),
    });
    await controller.connect();

    input.emit([0x91, 60, 100], 1);
    input.emit([0x92, 61, 100], 2);

    expect(received).toEqual([
      { channel: 3, note: 61, velocity: 100 / 127, noteOn: true, timeStampMs: 2 },
    ]);
    expect(() => new MidiInputController(() => undefined, { channel: 17 })).toThrow(RangeError);
  });

  it('attaches hot-plugged inputs and releases removed and disconnected listeners', async () => {
    const firstInput = new FakeMidiInput();
    const secondInput = new FakeMidiInput();
    const access = new FakeMidiAccess([firstInput]);
    const received: unknown[] = [];
    const controller = new MidiInputController((event) => received.push(event), {
      requestMIDIAccess: () => Promise.resolve(access),
    });
    await controller.connect();
    expect(firstInput.listenerCount).toBe(1);
    expect(access.stateListenerCount).toBe(1);

    access.replaceInputs([firstInput, secondInput]);
    expect(secondInput.listenerCount).toBe(1);
    access.replaceInputs([secondInput]);
    expect(firstInput.listenerCount).toBe(0);

    firstInput.emit([0x90, 60, 100], 1);
    secondInput.emit([0x90, 61, 100], 2);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ note: 61, timeStampMs: 2 });

    controller.disconnect();
    expect(controller.state).toBe('disconnected');
    expect(secondInput.listenerCount).toBe(0);
    expect(access.stateListenerCount).toBe(0);
    secondInput.emit([0x90, 62, 100], 3);
    access.replaceInputs([]);
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ note: 61, velocity: 0, noteOn: false });
  });

  it('releases notes when an input is unplugged or the controller disconnects', async () => {
    const unpluggedInput = new FakeMidiInput();
    const activeInput = new FakeMidiInput();
    const access = new FakeMidiAccess([unpluggedInput, activeInput]);
    const received: Array<{ channel: number; note: number; velocity: number; noteOn: boolean; timeStampMs: number }> = [];
    const controller = new MidiInputController((event) => received.push(event), {
      requestMIDIAccess: () => Promise.resolve(access),
    });
    await controller.connect();

    unpluggedInput.emit([0x92, 64, 90], 10);
    access.replaceInputs([activeInput]);
    activeInput.emit([0x93, 67, 80], 20);
    controller.disconnect();

    expect(received.map(({ channel, note, velocity, noteOn }) => ({ channel, note, velocity, noteOn }))).toEqual([
      { channel: 3, note: 64, velocity: 90 / 127, noteOn: true },
      { channel: 3, note: 64, velocity: 0, noteOn: false },
      { channel: 4, note: 67, velocity: 80 / 127, noteOn: true },
      { channel: 4, note: 67, velocity: 0, noteOn: false },
    ]);
    expect(received.slice(1).every(({ timeStampMs }) => Number.isFinite(timeStampMs))).toBe(true);
  });

  it('does not release a note while another connected input still holds it', async () => {
    const firstInput = new FakeMidiInput();
    const secondInput = new FakeMidiInput();
    const access = new FakeMidiAccess([firstInput, secondInput]);
    const received: unknown[] = [];
    const controller = new MidiInputController((event) => received.push(event), {
      requestMIDIAccess: () => Promise.resolve(access),
    });
    await controller.connect();

    firstInput.emit([0x90, 60, 100], 1);
    secondInput.emit([0x90, 60, 100], 2);
    firstInput.emit([0x80, 60, 0], 3);
    expect(received).toEqual([
      { channel: 1, note: 60, velocity: 100 / 127, noteOn: true, timeStampMs: 1 },
    ]);

    secondInput.emit([0x80, 60, 0], 4);
    expect(received).toEqual([
      { channel: 1, note: 60, velocity: 100 / 127, noteOn: true, timeStampMs: 1 },
      { channel: 1, note: 60, velocity: 0, noteOn: false, timeStampMs: 4 },
    ]);
    controller.disconnect();
  });

  it('keeps repeated note-ons from one input held until the matching note-off', async () => {
    const input = new FakeMidiInput();
    const access = new FakeMidiAccess([input]);
    const received: unknown[] = [];
    const controller = new MidiInputController((event) => received.push(event), {
      requestMIDIAccess: () => Promise.resolve(access),
    });
    await controller.connect();

    input.emit([0x90, 60, 100], 1);
    input.emit([0x90, 60, 90], 2);
    input.emit([0x80, 60, 0], 3);
    expect(received).toHaveLength(2);
    input.emit([0x80, 60, 0], 4);
    expect(received).toHaveLength(3);
    expect(received[2]).toMatchObject({ note: 60, velocity: 0, noteOn: false, timeStampMs: 4 });
    controller.disconnect();
  });

  it('releases held notes for a route change without disconnecting the MIDI access', async () => {
    const input = new FakeMidiInput();
    const access = new FakeMidiAccess([input]);
    const received: unknown[] = [];
    const controller = new MidiInputController((event) => received.push(event), {
      requestMIDIAccess: () => Promise.resolve(access),
    });
    await controller.connect();
    input.emit([0x90, 64, 100], 1);
    controller.releaseHeldNotes();
    expect(controller.state).toBe('connected');
    expect(input.listenerCount).toBe(1);
    expect(received).toEqual([
      { channel: 1, note: 64, velocity: 100 / 127, noteOn: true, timeStampMs: 1 },
      expect.objectContaining({ channel: 1, note: 64, velocity: 0, noteOn: false }),
    ]);
    input.emit([0x90, 67, 80], 2);
    expect(received.at(-1)).toMatchObject({ channel: 1, note: 67, noteOn: true });
    controller.disconnect();
  });

  it('reports unsupported and permission-denied access states', async () => {
    const unsupported = new MidiInputController(() => undefined, {
      requestMIDIAccess: () => undefined,
    });
    await expect(unsupported.connect()).resolves.toBe('unsupported');

    const denied = new MidiInputController(() => undefined, {
      requestMIDIAccess: () => Promise.reject({ name: 'NotAllowedError' }),
    });
    await expect(denied.connect()).resolves.toBe('permission-denied');
    expect(denied.state).toBe('permission-denied');
  });

  it('does not reconnect if disconnect happens while access is pending', async () => {
    let resolveAccess!: (access: MidiAccessLike) => void;
    const pendingAccess = new Promise<MidiAccessLike>((resolve) => {
      resolveAccess = resolve;
    });
    const input = new FakeMidiInput();
    const access = new FakeMidiAccess([input]);
    const controller = new MidiInputController(() => undefined, {
      requestMIDIAccess: () => pendingAccess,
    });

    const connectPromise = controller.connect();
    controller.disconnect();
    resolveAccess(access);

    await expect(connectPromise).resolves.toBe('disconnected');
    expect(controller.state).toBe('disconnected');
    expect(input.listenerCount).toBe(0);
    expect(access.stateListenerCount).toBe(0);
  });
});
