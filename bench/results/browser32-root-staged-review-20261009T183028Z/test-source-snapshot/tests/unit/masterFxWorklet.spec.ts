import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type TestProcessor = {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  processFailures: number;
  nonFiniteSamples: number;
  wetGain: number;
  wetTarget: number;
  wetStep: number;
  wetRampRemaining: number;
  fxTransitionControl: Int32Array | null;
  fxTransitionIndex: number;
  dsp: Record<string, any>;
};

function makeMasterProcessor() {
  let Registered: (new () => object) | null = null;
  const scope: Record<string, any> = {
    AudioWorkletProcessor: class { port = { postMessage() {} }; },
    registerProcessor(_name: string, processor: new () => object) { Registered = processor; },
    SharedArrayBuffer,
    Int32Array,
    Float32Array,
    Atomics,
    Math,
    Number,
    sampleRate: 48_000,
    currentFrame: 0,
  };
  const source = readFileSync(resolve(process.cwd(), 'public/worklets/master-fx-processor.js'), 'utf8');
  runInNewContext(source, scope);
  if (!Registered) throw new Error('The master FX Worklet did not register.');
  const processor = Object.create((Registered as new () => object).prototype) as TestProcessor;
  Object.assign(processor, {
    processCallbacks: 0, processedFrames: 0, outputFrames: 0, processFailures: 0, nonFiniteSamples: 0,
    lastFrameEnd: -1, lastFrameStart: -1, lastQuantumFrames: 0, minimumQuantumFrames: 0, maximumQuantumFrames: 0,
    frameDiscontinuities: 0, wetGain: 1, wetTarget: 1, wetStep: 0, wetRampRemaining: 0,
    fxTransitionControl: null, fxTransitionIndex: 1,
  });

  const maxFrames = 64;
  const memory = new ArrayBuffer(16_384);
  const stride = maxFrames * Float32Array.BYTES_PER_ELEMENT;
  const addresses = {
    leftAAddress: 0, rightAAddress: stride,
    leftBAddress: stride * 2, rightBAddress: stride * 3,
    dryLeftAddress: stride * 4, dryRightAddress: stride * 5,
    oldLeftAAddress: stride * 6, oldRightAAddress: stride * 7,
    oldLeftBAddress: stride * 8, oldRightBAddress: stride * 9,
  };
  const views = new Map<number, Float32Array>();
  for (const address of Object.values(addresses)) views.set(address, new Float32Array(memory, address, maxFrames));
  processor.dsp = {
    maxBlockFrames: maxFrames,
    memory: { buffer: memory },
    ...addresses,
    leftA: views.get(addresses.leftAAddress), rightA: views.get(addresses.rightAAddress),
    leftB: views.get(addresses.leftBAddress), rightB: views.get(addresses.rightBAddress),
    dryLeft: views.get(addresses.dryLeftAddress), dryRight: views.get(addresses.dryRightAddress),
    oldLeftA: views.get(addresses.oldLeftAAddress), oldRightA: views.get(addresses.oldRightAAddress),
    oldLeftB: views.get(addresses.oldLeftBAddress), oldRightB: views.get(addresses.oldRightBAddress),
    activeHandles: [], retired: null, transitionFrames: 0, transitionElapsed: 0,
    wasm: {
      webrc_dsp_fx_process_stereo(handle: number, sourceL: number, sourceR: number, destL: number, destR: number, frames: number) {
        const gain = handle === 1 ? 0.25 : 0.75;
        const inputLeft = views.get(sourceL)!;
        const inputRight = views.get(sourceR)!;
        const outputLeft = views.get(destL)!;
        const outputRight = views.get(destR)!;
        for (let frame = 0; frame < frames; frame += 1) {
          outputLeft[frame] = inputLeft[frame]! * gain;
          outputRight[frame] = inputRight[frame]! * gain;
        }
        return 0;
      },
    },
  };
  return { processor, scope };
}

describe('master shared-DSP Worklet', () => {
  it('keeps the dry path finite when either input channel contains NaN or infinity', () => {
    const { processor } = makeMasterProcessor();
    processor.wetGain = 0.35;
    processor.wetTarget = 0.35;
    const inputLeft = Float32Array.of(Number.NaN, Number.POSITIVE_INFINITY, 0.5, -0.25);
    const inputRight = Float32Array.of(0.25, Number.NEGATIVE_INFINITY, 0.125, -0.5);
    const outputLeft = new Float32Array(4);
    const outputRight = new Float32Array(4);
    processor.process([[inputLeft, inputRight]], [[outputLeft, outputRight]]);

    expect(Array.from(outputLeft).every(Number.isFinite)).toBe(true);
    expect(Array.from(outputRight).every(Number.isFinite)).toBe(true);
    expect(Array.from(outputLeft.slice(0, 2))).toEqual([0, 0]);
    expect(Array.from(outputRight.slice(0, 2))).toEqual([0.25, 0]);
    expect(outputLeft[2]).toBeCloseTo(0.5, 6);
    expect(outputRight[2]).toBeCloseTo(0.125, 6);
    expect(processor.nonFiniteSamples).toBe(3);
  });

  it('crossfades the old stereo chain to a replacement over prepared frames', () => {
    const { processor, scope } = makeMasterProcessor();
    const dsp = processor.dsp;
    dsp.activeHandles = [2];
    dsp.retired = { handles: [1] };
    dsp.transitionFrames = 480;
    dsp.transitionElapsed = 0;
    processor.fxTransitionControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    processor.fxTransitionControl[1] = 480;
    const inputLeft = new Float32Array(64).fill(0.5);
    const inputRight = new Float32Array(64).fill(-0.25);
    const outputLeft = new Float32Array(64);
    const outputRight = new Float32Array(64);
    let previousLeft = 0.125;
    let previousRight = -0.0625;
    let maximumStep = 0;

    for (let block = 0; block < 8; block += 1) {
      scope.currentFrame = block * 64;
      processor.process([[inputLeft, inputRight]], [[outputLeft, outputRight]]);
      for (let frame = 0; frame < 64; frame += 1) {
        maximumStep = Math.max(maximumStep, Math.abs(outputLeft[frame]! - previousLeft),
          Math.abs(outputRight[frame]! - previousRight));
        previousLeft = outputLeft[frame]!;
        previousRight = outputRight[frame]!;
      }
    }
    expect(dsp.transitionElapsed).toBe(480);
    expect(Atomics.load(processor.fxTransitionControl, 1)).toBe(0);
    expect(outputLeft[63]).toBeCloseTo(0.375, 6);
    expect(outputRight[63]).toBeCloseTo(-0.1875, 6);
    expect(maximumStep).toBeLessThan(0.001);
  });

  it('crossfades an old attenuating stereo chain to the dry path on clear', () => {
    const { processor, scope } = makeMasterProcessor();
    const dsp = processor.dsp;
    dsp.activeHandles = [];
    dsp.retired = { handles: [1] };
    dsp.transitionFrames = 480;
    dsp.transitionElapsed = 0;
    const inputLeft = new Float32Array(64).fill(0.5);
    const inputRight = new Float32Array(64).fill(-0.25);
    const outputLeft = new Float32Array(64);
    const outputRight = new Float32Array(64);
    let previousLeft = 0.125;
    let previousRight = -0.0625;
    let maximumStep = 0;

    for (let block = 0; block < 8; block += 1) {
      scope.currentFrame = block * 64;
      processor.process([[inputLeft, inputRight]], [[outputLeft, outputRight]]);
      for (let frame = 0; frame < 64; frame += 1) {
        maximumStep = Math.max(maximumStep, Math.abs(outputLeft[frame]! - previousLeft),
          Math.abs(outputRight[frame]! - previousRight));
        previousLeft = outputLeft[frame]!;
        previousRight = outputRight[frame]!;
      }
    }
    expect(outputLeft[63]).toBeCloseTo(0.5, 6);
    expect(outputRight[63]).toBeCloseTo(-0.25, 6);
    expect(maximumStep).toBeLessThan(0.001);
  });
});
