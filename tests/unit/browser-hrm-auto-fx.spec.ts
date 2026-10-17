import { afterEach, describe, expect, it, vi } from 'vitest';

const pitchHarness = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../../src/audio/pitch/signalsmith', () => ({
  createLiveInputTransposeNode: pitchHarness.create,
}));

import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserHrmAutoFX } from '../../src/audio/fx/BrowserHrmAutoFX';

class MockAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class MockGainNode extends MockAudioNode {
  readonly gain = {
    value: 1,
    setTargetAtTime: vi.fn((value: number) => { this.gain.value = value; }),
  };
}

class MockDelayNode extends MockAudioNode {
  readonly delayTime = { value: 0 };
}

class MockWorkletNode extends MockAudioNode {
  static instances: MockWorkletNode[] = [];
  readonly port = {
    postMessage: vi.fn(),
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  };

  constructor(
    readonly context: BaseAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    super();
    MockWorkletNode.instances.push(this);
  }
}

function makeContext(): AudioContext {
  return {
    currentTime: 2,
    sampleRate: 48_000,
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createGain: () => new MockGainNode(),
    createDelay: () => new MockDelayNode(),
  } as unknown as AudioContext;
}

function makePitchNode(latencySeconds = 0.02) {
  return Object.assign(new MockAudioNode(), {
    latencySeconds,
    latencySamples: Math.round(latencySeconds * 48_000),
    setPitch: vi.fn(async (_semitones: number, _outputTime?: number, _replaceFuture?: boolean) => undefined),
  });
}

function getGain(node: AudioNode): MockGainNode {
  return node as unknown as MockGainNode;
}

function deliverTarget(node: MockWorkletNode, message: Record<string, unknown>): void {
  node.port.onmessage?.({ data: { type: 'hrm-auto-target', ...message } } as MessageEvent<unknown>);
}

function makeEngine() {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const inputHead = new MockAudioNode();
  const inputTail = new MockAudioNode();
  const trackHead = new MockAudioNode();
  const trackTail = new MockAudioNode();
  const trackMix = new MockAudioNode();
  Object.assign(engine, {
    context: makeContext(),
    inputFxChain: { input: inputHead, output: inputTail },
    outputFxChain: { input: trackHead, output: trackTail },
    trackMixNode: trackMix,
    currentInputStream: null,
    inputFxInstances: [null, null, null, null],
    trackFxInstances: [null, null, null, null],
    inputFxTypes: [null, null, null, null],
    trackFxTypes: [null, null, null, null],
    fxWorkletModuleReady: null,
    lastError: '',
    statusListeners: new Set(),
    midiInput: { connect: vi.fn(async () => 'connected'), disconnect: vi.fn() },
  });
  return engine;
}

describe('Browser HRM AUTO FX adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    pitchHarness.create.mockReset();
    MockWorkletNode.instances = [];
  });

  it('installs the analysis worklet and two Signalsmith voices with latency-aligned dry routing', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const first = makePitchNode(0.02);
    const second = makePitchNode(0.024);
    pitchHarness.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const fx = new BrowserHrmAutoFX(makeContext(), async () => undefined);
    await fx.ready;

    const analyzer = MockWorkletNode.instances[0]!;
    const dryDelay = (fx as unknown as { dryDelay: MockDelayNode }).dryDelay;
    const align = (fx as unknown as { voiceAlignmentDelays: [MockDelayNode, MockDelayNode] }).voiceAlignmentDelays;
    const directGain = getGain((fx as unknown as { directGain: AudioNode }).directGain);
    const dryGain = getGain((fx as unknown as { dryGain: AudioNode }).dryGain);
    const voiceGains = (fx as unknown as { voiceGains: [GainNode, GainNode] }).voiceGains;

    expect(analyzer.name).toBe('rc505-fx-processor');
    expect(analyzer.options.processorOptions).toMatchObject({
      algorithm: 'hrm-auto',
      sampleRate: 48_000,
      parameters: { hrmAutoKey: 0, hrmAutoScale: 0, hrmAutoMidiChannel: 1, hrmAutoMixPercent: 70 },
      bypassed: true,
    });
    expect(dryDelay.delayTime.value).toBe(0.024);
    expect(align[0].delayTime.value).toBeCloseTo(0.004, 8);
    expect(align[1].delayTime.value).toBe(0);
    expect(fx.latencySamples).toBe(1152);
    expect(fx.input.connect).toHaveBeenCalledWith(analyzer);
    expect(analyzer.connect).toHaveBeenCalledWith(dryDelay);
    expect(analyzer.connect).toHaveBeenCalledWith(first);
    expect(analyzer.connect).toHaveBeenCalledWith(second);
    expect(directGain.gain.value).toBe(1);

    fx.setParam('mix', 60);
    fx.setBypass(false);
    expect(directGain.gain.value).toBe(0);
    expect(dryGain.gain.value).toBe(1); // no held MIDI target means aligned dry only
    expect(getGain(voiceGains[0]).gain.value).toBe(0);
    expect(getGain(voiceGains[1]).gain.value).toBe(0);
    fx.dispose();
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(second.disconnect).toHaveBeenCalledOnce();
  });

  it('schedules target shifts at absolute frames plus each voice latency and applies dry/wet mix', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const first = makePitchNode(0.02);
    const second = makePitchNode(0.024);
    pitchHarness.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const fx = new BrowserHrmAutoFX(makeContext(), async () => undefined);
    await fx.ready;
    fx.setBypass(false);
    fx.setParam('mix', 60);
    const analyzer = MockWorkletNode.instances[0]!;
    deliverTarget(analyzer, { frame: 96_000, reason: 1, note: 60, noteOn: true, activeNoteCount: 1, voiceCount: 2, target1: 4, target2: 7 });

    expect(first.setPitch).toHaveBeenCalledWith(4, 2.02, false);
    expect(second.setPitch).toHaveBeenCalledWith(7, 2.024, false);
    expect(getGain((fx as unknown as { dryGain: AudioNode }).dryGain).gain.value).toBeCloseTo(0.4, 8);
    const voiceGains = (fx as unknown as { voiceGains: [GainNode, GainNode] }).voiceGains;
    expect(getGain(voiceGains[0]).gain.value).toBeCloseTo(0.3, 8);
    expect(getGain(voiceGains[1]).gain.value).toBeCloseTo(0.3, 8);

    deliverTarget(analyzer, { frame: 100_000, reason: 2, note: 60, noteOn: false, activeNoteCount: 1, voiceCount: 1, target1: 5, target2: -128 });
    expect(first.setPitch).toHaveBeenLastCalledWith(5, 100_000 / 48_000 + 0.02, false);
    expect(getGain(voiceGains[0]).gain.value).toBeCloseTo(0.6, 8);
    expect(getGain(voiceGains[1]).gain.value).toBe(0);

    deliverTarget(analyzer, { frame: 101_000, reason: 2, note: 60, noteOn: false, activeNoteCount: 0, voiceCount: 0, target1: -128, target2: -128 });
    expect(getGain((fx as unknown as { dryGain: AudioNode }).dryGain).gain.value).toBe(1);
    expect(getGain(voiceGains[0]).gain.value).toBe(0);
    expect(getGain(voiceGains[1]).gain.value).toBe(0);
    fx.dispose();
  });

  it('validates catalog controls and fails closed for malformed targets or unavailable pitch runtime', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const first = makePitchNode();
    const second = makePitchNode();
    pitchHarness.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const onFailure = vi.fn();
    const fx = new BrowserHrmAutoFX(makeContext(), async () => undefined, onFailure);
    await fx.ready;
    fx.setBypass(false);
    fx.setParam('key', 12);
    expect(fx.error).toContain('key must be an integer');
    expect(getGain((fx as unknown as { directGain: AudioNode }).directGain).gain.value).toBe(1);
    fx.setParam('key', 7);
    expect(fx.error).toBe('');
    const analyzer = MockWorkletNode.instances[0]!;
    deliverTarget(analyzer, { frame: 96_000, voiceCount: 2, target1: 25, target2: 7 });
    expect(fx.error).toContain('out-of-range pitch target');
    expect(onFailure).toHaveBeenCalled();
    fx.dispose();

    pitchHarness.create.mockRejectedValueOnce(new Error('Signalsmith unavailable'));
    const unavailable = new BrowserHrmAutoFX(makeContext(), async () => undefined, onFailure);
    await unavailable.ready;
    expect(unavailable.error).toContain('Signalsmith unavailable');
    expect(getGain((unavailable as unknown as { directGain: AudioNode }).directGain).gain.value).toBe(1);
    unavailable.dispose();
  });

  it('routes MIDI only after explicit exact-slot connection and preserves OSC routing', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const pitches = [makePitchNode(), makePitchNode(), makePitchNode(), makePitchNode()];
    pitches.forEach((node) => pitchHarness.create.mockResolvedValueOnce(node));
    const engine = makeEngine();
    engine.setFxType('input', 0, 'HRM AUTO (M)');
    engine.setFxType('track', 1, 'HRM AUTO (M)');
    const inputFx = (engine as unknown as { inputFxInstances: Array<BrowserHrmAutoFX | null> }).inputFxInstances[0]!;
    const trackFx = (engine as unknown as { trackFxInstances: Array<BrowserHrmAutoFX | null> }).trackFxInstances[1]!;
    await Promise.all([inputFx.ready, trackFx.ready]);

    const handle = (engine as unknown as { handleMidiNote: (event: { channel: number; note: number; velocity: number; noteOn: boolean; timeStampMs: number }) => void }).handleMidiNote.bind(engine);
    handle({ channel: 2, note: 67, velocity: 0.75, noteOn: true, timeStampMs: 0 });
    const midiMessages = (index: number) => MockWorkletNode.instances[index]!.port.postMessage.mock.calls.filter(([message]) =>
      typeof message === 'object' && message !== null && 'type' in message && (message as { type: string }).type.startsWith('midi-note'));
    expect(midiMessages(0)).toHaveLength(0);
    expect(midiMessages(1)).toHaveLength(0);

    await engine.connectMidiInput({ path: 'track', slot: 'B', effectId: 'hrm_auto_m' });
    handle({ channel: 2, note: 67, velocity: 0.75, noteOn: true, timeStampMs: 0 });
    expect(midiMessages(0)).toHaveLength(0);
    expect(midiMessages(1)).toHaveLength(1);
    expect(midiMessages(1)[0]?.[0]).toMatchObject({
      type: 'midi-note-on', channel: 2, note: 67, velocity: 95, frame: 96_960,
    });

    await engine.connectMidiInput({ path: 'input', slot: 'A', effectId: 'hrm_auto_m' });
    handle({ channel: 2, note: 67, velocity: 0, noteOn: false, timeStampMs: 0 });
    expect(midiMessages(0)).toHaveLength(1);
    expect(midiMessages(0)[0]?.[0]).toMatchObject({ type: 'midi-note-off', channel: 2, note: 67 });
    expect(midiMessages(1)).toHaveLength(1);
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({ type: 'reset' });

    await engine.connectMidiInput({ path: 'track', slot: 'B', effectId: 'osc_voc_m' });
    handle({ channel: 2, note: 68, velocity: 0.5, noteOn: true, timeStampMs: 0 });
    expect(midiMessages(0)).toHaveLength(1);
    expect(midiMessages(1)).toHaveLength(1);
    inputFx.dispose();
    trackFx.dispose();
  });
});
