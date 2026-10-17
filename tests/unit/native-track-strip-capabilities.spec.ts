import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';

const HardwareButtonStub = defineComponent({
  props: {
    label: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    active: { type: Boolean, default: false },
    ariaLabel: { type: String, default: '' },
  },
  emits: ['press'],
  template: '<button type="button" :data-label="label" :disabled="disabled" :aria-label="ariaLabel" :data-active="active" @click="$emit(\'press\')">{{ label }}</button>',
});

const HardwareFaderStub = defineComponent({
  props: {
    disabled: { type: Boolean, default: false },
    disabledReason: { type: String, default: '' },
    ariaLabel: { type: String, default: '' },
    modelValue: { type: Number, default: 100 },
  },
  emits: ['update:modelValue'],
  template: '<input type="range" data-testid="track-level-fader" :disabled="disabled" :title="disabledReason" :aria-label="ariaLabel" :value="modelValue" @input="$emit(\'update:modelValue\', 50)">',
});

describe('Native TrackStrip per-track capability disclosure', () => {
  let wrapper: VueWrapper | null = null;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('disables the per-track FX toggle and level fader when Native exposes only a shared mix bus', async () => {
    vi.useFakeTimers();
    const track = {
      playLevel: 100,
      fxSw: 'OFF',
    };
    const trackAudio = {
      state: 'EMPTY',
      track,
      isReverse: false,
      isAvailable: true,
      transportEnabled: true,
      disabledReason: '',
      updateSettings: vi.fn(),
      toggleReverse: vi.fn(),
      fxChain: { setFilterEnabled: vi.fn(), setFilterParam: vi.fn(), setFilterValue: vi.fn() },
      triggerRecord: vi.fn(),
      triggerStop: vi.fn(),
      clear: vi.fn(),
    };
    vi.doMock('../../src/audio/AudioEngine', () => ({
      AudioEngine: {
        getInstance: () => ({
          tracks: [trackAudio],
          getTrackCapabilities: () => ({
            trackId: 1,
            isAvailable: true,
            availabilityReason: '',
            supportsTrackLevel: false,
            levelReason: 'TRACK MIX IN BROWSER ONLY',
            supportsTrackFx: false,
            trackFxReason: 'NATIVE TRACK A-D FX USE A SHARED POSTMIX BUS; PER-TRACK FILTER CONTROLS ARE UNAVAILABLE',
            supportsReverse: false,
            reverseReason: 'NO REVERSE IN NATIVE V1',
          }),
        }),
      },
    }));

    const component = (await import('../../src/components/panel/TrackStrip.vue')).default;
    wrapper = mount(component, {
      props: { trackId: 1 },
      global: { stubs: { HardwareButton: HardwareButtonStub, HardwareFader: HardwareFaderStub, LoopHalo: true } },
    });

    const fx = wrapper.get('button[data-label="FX"]');
    const level = wrapper.get('[data-testid="track-level-fader"]');
    expect(fx.attributes('disabled')).toBeDefined();
    expect(fx.attributes('aria-label')).toContain('individual FX unavailable');
    expect(level.attributes('disabled')).toBeDefined();
    expect(level.attributes('aria-label')).toContain('level unavailable');
    expect(wrapper.get('[data-testid="track-fx-unavailable"]').text()).toContain('SHARED POSTMIX BUS');
    expect(wrapper.get('[data-testid="track-level-unavailable"]').text()).toContain('TRACK MIX IN BROWSER ONLY');

    await fx.trigger('click');
    await level.setValue(50);
    expect(track.fxSw).toBe('OFF');
    expect(track.playLevel).toBe(100);
    expect(trackAudio.updateSettings).not.toHaveBeenCalled();
  });
});
