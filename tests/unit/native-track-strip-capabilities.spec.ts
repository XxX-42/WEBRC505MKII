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

function createAudioEngine(mode: 'native' | 'browser', optionsByTrack = new Map<number, string[]>()) {
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
    getNativeHqRenderer: vi.fn(() => ({ available: false, engines: [] })),
    setTrackFxType: vi.fn(() => true),
    setTrackFxParameter: vi.fn(() => true),
    setTrackFxNamedParameters: vi.fn(() => true),
    setTrackFxActive: vi.fn(() => true),
    setFxType: vi.fn(() => true),
    setFxParam: vi.fn(() => true),
    setFxActive: vi.fn(() => true),
  };

  return { engine, tracks };
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

  it('disables Native track FX when the track exposes no catalog options', async () => {
    vi.useFakeTimers();
    const { engine } = createAudioEngine('native');
    wrapper = await mountTrack(engine);

    const fx = wrapper.get('button[data-label="FX"]');
    expect(fx.attributes('disabled')).toBeDefined();
    expect(fx.attributes('aria-label')).toContain('Native per-track FX are not exposed');
    expect(wrapper.get('[data-testid="track-fx-unavailable"]').text().toLowerCase()).toContain('native per-track fx are not exposed');
    expect(wrapper.get('[data-testid="track-level-fader"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="track-level-unavailable"]').text()).toContain('TRACK MIX IN BROWSER ONLY');
    expect(engine.setFxType).not.toHaveBeenCalled();
  });

  it('routes the Native track FX key to LCD track 2 without a shared FX toggle', async () => {
    vi.useFakeTimers();
    const { engine, tracks } = createAudioEngine('native', new Map([[2, ['DELAY', 'PHASER']]]));
    wrapper = await mountTrack(engine, 2);

    const fx = wrapper.get('button[data-label="FX"]');
    expect(fx.attributes('disabled')).toBeUndefined();
    await fx.trigger('click');

    const { useNativeTrackFxState } = await import('../../src/composables/useNativeTrackFxState');
    const { useDevicePanel } = await import('../../src/composables/useDevicePanel');
    const { usePanelFocus } = await import('../../src/composables/usePanelFocus');
    expect(useNativeTrackFxState().target.value).toBe(2);
    expect(useDevicePanel().state.page).toBe('track-fx');
    expect(usePanelFocus().state.currentTrackId).toBe(2);
    expect(usePanelFocus().state.panelFocusContext).toBe('track-fx');
    expect(tracks[1]!.track.fxSw).toBe('OFF');
    expect(usePanelFocus().state.trackFxApplyMap[2]).toBe(false);
    expect(engine.setFxType).not.toHaveBeenCalled();
    expect(engine.setFxActive).not.toHaveBeenCalled();
  });

  it('routes the Browser track FX key to LCD track 2 without the legacy fxSw toggle', async () => {
    vi.useFakeTimers();
    const { engine, tracks } = createAudioEngine('browser');
    wrapper = await mountTrack(engine, 2);

    const fx = wrapper.get('button[data-label="FX"]');
    expect(fx.attributes('disabled')).toBeUndefined();
    await fx.trigger('click');

    const { useBrowserTrackFxState } = await import('../../src/composables/useBrowserTrackFxState');
    const { useDevicePanel } = await import('../../src/composables/useDevicePanel');
    const { usePanelFocus } = await import('../../src/composables/usePanelFocus');
    expect(useBrowserTrackFxState().target.value).toBe(2);
    expect(useDevicePanel().state.page).toBe('track-fx');
    expect(usePanelFocus().state.currentTrackId).toBe(2);
    expect(usePanelFocus().state.panelFocusContext).toBe('track-fx');
    expect(tracks[1]!.track.fxSw).toBe('OFF');
    expect(usePanelFocus().state.trackFxApplyMap[2]).toBe(false);
    expect(engine.setFxType).not.toHaveBeenCalled();
    expect(engine.setFxActive).not.toHaveBeenCalled();
  });
});
