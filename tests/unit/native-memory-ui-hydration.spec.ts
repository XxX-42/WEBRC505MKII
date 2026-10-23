import { afterEach, describe, expect, it, vi } from 'vitest';
const holder = vi.hoisted(() => ({ engine: null as any }));
vi.mock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => holder.engine } }));

afterEach(() => { localStorage.clear(); vi.resetModules(); });

describe('confirmed Native Memory editor hydration', () => {
  it('hydrates seven acknowledged banks without API writes and preserves recalled controls on subsequent shared/private named edits', async () => {
    const listeners = new Set<() => void>(), statuses = new Map<string, any>();
    const key = (path: string, index: number, trackId = 0) => `${path}:${trackId}:${index}`;
    for (const [path, trackId] of [['input', 0], ['track', 0], ...Array.from({ length: 5 }, (_, index) => ['track', index + 1])] as Array<[string, number]>) {
      for (let index = 0; index < 4; index++) {
        const populated = index === 0;
        statuses.set(key(path, index, trackId), { path, trackId, slot: ['A', 'B', 'C', 'D'][index],
          acknowledged: true, prepared: true, pendingApply: false, pendingRestart: false, outcomeUnknown: false,
          processingFaulted: false, controlFaulted: false, error: '', requestedRevision: 12, appliedRevision: 12,
          requestedEffectId: populated ? 'fractional_delay' : null, acknowledgedEffectId: populated ? 'fractional_delay' : null,
          requestedBypassed: false, appliedBypassed: false,
          requestedParameters: populated ? { delay_ms: 420 + trackId, feedback: 0.67, wet_mix: 0.31 } : {},
          acknowledgedParameters: populated ? { delay_ms: 420 + trackId, feedback: 0.67, wet_mix: 0.31 } : {} });
      }
    }
    const submit = (path: string, index: number, parameters: Record<string, number>, trackId = 0) => {
      const status = statuses.get(key(path, index, trackId));
      status.requestedParameters = { ...status.acknowledgedParameters, ...parameters }; status.acknowledgedParameters = { ...status.requestedParameters };
      status.requestedRevision++; status.appliedRevision = status.requestedRevision;
      for (const listener of listeners) listener(); return true;
    };
    const schema = { parameters: ['delay_ms', 'feedback', 'wet_mix'].map((id) => ({ id, minimum: 0, maximum: id === 'delay_ms' ? 5000 : 1, discrete: false })), legacyAliases: [] };
    holder.engine = { getMode: () => 'native', onStatusChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      getNativeCatalogFxSlotStatus: (path: string, index: number, trackId = 0) => statuses.get(key(path, index, trackId)),
      getNativeCatalogFxOptions: () => ['DELAY'], getNativeCatalogFxParameterSchema: () => schema,
      getNativeCatalogFxParameterSnapshot: (path: string, index: number, trackId = 0, overrides = {}) => ({ ...statuses.get(key(path, index, trackId)).acknowledgedParameters, ...overrides }),
      getTrackFxStatus: () => [], getCapabilities: () => ({ supportsInputFx: true, supportsTrackFx: true, fxReason: '' }),
      setFxType: vi.fn(), setFxParam: vi.fn(), setFxActive: vi.fn(), setCatalogFxParameters: vi.fn(submit),
      setTrackFxType: vi.fn(() => true), setTrackFxParameter: vi.fn(() => true), setTrackFxActive: vi.fn(() => true),
      setTrackFxNamedParameters: vi.fn((trackId: number, index: number, parameters: Record<string, number>) => submit('track', index, parameters, trackId)),
    };
    const { adoptCommittedNativeFxState, useFxPanelState } = await import('../../src/composables/useFxPanelState');
    const { useNativeTrackFxState } = await import('../../src/composables/useNativeTrackFxState');
    await adoptCommittedNativeFxState();
    for (const name of ['setFxType', 'setFxParam', 'setFxActive', 'setCatalogFxParameters', 'setTrackFxType', 'setTrackFxParameter', 'setTrackFxActive', 'setTrackFxNamedParameters']) expect(holder.engine[name]).not.toHaveBeenCalled();
    const shared = useFxPanelState('input'), privateState = useNativeTrackFxState(); privateState.selectTarget(3);
    expect(shared.slots.value[0]!.namedParametersByType?.DELAY).toEqual({ delay_ms: 420, feedback: 0.67, wet_mix: 0.31 });
    expect(privateState.activeFx.value?.namedParameters).toEqual({ delay_ms: 423, feedback: 0.67, wet_mix: 0.31 });
    expect(shared.setNativeNamedParameters(0, { delay_ms: 875 })).toBe(true);
    expect(statuses.get(key('input', 0)).acknowledgedParameters).toEqual({ delay_ms: 875, feedback: 0.67, wet_mix: 0.31 });
    expect(shared.slots.value[0]!.namedParametersByType?.DELAY).toEqual({ delay_ms: 875, feedback: 0.67, wet_mix: 0.31 });
    expect(privateState.setNamedParameters(3, 0, { delay_ms: 925 })).toBe(true);
    expect(statuses.get(key('track', 0, 3)).acknowledgedParameters).toEqual({ delay_ms: 925, feedback: 0.67, wet_mix: 0.31 });
    expect(privateState.activeFx.value?.namedParameters).toEqual({ delay_ms: 925, feedback: 0.67, wet_mix: 0.31 });
    const before = JSON.stringify([shared.slots.value, privateState.state]);
    statuses.get(key('track', 3, 5)).pendingApply = true;
    await expect(adoptCommittedNativeFxState()).rejects.toThrow(/confirmed FX readback/);
    expect(JSON.stringify([shared.slots.value, privateState.state])).toBe(before);
    expect(holder.engine.setCatalogFxParameters).toHaveBeenCalledTimes(1);
    expect(holder.engine.setTrackFxNamedParameters).toHaveBeenCalledTimes(1);
  });
});
