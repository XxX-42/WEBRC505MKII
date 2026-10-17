import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';

describe('useTrackStripState STOP interactions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function mountStripState(transportEnabled = true) {
    const trackAudio = {
      state: 'EMPTY',
      track: { playLevel: 100, filterValue: 0.5, filterResonance: 1, filterEnabled: false, fxSw: 'OFF' },
      isAvailable: true,
      transportEnabled,
      disabledReason: '',
      updateSettings: vi.fn(),
      toggleReverse: vi.fn(),
      fxChain: { setFilterEnabled: vi.fn(), setFilterParam: vi.fn() },
      triggerRecord: vi.fn(),
      triggerStop: vi.fn(),
      clear: vi.fn(),
    };
    const capabilities = {
      availabilityReason: '',
      supportsTrackLevel: true,
      levelReason: '',
      supportsTrackFx: true,
      trackFxReason: '',
      supportsReverse: true,
      reverseReason: '',
    };
    vi.doMock('../../src/audio/AudioEngine', () => ({
      AudioEngine: {
        getInstance: () => ({
          tracks: [trackAudio],
          selectedBackend: 'BROWSER',
          selectedSampleRate: 48000,
          getMode: () => 'browser',
          getUiStatus: () => ({ ready: true }),
          getTrackCapabilities: () => capabilities,
          getNativeHqRenderer: () => ({ available: false, engines: [] }),
        }),
      },
    }));

    const { useTrackStripState } = await import('../../src/composables/useTrackStripState');
    let state!: ReturnType<typeof useTrackStripState>;
    const Host = defineComponent({
      setup() {
        state = useTrackStripState(1);
        return () => null;
      },
    });
    const wrapper = mount(Host);
    return { wrapper, state, trackAudio };
  }

  it('stops on a short keyboard release, clears after the long hold, and cancels interrupted pointer holds', async () => {
    const { wrapper, state, trackAudio } = await mountStripState();
    const down = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
    state.handleStopKeyDown(down);
    expect(state.stopPressActive.value).toBe(true);
    state.handleStopKeyDown(new KeyboardEvent('keydown', { key: ' ', repeat: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1499);
    expect(trackAudio.clear).not.toHaveBeenCalled();
    state.handleStopKeyUp(new KeyboardEvent('keyup', { key: ' ', cancelable: true }));
    expect(state.stopPressActive.value).toBe(false);
    expect(down.defaultPrevented).toBe(true);
    expect(trackAudio.triggerStop).toHaveBeenCalledTimes(1);

    state.startStopPress('keyboard');
    await vi.advanceTimersByTimeAsync(1500);
    expect(trackAudio.clear).toHaveBeenCalledTimes(1);
    state.endStopPress('keyboard');
    expect(trackAudio.triggerStop).toHaveBeenCalledTimes(1);

    state.startStopPress({} as PointerEvent);
    state.cancelStopPress({} as PointerEvent);
    expect(state.stopPressActive.value).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(trackAudio.clear).toHaveBeenCalledTimes(1);
    expect(trackAudio.triggerStop).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('keeps STOP inert while transport is unavailable', async () => {
    const { wrapper, state, trackAudio } = await mountStripState(false);
    state.startStopPress('keyboard');
    state.endStopPress('keyboard');
    await vi.advanceTimersByTimeAsync(1500);

    expect(trackAudio.triggerStop).not.toHaveBeenCalled();
    expect(trackAudio.clear).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
