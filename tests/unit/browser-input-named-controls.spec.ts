import { defineComponent, h, nextTick } from 'vue';
import { shallowMount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FX_CATALOG } from '../../src/audio/fx/catalog';
import { AudioEngine } from '../../src/audio/AudioEngine';
import InputFxPanel from '../../src/components/panel/InputFxPanel.vue';
import { getBrowserInputFxControls } from '../../src/composables/browserTrackFxParameters';

const HardwareKnobStub = defineComponent({
  name: 'HardwareKnob',
  props: { modelValue: { type: Number, required: true } },
  emits: ['update:modelValue'],
  setup(_props, { emit }) {
    return () => h('button', { type: 'button', 'data-knob': true, onClick: () => emit('update:modelValue', 45) });
  },
});

function seedInputSlots(type: string) {
  localStorage.setItem('webrc505_top_panel', JSON.stringify({
    inputSlots: ['A', 'B', 'C', 'D'].map((id, index) => ({
      id, type: index === 0 ? type : 'FILTER', value: 50, active: false,
    })),
    trackSlots: ['A', 'B', 'C', 'D'].map((id) => ({ id, type: 'FILTER', value: 0, active: false })),
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  AudioEngine.getInstance().setMode('native');
});

describe('Browser Input bank named controls', () => {
  it('offers only named controls for catalogued Browser Input-bank routes', () => {
    expect(getBrowserInputFxControls('DSP LPF').filter(control => control.provenance === 'extension').map(({ key }) => key)).toEqual(['cutoffHz', 'filterResonancePercent', 'mix']);
    expect(getBrowserInputFxControls('DSP HPF').filter(control => control.provenance === 'extension').map(({ key }) => key)).toEqual(['cutoffHz', 'filterResonancePercent', 'mix']);
    expect(getBrowserInputFxControls('RING.MOD').map(({ key }) => key)).toContain('ringModWaveform');
    expect(getBrowserInputFxControls('VINYL FLICK (EXPERIMENTAL)')).toEqual([]);
    expect(getBrowserInputFxControls('BEAT SHIFT')).toEqual([]);

    for (const effect of FX_CATALOG.filter((entry) => entry.runtimeImplementations?.some((item) =>
      item.runtime === 'browser' && item.target === 'input-bank-slot'))) {
      const controls = getBrowserInputFxControls(effect.displayName);
      for (const control of controls) {
        expect(effect.runtimeImplementations?.some((item) => item.runtime === 'browser' && item.target === 'input-bank-slot')).toBe(true);
        expect(control.key).not.toMatch(/beatShift|vinylFlick/i);
      }
    }
  });

  it('edits, persists and restores per-effect Input overrides without leaking them across types; amount regains macro-owned controls', async () => {
    localStorage.clear();
    seedInputSlots('RING.MOD');
    const audio = AudioEngine.getInstance();
    audio.setMode('browser');
    vi.spyOn(audio, 'setCatalogFxParameters').mockImplementation(() => {});
    vi.spyOn(audio, 'setFxType').mockImplementation(() => {});
    vi.spyOn(audio, 'setFxParam').mockImplementation(() => {});
    vi.spyOn(audio, 'setFxActive').mockImplementation(() => {});

    const wrapper = shallowMount(InputFxPanel, { global: { stubs: { HardwareKnob: HardwareKnobStub, BrowserCatalogParametersEditor: false } } });
    await wrapper.get('details[data-input-named-controls] > summary').trigger('click');
    const waveform = wrapper.get('[aria-label="Input FX slot A ringModWaveform"]');
    await waveform.setValue('1');
    await nextTick();
    expect(audio.setCatalogFxParameters).toHaveBeenLastCalledWith('input', 0, { ringModWaveform: 1 });
    let saved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ namedParametersByType?: Record<string, Record<string, number>> }>;
    };
    expect(saved.inputSlots?.[0]?.namedParametersByType?.['RING.MOD']).toEqual({ ringModWaveform: 1 });

    await wrapper.get('select.fx-select').setValue('DSP LPF');
    await nextTick();
    expect(wrapper.get('[aria-label="Input FX slot A filterResonancePercent"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Input FX slot A ringModWaveform"]').exists()).toBe(false);
    audio.setCatalogFxParameters.mockClear();
    const cutoff = wrapper.get('[aria-label="Input FX slot A cutoffHz"]');
    await cutoff.setValue('420');
    await nextTick();
    expect(audio.setCatalogFxParameters).toHaveBeenLastCalledWith('input', 0, { cutoffHz: 420 });

    audio.setCatalogFxParameters.mockClear();
    wrapper.getComponent(HardwareKnobStub).vm.$emit('update:modelValue', 62);
    await nextTick();
    expect(audio.setCatalogFxParameters).not.toHaveBeenCalled();
    saved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as typeof saved;
    expect(saved.inputSlots?.[0]?.namedParametersByType?.['DSP LPF']).toBeUndefined();
    expect(saved.inputSlots?.[0]?.namedParametersByType?.['RING.MOD']).toEqual({ ringModWaveform: 1 });

    await wrapper.get('select.fx-select').setValue('RING.MOD');
    await nextTick();
    expect((wrapper.get('[aria-label="Input FX slot A ringModWaveform"]').element as HTMLSelectElement).value).toBe('1');
    expect(audio.setCatalogFxParameters).toHaveBeenLastCalledWith('input', 0, { ringModWaveform: 1 });
    await wrapper.get('[aria-label="Reset Input FX named controls"]').trigger('click');
    await nextTick();
    const afterReset = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as typeof saved;
    expect(afterReset.inputSlots?.[0]?.namedParametersByType?.['RING.MOD']).toBeUndefined();
    wrapper.unmount();
  });
});
