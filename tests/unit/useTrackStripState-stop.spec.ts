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

  async function mountStripState(transportEnabled = true, native = false) {
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
    let confirmedLevel = 100;
    const setMixerLevel = vi.fn(async (_id: number, value: number) => { confirmedLevel = value; });
    const engine = {
      tracks: [trackAudio], selectedBackend: native ? 'NATIVE' : 'BROWSER', selectedSampleRate: 48000,
      getMode: () => native ? 'native' : 'browser', getUiStatus: () => ({ ready: true }),
      getTrackCapabilities: () => capabilities, getNativeHqRenderer: () => ({ available: false, engines: [] }),
      getMixerState: () => ({ tracks: [confirmedLevel] }), setMixerLevel,
    };
    vi.doMock('../../src/audio/AudioEngine', () => ({
      AudioEngine: {
        getInstance: () => engine,
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
    return { wrapper, state, trackAudio, engine, setConfirmed: (value: number) => { confirmedLevel = value; } };
  }

  it('uses the Native mixer command and confirmed readback without mutating the proxy', async () => {
    const { wrapper, state, trackAudio, engine, setConfirmed } = await mountStripState(true, true);
    let finish!: () => void;
    engine.setMixerLevel.mockImplementationOnce(() => new Promise<void>(resolve => { finish = () => { setConfirmed(174); resolve(); }; }));
    const pending = state.handleLevelChange(175);
    expect(state.levelWritePending.value).toBe(true); expect(state.playLevel.value).toBe(100);
    await state.handleLevelChange(120);
    expect(engine.setMixerLevel).toHaveBeenCalledTimes(1); expect(engine.setMixerLevel).toHaveBeenCalledWith(1, 175);
    finish(); await pending;
    expect(state.playLevel.value).toBe(174); expect(state.levelWritePending.value).toBe(false);
    expect(trackAudio.track.playLevel).toBe(100); expect(trackAudio.updateSettings).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it('retains the last confirmed Native level and surfaces a rejected write', async () => {
    const { wrapper, state, engine, setConfirmed } = await mountStripState(true, true);
    setConfirmed(43); engine.setMixerLevel.mockRejectedValueOnce(new Error('HTTP 409 level rejected'));
    await state.handleLevelChange(180);
    expect(state.playLevel.value).toBe(43); expect(state.levelWritePending.value).toBe(false);
    const { useRc505Controls } = await import('../../src/composables/useRc505Controls');
    expect(JSON.stringify(useRc505Controls().state)).toContain('HTTP 409 level rejected');
    wrapper.unmount();
  });

  it('surfaces a rejected asynchronous REC completion through the control error state', async () => {
    const { wrapper, state, trackAudio } = await mountStripState(true, true);
    trackAudio.triggerRecord.mockRejectedValueOnce(new Error('Native REC completion was rejected'));
    await state.handleRecPlay();
    expect(trackAudio.triggerRecord).toHaveBeenCalledOnce();
    const { useRc505Controls } = await import('../../src/composables/useRc505Controls');
    expect(JSON.stringify(useRc505Controls().state)).toContain('Native REC completion was rejected');
    wrapper.unmount();
  });

  it('prevents a second track-strip REC command while the first Native ACK is pending', async () => {
    const { wrapper, state, trackAudio } = await mountStripState(true, true);
    let acknowledge!: () => void;
    trackAudio.triggerRecord.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    const first = state.handleRecPlay();
    expect(state.recordActionPending.value).toBe(true);
    await state.handleRecPlay();
    expect(trackAudio.triggerRecord).toHaveBeenCalledOnce();
    acknowledge();
    await first;
    expect(state.recordActionPending.value).toBe(false);
    wrapper.unmount();
  });

  it('stops on a short keyboard release, clears after the long hold, and cancels interrupted pointer holds', async () => {
    const { wrapper, state, trackAudio } = await mountStripState();
    const down = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
    state.handleStopKeyDown(down);
    expect(state.stopPressActive.value).toBe(true);
    state.handleStopKeyDown(new KeyboardEvent('keydown', { key: ' ', repeat: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1999);
    expect(trackAudio.clear).not.toHaveBeenCalled();
    state.handleStopKeyUp(new KeyboardEvent('keyup', { key: ' ', cancelable: true }));
    expect(state.stopPressActive.value).toBe(false);
    expect(down.defaultPrevented).toBe(true);
    expect(trackAudio.triggerStop).toHaveBeenCalledTimes(1);

    state.startStopPress('keyboard');
    await vi.advanceTimersByTimeAsync(2000);
    expect(trackAudio.clear).toHaveBeenCalledTimes(1);
    state.endStopPress('keyboard');
    expect(trackAudio.triggerStop).toHaveBeenCalledTimes(1);

    state.startStopPress({} as PointerEvent);
    state.cancelStopPress({} as PointerEvent);
    expect(state.stopPressActive.value).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(trackAudio.clear).toHaveBeenCalledTimes(1);
    expect(trackAudio.triggerStop).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('keeps STOP inert while transport is unavailable', async () => {
    const { wrapper, state, trackAudio } = await mountStripState(false);
    state.startStopPress('keyboard');
    state.endStopPress('keyboard');
    await vi.advanceTimersByTimeAsync(2000);

    expect(trackAudio.triggerStop).not.toHaveBeenCalled();
    expect(trackAudio.clear).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('cancels a pending clear on window blur, control-layer change and unmount', async () => {
    const { wrapper, state, trackAudio } = await mountStripState();
    state.startStopPress('keyboard');
    await vi.advanceTimersByTimeAsync(1000);
    window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(1200);
    expect(trackAudio.clear).not.toHaveBeenCalled();
    expect(trackAudio.triggerStop).not.toHaveBeenCalled();
    state.startStopPress('keyboard');
    const { useRc505Controls } = await import('../../src/composables/useRc505Controls');
    useRc505Controls().toggleUndoLayer();
    await vi.advanceTimersByTimeAsync(2100);
    expect(trackAudio.clear).not.toHaveBeenCalled();
    useRc505Controls().toggleUndoLayer();
    state.startStopPress('keyboard');
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(2100);
    expect(trackAudio.clear).not.toHaveBeenCalled();
  });

  it('cancels on runtime state or availability changes during a hold', async () => {
    const { wrapper, state, trackAudio } = await mountStripState();
    state.startStopPress('keyboard');
    await vi.advanceTimersByTimeAsync(1000);
    trackAudio.state = 'PLAYING';
    await vi.advanceTimersByTimeAsync(1100);
    expect(state.stopPressActive.value).toBe(false);
    expect(trackAudio.clear).not.toHaveBeenCalled();
    state.startStopPress('keyboard');
    trackAudio.transportEnabled = false;
    await vi.advanceTimersByTimeAsync(2100);
    state.endStopPress('keyboard');
    expect(trackAudio.clear).not.toHaveBeenCalled();
    expect(trackAudio.triggerStop).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('ignores mismatched pointers and cancels lost pointer capture', async () => {
    const { wrapper, state, trackAudio } = await mountStripState();
    const target = { setPointerCapture: vi.fn(), hasPointerCapture: () => false };
    const pointer = { button: 0, isPrimary: true, pointerId: 7, currentTarget: target } as unknown as PointerEvent;
    state.handleStopPointerDown(pointer);
    state.handleStopPointerUp({ ...pointer, pointerId: 8 } as PointerEvent);
    expect(state.stopPressActive.value).toBe(true);
    state.handleStopLostPointerCapture(pointer);
    await vi.advanceTimersByTimeAsync(2100);
    expect(state.stopPressActive.value).toBe(false);
    expect(trackAudio.clear).not.toHaveBeenCalled();
    expect(trackAudio.triggerStop).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
