import { afterEach, describe, expect, it, vi } from 'vitest';
import { RhythmEngine } from '../../src/audio/RhythmEngine';
import { RHYTHM_PATTERN_CATALOG, createCleanRoomPatternEvents } from '../../src/audio/rhythm';
import { RhythmWorkletCore, type RhythmWorkletConfiguration } from '../../src/audio/worklet/RhythmProcessor';
import { Transport } from '../../src/core/Transport';

class TestWorkletNode {
  static instances: TestWorkletNode[] = [];
  readonly port = { postMessage: vi.fn() };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  onprocessorerror: (() => void) | null = null;

  constructor(
    readonly context: AudioContext,
    readonly processorName: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    TestWorkletNode.instances.push(this);
  }
}

function createContext(): AudioContext {
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    sampleRate: 48_000,
    currentTime: 10,
    state: 'running',
    destination: {},
    createGain: vi.fn(() => gain),
    audioWorklet: { addModule: vi.fn(async (_url: string) => undefined) },
    resume: vi.fn(async () => undefined),
  } as unknown as AudioContext;
  return context;
}

function createWorkletConfig(overrides: Partial<RhythmWorkletConfiguration> = {}): RhythmWorkletConfiguration {
  const sampleRate = 16_000;
  const events = createCleanRoomPatternEvents(RHYTHM_PATTERN_CATALOG[105]!, {
    sampleRate,
    bpm: 123,
    bars: 1,
    variation: 'A',
  });
  return {
    sampleRate,
    bpm: 123,
    startFrame: 0,
    swingPercent: 50,
    quantizeGrid: '1/16',
    stepsPerBar: 16,
    kitIndex: 16,
    maxVoices: 4,
    eventTemplate: events,
    ...overrides,
  };
}

afterEach(() => {
  TestWorkletNode.instances = [];
  vi.unstubAllGlobals();
});

describe('rhythm AudioWorklet integration', () => {
  it('renders variable-sized blocks on the absolute timeline with a bounded voice pool', () => {
    const template = createCleanRoomPatternEvents(106, {
      sampleRate: 16_000,
      bpm: 123,
      bars: 1,
      variation: 'A',
    });
    const core = new RhythmWorkletCore(16_000);
    core.configure(createWorkletConfig({ eventTemplate: template, maxVoices: 4 }));
    const first = core.renderBlock(0, 257);
    const second = core.renderBlock(257, 19);
    const third = core.renderBlock(276, 2049);
    expect([first.length, second.length, third.length]).toEqual([257, 19, 2049]);
    expect([...first, ...second, ...third].some((sample) => sample !== 0)).toBe(true);
    expect(core.peakVoiceCount).toBeLessThanOrEqual(4);
  });

  it('renders directly into reused caller buffers for variable block sizes', () => {
    const sampleRate = 44_100;
    const bpm = 131;
    const template = createCleanRoomPatternEvents(106, { sampleRate, bpm, bars: 1, variation: 'D' });
    const configuration = createWorkletConfig({
      sampleRate,
      bpm,
      swingPercent: 67,
      quantizeGrid: '1/8',
      eventTemplate: template,
      maxVoices: 8,
    });
    const inPlaceCore = new RhythmWorkletCore(sampleRate);
    const allocatedCore = new RhythmWorkletCore(sampleRate);
    inPlaceCore.configure(configuration);
    allocatedCore.configure(configuration);

    const sizes = [31, 257, 128, 2049, 7];
    const outputs = sizes.map((size) => new Float32Array(size));
    const totalFrames = sizes.reduce((sum, size) => sum + size, 0);
    const reference = allocatedCore.renderBlock(0, totalFrames);
    const allocationTrap = vi.fn(() => { throw new Error('renderInto allocated a Float32Array'); });
    vi.stubGlobal('Float32Array', allocationTrap);
    const joined: number[] = [];
    let startFrame = 0;
    for (let index = 0; index < sizes.length; index += 1) {
      const size = sizes[index]!;
      const output = outputs[index]!;
      inPlaceCore.renderInto(startFrame, output);
      joined.push(...output);
      startFrame += size;
    }
    expect(allocationTrap).not.toHaveBeenCalled();
    expect(joined).toEqual([...reference]);
    expect(inPlaceCore.peakVoiceCount).toBeLessThanOrEqual(8);
  });

  it('repeats one-bar templates by global step ordinal rather than accumulating rounded bar lengths', () => {
    const sampleRate = 44_100;
    const bpm = 137;
    const template = createCleanRoomPatternEvents(106, { sampleRate, bpm, bars: 1, variation: 'A' });
    const core = new RhythmWorkletCore(sampleRate);
    core.configure(createWorkletConfig({
      sampleRate,
      bpm,
      swingPercent: 67,
      quantizeGrid: '1/8',
      startFrame: 1_234,
      stepsPerBar: 16,
      eventTemplate: template,
      maxVoices: 8,
    }));
    const barFrames = 4 * 60 * sampleRate / bpm;
    const endFrame = Math.ceil(barFrames * 2);
    const rendered = core.renderBlock(0, endFrame);
    expect(rendered.length).toBe(endFrame);
    expect(core.peakVoiceCount).toBeLessThanOrEqual(8);
  });

  it('loads one rhythm processor, passes catalog/kit/variation data, and preserves legacy controls', async () => {
    vi.stubGlobal('AudioWorkletNode', TestWorkletNode);
    const context = createContext();
    const engine = new RhythmEngine(context);
    try {
      engine.connect({} as AudioNode);
      engine.setVolume(75);
      engine.setPattern('TECHNO');
      expect(engine.patternMetadata.id).toBe('rhythm-198');
      expect(engine.setKit(16)).toBe(true);
      engine.setVariation('D');
      expect(engine.setSwingPercent(67)).toBe(true);
      expect(engine.setQuantizeGrid('1/8')).toBe(true);
      const timerSpy = vi.spyOn(window, 'setTimeout');
      engine.start();
      engine.start();
      expect(timerSpy).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(TestWorkletNode.instances).toHaveLength(1));

      const node = TestWorkletNode.instances[0]!;
      expect(context.audioWorklet.addModule).toHaveBeenCalledWith('/worklets/rhythm-processor.js');
      expect(node.processorName).toBe('rc505-rhythm-processor');
      expect(node.options.outputChannelCount).toEqual([1]);
      expect(node.connect).toHaveBeenCalledOnce();
      expect(node.port.postMessage).toHaveBeenCalledOnce();
      expect(context.audioWorklet.addModule).toHaveBeenCalledOnce();
      const start = node.port.postMessage.mock.calls[0]![0] as {
        type: string;
        configuration: RhythmWorkletConfiguration;
      };
      expect(start.type).toBe('start');
      expect(start.configuration).toMatchObject({ kitIndex: 16, bpm: 120, stepsPerBar: 16, swingPercent: 67, quantizeGrid: '1/8' });
      expect(start.configuration.startFrame).toBeGreaterThan(480_000);
      expect(start.configuration.eventTemplate.length).toBeGreaterThan(0);
      expect(start.configuration.eventTemplate.every((event) => event.provenance === 'clean-room-generated')).toBe(true);
      expect(engine.eventProvenance).toBe('clean-room-generated');

      engine.setCatalogPattern(240);
      expect(engine.patternMetadata.id).toBe('rhythm-240');
      expect(node.port.postMessage).toHaveBeenCalledTimes(2);
      const updated = node.port.postMessage.mock.calls[1]![0] as { configuration: RhythmWorkletConfiguration };
      expect(updated.configuration.eventTemplate.every((event) => event.patternId === 'rhythm-240')).toBe(true);
      expect(engine.setCatalogPattern(241)).toBe(false);
      engine.setKit('JAZZ');
      expect(engine.selectedKit.officialName).toBe('JAZZ');
      expect(node.port.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
        type: 'start',
        configuration: { kitIndex: 7 },
      });
      engine.stop();
      expect(node.port.postMessage.mock.calls.at(-1)?.[0]).toEqual({ type: 'stop' });
      expect(engine.outputNode.gain.value).toBe(0.75);
    } finally {
      engine.dispose();
    }
  });

  it('keeps METRONOME as a four-beat clean-room click pattern and does not allocate hit nodes', async () => {
    vi.stubGlobal('AudioWorkletNode', TestWorkletNode);
    const context = createContext();
    const engine = new RhythmEngine(context);
    try {
      engine.setPattern('METRONOME');
      expect(engine.patternMetadata.id).toBe('rhythm-210');
      engine.start();
      await vi.waitFor(() => expect(TestWorkletNode.instances).toHaveLength(1));
      const node = TestWorkletNode.instances[0]!;
      const posted = node.port.postMessage.mock.calls[0]![0] as { configuration: RhythmWorkletConfiguration };
      expect(posted.configuration.eventTemplate.map((event) => event.step)).toEqual([0, 4, 8, 12]);
      expect(posted.configuration.eventTemplate.map((event) => event.instrument)).toEqual(['kick', 'snare', 'snare', 'snare']);
      expect(context.createGain).toHaveBeenCalledOnce();
      expect(engine.error).toBe('');
    } finally {
      engine.dispose();
    }
  });

  it('reconfigures at the new tempo and keeps clean-room timing settings through tempo changes', async () => {
    vi.stubGlobal('AudioWorkletNode', TestWorkletNode);
    const context = createContext();
    const engine = new RhythmEngine(context);
    const transport = Transport.getInstance();
    transport.setBpm(120);
    try {
      expect(engine.setSettings({
        patternIndex: 240,
        kitIndex: 16,
        variation: 'C',
        section: 'fill',
        swingPercent: 67,
        quantizeGrid: '1/8',
      })).toBe(true);
      engine.start();
      await vi.waitFor(() => expect(TestWorkletNode.instances).toHaveLength(1));
      const node = TestWorkletNode.instances[0]!;
      const initial = node.port.postMessage.mock.calls[0]![0] as { configuration: RhythmWorkletConfiguration };
      expect(initial.configuration).toMatchObject({ bpm: 120, swingPercent: 67, quantizeGrid: '1/8', kitIndex: 16 });

      context.currentTime = 12;
      transport.setBpm(93);
      expect(node.port.postMessage).toHaveBeenCalledTimes(2);
      const changed = node.port.postMessage.mock.calls[1]![0] as { configuration: RhythmWorkletConfiguration };
      expect(changed.configuration).toMatchObject({
        bpm: 93,
        swingPercent: 67,
        quantizeGrid: '1/8',
        kitIndex: 16,
        eventTemplate: expect.arrayContaining([expect.objectContaining({ patternId: 'rhythm-240', section: 'fill' })]),
      });
      expect(changed.configuration.startFrame).toBeGreaterThan(initial.configuration.startFrame);
      expect(engine.patternMetadata.id).toBe('rhythm-240');
    } finally {
      engine.dispose();
      transport.setBpm(120);
    }
  });
});
