import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserWorkletFX } from '../../src/audio/fx/BrowserWorkletFX';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BrowserStepSlicerDsp } from '../../src/audio/fx/dsp/BrowserStepSlicerDsp';
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

function makeEngine(): BrowserAudioEngine {
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

function renderCore(core: BrowserFxDspCore, left: Float32Array, right: Float32Array, quanta: readonly number[]) {
  const outputLeft = new Float32Array(left.length);
  const outputRight = new Float32Array(right.length);
  let offset = 0;
  let block = 0;
  while (offset < left.length) {
    const frames = Math.min(quanta[block % quanta.length] ?? left.length, left.length - offset);
    core.processBlock(
      left.subarray(offset, offset + frames),
      right.subarray(offset, offset + frames),
      outputLeft.subarray(offset, offset + frames),
      outputRight.subarray(offset, offset + frames),
      frames,
      false,
    );
    offset += frames;
    block += 1;
  }
  return { left: outputLeft, right: outputRight };
}

describe('Browser STEP SLICER (catalog source ID 35)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWorkletNode.instances = [];
  });

  it('edits individual amplitude steps and applies step-count, tempo, and rate changes on sample-clock boundaries', () => {
    const dsp = new BrowserStepSlicerDsp(8000, {
      bpm: 120,
      stepCount: 2,
      rateBeats: 0.25,
      depthPercent: 100,
      filterHz: 20000,
      step01: 20,
      step02: 80,
      step03: 40,
    });
    expect(dsp.diagnostics).toMatchObject({ activeStepCount: 16, activeStepLevelPercent: 20, activeStepFrames: 1000 });
    dsp.processSample(0.5, 0.5);
    expect(dsp.wetLeft).toBeGreaterThan(0);
    expect(dsp.wetLeft).toBeLessThan(0.15);

    dsp.setParameters({ step03: 60, stepCount: 1, rateBeats: 0.5, bpm: 100, depthPercent: 90 });
    expect(dsp.diagnostics).toMatchObject({
      activeStepIndex: 0,
      activeStepCount: 16,
      activeBpm: 120,
      activeRateBeats: 0.25,
      activeStepLevelPercent: 20,
    });
    for (let frame = 1; frame < 1000; frame += 1) dsp.processSample(0.5, 0.5);
    expect(dsp.diagnostics).toMatchObject({
      boundaryCount: 1,
      lastBoundaryFrame: 999,
      activeStepIndex: 1,
      activeStepCount: 8,
      activeBpm: 100,
      activeRateBeats: 0.5,
      activeDepthPercent: 90,
      activeStepLevelPercent: 80,
      activeStepFrames: 2400,
      remainingFramesToBoundary: 2400,
    });
    for (let frame = 0; frame < 2400; frame += 1) dsp.processSample(0.5, 0.5);
    expect(dsp.diagnostics).toMatchObject({ boundaryCount: 2, lastBoundaryFrame: 3399, activeStepIndex: 2, activeStepLevelPercent: 60 });
  });

  it('produces identical bounded finite audio for fixed and variable core quanta, with alternating pan and reset', () => {
    const frames = 6000;
    const left = new Float32Array(frames).fill(0.35);
    const right = new Float32Array(frames).fill(0.2);
    const parameters = {
      bpm: 120,
      stepSlicerStepCount: 16,
      stepSlicerRateBeats: 0.25,
      stepSlicerDepthPercent: 100,
      stepSlicerPanDepthPercent: 100,
      stepSlicerFilterHz: 5000,
      stepSlicerStep01: 30,
      stepSlicerStep02: 90,
      stepSlicerStep03: 45,
    };
    const makeCore = () => {
      const core = new BrowserFxDspCore('step-slicer', 8000, parameters);
      core.setBypass(false, 0);
      return core;
    };
    const wholeCore = makeCore();
    const variableCore = makeCore();
    const whole = renderCore(wholeCore, left, right, [frames]);
    const variable = renderCore(variableCore, left, right, [1, 31, 128, 257, 3, 511, 17]);
    expect(variable.left).toEqual(whole.left);
    expect(variable.right).toEqual(whole.right);
    expect(whole.left[0]).toBeGreaterThan(0);
    expect(Math.abs(whole.right[0]!)).toBeLessThan(1e-8);
    expect(whole.left.slice(1015, 1096).every((sample) => Math.abs(sample) < 1e-8)).toBe(true);
    expect(whole.right.slice(1015, 1096).some((sample) => sample > 0)).toBe(true);
    expect(whole.left.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 0.350001)).toBe(true);
    expect(whole.right.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 0.200001)).toBe(true);
    expect(variableCore.stepSlicerDiagnostics).toMatchObject({ framesProcessed: frames, boundaryCount: 6, activeStepIndex: 6 });

    variableCore.reset();
    expect(variableCore.stepSlicerDiagnostics).toMatchObject({ framesProcessed: 0, boundaryCount: 0, lastBoundaryFrame: -1, activeStepIndex: 0 });
    const resetOut = renderCore(variableCore, left.slice(0, 100), right.slice(0, 100), [1, 7, 31]);
    expect(resetOut.left).toEqual(whole.left.slice(0, 100));
    expect(resetOut.right).toEqual(whole.right.slice(0, 100));
  });

  it('handles variable worklet quanta and configure/reset messages for editable steps', () => {
    const processor = new FxProcessor({
      processorOptions: {
        algorithm: 'step-slicer',
        sampleRate: 8000,
        parameters: { bpm: 120, stepSlicerStepCount: 16, stepSlicerRateBeats: 0.25, stepSlicerDepthPercent: 100, stepSlicerStep01: 0, stepSlicerStep02: 50 },
        bypassed: false,
      },
    });
    const leftInput = new Float32Array(2400).fill(0.3);
    const rightInput = new Float32Array(2400).fill(-0.2);
    const leftOutput = new Float32Array(leftInput.length);
    const rightOutput = new Float32Array(rightInput.length);
    const quanta = [1, 31, 128, 257, 3];
    let offset = 0;
    let block = 0;
    while (offset < leftInput.length) {
      const frames = Math.min(quanta[block % quanta.length]!, leftInput.length - offset);
      processor.process(
        [[leftInput.subarray(offset, offset + frames), rightInput.subarray(offset, offset + frames)]],
        [[leftOutput.subarray(offset, offset + frames), rightOutput.subarray(offset, offset + frames)]],
      );
      offset += frames;
      block += 1;
    }
    expect(processor.core.algorithm).toBe('step-slicer');
    expect(processor.core.stepSlicerDiagnostics).toMatchObject({ framesProcessed: 2400, boundaryCount: 2, activeStepIndex: 2 });
    expect(leftOutput.slice(0, 1000).every((sample) => Math.abs(sample) < 1e-8)).toBe(true);
    expect(leftOutput.slice(1000, 2000).some((sample) => sample > 0)).toBe(true);
    expect(leftOutput.every(Number.isFinite) && rightOutput.every(Number.isFinite)).toBe(true);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);

    processor.port.onmessage?.({ data: { type: 'configure', parameters: { stepSlicerStep03: 25, stepSlicerStepCount: 0, stepSlicerRateBeats: 1 } } });
    processor.port.onmessage?.({ data: { type: 'reset' } });
    expect(processor.core.stepSlicerDiagnostics).toMatchObject({
      framesProcessed: 0,
      boundaryCount: 0,
      lastBoundaryFrame: -1,
      activeStepCount: 4,
      activeRateBeats: 1,
      activeStepIndex: 0,
      activeStepLevelPercent: 0,
    });
  });

  it('routes through Browser Input A–D and the shared Track A–D worklet bank with mapped controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const engine = makeEngine();
    for (let slot = 0; slot < 4; slot += 1) {
      engine.setFxType('input', slot, 'STEP SLICER');
      engine.setFxType('track', slot, 'STEP SLICER');
    }
    engine.setFxParam('input', 0, 55);
    const inputFx = (engine as unknown as {
      inputFxInstances: Array<BrowserWorkletFX | null>;
      trackFxInstances: Array<BrowserWorkletFX | null>;
    }).inputFxInstances;
    const trackFx = (engine as unknown as {
      trackFxInstances: Array<BrowserWorkletFX | null>;
    }).trackFxInstances;
    engine.setStepSlicerControl('input', 0, 'step_count', 8);
    engine.setStepSlicerControl('input', 0, 'rate_beats', 0.5);
    engine.setStepSlicerControl('input', 0, 'pan_depth_percent', 75);
    engine.setStepSlicerControl('input', 0, 'filter_hz', 7200);
    engine.setStepSlicerStep('input', 0, 0, 25);

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(8));
    expect(MockWorkletNode.instances.map((instance) => instance.options.processorOptions?.algorithm)).toEqual(Array(8).fill('step-slicer'));
    const initialParameters = MockWorkletNode.instances[0]?.options.processorOptions?.parameters as Record<string, number>;
    expect(initialParameters).toMatchObject({
      bpm: 120,
      stepSlicerStepCount: 8,
      stepSlicerRateBeats: 0.5,
      stepSlicerPanDepthPercent: 75,
      stepSlicerFilterHz: 7200,
      stepSlicerStep01: 25,
    });
    expect(initialParameters.stepSlicerDepthPercent).toBeCloseTo(55);
    expect(inputFx).toHaveLength(4);
    expect(trackFx).toHaveLength(4);
    const inputHead = (engine as unknown as { inputFxChain: { input: MockAudioNode } }).inputFxChain.input;
    const inputTail = (engine as unknown as { inputFxChain: { output: MockAudioNode } }).inputFxChain.output;
    const trackHead = (engine as unknown as { outputFxChain: { input: MockAudioNode } }).outputFxChain.input;
    const trackTail = (engine as unknown as { outputFxChain: { output: MockAudioNode } }).outputFxChain.output;
    const trackMix = (engine as unknown as { trackMixNode: MockAudioNode }).trackMixNode;
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[0]!.input);
    expect(inputFx[3]!.output.connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[0]!.input);
    expect(trackFx[3]!.output.connect).toHaveBeenCalledWith(trackTail);
  });
});
