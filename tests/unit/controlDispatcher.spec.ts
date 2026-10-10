import { describe, expect, it, vi } from 'vitest';
import {
  CONTROL_ASSIGNMENT_COUNT,
  assertControlState,
  ControlCommandDispatcher,
  type AudioControlCommand,
  type ControlAssignment,
} from '../../src/controls/commandDispatcher';
import type { FxMidiInputEvent } from '../../src/audio/nativeFxProtocol';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function assignment(overrides: Partial<ControlAssignment> = {}): ControlAssignment {
  return {
    source: 'cc',
    channel: 1,
    number: 60,
    trigger: 'press',
    command: 'record-track',
    trackId: 2,
    ...overrides,
  };
}

function createDispatcher() {
  const run = vi.fn<(command: AudioControlCommand) => void>();
  const syncExternalClock = vi.fn<(bpm: number, beatOrdinal: number) => void>();
  const forwardFxMidiInput = vi.fn<(event: FxMidiInputEvent) => boolean>(() => true);
  const dispatcher = new ControlCommandDispatcher({ run, syncExternalClock, forwardFxMidiInput, storage: new MemoryStorage() });
  return { dispatcher, run, syncExternalClock, forwardFxMidiInput };
}

describe('ControlCommandDispatcher', () => {
  it('triggers CC press assignments on each rising edge and ignores repeated high values', () => {
    const { dispatcher, run } = createDispatcher();
    dispatcher.setAssignment(0, assignment());

    dispatcher.handleMidiMessage([0xb0, 60, 127]);
    dispatcher.handleMidiMessage([0xb0, 60, 127]);
    dispatcher.handleMidiMessage([0xb0, 60, 0]);
    dispatcher.handleMidiMessage([0xb0, 60, 127]);

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { type: 'record-track', trackId: 2 },
      { type: 'record-track', trackId: 2 },
    ]);
  });

  it('triggers CC release assignments only on falling edges', () => {
    const { dispatcher, run } = createDispatcher();
    dispatcher.setAssignment(0, assignment({ trigger: 'release', command: 'stop-track' }));

    dispatcher.handleMidiMessage([0xb0, 60, 127]);
    dispatcher.handleMidiMessage([0xb0, 60, 0]);
    dispatcher.handleMidiMessage([0xb0, 60, 0]);
    dispatcher.handleMidiMessage([0xb0, 60, 127]);
    dispatcher.handleMidiMessage([0xb0, 60, 0]);

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { type: 'stop-track', trackId: 2 },
      { type: 'stop-track', trackId: 2 },
    ]);
  });

  it('maps FX-send press and release assignments to explicit enabled state', () => {
    const { dispatcher, run } = createDispatcher();
    dispatcher.setAssignment(0, assignment({ number: 62, command: 'set-track-fx-send', trigger: 'press' }));
    dispatcher.setAssignment(1, assignment({ number: 62, command: 'set-track-fx-send', trigger: 'release' }));

    dispatcher.handleMidiMessage([0xb0, 62, 127]);
    dispatcher.handleMidiMessage([0xb0, 62, 0]);

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { type: 'set-track-fx-send', trackId: 2, enabled: true },
      { type: 'set-track-fx-send', trackId: 2, enabled: false },
    ]);
  });

  it('keeps CC and note input values separate for matching numbers', () => {
    const { dispatcher, run } = createDispatcher();
    dispatcher.setAssignment(0, assignment({ source: 'cc', command: 'stop-track' }));
    dispatcher.setAssignment(1, assignment({ source: 'note', command: 'record-track', trackId: 1 }));

    dispatcher.handleMidiMessage([0xb0, 60, 127]);
    dispatcher.handleMidiMessage([0x90, 60, 100]);
    dispatcher.handleMidiMessage([0x80, 60, 0]);

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { type: 'stop-track', trackId: 2 },
      { type: 'record-track', trackId: 1 },
    ]);
  });

  it('forwards typed MIDI notes after preserving assignment behavior and normalizes CC all-notes-off', () => {
    const { dispatcher, run, forwardFxMidiInput } = createDispatcher();
    dispatcher.setAssignment(0, assignment({ source: 'note', channel: 2, command: 'record-track', trackId: 3 }));
    dispatcher.handleMidiMessage([0x92, 60, 0], 10.25, 'input-a');
    dispatcher.handleMidiMessage([0x83, 60, 45], 11.5, 'input-a');
    dispatcher.handleMidiMessage([0x91, 60, 100], 12.75, 'input-a');
    dispatcher.handleMidiMessage([0xb4, 120, 0], 14, 'input-b');

    expect(run).toHaveBeenCalledWith({ type: 'record-track', trackId: 3 });
    expect(forwardFxMidiInput.mock.calls.map(([event]) => event)).toEqual([
      { type: 'NoteOff', channel: 2, note: 60, velocity: 0, timestampMs: 10.25 },
      { type: 'NoteOff', channel: 3, note: 60, velocity: 45, timestampMs: 11.5 },
      { type: 'NoteOn', channel: 1, note: 60, velocity: 100, timestampMs: 12.75 },
      { type: 'AllNotesOff', channel: 4, note: 0, velocity: 0, timestampMs: 14 },
    ]);
  });

  it('normalizes footswitch CC input and triggers only on each physical rising edge', () => {
    const { dispatcher, run } = createDispatcher();
    dispatcher.setAssignment(0, assignment({ source: 'foot', number: 64 }));

    dispatcher.handleControlInput({ source: 'cc', id: '64', deviceId: 'pedal', channel: 1, number: 64, value: 127 });
    dispatcher.handleControlInput({ source: 'cc', id: '64', deviceId: 'pedal', channel: 1, number: 64, value: 127 });
    dispatcher.handleControlInput({ source: 'cc', id: '64', deviceId: 'pedal', channel: 1, number: 64, value: 0 });
    dispatcher.handleControlInput({ source: 'cc', id: '64', deviceId: 'pedal', channel: 1, number: 64, value: 127 });

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { type: 'record-track', trackId: 2 },
      { type: 'record-track', trackId: 2 },
    ]);
  });

  it('routes expression values through normalized mixer targets', () => {
    const { dispatcher, run } = createDispatcher();
    dispatcher.setAssignment(0, assignment({ source: 'expression', number: 11, trigger: 'value', command: 'set-track-pan' }));
    dispatcher.handleMidiMessage([0xb0, 11, 64]);

    expect(run).toHaveBeenCalledWith({ type: 'set-track-pan', trackId: 2, value: 0 });
  });

  it('keeps an Assign Memory target independent from its MIDI control number and validates the shared project state', () => {
    const { dispatcher, run } = createDispatcher();
    dispatcher.setAssignment(0, assignment({ number: 127, command: 'load-memory', memoryId: 23 }));
    assertControlState(dispatcher.getState());
    dispatcher.handleMidiMessage([0xb0, 127, 127]);
    expect(run).toHaveBeenCalledWith({ type: 'load-memory', memoryId: 23 });

    dispatcher.setAssignment(1, assignment({ number: 98, command: 'load-memory' }));
    dispatcher.handleMidiMessage([0xb0, 98, 127]);
    expect(run).toHaveBeenLastCalledWith({ type: 'load-memory', memoryId: 99 });
    expect(() => assertControlState({
      ...dispatcher.getState(),
      assignments: dispatcher.getState().assignments.map((item, index) => index === 0 ? { ...item!, memoryId: 100 } : item),
    })).toThrow(TypeError);
  });

  it('routes MIDI start, stop and program change through the audio command handler', () => {
    const { dispatcher, run } = createDispatcher();

    dispatcher.handleMidiMessage([0xfa]);
    dispatcher.handleMidiMessage([0xfc]);
    dispatcher.handleMidiMessage([0xc0, 98]);

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { type: 'play-all' },
      { type: 'stop-all' },
      { type: 'load-memory', memoryId: 99 },
    ]);
  });

  it('preserves millibpm when deriving tempo from two consecutive 24-pulse MIDI beats', () => {
    const { dispatcher, syncExternalClock } = createDispatcher();
    const expectedBpm = 93.457;
    const pulseIntervalMs = 60_000 / (expectedBpm * 24);
    for (let pulse = 0; pulse < 48; pulse += 1) {
      dispatcher.handleMidiMessage([0xf8], pulse * pulseIntervalMs, 'clock-1');
    }
    expect(syncExternalClock).toHaveBeenCalledTimes(1);
    expect(syncExternalClock).toHaveBeenCalledWith(expectedBpm, 2);
  });

  it('keeps clock devices independent and ignores out-of-range MIDI clock intervals', () => {
    const { dispatcher, syncExternalClock } = createDispatcher();
    const streams = [
      { deviceId: 'clock-a', bpm: 100 },
      { deviceId: 'clock-b', bpm: 200 },
      { deviceId: 'clock-invalid', bpm: 60_000 },
    ];
    for (let pulse = 0; pulse < 48; pulse += 1) {
      for (const stream of streams) {
        const intervalMs = 60_000 / (stream.bpm * 24);
        dispatcher.handleMidiMessage([0xf8], pulse * intervalMs, stream.deviceId);
      }
    }

    expect(syncExternalClock.mock.calls).toEqual([
      [100, 2],
      [200, 2],
    ]);
  });

  it('persists and restores exactly sixteen validated assignments', () => {
    const storage = new MemoryStorage();
    const first = new ControlCommandDispatcher({ run: vi.fn(), storage });
    first.setAssignment(15, assignment({ source: 'expression', trigger: 'value', command: 'set-track-level', trackId: 5 }));

    const next = new ControlCommandDispatcher({ run: vi.fn(), storage });
    expect(next.getState().assignments).toHaveLength(CONTROL_ASSIGNMENT_COUNT);
    expect(next.getState().assignments[15]).toEqual(assignment({ source: 'expression', trigger: 'value', command: 'set-track-level', trackId: 5 }));
  });
});
