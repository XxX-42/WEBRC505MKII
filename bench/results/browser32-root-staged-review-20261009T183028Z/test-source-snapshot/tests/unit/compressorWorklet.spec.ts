import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompressorFX } from '../../src/audio/fx/CompressorFX';
import { createMockAudioContext, MockAudioWorkletNode } from '../helpers/audioTestUtils';

const source = readFileSync(resolve(process.cwd(), 'public/worklets/compressor-processor.js'), 'utf8');

class WorkletProcessorStub {}

type CompressorProcessor = {
  process: (
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ) => boolean;
};

const defaultParameters = {
  thresholdDb: -24,
  ratio: 12,
  kneeDb: 30,
  attackSeconds: 0.003,
  releaseSeconds: 0.25,
};

function createProcessor() {
  let RegisteredProcessor: (new () => CompressorProcessor) | null = null;
  runInNewContext(source, {
    AudioWorkletProcessor: WorkletProcessorStub,
    registerProcessor: (_name: string, processor: new () => CompressorProcessor) => {
      RegisteredProcessor = processor;
    },
    sampleRate: 48_000,
  });
  if (!RegisteredProcessor) throw new Error('Real compressor processor source did not register.');
  return new RegisteredProcessor();
}

function parameterArrays(overrides: Partial<typeof defaultParameters> = {}) {
  const values = { ...defaultParameters, ...overrides };
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, new Float32Array([value])])) as Record<string, Float32Array>;
}

function renderBlock(
  processor: CompressorProcessor,
  left: Float32Array,
  right = left,
  parameters: Record<string, Float32Array> = parameterArrays(),
) {
  const outLeft = new Float32Array(left.length);
  const outRight = new Float32Array(left.length);
  const keepAlive = processor.process([[left, right]], [[outLeft, outRight]], parameters);
  expect(keepAlive).toBe(true);
  return [outLeft, outRight] as const;
}

function renderConstant(
  processor: CompressorProcessor,
  leftValue: number,
  rightValue: number,
  frames: number,
  parameters: Record<string, Float32Array>,
) {
  let rendered: readonly [Float32Array, Float32Array] = [new Float32Array(), new Float32Array()];
  for (let offset = 0; offset < frames; offset += 128) {
    const blockFrames = Math.min(128, frames - offset);
    const left = new Float32Array(blockFrames).fill(leftValue);
    const right = new Float32Array(blockFrames).fill(rightValue);
    rendered = renderBlock(processor, left, right, parameters);
  }
  return rendered;
}

describe('linked compressor AudioWorklet processor', () => {
  it('emits the first impulse at sample zero without fixed lookahead', () => {
    const processor = createProcessor();
    const impulse = new Float32Array(128);
    impulse[0] = 0.5;

    const [left, right] = renderBlock(processor, impulse, impulse);

    expect(left.findIndex((sample) => sample !== 0)).toBe(0);
    expect(left[0]).toBeCloseTo(0.5, 6);
    expect(right[0]).toBeCloseTo(0.5, 6);
  });

  it('follows the static compression curve after the attack envelope settles', () => {
    const processor = createProcessor();
    const parameters = parameterArrays({ thresholdDb: -24, ratio: 12, kneeDb: 0, attackSeconds: 0.0001 });
    const [left] = renderConstant(processor, 0.5, 0.5, 24_000, parameters);
    const expectedOutput = 10 ** ((-24 + ((20 * Math.log10(0.5) + 24) / 12)) / 20);
    const settledOutput = left[left.length - 1]!;

    expect(settledOutput).toBeCloseTo(expectedOutput, 3);
    expect(settledOutput).toBeGreaterThan(0);
    expect(settledOutput).toBeLessThan(0.5);
  });

  it('uses the configured soft knee smoothly around threshold', () => {
    const processor = createProcessor();
    const inputLevel = 10 ** (-12 / 20);
    const parameters = parameterArrays({
      thresholdDb: -12,
      ratio: 4,
      kneeDb: 12,
      attackSeconds: 0.0001,
    });
    const [left] = renderConstant(processor, inputLevel, inputLevel, 24_000, parameters);
    const expectedAtThreshold = inputLevel * (10 ** (-1.125 / 20));

    expect(left[left.length - 1]).toBeCloseTo(expectedAtThreshold, 3);
    expect(left[left.length - 1]).toBeLessThan(inputLevel);
  });

  it('links both channels to the louder channel and shares one gain reduction', () => {
    const processor = createProcessor();
    const parameters = parameterArrays({ thresholdDb: -24, ratio: 12, kneeDb: 0, attackSeconds: 0.0001 });
    const [left, right] = renderConstant(processor, 0.5, 0.05, 24_000, parameters);

    expect(left[left.length - 1]).toBeLessThan(0.1);
    expect(right[right.length - 1]).toBeLessThan(0.01);
    expect(right[right.length - 1]! / left[left.length - 1]!).toBeCloseTo(0.1, 3);
  });

  it('applies attack and releases gain reduction over time', () => {
    const processor = createProcessor();
    const parameters = parameterArrays({
      thresholdDb: -30,
      ratio: 10,
      kneeDb: 0,
      attackSeconds: 0.01,
      releaseSeconds: 0.1,
    });
    const initial = renderBlock(processor, new Float32Array([0.5]), new Float32Array([0.5]), parameters);
    const attack = renderConstant(processor, 0.5, 0.5, 1_024, parameters);
    const earlyRelease = renderConstant(processor, 0.01, 0.01, 128, parameters);
    const settledRelease = renderConstant(processor, 0.01, 0.01, 24_000, parameters);

    expect(initial[0][0]).toBeGreaterThan(0.45);
    expect(attack[0][attack[0].length - 1]).toBeLessThan(0.1);
    expect(earlyRelease[0][0]).toBeLessThan(0.003);
    expect(settledRelease[0][settledRelease[0].length - 1]).toBeGreaterThan(0.009);
    expect(settledRelease[0][settledRelease[0].length - 1]).toBeLessThan(0.011);
  });

  it('sanitizes invalid samples and never emits non-finite audio', () => {
    const processor = createProcessor();
    const left = new Float32Array([Number.POSITIVE_INFINITY, Number.NaN, 0.1]);
    const right = new Float32Array([Number.NaN, Number.NEGATIVE_INFINITY, 0.1]);

    const [outLeft, outRight] = renderBlock(processor, left, right);

    expect([...outLeft, ...outRight].every(Number.isFinite)).toBe(true);
    expect(outLeft[0]).toBe(0);
    expect(outLeft[1]).toBe(0);
    expect(outRight[0]).toBe(0);
    expect(outRight[1]).toBe(0);
  });
});

describe('CompressorFX readiness and failure state', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stays dry until initialization completes and exposes the active AudioWorklet backend', async () => {
    const context = createMockAudioContext();
    const fx = new CompressorFX(context);
    const nodes: MockAudioWorkletNode[] = [];
    vi.stubGlobal('AudioWorkletNode', class extends MockAudioWorkletNode {
      constructor() {
        super();
        nodes.push(this);
      }
    });

    expect(fx.backend).toBe('dry-bypass');
    expect(fx.isReady).toBe(false);
    expect(fx.active).toBe(false);
    fx.setParam('amount', 0.5);
    fx.setBypass(false);

    const initialization = fx.initialize();
    expect(fx.initialize()).toBe(initialization);
    await initialization;

    expect(nodes).toHaveLength(1);
    expect(fx.backend).toBe('audio-worklet');
    expect(fx.isReady).toBe(true);
    expect(fx.active).toBe(true);
    fx.dispose();
    expect(fx.backend).toBe('disposed');
  });

  it('rejects initialization when the module cannot load and preserves dry bypass', async () => {
    const context = createMockAudioContext();
    const loadError = new Error('module load rejected');
    context.audioWorklet.addModule = vi.fn().mockRejectedValue(loadError);
    const fx = new CompressorFX(context);

    await expect(fx.initialize()).rejects.toThrow('module load rejected');
    expect(fx.backend).toBe('failed');
    expect(fx.isReady).toBe(false);
    expect(fx.active).toBe(false);
    expect(fx.error).toBe(loadError);
  });

  it('does not create a node when disposal wins a pending module load', async () => {
    const context = createMockAudioContext();
    let resolveModule!: () => void;
    context.audioWorklet.addModule = vi.fn(() => new Promise<void>((resolve) => {
      resolveModule = resolve;
    }));
    const nodes: MockAudioWorkletNode[] = [];
    vi.stubGlobal('AudioWorkletNode', class extends MockAudioWorkletNode {
      constructor() {
        super();
        nodes.push(this);
      }
    });
    const fx = new CompressorFX(context);
    const initialization = fx.initialize();

    fx.dispose();
    resolveModule();

    await expect(initialization).rejects.toThrow('disposed before its worklet finished loading');
    expect(nodes).toHaveLength(0);
    expect(fx.backend).toBe('disposed');
  });

  it('marks processorerror as failed, forces bypass, and notifies the owning chain', async () => {
    const context = createMockAudioContext();
    const fx = new CompressorFX(context);
    const nodes: MockAudioWorkletNode[] = [];
    vi.stubGlobal('AudioWorkletNode', class extends MockAudioWorkletNode {
      constructor() {
        super();
        nodes.push(this);
      }
    });
    const onFailure = vi.fn();
    fx.onFailure = onFailure;
    await fx.initialize();
    fx.setBypass(false);

    nodes[0]!.dispatchEvent(new Event('processorerror'));

    expect(fx.backend).toBe('failed');
    expect(fx.active).toBe(false);
    expect(fx.error).toBeInstanceOf(Error);
    expect(onFailure).toHaveBeenCalledOnce();
    fx.dispose();
  });
});
