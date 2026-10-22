import { describe, expect, it } from 'vitest';
import { BrowserOfficialStepSlicerDsp } from '../../src/audio/fx/dsp/BrowserOfficialStepSlicerDsp';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { OfficialBrowserControlState, getBrowserOfficialDefaults } from '../../src/audio/fx/dsp/OfficialBrowserParameters';
import { BrowserWorkletFX } from '../../src/audio/fx/BrowserWorkletFX';
const rate = 8000;
const context = () => ({ createGain: () => ({ connect() {}, disconnect() {} }) }) as unknown as AudioContext;
describe('official indexed step slicer', () => {
  it('runs exact 1..16 step counts rather than the old 4/8/16 quantizer', () => {
    for (let count = 1; count <= 16; count += 1) {
      const dsp = new BrowserOfficialStepSlicerDsp(rate, { rateHz: 10, stepMax: count });
      for (let i = 0; i < count * 800 + 4; i += 1) dsp.processSample(0.1, 0.2);
      expect(dsp.stepIndex).toBe(0);
    }
  });
  it('edits each level independently, not one whole-pattern gain', () => {
    const levels = Array.from({ length: 16 }, () => 100); levels[1] = 0; levels[2] = 25;
    const dsp = new BrowserOfficialStepSlicerDsp(rate, { rateHz: 10, stepMax: 3, stepLength: 100, compThreshold: 0, compGain: 0, levels });
    const output = Float64Array.from({ length: 3200 }, () => dsp.processSample(0.1, 0.2).wetLeft);
    expect(output[600]).toBeCloseTo(0.1, 8);
    expect(Math.abs(output[1400]!)).toBeLessThan(1e-9);
    expect(output[2200]).toBeCloseTo(0.025, 8);
    expect(output[3000]).toBeCloseTo(0.1, 8);
  });
  it('maps LENGTH to gate duty while preserving each step duration', () => {
    const short = new BrowserOfficialStepSlicerDsp(rate, { rateHz: 10, stepLength: 10, compThreshold: 0, compGain: 0 });
    const full = new BrowserOfficialStepSlicerDsp(rate, { rateHz: 10, stepLength: 100, compThreshold: 0, compGain: 0 });
    for (let i = 0; i < 600; i += 1) { short.processSample(0.1, 0.2); full.processSample(0.1, 0.2); }
    expect(short.wetLeft).toBeLessThan(1e-8); expect(full.wetLeft).toBeCloseTo(0.1, 8);
    expect(short.stepIndex).toBe(full.stepIndex);
  });
  it('DEPTH zero bypasses only slicing, with linked compression and makeup remaining active', () => {
    const dsp = new BrowserOfficialStepSlicerDsp(rate, { depth: 0, compThreshold: 0, compGain: 6, levels: new Float64Array(16) });
    for (let i = 0; i < 2000; i += 1) dsp.processSample(0.1, 0.2);
    expect(dsp.wetLeft).toBeCloseTo(0.1 * 10 ** 0.3, 8);
    expect(dsp.wetRight / dsp.wetLeft).toBe(2);
  });
  it('initializes all sixteen independently persisted defaults', () => {
    const defaults = getBrowserOfficialDefaults('step-slicer');
    for (let i = 1; i <= 16; i += 1) expect(defaults[`official_step_level_${i}`]).toBe(100);
    expect(defaults.official_step_level).toBeUndefined();
    const state = new OfficialBrowserControlState('step-slicer', rate);
    state.translate({ official_step_level_3: 17 }); state.translate({ official_step_level_16: 83 });
    expect(state.values.official_step_level_3).toBe(17); expect(state.values.official_step_level_16).toBe(83);
    expect(state.values.official_step_level_1).toBe(100);
  });
  it('UI-selected step metadata neither opts in nor changes the playback step', () => {
    const state = new OfficialBrowserControlState('step-slicer', rate);
    expect(state.translate({ official_step_index: 16 })).toEqual({ official_step_index: 16 });
    expect(state.values).toEqual({});
    const source = new Float32Array(4000).fill(0.1), a = new Float32Array(4000), b = new Float32Array(4000);
    new BrowserFxDspCore('step-slicer', rate, { official_step_level_3: 0 }).processBlock(source, source, a, null);
    new BrowserFxDspCore('step-slicer', rate, { official_step_level_3: 0, official_step_index: 16 }).processBlock(source, source, b, null);
    expect(a).toEqual(b);
  });
  it('adapter persists multiple indexed edits and validates aliases at the boundary', () => {
    const fx = new BrowserWorkletFX(context(), 'STEP SLICER', async () => {});
    fx.setParam('official_step_index', 3); fx.setParam('official_step_level_3', 17);
    fx.setParam('official_step_index', 16); fx.setParam('official_step_level_16', 83);
    expect(fx.error).toBe('');
    const snapshot = fx.getParameterSnapshot();
    const restored = new BrowserWorkletFX(context(), 'STEP SLICER', async () => {}, undefined, snapshot);
    expect(restored.error).toBe(''); expect(restored.getParameterSnapshot()).toEqual(snapshot);
    fx.setParam('official_step_level_3', 101); expect(fx.getParameterSnapshot().official_step_level_3).toBe(17);
    expect(fx.error).toContain('Invalid official');
  });
  it.each(['official_step_level', 'official_step_level_0', 'official_step_level_17'])('rejects ambiguous/out-of-range key %s', key => {
    const fx = new BrowserWorkletFX(context(), 'STEP SLICER', async () => {});
    fx.setParam(key, 50); expect(fx.error).toContain('Unsupported official');
  });
  it('is resettable, stereo linked, bounded and allocation-free while rendering', () => {
    const dsp = new BrowserOfficialStepSlicerDsp(rate, { rateHz: 160, compGain: 20 });
    const first = Float64Array.from({ length: 800 }, (_, i) => dsp.processSample(Math.sin(i), -Math.sin(i)).wetLeft);
    const storage = (dsp as unknown as { levels: Float64Array }).levels;
    dsp.reset();
    for (let i = 0; i < 800; i += 1) {
      dsp.processSample(Math.sin(i), -Math.sin(i));
      expect(dsp.wetLeft).toBe(first[i]); expect(dsp.wetRight).toBe(-dsp.wetLeft);
    }
    expect((dsp as unknown as { levels: Float64Array }).levels).toBe(storage);
    dsp.processSample(Number.NaN, Number.POSITIVE_INFINITY); expect(Number.isFinite(dsp.wetLeft + dsp.wetRight)).toBe(true);
  });
});
