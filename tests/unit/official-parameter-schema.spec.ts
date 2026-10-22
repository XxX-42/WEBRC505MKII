import { describe, expect, it } from 'vitest';
import { OFFICIAL_FX_EFFECTS, encodeOfficialValue, findOfficialEffect, officialParameterDomain, officialParameterApplicable, parseOfficialParameterState } from '../../src/audio/fx/official/parameters';

describe('versioned official parameter contract', () => {
  it('has unique effects and stable per-effect keys with source pages', () => {
    expect(new Set(OFFICIAL_FX_EFFECTS.map(e => e.name)).size).toBe(OFFICIAL_FX_EFFECTS.length);
    for (const effect of OFFICIAL_FX_EFFECTS) {
      expect(effect.page).toBeGreaterThanOrEqual(34);
      expect(new Set(effect.parameters.map(p => p.key)).size).toBe(effect.parameters.length);
      for (const parameter of effect.parameters) expect(parameter.values_raw.length).toBeGreaterThan(0);
    }
  });
  for (const effect of OFFICIAL_FX_EFFECTS) for (const parameter of effect.parameters) {
    it(`${effect.name}.${parameter.key}: validates each declared domain and rejects unknown data`, () => {
      const domain = officialParameterDomain(parameter);
      expect(new Set(domain.options.map(option => option.runtime)).size).toBe(domain.options.length);
      for (const entry of domain.options) expect(encodeOfficialValue(parameter, entry.value)).toBe(entry.runtime);
      if (domain.range) {
        expect(encodeOfficialValue(parameter, domain.range.min)).toBe(domain.range.min);
        expect(encodeOfficialValue(parameter, domain.range.max)).toBe(domain.range.max);
        expect(encodeOfficialValue(parameter, domain.range.max + 10000)).toBeNull();
      }
      expect(encodeOfficialValue(parameter, NaN)).toBeNull();
      expect(encodeOfficialValue(parameter, Infinity)).toBeNull();
      expect(encodeOfficialValue(parameter, '__unknown__')).toBeNull();
    });
  }
  it('keeps manual units separate from existing cutoffHz and round-trips state', () => {
    const state = { schemaVersion: 1, effect: 'LPF', values: { cutoff: 50, rate: 'quarter_note' } };
    expect(parseOfficialParameterState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(parseOfficialParameterState({ ...state, values: { cutoffHz: 1000 } })).toBeNull();
    expect(parseOfficialParameterState({ ...state, values: { cutoff: 1000 } })).toBeNull();
    expect(parseOfficialParameterState({ ...state, schemaVersion: 2 })).toBeNull();
  });
  it('retains unverified enumeration as incomplete rather than inventing choices', () => {
    const rate = findOfficialEffect('DSP LPF')!.parameters.find(p => p.key === 'rate')!;
    expect(officialParameterDomain(rate).complete).toBe(false);
    expect(encodeOfficialValue(rate, 'quarter_note')).toBe(-1);
    expect(encodeOfficialValue(rate, 'guessed_dotted_note')).toBeNull();
  });
  it('only enables carrier thru for external input carriers', () => {
    expect(officialParameterApplicable('VOCODER', 'carrier_thru', { carrier: 'MIC1' })).toBe(true);
    expect(officialParameterApplicable('VOCODER', 'carrier_thru', { carrier: 'TRACK1' })).toBe(false);
  });
});

it('encodes numeric-looking octave zero without aliasing -2 OCT and resolves OSC BOT notes', () => {
 const octave = findOfficialEffect('OSC VOC (M)')!.parameters.find(p => p.key === 'octave')!;
 expect(officialParameterDomain(octave).options.map(p => p.runtime)).toEqual([0, 1, 2, 3]);
 expect(encodeOfficialValue(octave, 0)).toBe(2);
 const note = findOfficialEffect('OSC BOT')!.parameters.find(p => p.key === 'note')!;
 expect(encodeOfficialValue(note, 'C1')).toBe(24);
 expect(encodeOfficialValue(note, 'C2')).toBe(36);
 expect(encodeOfficialValue(note, 'G9')).toBe(127);
});
