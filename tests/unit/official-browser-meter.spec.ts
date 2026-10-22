import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore, type BrowserFxAlgorithm, type BrowserFxParameters } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { OfficialBrowserControlState, officialRateHz } from '../../src/audio/fx/dsp/OfficialBrowserParameters';
import { BrowserWorkletFX } from '../../src/audio/fx/BrowserWorkletFX';
const sampleRate = 8000;
function render(algorithm: BrowserFxAlgorithm, parameters: BrowserFxParameters, frames = 8000): Float32Array {
  const input = Float32Array.from({ length: frames }, (_, i) => 0.3 * Math.sin(i * 0.172) + 0.2 * Math.sin(i * 0.719));
  const out = new Float32Array(frames);
  new BrowserFxDspCore(algorithm, sampleRate, parameters).processBlock(input, input, out, new Float32Array(frames));
  return out;
}
describe('official Browser meter-aware measure rates', () => {
  it.each([-4, -8, -16])('converts MEAS %s using normalized quarter-note meter', value => {
    expect(officialRateHz(value, 120, 3)).toBeCloseTo(2 / (Math.abs(value) * 3 / 4), 12);
    expect(officialRateHz(value, 120, 1.5)).toBeCloseTo(2 / (Math.abs(value) * 1.5 / 4), 12);
  });
  it.each([-2, -1, -0.125, 0, 50, 100, -1000])('does not change note/free/OFF rate %s with meter', value => {
    expect(officialRateHz(value, 120, 1.5)).toBe(officialRateHz(value, 120, 4));
  });
  it('retains meter before opt-in without activating the official parameter group', () => {
    const state = new OfficialBrowserControlState('tremolo', sampleRate);
    expect(state.translate({ quarterNotesPerMeasure: 3, mix: 0.2 })).toEqual({ quarterNotesPerMeasure: 3, mix: 0.2 });
    expect(state.values).toEqual({});
    expect(state.translate({ official_rate: -4 }).tremoloRateHz).toBeCloseTo(2 / 3);
    expect(state.translate({ quarterNotesPerMeasure: 1.5 }).tremoloRateHz).toBeCloseTo(4 / 3);
    expect(state.values.official_rate).toBe(-4);
  });
  it.each(['tremolo', 'auto-pan', 'manual-pan', 'stereo-enhance', 'isolator', 'lpf'] as const)('%s auxiliary-only changes preserve legacy audio exactly', algorithm => {
    expect(render(algorithm, { mix: 0.2, bpm: 120, quarterNotesPerMeasure: 3 })).toEqual(render(algorithm, { mix: 0.2, bpm: 120 }));
  });
  it.each(['lpf', 'bpf', 'hpf', 'phaser', 'flanger', 'tremolo', 'auto-pan', 'vibrato', 'chorus', 'isolator'] as const)('%s renders different MEAS modulation in 3/4 and 4/4', algorithm => {
    const parameters = { official_rate: -4, official_depth: 75 };
    expect(render(algorithm, { ...parameters, quarterNotesPerMeasure: 3 })).not.toEqual(render(algorithm, { ...parameters, quarterNotesPerMeasure: 4 }));
  });
  it('applies meter to STEP RATE sample-and-hold clocks', () => {
    const parameters = { official_rate: 65, official_depth: 75, official_step_rate: -4, bpm: 240 };
    expect(render('lpf', { ...parameters, quarterNotesPerMeasure: 3 }, 16000)).not.toEqual(render('lpf', { ...parameters, quarterNotesPerMeasure: 4 }, 16000));
  });
  it.each(['delay', 'panning-delay', 'reverse-delay', 'mod-delay'] as const)('%s negative TIME remains a fixed note length', algorithm => {
    const parameters = { official_time: -2, official_feedback: 2, official_d_level: 0, official_e_level: 100, bpm: 300 };
    expect(render(algorithm, { ...parameters, quarterNotesPerMeasure: 1.5 })).toEqual(render(algorithm, { ...parameters, quarterNotesPerMeasure: 4 }));
  });
  it.each(['vocoder', 'electric', 'osc-bot', 'osc-voc'] as const)('%s admits harmless host clock metadata without official activation', algorithm => {
    expect(() => new BrowserFxDspCore(algorithm, 48000, { bpm: 120, quarterNotesPerMeasure: 3 })).not.toThrow();
  });
  it('adapter preserves exact fractional meter and rejects invalid bounds', () => {
    const context = { createGain: () => ({ connect() {}, disconnect() {} }) } as unknown as AudioContext;
    const fx = new BrowserWorkletFX(context, 'RADIO', async () => {});
    fx.setParam('quarterNotesPerMeasure', 128);
    expect(fx.getParameterSnapshot().quarterNotesPerMeasure).toBe(128);
    fx.setParam('quarterNotesPerMeasure', 1.5);
    expect(fx.getParameterSnapshot().quarterNotesPerMeasure).toBe(1.5);
    fx.setParam('quarterNotesPerMeasure', 0);
    expect(fx.getParameterSnapshot().quarterNotesPerMeasure).toBe(1.5);
    expect(fx.error).toContain('meter');
  });
});
