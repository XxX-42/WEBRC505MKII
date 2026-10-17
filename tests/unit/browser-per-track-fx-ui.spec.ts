import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const wrappers: VueWrapper[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.doUnmock('../../src/audio/AudioEngine');
});

async function loadPanel(mode: 'browser' | 'native' = 'browser', surface: 'classic' | 'tech' = 'classic') {
  vi.resetModules();
  let error: string | null = null;
  const listeners: Array<() => void> = [];
  const engine = {
    getMode: () => mode,
    onStatusChange: vi.fn((callback: () => void) => { listeners.push(callback); return () => {}; }),
    getCapabilities: () => ({ supportsInputFx: true, supportsTrackFx: true, fxReason: '' }),
    isTrackAvailable: vi.fn(() => true),
    getTrackCapabilities: vi.fn((trackId: number) => ({ trackId, isAvailable: true, availabilityReason: '', supportsTrackLevel: true, levelReason: '', supportsTrackFx: false, trackFxReason: '', supportsReverse: false, reverseReason: '' })),
    getNativeCatalogFxOptions: () => [],
    getNativeCatalogFxSlotStatus: () => null,
    setFxType: vi.fn(), setFxParam: vi.fn(), setFxActive: vi.fn(), setCatalogFxParameters: vi.fn(),
    setTrackFxType: vi.fn(() => true),
    setTrackFxParameter: vi.fn(() => true),
    setTrackFxNamedParameters: vi.fn(() => true),
    setTrackFxActive: vi.fn(() => true),
    getTrackFxStatus: vi.fn((trackId: number) => [{
      trackId, available: true, routeMode: 'per-track-pre-mix', legacySharedPostmix: true,
      slots: ['A', 'B', 'C', 'D'].map((slot, slotIndex) => ({ slot, slotIndex, type: 'DELAY', state: error ? 'error' : 'ready', error, bypassed: Boolean(error), active: !error })),
    }]),
  };
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine } }));
  const component = surface === 'classic'
    ? (await import('../../src/components/panel/TrackFxPanel.vue')).default
    : (await import('../../src/components/TopPanel.vue')).default;
  const wrapper = shallowMount(component, { global: { stubs: { BrowserTrackFxPanel: false, NativeTrackFxPanel: false } } });
  wrappers.push(wrapper);
  const state = (await import('../../src/composables/useBrowserTrackFxState')).useBrowserTrackFxState();
  vi.clearAllMocks();
  return { wrapper, engine, state, reportError: async (message: string) => { error = message; listeners.forEach((listener) => listener()); await nextTick(); } };
}

describe('Browser per-track FX target UI', () => {
  it('routes independent track/slot controls, then returns to the unchanged shared editor', async () => {
    const { wrapper, engine } = await loadPanel();
    const target = wrapper.get('[aria-label="Track FX target"]');
    expect(target.findAll('option')).toHaveLength(6);
    expect(wrapper.text()).toContain('SHARED BANK · POST-MIX');
    expect(wrapper.find('[data-browser-track-fx]').exists()).toBe(false);

    await target.setValue('2');
    expect(wrapper.get('[data-track-fx-context]').text()).toBe('TRACK 2 · SLOT A');
    const types = wrapper.get('[aria-label="Per-track FX type"]');
    await types.setValue('DELAY');
    const trackEditor = wrapper.vm as unknown as { updateActiveValue(value: number): void };
    trackEditor.updateActiveValue(41);
    expect(engine.setTrackFxParameter).toHaveBeenLastCalledWith(2, 0, 41);
    expect(engine.setFxParam).not.toHaveBeenCalled();
    const options = types.findAll('option').map((option) => option.element.value);
    expect(options).toContain('DELAY');
    expect(options).not.toContain('BEAT SHIFT');
    expect(options).not.toContain('VINYL FLICK');
    expect(options).not.toContain('OSC VOC (M)');
    await wrapper.get('[aria-label="Per-track FX amount"]').setValue('57');
    await wrapper.get('[aria-label="Track 2 slot A delayTimeMs"]').setValue('734');
    await wrapper.get('[aria-label="Toggle per-track FX slot"]').trigger('click');
    expect(engine.setTrackFxType).toHaveBeenCalledWith(2, 0, 'DELAY');
    expect(engine.setTrackFxParameter).toHaveBeenLastCalledWith(2, 0, 57);
    expect(engine.setTrackFxNamedParameters).toHaveBeenLastCalledWith(2, 0, { delayTimeMs: 734 });
    expect(engine.setTrackFxActive).toHaveBeenLastCalledWith(2, 0, true);
    expect(engine.setFxType).not.toHaveBeenCalled();
    expect(engine.setFxParam).not.toHaveBeenCalled();
    expect(engine.setCatalogFxParameters).not.toHaveBeenCalled();

    await wrapper.get('[aria-label="Select Track 2 FX slot C"]').trigger('click');
    expect(wrapper.get('[data-track-fx-context]').text()).toBe('TRACK 2 · SLOT C');
    expect((wrapper.get('[aria-label="Per-track FX type"]').element as HTMLSelectElement).value).toBe('NONE');
    await wrapper.get('[aria-label="Per-track FX type"]').setValue('PHASER');
    expect(engine.setTrackFxType).toHaveBeenLastCalledWith(2, 2, 'PHASER');
    await target.setValue('1');
    expect(wrapper.get('[data-track-fx-context]').text()).toBe('TRACK 1 · SLOT A');
    expect((wrapper.get('[aria-label="Per-track FX type"]').element as HTMLSelectElement).value).toBe('NONE');
    await target.setValue('2');
    expect(wrapper.get('[data-track-fx-context]').text()).toBe('TRACK 2 · SLOT C');
    await wrapper.get('[aria-label="Select Track 2 FX slot A"]').trigger('click');
    expect((wrapper.get('[aria-label="Per-track FX amount"]').element as HTMLInputElement).value).toBe('57');
    expect((wrapper.get('[aria-label="Track 2 slot A delayTimeMs"]').element as HTMLInputElement).value).toBe('734');

    await target.setValue('shared');
    expect(wrapper.find('[data-browser-track-fx]').exists()).toBe(false);
    expect(wrapper.find('hardware-knob-stub').exists()).toBe(true);
    expect(wrapper.text()).toContain('SHARED BANK · POST-MIX');
  });

  it('shows unsupported saved source-transport settings and runtime failures explicitly', async () => {
    localStorage.setItem('webrc505_browser_per_track_fx_v1', JSON.stringify({
      version: 1, target: 4,
      tracks: Array.from({ length: 5 }, (_, index) => ({ trackId: index + 1, activeSlot: 'A', slots: [{ type: index === 3 ? 'VINYL FLICK' : 'NONE', active: true }] })),
    }));
    const { wrapper, reportError } = await loadPanel();
    expect(wrapper.get('[data-track-fx-context]').text()).toBe('TRACK 4 · SLOT A');
    expect(wrapper.get('[role="alert"]').text()).toContain('Unsupported saved per-track FX: VINYL FLICK');
    expect((wrapper.get('[aria-label="Per-track FX type"]').element as HTMLSelectElement).value).toBe('NONE');
    expect(wrapper.get('[aria-label="Toggle per-track FX slot"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[aria-label="Per-track FX type"]').setValue('DELAY');
    await wrapper.get('[aria-label="Toggle per-track FX slot"]').trigger('click');
    expect(wrapper.get('[aria-label="Toggle per-track FX slot"]').attributes('aria-pressed')).toBe('true');
    await reportError('AudioWorklet module failed');
    expect(wrapper.get('[data-track-fx-runtime-status]').text()).toBe('BYPASSED: AudioWorklet module failed');
    expect(wrapper.get('[aria-label="Toggle per-track FX slot"]').attributes('aria-pressed')).toBe('false');
  });

  it('offers the same independent Browser targeting in the tech shell without routing through its shared macros', async () => {
    const { wrapper, engine, state } = await loadPanel('browser', 'tech');
    expect(wrapper.findAll('fx-unit-stub')).toHaveLength(8);
    const target = wrapper.get('[aria-label="Track FX target"]');
    await target.setValue('5');
    expect(wrapper.findAll('fx-unit-stub')).toHaveLength(4);
    await wrapper.get('[aria-label="Select Track 5 FX slot D"]').trigger('click');
    await wrapper.get('[aria-label="Per-track FX type"]').setValue('ELECTRIC');
    await wrapper.get('[aria-label="Track 5 slot D electricCharacter"]').setValue('2');
    await wrapper.get('[aria-label="Toggle per-track FX slot"]').trigger('click');
    expect(wrapper.get('[data-track-fx-context]').text()).toBe('TRACK 5 · SLOT D');
    expect(engine.setTrackFxType).toHaveBeenLastCalledWith(5, 3, 'ELECTRIC');
    expect(engine.setTrackFxNamedParameters).toHaveBeenLastCalledWith(5, 3, { electricCharacter: 2 });
    expect(engine.setTrackFxActive).toHaveBeenLastCalledWith(5, 3, true);
    expect(engine.setFxType).not.toHaveBeenCalled();
    expect(engine.setFxParam).not.toHaveBeenCalled();
    expect(engine.setCatalogFxParameters).not.toHaveBeenCalled();
    await target.setValue('shared');
    expect(wrapper.find('[data-browser-track-fx]').exists()).toBe(false);
    expect(wrapper.findAll('fx-unit-stub')).toHaveLength(8);
    expect(state.state.tracks[4]!.slots[3]).toMatchObject({ type: 'ELECTRIC', active: true, namedParameters: { electricCharacter: 2 } });
  });

  it('keeps Browser UI/settings out of Native mode while allowing the Native target selector', async () => {
    const { wrapper, engine } = await loadPanel('native');
    expect(wrapper.find('[aria-label="Track FX target"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Native Track FX target"]').exists()).toBe(true);
    expect(wrapper.find('[data-browser-track-fx]').exists()).toBe(false);
    expect(engine.setFxType).not.toHaveBeenCalled();
    expect(engine.setTrackFxType).not.toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 'DELAY');
  });

  it('offers the Native independent chain in the tech shell and returns to its shared editor', async () => {
    const { wrapper } = await loadPanel('native', 'tech');
    const target = wrapper.get('[aria-label="Native Track FX target"]');
    await target.setValue('3');
    expect(wrapper.find('[data-native-track-fx]').exists()).toBe(true);
    expect(wrapper.find('[data-browser-track-fx]').exists()).toBe(false);
    expect(wrapper.get('[data-native-track-fx-context]').text()).toContain('TRACK 3');
    await target.setValue('shared');
    expect(wrapper.find('[data-native-track-fx]').exists()).toBe(false);
    expect(wrapper.find('[data-browser-track-fx]').exists()).toBe(false);
  });
});
