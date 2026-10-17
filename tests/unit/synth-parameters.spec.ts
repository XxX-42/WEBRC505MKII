import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { nativeCatalogEffectId, nativeCatalogMacroParameters, nativeCatalogSlotConfig } from '../../src/audio/nativeFxCatalog';
import { createDefaultSynthParameters, sanitizeSynthParameters } from '../../src/audio/synthParameters';
import SynthFxEditor from '../../src/components/fx/SynthFxEditor.vue';
import { vi } from 'vitest';

describe('clean-room SYNTH control contract', () => {
  it('provides the same bounded defaults for Browser and Native named controls', () => {
    expect(createDefaultSynthParameters()).toEqual({
      sensitivity: 60,
      waveform: 0,
      octave: 0,
      tone: 4000,
      mix: 50,
    });
    expect(nativeCatalogEffectId('SYNTH')).toBe('synth');
    expect(nativeCatalogMacroParameters('SYNTH', 25)).toEqual({
      sensitivity: 60,
      waveform: 0,
      octave: 0,
      tone: 4000,
      mix: 25,
    });
  });

  it('bounds persisted values, rounds choice and semitone controls, and replaces non-finite values', () => {
    expect(sanitizeSynthParameters({
      sensitivity: 500,
      waveform: 1.7,
      octave: -27.2,
      tone: Number.NaN,
      mix: Number.POSITIVE_INFINITY,
    })).toEqual({
      sensitivity: 100,
      waveform: 2,
      octave: -24,
      tone: 4000,
      mix: 50,
    });
    expect(sanitizeSynthParameters({ sensitivity: -1, waveform: -4, octave: 18.6, tone: 10, mix: 120 })).toEqual({
      sensitivity: 0,
      waveform: 0,
      octave: 19,
      tone: 100,
      mix: 100,
    });
  });

  it('maps named controls into Native catalog slots without changing target or bypass state', () => {
    expect(nativeCatalogSlotConfig('track', 2, {
      type: 'SYNTH',
      value: 22,
      active: true,
      parameters: { sensitivity: 31, waveform: 1, octave: 7, tone: 900, mix: 22 },
    })).toEqual({
      path: 'track', slot: 'C', effectId: 'synth',
      parameters: { sensitivity: 31, waveform: 1, octave: 7, tone: 900, mix: 22 },
      bypassed: false,
    });
  });

  it('routes the canonical named controls to Native and Browser parameter adapters', () => {
    const native = { setCatalogFxParameters: vi.fn() };
    const browser = { setFxNamedParameters: vi.fn() };
    const engine = Object.create(AudioEngine.prototype) as AudioEngine;
    Object.assign(engine, { currentMode: 'native', nativeEngine: native, browserEngine: browser });
    const parameters = createDefaultSynthParameters();

    engine.setCatalogFxParameters('input', 1, { ...parameters });
    expect(native.setCatalogFxParameters).toHaveBeenCalledWith('input', 1, { ...parameters });
    Object.assign(engine, { currentMode: 'browser' });
    engine.setCatalogFxParameters('track', 2, { ...parameters, waveform: 2, octave: -12 });
    expect(browser.setFxNamedParameters).toHaveBeenCalledWith('track', 2, {
      ...parameters, waveform: 2, octave: -12,
    });
  });

  it('renders five accessible controls and emits the corresponding named value for each', async () => {
    const wrapper = mount(SynthFxEditor, { props: { modelValue: createDefaultSynthParameters() } });
    expect(wrapper.findAll('input[type="range"]')).toHaveLength(4);
    await wrapper.get('[aria-label="Synth tracking sensitivity"]').setValue('73');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ sensitivity: 73 });
    await wrapper.get('[aria-label="Synth oscillator waveform"]').setValue('2');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ waveform: 2 });
    await wrapper.get('[aria-label="Synth oscillator octave"]').setValue('-12');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ octave: -12 });
    await wrapper.get('[aria-label="Synth tone cutoff hertz"]').setValue('6400');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ tone: 6400 });
    await wrapper.get('[aria-label="Synth effect mix percent"]').setValue('44');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ mix: 44 });
    wrapper.unmount();
  });
});
