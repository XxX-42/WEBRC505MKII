import { afterEach, describe, expect, it, vi } from 'vitest';
import { RhythmEngine } from '../../src/audio/RhythmEngine';
import { DrumVoicePool, RHYTHM_PATTERN_CATALOG, createCleanRoomPatternEvents } from '../../src/audio/rhythm';
import { RhythmWorkletCore, RhythmWorkletProcessor, type RhythmWorkletConfiguration } from '../../src/audio/worklet/RhythmProcessor';
import { Transport } from '../../src/core/Transport';

class TestWorkletNode {
  static instances: TestWorkletNode[] = [];
  readonly port: {
    postMessage: ReturnType<typeof vi.fn>;
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
  } = { postMessage: vi.fn(), onmessage: null };
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

  emitMessage(data: unknown): void {
    this.port.onmessage?.({ data } as MessageEvent<unknown>);
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
  it('publishes a worklet-owned absolute measure origin and advances its epoch only on phase changes', () => {
    const sampleRate = 44_100;
    const bpm = 137;
    const stepsPerBar = 14;
    const configuration = createWorkletConfig({
      sampleRate,
      bpm,
      startFrame: 8_765_432,
      stepsPerBar,
    });
    const core = new RhythmWorkletCore(sampleRate);
    expect(core.getMeasurePhaseSnapshot(1)).toBeNull();

    core.configure(configuration);
    const first = core.getMeasurePhaseSnapshot(1)!;
    expect(first).toEqual({
      type: 'measure-phase',
      available: true,
      requestId: 1,
      epoch: 1,
      originFrame: configuration.startFrame,
      nextMeasureFrame: configuration.startFrame + Math.round((stepsPerBar * sampleRate * 15) / bpm),
      sampleRate,
      bpm,
      stepsPerBar,
    });
    const output = new Float32Array(128);
    core.renderInto(configuration.startFrame, output);
    expect(core.getMeasurePhaseSnapshot(1)).toEqual(first);

    core.configure({ ...configuration, startFrame: configuration.startFrame + 10_000 });
    expect(core.getMeasurePhaseSnapshot(2)).toMatchObject({
      available: true,
      requestId: 2,
      epoch: 2,
      originFrame: configuration.startFrame + 10_000,
    });
    core.stop();
    expect(core.getMeasurePhaseSnapshot(3)).toBeNull();
    expect(core.currentPhaseEpoch).toBe(3);
  });

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

  it('silences a stale AudioWorklet frame without advancing the rhythm timeline, then resumes', () => {
    const sampleRate = 16_000;
    const configuration = createWorkletConfig({
      sampleRate,
      startFrame: 1_024,
      eventTemplate: createCleanRoomPatternEvents(106, { sampleRate, bpm: 123, bars: 1, variation: 'A' }),
    });
    const reference = new RhythmWorkletCore(sampleRate);
    reference.configure(configuration);
    const expectedBlocks = [1_024, 1_152, 1_280, 1_408].map((frame) => reference.renderBlock(frame, 128));

    const recovering = new RhythmWorkletCore(sampleRate);
    recovering.configure(configuration);
    const first = new Float32Array(128);
    const second = new Float32Array(128);
    const stale = new Float32Array(128);
    const staleOverlap = new Float32Array(128);
    const resumed = new Float32Array(128);
    const following = new Float32Array(128);
    recovering.renderInto(1_024, first);
    recovering.renderInto(1_152, second);

    // AudioWorklet currentFrame rewound one 128-frame quantum after a successful block.
    // Never feed this stale range to DrumVoicePool; silence it without moving the cursor.
    expect(recovering.renderInto(1_024, stale)).toBe(false);
    expect([...stale].every((sample) => sample === 0)).toBe(true);
    // Partial-overlap and repeated stale blocks remain muted and do not move the cursor.
    expect(recovering.renderInto(1_279, staleOverlap)).toBe(false);
    expect([...staleOverlap].every((sample) => sample === 0)).toBe(true);
    expect(recovering.renderInto(1_280, resumed)).toBe(true);
    expect(recovering.renderInto(1_408, following)).toBe(true);
    expect(first).toEqual(expectedBlocks[0]);
    expect(second).toEqual(expectedBlocks[1]);
    expect(resumed).toEqual(expectedBlocks[2]);
    expect(following).toEqual(expectedBlocks[3]);
  });

  it('mutes repeated stale blocks around a bar boundary without replaying or duplicating hits', () => {
    const sampleRate = 16_000;
    const bpm = 120;
    const barFrames = sampleRate * 2;
    const configuration = createWorkletConfig({
      sampleRate,
      bpm,
      startFrame: 0,
      eventTemplate: createCleanRoomPatternEvents(106, { sampleRate, bpm, bars: 1, variation: 'A' }),
    });
    const reference = new RhythmWorkletCore(sampleRate);
    reference.configure(configuration);
    reference.renderBlock(0, barFrames - 256);
    reference.renderBlock(barFrames - 256, 128);
    reference.renderBlock(barFrames - 128, 128);
    const expectedAtBar = reference.renderBlock(barFrames, 128);

    const recovering = new RhythmWorkletCore(sampleRate);
    recovering.configure(configuration);
    recovering.renderBlock(0, barFrames - 256);
    recovering.renderBlock(barFrames - 256, 128);
    recovering.renderBlock(barFrames - 128, 128);

    const stale = new Float32Array(128);
    const repeatedStale = new Float32Array(128);
    const atBar = new Float32Array(128);
    expect(recovering.renderInto(barFrames - 128, stale)).toBe(false);
    expect(recovering.renderInto(barFrames - 256, repeatedStale)).toBe(false);
    expect([...stale, ...repeatedStale].every((sample) => sample === 0)).toBe(true);
    expect(recovering.renderInto(barFrames, atBar)).toBe(true);
    expect(atBar).toEqual(expectedAtBar);
    expect([...atBar].some((sample) => sample !== 0)).toBe(true);
  });

  it('keeps the absolute cursor across a tempo reconfiguration and resumes with the new pattern', () => {
    const sampleRate = 16_000;
    const initial = createWorkletConfig({ sampleRate, startFrame: 1_024 });
    const updated = createWorkletConfig({
      sampleRate,
      bpm: 91,
      startFrame: 1_280,
      eventTemplate: createCleanRoomPatternEvents(106, { sampleRate, bpm: 91, bars: 1, variation: 'D' }),
    });
    const reference = new RhythmWorkletCore(sampleRate);
    reference.configure(updated);
    const expected = reference.renderBlock(1_280, 128);

    const core = new RhythmWorkletCore(sampleRate);
    core.configure(initial);
    core.renderBlock(1_024, 128);
    core.renderBlock(1_152, 128);
    expect(core.expectedNextFrame).toBe(1_280);
    core.configure(updated);
    const stale = new Float32Array(128);
    const resumed = new Float32Array(128);
    expect(core.renderInto(1_152, stale)).toBe(false);
    expect([...stale].every((sample) => sample === 0)).toBe(true);
    expect(core.expectedNextFrame).toBe(1_280);
    expect(core.renderInto(1_280, resumed)).toBe(true);
    expect(resumed).toEqual(expected);
  });

  it('keeps DrumVoicePool strict when a caller attempts to render a stale frame', () => {
    const sampleRate = 16_000;
    const pool = new DrumVoicePool({ sampleRate, kit: 16, maxVoices: 4 });
    pool.renderBlock(1_024, 128);
    pool.renderBlock(1_152, 128);
    expect(() => pool.renderBlock(1_024, 128)).toThrow(
      'renderBlock must advance monotonically on the absolute sample-frame timeline',
    );
  });

  it('keeps the AudioWorklet alive, mutes stale frames, and posts one rewind/recovery pair', () => {
    const sampleRate = 16_000;
    const configuration = createWorkletConfig({
      sampleRate,
      startFrame: 1_024,
      eventTemplate: createCleanRoomPatternEvents(106, { sampleRate, bpm: 123, bars: 1, variation: 'A' }),
    });
    vi.stubGlobal('sampleRate', sampleRate);
    const processor = new RhythmWorkletProcessor();
    const postMessage = vi.spyOn(processor.port, 'postMessage');
    processor.port.onmessage?.({ data: { type: 'start', requestId: 7, configuration } });
    expect(postMessage.mock.calls.map(([message]) => (message as { type: string }).type)).toEqual(['measure-phase']);
    expect(postMessage.mock.calls[0]![0]).toMatchObject({
      type: 'measure-phase', available: true, requestId: 7, epoch: 1,
      originFrame: 1_024, sampleRate, bpm: 123, stepsPerBar: 16,
      nextMeasureFrame: 1_024 + Math.round((16 * sampleRate * 15) / 123),
    });

    const renderAt = (frame: number): { readonly alive: boolean; readonly output: Float32Array } => {
      vi.stubGlobal('currentFrame', frame);
      const output = new Float32Array(128);
      const alive = processor.process([], [[output]]);
      return { alive, output };
    };

    const first = renderAt(1_024);
    const second = renderAt(1_152);
    const stale = renderAt(1_024);
    const repeatedStale = renderAt(1_152);
    const resumed = renderAt(1_280);

    const reference = new RhythmWorkletCore(sampleRate);
    reference.configure(configuration);
    reference.renderBlock(1_024, 128);
    reference.renderBlock(1_152, 128);
    const expectedResumed = reference.renderBlock(1_280, 128);
    expect(first.alive && second.alive && stale.alive && repeatedStale.alive && resumed.alive).toBe(true);
    expect([...stale.output, ...repeatedStale.output].every((sample) => sample === 0)).toBe(true);
    expect(resumed.output).toEqual(expectedResumed);
    expect(postMessage.mock.calls.map(([message]) => (message as { type: string }).type)).toEqual([
      'measure-phase',
      'timeline-rewind',
      'timeline-recovered',
    ]);
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
    const transport = Transport.getInstance();
    const bpmListeners = () => ((transport as any).listeners.get('bpm-change') ?? []).length;
    const bpmListenersBefore = bpmListeners();
    const engine = new RhythmEngine(context);
    try {
      expect(bpmListeners()).toBe(bpmListenersBefore);
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
      expect(bpmListeners()).toBe(bpmListenersBefore + 1);
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
      expect(bpmListeners()).toBe(bpmListenersBefore);
      expect(node.port.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'stop', requestId: expect.any(Number) });
      expect(engine.outputNode.gain.value).toBe(0.75);
    } finally {
      engine.dispose();
    }
  });

  it('accepts only the current acknowledged worklet phase and invalidates it immediately on stop', async () => {
    vi.stubGlobal('AudioWorkletNode', TestWorkletNode);
    const context = createContext();
    const engine = new RhythmEngine(context);
    try {
      expect(engine.measurePhaseSnapshot).toBeNull();
      engine.start();
      await vi.waitFor(() => expect(TestWorkletNode.instances).toHaveLength(1));
      const node = TestWorkletNode.instances[0]!;
      const start = node.port.postMessage.mock.calls[0]![0] as { requestId: number; configuration: RhythmWorkletConfiguration };
      const phase = {
        type: 'measure-phase',
        available: true,
        requestId: start.requestId,
        epoch: 1,
        originFrame: start.configuration.startFrame,
        nextMeasureFrame: start.configuration.startFrame
          + Math.round((start.configuration.stepsPerBar * context.sampleRate * 15) / start.configuration.bpm),
        sampleRate: context.sampleRate,
        bpm: start.configuration.bpm,
        stepsPerBar: start.configuration.stepsPerBar,
      };
      node.emitMessage({ ...phase, requestId: start.requestId - 1 });
      expect(engine.measurePhaseSnapshot).toBeNull();
      node.emitMessage({ ...phase, epoch: 0 });
      expect(engine.measurePhaseSnapshot).toBeNull();
      node.emitMessage(phase);
      expect(engine.measurePhaseSnapshot).toMatchObject({
        epoch: 1,
        originFrame: start.configuration.startFrame,
        nextMeasureFrame: phase.nextMeasureFrame,
      });
      node.emitMessage({ ...phase, nextMeasureFrame: phase.nextMeasureFrame + 1 });
      expect(engine.measurePhaseSnapshot?.nextMeasureFrame).toBe(phase.nextMeasureFrame);

      engine.setCatalogPattern(240);
      expect(engine.measurePhaseSnapshot).toBeNull();
      const reconfigured = node.port.postMessage.mock.calls.at(-1)?.[0] as {
        requestId: number;
        configuration: RhythmWorkletConfiguration;
      };
      expect(reconfigured.requestId).toBeGreaterThan(start.requestId);
      const reconfiguredPhase = {
        ...phase,
        requestId: reconfigured.requestId,
        epoch: 2,
        originFrame: reconfigured.configuration.startFrame,
        bpm: reconfigured.configuration.bpm,
        stepsPerBar: reconfigured.configuration.stepsPerBar,
        nextMeasureFrame: reconfigured.configuration.startFrame
          + Math.round((reconfigured.configuration.stepsPerBar * context.sampleRate * 15)
            / reconfigured.configuration.bpm),
      };
      node.emitMessage(phase);
      expect(engine.measurePhaseSnapshot).toBeNull();
      node.emitMessage(reconfiguredPhase);
      expect(engine.measurePhaseSnapshot).toMatchObject({ epoch: 2, requestId: reconfigured.requestId });

      engine.stop();
      expect(engine.measurePhaseSnapshot).toBeNull();
      const stop = node.port.postMessage.mock.calls.at(-1)?.[0] as { requestId: number };
      node.emitMessage(reconfiguredPhase);
      expect(engine.measurePhaseSnapshot).toBeNull();
      node.emitMessage({ type: 'measure-phase', available: false, requestId: stop.requestId, epoch: 2 });
      expect(engine.measurePhaseSnapshot).toBeNull();

      engine.start();
      await vi.waitFor(() => expect(node.port.postMessage).toHaveBeenCalledTimes(4));
      const restarted = node.port.postMessage.mock.calls.at(-1)?.[0] as {
        requestId: number;
        configuration: RhythmWorkletConfiguration;
      };
      expect(restarted.requestId).toBeGreaterThan(stop.requestId);
      node.emitMessage({ type: 'measure-phase', available: false, requestId: stop.requestId, epoch: 3 });
      expect(engine.measurePhaseSnapshot).toBeNull();
      node.emitMessage({
        type: 'measure-phase',
        available: true,
        requestId: restarted.requestId,
        epoch: 4,
        originFrame: restarted.configuration.startFrame,
        nextMeasureFrame: restarted.configuration.startFrame
          + Math.round((restarted.configuration.stepsPerBar * context.sampleRate * 15) / restarted.configuration.bpm),
        sampleRate: context.sampleRate,
        bpm: restarted.configuration.bpm,
        stepsPerBar: restarted.configuration.stepsPerBar,
      });
      expect(engine.measurePhaseSnapshot).toMatchObject({ epoch: 4, requestId: restarted.requestId });
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

  it('surfaces timeline mute and recovery diagnostics through the rhythm status callback', async () => {
    vi.stubGlobal('AudioWorkletNode', TestWorkletNode);
    const context = createContext();
    const notifyStatus = vi.fn();
    const engine = new RhythmEngine(context, notifyStatus);
    try {
      engine.start();
      await vi.waitFor(() => expect(TestWorkletNode.instances).toHaveLength(1));
      const node = TestWorkletNode.instances[0]!;
      node.emitMessage({
        type: 'timeline-rewind',
        requestedStartFrame: 1_024,
        expectedStartFrame: 1_152,
        frameCount: 128,
      });
      expect(engine.error).toContain('block was muted');
      expect(engine.error).toContain('state was not rewound');
      expect(notifyStatus).toHaveBeenCalledOnce();

      node.emitMessage({
        type: 'timeline-recovered',
        firstStaleStartFrame: 1_024,
        expectedStartFrame: 1_152,
        resumedStartFrame: 1_152,
      });
      expect(engine.error).toContain('Timeline continuity was interrupted');
      expect(engine.error).toContain('not buffered for replay');
      expect(notifyStatus).toHaveBeenCalledTimes(2);
    } finally {
      engine.dispose();
    }
  });

  it('renders catalog GUIDE 210 with the same sample-frame click as legacy METRONOME, independent of variation/section', async () => {
    vi.stubGlobal('AudioWorkletNode', TestWorkletNode);
    const context = createContext();
    const engine = new RhythmEngine(context);
    try {
      engine.setCatalogPattern(210);
      engine.setVariation('D');
      engine.setSection('fill');
      engine.start();
      await vi.waitFor(() => expect(TestWorkletNode.instances).toHaveLength(1));

      const node = TestWorkletNode.instances[0]!;
      const posted = node.port.postMessage.mock.calls[0]![0] as { configuration: RhythmWorkletConfiguration };
      const { eventTemplate, startFrame } = posted.configuration;
      expect(eventTemplate.map(({ step }) => step)).toEqual([0, 4, 8, 12]);
      expect(eventTemplate.map(({ instrument }) => instrument)).toEqual(['kick', 'snare', 'snare', 'snare']);
      expect(startFrame).toBeGreaterThan(0);
      expect(eventTemplate.map(({ frame }) => frame)).toEqual([0, 24000, 48000, 72000]);
      expect(eventTemplate.every(({ variation, section, patternId }) =>
        variation === 'A' && section === 'main' && patternId === 'rhythm-210')).toBe(true);
      expect(engine.patternMetadata.genre).toBe('GUIDE');
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
