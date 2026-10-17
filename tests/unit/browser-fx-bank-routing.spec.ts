import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { FX_CATALOG_BY_ID } from '../../src/audio/fx/catalog';
import { Transport } from '../../src/core/Transport';

class MockAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly gain = { setTargetAtTime: vi.fn() };
}

class MockWorkletNode {
  static instances: MockWorkletNode[] = [];
  readonly port = { postMessage: vi.fn() };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor(
    readonly context: BaseAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    MockWorkletNode.instances.push(this);
  }
}

function makeEngine(): {
  engine: BrowserAudioEngine;
  inputHead: MockAudioNode;
  inputTail: MockAudioNode;
  trackHead: MockAudioNode;
  trackTail: MockAudioNode;
  trackMix: MockAudioNode;
  addModule: ReturnType<typeof vi.fn>;
} {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const inputHead = new MockAudioNode();
  const inputTail = new MockAudioNode();
  const trackHead = new MockAudioNode();
  const trackTail = new MockAudioNode();
  const trackMix = new MockAudioNode();
  const addModule = vi.fn(async (_url: string) => undefined);
  const context = {
    sampleRate: 48000,
    currentTime: 2.25,
    audioWorklet: { addModule },
    createGain: () => new MockAudioNode(),
  } as unknown as AudioContext;

  Object.assign(engine, {
    context,
    inputFxChain: { input: inputHead, output: inputTail },
    outputFxChain: { input: trackHead, output: trackTail },
    trackMixNode: trackMix,
    currentInputStream: null,
    inputFxInstances: [null, null, null, null],
    trackFxInstances: [null, null, null, null],
    inputFxTypes: [null, null, null, null],
    trackFxTypes: [null, null, null, null],
    fxWorkletModuleReady: null,
    fxWorkletGeneration: 0,
    lastError: '',
    statusListeners: new Set(),
  });

  return { engine, inputHead, inputTail, trackHead, trackTail, trackMix, addModule };
}

describe('Browser clean-room DSP in dynamic FX banks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWorkletNode.instances = [];
  });

  it('routes four selected effects through each existing input and shared track A–D bank', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix, addModule } = makeEngine();
    const types = ['DSP LPF', 'DSP BPF', 'DSP HPF', 'FDN8 REVERB'] as const;

    types.forEach((type, slot) => {
      engine.setFxType('input', slot, type);
      engine.setFxType('track', slot, type);
    });

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(8));
    expect(addModule).toHaveBeenCalledOnce();
    expect(addModule).toHaveBeenCalledWith('/worklets/fx-processor.js');

    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(inputFx).toHaveLength(4);
    expect(trackFx).toHaveLength(4);
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[0]!.input);
    expect((inputFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputFx[1]!.input);
    expect((inputFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputFx[2]!.input);
    expect((inputFx[2]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputFx[3]!.input);
    expect((inputFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[0]!.input);
    expect((trackFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackFx[1]!.input);
    expect((trackFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackFx[2]!.input);
    expect((trackFx[2]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackFx[3]!.input);
    expect((trackFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'lpf', 'lpf', 'bpf', 'bpf', 'hpf', 'hpf', 'reverb', 'reverb',
    ]);
  });

  it('constructs G2B on the actual Input and shared Track bank slots', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    engine.setFxType('input', 0, 'G2B');
    engine.setFxType('track', 2, 'G2B');

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map(({ options }) => options.processorOptions?.algorithm)).toEqual(['g2b', 'g2b']);
    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[0]!.input);
    expect((inputFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[2]!.input);
    expect((trackFx[2]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
  });

  it('routes ELECTRIC characters through all Input and shared Track A-D worklet slots', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    for (let slot = 0; slot < 4; slot += 1) {
      engine.setFxType('input', slot, 'ELECTRIC');
      engine.setFxNamedParameters('input', slot, {
        character: slot,
        'pitch-snap': slot * 25,
        tone: 700 + (slot * 900),
      });
      engine.setFxParam('input', slot, 35 + (slot * 10));
    }
    for (let slot = 0; slot < 4; slot += 1) {
      engine.setFxType('track', slot, 'ELECTRIC');
      engine.setFxNamedParameters('track', slot, {
        character: 3 - slot,
        'pitch-snap': 100 - (slot * 25),
        tone: 1_000 + (slot * 1_100),
      });
      engine.setFxParam('track', slot, 65 - (slot * 10));
    }

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(8));
    expect(MockWorkletNode.instances.map(({ options }) => options.processorOptions?.algorithm))
      .toEqual(Array.from({ length: 8 }, () => 'electric'));
    for (let slot = 0; slot < 4; slot += 1) {
      expect(MockWorkletNode.instances[slot]!.options.processorOptions?.parameters).toMatchObject({
        electricCharacter: slot,
        electricPitchSnapPercent: slot * 25,
        electricToneHz: 700 + (slot * 900),
        mix: (35 + (slot * 10)) / 100,
      });
      expect(MockWorkletNode.instances[slot + 4]!.options.processorOptions?.parameters).toMatchObject({
        electricCharacter: 3 - slot,
        electricPitchSnapPercent: 100 - (slot * 25),
        electricToneHz: 1_000 + (slot * 1_100),
        mix: (65 - (slot * 10)) / 100,
      });
    }

    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[0]!.input);
    expect((inputFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputFx[1]!.input);
    expect((inputFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputFx[2]!.input);
    expect((inputFx[2]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputFx[3]!.input);
    expect((inputFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[0]!.input);
    expect((trackFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackFx[1]!.input);
    expect((trackFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackFx[2]!.input);
    expect((trackFx[2]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackFx[3]!.input);
    expect((trackFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
  });

  it('routes VOCODER through the real Input and shared Track slot adapters with named controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    engine.setFxType('input', 1, 'VOCODER');
    engine.setFxType('track', 3, 'VOCODER');
    engine.setFxParam('input', 1, 55);
    engine.setFxParam('track', 3, 65);
    engine.setFxNamedParameters('input', 1, { bands: 12, carrier: 2 });
    engine.setFxNamedParameters('track', 3, { bands: 20, carrier: 0 });

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map(({ options }) => options.processorOptions?.algorithm)).toEqual([
      'vocoder', 'vocoder',
    ]);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      vocoderBands: 12,
      vocoderCarrier: 2,
      mix: 0.55,
    });
    expect(MockWorkletNode.instances[1]!.options.processorOptions?.parameters).toMatchObject({
      vocoderBands: 20,
      vocoderCarrier: 0,
      mix: 0.65,
    });
    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[1]!.input);
    expect((inputFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[3]!.input);
    expect((trackFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
  });

  it('routes OSC BOT through Input and shared Track worklets with tempo and named controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    engine.setFxType('input', 0, 'OSC BOT');
    engine.setFxType('track', 2, 'OSC BOT');
    engine.setFxParam('input', 0, 60);
    engine.setFxParam('track', 2, 45);
    engine.setFxNamedParameters('input', 0, { waveform: 0, pattern: 4, tone: 4100 });
    engine.setFxNamedParameters('track', 2, { waveform: 2, pattern: 7, tone: 2700 });

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map(({ options }) => options.processorOptions?.algorithm)).toEqual(['osc-bot', 'osc-bot']);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      bpm: expect.any(Number),
      mix: 0.6,
      oscBotWaveform: 0,
      oscBotPattern: 4,
      oscBotToneHz: 4100,
    });
    expect(MockWorkletNode.instances[1]!.options.processorOptions?.parameters).toMatchObject({
      bpm: expect.any(Number),
      mix: 0.45,
      oscBotWaveform: 2,
      oscBotPattern: 7,
      oscBotToneHz: 2700,
    });
    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[0]!.input);
    expect((inputFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[2]!.input);
    expect((trackFx[2]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
  });

  it('routes OSC VOC (M) through selected Input and shared Track slots with MIDI controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    engine.setFxType('input', 1, 'OSC VOC (M)');
    engine.setFxType('track', 3, 'OSC VOC (M)');
    engine.setFxParam('input', 1, 55);
    engine.setFxParam('track', 3, 40);
    engine.setFxNamedParameters('input', 1, { waveform: 2, 'midi-channel': 3, octave: 12 });
    engine.setFxNamedParameters('track', 3, { waveform: 1, 'midi-channel': 9, octave: -12 });

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map(({ options }) => options.processorOptions?.algorithm)).toEqual([
      'osc-voc', 'osc-voc',
    ]);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      oscVocWaveform: 2,
      oscVocMidiChannel: 3,
      oscVocOctave: 12,
      oscVocBands: 16,
      mix: 0.55,
    });
    expect(MockWorkletNode.instances[1]!.options.processorOptions?.parameters).toMatchObject({
      oscVocWaveform: 1,
      oscVocMidiChannel: 9,
      oscVocOctave: -12,
      oscVocBands: 16,
      mix: 0.4,
    });
    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[1]!.input);
    expect((inputFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[3]!.input);
    expect((trackFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
  });

  it('routes future Web MIDI note timestamps to only configured OSC VOC slots', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();
    engine.setFxType('input', 0, 'OSC VOC (M)');
    engine.setFxType('input', 2, 'DSP LPF');
    engine.setFxType('track', 1, 'OSC VOC (M)');
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(3));

    const engineWithMidi = engine as unknown as {
      handleMidiNote(event: { channel: number; note: number; velocity: number; noteOn: boolean; timeStampMs: number }): void;
    };
    const eventTimestamp = performance.now() + 5;
    engineWithMidi.handleMidiNote({
      channel: 3,
      note: 69,
      velocity: 0.75,
      noteOn: true,
      timeStampMs: eventTimestamp,
    });

    const sentMessages = MockWorkletNode.instances.map((node) => node.port.postMessage.mock.calls
      .map(([message]) => message as { type?: string; channel?: number; note?: number; velocity?: number; frame?: number })
      .filter((message) => message.type === 'midi-note-on'));
    expect(sentMessages[0]).toHaveLength(1);
    expect(sentMessages[1]).toHaveLength(0);
    expect(sentMessages[2]).toHaveLength(1);
    const minimumLeadFrame = Math.ceil((2.25 + 0.02) * 48_000);
    const originalTimestampLimit = Math.ceil((2.25 + 0.025) * 48_000);
    expect(sentMessages[0]?.[0]).toMatchObject({
      channel: 3,
      note: 69,
      velocity: Math.round(0.75 * 127),
    });
    const inputFrame = sentMessages[0]?.[0]?.frame ?? 0;
    expect(inputFrame).toBeGreaterThanOrEqual(minimumLeadFrame);
    expect(inputFrame).toBeLessThanOrEqual(originalTimestampLimit);
    expect(sentMessages[2]?.[0]?.frame).toBe(inputFrame);
  });

  it('routes ROLL through both Input and shared Track A–D worklets with tempo and named controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    engine.setFxType('input', 1, 'ROLL');
    engine.setFxType('track', 3, 'ROLL');
    engine.setFxParam('input', 1, 45);
    engine.setFxNamedParameters('input', 1, {
      slice_beats: 1, decay_percent: 42, pitch_semitones: -12, direction: 2,
    });
    engine.setFxNamedParameters('track', 3, { bpm: 90 });

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map(({ options }) => options.processorOptions?.algorithm)).toEqual(['roll', 'roll']);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      bpm: 120,
      mix: 0.45,
      rollSliceBeats: 1,
      rollDecayPercent: 42,
      rollPitchSemitones: -12,
      rollDirection: 2,
    });
    expect(MockWorkletNode.instances[1]!.options.processorOptions?.parameters).toMatchObject({ bpm: 90 });
    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[1]!.input);
    expect((inputFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[3]!.input);
    expect((trackFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
  });

  it('routes FREEZE micro-loop controls through Browser Input and shared Track A–D', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    engine.setFxType('input', 0, 'FREEZE');
    engine.setFxType('track', 2, 'FREEZE');
    engine.setFxParam('input', 0, 70);
    engine.setFxNamedParameters('input', 0, {
      capture_ms: 420, mode: 0, pitch_semitones: -9, freeze: 1,
    });
    engine.setFxNamedParameters('track', 2, {
      capture_ms: 1000, mode: 0, pitch_semitones: 7, freeze: 0,
    });

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map(({ options }) => options.processorOptions?.algorithm)).toEqual(['freeze', 'freeze']);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      mix: 0.7,
      freezeCaptureLengthMs: 420,
      freezeMode: 0,
      freezePitchSemitones: -9,
      freezeEnabled: 1,
    });
    expect(MockWorkletNode.instances[1]!.options.processorOptions?.parameters).toMatchObject({
      freezeCaptureLengthMs: 1000,
      freezeMode: 0,
      freezePitchSemitones: 7,
      freezeEnabled: 0,
    });
    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[0]!.input);
    expect((inputFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[2]!.input);
    expect((trackFx[2]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
  });

  it('surfaces unsupported Browser spectral FREEZE configuration through engine status', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();
    engine.setFxType('input', 0, 'FREEZE');
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(1));

    engine.setFxNamedParameters('input', 0, { mode: 1 });

    expect(engine.getUiStatus().lastError).toBe(
      'Browser DSP FREEZE failed: Spectral FREEZE mode is unavailable; only micro-loop mode is wired.',
    );
  });

  it('routes GATE REVERB controls through both Browser A–D banks', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    engine.setFxType('input', 0, 'GATE REVERB');
    engine.setFxType('track', 0, 'GATE REVERB');
    engine.setFxParam('input', 0, 45);
    const inputEffect = (engine as unknown as {
      inputFxInstances: { setParam(key: string, value: number): void }[];
    }).inputFxInstances[0]!;
    inputEffect.setParam('decay', 3.2);
    inputEffect.setParam('threshold', -31);
    inputEffect.setParam('hold', 375);
    inputEffect.setParam('release', 225);

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(['gate-reverb', 'gate-reverb']);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      mix: 0.45,
      decaySeconds: 3.2,
      gateThresholdDb: -31,
      gateHoldMs: 375,
      gateReleaseMs: 225,
    });
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[0]!.input);
    expect((inputFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[0]!.input);
    expect((trackFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
  });

  it('routes SLOW GEAR through Input and shared Track A–D with provisional controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();

    for (let slot = 0; slot < 4; slot += 1) {
      engine.setFxType('input', slot, 'SLOW GEAR');
      engine.setFxType('track', slot, 'SLOW GEAR');
    }
    engine.setFxParam('input', 0, 50);
    const inputFxBeforeInstall = (engine as unknown as {
      inputFxInstances: { setParam(key: string, value: number): void }[];
    }).inputFxInstances[0]!;
    inputFxBeforeInstall.setParam('attack', 375);
    inputFxBeforeInstall.setParam('sensitivity', 80);

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(8));

    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(Array(8).fill('slow-gear'));
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      slowGearAttackMs: 375,
      slowGearSensitivityPercent: 80,
      mix: 0.5,
    });
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[0]!.input);
    expect((inputFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputFx[1]!.input);
    expect((inputFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputFx[2]!.input);
    expect((inputFx[2]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputFx[3]!.input);
    expect((inputFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[0]!.input);
    expect((trackFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackFx[1]!.input);
    expect((trackFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackFx[2]!.input);
    expect((trackFx[2]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackFx[3]!.input);
    expect((trackFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
  });

  it('routes PREAMP source #23 through input and shared track banks with model/tone controls', async () => {
    expect(FX_CATALOG_BY_ID.get('preamp')).toMatchObject({ sourceIndex: 23, displayName: 'PREAMP' });
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    engine.setFxType('input', 2, 'PREAMP');
    engine.setFxType('track', 1, 'PREAMP');
    engine.setFxNamedParameters('input', 2, {
      model: 3, gain: 48, bass: 4.5, middle: -2, treble: 6, level: -3, mix: 0.25,
    });

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(['preamp', 'preamp']);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      preampModel: 3,
      preampGainPercent: 48,
      preampBassDb: 4.5,
      preampMiddleDb: -2,
      preampTrebleDb: 6,
      preampLevelDb: -3,
    });
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).not.toHaveProperty('mix');

    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[2]!.input);
    expect((inputFx[2]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[1]!.input);
    expect((trackFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
  });

  it('installs VINYL FLICK through the real Track worklet path with neutral-center macro and track-only catalog scope', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, trackHead, trackTail } = makeEngine();
    engine.setFxType('track', 0, 'VINYL FLICK');
    engine.setFxParam('track', 0, 50);
    const effect = (engine as unknown as {
      trackFxInstances: { setParam(key: string, value: number): void }[];
    }).trackFxInstances[0]!;
    effect.setParam('return-time', 0.8);
    effect.setParam('brake', 65);

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(1));
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.algorithm).toBe('vinyl-flick');
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      vinylFlickSpeed: 0,
      mix: 0.5,
      vinylFlickReturnTimeSeconds: 0.8,
      vinylFlickBrakePercent: 65,
    });
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[0]!.input);
    expect((trackFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
    expect(FX_CATALOG_BY_ID.get('vinyl-flick')?.availability).toMatchObject({ input: false, track: true });
  });

  it('routes ISOLATOR through both A–D banks and preserves its band, gate and BPM controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();

    for (let slot = 0; slot < 4; slot += 1) {
      engine.setFxType('input', slot, 'ISOLATOR');
      engine.setFxType('track', slot, 'ISOLATOR');
    }
    engine.setFxParam('input', 0, 65);
    const inputFxBeforeInstall = (engine as unknown as {
      inputFxInstances: { setParam(key: string, value: number): void }[];
    }).inputFxInstances[0]!;
    inputFxBeforeInstall.setParam('low', -18);
    inputFxBeforeInstall.setParam('mid-gain', 3);
    inputFxBeforeInstall.setParam('gate-rate', 1);
    inputFxBeforeInstall.setParam('bpm', 132);

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(8));

    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode; setParam(key: string, value: number): void }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode }[] }).trackFxInstances;
    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(Array(8).fill('isolator'));
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      bpm: 132,
      isolatorLowGainDb: -18,
      isolatorMidGainDb: 3,
      isolatorGateRateBeats: 1,
      isolatorGateDepthPercent: 65,
    });
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[0]!.input);
    expect((inputFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[0]!.input);
    expect((trackFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);

    inputFx[0]!.setParam('high', 6);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { isolatorHighGainDb: 6 },
    });
  });

  it('applies the generic bank parameter and active state to the selected DSP instance', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 0, 'DSP LPF');
    engine.setFxParam('input', 0, 75);
    engine.setFxActive('input', 0, true);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(1));

    const node = MockWorkletNode.instances[0]!;
    expect(node.port.postMessage).toHaveBeenCalledWith({
      type: 'configure',
      parameters: { cutoffHz: 20 * (1000 ** 0.75) },
    });
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'set-bypass', value: false, rampFrames: 0 });
  });

  it('configures the oversampled distortion and fractional-delay flanger macros', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 0, 'DIST');
    engine.setFxParam('input', 0, 50);
    engine.setFxType('track', 0, 'FLANGER');
    engine.setFxParam('track', 0, 50);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'distortion', 'flanger',
    ]);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure',
      parameters: { driveDb: 18, outputDb: 0, mix: 0.5 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure',
      parameters: { flangerDepth: 0.5, mix: 0.5 },
    });
  });

  it('routes and configures the low-latency dynamics compressor in both banks', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 2, 'DYNAMICS');
    engine.setFxParam('input', 2, 50);
    engine.setFxType('track', 2, 'DYNAMICS');
    engine.setFxParam('track', 2, 50);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'dynamics', 'dynamics',
    ]);
    for (const node of MockWorkletNode.instances) {
      expect(node.port.postMessage).toHaveBeenCalledWith({
        type: 'configure',
        parameters: { thresholdDb: -18, ratio: 10.5, kneeDb: 6, attackMs: 10, releaseMs: 120, mix: 1 },
      });
    }
  });

  it('routes MOD DELAY into Browser Input and shared Track banks with smoothed fractional-delay controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();
    engine.setFxType('input', 1, 'MOD DELAY');
    engine.setFxType('track', 2, 'MOD DELAY');
    engine.setFxParam('input', 1, 50);
    const inputEffect = (engine as unknown as {
      inputFxInstances: { setParam(key: string, value: number): void }[];
    }).inputFxInstances[1]!;
    inputEffect.setParam('time', 750);
    inputEffect.setParam('rate', 1.25);
    inputEffect.setParam('depth', 18);
    inputEffect.setParam('feedback', 42);

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'mod-delay', 'mod-delay',
    ]);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      mix: 0.5,
      modDelayTimeMs: 750,
      modDelayRateHz: 1.25,
      modDelayDepthMs: 18,
      modDelayFeedbackPercent: 42,
    });
  });

  it('routes stereo-enhance through input and track A–D slots with normalized width controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 0, 'STEREO ENHANCE');
    engine.setFxParam('input', 0, 75);
    engine.setFxType('track', 3, 'STEREO ENHANCE');
    engine.setFxParam('track', 3, 25);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'stereo-enhance', 'stereo-enhance',
    ]);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure',
      parameters: { stereoWidth: 1.5 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure',
      parameters: { stereoWidth: 0.5 },
    });

    const trackFx = (engine as unknown as { trackFxInstances: { setParam(key: string, value: number): void }[] }).trackFxInstances[3]!;
    trackFx.setParam('width', 150);
    trackFx.setParam('low-mono-cutoff', 320);
    trackFx.setParam('decorrelation', 80);
    trackFx.setParam('mix', 100);
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { stereoWidth: 1.5 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { stereoLowMonoCutoffHz: 320 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { stereoDecorrelation: 0.8 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { mix: 1 },
    });
  });

  it('routes the preallocated fractional delay through the existing bank slot', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 1, 'DELAY');
    engine.setFxParam('input', 1, 50);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(1));

    expect(MockWorkletNode.instances[0]!.options.processorOptions?.algorithm).toBe('delay');
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure',
      parameters: { mix: 0.5 },
    });
  });

  it('routes and mixes the multi-voice chorus through a track-bank slot', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('track', 1, 'CHORUS');
    engine.setFxParam('track', 1, 50);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(1));

    expect(MockWorkletNode.instances[0]!.options.processorOptions?.algorithm).toBe('chorus');
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure',
      parameters: { mix: 0.5 },
    });
  });

  it('routes PHASER through both A–D banks as an all-pass worklet, not the legacy placeholder', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 0, 'PHASER');
    engine.setFxParam('input', 0, 50);
    engine.setFxType('track', 3, 'PHASER');
    engine.setFxParam('track', 3, 50);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'phaser', 'phaser',
    ]);
    for (const node of MockWorkletNode.instances) {
      expect(node.port.postMessage).toHaveBeenCalledWith({
        type: 'configure',
        parameters: { phaserDepth: 0.5, mix: 0.5 },
      });
    }
  });

  it('routes TREMOLO through input and shared track banks with an amplitude-depth macro', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 1, 'TREMOLO');
    engine.setFxParam('input', 1, 75);
    engine.setFxType('track', 2, 'TREMOLO');
    engine.setFxParam('track', 2, 25);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'tremolo', 'tremolo',
    ]);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure',
      parameters: { tremoloDepth: 0.75, mix: 1 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure',
      parameters: { tremoloDepth: 0.25, mix: 1 },
    });
  });

  it('routes AUTO PAN through input and shared track banks with an equal-power pan-depth macro', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 3, 'AUTO PAN');
    engine.setFxParam('input', 3, 40);
    engine.setFxType('track', 0, 'AUTO PAN');
    engine.setFxParam('track', 0, 80);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'auto-pan', 'auto-pan',
    ]);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure',
      parameters: { autoPanDepth: 0.4, mix: 1 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure',
      parameters: { autoPanDepth: 0.8, mix: 1 },
    });
  });

  it('routes clean-room Lo-Fi to input and shared track slots with a bounded mix macro', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 1, 'LO-FI');
    engine.setFxParam('input', 1, 75);
    engine.setFxType('track', 2, 'LO-FI');
    engine.setFxParam('track', 2, 25);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(['lo-fi', 'lo-fi']);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { mix: 0.75 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { mix: 0.25 },
    });
  });

  it('routes four-band EQ to input and shared track slots with a flat-to-tilt macro', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 0, 'EQ');
    engine.setFxParam('input', 0, 75);
    engine.setFxType('track', 3, 'EQ');
    engine.setFxParam('track', 3, 25);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(['eq', 'eq']);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { eqLowGainDb: 9, eqHighGainDb: -9, mix: 1 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { eqLowGainDb: 3, eqHighGainDb: -3, mix: 1 },
    });
  });

  it('routes TWIST through Browser Input and shared Track A–D banks with signed macro controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail } = makeEngine();

    engine.setFxType('input', 1, 'TWIST');
    engine.setFxType('track', 2, 'TWIST');
    engine.setFxParam('input', 1, 75); // Generic 75% maps to +50 signed amount.
    engine.setFxParam('track', 2, 25); // Generic 25% maps to -50 signed amount.
    engine.setFxNamedParameters('input', 1, { trajectory: 1, mix_percent: 80 });
    engine.setFxNamedParameters('track', 2, { trajectory: 3, mix_percent: 35 });

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'twist', 'twist',
    ]);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      twistAmount: 50, twistTrajectory: 1, mix: 0.8,
    });
    expect(MockWorkletNode.instances[1]!.options.processorOptions?.parameters).toMatchObject({
      twistAmount: -50, twistTrajectory: 3, mix: 0.35,
    });

    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode; setParam(key: string, value: number): void }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode; setParam(key: string, value: number): void }[] }).trackFxInstances;
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[1]!.input);
    expect((inputFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[2]!.input);
    expect((trackFx[2]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);

    inputFx[1]!.setParam('twist.amount', -25);
    trackFx[2]!.setParam('trajectory', 2);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { twistAmount: -25 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { twistTrajectory: 2 },
    });
  });

  it('routes experimental WARP through Input A and shared Track D with tempo, granular controls, and no spectral mode', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail } = makeEngine();

    engine.setFxType('input', 0, 'WARP (EXPERIMENTAL)');
    engine.setFxType('track', 3, 'WARP (EXPERIMENTAL)');
    engine.setFxParam('input', 0, 75);
    engine.setFxParam('track', 3, 45);
    engine.setFxNamedParameters('input', 0, { capture: 0.5, smear: 45, pitch: 7, feedback: 67, freeze: 1 });
    engine.setFxNamedParameters('track', 3, { capture: 2, smear: 80, pitch: -12, feedback: 92, freeze: 0 });

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(['warp', 'warp']);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({
      bpm: expect.any(Number), warpCaptureBeats: 0.5, warpSmearPercent: 45,
      warpPitchSemitones: 7, warpFeedbackPercent: 67, warpFreezeEnabled: 1, mix: 0.75,
    });
    expect(MockWorkletNode.instances[1]!.options.processorOptions?.parameters).toMatchObject({
      bpm: expect.any(Number), warpCaptureBeats: 2, warpSmearPercent: 80,
      warpPitchSemitones: -12, warpFeedbackPercent: 92, warpFreezeEnabled: 0, mix: 0.45,
    });

    const inputFx = (engine as unknown as { inputFxInstances: { input: AudioNode; output: AudioNode; setParam(key: string, value: number): void }[] }).inputFxInstances;
    const trackFx = (engine as unknown as { trackFxInstances: { input: AudioNode; output: AudioNode; setParam(key: string, value: number): void }[] }).trackFxInstances;
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[0]!.input);
    expect((inputFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[3]!.input);
    expect((trackFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);

    inputFx[0]!.setParam('mode', 1);
    expect((engine as unknown as { lastError: string }).lastError)
      .toContain('WARP spectral mode is unavailable');
    expect(MockWorkletNode.instances[0]!.port.postMessage).not.toHaveBeenCalledWith({
      type: 'configure', parameters: { mode: 1 },
    });
    inputFx[0]!.setParam('warp.feedback', 40);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { warpFeedbackPercent: 40 },
    });

    const transport = Transport.getInstance();
    const originalBpm = transport.bpm;
    transport.bpm = 137;
    (engine as unknown as { handleTransportBpmChange(): void }).handleTransportBpmChange();
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { bpm: 137 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { bpm: 137 },
    });
    transport.bpm = originalBpm;
  });

  it('routes MANUAL PAN to both banks with the generic amount mapped to a static position', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 1, 'MANUAL PAN');
    engine.setFxParam('input', 1, 75);
    engine.setFxType('track', 2, 'MANUAL PAN');
    engine.setFxParam('track', 2, 25);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(['manual-pan', 'manual-pan']);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { manualPanPosition: 0.5, mix: 1 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { manualPanPosition: -0.5, mix: 1 },
    });
  });

  it('routes TAPE ECHO to both banks and maps its provisional controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 1, 'TAPE ECHO');
    engine.setFxParam('input', 1, 60);
    engine.setFxType('track', 2, 'TAPE ECHO');
    engine.setFxParam('track', 2, 20);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'tape-echo', 'tape-echo',
    ]);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { mix: 0.6 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { mix: 0.2 },
    });

    const inputFx = (engine as unknown as { inputFxInstances: { setParam(key: string, value: number): void }[] }).inputFxInstances[1]!;
    inputFx.setParam('time', 500);
    inputFx.setParam('feedback', 40);
    inputFx.setParam('wow-flutter', 25);
    inputFx.setParam('saturation', 60);
    inputFx.setParam('tone_hz', 7000);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { tapeEchoTimeMs: 500 },
    });
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { tapeEchoFeedback: 40 },
    });
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { tapeEchoWow: 25 },
    });
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { tapeEchoSaturation: 60 },
    });
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { tapeEchoToneHz: 7000 },
    });
  });

  it('routes PANNING DELAY to Input and shared Track banks with amount and custom controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 0, 'PANNING DELAY');
    engine.setFxParam('input', 0, 60);
    engine.setFxType('track', 3, 'PANNING DELAY');
    engine.setFxParam('track', 3, 30);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'panning-delay', 'panning-delay',
    ]);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { mix: 0.6 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { mix: 0.3 },
    });

    const inputFx = (engine as unknown as { inputFxInstances: { setParam(key: string, value: number): void }[] }).inputFxInstances[0]!;
    inputFx.setParam('time', 420);
    inputFx.setParam('feedback', 45);
    inputFx.setParam('pan', -35);
    inputFx.setParam('mix', 25);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { panningDelayTimeMs: 420 },
    });
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { panningDelayFeedback: 45 },
    });
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { panningDelayPan: -35 },
    });
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { mix: 0.25 },
    });
  });

  it('routes GRANULAR DELAY through input and shared Track A–D slots with all grain controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();

    engine.setFxType('input', 1, 'GRANULAR DELAY');
    engine.setFxParam('input', 1, 45);
    engine.setFxType('track', 3, 'GRANULAR DELAY');
    engine.setFxParam('track', 3, 70);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));

    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual([
      'granular-delay', 'granular-delay',
    ]);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { mix: 0.45 },
    });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { mix: 0.7 },
    });

    const inputFx = (engine as unknown as { inputFxInstances: { setParam(key: string, value: number): void }[] }).inputFxInstances[1]!;
    inputFx.setParam('grain-size', 320);
    inputFx.setParam('density', 27);
    inputFx.setParam('pitch', -7);
    inputFx.setParam('jitter', 85);
    inputFx.setParam('feedback', 40);
    inputFx.setParam('mix', 55);
    for (const [key, value] of [
      ['granularGrainSizeMs', 320],
      ['granularDensityHz', 27],
      ['granularPitchSemitones', -7],
      ['granularPositionJitterPercent', 85],
      ['granularFeedbackPercent', 40],
      ['mix', 0.55],
    ] as const) {
      expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
        type: 'configure', parameters: { [key]: value },
      });
    }
  });

  it('routes RADIO through input and shared Track A–D slots with band, drive, noise and mix controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();
    engine.setFxType('input', 0, 'RADIO');
    engine.setFxType('track', 2, 'RADIO');
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(['radio', 'radio']);

    const inputFx = (engine as unknown as { inputFxInstances: { setParam(key: string, value: number): void }[] }).inputFxInstances[0]!;
    const trackFx = (engine as unknown as { trackFxInstances: { setParam(key: string, value: number): void }[] }).trackFxInstances[2]!;
    inputFx.setParam('band', 2);
    inputFx.setParam('drive', 81);
    inputFx.setParam('noise', 23);
    inputFx.setParam('mix', 44);
    trackFx.setParam('band', 1);
    trackFx.setParam('drive', 55);
    trackFx.setParam('noise', 10);
    trackFx.setParam('mix', 67);
    for (const [instance, expected] of [
      [MockWorkletNode.instances[0]!, { radioBand: 2, radioDrive: 81, radioNoise: 23, mix: 0.44 }],
      [MockWorkletNode.instances[1]!, { radioBand: 1, radioDrive: 55, radioNoise: 10, mix: 0.67 }],
    ] as const) {
      for (const [key, value] of Object.entries(expected)) {
        expect(instance.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { [key]: value } });
      }
    }
  });

  it('routes SUSTAINER through Input and every shared Track A–D slot with its four controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();
    engine.setFxType('input', 0, 'SUSTAINER');
    for (let slot = 0; slot < 4; slot += 1) engine.setFxType('track', slot, 'SUSTAINER');
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(5));
    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(Array(5).fill('sustainer'));

    const inputFx = (engine as unknown as { inputFxInstances: { setParam(key: string, value: number): void }[] }).inputFxInstances[0]!;
    const trackFx = (engine as unknown as { trackFxInstances: { setParam(key: string, value: number): void }[] }).trackFxInstances;
    inputFx.setParam('threshold', -31);
    inputFx.setParam('ratio', 8);
    inputFx.setParam('release', 640);
    inputFx.setParam('output', 5);
    trackFx[3]!.setParam('threshold_db', -18);
    trackFx[3]!.setParam('release_ms', 42);
    for (const [instance, expected] of [
      [MockWorkletNode.instances[0]!, { thresholdDb: -31, ratio: 8, releaseMs: 640, outputDb: 5 }],
      [MockWorkletNode.instances[4]!, { thresholdDb: -18, releaseMs: 42 }],
    ] as const) {
      for (const [key, value] of Object.entries(expected)) {
        expect(instance.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { [key]: value } });
      }
    }
  });

  it('routes VIBRATO through input and shared Track A–D slots with LFO and delay controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine } = makeEngine();
    engine.setFxType('input', 0, 'VIBRATO');
    engine.setFxType('track', 3, 'VIBRATO');
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(['vibrato', 'vibrato']);

    const inputFx = (engine as unknown as { inputFxInstances: { setParam(key: string, value: number): void }[] }).inputFxInstances[0]!;
    const trackFx = (engine as unknown as { trackFxInstances: { setParam(key: string, value: number): void }[] }).trackFxInstances[3]!;
    inputFx.setParam('rate', 11.5);
    inputFx.setParam('depth', 85);
    inputFx.setParam('delay', 7.2);
    inputFx.setParam('mix', 65);
    trackFx.setParam('rate', 0.25);
    trackFx.setParam('depth', 20);
    trackFx.setParam('delay', 1.5);
    trackFx.setParam('mix', 100);
    for (const [instance, expected] of [
      [MockWorkletNode.instances[0]!, { vibratoRateHz: 11.5, vibratoDepthPercent: 85, vibratoDelayMs: 7.2, mix: 0.65 }],
      [MockWorkletNode.instances[1]!, { vibratoRateHz: 0.25, vibratoDepthPercent: 20, vibratoDelayMs: 1.5, mix: 1 }],
    ] as const) {
      for (const [key, value] of Object.entries(expected)) {
        expect(instance.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { [key]: value } });
      }
    }
  });
});
