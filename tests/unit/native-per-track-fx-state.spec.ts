import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeCatalogEffectId, nativeCatalogMacroParameters } from '../../src/audio/nativeFxCatalog';

function mockEngine(mode: 'browser' | 'native' = 'native') {
  const listeners = new Set<() => void>();
  const types = new Map<string, string>();
  const values = new Map<string, number>();
  const runtimes = new Map<string, Record<string, unknown>>();
  const keyFor = (trackId: number, slotIndex: number) => `${trackId}:${slotIndex}`;
  const schemaFor = (type: string) => type === 'PHASER' ? ({
    version: 1 as const,
    parameters: [
      { id: 'stages', label: 'Stages', minimum: 4, maximum: 12, defaultValue: 8, smoothingMs: 40, discrete: true, discreteValues: [4, 8, 12] },
      { id: 'rate_hz', label: 'Rate', minimum: 0.05, maximum: 10, defaultValue: 0.5, smoothingMs: 20, discrete: false },
      { id: 'depth', label: 'Depth', minimum: 0, maximum: 1, defaultValue: 0.65, smoothingMs: 20, discrete: false },
    ],
    legacyAliases: [],
  }) : type === 'DELAY' ? ({
    version: 1 as const,
    parameters: [
      { id: 'delay_ms', label: 'Delay time', minimum: 10, maximum: 2000, defaultValue: 350, smoothingMs: 20, discrete: false },
      { id: 'feedback', label: 'Feedback', minimum: 0, maximum: 0.95, defaultValue: 0.35, smoothingMs: 20, discrete: false },
      { id: 'wet_mix', label: 'Wet', minimum: 0, maximum: 1, defaultValue: 0.3, smoothingMs: 10, discrete: false },
    ],
    legacyAliases: [],
  }) : null;
  const getRuntime = (trackId: number, slotIndex: number) => {
    const key = keyFor(trackId, slotIndex);
    const type = types.get(key) ?? '';
    const effectId = nativeCatalogEffectId(type);
    const parameters = type ? nativeCatalogMacroParameters(type, values.get(key) ?? 0) : {};
    return runtimes.get(key) ?? {
      error: '', pendingApply: false, acknowledged: Boolean(effectId),
      acknowledgedEffectId: effectId, requestedEffectId: effectId,
      requestedRevision: 7, appliedRevision: 7,
      acknowledgedParameters: effectId ? parameters : null, requestedParameters: parameters,
    };
  };
  return {
    runtimes,
    getMode: () => mode,
    onStatusChange: vi.fn((callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); }),
    emitStatus: () => { for (const listener of listeners) listener(); },
    getNativeCatalogFxOptions: vi.fn((_path: string, _trackId: number) => ['DELAY', 'PHASER', 'VINYL FLICK (EXPERIMENTAL)']),
    getTrackFxStatus: vi.fn((trackId: number) => [{
      trackId, available: true, routeMode: 'per-track-pre-mix', perTrackFxChainAvailable: true,
      legacySharedPostmix: true, slots: Array.from({ length: 4 }, (_, slotIndex) => ({
        slotIndex, slot: ['A', 'B', 'C', 'D'][slotIndex], type: null, active: false, bypassed: true, state: 'empty', error: null,
      })),
    }]),
    getNativeCatalogFxSlotStatus: vi.fn((path: string, slotIndex: number, trackId: number) => ({ ...getRuntime(trackId, slotIndex) })),
    getNativeCatalogFxParameterSchema: vi.fn((type: string) => schemaFor(type)),
    setTrackFxType: vi.fn((trackId: number, slotIndex: number, type: string) => { types.set(keyFor(trackId, slotIndex), type); return true; }),
    setTrackFxParameter: vi.fn((trackId: number, slotIndex: number, value: number) => { values.set(keyFor(trackId, slotIndex), value); return true; }),
    setTrackFxNamedParameters: vi.fn((trackId: number, slotIndex: number, parameters: Record<string, number>) => {
      const key = keyFor(trackId, slotIndex);
      const type = types.get(key) ?? 'NONE';
      const effectId = nativeCatalogEffectId(type);
      const expected = { ...nativeCatalogMacroParameters(type, values.get(key) ?? 0), ...parameters };
      runtimes.set(key, {
        error: '', pendingApply: true, acknowledged: false, acknowledgedEffectId: effectId,
        requestedEffectId: effectId, requestedRevision: 8, appliedRevision: 7,
        requestedParameters: expected, acknowledgedParameters: null,
      });
      return true;
    }),
    acknowledgeNamedParameters(trackId: number, slotIndex: number) {
      const key = keyFor(trackId, slotIndex);
      const runtime = getRuntime(trackId, slotIndex);
      runtimes.set(key, { ...runtime, error: '', pendingApply: false, acknowledged: true,
        acknowledgedEffectId: runtime.requestedEffectId, appliedRevision: runtime.requestedRevision, pendingRestart: false,
        acknowledgedParameters: runtime.requestedParameters });
      for (const listener of listeners) listener();
    },
    rejectNamedParameters(trackId: number, slotIndex: number, error: string) {
      const key = keyFor(trackId, slotIndex);
      const runtime = getRuntime(trackId, slotIndex);
      runtimes.set(key, { ...runtime, error, pendingApply: false, acknowledged: false });
      for (const listener of listeners) listener();
    },
    setTrackFxActive: vi.fn(() => true),
  };
}

async function loadState(mode: 'browser' | 'native' = 'native') {
  vi.resetModules();
  const engine = mockEngine(mode);
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine } }));
  const module = await import('../../src/composables/useNativeTrackFxState');
  return { ...module, panel: module.useNativeTrackFxState(), engine };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.doUnmock('../../src/audio/AudioEngine'));

describe('Native independent 5×4 track FX state', () => {
  it('persists independent banks and dispatches named parameters, activation and target by track ID', async () => {
    const { panel, engine, NATIVE_TRACK_FX_STORAGE_KEY } = await loadState();
    expect(panel.state.tracks).toHaveLength(5);
    expect(panel.state.tracks.every((bank) => bank.slots.length === 4)).toBe(true);
    vi.clearAllMocks();

    expect(panel.selectTarget(1)).toBe(true);
    expect(panel.setType(1, 0, 'DELAY')).toBe(true);
    expect(panel.setValue(1, 0, 37)).toBe(true);
    expect(panel.setNamedParameters(1, 0, { delay_ms: 333, feedback: 0.4 })).toBe(true);
    expect(panel.state.tracks[0]!.slots[0]!.namedParameters).toEqual({});
    expect(JSON.parse(localStorage.getItem('webrc505_native_per_track_fx_v1')!).tracks[0].slots[0].namedParameters).toEqual({});
    engine.acknowledgeNamedParameters(1, 0);
    expect(panel.setActive(1, 0, true)).toBe(true);
    expect(panel.selectTarget(2)).toBe(true);
    expect(panel.setType(2, 1, 'PHASER')).toBe(true);
    panel.setValue(2, 1, 65);
    panel.setActive(2, 1, true);
    panel.selectSlot('B');

    expect(panel.state.tracks[0]!.slots[0]).toMatchObject({ type: 'DELAY', value: 37, active: true, namedParameters: { delay_ms: 333, feedback: 0.4 } });
    expect(panel.state.tracks[1]!.slots[0]!.type).toBe('NONE');
    expect(panel.state.tracks[1]!.slots[1]).toMatchObject({ type: 'PHASER', value: 65, active: true });
    expect(engine.setTrackFxType).toHaveBeenCalledWith(1, 0, 'DELAY');
    expect(engine.setTrackFxNamedParameters).toHaveBeenLastCalledWith(1, 0, { delay_ms: 333, feedback: 0.4 });
    expect(engine.setTrackFxActive).toHaveBeenCalledWith(2, 1, true);
    expect(JSON.parse(localStorage.getItem(NATIVE_TRACK_FX_STORAGE_KEY)!)).toMatchObject({ version: 1, target: 2 });

    const restored = await loadState();
    expect(restored.panel.target.value).toBe(2);
    expect(restored.panel.activeSlot.value).toBe('B');
    restored.panel.selectTarget(1);
    expect(restored.panel.activeFx.value).toMatchObject({ type: 'DELAY', value: 37, active: true, namedParameters: { delay_ms: 333, feedback: 0.4 } });
    expect(restored.engine.setTrackFxType).toHaveBeenCalledWith(1, 0, 'DELAY');
    expect(restored.engine.setTrackFxActive).toHaveBeenCalledWith(1, 0, true);
  });

  it('rejects source transport placement and invalid numeric parameters without dispatch', async () => {
    const { panel, engine } = await loadState();
    vi.clearAllMocks();
    panel.selectTarget(1);
    for (const type of ['BEAT SHIFT', 'VINYL FLICK', 'VINYL FLICK (EXPERIMENTAL)']) {
      expect(panel.fxOptions.value).not.toContain(type);
      expect(panel.setType(1, 0, type)).toBe(false);
    }
    expect(panel.warning.value).toContain('separate experimental loop-transport stage');
    expect(panel.setType(0, 0, 'DELAY')).toBe(false);
    expect(panel.setType(6, 0, 'DELAY')).toBe(false);
    expect(panel.setType(1, 4, 'DELAY')).toBe(false);
    expect(panel.setNamedParameters(1, 0, { feedback: Number.NaN })).toBe(false);
    expect(engine.setTrackFxType).not.toHaveBeenCalled();
    expect(engine.setTrackFxNamedParameters).not.toHaveBeenCalled();
  });

  it('validates Native bounds/discrete choices and stores named overrides only after ACK', async () => {
    const { panel, engine, NATIVE_TRACK_FX_STORAGE_KEY } = await loadState();
    panel.selectTarget(1);
    expect(panel.setType(1, 0, 'PHASER')).toBe(true);
    const before = localStorage.getItem(NATIVE_TRACK_FX_STORAGE_KEY);
    expect(panel.setNamedParameters(1, 0, { unknown: 1 })).toBe(false);
    expect(panel.setNamedParameters(1, 0, { rate_hz: 20 })).toBe(false);
    expect(panel.setNamedParameters(1, 0, { stages: 6 })).toBe(false);
    expect(engine.setTrackFxNamedParameters).not.toHaveBeenCalled();
    expect(localStorage.getItem(NATIVE_TRACK_FX_STORAGE_KEY)).toBe(before);

    expect(panel.setNamedParameters(1, 0, { stages: 8, rate_hz: 2 })).toBe(true);
    expect(panel.state.tracks[0]!.slots[0]!.namedParameters).toEqual({});
    expect(localStorage.getItem(NATIVE_TRACK_FX_STORAGE_KEY)).toBe(before);
    engine.acknowledgeNamedParameters(1, 0);
    expect(panel.state.tracks[0]!.slots[0]!.namedParameters).toEqual({ stages: 8, rate_hz: 2 });
    // Explicit named controls override the macro value for the same ID while
    // unspecified macro controls continue to follow the amount slider.
    panel.setValue(1, 0, 60);
    expect(panel.setNamedParameters(1, 0, { depth: 0.2 })).toBe(true);
    expect(engine.getNativeCatalogFxSlotStatus('track', 0, 1).requestedParameters).toMatchObject({ depth: 0.2, wet_mix: 0.6 });
    engine.acknowledgeNamedParameters(1, 0);
    expect(panel.state.tracks[0]!.slots[0]!.namedParameters).toEqual({ depth: 0.2 });
    const acknowledged = localStorage.getItem(NATIVE_TRACK_FX_STORAGE_KEY);
    expect(JSON.parse(acknowledged!).tracks[0].slots[0].namedParameters).toEqual({ depth: 0.2 });

    expect(panel.setNamedParameters(1, 0, { stages: 12 })).toBe(true);
    engine.rejectNamedParameters(1, 0, 'Invalid Native catalog FX parameter rate_hz for phaser.');
    expect(panel.state.tracks[0]!.slots[0]!.namedParameters).toEqual({ depth: 0.2 });
    expect(localStorage.getItem(NATIVE_TRACK_FX_STORAGE_KEY)).toBe(acknowledged);
  });

  it('restores only valid state and exposes runtime apply ACK/error state', async () => {
    const { NATIVE_TRACK_FX_STORAGE_KEY } = await loadState();
    localStorage.setItem(NATIVE_TRACK_FX_STORAGE_KEY, JSON.stringify({
      version: 1,
      target: 1,
      tracks: [{ trackId: 1, activeSlot: 'B', slots: [
        { type: 'DELAY', value: 999, active: true, namedParameters: { delay_ms: 250, wrong: 'bad' } },
        { type: 'VINYL FLICK', value: 80, active: true },
      ] }],
    }));
    const { panel, engine } = await loadState();
    expect(panel.activeSlot.value).toBe('B');
    panel.selectSlot('A');
    expect(panel.activeFx.value).toMatchObject({ type: 'DELAY', value: 100, active: true, namedParameters: { delay_ms: 250 } });
    panel.selectSlot('B');
    expect(panel.activeFx.value).toMatchObject({ type: 'NONE', value: 0, active: false });
    expect(panel.warning.value).toContain('not a per-track A–D insert');
    panel.selectSlot('A');
    // A persisted override is not effective until the Native callback reports
    // the slot revision that includes it.
    expect(panel.slotRuntime.value).toMatchObject({ pendingApply: true, acknowledged: false });
    engine.acknowledgeNamedParameters(1, 0);
    expect(panel.slotRuntime.value).toMatchObject({ acknowledged: true, appliedRevision: 8 });
    engine.getNativeCatalogFxSlotStatus.mockReturnValueOnce({
      error: 'Native per-track catalog FX is unavailable.', pendingApply: false, acknowledged: false,
      acknowledgedEffectId: null, requestedRevision: 8, appliedRevision: 7, acknowledgedParameters: null,
    });
    engine.emitStatus();
    expect(panel.slotRuntime.value?.error).toBe('Native per-track catalog FX is unavailable.');
  });

  it('does not send Native track changes when Browser mode is active', async () => {
    const { panel, engine } = await loadState('browser');
    expect(panel.setType(1, 0, 'DELAY')).toBe(false);
    expect(panel.setValue(1, 0, 50)).toBe(false);
    expect(panel.setNamedParameters(1, 0, { delay_time_ms: 250 })).toBe(false);
    expect(panel.setActive(1, 0, true)).toBe(false);
    expect(engine.setTrackFxType).not.toHaveBeenCalled();
    expect(engine.setTrackFxParameter).not.toHaveBeenCalled();
    expect(engine.setTrackFxNamedParameters).not.toHaveBeenCalled();
    expect(engine.setTrackFxActive).not.toHaveBeenCalled();
  });
  it('ignores only derived timing keys for per-track ACK and clears an old-host definite refusal', async () => {
    const { panel, engine } = await loadState();
    panel.setType(1, 0, 'PHASER');
    expect(panel.setNamedParameters(1, 0, { depth: 0.4 })).toBe(true);
    let runtime = engine.runtimes.get('1:0')!;
    runtime.requestedParameters = { ...(runtime.requestedParameters as Record<string, number>), official_bpm: 173, official_quarter_notes_per_measure: 3 };
    engine.acknowledgeNamedParameters(1, 0);
    expect(panel.state.tracks[0]!.slots[0]!.namedParameters).toEqual({ depth: 0.4 });
    expect(panel.setNamedParameters(1, 0, { depth: 0.6 })).toBe(true);
    runtime = engine.runtimes.get('1:0')!;
    runtime.requestedParameters = { ...(runtime.requestedParameters as Record<string, number>), official_bpm: 173, official_quarter_notes_per_measure: 3 };
    engine.rejectNamedParameters(1, 0, 'Native host lacks safe official parameter replacement; update the host.');
    engine.acknowledgeNamedParameters(1, 0); // A later unrelated status must not resurrect a rejected edit.
    expect(panel.state.tracks[0]!.slots[0]!.namedParameters).toEqual({ depth: 0.4 });
  });

  it('retains per-track reset through requiresRestart and persists its eventual ACK', async () => {
    const { panel, engine, NATIVE_TRACK_FX_STORAGE_KEY } = await loadState();
    panel.setType(1, 0, 'PHASER');
    expect(panel.setNamedParameters(1, 0, { depth: 0.4 })).toBe(true);
    engine.acknowledgeNamedParameters(1, 0);
    expect(panel.setNamedParameters(1, 0, {})).toBe(true);
    engine.runtimes.get('1:0')!.pendingRestart = true;
    engine.rejectNamedParameters(1, 0, 'Stop Native audio before replacing parameters.');
    expect(panel.state.tracks[0]!.slots[0]!.namedParameters).toEqual({ depth: 0.4 });
    panel.setActive(1, 0, true);
    panel.setValue(1, 0, 60);
    // Match the real engine's amount-only reapply, preserving its pending empty overrides.
    engine.runtimes.get('1:0')!.requestedParameters = { depth: 0.6, wet_mix: 0.6 };
    engine.acknowledgeNamedParameters(1, 0);
    expect(panel.state.tracks[0]!.slots[0]!.namedParameters).toEqual({});
    expect(JSON.parse(localStorage.getItem(NATIVE_TRACK_FX_STORAGE_KEY)!).tracks[0].slots[0].namedParameters).toEqual({});
  });

});
