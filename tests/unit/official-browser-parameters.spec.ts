import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore, type BrowserFxAlgorithm, type BrowserFxParameters } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BROWSER_OFFICIAL_PARAMETER_KEYS, BROWSER_OFFICIAL_SOURCE_ALGORITHMS, OfficialBrowserControlState, getBrowserOfficialDefaults, officialRateHz } from '../../src/audio/fx/dsp/OfficialBrowserParameters';

const rate = 12000;
const frames = 6000;
const input = Float32Array.from({ length: frames }, (_, i) => {
  const envelope = i % 900 < 160 ? 0.75 : 0.08;
  return envelope * (Math.sin(2 * Math.PI * 83 * i / rate) + 0.4 * Math.sin(2 * Math.PI * 977 * i / rate) + 0.3 * Math.sin(2 * Math.PI * 3901 * i / rate));
});
function render(algorithm: BrowserFxAlgorithm, params: BrowserFxParameters, blocks = [frames], source = input): Float32Array {
  const core = new BrowserFxDspCore(algorithm, rate, params);
  if (algorithm === 'osc-voc') { core.scheduleMidiNoteOn(1, 60, 100, 0); core.scheduleMidiNoteOff(1, 60, frames / 2); }
  const output = new Float32Array(frames * 2);
  const right = algorithm === 'stereo-enhance' ? source.map((x, i) => x * 0.6 + 0.1 * Math.sin(2 * Math.PI * 210 * i / rate)) : source;
  let offset = 0, block = 0;
  while (offset < frames) {
    const deactivateAt = algorithm === 'freeze' ? frames * 0.75 : frames / 2;
    const hasLifecycle = algorithm === 'twist' || algorithm === 'freeze' || algorithm === 'roll';
    if (hasLifecycle && offset === deactivateAt) { if (algorithm === 'roll') core.setParameters({ official_roll: 0 }); else core.setBypass(true); }
    const requested = Math.min(frames - offset, blocks[block++ % blocks.length]!);
    const length = hasLifecycle && offset < deactivateAt ? Math.min(requested, deactivateAt - offset) : requested;
    core.processBlock(source.subarray(offset, offset + length), right.subarray(offset, offset + length), output.subarray(offset, offset + length), output.subarray(frames + offset, frames + offset + length), undefined, false, algorithm === 'vocoder' ? source.subarray(offset, offset + length) : null);
    offset += length;
  }
  expect(output.every(Number.isFinite)).toBe(true);
  return output;
}
function difference(a: Float32Array, b: Float32Array): number {
  return a.reduce((sum, value, index) => sum + (value - b[index]!) ** 2, 0) / a.length;
}
type Case = [string, number, number, BrowserFxParameters?];
const modulation: Case[] = [['rate', 15, 95], ['depth', 0, 100], ['resonance', 0, 90], ['step_rate', -1000, 30]];
const cases: Partial<Record<BrowserFxAlgorithm, Case[]>> = {
  lpf: [...modulation, ['cutoff', 25, 80]],
  bpf: [...modulation, ['cutoff', 25, 80]],
  hpf: [...modulation, ['cutoff', 25, 80]],
  phaser: [...modulation, ['manual', 10, 90], ['d_level', 0, 100], ['e_level', 0, 100], ['stage', 4, 12], ['stage', 8, -1]],
  flanger: [...modulation, ['manual', 10, 90], ['d_level', 0, 100], ['e_level', 0, 100], ['separation', 0, 100]],
  'lo-fi': [['bitdepth', 2, 16], ['samplerate', 2, 20], ['balance', 0, 100]],
  radio: [['lo_fi', 1, 10], ['level', 0, 100]],
  'ring-mod': [['frequency', 10, 90], ['balance', 0, 100]],
  sustainer: [['attack', 0, 100], ['release', 0, 100], ['sustain', 0, 100], ['level', 0, 100], ['low_gain', -20, 20], ['hi_gain', -20, 20]],
  distortion: [['type', 0, 1], ['type', 1, 2], ['type', 2, 3], ['type', 3, 4], ['type', 4, 5], ['tone', -50, 50], ['dist', 0, 100], ['d_level', 0, 100], ['e_level', 0, 100]],
  eq: [['lo', -20, 20], ['lo_mid', -20, 20], ['lo_mid_freq', 100, 3000, { official_lo_mid: 12 }], ['lo_mid_q', 0.5, 16, { official_lo_mid: 12 }], ['hi_mid', -20, 20], ['hi_mid_freq', 500, 4000, { official_hi_mid: 12 }], ['hi_mid_q', 0.5, 16, { official_hi_mid: 12 }], ['high', -20, 20], ['level', 0, 100]],
  'slow-gear': [['sens', 0, 100], ['rise_time', 0, 100], ['level', 0, 100]],
  tremolo: [['rate', 0, 100], ['depth', 0, 100], ['waveform', 0, 100]],
  'auto-pan': [['rate', 0, 100], ['depth', 0, 100], ['waveform', 0, 100], ['init_phase', 0, 90], ['step_rate', -1000, 35]],
  'manual-pan': [['position', -50, 50]],
  vibrato: [['rate', 0, 100], ['depth', 0, 100], ['color', 0, 100], ['d_level', 0, 100], ['e_level', 0, 100]],
  'stereo-enhance': [['low_cut', -1000, 3000], ['high_cut', 100, -1000], ['enhance', 0, 100]],
  chorus: [['rate', 0, 100], ['depth', 0, 100], ['d_level', 0, 100], ['e_level', 0, 100], ['low_cut', -1000, 3000], ['high_cut', 100, -1000]],
  reverb: [['time', 0.1, 10], ['pre_delay', 0, 300], ['density', 1, 10], ['d_level', 0, 100], ['e_level', 0, 100], ['low_cut', -1000, 3000], ['high_cut', 100, -1000]],
  'gate-reverb': [['time', 0.1, 10], ['pre_delay', 0, 300], ['threshold', 0, 100], ['d_level', 0, 100], ['e_level', 0, 100], ['low_cut', -1000, 3000], ['high_cut', 100, -1000]],
  synth: [['frequency', 20, 90], ['resonance', 0, 100], ['decay', 0, 100, { official_frequency: 40, official_resonance: 65 }], ['balance', 0, 100]],
  g2b: [['balance', 0, 100]],
  isolator: [['band', 0, 2], ['rate', 0, 100], ['band_level', 0, 100], ['depth', 0, 100], ['step_rate', -1000, 35], ['waveform', 0, 1]],
  delay: [['time', 20, 200], ['feedback', 1, 16], ['d_level', 0, 100], ['e_level', 0, 120], ['low_cut', -1000, 3000], ['high_cut', 100, -1000]],
  'panning-delay': [['time', 20, 200], ['feedback', 1, 16], ['d_level', 0, 100], ['e_level', 0, 120], ['low_cut', -1000, 3000], ['high_cut', 100, -1000]],
  'reverse-delay': [['time', 20, 200], ['feedback', 1, 16], ['d_level', 0, 100], ['e_level', 0, 120], ['low_cut', -1000, 3000], ['high_cut', 100, -1000]],
  'mod-delay': [['time', 20, 200], ['feedback', 1, 16], ['mod_depth', 0, 100], ['d_level', 0, 100], ['e_level', 0, 120], ['low_cut', -1000, 3000], ['high_cut', 100, -1000]],
  'granular-delay': [['time', 0, 100], ['feedback', 0, 100], ['e_level', 0, 100]],
  warp: [['level', 0, 100]],
  'reverse-reverb': [['time', .1, 10], ['pre_delay', 0, 300], ['gate_time', .1, 1], ['d_level', 0, 100], ['e_level', 0, 100], ['low_cut', -1000, 3000], ['high_cut', 100, -1000]],
  'pattern-slicer': [['rate', 0, 100], ['duty', 1, 99], ['attack', 0, 100], ['depth', 0, 100], ['comp_threshold', -30, 0], ['comp_gain', 0, 20]],
  'beat-repeat': [['type', 0, 1], ['type', 1, 2], ['length', -0.25, -2]],
  'beat-scatter': [['length', -0.125, -4]],
  dynamics: [['type', 0, 18], ['dynamics', -20, 20]],
  preamp: [['amp_type', 0, 8], ['spk_type', 0, 8], ['gain', 0, 120], ['t_comp', -10, 10], ['bass', 0, 100], ['middle', 0, 100], ['treble', 0, 100], ['presence', 0, 100], ['mic_type', 0, 4], ['mic_dis', 0, 1], ['mic_pos', 0, 10], ['e_level', 0, 100]],
  electric: [['shift', -12, 12], ['formant', -50, 50], ['speed', 0, 10], ['stability', -10, 10], ['scale', 0, 1]],
  vocoder: [['tone', -50, 50], ['attack', 0, 100], ['mod_sens', -50, 50], ['balance', 0, 100]],
  'osc-voc': [['carrier', 0, 4], ['tone', -50, 50], ['attack', 0, 100], ['octave', 0, 3], ['mod_sens', -50, 50], ['release', 0, 100], ['balance', 0, 100]],
  'osc-bot': [['osc', 0, 4], ['tone', -50, 50], ['attack', 0, 100], ['note', 36, 72], ['mod_sens', -50, 50], ['balance', 0, 100]],
  roll: [['time', 20, 100], ['feedback', 1, 100], ['repeat', 1, -1000, { official_variant: 2 }], ['roll', 1, 4], ['balance', 0, 100]],
  'step-slicer': [['rate', 0, 100], ['step_max', 1, 16, { official_step_level_1: 0 }], ['step_length', 1, 100], ['depth', 0, 100], ['comp_threshold', -30, 0], ['comp_gain', 0, 20], ...Array.from({ length: 16 }, (_, i) => [`step_level_${i + 1}`, 0, 100] as Case)],
  twist: [['release', 0, 1], ['rise', 0, 100], ['fall', 0, 100, { official_release: 1 }], ['level', 0, 100]],
  freeze: [['attack', 0, 100], ['release', 0, 100], ['decay', 0, 100], ['sustain', 0, 100], ['balance', 0, 100]],
  'tape-echo': [['variant', 1, 2], ['repeat_rate', 20, 90, { official_variant: 1 }], ['intensity', 0, 100, { official_variant: 1 }],
    ['d_level', 0, 100, { official_variant: 1 }], ['e_level', 0, 120, { official_variant: 1 }],
    ['bass', -50, 50, { official_variant: 1 }], ['treble', -50, 50, { official_variant: 1 }],
    ['low_cut', -1000, 3000, { official_variant: 2 }], ['high_cut', 100, -1000, { official_variant: 2 }]],
};
describe('manual-aligned Browser controls have real audio behavior', () => {
  for (const [algorithm, list] of Object.entries(cases)) {
    const common: BrowserFxParameters = ['lpf', 'bpf', 'hpf', 'phaser', 'flanger'].includes(algorithm)
      ? { official_rate: 65, official_depth: 70, official_resonance: 40, ...(algorithm === 'phaser' || algorithm === 'flanger' ? { official_d_level: 50, official_e_level: 70 } : {}) }
      : algorithm === 'reverb' || algorithm === 'gate-reverb' ? { official_pre_delay: 0 }
      : algorithm === 'reverse-reverb' ? { official_pre_delay: 0, official_gate_time: .1, official_time: .2 }
      : algorithm === 'roll' ? { official_variant: 1, official_roll: 1, official_time: 20, official_balance: 100 }
      : algorithm === 'beat-repeat' || algorithm === 'beat-scatter' ? { bpm: 300 }
      : algorithm === 'step-slicer' ? { official_rate: -0.125, bpm: 300 } : {};
    for (const [key, low, high, context] of list) it(`${algorithm}.${key} ${low} -> ${high} changes the rendered signal`, () => {
      const source = algorithm === 'slow-gear' && key === 'sens' ? input.map(x => x * 0.005)
        : algorithm === 'electric' ? input.map((_, i) => 0.25 * Math.sin(2 * Math.PI * 233 * i / rate + 1.5 * Math.sin(i / 170)))
        : algorithm === 'synth' || algorithm === 'g2b' ? input.map((_, i) => (i % 1800 < 600 ? 0.3 : 0.07) * Math.sin(2 * Math.PI * 220 * i / rate)) : input;
      const a = render(algorithm as BrowserFxAlgorithm, { ...common, ...context, [`official_${key}`]: low }, [frames], source);
      const b = render(algorithm as BrowserFxAlgorithm, { ...common, ...context, [`official_${key}`]: high }, [frames], source);
      expect(difference(a, b)).toBeGreaterThan(1e-9);
    });
  }
  it('has an audible parameter case for every advertised key', () => {
    for (const [algorithm, keys] of Object.entries(BROWSER_OFFICIAL_PARAMETER_KEYS)) {
      // Real-loop controls are covered by official-browser-source-transport,
      // never a misleading causal-DSP audio-difference fixture.
      if (BROWSER_OFFICIAL_SOURCE_ALGORITHMS.includes(algorithm)) continue;
      // VOCODER CARRIER is tested by the real source-selection graph suite.
      if (algorithm === 'vocoder') { expect(keys).toContain('official_carrier'); }
      const audioKeys = (keys: readonly string[]) => keys.filter(key => key !== 'official_variant' && key !== 'official_step_index' && !(algorithm === 'vocoder' && key === 'official_carrier'));
      expect(new Set(audioKeys((cases[algorithm as BrowserFxAlgorithm] ?? []).map(c => `official_${c[0]}`)))).toEqual(new Set(audioKeys(keys)));
    }
  });
  it('uses independent zero-able direct/effect gains rather than a shared mix', () => {
    for (const algorithm of ['phaser', 'flanger', 'distortion'] as const) {
      expect(render(algorithm, { official_d_level: 0, official_e_level: 0 }).every(x => x === 0)).toBe(true);
      const dry = render(algorithm, { official_d_level: 100, official_e_level: 0 });
      if (algorithm !== 'distortion') expect(dry.subarray(0, frames)).toEqual(input);
    }
  });
  it('LO-FI OFF independently disables rate and bit reduction', () => {
    const off = render('lo-fi', { official_bitdepth: -1000, official_samplerate: -1000, official_balance: 100 });
    expect(off.subarray(0, frames)).toEqual(input);
    expect(difference(off, render('lo-fi', { official_bitdepth: 1, official_samplerate: -1000, official_balance: 100 }))).toBeGreaterThan(0.01);
  });
  it('keeps official parameter audio sample-clocked across callback sizes', () => {
    for (const algorithm of ['lpf', 'phaser', 'flanger', 'sustainer', 'distortion', 'eq'] as const) {
      const parameter = cases[algorithm]![0]!;
      const params = { [`official_${parameter[0]}`]: parameter[2] };
      expect(render(algorithm, params, [1, 7, 128, 19, 255])).toEqual(render(algorithm, params));
    }
  });
  it('rejects unsupported official controls instead of publishing inert knobs', () => {
    expect(() => new BrowserFxDspCore('ring-mod', rate, { official_mode: 0 })).toThrow(/Unsupported official/);
    expect(() => new BrowserFxDspCore('phaser', rate, { official_made_up: 5 })).toThrow(/Unsupported official/);
  });
  it.each(['tremolo', 'auto-pan', 'manual-pan', 'stereo-enhance', 'isolator', 'distortion'] as BrowserFxAlgorithm[])('BPM alone does not activate official mappings for legacy %s', algorithm => {
    const state = new OfficialBrowserControlState(algorithm, rate);
    const legacy = { mix: 0.2, bpm: 120 };
    expect(state.translate(legacy)).toBe(legacy);
    expect(state.translate({ bpm: 180 })).toEqual({ bpm: 180 });
    expect(difference(render(algorithm, { mix: 0.2, bpm: 120 }), render(algorithm, { mix: 0.2 }))).toBe(0);
  });
  it.each(['lpf', 'hpf'] as BrowserFxAlgorithm[])('official resonance takes priority over legacy percent in %s complete parameter maps', algorithm => {
    const selected = { official_cutoff: 50, official_resonance: 85 };
    expect(difference(render(algorithm, selected), render(algorithm, { ...selected, filterResonancePercent: 0 }))).toBe(0);
    const a = new BrowserFxDspCore(algorithm, rate, selected);
    const b = new BrowserFxDspCore(algorithm, rate, selected);
    b.setParameters({ filterResonancePercent: 0 });
    const left = new Float32Array(frames), right = new Float32Array(frames);
    a.processBlock(input, null, left, null); b.processBlock(input, null, right, null);
    expect(right).toEqual(left);
  });
  it('first official edit loads only documented supported defaults, and a variant change rebuilds them', () => {
    const state = new OfficialBrowserControlState('lpf', rate);
    state.translate({ official_cutoff: 70 });
    expect(state.values.official_rate).toBe(-1);
    expect(state.values.official_depth).toBe(getBrowserOfficialDefaults('lpf').official_depth);
    expect(state.values.official_cutoff).toBe(70);
    const tape = new OfficialBrowserControlState('tape-echo', rate);
    tape.translate({ official_variant: 1, official_bass: 20 });
    tape.translate({ official_variant: 2 });
    expect(tape.values.official_bass).toBeUndefined();
    expect(tape.values.official_repeat_rate).toBe(200);
  });
  it('requires an explicit tape variant and rejects fields belonging to the other domain', () => {
    expect(() => new BrowserFxDspCore('tape-echo', rate, { official_repeat_rate: 50 })).toThrow();
    expect(() => new BrowserFxDspCore('tape-echo', rate, { official_variant: 1, official_low_cut: 200 })).toThrow();
    expect(() => new BrowserFxDspCore('tape-echo', rate, { official_variant: 2, official_bass: 20 })).toThrow();
    const core = new BrowserFxDspCore('tape-echo', rate, { official_variant: 1, official_bass: 50 });
    expect(() => core.setParameters({ official_variant: 2, official_low_cut: 200 })).not.toThrow();
    expect(() => core.setParameters({ official_bass: 20 })).toThrow();
  });
  it('keeps explicitly selected official controls authoritative over later legacy macros', () => {
    const a = new BrowserFxDspCore('lpf', rate, { official_cutoff: 60, official_depth: 0 });
    const b = new BrowserFxDspCore('lpf', rate, { official_cutoff: 60, official_depth: 0 });
    b.setParameters({ cutoffHz: 20 });
    const left = new Float32Array(frames), right = new Float32Array(frames);
    a.processBlock(input, null, left, null); b.processBlock(input, null, right, null);
    expect(right).toEqual(left);
    const c = new BrowserFxDspCore('ring-mod', rate, { official_balance: 75 });
    const d = new BrowserFxDspCore('ring-mod', rate, { official_balance: 75 });
    d.setParameters({ mix: 0 });
    c.processBlock(input, null, left, null); d.processBlock(input, null, right, null);
    expect(right).toEqual(left);
  });
  it('tempo selections use negative quarter-note beats, not the legacy free-rate scale', () => {
    expect(officialRateHz(-1, 120)).toBe(2);
    expect(officialRateHz(-16, 60)).toBe(0.0625);
    expect(officialRateHz(-0.125, 120)).toBe(16);
    expect(officialRateHz(-1000, 120)).toBe(0);
  });
});
