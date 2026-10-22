import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserWorkletFX } from '../../src/audio/fx/BrowserWorkletFX';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BrowserPatternSlicerDsp } from '../../src/audio/fx/dsp/BrowserPatternSlicerDsp';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

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

function createEngine(): BrowserAudioEngine {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  Object.assign(engine, {
    context: {
      sampleRate: 48000,
      audioWorklet: { addModule: vi.fn(async (_url: string) => undefined) },
      createGain: () => new MockAudioNode(),
    },
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

function renderCore(core: BrowserFxDspCore, input: Float32Array, blockSizes: readonly number[]): Float32Array {
  const output = new Float32Array(input.length);
  let offset = 0;
  let block = 0;
  while (offset < input.length) {
    const size = Math.min(blockSizes[block % blockSizes.length] ?? input.length, input.length - offset);
    core.processBlock(input.subarray(offset, offset + size), null, output.subarray(offset, offset + size), null, size);
    offset += size;
    block += 1;
  }
  return output;
}

describe('Browser PATTERN SLICER (catalog source ID 34)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWorkletNode.instances = [];
  });

  it('uses the active 16-step table at sample-clocked tempo boundaries with smoothed edges', () => {
    const dsp = new BrowserPatternSlicerDsp(8000, {
      bpm: 120,
      pattern: 0,
      rateBeats: 0.25,
      depthPercent: 100,
      edgeMs: 0.5,
    });
    const open = new Float32Array(1000).fill(0.5);
    for (const sample of open) dsp.processSample(sample, -sample);
    expect(dsp.wetLeft).toBeCloseTo(0.5);
    expect(dsp.wetRight).toBeCloseTo(-0.5);
    expect(dsp.diagnostics).toMatchObject({
      framesProcessed: 1000,
      boundaryCount: 1,
      lastBoundaryFrame: 999,
      activeStepIndex: 1,
      activeStepFrames: 1000,
      remainingFramesToBoundary: 1000,
    });

    const edge = new Float32Array(4);
    for (let index = 0; index < edge.length; index += 1) {
      dsp.processSample(1, 1);
      edge[index] = dsp.wetLeft;
    }
    expect(edge[0]).toBeCloseTo(1);
    expect(edge[1]).toBeLessThan(edge[0]!);
    expect(edge[2]).toBeLessThan(edge[1]!);
    expect(edge[3]).toBeCloseTo(0);
  });

  it('latches controls at the next step, bounds hostile values, and lets depth zero pass unchanged', () => {
    const dsp = new BrowserPatternSlicerDsp(8000, { bpm: 120, pattern: 0, rateBeats: 0.25, depthPercent: 100 });
    for (let frame = 0; frame < 123; frame += 1) dsp.processSample(0.2, -0.2);
    dsp.setParameters({ bpm: -10, pattern: 99, rateBeats: 3.3, depthPercent: 200, edgeMs: 100 });
    expect(dsp.diagnostics).toMatchObject({ activeBpm: 120, activePattern: 0, activeRateBeats: 0.25, activeDepthPercent: 100 });
    for (let frame = 123; frame < 1000; frame += 1) dsp.processSample(0.2, -0.2);
    expect(dsp.diagnostics).toMatchObject({ activeBpm: 40, activePattern: 7, activeRateBeats: 4, activeDepthPercent: 100, activeEdgeMs: 20 });

    const transparent = new BrowserPatternSlicerDsp(8000, { depthPercent: 0, pattern: 0 });
    transparent.processSample(0.25, -0.125);
    expect(transparent.wetLeft).toBe(0.25);
    expect(transparent.wetRight).toBe(-0.125);
  });

  it('keeps the Browser DSP core output independent of variable render blocks', () => {
    const input = new Float32Array(12_000).fill(0.35);
    const run = (blocks: readonly number[]) => {
      const core = new BrowserFxDspCore('pattern-slicer', 8000, {
        bpm: 120,
        patternSlicerPattern: 6,
        patternSlicerRateBeats: 0.25,
        patternSlicerDepthPercent: 100,
        patternSlicerEdgeMs: 1,
      });
      core.setBypass(false, 0);
      return { output: renderCore(core, input, blocks), diagnostics: core.patternSlicerDiagnostics };
    };
    const whole = run([input.length]);
    const variable = run([1, 31, 128, 257, 3, 511, 17]);
    expect(variable.output).toEqual(whole.output);
    expect(variable.diagnostics).toEqual(whole.diagnostics);
    expect(whole.output.some((sample, index) => sample !== input[index])).toBe(true);
    expect(whole.output.every(Number.isFinite)).toBe(true);
  });

  it('processes variable worklet quanta and configure messages through the real processor', () => {
    const processor = new FxProcessor({
      processorOptions: {
        algorithm: 'pattern-slicer',
        sampleRate: 8000,
        parameters: { bpm: 120, patternSlicerPattern: 0, patternSlicerRateBeats: 0.25, patternSlicerDepthPercent: 100, patternSlicerEdgeMs: 0.5 },
        bypassed: false,
      },
    });
    processor.port.onmessage?.({ data: { type: 'configure', parameters: { patternSlicerPattern: 3 } } });
    const input = new Float32Array(9000).fill(0.4);
    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);
    const blocks = [1, 31, 128, 257, 3];
    let offset = 0;
    let block = 0;
    while (offset < input.length) {
      const count = Math.min(blocks[block % blocks.length]!, input.length - offset);
      processor.process([[input.subarray(offset, offset + count)]], [[left.subarray(offset, offset + count), right.subarray(offset, offset + count)]]);
      offset += count;
      block += 1;
    }
    expect(left).not.toEqual(input);
    expect(right).toEqual(left);
    expect(left.every(Number.isFinite)).toBe(true);
    expect(processor.core.framesProcessed).toBe(input.length);
    expect(processor.core.patternSlicerDiagnostics).toMatchObject({ boundaryCount: 9, activeStepIndex: 9 });
  });

  it('routes PATTERN SLICER to both Browser input and Track A–D banks and exposes controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const engine = createEngine();
    for (let slot = 0; slot < 4; slot += 1) {
      engine.setFxType('input', slot, 'PATTERN SLICER');
      engine.setFxType('track', slot, 'PATTERN SLICER');
    }
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(8));
    expect(MockWorkletNode.instances.map((instance) => instance.options.processorOptions?.algorithm))
      .toEqual(Array(8).fill('pattern-slicer'));
    expect(MockWorkletNode.instances[0]?.options.processorOptions?.bypassed).toBe(true);
    expect(MockWorkletNode.instances[0]?.options.processorOptions?.parameters).toMatchObject({ bpm: 120 });

    const internals = engine as unknown as {
      inputFxInstances: Array<BrowserWorkletFX | null>;
      trackFxInstances: Array<BrowserWorkletFX | null>;
      inputFxChain: { input: MockAudioNode; output: MockAudioNode };
      outputFxChain: { input: MockAudioNode; output: MockAudioNode };
    };
    expect(internals.inputFxChain.input.connect).toHaveBeenLastCalledWith(internals.inputFxInstances[0]!.input);
    expect(internals.outputFxChain.input.connect).toHaveBeenLastCalledWith(internals.trackFxInstances[0]!.input);
    for (let slot = 0; slot < 3; slot += 1) {
      expect(internals.inputFxInstances[slot]!.output.connect).toHaveBeenLastCalledWith(internals.inputFxInstances[slot + 1]!.input);
      expect(internals.trackFxInstances[slot]!.output.connect).toHaveBeenLastCalledWith(internals.trackFxInstances[slot + 1]!.input);
    }
    expect(internals.inputFxInstances[3]!.output.connect).toHaveBeenLastCalledWith(internals.inputFxChain.output);
    expect(internals.trackFxInstances[3]!.output.connect).toHaveBeenLastCalledWith(internals.outputFxChain.output);

    engine.setFxActive('input', 0, true);
    engine.setFxParam('input', 0, 75);
    const instances = (engine as unknown as { inputFxInstances: Array<BrowserWorkletFX | null> }).inputFxInstances;
    const fx = instances[0]!;
    fx.setParam('pattern', 4);
    fx.setParam('rate', 0.5);
    fx.setParam('depth', 60);
    fx.setParam('edge', 5);
    fx.setParam('bpm', 90);
    expect(MockWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledWith({ type: 'set-bypass', value: false, rampFrames: 128 });
    expect(MockWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { bpm: 120, patternSlicerDepthPercent: 75 } });
    expect(MockWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { patternSlicerPattern: 4 } });
    expect(MockWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { patternSlicerRateBeats: 0.5 } });
    expect(MockWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { patternSlicerDepthPercent: 60 } });
    expect(MockWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { patternSlicerEdgeMs: 5 } });
    expect(MockWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { bpm: 90 } });
    expect(MockWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledWith({ type: 'reset' });
  });
});
