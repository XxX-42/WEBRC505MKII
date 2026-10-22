import { describe, expect, it } from 'vitest';
import {
  BrowserFreezeDsp,
  type BrowserFreezeOfficialParameters,
} from '../../src/audio/fx/dsp/BrowserFreezeDsp';

const SAMPLE_RATE = 8000;

function timeFrames(value: number, minimumMs: number, maximumMs: number, sampleRate = SAMPLE_RATE): number {
  return Math.round(sampleRate * minimumMs * Math.pow(maximumMs / minimumMs, value / 100) / 1000);
}

function processConstant(dsp: BrowserFreezeDsp, frames: number, left = 0.8, right = -0.6): Float32Array {
  const output = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    dsp.processSample(left, right);
    output[frame] = dsp.outputLeft;
  }
  return output;
}

function captured(
  parameters: BrowserFreezeOfficialParameters = {},
  sampleRate = SAMPLE_RATE,
): BrowserFreezeDsp {
  const dsp = new BrowserFreezeDsp(sampleRate, { captureLengthMs: 10 });
  dsp.setOfficialParameters(parameters);
  processConstant(dsp, sampleRate / 100, 0.5, -0.25);
  dsp.setParameters({ frozen: true });
  return dsp;
}

function floatHash(data: Float32Array): number {
  let hash = 2166136261;
  for (const word of new Uint32Array(data.buffer)) hash = Math.imul(hash ^ word, 16777619) >>> 0;
  return hash;
}

describe('Official FREEZE clean-room amplitude ADSR controls', () => {
  it('is wet-only before capture, during a held loop, and after release', () => {
    const dsp = new BrowserFreezeDsp(SAMPLE_RATE, { captureLengthMs: 20 });
    dsp.setOfficialParameters({ attack: 0, decay: 0, sustain: 100, release: 0 });
    dsp.setParameters({ frozen: true });
    expect(processConstant(dsp, 159).every((sample) => sample === 0)).toBe(true);
    expect(dsp.diagnostics).toMatchObject({ capturePending: true, hasFrozenBuffer: false });
    dsp.processSample(0.8, -0.6);
    expect(dsp.diagnostics).toMatchObject({ capturePending: false, hasFrozenBuffer: true });
    expect(dsp.outputLeft).toBeCloseTo(0.8 / 16, 6);

    processConstant(dsp, 200, -0.9, 0.9);
    expect(dsp.outputLeft).toBeCloseTo(0.8, 6);
    expect(dsp.outputRight).toBeCloseTo(-0.6, 6);
    dsp.setParameters({ frozen: false });
    processConstant(dsp, dsp.officialReleaseFrames, -0.9, 0.9);
    expect(dsp.outputLeft).toBe(0);
    expect(dsp.outputRight).toBe(0);
    expect(dsp.hasFrozenBuffer).toBe(false);
    expect(processConstant(dsp, 100, -0.9, 0.9).every((sample) => sample === 0)).toBe(true);
  });

  it.each([8000, 48000])('reaches peak, sustain and exact release zero on the mapped frame at %i Hz', (sampleRate) => {
    const dsp = captured({ attack: 0, decay: 0, sustain: 25, release: 0 }, sampleRate);
    const attackFrames = timeFrames(0, 2, 2000, sampleRate);
    const decayFrames = timeFrames(0, 10, 2000, sampleRate);
    const releaseFrames = timeFrames(0, 2, 5000, sampleRate);
    const attack = processConstant(dsp, attackFrames);
    expect(attack[0]).toBeCloseTo(0.5 / attackFrames, 7);
    expect(attack[attackFrames - 2]).toBeCloseTo(0.5 * (attackFrames - 1) / attackFrames, 7);
    expect(attack[attackFrames - 1]).toBe(0.5);
    expect(dsp.diagnostics.activationGain).toBe(1);

    const decay = processConstant(dsp, decayFrames);
    expect(decay[0]).toBeCloseTo(0.5 * (1 - 0.75 / decayFrames), 7);
    expect(decay[decayFrames - 1]).toBe(0.125);
    const plateau = processConstant(dsp, 400);
    expect(plateau.every((sample) => sample === 0.125)).toBe(true);
    expect(dsp.outputRight).toBe(-0.0625);
    expect(dsp.isFrozen).toBe(true);

    dsp.setParameters({ frozen: false });
    const release = processConstant(dsp, releaseFrames - 1);
    expect(release[0]).toBeCloseTo(0.125 * (1 - 1 / releaseFrames), 7);
    expect(release[release.length - 1]).toBeGreaterThan(0);
    expect(dsp.hasFrozenBuffer).toBe(true);
    dsp.processSample(0.8, -0.6);
    expect(dsp.outputLeft).toBe(0);
    expect(dsp.outputRight).toBe(0);
    expect(dsp.diagnostics.activationGain).toBe(0);
    expect(dsp.hasFrozenBuffer).toBe(false);
  });

  it('uses native default 30 for all four controls, with exponential time mappings', () => {
    const dsp = captured();
    const attackFrames = timeFrames(30, 2, 2000);
    const decayFrames = timeFrames(30, 10, 2000);
    expect(dsp.officialReleaseFrames).toBe(timeFrames(30, 2, 5000));
    processConstant(dsp, attackFrames - 1);
    expect(dsp.outputLeft).toBeCloseTo(0.5 * (attackFrames - 1) / attackFrames, 7);
    dsp.processSample(0.8, -0.6);
    expect(dsp.outputLeft).toBe(0.5);
    processConstant(dsp, decayFrames);
    expect(dsp.outputLeft).toBeCloseTo(0.15, 7);
    expect(processConstant(dsp, 400).every((sample) => Math.abs(sample - 0.15) < 1e-7)).toBe(true);
    dsp.setParameters({ frozen: false });
    processConstant(dsp, dsp.officialReleaseFrames);
    expect(dsp.outputLeft).toBe(0);
  });

  it.each(['attack', 'decay', 'sustain', 'release'] as const)('%s independently changes rendered audio', (control) => {
    const render = (value: number): Float32Array => {
      const parameters = { attack: 0, decay: 0, sustain: 50, release: 0, [control]: value };
      const dsp = captured(parameters);
      if (control === 'release') {
        processConstant(dsp, 400);
        dsp.setParameters({ frozen: false });
      }
      return processConstant(dsp, 400);
    };
    const minimum = render(0);
    const maximum = render(100);
    let absoluteDifference = 0;
    for (let frame = 0; frame < minimum.length; frame += 1) {
      absoluteDifference += Math.abs(minimum[frame]! - maximum[frame]!);
    }
    expect(absoluteDifference).toBeGreaterThan(10);
  });

  it('clamps finite native values and ignores non-finite edits without poisoning the envelope', () => {
    const clamped = captured({ attack: -100, decay: -1, sustain: 200, release: 500 });
    const reference = captured({ attack: 0, decay: 0, sustain: 100, release: 100 });
    clamped.setOfficialParameters({ attack: NaN, decay: Infinity, sustain: -Infinity, release: NaN });
    expect(clamped.officialReleaseFrames).toBe(SAMPLE_RATE * 5);
    expect(processConstant(clamped, 400)).toEqual(processConstant(reference, 400));
    clamped.setParameters({ frozen: false });
    reference.setParameters({ frozen: false });
    expect(processConstant(clamped, SAMPLE_RATE * 5 + 1)).toEqual(processConstant(reference, SAMPLE_RATE * 5 + 1));
    expect(clamped.outputLeft).toBe(0);
    expect(clamped.hasFrozenBuffer).toBe(false);
  });

  it('releases from the current attack or decay level without a gain jump', () => {
    for (const stage of ['attack', 'decay']) {
      const dsp = captured({ attack: stage === 'attack' ? 100 : 0, decay: 100, sustain: 20, release: 0 });
      processConstant(dsp, stage === 'attack' ? 100 : 500);
      const gainBeforeRelease = dsp.diagnostics.activationGain;
      expect(gainBeforeRelease).toBeGreaterThan(0);
      expect(gainBeforeRelease).toBeLessThan(1);
      dsp.setParameters({ frozen: false });
      dsp.processSample(0.8, -0.6);
      expect(dsp.outputLeft).toBeCloseTo(0.5 * gainBeforeRelease * (1 - 1 / dsp.officialReleaseFrames), 10);
      processConstant(dsp, dsp.officialReleaseFrames - 1);
      expect(dsp.outputLeft).toBe(0);
      expect(dsp.hasFrozenBuffer).toBe(false);
    }
  });

  it('finishes an old release before a retrigger swaps to fresh history and restarts attack', () => {
    const dsp = captured({ attack: 0, decay: 0, sustain: 100, release: 30 });
    processConstant(dsp, 400, 0.2, -0.1);
    dsp.setParameters({ frozen: false });
    processConstant(dsp, 5, 0.2, -0.1);
    dsp.setParameters({ frozen: true });
    expect(dsp.diagnostics.capturePending).toBe(true);
    processConstant(dsp, dsp.officialReleaseFrames - 6, 0.2, -0.1);
    expect(dsp.diagnostics.capturePending).toBe(true);
    expect(dsp.outputLeft).toBeCloseTo(0.5 / dsp.officialReleaseFrames, 7);
    dsp.processSample(0.2, -0.1);
    expect(dsp.outputLeft).toBe(0);
    expect(dsp.diagnostics.capturePending).toBe(true);
    dsp.processSample(0.2, -0.1);
    expect(dsp.diagnostics.capturePending).toBe(false);
    expect(dsp.outputLeft).toBeCloseTo(0.2 / 16, 7);
    processConstant(dsp, 100, 0.9, -0.9);
    expect(dsp.outputLeft).toBeCloseTo(0.2, 7);
    expect(dsp.outputRight).toBeCloseTo(-0.1, 7);
  });

  it('does not restart a ramp when identical official parameters are repeatedly applied', () => {
    const parameters = { attack: 30, decay: 30, sustain: 30, release: 30 };
    const repeatedlySet = captured(parameters);
    const reference = captured(parameters);
    for (let frame = 0; frame < 1000; frame += 1) {
      if (frame === 700) {
        repeatedlySet.setParameters({ frozen: false });
        reference.setParameters({ frozen: false });
      }
      repeatedlySet.setOfficialParameters(parameters);
      repeatedlySet.processSample(0.8, -0.6);
      reference.processSample(0.8, -0.6);
      expect(repeatedlySet.outputLeft).toBe(reference.outputLeft);
      expect(repeatedlySet.outputRight).toBe(reference.outputRight);
    }
    expect(repeatedlySet.hasFrozenBuffer).toBe(false);
  });

  it('remains identical with arbitrary blocks, sample processing and in-place arrays', () => {
    const totalFrames = 5000;
    const render = (blockSizes: readonly number[], inPlace: boolean, sampleBySample = false) => {
      const dsp = new BrowserFreezeDsp(SAMPLE_RATE, { captureLengthMs: 50 });
      dsp.setOfficialParameters({ attack: 45, decay: 35, sustain: 40, release: 50 });
      const inputLeft = Float32Array.from({ length: totalFrames }, (_, frame) => 0.6 * Math.sin(frame * 0.07));
      const inputRight = Float32Array.from({ length: totalFrames }, (_, frame) => 0.4 * Math.cos(frame * 0.037));
      const left = inPlace ? inputLeft : new Float32Array(totalFrames);
      const right = inPlace ? inputRight : new Float32Array(totalFrames);
      const ends = [100, 1200, 1250, 1800, 2800, totalFrames];
      let offset = 0;
      let block = 0;
      for (const end of ends) {
        if (offset === 100 || offset === 1250) dsp.setParameters({ frozen: true });
        if (offset === 1200 || offset === 2800) dsp.setParameters({ frozen: false });
        if (offset === 1800) dsp.setOfficialParameters({ decay: 55, sustain: 60 });
        while (offset < end) {
          const length = sampleBySample ? 1 : Math.min(blockSizes[block % blockSizes.length]!, end - offset);
          if (sampleBySample) {
            dsp.processSample(inputLeft[offset]!, inputRight[offset]!);
            left[offset] = dsp.outputLeft;
            right[offset] = dsp.outputRight;
          } else {
            dsp.processBlock(inputLeft.subarray(offset, offset + length), inputRight.subarray(offset, offset + length),
              left.subarray(offset, offset + length), right.subarray(offset, offset + length));
          }
          offset += length;
          block += 1;
        }
      }
      return { left, right, diagnostics: dsp.diagnostics };
    };
    const whole = render([totalFrames], false);
    expect(render([1, 31, 128, 257, 3, 511, 17], true)).toEqual(whole);
    expect(render([1], false, true)).toEqual(whole);
  });

  it('keeps pathological inputs bounded and resets ring/envelope state while preserving controls', () => {
    const dsp = new BrowserFreezeDsp(SAMPLE_RATE, { captureLengthMs: 2 });
    dsp.setOfficialParameters({ attack: 0, decay: 0, sustain: 0, release: 100 });
    type Storage = { historyLeft: Float32Array; historyRight: Float32Array; loopLeft: Float32Array; loopRight: Float32Array };
    const storage = dsp as unknown as Storage;
    const originalBuffers = [storage.historyLeft, storage.historyRight, storage.loopLeft, storage.loopRight];
    const pathological = [NaN, Infinity, -Infinity, 1e30, -1e30];
    dsp.setParameters({ frozen: true });
    for (let frame = 0; frame < 1000; frame += 1) {
      dsp.processSample(pathological[frame % pathological.length]!, pathological[(frame + 2) % pathological.length]!);
      expect(Number.isFinite(dsp.outputLeft)).toBe(true);
      expect(Number.isFinite(dsp.outputRight)).toBe(true);
      expect(Math.abs(dsp.outputLeft)).toBeLessThanOrEqual(8);
      expect(Math.abs(dsp.outputRight)).toBeLessThanOrEqual(8);
    }
    expect(dsp.diagnostics.activationGain).toBe(0);
    expect(dsp.isFrozen).toBe(true);
    expect(dsp.hasFrozenBuffer).toBe(true);
    dsp.reset();
    expect(dsp.diagnostics).toMatchObject({ activationGain: 0, targetFrozen: false, hasFrozenBuffer: false, historyFrames: 0, framesProcessed: 0 });
    expect(dsp.officialReleaseFrames).toBe(40000);
    for (const buffer of [storage.historyLeft, storage.historyRight, storage.loopLeft, storage.loopRight]) {
      expect(originalBuffers.includes(buffer)).toBe(true);
      expect(buffer.every((sample) => sample === 0)).toBe(true);
    }
    expect(processConstant(dsp, 16, 0.5, -0.25).every((sample) => sample === 0)).toBe(true);
    dsp.setParameters({ frozen: true });
    processConstant(dsp, 16);
    expect(dsp.outputLeft).toBe(0.5);
    processConstant(dsp, 80);
    expect(dsp.outputLeft).toBe(0);
    dsp.setParameters({ frozen: false });
    dsp.processSample(0.8, -0.6);
    expect(dsp.hasFrozenBuffer).toBe(false);
  });

  it('preserves the original legacy output bit-for-bit when official controls are untouched', () => {
    // Golden hashes captured from BrowserFreezeDsp before the official ADSR path
    // was added. Covers passthrough, pitched hold, release and a fast retrigger.
    const dsp = new BrowserFreezeDsp(SAMPLE_RATE, { captureLengthMs: 20 });
    const left = new Float32Array(1200);
    const right = new Float32Array(1200);
    for (let frame = 0; frame < left.length; frame += 1) {
      if (frame === 200) dsp.setParameters({ frozen: true, pitchSemitones: 7 });
      if (frame === 450 || frame === 900) dsp.setParameters({ frozen: false });
      if (frame === 457) dsp.setParameters({ frozen: true });
      dsp.processSample(((frame % 37) - 18) / 40, ((frame % 51) - 25) / 60);
      left[frame] = dsp.outputLeft;
      right[frame] = dsp.outputRight;
    }
    expect(floatHash(left)).toBe(1263996900);
    expect(floatHash(right)).toBe(3174964522);
  });
});
