import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';

const StubButton = defineComponent({
  props: {
    label: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    disabledReason: { type: String, default: '' },
  },
  emits: ['press', 'release', 'cancel'],
  template: '<button type="button" class="stub-button" :data-label="label" @click="$emit(\'press\')">{{ label }}</button>',
});

const StubKnob = defineComponent({
  props: {
    label: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    disabledReason: { type: String, default: '' },
  },
  emits: ['update:modelValue'],
  template: '<button type="button" class="stub-knob" :data-label="label" @click="$emit(\'update:modelValue\', label === \'FREQ\' ? 80 : 7)">{{ label }}</button>',
});

const StubFader = defineComponent({
  props: {
    disabled: { type: Boolean, default: false },
    disabledReason: { type: String, default: '' },
  },
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
    } | (() => {
      supportsTrackLevel: boolean;
      levelReason: string;
      supportsTrackFx: boolean;
      trackFxReason: string;
      supportsReverse: boolean;
      reverseReason: string;
    });
    trackId?: number;
    runtimeReady?: () => boolean;
    runtimeMessage?: () => string;
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
    const trackId = options.trackId ?? 1;
    const statusListeners = new Set<(status: { ready: boolean; message: string }) => void>();
    const getUiStatus = () => ({
      ready: options.runtimeReady?.() ?? true,
      message: options.runtimeMessage?.() ?? '',
    });
    const engine = {
      tracks: Array.from({ length: trackId }, (_, index) => index === trackId - 1 ? options.trackAudio : undefined),
      getTrackCapabilities: () => typeof options.trackCapabilities === 'function'
        ? options.trackCapabilities()
        : options.trackCapabilities,
      getUiStatus,
      onStatusChange: (listener: (status: ReturnType<typeof getUiStatus>) => void) => {
        statusListeners.add(listener);
        listener(getUiStatus());
        return () => statusListeners.delete(listener);
      },
    };
    vi.doMock('../../src/audio/AudioEngine', () => ({
      AudioEngine: {
        getInstance: () => engine,
      },
    }));

    const component = (await import('../../src/components/TrackUnit.vue')).default;
    const wrapper = mount(component, {
      props: { trackId },
      global: {
        stubs: {
          HardwareButton: StubButton,
          HardwareKnob: StubKnob,
          HardwareFader: StubFader,
          LoopHalo: true,
        },
      },
    });
    return {
      wrapper,
      notifyStatusChange: () => {
        for (const listener of statusListeners) listener(getUiStatus());
      },
    };
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

    const { wrapper } = await mountTrackUnit({
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

  it('locks the Enhanced REC button until Native ACK and reports a rejected action', async () => {
    const trackAudio = {
      state: 'EMPTY',
      track: { playLevel: 100, filterValue: 0.5, filterResonance: 1, filterEnabled: false },
      isReverse: false,
      isAvailable: true,
      transportEnabled: true,
      disabledReason: '',
      updateSettings: vi.fn(),
      toggleReverse: vi.fn(),
      fxChain: { setFilterEnabled: vi.fn(), setFilterParam: vi.fn() },
      triggerRecord: vi.fn(),
      triggerStop: vi.fn(),
      clear: vi.fn(),
    };
    let acknowledge!: () => void;
    trackAudio.triggerRecord.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const { wrapper } = await mountTrackUnit({
      trackAudio,
      trackCapabilities: { supportsTrackLevel: true, levelReason: '', supportsTrackFx: true,
        trackFxReason: '', supportsReverse: true, reverseReason: '' },
    });
    const recordButton = wrapper.findAllComponents(StubButton).find(button => button.props('label') === '')!;

    await recordButton.trigger('click');
    expect(trackAudio.triggerRecord).toHaveBeenCalledOnce();
    expect(recordButton.props('disabled')).toBe(true);
    expect(recordButton.props('disabledReason')).toContain('acknowledgement');
    await recordButton.trigger('click');
    expect(trackAudio.triggerRecord).toHaveBeenCalledOnce();

    acknowledge();
    await Promise.resolve(); await wrapper.vm.$nextTick();
    expect(recordButton.props('disabled')).toBe(false);

    trackAudio.triggerRecord.mockRejectedValueOnce(new Error('Enhanced Native REC rejected'));
    await recordButton.trigger('click');
    await Promise.resolve(); await wrapper.vm.$nextTick();
    const { useRc505Controls } = await import('../../src/composables/useRc505Controls');
    expect(useRc505Controls().state.errorDetail).toBe('Enhanced Native REC rejected');
    expect(recordButton.props('disabled')).toBe(false);
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

    const { wrapper } = await mountTrackUnit({
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

    expect(wrapper.findAllComponents(StubKnob).every((knob) => knob.props('disabled'))).toBe(true);
    expect(wrapper.findAllComponents(StubButton).find((button) => button.props('label') === 'FX')?.props('disabled')).toBe(true);
    expect(wrapper.findAllComponents(StubButton).find((button) => button.props('label') === 'TRACK')?.props('disabled')).toBe(true);
    expect(wrapper.getComponent(StubFader).props('disabled')).toBe(true);

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

  it('stops on a short release, cancels interrupted holds, and clears only after 2000ms', async () => {
    const trackAudio = {
      state: 'EMPTY',
      track: { playLevel: 100, filterValue: 0.5, filterResonance: 1, filterEnabled: false },
      isReverse: false,
      isAvailable: true,
      transportEnabled: true,
      disabledReason: '',
      updateSettings: vi.fn(),
      toggleReverse: vi.fn(),
      fxChain: { setFilterEnabled: vi.fn(), setFilterParam: vi.fn() },
      triggerRecord: vi.fn(),
      triggerStop: vi.fn(),
      clear: vi.fn(),
    };
    const { wrapper } = await mountTrackUnit({
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
    const stopButton = wrapper.findAllComponents(StubButton).find((button) => button.props('label') === 'STOP');
    expect(stopButton).toBeDefined();

    stopButton!.vm.$emit('press');
    stopButton!.vm.$emit('release');
    expect(trackAudio.triggerStop).toHaveBeenCalledTimes(1);

    stopButton!.vm.$emit('press');
    stopButton!.vm.$emit('cancel');
    await vi.advanceTimersByTimeAsync(2000);
    expect(trackAudio.clear).not.toHaveBeenCalled();
    expect(trackAudio.triggerStop).toHaveBeenCalledTimes(1);

    stopButton!.vm.$emit('press');
    await vi.advanceTimersByTimeAsync(1999);
    expect(trackAudio.clear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(trackAudio.clear).toHaveBeenCalledTimes(1);
    stopButton!.vm.$emit('release');
    expect(trackAudio.triggerStop).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it('refreshes Native track capabilities when status expands from one track to five', async () => {
    const trackAudio = {
      state: 'EMPTY',
      track: { playLevel: 100, filterValue: 0.5, filterResonance: 1, filterEnabled: false },
      isReverse: false,
      isAvailable: true,
      transportEnabled: true,
      disabledReason: '',
      updateSettings: vi.fn(),
      toggleReverse: vi.fn(),
      fxChain: { setFilterEnabled: vi.fn(), setFilterParam: vi.fn() },
      triggerRecord: vi.fn(),
      triggerStop: vi.fn(),
      clear: vi.fn(),
    };
    let nativeTrackCount = 1;
    const capabilities = () => nativeTrackCount === 1
      ? {
        supportsTrackLevel: false,
        levelReason: 'TRACK 2 NOT EXPOSED BY NATIVE STATUS',
        supportsTrackFx: false,
        trackFxReason: 'TRACK 2 FX NOT EXPOSED BY NATIVE STATUS',
        supportsReverse: false,
        reverseReason: 'TRACK 2 REVERSE NOT EXPOSED BY NATIVE STATUS',
      }
      : {
        supportsTrackLevel: true,
        levelReason: '',
        supportsTrackFx: true,
        trackFxReason: '',
        supportsReverse: true,
        reverseReason: '',
      };

    const { wrapper, notifyStatusChange } = await mountTrackUnit({
      trackId: 2,
      trackAudio,
      trackCapabilities: capabilities,
    });

    expect(wrapper.text()).toContain('TRACK 2 NOT EXPOSED BY NATIVE STATUS');
    expect(wrapper.findComponent(StubFader).props('disabled')).toBe(true);

    nativeTrackCount = 5;
    notifyStatusChange();
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).not.toContain('NOT EXPOSED BY NATIVE STATUS');
    expect(wrapper.findComponent(StubFader).props('disabled')).toBe(false);
    expect(wrapper.findAllComponents(StubKnob).every((knob) => !knob.props('disabled'))).toBe(true);
    expect(wrapper.findAllComponents(StubButton).find((button) => button.props('label') === 'FX')?.props('disabled')).toBe(false);
    expect(wrapper.findAllComponents(StubButton).find((button) => button.props('label') === 'TRACK')?.props('disabled')).toBe(false);

    wrapper.unmount();
  });

  it('keeps Browser transport disabled until the audio engine reports ready', async () => {
    const trackAudio = {
      state: 'EMPTY',
      track: { playLevel: 100, filterValue: 0.5, filterResonance: 1, filterEnabled: false },
      isReverse: false,
      isAvailable: true,
      transportEnabled: true,
      disabledReason: '',
      updateSettings: vi.fn(),
      toggleReverse: vi.fn(),
      fxChain: { setFilterEnabled: vi.fn(), setFilterParam: vi.fn() },
      triggerRecord: vi.fn(),
      triggerStop: vi.fn(),
      clear: vi.fn(),
    };
    let ready = false;
    const { wrapper, notifyStatusChange } = await mountTrackUnit({
      trackAudio,
      runtimeReady: () => ready,
      runtimeMessage: () => ready ? 'BROWSER AUDIO READY' : 'BROWSER AUDIO NOT INITIALIZED',
      trackCapabilities: {
        supportsTrackLevel: true,
        levelReason: '',
        supportsTrackFx: true,
        trackFxReason: '',
        supportsReverse: true,
        reverseReason: '',
      },
    });

    const recordButton = wrapper.findAllComponents(StubButton).find((button) => button.props('label') === '');
    const stopButton = wrapper.findAllComponents(StubButton).find((button) => button.props('label') === 'STOP');
    expect(recordButton?.props('disabled')).toBe(true);
    expect(stopButton?.props('disabled')).toBe(true);

    ready = true;
    notifyStatusChange();
    await wrapper.vm.$nextTick();

    expect(recordButton?.props('disabled')).toBe(false);
    expect(stopButton?.props('disabled')).toBe(false);
    wrapper.unmount();
  });
});
