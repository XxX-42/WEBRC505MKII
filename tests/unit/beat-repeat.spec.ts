import { describe, expect, it, vi } from 'vitest';
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
  const addModule = vi.fn(async (_url: string) => undefined);
  const context = {
    sampleRate: 48000,
    audioWorklet: { addModule },
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
    trackFxTypes: [null, null, null, null],
    fxWorkletModuleReady: null,
    fxWorkletGeneration: 0,
    statusListeners: new Set(),
    currentInputStream: null,
  });
  return engine;
}

function render(core: BrowserFxDspCore, left: Float32Array, right: Float32Array, blocks: readonly number[]): [Float32Array, Float32Array] {
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

describe('Browser BEAT REPEAT (catalog ID 51)', () => {
  it('rejects Input FX assignment and is wired only into the shared Track A–D bank', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    MockWorkletNode.instances = [];
    const engine = makeEngine();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    engine.setFxType('input', 0, 'BEAT REPEAT');
    expect(warn).toHaveBeenCalledWith('BEAT REPEAT is available only in the Browser Track FX bank.');
    expect((engine as unknown as { inputFxInstances: unknown[] }).inputFxInstances[0]).toBeNull();
    expect(MockWorkletNode.instances).toHaveLength(0);

    engine.setFxType('track', 2, 'BEAT REPEAT');
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(1));
    const processor = MockWorkletNode.instances[0]!;
    expect(processor.options.processorOptions?.algorithm).toBe('beat-repeat');
    expect(processor.options.processorOptions?.bypassed).toBe(true);
    expect(processor.options.processorOptions?.parameters).toMatchObject({ bpm: 120 });

    engine.setFxActive('track', 2, true);
    engine.setFxParam('track', 2, 50);
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: 'set-bypass', value: false, rampFrames: 128 });
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { bpm: 120, mix: 0.5 } });
    const trackEffects = (engine as unknown as { trackFxInstances: Array<{ setParam(key: string, value: number): void } | null> }).trackFxInstances;
    trackEffects[2]?.setParam('mix', 50);
    trackEffects[2]?.setParam('division', 0.25);
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { mix: 0.5 } });
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { division: 0.25 } });
    warn.mockRestore();
    vi.unstubAllGlobals();
  });

  it('captures a subdivision, retriggers it, and crossfades the forward loop seam continuously', () => {
    const sampleRate = 8000;
    const intervalFrames = 1000; // 1/4 beat at 120 BPM
    const frames = intervalFrames * 3;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      left[frame] = 0.3 * Math.sin((2 * Math.PI * frame) / 100);
      right[frame] = 0.25 * Math.cos((2 * Math.PI * frame) / 100);
    }

    const core = new BrowserFxDspCore('beat-repeat', sampleRate, {
      bpm: 120, division: 0.25, decay: 0, direction: 0, mix: 1,
    });
    core.setBypass(false, 0);
    const [outputLeft, outputRight] = render(core, left, right, [127, 31, 257, 1, 64, 511]);

    expect(outputLeft.slice(0, intervalFrames)).toEqual(left.slice(0, intervalFrames));
    expect(outputRight.slice(0, intervalFrames)).toEqual(right.slice(0, intervalFrames));
    expect(outputLeft.slice(intervalFrames).some((sample) => sample !== 0)).toBe(true);
    expect(outputLeft.every(Number.isFinite)).toBe(true);
    expect(outputRight.every(Number.isFinite)).toBe(true);
    // A loop boundary should continue through the authored equal-power seam,
    // rather than click back to the slice's first sample.
    expect(Math.abs((outputLeft[2000] ?? 0) - (outputLeft[1999] ?? 0))).toBeLessThan(0.08);
    expect(core.beatRepeatDiagnostics).toMatchObject({
      boundaryCount: 3,
      activeBpm: 120,
      activeDivision: 0.25,
      activeSliceFrames: intervalFrames,
      maxSliceFrames: sampleRate * 6 + 2,
    });
    expect(core.nonFiniteOutputSamples).toBe(0);
  });

  it('latches BPM and subdivision changes only at the next sample-clock event', () => {
    const core = new BrowserFxDspCore('beat-repeat', 8000, {
      bpm: 120, division: 0.25, decay: 0, mix: 1,
    });
    core.setBypass(false, 0);
    const zeros = new Float32Array(400);
    core.processBlock(zeros, zeros, new Float32Array(400), new Float32Array(400), 400);
    core.setParameters({ bpm: 60, division: 0.5 });

    const next599 = new Float32Array(599);
    core.processBlock(next599, next599, new Float32Array(599), new Float32Array(599), 599);
    expect(core.beatRepeatDiagnostics).toMatchObject({ boundaryCount: 0, activeBpm: 120, activeDivision: 0.25 });

    const oneFrame = new Float32Array(1);
    core.processBlock(oneFrame, oneFrame, new Float32Array(1), new Float32Array(1), 1);
    expect(core.beatRepeatDiagnostics).toMatchObject({
      boundaryCount: 1,
      lastBoundaryFrame: 999,
      activeBpm: 60,
      activeDivision: 0.5,
      remainingFramesToBoundary: 4000,
    });

    const next3999 = new Float32Array(3999);
    core.processBlock(next3999, next3999, new Float32Array(3999), new Float32Array(3999), 3999);
    expect(core.beatRepeatDiagnostics?.boundaryCount).toBe(1);
    core.processBlock(oneFrame, oneFrame, new Float32Array(1), new Float32Array(1), 1);
    expect(core.beatRepeatDiagnostics).toMatchObject({ boundaryCount: 2, activeBpm: 60, activeDivision: 0.5 });
  });

  it('plays a captured slice backward when the fixed reverse direction is selected', () => {
    const intervalFrames = 1000;
    const left = new Float32Array(intervalFrames * 2);
    const right = new Float32Array(intervalFrames * 2);
    for (let frame = 0; frame < intervalFrames; frame += 1) {
      left[frame] = frame / intervalFrames;
      right[frame] = frame / intervalFrames;
    }
    const core = new BrowserFxDspCore('beat-repeat', 8000, {
      bpm: 120, division: 0.25, decay: 0, direction: 1, mix: 1,
    });
    core.setBypass(false, 0);
    const [outputLeft] = render(core, left, right, [91, 257, 19]);
    expect(outputLeft[intervalFrames] ?? 0).toBeGreaterThan(0.95);
    expect(outputLeft[intervalFrames + 10] ?? 0).toBeGreaterThan(outputLeft[intervalFrames + 100] ?? 0);
  });

  it('replays reverse/alternate slices with decay and bounded deterministic storage at the 6-second limit', () => {
    const sampleRate = 8000;
    const frames = sampleRate * 12 + 100;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const inSlice = (frame % (sampleRate * 6)) / (sampleRate * 6);
      left[frame] = inSlice;
      right[frame] = 0.5 - inSlice;
    }

    const run = (blocks: readonly number[]) => {
      const core = new BrowserFxDspCore('beat-repeat', sampleRate, {
        bpm: 40, division: 4, decay: 20, direction: 2, mix: 1,
      });
      core.setBypass(false, 0);
      const output = render(core, left, right, blocks);
      return { core, output };
    };
    const segmented = run([1, 127, 257, 511, 64]);
    const otherSegmentation = run([frames]);

    expect(segmented.output[0]).toEqual(otherSegmentation.output[0]);
    expect(segmented.output[1]).toEqual(otherSegmentation.output[1]);
    expect(segmented.core.beatRepeatDiagnostics).toMatchObject({
      boundaryCount: 2,
      activeDirection: 2,
      activeSliceFrames: sampleRate * 6,
      maxSliceFrames: sampleRate * 6 + 2,
    });
    expect(segmented.output[0][sampleRate * 12] ?? 0).toBeGreaterThan(0.79);
    expect(segmented.output[0][sampleRate * 12] ?? 0).toBeLessThan(0.81);
    expect(segmented.core.nonFiniteInputSamples).toBe(0);
    expect(segmented.core.nonFiniteOutputSamples).toBe(0);
    expect(segmented.output[0].every(Number.isFinite)).toBe(true);
    expect(segmented.output[1].every(Number.isFinite)).toBe(true);
  });
});
