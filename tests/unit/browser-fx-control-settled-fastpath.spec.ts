import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore, type BrowserFxAlgorithm } from '../../src/audio/fx/dsp/BrowserFxDspCore';

type LegacySmootherState = {
  current: number;
  target: number;
  oneMinusAlpha: number;
  next: () => number;
};

type CorePair = { optimized: BrowserFxDspCore; reference: BrowserFxDspCore };

function getExponentialSmoother(core: BrowserFxDspCore, name: string): LegacySmootherState & { settled: boolean } {
  return (core as unknown as Record<string, LegacySmootherState & { settled: boolean }>)[name] as LegacySmootherState & { settled: boolean };
}

const advanceControlSmootherNames = [
  'cutoff', 'q', 'wet', 'decaySeconds', 'dampingHz', 'ringModHz', 'ringModDepth', 'driveDb', 'outputDb',
  'flangerDelayMs', 'flangerDepth', 'flangerRateHz', 'flangerFeedback', 'dynamicsThreshold', 'dynamicsRatio',
  'dynamicsKnee', 'dynamicsAttackMs', 'dynamicsReleaseMs', 'delayTimeMs', 'delayFeedback', 'delayToneHz',
  'chorusDelayMs', 'chorusRateHz', 'chorusDepthMs', 'chorusFeedback', 'chorusToneHz', 'phaserRateHz',
  'phaserDepth', 'phaserFeedback', 'tremoloRateHz', 'tremoloDepth', 'autoPanRateHz', 'autoPanDepth',
  'stereoWidth', 'stereoLowMonoCutoffHz', 'stereoDecorrelation',
] as const;

/** Restore the exact unconditional recurrence used at HEAD on a reference core. */
function forceLegacySmootherPath(core: BrowserFxDspCore): number {
  const internals = core as unknown as Record<string, unknown>;
  let patched = 0;
  for (const value of Object.values(internals)) {
    if (!value || typeof value !== 'object') continue;
    const smoother = value as Partial<LegacySmootherState>;
    if (typeof smoother.current !== 'number'
        || typeof smoother.target !== 'number'
        || typeof smoother.oneMinusAlpha !== 'number'
        || typeof smoother.next !== 'function') continue;
    smoother.next = function legacyNext(this: LegacySmootherState): number {
      this.current += (this.target - this.current) * this.oneMinusAlpha;
      return this.current;
    };
    patched += 1;
  }
  return patched;
}

function createPair(algorithm: BrowserFxAlgorithm, sampleRate = 48000): CorePair {
  const optimized = new BrowserFxDspCore(algorithm, sampleRate);
  const reference = new BrowserFxDspCore(algorithm, sampleRate);
  (reference as unknown as { settledControlFastPathEnabled: boolean }).settledControlFastPathEnabled = false;
  expect(forceLegacySmootherPath(reference)).toBeGreaterThan(0);
  return { optimized, reference };
}

function makeSignal(frames: number, startFrame: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const position = startFrame + frame;
    left[frame] = (position % 997 === 0 ? 0.8 : 0)
      + 0.27 * Math.sin((2 * Math.PI * 997 * position) / 48000);
    right[frame] = (position % 1237 === 0 ? -0.5 : 0)
      + 0.23 * Math.sin((2 * Math.PI * 613 * position) / 48000);
  }
  return { left, right };
}

function bits(samples: Float32Array): Uint32Array {
  return new Uint32Array(samples.buffer, samples.byteOffset, samples.length);
}

function processPaired(
  pair: CorePair,
  frames: number,
  blockSizes: readonly number[],
  startFrame = 0,
): { left: Float32Array; right: Float32Array } {
  const input = makeSignal(frames, startFrame);
  const optimizedLeft = new Float32Array(frames);
  const optimizedRight = new Float32Array(frames);
  const referenceLeft = new Float32Array(frames);
  const referenceRight = new Float32Array(frames);
  let offset = 0;
  let blockIndex = 0;
  while (offset < frames) {
    const length = Math.min(blockSizes[blockIndex % blockSizes.length] ?? frames, frames - offset);
    pair.optimized.processBlock(
      input.left.subarray(offset, offset + length), input.right.subarray(offset, offset + length),
      optimizedLeft.subarray(offset, offset + length), optimizedRight.subarray(offset, offset + length), length,
    );
    pair.reference.processBlock(
      input.left.subarray(offset, offset + length), input.right.subarray(offset, offset + length),
      referenceLeft.subarray(offset, offset + length), referenceRight.subarray(offset, offset + length), length,
    );
    offset += length;
    blockIndex += 1;
  }
  expect(bits(optimizedLeft)).toEqual(bits(referenceLeft));
  expect(bits(optimizedRight)).toEqual(bits(referenceRight));
  return { left: optimizedLeft, right: optimizedRight };
}

const controlRamp = {
  cutoffHz: 8700,
  q: 8.5,
  mix: 0.61,
  decaySeconds: 7.2,
  dampingHz: 2600,
  ringModHz: 1720,
  ringModDepth: 0.37,
  driveDb: 28,
  outputDb: -6,
  flangerDelayMs: 5.3,
  flangerDepth: 0.74,
  flangerRateHz: 4.1,
  flangerFeedback: -0.51,
  thresholdDb: -33,
  ratio: 7.5,
  kneeDb: 16,
  attackMs: 24,
  releaseMs: 290,
  delayTimeMs: 311,
  delayFeedback: 0.71,
  delayToneHz: 7200,
  chorusDelayMs: 23,
  chorusRateHz: 3.2,
  chorusDepthMs: 14,
  chorusFeedback: 0.41,
  chorusToneHz: 6200,
  phaserRateHz: 7.1,
  phaserDepth: 0.73,
  phaserFeedback: 0.57,
  tremoloRateHz: 8.2,
  tremoloDepth: 0.66,
  autoPanRateHz: 6.4,
  autoPanDepth: 0.69,
  stereoWidth: 1.72,
  stereoLowMonoCutoffHz: 430,
  stereoDecorrelation: 0.81,
};

describe('Browser FX settled smoother fast path', () => {
  it('matches the original output bits for static controls and irregular block sizes', () => {
    const pair = createPair('lpf');
    processPaired(pair, 8192, [1, 31, 257, 3, 64, 1024]);
    expect((pair.optimized as unknown as { controlsSteady: boolean }).controlsSteady).toBe(true);
    expect(getExponentialSmoother(pair.optimized, 'cutoff').settled).toBe(true);
    expect(advanceControlSmootherNames).toHaveLength(36);
    expect(advanceControlSmootherNames.every((name) => getExponentialSmoother(pair.optimized, name).settled)).toBe(true);
    pair.optimized.setParameters({ cutoffHz: 1200 });
    pair.reference.setParameters({ cutoffHz: 1200 });
    processPaired(pair, 2049, [5, 256, 1, 77], 8192);
  });

  it('matches original output bits through active ramps, changed targets, reset, and resumed ramps', () => {
    const pair = createPair('lpf');
    const irregularBlocks = [1, 13, 255, 17, 4096, 2, 64];
    pair.optimized.setParameters(controlRamp);
    pair.reference.setParameters(controlRamp);
    processPaired(pair, 4099, irregularBlocks, 0);
    expect(getExponentialSmoother(pair.optimized, 'cutoff').current).toBeGreaterThan(1200);
    expect(getExponentialSmoother(pair.optimized, 'cutoff').current).toBeLessThan(controlRamp.cutoffHz);

    // Redirect several active controls while blocks continue to vary.
    const secondRamp = { ...controlRamp, cutoffHz: 1450, mix: 0.92, outputDb: 3, delayTimeMs: 27, stereoWidth: 0.58 };
    pair.optimized.setParameters(secondRamp);
    pair.reference.setParameters(secondRamp);
    expect((pair.optimized as unknown as { controlsSteady: boolean }).controlsSteady).toBe(false);
    processPaired(pair, 50000, irregularBlocks, 4099);
    expect((pair.optimized as unknown as { controlsSteady: boolean }).controlsSteady).toBe(true);
    expect(getExponentialSmoother(pair.optimized, 'cutoff').settled).toBe(true);

    pair.optimized.reset();
    pair.reference.reset();
    processPaired(pair, 1027, [511, 1, 7, 128], 54099);
    expect(getExponentialSmoother(pair.optimized, 'cutoff').settled).toBe(true);

    // A genuinely new target after reset invalidates a cached settled value.
    const thirdRamp = { ...secondRamp, cutoffHz: 7600, q: 1.15, mix: 0.18, stereoDecorrelation: 0.12 };
    pair.optimized.setParameters(thirdRamp);
    pair.reference.setParameters(thirdRamp);
    expect(getExponentialSmoother(pair.optimized, 'cutoff').settled).toBe(false);
    processPaired(pair, 3301, [3, 1024, 29, 2, 127], 55126);
  });

  it('matches original output bits as selected algorithms are replaced', () => {
    // The algorithm is immutable per core. These fresh instances exercise each
    // algorithm-specific coefficient/phase branch used by advanceControls.
    const algorithms: BrowserFxAlgorithm[] = [
      'lpf', 'ring-mod', 'distortion', 'dynamics', 'delay', 'chorus',
      'phaser', 'tremolo', 'auto-pan', 'reverb', 'gate-reverb', 'stereo-enhance',
    ];
    let frame = 0;
    for (const algorithm of algorithms) {
      const pair = createPair(algorithm);
      pair.optimized.setParameters(controlRamp);
      pair.reference.setParameters(controlRamp);
      processPaired(pair, 333, [1, 12, 127, 5], frame);
      frame += 333;
    }
  });

  it('keeps the coefficient countdown phase when a settled core receives new controls', () => {
    const pair = createPair('reverb');
    processPaired(pair, 8192, [128]);
    expect((pair.optimized as unknown as { controlsSteady: boolean }).controlsSteady).toBe(true);

    // Move off the coefficient refresh boundary before changing parameters.
    // The optimized and reference paths must still update the coefficient on
    // the same future sample while resuming exponential ramps.
    processPaired(pair, 7, [7], 8192);
    pair.optimized.setParameters({ decaySeconds: 7.5, dampingHz: 2470, mix: 0.63 });
    pair.reference.setParameters({ decaySeconds: 7.5, dampingHz: 2470, mix: 0.63 });
    processPaired(pair, 24000, [1, 257, 13, 64, 511], 8199);
    expect((pair.optimized as unknown as { controlsSteady: boolean }).controlsSteady).toBe(true);
  });

  it('waits for the tremolo waveform crossfade before caching steady controls', () => {
    const pair = createPair('tremolo');
    pair.optimized.setParameters({ tremoloWaveform: 'square' });
    pair.reference.setParameters({ tremoloWaveform: 'square' });
    processPaired(pair, 2048, [1, 31, 257, 3, 64]);
    expect((pair.optimized as unknown as { controlsSteady: boolean }).controlsSteady).toBe(true);
    expect((pair.optimized as unknown as { tremoloWaveformBlendValue: number }).tremoloWaveformBlendValue).toBe(1);
  });
});
