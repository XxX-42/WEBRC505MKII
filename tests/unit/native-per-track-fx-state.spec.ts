import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockEngine(mode: 'browser' | 'native' = 'native') {
  const listeners = new Set<() => void>();
  return {
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
    getNativeCatalogFxSlotStatus: vi.fn(() => ({
      error: '', pendingApply: false, acknowledged: true, acknowledgedEffectId: 'fractional_delay',
      requestedRevision: 7, appliedRevision: 7, acknowledgedParameters: { delay_time_ms: 250 },
    })),
    setTrackFxType: vi.fn(() => true),
    setTrackFxParameter: vi.fn(() => true),
    setTrackFxNamedParameters: vi.fn(() => true),
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
    expect(panel.setNamedParameters(1, 0, { delay_time_ms: 333, feedback: 0.4 })).toBe(true);
    expect(panel.setActive(1, 0, true)).toBe(true);
    expect(panel.selectTarget(2)).toBe(true);
    expect(panel.setType(2, 1, 'PHASER')).toBe(true);
    panel.setValue(2, 1, 65);
    panel.setActive(2, 1, true);
    panel.selectSlot('B');

    expect(panel.state.tracks[0]!.slots[0]).toMatchObject({ type: 'DELAY', value: 37, active: true, namedParameters: { delay_time_ms: 333, feedback: 0.4 } });
    expect(panel.state.tracks[1]!.slots[0]!.type).toBe('NONE');
    expect(panel.state.tracks[1]!.slots[1]).toMatchObject({ type: 'PHASER', value: 65, active: true });
    expect(engine.setTrackFxType).toHaveBeenCalledWith(1, 0, 'DELAY');
    expect(engine.setTrackFxNamedParameters).toHaveBeenLastCalledWith(1, 0, { delay_time_ms: 333, feedback: 0.4 });
    expect(engine.setTrackFxActive).toHaveBeenCalledWith(2, 1, true);
    expect(JSON.parse(localStorage.getItem(NATIVE_TRACK_FX_STORAGE_KEY)!)).toMatchObject({ version: 1, target: 2 });

    const restored = await loadState();
    expect(restored.panel.target.value).toBe(2);
    expect(restored.panel.activeSlot.value).toBe('B');
    restored.panel.selectTarget(1);
    expect(restored.panel.activeFx.value).toMatchObject({ type: 'DELAY', value: 37, active: true, namedParameters: { delay_time_ms: 333, feedback: 0.4 } });
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

  it('restores only valid state and exposes runtime apply ACK/error state', async () => {
    const { NATIVE_TRACK_FX_STORAGE_KEY } = await loadState();
    localStorage.setItem(NATIVE_TRACK_FX_STORAGE_KEY, JSON.stringify({
      version: 1,
      target: 1,
      tracks: [{ trackId: 1, activeSlot: 'B', slots: [
        { type: 'DELAY', value: 999, active: true, namedParameters: { delay_time_ms: 250, wrong: 'bad' } },
        { type: 'VINYL FLICK', value: 80, active: true },
      ] }],
    }));
    const { panel, engine } = await loadState();
    expect(panel.activeSlot.value).toBe('B');
    panel.selectSlot('A');
    expect(panel.activeFx.value).toMatchObject({ type: 'DELAY', value: 100, active: true, namedParameters: { delay_time_ms: 250 } });
    panel.selectSlot('B');
    expect(panel.activeFx.value).toMatchObject({ type: 'NONE', value: 0, active: false });
    expect(panel.warning.value).toContain('not a per-track A–D insert');
    expect(panel.slotRuntime.value).toMatchObject({ acknowledged: true, appliedRevision: 7 });
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
});
