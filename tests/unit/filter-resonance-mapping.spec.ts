import { describe, expect, it } from 'vitest';
import { BROWSER_PER_TRACK_PARAMETER_KEYS } from '../../src/audio/BrowserTrackFxChain';
import { BrowserFxDspCore, filterResonancePercentToQ } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { FX_CATALOG } from '../../src/audio/fx/catalog';
import { getBrowserTrackFxControls, sanitizeBrowserTrackFxParameters } from '../../src/composables/browserTrackFxParameters';

function render(core: BrowserFxDspCore, input: Float32Array, blocks: readonly number[] = [input.length]): Float32Array {
  const output = new Float32Array(input.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < input.length) {
    const requested = blocks[blockIndex % blocks.length] ?? input.length;
    const frames = Math.min(requested, input.length - offset);
    core.processBlock(input.subarray(offset, offset + frames), null, output.subarray(offset, offset + frames), null, frames);
    offset += frames;
    blockIndex += 1;
  }
  return output;
}

function inputTone(frames: number, sampleRate: number): Float32Array {
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) samples[frame] = Math.sin((2 * Math.PI * 1000 * frame) / sampleRate);
  return samples;
}

describe('LPF/HPF resonance-percent mapping', () => {
  it.each(['LPF', 'HPF'])('%s metadata, UI controls and private worklet parameters share the percent contract', (type) => {
    const effect = FX_CATALOG.find(({ displayName }) => displayName === type)!;
    const descriptor = effect.parameters.find(({ key }) => key === 'resonance')!;
    const control = getBrowserTrackFxControls(`DSP ${type}`).find(({ key }) => key === 'filterResonancePercent');
    const algorithm = type === 'LPF' ? 'lpf' : 'hpf';
    expect(descriptor).toMatchObject({ unit: '%', range: { min: 0, max: 100 }, defaultValue: 15 });
    expect(descriptor.runtimeMapping).toContain('resonance_percent');
    expect(control).toMatchObject({ key: 'filterResonancePercent', unit: '%', min: 0, max: 100, defaultValue: 15, hint: descriptor.runtimeMapping });
    expect(sanitizeBrowserTrackFxParameters(`DSP ${type}`, { filterResonancePercent: 54, q: 8 })).toEqual({ filterResonancePercent: 54 });
    expect(BROWSER_PER_TRACK_PARAMETER_KEYS[algorithm]).toContain('filterResonancePercent');
  });

  it('maps 0–100% to bounded Q while preserving the legacy default Q at 15%', () => {
    expect(filterResonancePercentToQ(0)).toBe(0.5);
    expect(filterResonancePercentToQ(15)).toBeCloseTo(Math.SQRT1_2, 7);
    expect(filterResonancePercentToQ(100)).toBe(12);
    expect(filterResonancePercentToQ(-10)).toBe(0.5);
    expect(filterResonancePercentToQ(110)).toBe(12);
  });

  it.each(['lpf', 'hpf'] as const)('%s runtime applies percent as the same Q ramp under variable block sizes', (algorithm) => {
    for (const sampleRate of [44_100, 96_000]) {
      const baseline = new BrowserFxDspCore(algorithm, sampleRate, { cutoffHz: 1000, q: Math.SQRT1_2, mix: 1 });
      const mappedDefault = new BrowserFxDspCore(algorithm, sampleRate, { cutoffHz: 1000, filterResonancePercent: 15, mix: 1 });
      const initial = inputTone(3072, sampleRate);
      expect([...render(mappedDefault, initial)]).toEqual([...render(baseline, initial)]);

      const mapped = new BrowserFxDspCore(algorithm, sampleRate, { cutoffHz: 1000, filterResonancePercent: 15, mix: 1 });
      const directQ = new BrowserFxDspCore(algorithm, sampleRate, { cutoffHz: 1000, q: filterResonancePercentToQ(15), mix: 1 });
      const prefix = inputTone(37, sampleRate);
      const mappedPrefix = render(mapped, prefix);
      const directPrefix = render(directQ, prefix);
      expect([...mappedPrefix]).toEqual([...directPrefix]);
      mapped.setParameters({ filterResonancePercent: 83 });
      directQ.setParameters({ q: filterResonancePercentToQ(83) });
      const change = inputTone(8192, sampleRate);
      expect([...render(mapped, change, [1, 7, 64, 13, 127])]).toEqual([...render(directQ, change, [1, 7, 64, 13, 127])]);
    }
  });
});
