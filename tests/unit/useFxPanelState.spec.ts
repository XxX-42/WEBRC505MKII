import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const state = {
    activeBankId: 'bank-1',
    banks: Array.from({ length: 4 }, (_, index) => ({
      id: `bank-${index + 1}`,
      name: `Bank ${index + 1}`,
      input: [null, null, null, null] as Array<{ type: string; enabled: boolean; params: Record<string, number> } | null>,
      track: [null, null, null, null] as Array<{ type: string; enabled: boolean; params: Record<string, number> } | null>,
      output: [null, null, null, null] as Array<{ type: string; enabled: boolean; params: Record<string, number> } | null>,
    })),
  };
  const listeners = new Set<(next: typeof state) => void>();
  const publish = () => listeners.forEach((listener) => listener(structuredClone(state)));
  const engine = {
    tracks: [] as Array<{ track?: { fxSw?: string } }>,
    getMode: vi.fn(() => 'browser'),
    getUiStatus: vi.fn(() => ({ ready: true })),
    getCapabilities: vi.fn(() => ({ supportsInputFx: true, supportsTrackFx: true, fxReason: '' })),
    onStatusChange: vi.fn((listener: (status: { ready: boolean }) => void) => {
      listener({ ready: true });
      return () => undefined;
    }),
    getFxState: vi.fn(() => structuredClone(state)),
    getAvailableFxTypes: vi.fn(() => ['COMPRESSOR', 'FILTER', 'DELAY', 'REVERB', 'SLICER', 'PHASER']),
    getActiveFxBankId: vi.fn(() => state.activeBankId),
    subscribeFxState: vi.fn((listener: (next: typeof state) => void) => {
      listeners.add(listener);
      listener(structuredClone(state));
      return () => listeners.delete(listener);
    }),
    selectFxBank: vi.fn(async (id: string) => {
      state.activeBankId = id;
      publish();
    }),
    updateFxBankSlot: vi.fn(async (location: 'input' | 'track' | 'output', index: number, unit: { type: string; enabled: boolean; params: Record<string, number> } | null) => {
      const bank = state.banks.find((candidate) => candidate.id === state.activeBankId);
      if (!bank) throw new Error('Active bank missing');
      bank[location][index] = unit ? structuredClone(unit) : null;
      publish();
    }),
  };
  return { state, listeners, engine };
});

vi.mock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => fixture.engine } }));

describe('useFxPanelState', () => {
  beforeEach(() => {
    fixture.state.activeBankId = 'bank-1';
    fixture.state.banks.forEach((bank) => {
      bank.input = [null, null, null, null];
      bank.track = [null, null, null, null];
      bank.output = [null, null, null, null];
    });
    fixture.listeners.clear();
    vi.clearAllMocks();
  });

  it('updates the active immutable project bank slot with exact effect parameters', async () => {
    vi.resetModules();
    const { useFxPanelState } = await import('../../src/composables/useFxPanelState');
    const panel = useFxPanelState('input');

    expect(panel.fxOptions.value).toContain('COMPRESSOR');
    expect(panel.slots.value[0]?.unit).toBeNull();
    await panel.updateType('A', 'FILTER');
    await panel.updateValue('A', 37);

    expect(fixture.engine.updateFxBankSlot).toHaveBeenLastCalledWith('input', 0, {
      type: 'FILTER',
      enabled: true,
      params: { frequency: 0.37, resonance: 0.05 },
    });
    expect(panel.slots.value[0]?.value).toBeCloseTo(37);
    expect(panel.slots.value[0]?.unit?.params.frequency).toBeCloseTo(0.37);
  });

  it('uses the engine bank subscription as the source of truth after switching and project restore', async () => {
    vi.resetModules();
    const { useFxPanelState } = await import('../../src/composables/useFxPanelState');
    const panel = useFxPanelState('track');
    await panel.selectBank('bank-3');

    expect(fixture.engine.selectFxBank).toHaveBeenCalledWith('bank-3');
    expect(panel.activeBankId.value).toBe('bank-3');

    fixture.state.banks[2]!.track[0] = { type: 'COMPRESSOR', enabled: true, params: { amount: 0.6, thresholdDb: -36, ratio: 12.4 } };
    fixture.listeners.forEach((listener) => listener(structuredClone(fixture.state)));
    expect(panel.slots.value[0]?.type).toBe('COMPRESSOR');
    expect(panel.slots.value[0]?.value).toBeCloseTo(60);
  });
});
