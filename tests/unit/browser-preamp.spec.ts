import { describe, expect, it } from 'vitest';
import { BrowserPreampDsp } from '../../src/audio/fx/dsp/BrowserPreampDsp';
import { BROWSER_FX_ALGORITHM_INFO, BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

function createTone(length: number, sampleRate: number, frequency: number, amplitude = 0.35): Float32Array {
  const samples = new Float32Array(length);
  for (let frame = 0; frame < length; frame += 1) {
    samples[frame] = amplitude * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
  }
  return samples;
}

function runStereo(
  core: BrowserFxDspCore,
  left: Float32Array,
  right: Float32Array,
  blockSizes: readonly number[] = [left.length],
): { left: Float32Array; right: Float32Array } {
  const outputLeft = new Float32Array(left.length);
  const outputRight = new Float32Array(right.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < left.length) {
    const requested = blockSizes[blockIndex % blockSizes.length] ?? left.length;
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
  return { left: outputLeft, right: outputRight };
}

function energy(samples: Float32Array, start: number): number {
  let total = 0;
  for (let frame = start; frame < samples.length; frame += 1) total += (samples[frame] ?? 0) ** 2;
  return total;
}

function toneMagnitude(samples: Float32Array, frequency: number, sampleRate: number, start: number, frames: number): number {
  let real = 0;
  let imaginary = 0;
  for (let frame = start; frame < start + frames; frame += 1) {
    const phase = (2 * Math.PI * frequency * frame) / sampleRate;
    const sample = samples[frame] ?? 0;
    real += sample * Math.cos(phase);
    imaginary -= sample * Math.sin(phase);
  }
  return (2 * Math.hypot(real, imaginary)) / frames;
}

function maxMagnitude(samples: Float32Array): number {
  let maximum = 0;
  for (const sample of samples) maximum = Math.max(maximum, Math.abs(sample));
  return maximum;
}

describe('clean-room Browser PREAMP', () => {
  it('declares the expected catalog mapping, algorithm, and FIR latency', () => {
    expect(BROWSER_FX_ALGORITHM_INFO.preamp).toMatchObject({
      catalogFunction: 'PREAMP (catalog ID 23)',
      formulaIds: ['F02', 'F07', 'F18', 'F23'],
      algorithmicLatencySamples: 16,
      impulseResponsePeakSamplesAt48k: 18,
      supportsDryWetMix: false,
    });
    expect(BROWSER_FX_ALGORITHM_INFO.preamp.cleanRoomProvenance).toContain('no Roland source');
    expect(BROWSER_FX_ALGORITHM_INFO.preamp.cleanRoomProvenance).toContain('129-tap cabinet response');
    expect(BROWSER_FX_ALGORITHM_INFO.preamp.cleanRoomProvenance).toContain('no wet/dry control');
  });

  it('is invariant to arbitrary callback sizes and keeps the stereo output finite and bounded', () => {
    const sampleRate = 48000;
    const left = createTone(4097, sampleRate, 439, 1.8);
    const right = createTone(4097, sampleRate, 653, 1.6);
    const parameters = {
      mix: 1,
      preampModel: 3,
      preampGainPercent: 100,
      preampBassDb: 12,
      preampMiddleDb: -12,
      preampTrebleDb: 12,
      preampLevelDb: 12,
    };
    const whole = runStereo(new BrowserFxDspCore('preamp', sampleRate, parameters), left, right);
    const split = runStereo(new BrowserFxDspCore('preamp', sampleRate, parameters), left, right, [1, 7, 64, 127, 257, 3, 511]);

    expect(whole.left).toEqual(split.left);
    expect(whole.right).toEqual(split.right);
    expect(maxMagnitude(whole.left)).toBeLessThanOrEqual(4);
    expect(maxMagnitude(whole.right)).toBeLessThanOrEqual(4);
    expect([...whole.left, ...whole.right].every(Number.isFinite)).toBe(true);
  });

  it('runs through FxProcessor at variable AudioWorklet quanta', () => {
    const sampleRate = 48000;
    const left = createTone(4097, sampleRate, 523, 0.8);
    const right = createTone(4097, sampleRate, 771, 0.6);
    const render = (blockSizes: readonly number[]) => {
      const processor = new FxProcessor({
        processorOptions: {
          algorithm: 'preamp',
          sampleRate,
          parameters: { preampModel: 2, preampGainPercent: 72, preampLevelDb: -2 },
          bypassed: false,
        },
      });
      const outputLeft = new Float32Array(left.length);
      const outputRight = new Float32Array(right.length);
      let offset = 0;
      let block = 0;
      while (offset < left.length) {
        const frames = Math.min(blockSizes[block % blockSizes.length] ?? left.length, left.length - offset);
        const outputChannels = [outputLeft.subarray(offset, offset + frames), outputRight.subarray(offset, offset + frames)];
        expect(processor.process(
          [[left.subarray(offset, offset + frames), right.subarray(offset, offset + frames)]],
          [outputChannels],
        )).toBe(true);
        offset += frames;
        block += 1;
      }
      return { left: outputLeft, right: outputRight };
    };
    const whole = render([left.length]);
    const split = render([1, 7, 64, 127, 257, 3, 511]);
    expect(split.left).toEqual(whole.left);
    expect(split.right).toEqual(whole.right);
    expect(whole.left.some((sample) => sample !== 0)).toBe(true);
  });

  it('rejects high-frequency nonlinear aliases against a single-rate waveshaper reference', () => {
    const sampleRate = 48000;
    const frames = 32768;
    const analysisStart = 4096;
    const analysisFrames = 16384;
    const fundamental = 10500;
    const aliases = [1500, 4500, 7500, 13500, 16500, 19500, 22500] as const;
    const input = createTone(frames, sampleRate, fundamental, 0.5);
    const processed = runStereo(
      new BrowserFxDspCore('preamp', sampleRate, {
        mix: 1, preampModel: 0, preampGainPercent: 100,
        preampBassDb: 0, preampMiddleDb: 0, preampTrebleDb: 0, preampLevelDb: 0,
      }),
      input,
      new Float32Array(frames),
    ).left;

    // Reference: the same authored clean-style static transfer at 1x, where
    // harmonics above Nyquist fold into audible base-band alias bins.
    const drive = 0.78 * 29;
    const shape = 1.2;
    const nonlinearBlend = 0.68;
    const singleRateReference = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const sample = input[frame] ?? 0;
      singleRateReference[frame] = sample * (1 - nonlinearBlend)
        + (Math.tanh(shape * drive * sample) / shape) * nonlinearBlend;
    }

    // Measure the clean-room post-stage tone/cab response at small signal so
    // the alias-band comparison accounts for speaker/EQ coloration by bin.
    const linearTransfer = (frequency: number): number => {
      const linearPath = new BrowserPreampDsp(sampleRate, { model: 0, gainPercent: 0 });
      const output = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        const sample = 0.001 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
        linearPath.processSample(sample, sample);
        output[frame] = linearPath.outputLeft;
      }
      return toneMagnitude(output, frequency, sampleRate, analysisStart, analysisFrames) / 0.001;
    };
    const fundamentalTransfer = linearTransfer(fundamental);
    const referenceAliasRatioSquared = aliases.reduce((sum, frequency) => {
      const inputAliasMagnitude = toneMagnitude(singleRateReference, frequency, sampleRate, analysisStart, analysisFrames);
      const postStageTransfer = linearTransfer(frequency);
      const correctedAlias = inputAliasMagnitude * (postStageTransfer / fundamentalTransfer);
      return sum + correctedAlias * correctedAlias;
    }, 0) / toneMagnitude(singleRateReference, fundamental, sampleRate, analysisStart, analysisFrames) ** 2;
    const actualAliasRatioSquared = aliases.reduce((sum, frequency) => {
      const magnitude = toneMagnitude(processed, frequency, sampleRate, analysisStart, analysisFrames);
      return sum + magnitude * magnitude;
    }, 0) / toneMagnitude(processed, fundamental, sampleRate, analysisStart, analysisFrames) ** 2;

    expect(Math.sqrt(actualAliasRatioSquared)).toBeLessThan(Math.sqrt(referenceAliasRatioSquared) * 0.05);
  });

  it('distinguishes fixed 16-sample oversampling latency from the 18-sample full impulse peak', () => {
    const sampleRate = 48000;
    const core = new BrowserFxDspCore('preamp', sampleRate);
    const impulse = new Float32Array(128);
    impulse[0] = 1;
    const output = new Float32Array(impulse.length);
    core.processBlock(impulse, null, output, null);
    let peakIndex = 0;
    for (let frame = 1; frame < output.length; frame += 1) {
      if (Math.abs(output[frame] ?? 0) > Math.abs(output[peakIndex] ?? 0)) peakIndex = frame;
    }
    expect(core.algorithmicLatencySamples).toBe(16);
    expect(BROWSER_FX_ALGORITHM_INFO.preamp.impulseResponsePeakSamplesAt48k).toBe(18);
    expect(peakIndex).toBe(18);
  });

  it('has no wet/dry control in its effect contract', () => {
    const sampleRate = 48000;
    const left = createTone(1024, sampleRate, 1700, 0.35);
    const right = createTone(1024, sampleRate, 2300, 0.27);
    const render = (mix: number) => runStereo(
      new BrowserFxDspCore('preamp', sampleRate, { mix, preampModel: 2, preampGainPercent: 55 }),
      left,
      right,
    );
    const noMix = render(0);
    const midMix = render(0.5);
    const fullMix = render(1);
    expect(noMix.left).toEqual(midMix.left);
    expect(noMix.left).toEqual(fullMix.left);
    expect(noMix.right).toEqual(fullMix.right);
  });

  it('changes voicing, nonlinear drive, tone stack, and output level', () => {
    const sampleRate = 48000;
    const left = createTone(12000, sampleRate, 220, 0.4);
    const right = new Float32Array(left.length);
    const render = (parameters: ConstructorParameters<typeof BrowserFxDspCore>[2]) => runStereo(
      new BrowserFxDspCore('preamp', sampleRate, { mix: 1, ...parameters }),
      left,
      right,
    ).left;

    const lowDrive = render({ preampModel: 0, preampGainPercent: 0, preampBassDb: 0, preampMiddleDb: 0, preampTrebleDb: 0, preampLevelDb: 0 });
    const highDrive = render({ preampModel: 0, preampGainPercent: 100, preampBassDb: 0, preampMiddleDb: 0, preampTrebleDb: 0, preampLevelDb: 0 });
    const leadModel = render({ preampModel: 3, preampGainPercent: 100, preampBassDb: 0, preampMiddleDb: 0, preampTrebleDb: 0, preampLevelDb: 0 });
    const boostedTone = render({ preampModel: 0, preampGainPercent: 0, preampBassDb: 12, preampMiddleDb: 0, preampTrebleDb: 0, preampLevelDb: 0 });
    const raisedLevel = render({ preampModel: 0, preampGainPercent: 0, preampBassDb: 0, preampMiddleDb: 0, preampTrebleDb: 0, preampLevelDb: 12 });

    expect(Math.abs(energy(lowDrive, 512) - energy(highDrive, 512))).toBeGreaterThan(0.1);
    expect(Math.abs(energy(highDrive, 512) - energy(leadModel, 512))).toBeGreaterThan(0.01);
    expect(energy(boostedTone, 512)).toBeGreaterThan(energy(lowDrive, 512));
    expect(energy(raisedLevel, 512)).toBeGreaterThan(energy(lowDrive, 512));
  });

  it('has a measurable speaker-cabinet high-frequency rolloff', () => {
    const sampleRate = 48000;
    const frames = 16384;
    const renderTone = (frequency: number): Float32Array => {
      const processor = new BrowserPreampDsp(sampleRate, { model: 0, gainPercent: 0 });
      const input = createTone(frames, sampleRate, frequency, 0.001);
      const output = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        processor.processSample(input[frame] ?? 0, input[frame] ?? 0);
        output[frame] = processor.outputLeft;
      }
      return output;
    };
    const lowBand = toneMagnitude(renderTone(1500), 1500, sampleRate, 4096, 8192);
    const highBand = toneMagnitude(renderTone(10500), 10500, sampleRate, 4096, 8192);
    expect(highBand).toBeLessThan(lowBand * 0.25);
  });

  it('resets oversampling and cabinet history without changing its fixed resource policy', () => {
    const processor = new BrowserPreampDsp(48000, { gainPercent: 80 });
    for (let frame = 0; frame < 400; frame += 1) processor.processSample(0.5, -0.25);
    processor.reset();
    expect(processor.outputLeft).toBe(0);
    expect(processor.outputRight).toBe(0);
    for (let frame = 0; frame < 32; frame += 1) processor.processSample(0, 0);
    expect(processor.outputLeft).toBe(0);
    expect(processor.outputRight).toBe(0);
  });
});
