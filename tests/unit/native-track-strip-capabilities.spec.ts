import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';

const HardwareButtonStub = defineComponent({
  props: {
    label: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    active: { type: Boolean, default: false },
    ariaLabel: { type: String, default: '' },
    ledColor: { type: String, default: 'neutral' },
    ledOn: { type: Boolean, default: false },
  },
  emits: ['press'],
  template: '<button type="button" :data-label="label" :disabled="disabled" :aria-label="ariaLabel" :data-active="active" :data-led-color="ledColor" :data-led-on="ledOn" @click="$emit(\'press\')">{{ label }}</button>',
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

function createAudioEngine(mode: 'native' | 'browser', optionsByTrack = new Map<number, string[]>()) {
  let historyStatus = { canUndo: false, canRedo: false, busy: false };
  const tracks = Array.from({ length: 5 }, (_, index) => {
    const track = { playLevel: 100, fxSw: 'OFF' };
    return {
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
      trackId: index + 1,
    };
  });

  const engine = {
    tracks,
    selectedBackend: mode === 'native' ? 'NATIVE' : 'BROWSER',
    selectedSampleRate: 48000,
    getMode: vi.fn(() => mode),
    getUiStatus: vi.fn(() => ({ ready: true, message: '' })),
    onStatusChange: vi.fn(() => () => {}),
    getTrackCapabilities: vi.fn((trackId: number) => ({
      trackId,
      isAvailable: true,
      availabilityReason: '',
      supportsTrackLevel: mode === 'browser',
      levelReason: mode === 'browser' ? '' : 'TRACK MIX IN BROWSER ONLY',
      supportsTrackFx: mode === 'browser',
      trackFxReason: mode === 'browser' ? '' : 'NATIVE LEGACY FILTER ROUTE IS UNAVAILABLE',
      supportsReverse: false,
      reverseReason: 'NO REVERSE IN THIS RUNTIME',
    })),
    getNativeCatalogFxOptions: vi.fn((_path: string, trackId: number) => optionsByTrack.get(trackId) ?? []),
    getNativeCatalogFxSlotStatus: vi.fn(() => null),
    getTrackFxStatus: vi.fn(() => []),
    getTrackHistoryStatus: vi.fn(() => historyStatus),
    getNativeHqRenderer: vi.fn(() => ({ available: false, engines: [] })),
    setTrackFxType: vi.fn(() => true),
    setTrackFxParameter: vi.fn(() => true),
    setTrackFxNamedParameters: vi.fn(() => true),
    setTrackFxActive: vi.fn(() => true),
    setFxType: vi.fn(() => true),
    setFxParam: vi.fn(() => true),
    setFxActive: vi.fn(() => true),
  };

  return { engine, tracks, setHistoryStatus: (status: typeof historyStatus) => { historyStatus = status; } };
}

async function mountTrack(engine: ReturnType<typeof createAudioEngine>['engine'], trackId = 2) {
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine } }));
  const component = (await import('../../src/components/panel/TrackStrip.vue')).default;
  return mount(component, {
    props: { trackId },
    global: { stubs: { HardwareButton: HardwareButtonStub, HardwareFader: HardwareFaderStub, LoopHalo: true } },
  });
}

describe('TrackStrip physical FX key', () => {
  let wrapper: VueWrapper | null = null;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('keeps Classic per-track FX apply disabled when no per-track shared-FX gate exists', async () => {
    vi.useFakeTimers();
    const { engine } = createAudioEngine('native');
    wrapper = await mountTrack(engine);

    const fx = wrapper.get('button[data-label="FX"]');
    expect(fx.attributes('disabled')).toBeDefined();
    expect(fx.attributes('data-hardware-role')).toBe('TRACK_FX_APPLY');
    expect(fx.attributes('aria-label')).toContain('Per-track application of the shared Track FX is unavailable');
    expect(wrapper.get('[data-testid="track-fx-unavailable"]').text()).toBe('Per-track application of the shared Track FX is unavailable.');
    expect(wrapper.get('[data-testid="track-level-fader"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="track-level-unavailable"]').text()).toContain('TRACK MIX IN BROWSER ONLY');
    expect(engine.setFxType).not.toHaveBeenCalled();
  });

  it('does not mistake Native private FX catalog options for Classic shared per-track apply support', async () => {
    vi.useFakeTimers();
    const { engine, tracks } = createAudioEngine('native', new Map([[2, ['DELAY', 'PHASER']]]));
    wrapper = await mountTrack(engine, 2);

    const fx = wrapper.get('button[data-label="FX"]');
    expect(fx.attributes('disabled')).toBeDefined();
    expect(fx.attributes('data-hardware-role')).toBe('TRACK_FX_APPLY');
    const { useNativeTrackFxState } = await import('../../src/composables/useNativeTrackFxState');
    const { useDevicePanel } = await import('../../src/composables/useDevicePanel');
    const { usePanelFocus } = await import('../../src/composables/usePanelFocus');
    const targetBefore = useNativeTrackFxState().target.value;
    const pageBefore = useDevicePanel().state.page;
    const focusBefore = usePanelFocus().state.panelFocusContext;
    await fx.trigger('click');

    expect(useNativeTrackFxState().target.value).toBe(targetBefore);
    expect(useDevicePanel().state.page).toBe(pageBefore);
    expect(usePanelFocus().state.panelFocusContext).toBe(focusBefore);
    expect(tracks[1]!.track.fxSw).toBe('OFF');
    expect(usePanelFocus().state.trackFxApplyMap[2]).toBe(false);
    expect(engine.setFxType).not.toHaveBeenCalled();
    expect(engine.setFxActive).not.toHaveBeenCalled();
  });

  it('does not expose Classic shared per-track FX apply in Browser mode', async () => {
    vi.useFakeTimers();
    const { engine, tracks } = createAudioEngine('browser');
    wrapper = await mountTrack(engine, 2);

    const fx = wrapper.get('button[data-label="FX"]');
    expect(fx.attributes('disabled')).toBeDefined();
    expect(fx.attributes('data-hardware-role')).toBe('TRACK_FX_APPLY');
    const { useBrowserTrackFxState } = await import('../../src/composables/useBrowserTrackFxState');
    const { useDevicePanel } = await import('../../src/composables/useDevicePanel');
    const { usePanelFocus } = await import('../../src/composables/usePanelFocus');
    const targetBefore = useBrowserTrackFxState().target.value;
    const pageBefore = useDevicePanel().state.page;
    const focusBefore = usePanelFocus().state.panelFocusContext;
    await fx.trigger('click');

    expect(useBrowserTrackFxState().target.value).toBe(targetBefore);
    expect(useDevicePanel().state.page).toBe(pageBefore);
    expect(usePanelFocus().state.panelFocusContext).toBe(focusBefore);
    expect(tracks[1]!.track.fxSw).toBe('OFF');
    expect(usePanelFocus().state.trackFxApplyMap[2]).toBe(false);
    expect(engine.setFxType).not.toHaveBeenCalled();
    expect(engine.setFxActive).not.toHaveBeenCalled();
  });

  it('refreshes the UNDO LED after history settles without an audio status event', async () => {
    vi.useFakeTimers();
    const { engine, tracks, setHistoryStatus } = createAudioEngine('native');
    tracks[1]!.state = 'STOPPED';
    setHistoryStatus({ canUndo: true, canRedo: false, busy: true });
    wrapper = await mountTrack(engine, 2);

    const { useRc505Controls } = await import('../../src/composables/useRc505Controls');
    useRc505Controls().toggleUndoLayer();
    await nextTick();
    const record = wrapper.get('button[data-panel-control="record-play"]');
    expect(record.attributes('data-hardware-role')).toBe('UNDO');
    expect(record.attributes('disabled')).toBeDefined();
    expect(record.attributes('data-led-on')).toBe('false');

    setHistoryStatus({ canUndo: true, canRedo: false, busy: false });
    await vi.advanceTimersByTimeAsync(60);

    expect(record.attributes('data-hardware-role')).toBe('UNDO');
    expect(record.attributes('disabled')).toBeUndefined();
    expect(record.attributes('data-led-on')).toBe('true');
    expect(record.attributes('data-led-color')).toBe('green');
    expect(tracks[1]!.state).toBe('STOPPED');
  });
});
