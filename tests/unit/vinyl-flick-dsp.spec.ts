import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BrowserVinylFlickDsp } from '../../src/audio/fx/dsp/BrowserVinylFlickDsp';

function runStereo(
  core: BrowserFxDspCore,
  left: Float32Array,
  right: Float32Array,
  blockSizes?: readonly number[],
): [Float32Array, Float32Array] {
  const outputLeft = new Float32Array(left.length);
  const outputRight = new Float32Array(right.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < left.length) {
    const requested = blockSizes?.[blockIndex % blockSizes.length] ?? left.length;
    const frames = Math.min(Math.max(1, requested), left.length - offset);
    core.processBlock(
      left.subarray(offset, offset + frames),
      right.subarray(offset, offset + frames),
      outputLeft.subarray(offset, offset + frames),
      outputRight.subarray(offset, offset + frames),
      frames,
    );
    offset += frames;
    blockIndex += 1;
  }
  return [outputLeft, outputRight];
}

describe('clean-room Browser VINYL FLICK', () => {
  it('keeps the neutral 1x path stereo-aligned with its two-sample dry lookahead', () => {
    const dsp = new BrowserVinylFlickDsp(8000);
    const left = [0.1, 0.2, -0.35, 0.4, 0.7];
    const right = [-0.4, 0.3, 0.5, -0.2, 0.15];

    for (let frame = 0; frame < left.length; frame += 1) {
      dsp.processSample(left[frame]!, right[frame]!);
      if (frame < 2) {
        expect(dsp.dryLeft).toBe(0);
        expect(dsp.wetLeft).toBe(0);
      } else {
        expect(dsp.dryLeft).toBeCloseTo(left[frame - 2]!, 7);
        expect(dsp.dryRight).toBeCloseTo(right[frame - 2]!, 7);
        expect(dsp.wetLeft).toBeCloseTo(dsp.dryLeft, 7);
        expect(dsp.wetRight).toBeCloseTo(dsp.dryRight, 7);
      }
    }
    expect(dsp.algorithmicLatencySamples).toBe(2);
    expect(dsp.diagnostics.speedTargetRate).toBe(1);
  });

  it('interpolates fractional ramp and low-frequency sine reads at the forward read position', () => {
    const sampleRate = 8000;
    const rampDsp = new BrowserVinylFlickDsp(sampleRate, {
      speed: -20,
      returnTimeSeconds: 0.05,
      brakePercent: 100,
    });
    const rampSlope = 0.00001;
    let rampMaxError = 0;
    for (let frame = 0; frame < 4500; frame += 1) {
      const readPosition = rampDsp.diagnostics.readPosition;
      rampDsp.processSample(frame * rampSlope, -(frame * rampSlope));
      if (frame > 4000) {
        rampMaxError = Math.max(rampMaxError, Math.abs(rampDsp.wetLeft - (readPosition * rampSlope)));
      }
    }
    expect(rampDsp.diagnostics.motorRate).toBeCloseTo(0.8, 2);
    expect(rampMaxError).toBeLessThan(2e-7);

    const sineDsp = new BrowserVinylFlickDsp(sampleRate, {
      speed: -20,
      returnTimeSeconds: 0.05,
      brakePercent: 100,
    });
    const frequencyHz = 30;
    let sineMaxError = 0;
    for (let frame = 0; frame < 4500; frame += 1) {
      const readPosition = sineDsp.diagnostics.readPosition;
      sineDsp.processSample(
        0.3 * Math.sin((2 * Math.PI * frequencyHz * frame) / sampleRate),
        0.2 * Math.cos((2 * Math.PI * frequencyHz * frame) / sampleRate),
      );
      if (frame > 4000) {
        const expected = 0.3 * Math.sin((2 * Math.PI * frequencyHz * readPosition) / sampleRate);
        sineMaxError = Math.max(sineMaxError, Math.abs(sineDsp.wetLeft - expected));
      }
    }
    expect(sineMaxError).toBeLessThan(2e-5);
  });

  it('models stall, forward recovery, and accelerated speed without reverse playback', () => {
    const sampleRate = 8000;
    const dsp = new BrowserVinylFlickDsp(sampleRate, {
      speed: -100,
      returnTimeSeconds: 0.05,
      brakePercent: 100,
    });
    for (let frame = 0; frame < sampleRate; frame += 1) dsp.processSample(0.25, -0.15);
    expect(dsp.diagnostics.speedTargetRate).toBe(0);
    expect(Math.abs(dsp.diagnostics.motorRate)).toBeLessThan(0.02);

    dsp.setParameters({ speed: 0 });
    for (let frame = 0; frame < sampleRate; frame += 1) dsp.processSample(0.25, -0.15);
    expect(dsp.diagnostics.motorRate).toBeCloseTo(1, 2);

    dsp.setParameters({ speed: 100 });
    for (let frame = 0; frame < sampleRate; frame += 1) dsp.processSample(0.25, -0.15);
    expect(dsp.diagnostics.motorRate).toBeCloseTo(2, 2);

    // A live insert cannot read future source frames. At a sustained >1x
    // target the head reaches the two-sample causal boundary, then safely
    // follows the newest available input instead of reading uninitialized
    // memory or pretending that a live loop is available.
    const accelerated = new BrowserVinylFlickDsp(sampleRate, {
      speed: 100,
      returnTimeSeconds: 0.05,
      brakePercent: 100,
    });
    let liveEdgeError = 0;
    for (let frame = 0; frame < sampleRate; frame += 1) {
      const sample = frame * 0.0001;
      accelerated.processSample(sample, -sample);
      if (frame > 32) liveEdgeError = Math.max(liveEdgeError, Math.abs(accelerated.wetLeft - ((frame - 2) * 0.0001)));
    }
    expect(accelerated.diagnostics.motorRate).toBeCloseTo(2, 2);
    expect(accelerated.diagnostics.readPosition).toBe(accelerated.diagnostics.framesProcessed - 2);
    expect(liveEdgeError).toBeLessThan(1e-6);
    accelerated.setParameters({ speed: 0 });
    for (let frame = 0; frame < sampleRate; frame += 1) accelerated.processSample(0, 0);
    expect(accelerated.diagnostics.motorRate).toBeCloseTo(1, 2);

    const stopped = new BrowserVinylFlickDsp(sampleRate, {
      speed: -100,
      returnTimeSeconds: 0.2,
      brakePercent: 0,
    });
    for (let frame = 0; frame < sampleRate; frame += 1) {
      stopped.processSample(0.2 * Math.sin(frame * 0.03), 0.1 * Math.cos(frame * 0.02));
      expect(stopped.diagnostics.motorRate).toBeGreaterThanOrEqual(0);
    }
    expect(stopped.diagnostics.motorRate).toBeLessThan(0.01);
    stopped.setParameters({ speed: 50 });
    for (let frame = 0; frame < sampleRate; frame += 1) {
      stopped.processSample(0.2 * Math.sin(frame * 0.03), 0.1 * Math.cos(frame * 0.02));
      expect(stopped.diagnostics.motorRate).toBeGreaterThanOrEqual(0);
    }
    expect(stopped.diagnostics.motorRate).toBeCloseTo(1.5, 1);
  });

  it('uses a bounded phase slip to keep long slow and stalled playback audible', () => {
    const sampleRate = 8000;
    const slow = new BrowserVinylFlickDsp(sampleRate, {
      speed: -50,
      returnTimeSeconds: 0.05,
      brakePercent: 100,
    });
    let nonSilentSamples = 0;
    // Half-speed consumes a 4 s ring after about 8 s, then should phase-slip
    // and continue instead of silently losing its head at the overwritten edge.
    const totalFrames = sampleRate * 10;
    for (let frame = 0; frame < totalFrames; frame += 1) {
      const sample = 0.25 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate);
      slow.processSample(sample, sample * -0.6);
      if (frame > sampleRate * 5 && Math.abs(slow.wetLeft) > 1e-4) nonSilentSamples += 1;
      if (frame % 4096 === 0) {
        expect(Number.isFinite(slow.wetLeft)).toBe(true);
        expect(Number.isFinite(slow.wetRight)).toBe(true);
      }
    }
    expect(slow.diagnostics.maxHistoryFrames).toBe(sampleRate * 4);
    expect(slow.diagnostics.phaseSlipCount).toBeGreaterThan(0);
    expect(nonSilentSamples).toBeGreaterThan(sampleRate / 2);

    slow.setParameters({ speed: -100 });
    for (let frame = 0; frame < totalFrames; frame += 1) slow.processSample(0.25, -0.15);
    expect(slow.diagnostics.phaseSlipCount).toBeGreaterThan(1);
    expect(Math.max(Math.abs(slow.wetLeft), Math.abs(slow.wetRight))).toBeGreaterThan(0.1);
  });

  it('is block-size invariant, handles reset, and sanitizes hostile stereo input in the core', () => {
    const sampleRate = 8000;
    const frames = 8000;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      left[frame] = 0.3 * Math.sin((2 * Math.PI * 311 * frame) / sampleRate);
      right[frame] = 0.2 * Math.cos((2 * Math.PI * 617 * frame) / sampleRate);
    }
    left[137] = Number.NaN;
    right[701] = Number.POSITIVE_INFINITY;
    const parameters = {
      vinylFlickSpeed: -20,
      vinylFlickReturnTimeSeconds: 0.2,
      vinylFlickBrakePercent: 65,
      mix: 1,
    };
    const wholeCore = new BrowserFxDspCore('vinyl-flick', sampleRate, parameters);
    const splitCore = new BrowserFxDspCore('vinyl-flick', sampleRate, parameters);
    wholeCore.setBypass(false, 0);
    splitCore.setBypass(false, 0);
    const whole = runStereo(wholeCore, left, right);
    const split = runStereo(splitCore, left, right, [1, 31, 128, 257, 3]);
    expect(split[0]).toEqual(whole[0]);
    expect(split[1]).toEqual(whole[1]);
    expect(whole[0].every(Number.isFinite)).toBe(true);
    expect(whole[1].every(Number.isFinite)).toBe(true);
    expect(wholeCore.algorithmicLatencySamples).toBe(2);
    expect(wholeCore.nonFiniteInputSamples).toBe(2);

    wholeCore.reset();
    const replay = runStereo(wholeCore, left, right, [7, 64, 13]);
    expect(replay[0]).toEqual(whole[0]);
    expect(replay[1]).toEqual(whole[1]);
  });
});
