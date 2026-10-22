import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BROWSER_PER_TRACK_PARAMETER_KEYS } from '../../src/audio/BrowserTrackFxChain';
import { getBrowserTrackFxControls, sanitizeBrowserTrackFxParameters } from '../../src/composables/browserTrackFxParameters';

function render(core: BrowserFxDspCore, frames: number, blocks: readonly number[] = [frames]): Float32Array {
  const input = new Float32Array(frames).fill(1);
  const output = new Float32Array(frames);
  const right = new Float32Array(frames).fill(1);
  const rightOutput = new Float32Array(frames);
  let offset = 0;
  let blockIndex = 0;
  while (offset < frames) {
    const block = Math.min(blocks[blockIndex % blocks.length] ?? frames, frames - offset);
    core.processBlock(
      input.subarray(offset, offset + block),
      right.subarray(offset, offset + block),
      output.subarray(offset, offset + block),
      rightOutput.subarray(offset, offset + block),
      block,
    );
    offset += block;
    blockIndex += 1;
  }
  return output;
}

function goertzelMagnitude(signal: Float32Array, begin: number, frames: number, bin: number): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * bin) / frames);
  let previous = 0;
  let previous2 = 0;
  for (let index = 0; index < frames; index += 1) {
    const current = (signal[begin + index] ?? 0) + coefficient * previous - previous2;
    previous2 = previous;
    previous = current;
  }
  const power = Math.max(0, previous * previous + previous2 * previous2 - coefficient * previous * previous2);
  return (2 * Math.sqrt(power)) / frames;
}

describe('RING.MOD carrier waveform contract', () => {
  it('exposes the catalog waveform choice through per-track controls with the sine default', () => {
    const controls = getBrowserTrackFxControls('RING.MOD');
    const waveform = controls.find(({ label }) => label === 'Carrier waveform');
    expect(waveform).toMatchObject({ key: 'ringModWaveform', min: 0, max: 1, defaultValue: 0, unit: 'choice' });
    expect(waveform?.options).toEqual([{ value: 0, label: 'Sine' }, { value: 1, label: 'Triangle' }]);
    expect(BROWSER_PER_TRACK_PARAMETER_KEYS['ring-mod']).toContain('ringModWaveform');
    expect(sanitizeBrowserTrackFxParameters('RING.MOD', { ringModWaveform: 1.8 })).toEqual({ ringModWaveform: 1 });
  });

  it('keeps default and explicit sine output bit-identical while triangle produces the selected carrier', () => {
    const defaultSine = new BrowserFxDspCore('ring-mod', 48000, { ringModHz: 440, ringModDepth: 1, mix: 1 });
    const explicitSine = new BrowserFxDspCore('ring-mod', 48000, { ringModHz: 440, ringModDepth: 1, mix: 1, ringModWaveform: 0 });
    const triangle = new BrowserFxDspCore('ring-mod', 48000, { ringModHz: 440, ringModDepth: 1, mix: 1, ringModWaveform: 1 });
    const sineOutput = render(defaultSine, 8192);
    const explicitSineOutput = render(explicitSine, 8192);
    const triangleOutput = render(triangle, 8192);
    expect([...explicitSineOutput]).toEqual([...sineOutput]);
    expect(triangleOutput.some((sample, index) => Math.abs(sample - sineOutput[index]!) > 1e-3)).toBe(true);
    expect([...triangleOutput].every(Number.isFinite)).toBe(true);
  });

  it('truncates triangle partials against the actual sample rate and smooths live waveform changes', () => {
    const sampleRate = 48000;
    const carrierHz = 6000;
    const carrier = new BrowserFxDspCore('ring-mod', sampleRate, {
      ringModHz: carrierHz, ringModDepth: 1, ringModWaveform: 1, mix: 1,
    });
    const triangleOutput = render(carrier, 12288);
    const fundamental = goertzelMagnitude(triangleOutput, 4096, 8192, 1024);
    const thirdHarmonic = goertzelMagnitude(triangleOutput, 4096, 8192, 3072);
    // At 6 kHz and 48 kHz, the 0.45*Fs budget admits the fundamental and
    // third partial, but excludes the fifth and higher partials. The ratio is
    // a functional table check, not a full perceptual/alias-quality pass.
    expect(fundamental).toBeGreaterThan(0.7);
    expect(thirdHarmonic / fundamental).toBeGreaterThan(0.08);
    expect(thirdHarmonic / fundamental).toBeLessThan(0.15);

    const whole = new BrowserFxDspCore('ring-mod', sampleRate, { ringModHz: 440, ringModDepth: 1, mix: 1 });
    const split = new BrowserFxDspCore('ring-mod', sampleRate, { ringModHz: 440, ringModDepth: 1, mix: 1 });
    const frames = 4096;
    const prefixFrames = 257;
    const input = new Float32Array(frames).fill(1);
    const outputWhole = new Float32Array(frames);
    const outputSplit = new Float32Array(frames);
    const scratchRight = new Float32Array(frames);
    whole.processBlock(input.subarray(0, prefixFrames), input.subarray(0, prefixFrames), outputWhole.subarray(0, prefixFrames), scratchRight.subarray(0, prefixFrames), prefixFrames);
    split.processBlock(input.subarray(0, prefixFrames), input.subarray(0, prefixFrames), outputSplit.subarray(0, prefixFrames), scratchRight.subarray(0, prefixFrames), prefixFrames);
    whole.setParameters({ ringModWaveform: 1 });
    split.setParameters({ ringModWaveform: 1 });
    whole.processBlock(input.subarray(prefixFrames), input.subarray(prefixFrames), outputWhole.subarray(prefixFrames), scratchRight.subarray(prefixFrames), frames - prefixFrames);
    let offset = prefixFrames;
    for (const blockSize of [1, 7, 31, 64, 5, 127]) {
      if (offset >= frames) break;
      const count = Math.min(blockSize, frames - offset);
      split.processBlock(input.subarray(offset, offset + count), input.subarray(offset, offset + count), outputSplit.subarray(offset, offset + count), scratchRight.subarray(offset, offset + count), count);
      offset += count;
    }
    while (offset < frames) {
      const count = Math.min(89, frames - offset);
      split.processBlock(input.subarray(offset, offset + count), input.subarray(offset, offset + count), outputSplit.subarray(offset, offset + count), scratchRight.subarray(offset, offset + count), count);
      offset += count;
    }
    expect([...outputSplit]).toEqual([...outputWhole]);
    let maximumAdjacentStep = 0;
    for (let index = 1; index < outputWhole.length; index += 1) {
      maximumAdjacentStep = Math.max(maximumAdjacentStep, Math.abs(outputWhole[index]! - outputWhole[index - 1]!));
    }
    expect(maximumAdjacentStep).toBeLessThan(0.1);
  });
});
