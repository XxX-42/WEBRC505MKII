import { afterEach, describe, expect, it, vi } from 'vitest';

const pitchHarness = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../../src/audio/pitch/signalsmith', () => ({
  createLiveInputTransposeNode: pitchHarness.create,
}));

import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserRobotFX } from '../../src/audio/fx/BrowserRobotFX';

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

function makePitchNode(latencySeconds = 0.024) {
  return Object.assign(new MockAudioNode(), {
    latencySeconds,
    latencySamples: Math.round(latencySeconds * 48_000),
    setPitch: vi.fn(async (
      _semitones: number,
      _outputTime?: number,
      _replaceFuture?: boolean,
      _formantSemitones?: number,
      _formantBaseHz?: number,
      _formantCompensation?: boolean,
    ) => undefined),
  });
}

function getGain(node: AudioNode): MockGainNode { return node as unknown as MockGainNode; }

function deliverTarget(node: MockWorkletNode, message: Record<string, unknown>): void {
  node.port.onmessage?.({ data: { type: 'robot-pitch-target', ...message } } as MessageEvent<unknown>);
}

function deliverMode(node: MockWorkletNode, message: Record<string, unknown>): void {
  node.port.onmessage?.({ data: { type: 'robot-mode', ...message } } as MessageEvent<unknown>);
}

function makeEngine(): BrowserAudioEngine {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  Object.assign(engine, {
    context: makeContext(),
    inputFxChain: { input: new MockAudioNode(), output: new MockAudioNode() },
    outputFxChain: { input: new MockAudioNode(), output: new MockAudioNode() },
    trackMixNode: new MockAudioNode(),
    currentInputStream: null,
    inputFxInstances: [null, null, null, null],
    trackFxInstances: [null, null, null, null],
    inputFxTypes: [null, null, null, null],
    inputFxActive: [false, false, false, false],
    trackFxTypes: [null, null, null, null],
    fxWorkletModuleReady: null,
    lastError: '',
    statusListeners: new Set(),
  });
  return engine;
}

describe('Browser ROBOT FX adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    pitchHarness.create.mockReset();
    MockWorkletNode.instances = [];
  });

  it('schedules ordered frame-stamped pitch plus formant targets and uses aligned dry/wet routing', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const shifter = makePitchNode();
    pitchHarness.create.mockResolvedValue(shifter);
    const fx = new BrowserRobotFX(makeContext(), async () => undefined);
    await fx.ready;
    const analyzer = MockWorkletNode.instances[0]!;
    expect(analyzer.options.processorOptions).toMatchObject({
      algorithm: 'robot',
      sampleRate: 48_000,
      parameters: { robotPitch: 0, robotFormantSemitones: 0 },
      bypassed: true,
    });
    expect((fx as unknown as { dryDelay: MockDelayNode }).dryDelay.delayTime.value).toBe(0.0295);
    expect((fx as unknown as { wetDelay: MockDelayNode }).wetDelay.delayTime.value).toBeCloseTo(0.0055, 8);
    expect((fx as unknown as { psolaDelay: MockDelayNode }).psolaDelay.delayTime.value).toBe(0);
    expect(fx.psolaLatencySamples).toBe(1_416);
    expect(fx.signalsmithLatencySamples).toBe(1_152);
    expect(fx.latencySamples).toBe(1_416);
    const directGain = getGain((fx as unknown as { directGain: AudioNode }).directGain);
    const dryGain = getGain((fx as unknown as { dryGain: AudioNode }).dryGain);
    const wetGain = getGain((fx as unknown as { wetGain: AudioNode }).wetGain);
    const psolaGain = getGain((fx as unknown as { psolaGain: AudioNode }).psolaGain);

    fx.setParam('robot.mix', 40);
    fx.setParam('robot.formant', 3.5);
    fx.setBypass(false);
    shifter.setPitch.mockClear(); // discard the zero-target reset scheduled at reactivation
    const sourceMidi = 60.1;
    const sourceHz = 440 * (2 ** ((sourceMidi - 69) / 12));
    deliverTarget(analyzer, {
      frame: 96_000, semitones: 61 - sourceMidi, sourceMidi, targetMidi: 61,
      sourceHz, confidence: 0.92, voiced: true,
    });
    expect(shifter.setPitch).toHaveBeenCalledTimes(1);
    expect(shifter.setPitch).toHaveBeenLastCalledWith(61 - sourceMidi, 2.024, false, 3.5, sourceHz, true);
    expect(directGain.gain.value).toBe(0);
    expect(dryGain.gain.value).toBeCloseTo(0.6, 8);
    expect(wetGain.gain.value).toBeCloseTo(0.4, 8);
    expect(psolaGain.gain.value).toBe(0);

    deliverTarget(analyzer, {
      frame: 96_256, semitones: 61 - (sourceMidi + 0.02), sourceMidi: sourceMidi + 0.02, targetMidi: 61,
      sourceHz: sourceHz * (2 ** (0.02 / 12)), confidence: 0.91, voiced: true,
    });
    expect(shifter.setPitch).toHaveBeenCalledTimes(2);
    const firstSchedule = shifter.setPitch.mock.calls[0]?.[1] ?? 0;
    const secondSchedule = shifter.setPitch.mock.calls[1]?.[1] ?? 0;
    expect(secondSchedule).toBeGreaterThan(firstSchedule);
    expect(shifter.setPitch.mock.calls[1]).toEqual([
      61 - (sourceMidi + 0.02), 96_256 / 48_000 + 0.024, false,
      3.5, sourceHz * (2 ** (0.02 / 12)), true,
    ]);

    deliverMode(analyzer, {
      frame: 96_256, mode: 'signalsmith', reason: 'formant-control-active',
      trackerLatencyFrames: 1_880, psolaLatencySamples: 1_416,
    });
    expect(fx.processingMode).toBe('signalsmith');
    expect(fx.processingModeReason).toBe('formant-control-active');
    fx.setParam('robot.formant', 0);
    deliverMode(analyzer, {
      frame: 96_512, mode: 'psola', reason: 'stable-voiced',
      trackerLatencyFrames: 1_880, psolaLatencySamples: 1_416,
    });
    expect(fx.processingMode).toBe('psola');
    expect(wetGain.gain.value).toBe(0);
    expect(psolaGain.gain.value).toBeCloseTo(0.4, 8);

    fx.setBypass(true);
    expect(directGain.gain.value).toBe(1);
    expect(dryGain.gain.value).toBe(0);
    expect(wetGain.gain.value).toBe(0);
    expect(psolaGain.gain.value).toBe(0);

    deliverTarget(analyzer, {
      frame: 96_512, semitones: 0, sourceMidi: 0, targetMidi: 0,
      sourceHz: 0, confidence: 0, voiced: false,
    });
    expect(shifter.setPitch).toHaveBeenCalledTimes(2);
    expect(dryGain.gain.value).toBe(0);
    expect(wetGain.gain.value).toBe(0);
    fx.dispose();
  });

  it('maps catalog parameters through exact Input and Track ROBOT instances and rejects unknown controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const inputNode = makePitchNode();
    const trackNode = makePitchNode();
    pitchHarness.create.mockResolvedValueOnce(inputNode).mockResolvedValueOnce(trackNode);
    const engine = makeEngine();
    engine.setFxType('input', 1, 'ROBOT (EXPERIMENTAL)');
    engine.setFxType('track', 2, 'ROBOT');
    const inputFx = (engine as unknown as { inputFxInstances: Array<BrowserRobotFX | null> }).inputFxInstances[1]!;
    const trackFx = (engine as unknown as { trackFxInstances: Array<BrowserRobotFX | null> }).trackFxInstances[2]!;
    await Promise.all([inputFx.ready, trackFx.ready]);
    expect(inputFx).toBeInstanceOf(BrowserRobotFX);
    expect((engine as unknown as { inputFxTypes: Array<string | null> }).inputFxTypes[1]).toBe('ROBOT (EXPERIMENTAL)');
    expect((engine as unknown as { lastError: string }).lastError).toBe('');

    engine.setFxNamedParameters('input', 1, { pitch_semitones: 12, formant_semitones: -4, mix_percent: 55 });
    engine.setFxNamedParameters('track', 2, { pitch_semitones: -7, formant_semitones: 2, mix_percent: 25 });
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { robotPitch: 12 } });
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { robotFormantSemitones: -4 } });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { robotPitch: -7 } });
    expect(MockWorkletNode.instances[1]!.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { robotFormantSemitones: 2 } });
    expect((inputFx as unknown as { mix: number }).mix).toBe(0.55);
    expect((trackFx as unknown as { mix: number }).mix).toBe(0.25);
    expect(inputFx.error).toBe('');
    expect(trackFx.error).toBe('');
    expect((engine as unknown as { inputFxChain: { input: MockAudioNode } }).inputFxChain.input.connect)
      .toHaveBeenCalledWith(inputFx.input);
    expect((engine as unknown as { trackFxInstances: BrowserRobotFX[] }).trackFxInstances[2]!.output.connect)
      .toHaveBeenCalledWith((engine as unknown as { outputFxChain: { output: MockAudioNode } }).outputFxChain.output);

    inputFx.setBypass(false);
    inputNode.setPitch.mockClear();
    inputFx.setParam('robot.unknown', 1);
    expect(inputFx.error).toContain('does not support the robot.unknown parameter');
    expect(getGain((inputFx as unknown as { directGain: AudioNode }).directGain).gain.value).toBe(1);
    expect(inputNode.setPitch).not.toHaveBeenCalled();
    inputFx.dispose();
    trackFx.dispose();
  });
});
