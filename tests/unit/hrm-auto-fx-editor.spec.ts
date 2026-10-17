import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';

const { engineMock } = vi.hoisted(() => ({
  engineMock: {
    getMode: vi.fn(() => 'browser'),
    getMidiInputState: vi.fn(() => 'disconnected'),
    onMidiInputStateChange: vi.fn((listener: (state: string) => void) => {
      listener('disconnected');
      return vi.fn();
    }),
    connectMidiInput: vi.fn(async () => 'connected'),
    disconnectMidiInput: vi.fn(),
  },
}));

vi.mock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engineMock } }));

import HrmAutoFxEditor from '../../src/components/fx/HrmAutoFxEditor.vue';
import { createDefaultHrmAutoParameters } from '../../src/audio/hrmAutoParameters';

describe('HRM AUTO FX editor', () => {
  beforeEach(() => {
    engineMock.getMode.mockReturnValue('browser');
    engineMock.getMidiInputState.mockReturnValue('disconnected');
    engineMock.onMidiInputStateChange.mockClear();
    engineMock.connectMidiInput.mockReset().mockResolvedValue('connected');
    engineMock.disconnectMidiInput.mockClear();
  });

  it('shows experimental clean-room controls and emits sanitized changes', async () => {
    const wrapper = mount(defineComponent({
      setup() {
        const model = ref(createDefaultHrmAutoParameters());
        return () => h(HrmAutoFxEditor, {
          modelValue: model.value,
          midiTarget: { path: 'input', slot: 'B', effectId: 'hrm_auto_m' },
          'onUpdate:modelValue': (value) => { model.value = value; },
        });
      },
    }));
    const editor = wrapper.getComponent(HrmAutoFxEditor);
    expect(editor.get('[data-hrm-auto-editor]').attributes('aria-label')).toContain('experimental');
    expect(editor.get('header').text()).toContain('CLEAN-ROOM MIDI HARMONY CONTROLS');
    expect(editor.findAll('select')).toHaveLength(3);
    expect(editor.findAll('input[type="range"]')).toHaveLength(1);
    expect(editor.get('.hrm-auto-note').text()).toContain('MIDI access is requested only after pressing Connect MIDI');
    expect(editor.get('[data-midi-status]').text()).toBe('MIDI input disconnected');
    expect(engineMock.connectMidiInput).not.toHaveBeenCalled();

    await editor.get('[aria-label="HRM AUTO key"]').setValue('9');
    await editor.get('[aria-label="HRM AUTO scale"]').setValue('2');
    await editor.get('[aria-label="HRM AUTO MIDI channel"]').setValue('8');
    await editor.get('[aria-label="HRM AUTO effect mix percent"]').setValue('41');
    expect(editor.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      key: 9,
      scale: 2,
      midiChannel: 8,
      mixPercent: 41,
    });

    await editor.get('button').trigger('click');
    expect(engineMock.connectMidiInput).toHaveBeenCalledWith({ path: 'input', slot: 'B', effectId: 'hrm_auto_m' });
    expect(editor.get('[data-midi-status]').text()).toBe('MIDI input connected');
    wrapper.unmount();
  });

  it('uses the shared MIDI state listener and disconnects explicitly', async () => {
    let stateListener: ((state: string) => void) | undefined;
    engineMock.onMidiInputStateChange.mockImplementation((listener: (state: string) => void) => {
      stateListener = listener;
      listener('connected');
      return vi.fn();
    });
    const wrapper = mount(HrmAutoFxEditor, {
      props: { modelValue: createDefaultHrmAutoParameters(), midiTarget: { path: 'track', slot: 'D', effectId: 'hrm_auto_m' } },
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('button').text()).toBe('Disconnect MIDI');
    stateListener?.('permission-denied');
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-midi-status]').text()).toBe('MIDI permission denied');
    expect(wrapper.get('button').text()).toBe('Connect MIDI');
    stateListener?.('connected');
    await wrapper.vm.$nextTick();
    await wrapper.get('button').trigger('click');
    expect(engineMock.disconnectMidiInput).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});
