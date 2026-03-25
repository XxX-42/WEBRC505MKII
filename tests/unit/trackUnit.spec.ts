import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';

const StubButton = defineComponent({
  props: {
    label: { type: String, default: '' },
  },
  emits: ['press'],
  template: '<button type="button" class="stub-button" :data-label="label" @click="$emit(\'press\')">{{ label }}</button>',
});

const StubKnob = defineComponent({
  props: {
    label: { type: String, default: '' },
  },
  emits: ['update:modelValue'],
  template: '<button type="button" class="stub-knob" :data-label="label" @click="$emit(\'update:modelValue\', label === \'FREQ\' ? 80 : 7)">{{ label }}</button>',
});

const StubFader = defineComponent({
  emits: ['update:modelValue'],
  template: '<button type="button" class="stub-fader" @click="$emit(\'update:modelValue\', 73)">FADER</button>',
});

describe('TrackUnit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function mountTrackUnit(options: {
    trackCapabilities: {
      supportsTrackLevel: boolean;
      levelReason: string;
      supportsTrackFx: boolean;
      trackFxReason: string;
      supportsReverse: boolean;
      reverseReason: string;
    };
    trackAudio: {
      state: string;
      track: {
        playLevel: number;
        filterValue: number;
        filterResonance: number;
        filterEnabled: boolean;
      };
      isReverse: boolean;
      isAvailable: boolean;
      transportEnabled: boolean;
      disabledReason: string;
      updateSettings: ReturnType<typeof vi.fn>;
      toggleReverse: ReturnType<typeof vi.fn>;
      fxChain: {
        setFilterEnabled: ReturnType<typeof vi.fn>;
        setFilterParam: ReturnType<typeof vi.fn>;
      };
      triggerRecord: ReturnType<typeof vi.fn>;
      triggerStop: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
    };
  }) {
    vi.doMock('../../src/audio/AudioEngine', () => ({
      AudioEngine: {
        getInstance: () => ({
          tracks: [options.trackAudio],
          getTrackCapabilities: () => options.trackCapabilities,
        }),
      },
    }));

    const component = (await import('../../src/components/TrackUnit.vue')).default;
    return mount(component, {
      props: { trackId: 1 },
      global: {
        stubs: {
          HardwareButton: StubButton,
          HardwareKnob: StubKnob,
          HardwareFader: StubFader,
          LoopHalo: true,
        },
      },
    });
  }

  it('writes back level, filter, and reverse controls in browser mode', async () => {
    const trackAudio = {
      state: 'EMPTY',
      track: {
        playLevel: 100,
        filterValue: 0.5,
        filterResonance: 1,
        filterEnabled: false,
      },
      isReverse: false,
      isAvailable: true,
      transportEnabled: true,
      disabledReason: '',
      updateSettings: vi.fn(),
      toggleReverse: vi.fn(function (this: { isReverse: boolean }) {
        this.isReverse = !this.isReverse;
      }),
      fxChain: {
        setFilterEnabled: vi.fn(),
        setFilterParam: vi.fn(),
      },
      triggerRecord: vi.fn(),
      triggerStop: vi.fn(),
      clear: vi.fn(),
    };

    const wrapper = await mountTrackUnit({
      trackAudio,
      trackCapabilities: {
        supportsTrackLevel: true,
        levelReason: '',
        supportsTrackFx: true,
        trackFxReason: '',
        supportsReverse: true,
        reverseReason: '',
      },
    });

    await wrapper.get('.stub-fader').trigger('click');
    await wrapper.get('[data-label="FX"]').trigger('click');
    await wrapper.get('[data-label="FREQ"]').trigger('click');
    await wrapper.get('[data-label="RES"]').trigger('click');
    await wrapper.get('[data-label="TRACK"]').trigger('click');

    expect(trackAudio.track.playLevel).toBe(73);
    expect(trackAudio.updateSettings).toHaveBeenCalled();
    expect(trackAudio.track.filterEnabled).toBe(true);
    expect(trackAudio.fxChain.setFilterEnabled).toHaveBeenCalledWith(true);
    expect(trackAudio.fxChain.setFilterParam).toHaveBeenCalledWith('frequency', 0.8);
    expect(trackAudio.fxChain.setFilterParam).toHaveBeenCalledWith('resonance', 0.7);
    expect(trackAudio.toggleReverse).toHaveBeenCalled();

    wrapper.unmount();
  });

  it('shows capability reasons and keeps upper deck inert when native limits apply', async () => {
    const trackAudio = {
      state: 'EMPTY',
      track: {
        playLevel: 100,
        filterValue: 0.5,
        filterResonance: 1,
        filterEnabled: false,
      },
      isReverse: false,
      isAvailable: true,
      transportEnabled: true,
      disabledReason: '',
      updateSettings: vi.fn(),
      toggleReverse: vi.fn(),
      fxChain: {
        setFilterEnabled: vi.fn(),
        setFilterParam: vi.fn(),
      },
      triggerRecord: vi.fn(),
      triggerStop: vi.fn(),
      clear: vi.fn(),
    };

    const wrapper = await mountTrackUnit({
      trackAudio,
      trackCapabilities: {
        supportsTrackLevel: false,
        levelReason: 'TRACK MIX IN BROWSER ONLY',
        supportsTrackFx: false,
        trackFxReason: 'NO FX IN NATIVE V1',
        supportsReverse: false,
        reverseReason: 'NO REVERSE IN NATIVE V1',
      },
    });

    expect(wrapper.text()).toContain('TRACK MIX IN BROWSER ONLY');
    expect(wrapper.text()).toContain('NO FX IN NATIVE V1');
    expect(wrapper.text()).toContain('NO REVERSE IN NATIVE V1');

    trackAudio.updateSettings.mockClear();
    trackAudio.fxChain.setFilterEnabled.mockClear();
    trackAudio.toggleReverse.mockClear();

    await wrapper.get('.stub-fader').trigger('click');
    await wrapper.get('[data-label="FX"]').trigger('click');
    await wrapper.get('[data-label="TRACK"]').trigger('click');

    expect(trackAudio.updateSettings).not.toHaveBeenCalled();
    expect(trackAudio.fxChain.setFilterEnabled).not.toHaveBeenCalled();
    expect(trackAudio.toggleReverse).not.toHaveBeenCalled();

    wrapper.unmount();
  });
});
