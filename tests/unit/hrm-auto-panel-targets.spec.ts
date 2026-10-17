import { defineComponent, h } from 'vue';
import { shallowMount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/AudioEngine';
import TopPanel from '../../src/components/TopPanel.vue';
import InputFxPanel from '../../src/components/panel/InputFxPanel.vue';
import TrackFxPanel from '../../src/components/panel/TrackFxPanel.vue';

const HrmAutoTargetStub = defineComponent({
  name: 'HrmAutoFxEditor',
  props: {
    modelValue: { type: Object, required: false },
    midiTarget: { type: Object, required: true },
  },
  setup(props) {
    return () => h('div', { 'data-hrm-auto-midi-target': JSON.stringify(props.midiTarget) });
  },
});

const FxMacroStub = defineComponent({
  name: 'FxUnit',
  props: { label: { type: String, required: true } },
  emits: ['update:modelValue'],
  setup() { return () => h('button'); },
});

const KnobMacroStub = defineComponent({
  name: 'HardwareKnob',
  props: { modelValue: { type: Number, required: false } },
  emits: ['update:modelValue'],
  setup() { return () => h('button'); },
});

const slots = ['A', 'B', 'C', 'D'].map((id, index) => ({
  id,
  type: index === 0 ? 'HRM AUTO (M)' : 'FILTER',
  value: 70,
  active: false,
  ...(index === 0 ? { hrmAutoParameters: { key: 0, scale: 0, midiChannel: 1, mixPercent: 70 } } : {}),
}));

describe('HRM AUTO panel MIDI targets', () => {
  it('passes one exact Input and Track target in each shell layout and routes the active mix macro', async () => {
    localStorage.clear();
    AudioEngine.getInstance().setMode('browser');
    localStorage.setItem('webrc505_top_panel', JSON.stringify({ inputSlots: slots, trackSlots: slots }));
    const setCatalogParameters = vi.spyOn(AudioEngine.getInstance(), 'setCatalogFxParameters');
    const wrapper = shallowMount(TopPanel, {
      global: { stubs: { HrmAutoFxEditor: HrmAutoTargetStub, FxUnit: FxMacroStub } },
    });
    const targets = wrapper.findAllComponents(HrmAutoTargetStub).map((component) => component.props('midiTarget'));
    expect(targets).toEqual([
      { path: 'input', slot: 'A', effectId: 'hrm_auto_m' },
      { path: 'track', slot: 'A', effectId: 'hrm_auto_m' },
    ]);
    const input = shallowMount(InputFxPanel, {
      global: { stubs: { HrmAutoFxEditor: HrmAutoTargetStub, HardwareKnob: KnobMacroStub } },
    });
    const track = shallowMount(TrackFxPanel, {
      global: { stubs: { HrmAutoFxEditor: HrmAutoTargetStub, HardwareKnob: KnobMacroStub } },
    });
    expect(input.findAllComponents(HrmAutoTargetStub)).toHaveLength(1);
    expect(input.getComponent(HrmAutoTargetStub).props('midiTarget')).toEqual({ path: 'input', slot: 'A', effectId: 'hrm_auto_m' });
    expect(track.findAllComponents(HrmAutoTargetStub)).toHaveLength(1);
    expect(track.getComponent(HrmAutoTargetStub).props('midiTarget')).toEqual({ path: 'track', slot: 'A', effectId: 'hrm_auto_m' });

    setCatalogParameters.mockClear();
    const topFxUnits = wrapper.findAllComponents(FxMacroStub);
    expect(topFxUnits).toHaveLength(8);
    topFxUnits[0]!.vm.$emit('update:modelValue', 33);
    await wrapper.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenCalledWith('input', 0, {
      key: 0, scale: 0, 'midi-channel': 1, mix: 33,
    });
    setCatalogParameters.mockClear();
    (topFxUnits[4]!.vm.$.vnode.props?.['onUpdate:modelValue'] as ((value: number) => void) | undefined)?.(48);
    await wrapper.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenCalledWith('track', 0, {
      key: 0, scale: 0, 'midi-channel': 1, mix: 48,
    });

    setCatalogParameters.mockClear();
    input.findComponent(KnobMacroStub).vm.$emit('update:modelValue', 57);
    await input.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenCalledWith('input', 0, {
      key: 0, scale: 0, 'midi-channel': 1, mix: 57,
    });
    setCatalogParameters.mockClear();
    track.findComponent(KnobMacroStub).vm.$emit('update:modelValue', 61);
    await track.vm.$nextTick();
    expect(setCatalogParameters).toHaveBeenCalledWith('track', 0, {
      key: 0, scale: 0, 'midi-channel': 1, mix: 61,
    });
    input.unmount();
    track.unmount();
    wrapper.unmount();
  });
});
