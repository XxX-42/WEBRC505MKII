import { describe, expect, it } from 'vitest';
import { FX_CATALOG } from '../../src/audio/fx/catalog';
import { BROWSER_PER_TRACK_PARAMETER_KEYS } from '../../src/audio/BrowserTrackFxChain';
import { BROWSER_OFFICIAL_PARAMETER_KEYS } from '../../src/audio/fx/official/browserBindings';
import { findOfficialEffect, findOfficialRuntimeParameter, resolveOfficialEffect, mergeOfficialParameterEdit, encodeOfficialValue, isOfficialRuntimeValueValid } from '../../src/audio/fx/official/parameters';
import { getBrowserTrackFxControls, sanitizeBrowserTrackFxParameters } from '../../src/composables/browserTrackFxParameters';

describe('Official controls across source, UI and executable whitelist', () => {
  it('only exposes controls admitted by the real DSP registry, preserving legacy units', () => {
    let count = 0;
    for (const entry of FX_CATALOG) {
      for (const control of getBrowserTrackFxControls(entry.displayName)) {
        if (control.provenance !== 'official-interface') continue;
        count += 1;
        const source = findOfficialRuntimeParameter(findOfficialEffect(entry.displayName), control.key);
        expect(source, `${entry.displayName}/${control.key}`).toBeDefined();
        expect(Object.values(BROWSER_OFFICIAL_PARAMETER_KEYS).some(keys => keys.includes(control.key))).toBe(true);
        expect(isOfficialRuntimeValueValid(source!, control.defaultValue)).toBe(true);
        if (source!.default !== null) expect(encodeOfficialValue(source!, source!.default!)).not.toBeNull();
        for (const value of [Number.NaN, Infinity, 1e9, -1e9]) {
          expect(sanitizeBrowserTrackFxParameters(entry.displayName, { [control.key]: value })).toEqual({});
        }
        for (const option of control.options ?? []) {
          expect(isOfficialRuntimeValueValid(source!, option.value)).toBe(true);
          expect(sanitizeBrowserTrackFxParameters(entry.displayName, { [control.key]: option.value })).toEqual({ [control.key]: option.value });
        }
      }
    }
    expect(count).toBeGreaterThan(70);
    expect(getBrowserTrackFxControls('DSP LPF').find(p => p.key === 'cutoffHz')?.unit).toBe('Hz');
    expect(getBrowserTrackFxControls('DSP LPF').find(p => p.key === 'official_cutoff')).toMatchObject({ min: 0, max: 100 });
  });
  it('keeps unsupported proprietary controls out of the executable interface', () => {
    expect(getBrowserTrackFxControls('RING.MOD').some(p => p.key === 'official_mode')).toBe(false);
    expect(getBrowserTrackFxControls('SLOW GEAR').some(p => p.key === 'official_mode')).toBe(false);
    expect(getBrowserTrackFxControls('VOCODER').find(p => p.key === 'official_carrier')?.options?.map(option => option.value)).toEqual([6, 7, 8, 9, 10]);
    expect(getBrowserTrackFxControls('VOCODER').some(p => p.key === 'official_carrier_thru')).toBe(false);
    for (const [algorithm, keys] of Object.entries(BROWSER_OFFICIAL_PARAMETER_KEYS)) {
      if (['beat-shift', 'vinyl-flick'].includes(algorithm)) {
        expect(BROWSER_PER_TRACK_PARAMETER_KEYS[algorithm]).toBeUndefined();
      } else expect(BROWSER_PER_TRACK_PARAMETER_KEYS[algorithm]).toEqual(expect.arrayContaining(keys));
    }
  });
  it('requires explicit variants and preserves the documented octave default', () => {
    expect(encodeOfficialValue(findOfficialEffect('PITCH BEND')!.parameters.find(p => p.key === 'pitch')!, '+4OCT')).toBe(4);
    expect(getBrowserTrackFxControls('PITCH BEND').find(p => p.key === 'official_pitch')?.defaultValue).toBe(4);
    expect(resolveOfficialEffect('TAPE ECHO')).toBeUndefined();
    const controls = getBrowserTrackFxControls('TAPE ECHO', { official_variant: 2 });
    expect(controls.some(p => p.key === 'official_low_cut')).toBe(true);
    expect(controls.some(p => p.key === 'official_bass')).toBe(false);
    expect(mergeOfficialParameterEdit({ mix: 0.4, official_variant: 1, official_bass: 8 }, 'official_variant', 2)).toEqual({ mix: 0.4, official_variant: 2 });
  });
  it('retains exact explicit tempo sentinels and rejects undocumented fractional numeric input', () => {
    expect(sanitizeBrowserTrackFxParameters('DSP LPF', { official_rate: -1 })).toEqual({ official_rate: -1 });
    expect(sanitizeBrowserTrackFxParameters('DSP LPF', { official_rate: 20.3 })).toEqual({});
    expect(sanitizeBrowserTrackFxParameters('DSP LPF', { official_rate: -0.37 })).toEqual({});
  });
});

it('exposes source-reader controls only for the shared Track A route, not private FX chains', () => {
  for (const type of ['BEAT SHIFT', 'VINYL FLICK']) {
    const shared = getBrowserTrackFxControls(type, {}, 0, 'shared').filter(control => control.provenance === 'official-interface');
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every(control => control.hint?.includes('PARTIAL_SOURCE_MODES'))).toBe(true);
    expect(getBrowserTrackFxControls(type, {}, 0, 'private').some(control => control.provenance === 'official-interface')).toBe(false);
    expect(getBrowserTrackFxControls(type, {}, 1, 'shared').some(control => control.provenance === 'official-interface')).toBe(false);
    const values = Object.fromEntries(shared.map(control => [control.key, control.defaultValue]));
    expect(sanitizeBrowserTrackFxParameters(type, values, {}, 'shared')).toMatchObject(values);
    expect(Object.keys(sanitizeBrowserTrackFxParameters(type, values, {}, 'private')).some(key => key.startsWith('official_'))).toBe(false);
  }
});
