import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';

const wrappers: VueWrapper[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.doUnmock('../../src/audio/AudioEngine');
});

async function loadPanel(saved: unknown = { version: 1, target: 2, tracks: [] }) {
  vi.resetModules();
  localStorage.setItem('webrc505_native_per_track_fx_v1', JSON.stringify(saved));
  let runtimeError = '';
  const listeners: Array<() => void> = [];
  const engine = {
    getMode: () => 'native',
    onStatusChange: vi.fn((callback: () => void) => { listeners.push(callback); return () => {}; }),
    getNativeCatalogFxOptions: vi.fn(() => ['DELAY', 'PHASER', 'VINYL FLICK (EXPERIMENTAL)']),
    getNativeCatalogFxSlotStatus: vi.fn(() => ({
      error: runtimeError, pendingApply: false, acknowledged: !runtimeError,
      acknowledgedEffectId: runtimeError ? null : 'fractional_delay',
      requestedRevision: 4, appliedRevision: 4,
      acknowledgedParameters: runtimeError ? null : { delay_time_ms: 250, feedback: 0.4 },
    })),
    getTrackFxStatus: vi.fn((trackId: number) => [{
      trackId, available: true, routeMode: 'per-track-pre-mix', perTrackFxChainAvailable: true,
      legacySharedPostmix: true, slots: ['A', 'B', 'C', 'D'].map((slot, slotIndex) => ({
        slot, slotIndex, type: 'DELAY', active: true, bypassed: false, state: runtimeError ? 'error' : 'ready', error: runtimeError,
      })),
    }]),
    setTrackFxType: vi.fn(() => true),
    setTrackFxParameter: vi.fn(() => true),
    setTrackFxNamedParameters: vi.fn(() => true),
    setTrackFxActive: vi.fn(() => true),
    emitStatus: () => { for (const listener of listeners) listener(); },
    setRuntimeError: (error: string) => { runtimeError = error; for (const listener of listeners) listener(); },
  };
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine } }));
  const component = (await import('../../src/components/panel/NativeTrackFxPanel.vue')).default;
  const wrapper = mount(component);
  wrappers.push(wrapper);
  vi.clearAllMocks();
  return { wrapper, engine };
}

describe('Native per-track FX editor', () => {
  it('edits the selected target/slot, persists parameters and reports Native revision ACK', async () => {
    const saved = {
      version: 1, target: 2,
      tracks: [
        { trackId: 1, activeSlot: 'A', slots: [] },
        { trackId: 2, activeSlot: 'B', slots: [
          { type: 'NONE', value: 0, active: false, namedParameters: {} },
          { type: 'DELAY', value: 41, active: false, namedParameters: { delay_time_ms: 250 } },
        ] },
      ],
    };
    const { wrapper, engine } = await loadPanel(saved);
    expect(wrapper.get('[data-native-track-fx-context]').text()).toBe('TRACK 2 · SLOT B');
    expect(wrapper.text()).toContain('API ACK fractional_delay · 2 PARAMETER(S) · REV 4');
    expect(wrapper.findAll('[aria-label="Select Native Track 2 FX slot B"]').length).toBe(1);
    expect((wrapper.get('[aria-label="Native per-track FX type"]').element as HTMLSelectElement).value).toBe('DELAY');

    await wrapper.get('[aria-label="Native per-track FX type"]').setValue('PHASER');
    await wrapper.get('[aria-label="Native per-track FX amount"]').setValue('63');
    await wrapper.get('[aria-label="Native per-track named parameter JSON"]').setValue('{"rate_hz": 0.5, "depth": 0.7}');
    await wrapper.get('.apply-parameters').trigger('click');
    await wrapper.get('[aria-label="Toggle Native per-track FX slot"]').trigger('click');

    expect(engine.setTrackFxType).toHaveBeenCalledWith(2, 1, 'PHASER');
    expect(engine.setTrackFxParameter).toHaveBeenLastCalledWith(2, 1, 63);
    expect(engine.setTrackFxNamedParameters).toHaveBeenLastCalledWith(2, 1, { rate_hz: 0.5, depth: 0.7 });
    expect(engine.setTrackFxActive).toHaveBeenLastCalledWith(2, 1, true);
    const stored = JSON.parse(localStorage.getItem('webrc505_native_per_track_fx_v1')!);
    expect(stored.tracks[1].slots[1]).toMatchObject({ type: 'PHASER', value: 63, active: true, namedParameters: { rate_hz: 0.5, depth: 0.7 } });

    engine.setRuntimeError('Native callback rejected out-of-range parameter');
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-native-track-fx-runtime-status]').text()).toContain('NOT APPLIED: Native callback rejected out-of-range parameter');
  });

  it('omits source-transport effects from insert choices and shows rejected persisted selections', async () => {
    const saved = {
      version: 1, target: 1,
      tracks: [{ trackId: 1, activeSlot: 'A', slots: [{ type: 'VINYL FLICK', value: 80, active: true }] }],
    };
    const { wrapper, engine } = await loadPanel(saved);
    const effect = wrapper.get('[aria-label="Native per-track FX type"]');
    expect(effect.findAll('option').map((option) => option.element.value)).not.toContain('VINYL FLICK (EXPERIMENTAL)');
    expect(wrapper.get('[role="alert"]').text()).toContain('not a per-track A–D insert');
    expect((effect.element as HTMLSelectElement).value).toBe('NONE');
    expect(wrapper.get('[aria-label="Toggle Native per-track FX slot"]').attributes('disabled')).toBeDefined();
    expect(engine.setTrackFxActive).not.toHaveBeenCalledWith(1, 0, true);
  });

  it('keeps invalid JSON and non-finite parameter edits out of the bridge API', async () => {
    const { wrapper, engine } = await loadPanel({
      version: 1, target: 2,
      tracks: [
        { trackId: 1, activeSlot: 'A', slots: [] },
        { trackId: 2, activeSlot: 'A', slots: [{ type: 'DELAY', value: 20, active: false, namedParameters: {} }] },
      ],
    });
    vi.clearAllMocks();
    await wrapper.get('[aria-label="Native per-track named parameter JSON"]').setValue('{bad');
    await wrapper.get('.apply-parameters').trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toContain('JSON');
    expect(engine.setTrackFxNamedParameters).not.toHaveBeenCalled();
  });
});
