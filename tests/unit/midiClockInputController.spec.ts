import { describe, expect, it, vi } from 'vitest';
import { MidiClockInputController, type MidiPermissionStatusLike } from '../../src/audio/MidiClockInputController';
import type { MidiAccessLike, MidiInputLike, MidiMessageEventLike } from '../../src/audio/MidiInputController';

class FakeInput implements MidiInputLike {
  constructor(readonly name: string) {}
  state: 'connected' | 'disconnected' = 'connected';
  private listeners = new Set<(event: MidiMessageEventLike) => void>();
  private lastListener?: (event: MidiMessageEventLike) => void;
  addEventListener(_type: 'midimessage', listener: (event: MidiMessageEventLike) => void): void {
    this.listeners.add(listener);
    this.lastListener = listener;
  }
  removeEventListener(_type: 'midimessage', listener: (event: MidiMessageEventLike) => void): void {
    this.listeners.delete(listener);
  }
  send(data: number[], timeStamp: number): void {
    for (const listener of this.listeners) listener({ data, timeStamp });
  }
  deliverLate(data: number[], timeStamp: number): void { this.lastListener?.({ data, timeStamp }); }
}

class FakeAccess implements MidiAccessLike {
  readonly inputs: MidiAccessLike['inputs'];
  private listeners = new Set<() => void>();
  constructor(private ports: MidiInputLike[]) {
    this.inputs = { forEach: (callback) => this.ports.forEach(callback) };
  }
  addEventListener(_type: 'statechange', listener: () => void): void { this.listeners.add(listener); }
  removeEventListener(_type: 'statechange', listener: () => void): void { this.listeners.delete(listener); }
  setPorts(ports: MidiInputLike[]): void { this.ports = ports; }
  changeState(): void { for (const listener of this.listeners) listener(); }
}

class FakePermissionStatus implements MidiPermissionStatusLike {
  state: 'granted' | 'denied' | 'prompt' = 'granted';
  private listeners = new Set<() => void>();
  addEventListener(_type: 'change', listener: () => void): void { this.listeners.add(listener); }
  removeEventListener(_type: 'change', listener: () => void): void { this.listeners.delete(listener); }
  setState(state: 'granted' | 'denied' | 'prompt'): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

describe('MidiClockInputController', () => {
  it('requests access only on connect and observes F8 without interpreting note messages as clock', async () => {
    const input = new FakeInput('Interface A');
    const access = new FakeAccess([input]);
    const requestMIDIAccess = vi.fn(async () => access);
    const controller = new MidiClockInputController({ requestMIDIAccess, now: () => 0 });

    expect(requestMIDIAccess).not.toHaveBeenCalled();
    expect(controller.getSnapshot(0)).toMatchObject({ connection: 'disconnected', signal: 'waiting', tickCount: 0 });
    await controller.connect();
    const connected = controller.getSnapshot(0);
    expect(connected).toMatchObject({ connection: 'connected', inputCount: 1, inputs: [{ name: 'Interface A' }], selectedInputKey: null });

    input.send([0x90, 60, 100], 1);
    input.send([0xf8, 0xf8], 2);
    expect(controller.getSnapshot(2)).toMatchObject({ signal: 'waiting', tickCount: 0 });

    input.send([0xf8], 10);
    expect(controller.getSnapshot(10)).toMatchObject({ signal: 'waiting', tickCount: 0, selectedInputKey: null });
    expect(controller.selectInput(connected.inputs[0]!.key)).toBe(true);
    expect(controller.getSnapshot(10)).toMatchObject({ signal: 'waiting', tickCount: 0 });
    input.send([0xf8], 20);
    expect(controller.getSnapshot(20)).toMatchObject({ signal: 'observed', tickCount: 1, selectedInputName: 'Interface A' });
  });

  it('reports stable timing only after a full clean interval window, and marks missing ticks stale', async () => {
    const input = new FakeInput('Clock');
    const controller = new MidiClockInputController({
      requestMIDIAccess: async () => new FakeAccess([input]),
      now: () => 0,
    });
    await controller.connect();
    const inputKey = controller.getSnapshot(0).inputs[0]!.key;
    controller.selectInput(inputKey);
    for (let tick = 0; tick <= 24; tick += 1) input.send([0xf8], tick * 20.8333333333);
    const stable = controller.getSnapshot(500);
    expect(stable.signal).toBe('observed');
    expect(stable.stability).toBe('stable');
    expect(stable.measuredBpm).toBeCloseTo(120, 1);

    input.send([0xf8], 700);
    expect(controller.getSnapshot(700).stability).toBe('unstable');
    expect(controller.getSnapshot(1801).signal).toBe('stale');
    expect(controller.getSnapshot(1801).stability).toBe('insufficient-data');
  });

  it('measures only the explicitly selected port and does not reuse another port history', async () => {
    const first = new FakeInput('First');
    const second = new FakeInput('Second');
    const access = new FakeAccess([first, second]);
    const controller = new MidiClockInputController({ requestMIDIAccess: async () => access, now: () => 0 });
    await controller.connect();
    const ports = controller.getSnapshot(0).inputs;
    controller.selectInput(ports[0]!.key);
    const start = 100;
    const interval = 60_000 / 120 / 24;
    for (let tick = 0; tick <= 24; tick += 1) first.send([0xf8], start + tick * interval);
    const now = start + 24 * interval;
    expect(controller.getSnapshot(now).stability).toBe('stable');

    second.send([0xf8], now);
    const stillFirst = controller.getSnapshot(now);
    expect(stillFirst).toMatchObject({ signal: 'observed', stability: 'stable' });
    expect(stillFirst.measuredBpm).toBeCloseTo(120, 5);
    expect(controller.selectInput(ports[1]!.key)).toBe(true);
    expect(controller.getSnapshot(now)).toMatchObject({ signal: 'waiting', stability: 'insufficient-data', measuredBpm: null });
    second.send([0xf8], now + 1);
    expect(controller.getSnapshot(now + 1)).toMatchObject({ signal: 'observed', tickCount: 1, measuredBpm: null });

    access.setPorts([first]);
    access.changeState();
    expect(controller.getSnapshot(now + 1)).toMatchObject({ signal: 'waiting', stability: 'insufficient-data', inputCount: 1, selectedInputKey: null });
  });

  it('clears a disconnected port and its clock evidence on statechange', async () => {
    const input = new FakeInput('Clock');
    const access = new FakeAccess([input]);
    const controller = new MidiClockInputController({ requestMIDIAccess: async () => access, now: () => 0 });
    await controller.connect();
    controller.selectInput(controller.getSnapshot(0).inputs[0]!.key);
    input.send([0xf8], 100);
    expect(controller.getSnapshot(100).signal).toBe('observed');

    input.state = 'disconnected';
    access.changeState();
    expect(controller.getSnapshot(100)).toMatchObject({ signal: 'waiting', inputCount: 0, tickCount: 0, lastTickAtMs: null, selectedInputKey: null, selectedInputName: null });
    input.deliverLate([0xf8], 120);
    expect(controller.getSnapshot(120)).toMatchObject({ signal: 'waiting', inputCount: 0, tickCount: 0, selectedInputKey: null });
  });

  it('clears selection and listeners when access is revoked, including late queued messages', async () => {
    const input = new FakeInput('Clock');
    const permission = new FakePermissionStatus();
    const controller = new MidiClockInputController({
      requestMIDIAccess: async () => new FakeAccess([input]),
      requestPermissionStatus: async () => permission,
      now: () => 0,
    });
    await controller.connect();
    const key = controller.getSnapshot(0).inputs[0]!.key;
    controller.selectInput(key);
    input.send([0xf8], 100);
    expect(controller.getSnapshot(100)).toMatchObject({ signal: 'observed', selectedInputKey: key });

    permission.setState('denied');
    expect(controller.getSnapshot(100)).toMatchObject({ connection: 'permission-denied', signal: 'waiting', inputCount: 0, selectedInputKey: null });
    input.deliverLate([0xf8], 120);
    expect(controller.getSnapshot(120)).toMatchObject({ connection: 'permission-denied', signal: 'waiting', inputCount: 0, tickCount: 0, selectedInputKey: null });
  });

  it('removes listeners and clears clock evidence on disconnect', async () => {
    const input = new FakeInput('Clock');
    const controller = new MidiClockInputController({ requestMIDIAccess: async () => new FakeAccess([input]), now: () => 0 });
    await controller.connect();
    controller.selectInput(controller.getSnapshot(0).inputs[0]!.key);
    input.send([0xf8], 100);
    controller.disconnect();
    input.send([0xf8], 120);
    expect(controller.getSnapshot(120)).toMatchObject({ connection: 'disconnected', signal: 'waiting', tickCount: 0, inputCount: 0, selectedInputKey: null });
  });
});
