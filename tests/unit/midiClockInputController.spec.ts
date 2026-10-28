import { describe, expect, it, vi } from 'vitest';
import { MidiClockInputController } from '../../src/audio/MidiClockInputController';
import type { MidiAccessLike, MidiInputLike, MidiMessageEventLike } from '../../src/audio/MidiInputController';

class FakeInput implements MidiInputLike {
  private listeners = new Set<(event: MidiMessageEventLike) => void>();
  addEventListener(_type: 'midimessage', listener: (event: MidiMessageEventLike) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'midimessage', listener: (event: MidiMessageEventLike) => void): void {
    this.listeners.delete(listener);
  }
  send(data: number[], timeStamp: number): void {
    for (const listener of this.listeners) listener({ data, timeStamp });
  }
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

describe('MidiClockInputController', () => {
  it('requests access only on connect and observes F8 without interpreting note messages as clock', async () => {
    const input = new FakeInput();
    const access = new FakeAccess([input]);
    const requestMIDIAccess = vi.fn(async () => access);
    const controller = new MidiClockInputController({ requestMIDIAccess, now: () => 0 });

    expect(requestMIDIAccess).not.toHaveBeenCalled();
    expect(controller.getSnapshot(0)).toMatchObject({ connection: 'disconnected', signal: 'waiting', tickCount: 0 });
    await controller.connect();
    expect(controller.getSnapshot(0)).toMatchObject({ connection: 'connected', inputCount: 1 });

    input.send([0x90, 60, 100], 1);
    input.send([0xf8, 0xf8], 2);
    expect(controller.getSnapshot(2)).toMatchObject({ signal: 'waiting', tickCount: 0 });

    input.send([0xf8], 10);
    expect(controller.getSnapshot(10)).toMatchObject({ signal: 'observed', tickCount: 1, stability: 'insufficient-data' });
  });

  it('reports stable timing only after a full clean interval window, and marks missing ticks stale', async () => {
    const input = new FakeInput();
    const controller = new MidiClockInputController({
      requestMIDIAccess: async () => new FakeAccess([input]),
      now: () => 0,
    });
    await controller.connect();
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

  it('keeps port histories separate and reports multiple live clock sources as ambiguous', async () => {
    const first = new FakeInput();
    const second = new FakeInput();
    const access = new FakeAccess([first, second]);
    const controller = new MidiClockInputController({ requestMIDIAccess: async () => access, now: () => 0 });
    await controller.connect();
    const start = 100;
    const interval = 60_000 / 120 / 24;
    for (let tick = 0; tick <= 24; tick += 1) first.send([0xf8], start + tick * interval);
    const now = start + 24 * interval;
    expect(controller.getSnapshot(now).stability).toBe('stable');

    second.send([0xf8], now);
    expect(controller.getSnapshot(now)).toMatchObject({ signal: 'ambiguous', stability: 'insufficient-data', measuredBpm: null });

    access.setPorts([first]);
    access.changeState();
    expect(controller.getSnapshot(now)).toMatchObject({ signal: 'observed', stability: 'stable', inputCount: 1 });
  });

  it('clears a disconnected port and its clock evidence on statechange', async () => {
    const input = new FakeInput();
    const access = new FakeAccess([input]);
    const controller = new MidiClockInputController({ requestMIDIAccess: async () => access, now: () => 0 });
    await controller.connect();
    input.send([0xf8], 100);
    expect(controller.getSnapshot(100).signal).toBe('observed');

    access.setPorts([]);
    access.changeState();
    expect(controller.getSnapshot(100)).toMatchObject({ signal: 'waiting', inputCount: 0, tickCount: 0, lastTickAtMs: null });
  });

  it('removes listeners and clears clock evidence on disconnect', async () => {
    const input = new FakeInput();
    const controller = new MidiClockInputController({ requestMIDIAccess: async () => new FakeAccess([input]), now: () => 0 });
    await controller.connect();
    input.send([0xf8], 100);
    controller.disconnect();
    input.send([0xf8], 120);
    expect(controller.getSnapshot(120)).toMatchObject({ connection: 'disconnected', signal: 'waiting', tickCount: 0, inputCount: 0 });
  });
});
