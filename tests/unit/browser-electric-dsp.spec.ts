import { describe, expect, it } from 'vitest';
import { BrowserElectricDsp } from '../../src/audio/fx/dsp/BrowserElectricDsp';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

const SAMPLE_RATE = 48_000;

function tone(frequencyHz: number, frames: number, amplitude = 0.3): Float32Array {
  const result = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    result[frame] = amplitude * Math.sin((2 * Math.PI * frequencyHz * frame) / SAMPLE_RATE);
  }
  return result;
}

function renderCharacter(character: 0 | 1 | 2 | 3, input: Float32Array): Float32Array {
  const dsp = new BrowserElectricDsp(SAMPLE_RATE, {
    character,
    pitchSnapPercent: 100,
    toneHz: 12_000,
  });
  const output = new Float32Array(input.length);
  for (let frame = 0; frame < input.length; frame += 1) {
    const sample = input[frame] ?? 0;
    dsp.processSample(sample, sample);
    output[frame] = dsp.outputLeft;
  }
  expect(dsp.isVoiced).toBe(true);
  return output;
}

function renderWorklet(input: Float32Array, blockSizes: readonly number[]): Float32Array {
  const processor = new FxProcessor({
    processorOptions: {
      algorithm: 'electric',
      sampleRate: SAMPLE_RATE,
      bypassed: false,
      parameters: {
        electricCharacter: 0,
        electricPitchSnapPercent: 100,
        electricToneHz: 10_000,
        mix: 1,
      },
    },
  });
  const output = new Float32Array(input.length);
  let offset = 0;
  let block = 0;
  while (offset < input.length) {
    const length = Math.min(blockSizes[block % blockSizes.length] ?? input.length, input.length - offset);
    const inputView = input.subarray(offset, offset + length);
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    expect(processor.process([[inputView, inputView]], [[left, right]])).toBe(true);
    output.set(left, offset);
    offset += length;
    block += 1;
  }
  return output;
}

describe('clean-room Browser ELECTRIC DSP', () => {
  it('renders four distinct, finite character paths from the same voiced source', () => {
    const input = tone(442, SAMPLE_RATE);
    const outputs = ([0, 1, 2, 3] as const).map((character) => renderCharacter(character, input));
    for (const output of outputs) {
      expect([...output].every(Number.isFinite)).toBe(true);
      let peak = 0;
      for (const sample of output) peak = Math.max(peak, Math.abs(sample));
      expect(peak).toBeLessThanOrEqual(4);
    }

    for (let first = 0; first < outputs.length; first += 1) {
      for (let second = first + 1; second < outputs.length; second += 1) {
        let differenceEnergy = 0;
        for (let frame = 12_000; frame < input.length; frame += 1) {
          const difference = (outputs[first]?.[frame] ?? 0) - (outputs[second]?.[frame] ?? 0);
          differenceEnergy += difference * difference;
        }
        expect(differenceEnergy).toBeGreaterThan(0.05);
      }
    }
  });

  it('blends measured F0 toward the nearest semitone as pitch snap increases', () => {
    const input = tone(447, SAMPLE_RATE);
    const loose = new BrowserElectricDsp(SAMPLE_RATE, { character: 0, pitchSnapPercent: 0 });
    const snapped = new BrowserElectricDsp(SAMPLE_RATE, { character: 0, pitchSnapPercent: 100 });
    for (let frame = 0; frame < input.length; frame += 1) {
      const sample = input[frame] ?? 0;
      loose.processSample(sample, sample);
      snapped.processSample(sample, sample);
    }
    expect(snapped.isVoiced).toBe(true);
    expect(Math.abs(snapped.targetPitchHz - 440)).toBeLessThan(2);
    expect(Math.abs(loose.targetPitchHz - 440)).toBeGreaterThan(Math.abs(snapped.targetPitchHz - 440) + 3);
  });

  it('keeps unsupported Classic/Metallic input dry and exposes strict controls', () => {
    const core = new BrowserFxDspCore('electric', SAMPLE_RATE, {
      electricCharacter: 0,
      electricPitchSnapPercent: 100,
      electricToneHz: 1_200,
      mix: 1,
    });
    expect(core.algorithmicLatencySamples).toBe(2_868);
    core.setBypass(false, 0);
    const input = new Float32Array(4_096);
    let randomState = 0x6d2b79f5;
    for (let frame = 0; frame < input.length; frame += 1) {
      // Deterministic aperiodic material should not enter the voiced resynth path.
      randomState = (Math.imul(randomState ^ (randomState >>> 15), randomState | 1) + 0x6d2b79f5) | 0;
      input[frame] = ((randomState >>> 0) / 0xffffffff - 0.5) * 0.5;
    }
    const output = new Float32Array(input.length);
    core.processBlock(input, input, output, output, input.length, true);
    expect(output).toEqual(input);
    expect(() => core.setParameters({ electricCharacter: 4 })).toThrow(/character must be an integer from 0 to 3/);
    expect(() => core.setParameters({ electricPitchSnapPercent: 101 })).toThrow(/pitch snap must be from 0 to 100/);
    expect(() => core.setParameters({ electricToneHz: 99 })).toThrow(/tone cutoff must be from 100 to 16000/);
  });

  it('runs the AudioWorklet route identically across variable actual callback sizes', () => {
    const input = tone(447, 12_347, 0.25);
    const wholeBlock = renderWorklet(input, [input.length]);
    const variableBlocks = renderWorklet(input, [1, 17, 128, 257, 31, 511, 73]);
    expect(variableBlocks).toEqual(wholeBlock);
    expect([...variableBlocks].every(Number.isFinite)).toBe(true);
    let changed = false;
    for (let frame = 6_000; frame < input.length; frame += 1) {
      if (Math.abs((variableBlocks[frame] ?? 0) - (input[frame] ?? 0)) > 1e-3) {
        changed = true;
        break;
      }
    }
    expect(changed).toBe(true);
  });
});
