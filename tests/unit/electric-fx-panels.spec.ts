import { defineComponent, h } from 'vue';
import { mount, shallowMount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/AudioEngine';
import type { ElectricParameters } from '../../src/audio/electricParameters';
import ElectricFxEditor from '../../src/components/fx/ElectricFxEditor.vue';
import TopPanel from '../../src/components/TopPanel.vue';
import InputFxPanel from '../../src/components/panel/InputFxPanel.vue';
import TrackFxPanel from '../../src/components/panel/TrackFxPanel.vue';

const FxMacroStub = defineComponent({
  name: 'FxUnit',
  props: {
    label: { type: String, required: true },
    modelValue: { type: Number, required: true },
    selectedType: { type: String, required: true },
  },
  emits: ['update:modelValue', 'update:selectedType', 'update:active'],
  setup(props, { emit }) {
    return () => h('button', {
      type: 'button',
      'data-fx-macro': props.label,
      onClick: () => emit('update:modelValue', props.modelValue),
    });
  },
});

const KnobMacroStub = defineComponent({
  name: 'HardwareKnob',
  props: { modelValue: { type: Number, required: true } },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('button', {
      type: 'button',
      'data-knob-value': props.modelValue,
      onClick: () => emit('update:modelValue', props.modelValue),
    });
  },
});

function fxSlots(): Array<{ id: string; type: string; value: number; active: boolean; electricParameters: ElectricParameters }> {
  return ['A', 'B', 'C', 'D'].map((id) => ({
    id,
    type: 'ELECTRIC',
    value: 70,
    active: false,
    electricParameters: { character: 0, pitchSnapPercent: 50, toneHz: 5000, mixPercent: 70 },
  }));
}

function seedRuntimeSlots(): void {
  localStorage.setItem('webrc505_top_panel', JSON.stringify({ inputSlots: fxSlots(), trackSlots: fxSlots() }));
  localStorage.setItem('webrc505_native_fx_catalog', JSON.stringify({ inputSlots: fxSlots(), trackSlots: fxSlots() }));
}

function macroFor(wrapper: ReturnType<typeof shallowMount>, label: string) {
  return wrapper.findAllComponents(FxMacroStub).find((unit) => unit.props('label') === label)!;
}

afterEach(() => {
  localStorage.clear();
  AudioEngine.getInstance().setMode('native');
});

describe('ELECTRIC controls in FX panels', () => {
  it('mounts in all Input/Track surfaces, persists four edits and dispatches exact Browser and Native names; macro remains mix', async () => {
    localStorage.clear();
    seedRuntimeSlots();
    const audio = AudioEngine.getInstance();
    audio.setMode('browser');
    const setCatalogParameters = vi.spyOn(audio, 'setCatalogFxParameters');

    const topPanel = shallowMount(TopPanel, {
      global: {
        stubs: { FxUnit: FxMacroStub, ElectricFxEditor: false, TransportControls: true, RhythmControls: true },
      },
    });
    const classicInput = shallowMount(InputFxPanel, {
      global: { stubs: { HardwareKnob: KnobMacroStub, ElectricFxEditor: false } },
    });
    const classicTrack = shallowMount(TrackFxPanel, {
      global: { stubs: { HardwareKnob: KnobMacroStub, ElectricFxEditor: false } },
    });

    expect(topPanel.findAllComponents(ElectricFxEditor)).toHaveLength(2);
    expect(classicInput.findAllComponents(ElectricFxEditor)).toHaveLength(1);
    expect(classicTrack.findAllComponents(ElectricFxEditor)).toHaveLength(1);

    const editors = topPanel.findAllComponents(ElectricFxEditor);
    const inputEditor = editors[0]!;
    const trackEditor = editors[1]!;

    setCatalogParameters.mockClear();
    await inputEditor.get('[aria-label="ELECTRIC character"]').setValue('3');
    await inputEditor.get('[aria-label="ELECTRIC pitch snap percent"]').setValue('84');
    await inputEditor.get('[aria-label="ELECTRIC tone cutoff Hz"]').setValue('9450');
    await inputEditor.get('[aria-label="ELECTRIC effect mix percent"]').setValue('66');
    await topPanel.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenLastCalledWith('input', 0, {
      electricCharacter: 3, electricPitchSnapPercent: 84, electricToneHz: 9450, mix: 0.66,
    });

    let browserSaved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ electricParameters?: ElectricParameters }>;
    };
    expect(browserSaved.inputSlots?.[0]?.electricParameters).toEqual({
      character: 3, pitchSnapPercent: 84, toneHz: 9450, mixPercent: 66,
    });

    setCatalogParameters.mockClear();
    classicInput.findComponent(KnobMacroStub).vm.$emit('update:modelValue', 36);
    await classicInput.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenLastCalledWith('input', 0, {
      electricCharacter: 3, electricPitchSnapPercent: 84, electricToneHz: 9450, mix: 0.36,
    });

    setCatalogParameters.mockClear();
    await trackEditor.get('[aria-label="ELECTRIC character"]').setValue('2');
    await trackEditor.get('[aria-label="ELECTRIC pitch snap percent"]').setValue('38');
    await trackEditor.get('[aria-label="ELECTRIC tone cutoff Hz"]').setValue('3600');
    await trackEditor.get('[aria-label="ELECTRIC effect mix percent"]').setValue('56');
    await topPanel.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenLastCalledWith('track', 0, {
      electricCharacter: 2, electricPitchSnapPercent: 38, electricToneHz: 3600, mix: 0.56,
    });
    browserSaved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as typeof browserSaved;
    expect((browserSaved as typeof browserSaved & { trackSlots?: Array<{ electricParameters?: ElectricParameters }> })
      .trackSlots?.[0]?.electricParameters).toEqual({
        character: 2, pitchSnapPercent: 38, toneHz: 3600, mixPercent: 56,
      });

    setCatalogParameters.mockClear();
    classicTrack.findComponent(KnobMacroStub).vm.$emit('update:modelValue', 34);
    await classicTrack.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenLastCalledWith('track', 0, {
      electricCharacter: 2, electricPitchSnapPercent: 38, electricToneHz: 3600, mix: 0.34,
    });

    setCatalogParameters.mockClear();
    macroFor(topPanel, 'A').vm.$emit('update:modelValue', 41);
    await topPanel.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenLastCalledWith('input', 0, {
      electricCharacter: 3, electricPitchSnapPercent: 84, electricToneHz: 9450, mix: 0.41,
    });
    browserSaved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as typeof browserSaved;
    expect(browserSaved.inputSlots?.[0]?.electricParameters?.mixPercent).toBe(41);

    setCatalogParameters.mockClear();
    topPanel.findAllComponents(FxMacroStub)[4]!.vm.$emit('update:modelValue', 47);
    await topPanel.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenLastCalledWith('track', 0, {
      electricCharacter: 2, electricPitchSnapPercent: 38, electricToneHz: 3600, mix: 0.47,
    });

    classicInput.unmount();
    classicTrack.unmount();
    topPanel.unmount();

    audio.setMode('native');
    const nativePanel = shallowMount(TopPanel, {
      global: {
        stubs: { FxUnit: FxMacroStub, ElectricFxEditor: false, TransportControls: true, RhythmControls: true },
      },
    });
    const nativeEditors = nativePanel.findAllComponents(ElectricFxEditor);
    expect(nativeEditors).toHaveLength(2);

    setCatalogParameters.mockClear();
    await nativeEditors[1]!.get('[aria-label="ELECTRIC character"]').setValue('1');
    await nativeEditors[1]!.get('[aria-label="ELECTRIC pitch snap percent"]').setValue('29');
    await nativeEditors[1]!.get('[aria-label="ELECTRIC tone cutoff Hz"]').setValue('2600');
    await nativeEditors[1]!.get('[aria-label="ELECTRIC effect mix percent"]').setValue('64');
    await nativePanel.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenLastCalledWith('track', 0, {
      character: 1, 'pitch-snap': 29, tone: 2600, mix: 64,
    });

    const nativeSaved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}') as {
      trackSlots?: Array<{ electricParameters?: ElectricParameters }>;
    };
    expect(nativeSaved.trackSlots?.[0]?.electricParameters).toEqual({
      character: 1, pitchSnapPercent: 29, toneHz: 2600, mixPercent: 64,
    });

    setCatalogParameters.mockClear();
    nativePanel.findAllComponents(FxMacroStub)[4]!.vm.$emit('update:modelValue', 52);
    await nativePanel.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenLastCalledWith('track', 0, {
      character: 1, 'pitch-snap': 29, tone: 2600, mix: 52,
    });
    const nativeSavedAfterMacro = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}') as typeof nativeSaved;
    expect(nativeSavedAfterMacro.trackSlots?.[0]?.electricParameters?.mixPercent).toBe(52);

    nativePanel.unmount();
    setCatalogParameters.mockRestore();
  });

  it('clamps invalid persisted controls and keeps all four character labels editable', async () => {
    const wrapper = mount(ElectricFxEditor, {
      props: { modelValue: { character: 99, pitchSnapPercent: -5, toneHz: 20000, mixPercent: 130 } as unknown as ElectricParameters },
    });
    expect((wrapper.get('[aria-label="ELECTRIC character"]').element as HTMLSelectElement).value).toBe('3');
    expect((wrapper.get('[aria-label="ELECTRIC pitch snap percent"]').element as HTMLInputElement).value).toBe('0');
    expect((wrapper.get('[aria-label="ELECTRIC tone cutoff Hz"]').element as HTMLInputElement).value).toBe('16000');
    expect((wrapper.get('[aria-label="ELECTRIC effect mix percent"]').element as HTMLInputElement).value).toBe('100');
    expect(wrapper.get('[aria-label="ELECTRIC character"]').text()).toContain('Classic');
    expect(wrapper.get('[aria-label="ELECTRIC character"]').text()).toContain('Metallic');
    expect(wrapper.get('[aria-label="ELECTRIC character"]').text()).toContain('Vocoder');
    expect(wrapper.get('[aria-label="ELECTRIC character"]').text()).toContain('Bit-crush');
    wrapper.unmount();
  });
});
