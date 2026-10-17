import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

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

vi.mock('../../src/audio/AudioEngine', () => ({
  AudioEngine: { getInstance: () => engineMock },
}));

import OscVocFxEditor from '../../src/components/fx/OscVocFxEditor.vue';
import { createDefaultOscVocParameters } from '../../src/audio/oscVocParameters';

describe('OSC VOC (M) editor', () => {
  beforeEach(() => {
    engineMock.getMode.mockReturnValue('browser');
    engineMock.getMidiInputState.mockReturnValue('disconnected');
    engineMock.onMidiInputStateChange.mockClear();
    engineMock.connectMidiInput.mockReset().mockResolvedValue('connected');
    engineMock.disconnectMidiInput.mockClear();
  });

  it('shows parameter controls and requests MIDI only after the explicit connect action', async () => {
    const wrapper = mount(OscVocFxEditor, { props: { modelValue: createDefaultOscVocParameters(), midiTarget: { path: 'input', slot: 'B' } } });

    expect(wrapper.get('[data-osc-voc-editor]').exists()).toBe(true);
    expect(wrapper.get('.hint').text()).toContain('One monophonic carrier');
    expect(wrapper.get('[data-midi-status]').text()).toBe('MIDI input disconnected');
    expect(engineMock.getMidiInputState).toHaveBeenCalledOnce();
    expect(engineMock.onMidiInputStateChange).toHaveBeenCalledOnce();
    expect(engineMock.connectMidiInput).not.toHaveBeenCalled();

    await wrapper.get('[aria-label="OSC VOC carrier waveform"]').setValue('2');
    await wrapper.get('[aria-label="OSC VOC MIDI channel"]').setValue('7');
    await wrapper.get('[aria-label="OSC VOC octave transpose"]').setValue('-12');
    await wrapper.get('[aria-label="OSC VOC effect mix"]').setValue('43');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      waveform: 2,
      midiChannel: 7,
      octaveSemitones: -12,
      mixPercent: 43,
    });

    await wrapper.get('button').trigger('click');
    expect(engineMock.connectMidiInput).toHaveBeenCalledOnce();
    expect(engineMock.connectMidiInput).toHaveBeenCalledWith({ path: 'input', slot: 'B' });
    expect(wrapper.get('[data-midi-status]').text()).toBe('MIDI input connected');

    wrapper.unmount();
  });

  it('disconnects from MIDI only when connected and follows the shared state listener', async () => {
    let stateListener: ((state: string) => void) | undefined;
    engineMock.onMidiInputStateChange.mockImplementation((listener: (state: string) => void) => {
      stateListener = listener;
      listener('connected');
      return vi.fn();
    });
    const wrapper = mount(OscVocFxEditor, { props: { modelValue: createDefaultOscVocParameters(), midiTarget: { path: 'track', slot: 'D' } } });
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

  it('explains an unavailable Native slot and disconnects when its selected bank route changes', async () => {
    let stateListener: ((state: string) => void) | undefined;
    engineMock.getMode.mockReturnValue('native');
    engineMock.getMidiInputState.mockReturnValue('runtime-unavailable');
    engineMock.onMidiInputStateChange.mockImplementation((listener: (state: string) => void) => {
      stateListener = listener;
      listener('runtime-unavailable');
      return vi.fn();
    });
    const wrapper = mount(OscVocFxEditor, {
      props: { modelValue: createDefaultOscVocParameters(), midiTarget: { path: 'input', slot: 'A' } },
    });
    expect(wrapper.get('[data-midi-status]').text()).toContain('Native OSC VOC must be running');
    expect(wrapper.get('.hint').text()).toContain('up to 8 held MIDI notes');

    stateListener?.('connected');
    await wrapper.vm.$nextTick();
    await wrapper.setProps({ midiTarget: { path: 'track', slot: 'D' } });
    expect(engineMock.disconnectMidiInput).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});
