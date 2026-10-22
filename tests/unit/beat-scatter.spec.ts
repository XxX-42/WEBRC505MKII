import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';

class MockAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
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

function makeEngine(): BrowserAudioEngine {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const context = {
    sampleRate: 48000,
    audioWorklet: { addModule: vi.fn(async (_url: string) => undefined) },
    createGain: () => new MockAudioNode(),
  } as unknown as AudioContext;
  Object.assign(engine, {
    context,
    inputFxChain: { input: new MockAudioNode(), output: new MockAudioNode() },
    outputFxChain: { input: new MockAudioNode(), output: new MockAudioNode() },
    trackMixNode: new MockAudioNode(),
    inputFxInstances: [null, null, null, null],
    trackFxInstances: [null, null, null, null],
    inputFxTypes: [null, null, null, null],
    inputFxActive: [false, false, false, false],
    trackFxTypes: [null, null, null, null],
    fxWorkletModuleReady: null,
    fxWorkletGeneration: 0,
    statusListeners: new Set(),
    currentInputStream: null,
  });
  return engine;
}

function render(
  core: BrowserFxDspCore,
  left: Float32Array,
  right: Float32Array,
  blocks: readonly number[],
): [Float32Array, Float32Array] {
  const outputLeft = new Float32Array(left.length);
  const outputRight = new Float32Array(right.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < left.length) {
    const requested = blocks[blockIndex % blocks.length] ?? left.length;
    const count = Math.min(requested, left.length - offset);
    core.processBlock(
      left.subarray(offset, offset + count),
      right.subarray(offset, offset + count),
      outputLeft.subarray(offset, offset + count),
      outputRight.subarray(offset, offset + count),
      count,
    );
    offset += count;
    blockIndex += 1;
  }
  return [outputLeft, outputRight];
}

function createStereoSlices(frames: number): [Float32Array, Float32Array] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const grain = Math.floor((frame % 1000) / 250);
    const withinGrain = (frame % 250) / 250;
    left[frame] = (grain + 1) * 0.12 + 0.03 * withinGrain;
    right[frame] = -((grain + 1) * 0.08) - 0.02 * withinGrain;
  }
  return [left, right];
}

describe('Browser BEAT SCATTER (catalog source ID 50)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWorkletNode.instances = [];
  });

  it('rejects Input assignment and routes a bypassed Worklet into the Track A–D bank', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const engine = makeEngine();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    engine.setFxType('input', 0, 'BEAT SCATTER');
    expect(warn).toHaveBeenCalledWith('BEAT SCATTER is available only in the Browser Track FX bank.');
    expect((engine as unknown as { inputFxInstances: unknown[] }).inputFxInstances[0]).toBeNull();
    expect(MockWorkletNode.instances).toHaveLength(0);

    for (let slot = 0; slot < 4; slot += 1) engine.setFxType('track', slot, 'BEAT SCATTER');
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(4));
    const node = MockWorkletNode.instances[2]!;
    expect(MockWorkletNode.instances.map((instance) => instance.options.processorOptions?.algorithm))
      .toEqual(Array(4).fill('beat-scatter'));
    expect((engine as unknown as { trackFxTypes: Array<string | null> }).trackFxTypes)
      .toEqual(Array(4).fill('BEAT SCATTER'));
    expect(node.options.processorOptions?.algorithm).toBe('beat-scatter');
    expect(node.options.processorOptions?.bypassed).toBe(true);
    expect(node.options.processorOptions?.parameters).toMatchObject({ bpm: 120 });

    engine.setFxActive('track', 2, true);
    engine.setFxParam('track', 2, 50);
    const trackFxInstances = (engine as unknown as {
      trackFxInstances: Array<{ setParam(key: string, value: number): void } | null>;
    }).trackFxInstances;
    const fx = trackFxInstances[2]!;
    fx.setParam('slice', 0.5);
    fx.setParam('scatter', 75);
    fx.setParam('pitch', -12);
    fx.setParam('repeats', 8);
    fx.setParam('mix', 25);

    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'set-bypass', value: false, rampFrames: 128 });
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { bpm: 120, mix: 0.5 } });
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { beatScatterSliceBeats: 0.5 } });
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { beatScatterScatterPercent: 75 } });
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { beatScatterPitchSemitones: -12 } });
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { beatScatterRepeats: 8 } });
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { mix: 0.25 } });
    warn.mockRestore();
  });

  it('captures and reorders quantized grains deterministically with audible pitch control', () => {
    const [left, right] = createStereoSlices(3000);
    const run = (parameters: ConstructorParameters<typeof BrowserFxDspCore>[2]) => {
      const core = new BrowserFxDspCore('beat-scatter', 8000, parameters);
      core.setBypass(false, 0);
      return { core, output: render(core, left, right, [left.length]) };
    };

    const sequential = run({ bpm: 120, beatScatterSliceBeats: 0.25, beatScatterScatterPercent: 0, beatScatterPitchSemitones: 0, beatScatterRepeats: 4, mix: 1 });
    const scattered = run({ bpm: 120, beatScatterSliceBeats: 0.25, beatScatterScatterPercent: 100, beatScatterPitchSemitones: 0, beatScatterRepeats: 4, mix: 1 });
    const repeated = run({ bpm: 120, beatScatterSliceBeats: 0.25, beatScatterScatterPercent: 100, beatScatterPitchSemitones: 0, beatScatterRepeats: 4, mix: 1 });
    const pitched = run({ bpm: 120, beatScatterSliceBeats: 0.25, beatScatterScatterPercent: 0, beatScatterPitchSemitones: 12, beatScatterRepeats: 4, mix: 1 });

    expect(sequential.output[0].slice(0, 1000)).toEqual(left.slice(0, 1000));
    expect(scattered.output[0]).toEqual(repeated.output[0]);
    expect(scattered.output[1]).toEqual(repeated.output[1]);
    expect(scattered.output[0].slice(1000)).not.toEqual(sequential.output[0].slice(1000));
    expect(pitched.output[0].slice(1000)).not.toEqual(sequential.output[0].slice(1000));
    expect(sequential.core.beatScatterDiagnostics).toMatchObject({
      boundaryCount: 3,
      activeBpm: 120,
      activeSliceBeats: 0.25,
      activeScatterPercent: 0,
      activePitchSemitones: 0,
      activeRepeats: 4,
      activeSliceFrames: 1000,
      hasCapturedSlice: true,
    });
    expect(scattered.output[0].every(Number.isFinite)).toBe(true);
    expect(scattered.output[1].every(Number.isFinite)).toBe(true);
  });

  it('is independent of render-block segmentation across capture and grain boundaries', () => {
    const [left, right] = createStereoSlices(9000);
    const run = (blocks: readonly number[]) => {
      const core = new BrowserFxDspCore('beat-scatter', 8000, {
        bpm: 120,
        beatScatterSliceBeats: 0.5,
        beatScatterScatterPercent: 72,
        beatScatterPitchSemitones: -7,
        beatScatterRepeats: 7,
        mix: 1,
      });
      core.setBypass(false, 0);
      return render(core, left, right, blocks);
    };

    const wholeBlock = run([left.length]);
    const variableQuanta = run([1, 31, 128, 257, 3, 511, 17]);
    expect(variableQuanta[0]).toEqual(wholeBlock[0]);
    expect(variableQuanta[1]).toEqual(wholeBlock[1]);
  });

  it('latches tempo and descriptor-bounded controls at a slice boundary with fixed state capacity', () => {
    const core = new BrowserFxDspCore('beat-scatter', 8000, {
      bpm: 120,
      beatScatterSliceBeats: 0.25,
      beatScatterScatterPercent: 50,
      beatScatterPitchSemitones: 0,
      beatScatterRepeats: 4,
      mix: 1,
    });
    core.setBypass(false, 0);
    const first = new Float32Array(123).fill(0.1);
    core.processBlock(first, first, new Float32Array(first.length), new Float32Array(first.length), first.length);
    core.setParameters({
      bpm: 1,
      beatScatterSliceBeats: 3.5,
      beatScatterScatterPercent: 200,
      beatScatterPitchSemitones: 100,
      beatScatterRepeats: 100,
    });
    expect(core.beatScatterDiagnostics).toMatchObject({
      boundaryCount: 0,
      activeBpm: 120,
      activeSliceBeats: 0.25,
      activeScatterPercent: 50,
      activePitchSemitones: 0,
      activeRepeats: 4,
      remainingFramesToBoundary: 877,
    });

    const rest = new Float32Array(877).fill(0.1);
    core.processBlock(rest, rest, new Float32Array(rest.length), new Float32Array(rest.length), rest.length);
    expect(core.beatScatterDiagnostics).toMatchObject({
      boundaryCount: 1,
      activeBpm: 40,
      activeSliceBeats: 4,
      activeScatterPercent: 100,
      activePitchSemitones: 24,
      activeRepeats: 16,
      activeSliceFrames: 1000,
      remainingFramesToBoundary: 48000,
      maxSliceFrames: 48002,
    });

    const largestSlice = new Float32Array(48000).fill(0.1);
    const largestOutput = new Float32Array(largestSlice.length);
    core.processBlock(largestSlice, largestSlice, largestOutput, new Float32Array(largestSlice.length), largestSlice.length);
    expect(core.beatScatterDiagnostics).toMatchObject({
      boundaryCount: 2,
      activeSliceFrames: 48000,
      maxSliceFrames: 48002,
      hasCapturedSlice: true,
    });

    const hostile = new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.1]);
    const hostileOutput = new Float32Array(hostile.length);
    core.processBlock(hostile, hostile, hostileOutput, new Float32Array(hostile.length), hostile.length);
    expect(hostileOutput.every(Number.isFinite)).toBe(true);
    expect(core.nonFiniteInputSamples).toBeGreaterThan(0);
    expect(core.nonFiniteOutputSamples).toBe(0);
  });
});
