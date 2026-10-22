import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nativeCatalogMacroParameters } from '../../src/audio/nativeFxCatalog';

const wrappers: VueWrapper[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.doUnmock('../../src/audio/AudioEngine');
});

async function loadPanel(saved: unknown = { version: 1, target: 2, tracks: [] }, schemaAvailable = true) {
  vi.resetModules();
  localStorage.setItem('webrc505_native_per_track_fx_v1', JSON.stringify(saved));
  let runtimeError = '';
  let currentType = 'DELAY';
  let currentAmount = 0;
  let runtime: Record<string, unknown> = {
    error: '', pendingApply: false, acknowledged: true,
    acknowledgedEffectId: 'fractional_delay', requestedEffectId: 'fractional_delay',
    requestedRevision: 4, appliedRevision: 4,
    requestedParameters: { delay_ms: 250, feedback: 0.4 },
    acknowledgedParameters: { delay_ms: 250, feedback: 0.4 },
  };
  const listeners: Array<() => void> = [];
  const engine = {
    getMode: () => 'native',
    onStatusChange: vi.fn((callback: () => void) => { listeners.push(callback); return () => {}; }),
    getNativeCatalogFxOptions: vi.fn(() => ['DELAY', 'PHASER', 'VINYL FLICK (EXPERIMENTAL)']),
    getNativeCatalogFxSlotStatus: vi.fn(() => ({ ...runtime, error: runtimeError || runtime.error })),
    getNativeCatalogFxParameterSchema: vi.fn((type: string) => !schemaAvailable ? null : type === 'PHASER' ? ({
      version: 1,
      parameters: [
        { id: 'stages', label: 'Stages', minimum: 4, maximum: 12, defaultValue: 8, smoothingMs: 40, discrete: true, discreteValues: [4, 8, 12] },
        { id: 'rate_hz', label: 'Rate', minimum: 0.05, maximum: 10, defaultValue: 0.5, smoothingMs: 20, discrete: false },
        { id: 'depth', label: 'Depth', minimum: 0, maximum: 1, defaultValue: 0.65, smoothingMs: 20, discrete: false },
        { id: 'wet_mix', label: 'Wet mix', minimum: 0, maximum: 1, defaultValue: 0.5, smoothingMs: 20, discrete: false },
      ], legacyAliases: [],
    }) : type === 'DELAY' ? ({
      version: 1,
      parameters: [{ id: 'delay_ms', label: 'Delay time', minimum: 10, maximum: 2000, defaultValue: 350, smoothingMs: 20, discrete: false }],
      legacyAliases: [{ id: 'q', label: 'Legacy Q', minimum: 0.5, maximum: 12, defaultValue: 0.707, smoothingMs: 20, discrete: false, legacyAlias: true }],
    }) : null),
    getTrackFxStatus: vi.fn((trackId: number) => [{
      trackId, available: true, routeMode: 'per-track-pre-mix', perTrackFxChainAvailable: true,
      legacySharedPostmix: true, slots: ['A', 'B', 'C', 'D'].map((slot, slotIndex) => ({
        slot, slotIndex, type: 'DELAY', active: true, bypassed: false, state: runtimeError ? 'error' : 'ready', error: runtimeError,
      })),
    }]),
    setTrackFxType: vi.fn((_trackId: number, _slotIndex: number, type: string) => {
      currentType = type;
      return true;
    }),
    setTrackFxParameter: vi.fn((_trackId: number, _slotIndex: number, value: number) => { currentAmount = value; return true; }),
    setTrackFxNamedParameters: vi.fn((_trackId: number, _slotIndex: number, parameters: Record<string, number>) => {
      const requestedRevision = Number(runtime.requestedRevision ?? 4) + 1;
      const effectId = currentType === 'PHASER' ? 'phaser' : 'fractional_delay';
      const requestedParameters = { ...nativeCatalogMacroParameters(currentType, currentAmount), ...parameters };
      runtime = {
        ...runtime, error: '', pendingApply: true, acknowledged: false,
        requestedEffectId: effectId, requestedRevision, appliedRevision: requestedRevision - 1,
        requestedParameters, acknowledgedParameters: null,
      };
      return true;
    }),
    setTrackFxActive: vi.fn(() => true),
    emitStatus: () => { for (const listener of listeners) listener(); },
    setRuntimeError: (error: string) => { runtimeError = error; runtime = { ...runtime, error, pendingApply: false, acknowledged: false }; for (const listener of listeners) listener(); },
    acknowledgeNamedParameters: () => {
      const requestedRevision = Number(runtime.requestedRevision ?? 4);
      runtime = { ...runtime, pendingApply: false, acknowledged: true,
        acknowledgedEffectId: runtime.requestedEffectId, appliedRevision: requestedRevision,
        acknowledgedParameters: { ...runtime.requestedParameters as Record<string, number> } };
      runtimeError = '';
      for (const listener of listeners) listener();
    },
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
          { type: 'DELAY', value: 41, active: false, namedParameters: {} },
        ] },
      ],
    };
    const { wrapper, engine } = await loadPanel(saved);
    expect(wrapper.get('[data-native-track-fx-context]').text()).toBe('TRACK 2 · SLOT B');
    expect(wrapper.text()).toContain('API ACK fractional_delay · 2 PARAMETER(S) · REV 4');
    expect(wrapper.text()).toContain('Legacy JSON aliases accepted: q');
    expect(wrapper.findAll('[aria-label="Select Native Track 2 FX slot B"]').length).toBe(1);
    expect((wrapper.get('[aria-label="Native per-track FX type"]').element as HTMLSelectElement).value).toBe('DELAY');

    await wrapper.get('[aria-label="Native per-track FX type"]').setValue('PHASER');
    await wrapper.get('[aria-label="Native per-track FX amount"]').setValue('63');
    const rate = wrapper.get('[aria-label="Native Rate"]');
    const depth = wrapper.get('[aria-label="Native Depth"]');
    expect(rate.attributes('min')).toBe('0.05');
    expect(rate.attributes('max')).toBe('10');
    expect(depth.attributes('step')).toBe('0.01');
    expect(wrapper.get('[aria-label="Native Stages"]').findAll('option').map((option) => option.element.value)).toEqual(['4', '8', '12']);
    await rate.setValue('0.5');
    await depth.setValue('0.7');
    await wrapper.get('.apply-parameters').trigger('click');
    expect(engine.setTrackFxNamedParameters).toHaveBeenCalledWith(2, 1, { rate_hz: 0.5, depth: 0.7 });
    expect(JSON.parse(localStorage.getItem('webrc505_native_per_track_fx_v1')!).tracks[1].slots[1].namedParameters).toEqual({});
    engine.acknowledgeNamedParameters();
    await wrapper.vm.$nextTick();
    expect(JSON.parse(localStorage.getItem('webrc505_native_per_track_fx_v1')!).tracks[1].slots[1].namedParameters).toEqual({ rate_hz: 0.5, depth: 0.7 });
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
    await wrapper.get('.advanced-parameters .apply-parameters').trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toContain('JSON');
    expect(engine.setTrackFxNamedParameters).not.toHaveBeenCalled();
  });

  it('does not guess control ranges for an old Native host without the versioned schema', async () => {
    const { wrapper, engine } = await loadPanel({
      version: 1, target: 2,
      tracks: [
        { trackId: 1, activeSlot: 'A', slots: [] },
        { trackId: 2, activeSlot: 'A', slots: [{ type: 'DELAY', value: 20, active: false, namedParameters: {} }] },
      ],
    }, false);
    expect(wrapper.find('[aria-label="Native Delay time"]').exists()).toBe(false);
    expect(wrapper.find('[data-native-parameter-schema-unavailable]').exists()).toBe(true);
    expect(wrapper.get('.apply-parameters').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.advanced-parameters').exists()).toBe(true);
    await wrapper.get('[aria-label="Native per-track named parameter JSON"]').setValue('{"delay_ms": 333}');
    await wrapper.get('.advanced-parameters .apply-parameters').trigger('click');
    expect(engine.setTrackFxNamedParameters).toHaveBeenCalledWith(2, 0, { delay_ms: 333 });
  });
});
