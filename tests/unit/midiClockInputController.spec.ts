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

class FakeAudioContextClock {
  state: 'running' | 'suspended' = 'running';
  performanceTimeMs = 1_000;
  audioTimeSeconds = 10;
  private listeners = new Set<() => void>();
  get listenerCount(): number { return this.listeners.size; }
  addEventListener(_type: 'statechange', listener: () => void): void { this.listeners.add(listener); }
  removeEventListener(_type: 'statechange', listener: () => void): void { this.listeners.delete(listener); }
  changeState(state: 'running' | 'suspended'): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

describe('MidiClockInputController', () => {
  it('does not resubscribe to AudioContext statechange during disconnect refresh', async () => {
    const input = new FakeInput('Clock');
    const context = new FakeAudioContextClock();
    let controller!: MidiClockInputController;
    controller = new MidiClockInputController({
      requestMIDIAccess: async () => new FakeAccess([input]),
      now: () => context.performanceTimeMs,
      getAudioAnchor: () => ({
        performanceTimeMs: context.performanceTimeMs,
        audioTimeSeconds: context.audioTimeSeconds,
        sampleRate: 48_000,
        contextKey: context,
        contextState: context.state,
      }),
      // Mirrors a UI refresh callback that reads a snapshot during disconnect().
      onChange: () => { controller.getSnapshot(); },
    });
    await controller.connect();
    const inputKey = controller.getSnapshot().inputs[0]!.key;
    controller.selectInput(inputKey);
    expect(context.listenerCount).toBe(1);

    controller.disconnect();
    expect(context.listenerCount).toBe(0);
    controller.getSnapshot();
    expect(context.listenerCount).toBe(0);
  });

  it('invalidates old frame anchors for suspend and resume between polling snapshots', async () => {
    const input = new FakeInput('Clock');
    const context = new FakeAudioContextClock();
    const controller = new MidiClockInputController({
      requestMIDIAccess: async () => new FakeAccess([input]),
      now: () => context.performanceTimeMs,
      getAudioAnchor: () => ({
        performanceTimeMs: context.performanceTimeMs,
        audioTimeSeconds: context.audioTimeSeconds,
        sampleRate: 48_000,
        contextKey: context,
        contextState: context.state,
      }),
    });
    await controller.connect();
    controller.selectInput(controller.getSnapshot().inputs[0]!.key);
    input.send([0xf8], context.performanceTimeMs);
    expect(controller.getSnapshot().frameMapping.anchorCount).toBe(1);

    context.performanceTimeMs = 1_250;
    context.audioTimeSeconds = 10.25;
    expect(controller.getSnapshot().frameMapping.anchorCount).toBe(2);

    // Both statechange events occur before the next normal 250 ms diagnostic poll.
    context.changeState('suspended');
    context.changeState('running');
    context.performanceTimeMs = 1_500;
    context.audioTimeSeconds = 10.5;
    input.send([0xf8], 1_490);
    expect(controller.getSnapshot()).toMatchObject({
      frameMapping: { ok: false, frame: null, reason: 'insufficient-drift-evidence', anchorCount: 1, driftPpm: null },
    });
    controller.disconnect();
  });

  it('keeps an early MIDI Start unavailable after later fit evidence and maps only a fresh Start', async () => {
    const input = new FakeInput('Clock');
    const context = new FakeAudioContextClock();
    const controller = new MidiClockInputController({
      requestMIDIAccess: async () => new FakeAccess([input]),
      now: () => context.performanceTimeMs,
      getAudioAnchor: () => ({
        performanceTimeMs: context.performanceTimeMs,
        audioTimeSeconds: context.audioTimeSeconds,
        sampleRate: 48_000,
        contextKey: context,
        contextState: context.state,
      }),
    });
    await controller.connect();
    const key = controller.getSnapshot().inputs[0]!.key;
    controller.selectInput(key);
    controller.getSnapshot();
    context.performanceTimeMs = 1_250;
    context.audioTimeSeconds = 10.25;
    controller.getSnapshot();
    input.send([0xfa], 1_240);
    expect(controller.getSnapshot()).toMatchObject({
      lastStartAtMs: 1_240,
      startFrameMapping: { ok: false, frame: null, reason: 'insufficient-drift-evidence', anchorCount: 2, driftPpm: null },
      tickCount: 0,
      phaseState: 'waiting',
    });

    for (const timeMs of [2_000, 3_000, 4_000]) {
      context.performanceTimeMs = timeMs;
      context.audioTimeSeconds = 10 + (timeMs - 1_000) / 1_000;
      input.send([0xf8], timeMs - 10);
      const snapshot = controller.getSnapshot();
      expect(snapshot.startFrameMapping).toMatchObject({
        ok: false, frame: null, reason: 'insufficient-drift-evidence', driftPpm: null,
      });
    }
    expect(controller.getSnapshot()).toMatchObject({
      startFrameMapping: { ok: false, reason: 'insufficient-drift-evidence' },
    });

    input.send([0xfa], 4_000);
    expect(controller.getSnapshot()).toMatchObject({
      lastStartAtMs: 4_000,
      startFrameMapping: { ok: true, frame: 624_000, reason: null, anchorCount: 5 },
    });

    context.changeState('suspended');
    expect(controller.getSnapshot()).toMatchObject({ lastStartAtMs: null, startFrameMapping: { ok: false } });
    context.changeState('running');
    controller.disconnect();
    expect(controller.getSnapshot()).toMatchObject({ lastStartAtMs: null, startFrameMapping: { ok: false, reason: 'unanchored' } });
  });

  it('ignores MIDI Start from an unselected source and clears its projection on source change', async () => {
    const first = new FakeInput('First');
    const second = new FakeInput('Second');
    const controller = new MidiClockInputController({
      requestMIDIAccess: async () => new FakeAccess([first, second]),
      now: () => 100,
    });
    await controller.connect();
    const [firstPort, secondPort] = controller.getSnapshot(100).inputs;
    controller.selectInput(firstPort!.key);
    second.send([0xfa], 100);
    expect(controller.getSnapshot(100).lastStartAtMs).toBeNull();
    first.send([0xfa], 100);
    expect(controller.getSnapshot(100).lastStartAtMs).toBe(100);
    controller.selectInput(secondPort!.key);
    expect(controller.getSnapshot(100)).toMatchObject({ lastStartAtMs: null, startFrameMapping: { ok: false } });
  });

  it('expires the external Start projection after one second without a selected-source clock event', async () => {
    const input = new FakeInput('Clock');
    const controller = new MidiClockInputController({ requestMIDIAccess: async () => new FakeAccess([input]), now: () => 100 });
    await controller.connect();
    controller.selectInput(controller.getSnapshot(100).inputs[0]!.key);
    input.send([0xfa], 100);
    expect(controller.getSnapshot(100).lastStartAtMs).toBe(100);
    expect(controller.getSnapshot(1_101)).toMatchObject({
      lastStartAtMs: null,
      startFrameMapping: { ok: false, frame: null, reason: 'stale-event' },
      phaseState: 'waiting',
    });
  });

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

  it('locks relative phase only for the selected source and resets it on source changes', async () => {
    const first = new FakeInput('First');
    const second = new FakeInput('Second');
    const controller = new MidiClockInputController({ requestMIDIAccess: async () => new FakeAccess([first, second]), now: () => 0 });
    await controller.connect();
    const [firstPort, secondPort] = controller.getSnapshot(0).inputs;
    expect(firstPort).toBeDefined();
    expect(secondPort).toBeDefined();
    controller.selectInput(firstPort!.key);

    for (let tick = 0; tick < 9; tick += 1) first.send([0xf8], 100 + tick * (60_000 / 120 / 24));
    const locked = controller.getSnapshot(100 + 8 * (60_000 / 120 / 24));
    expect(locked).toMatchObject({ phaseState: 'locked', phaseLocked: true, phaseControlReady: true, phaseConsecutiveTrustedIntervals: 8, phaseAcceptedIntervals: 8, phaseInferredMissingTicks: 0 });
    expect(locked.phaseRelativeTicks).toBeCloseTo(8, 5);

    for (let tick = 0; tick < 9; tick += 1) second.send([0xf8], 1000 + tick * (60_000 / 120 / 24));
    const firstStillSelected = controller.getSnapshot(100 + 8 * (60_000 / 120 / 24));
    expect(firstStillSelected.phaseRelativeTicks).toBeCloseTo(8, 5);
    expect(firstStillSelected.selectedInputName).toBe('First');

    controller.selectInput(secondPort!.key);
    expect(controller.getSnapshot(1200)).toMatchObject({ phaseState: 'waiting', phaseLocked: false, phaseControlReady: false, phaseConsecutiveTrustedIntervals: 0, phaseAcceptedIntervals: 0, phaseRelativeTicks: null });
    second.send([0xf8], 2000);
    expect(controller.getSnapshot(2000)).toMatchObject({ phaseState: 'acquiring', phaseLocked: false, phaseAcceptedIntervals: 0, phaseRelativeTicks: null });
    for (let tick = 1; tick < 9; tick += 1) second.send([0xf8], 2000 + tick * (60_000 / 120 / 24));
    expect(controller.getSnapshot(2000 + 8 * (60_000 / 120 / 24))).toMatchObject({ phaseState: 'locked', phaseLocked: true, selectedInputName: 'Second' });
  });

  it('expires relative phase before the monitor signal goes stale and clears it when the selected source disconnects', async () => {
    const first = new FakeInput('First');
    const second = new FakeInput('Second');
    const access = new FakeAccess([first, second]);
    const controller = new MidiClockInputController({ requestMIDIAccess: async () => access, now: () => 0 });
    await controller.connect();
    controller.selectInput(controller.getSnapshot(0).inputs[0]!.key);
    const last = 100 + 8 * (60_000 / 120 / 24);
    for (let tick = 0; tick < 9; tick += 1) first.send([0xf8], 100 + tick * (60_000 / 120 / 24));
    expect(controller.getSnapshot(last).phaseLocked).toBe(true);
    expect(controller.getSnapshot(last + 501)).toMatchObject({ signal: 'observed', phaseState: 'stale', phaseLocked: false, phaseControlReady: false, phaseConsecutiveTrustedIntervals: 0, phaseRelativeTicks: null });

    first.state = 'disconnected';
    access.setPorts([second]);
    access.changeState();
    expect(controller.getSnapshot(last + 502)).toMatchObject({ selectedInputKey: null, phaseState: 'waiting', phaseAcceptedIntervals: 0, phaseRelativeTicks: null });
  });

  it('clears a disconnected port and its clock evidence on statechange', async () => {
    const input = new FakeInput('Clock');
    const access = new FakeAccess([input]);
    const controller = new MidiClockInputController({ requestMIDIAccess: async () => access, now: () => 0 });
    await controller.connect();
    controller.selectInput(controller.getSnapshot(0).inputs[0]!.key);
    input.send([0xf8], 100);
    input.send([0xfa], 110);
    expect(controller.getSnapshot(100).signal).toBe('observed');
    expect(controller.getSnapshot(110).lastStartAtMs).toBe(110);

    input.state = 'disconnected';
    access.changeState();
    expect(controller.getSnapshot(100)).toMatchObject({ signal: 'waiting', inputCount: 0, tickCount: 0, lastTickAtMs: null, lastStartAtMs: null, selectedInputKey: null, selectedInputName: null, startFrameMapping: { ok: false } });
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
