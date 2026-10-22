import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore, type BrowserFxParameters } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { OFFICIAL_DYNAMICS_PROFILES } from '../../src/audio/fx/dsp/OfficialDynamicsProfiles';
import { getBrowserOfficialDefaults } from '../../src/audio/fx/dsp/OfficialBrowserParameters';
const sampleRate = 8000;
function render(parameters: BrowserFxParameters, source: Float32Array, blocks = source.length): Float32Array {
  const core = new BrowserFxDspCore('dynamics', sampleRate, parameters), output = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += blocks) core.processBlock(source.subarray(i, i + blocks), source.subarray(i, i + blocks), output.subarray(i, i + blocks), null);
  expect(output.every(Number.isFinite)).toBe(true); return output;
}
function rms(input: Float32Array): number { return Math.sqrt(input.reduce((s, x) => s + x * x, 0) / input.length); }
describe('official dynamics functional profiles', () => {
  const source = Float32Array.from({ length: 8000 }, (_, i) => (i % 800 < 200 ? 0.7 : 0.05) * (Math.sin(i * 0.17) + 0.3 * Math.sin(i * 0.91)));
  it('has 19 nonaliasing audible detector/EQ profiles, not a cosmetic type enum', () => {
    expect(OFFICIAL_DYNAMICS_PROFILES).toHaveLength(19);
    const outputs = OFFICIAL_DYNAMICS_PROFILES.map((_, i) => render({ official_type: i }, source));
    for (let a = 0; a < outputs.length; a += 1) for (let b = a + 1; b < outputs.length; b += 1) expect(outputs[a]).not.toEqual(outputs[b]);
  });
  it.each(OFFICIAL_DYNAMICS_PROFILES.map((profile, index) => [profile.name, index] as const))('%s positive DYNAMICS increases soft/loud contrast relative to negative', (_, type) => {
    const source = Float32Array.from({ length: 16000 }, (_, i) => (i < 8000 ? 0.02 : 0.7) * Math.sin(i * 0.17));
    const low = render({ official_type: type, official_dynamics: -20 }, source);
    const high = render({ official_type: type, official_dynamics: 20 }, source);
    const contrast = (x: Float32Array) => rms(x.subarray(14000)) / rms(x.subarray(6000, 8000));
    expect(contrast(high)).toBeGreaterThan(contrast(low));
  });
  it('does not invent an official TYPE default where the manual marks none', () => {
    expect(getBrowserOfficialDefaults('dynamics')).toEqual({ official_dynamics: 0 });
  });
  it('keeps authored official settings authoritative over later legacy macro fields', () => {
    const a = render({ official_type: 18, official_dynamics: -10 }, source);
    const b = render({ official_type: 18, official_dynamics: -10, ratio: 1, thresholdDb: 0, outputDb: 12, mix: 0 }, source);
    expect(a).toEqual(b);
  });
  it('is block-size invariant', () => {
    expect(render({ official_type: 17, official_dynamics: 12 }, source, 127)).toEqual(render({ official_type: 17, official_dynamics: 12 }, source));
  });
});
