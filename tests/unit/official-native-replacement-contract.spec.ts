import { describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { NativeBridgeClient, type NativeCatalogSlotConfig, type NativeStatus } from '../../src/audio/NativeBridgeClient';
import { renderedCatalogWrite } from '../helpers/nativeCatalogReadback';

function harness(supportsReplacement: boolean, parameters: Record<string, number> = { official_cutoff: 50 }, rejection?: string) {
  const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
  const slots = ['A', 'B', 'C', 'D'].map(slot => ({ slot, effectId: '', bypassed: false }));
  const status = { nativeFx: { catalogParameterReplacement: supportsReplacement,
    inputCatalogSlots: [{ slot: 'A', effectId: 'filter.lpf', bypassed: false }, ...slots.slice(1)], catalogSlots: slots,
    catalogEffectAvailability: [{ effectId: 'filter.lpf', input: true, track: true, officialParameters: [{ id: 'official_cutoff' }] }],
  } } as unknown as NativeStatus;
  const empty = () => ({ type: '', value: 0, active: false, parameters: {} });
  const input = [{ type: 'DSP LPF', value: 50, active: true, parameters }, empty(), empty(), empty()];
  const track = [empty(), empty(), empty(), empty()];
  const bridge = { setCatalogSlot: vi.fn(async (config: NativeCatalogSlotConfig) => {
    if (rejection) throw new Error(rejection);
    status.nativeFx!.inputCatalogSlots![0] = renderedCatalogWrite(config);
    return status;
  }), stopEngine: vi.fn() };
  Object.assign(engine, { latestStatus: status, engineRunning: true, bridge, nativeCatalogFxRuntime: new Map(),
    nativeCatalogSlotEditRevisions: new Map(), nativePerTrackFxEdited: new Set(),
    nativeCatalogFxDirtySlots: new Set(['input:A']), nativeCatalogFxSubmittedEditRevisions: new Map(),
    nativeCatalogFxHydratedSlots: new Set(), nativeCatalogFxUnknownParameterSlots: new Set(),
    nativeCatalogStates: (path: string) => path === 'input' ? input : track,
    isPerTrackCatalogAvailable: () => false, getCatalogFxOptions: () => ['DSP LPF'], applyStatus: vi.fn(), emitAll: vi.fn(),
  });
  return { engine, bridge, sync: () => (engine as unknown as { syncNativeFxCatalogSlots(allow: boolean): Promise<void> }).syncNativeFxCatalogSlots(false) };
}

describe('Native complete authored snapshots', () => {
  it('sends an explicit replacement contract only to a capable host', async () => {
    const { engine, bridge, sync } = harness(true);
    await sync();
    expect(bridge.setCatalogSlot).toHaveBeenCalledWith(expect.objectContaining({ replaceParameters: true, parameters: expect.objectContaining({ official_cutoff: 50 }) }));
    expect(engine.getCatalogFxSlotStatus('input', 0)?.acknowledged).toBe(true);
  });
  it('does not claim official reset/edits were accepted by an old patch-only host', async () => {
    const { engine, bridge, sync } = harness(false);
    await sync();
    expect(bridge.setCatalogSlot).not.toHaveBeenCalled();
    expect(engine.getCatalogFxSlotStatus('input', 0)).toMatchObject({ acknowledged: false, error: expect.stringContaining('update the Native host') });
  });
  it('keeps old-host legacy-only writes working without inventing replacement support', async () => {
    const { bridge, sync } = harness(false, { cutoff_hz: 2000 });
    await sync();
    expect(bridge.setCatalogSlot).toHaveBeenCalledTimes(1);
    expect(bridge.setCatalogSlot.mock.calls[0]![0].replaceParameters).toBeUndefined();
  });
  it('reports a rejected live removal as not applied, without stopping audio itself', async () => {
    const { engine, bridge, sync } = harness(true, {}, 'Stop Native audio before removing authored parameters; requiresRestart');
    await sync();
    expect(engine.getCatalogFxSlotStatus('input', 0)).toMatchObject({ acknowledged: false, pendingRestart: true, error: expect.stringContaining('Stop Native audio') });
    expect(bridge.stopEngine).not.toHaveBeenCalled();
  });
  it('preserves and validates the optional raw bridge flag', async () => {
    const bridge = new NativeBridgeClient();
    const request = vi.fn().mockResolvedValue({});
    (bridge as unknown as { request: typeof request }).request = request;
    await bridge.setCatalogSlot({ slot: 'A', effectId: 'filter.lpf', bypassed: false, parameters: {}, replaceParameters: true });
    expect(JSON.parse(request.mock.calls[0]![1].body).replaceParameters).toBe(true);
    await expect(bridge.setCatalogSlot({ slot: 'A', effectId: 'filter.lpf', bypassed: false, replaceParameters: 'yes' } as unknown as NativeCatalogSlotConfig)).rejects.toThrow(RangeError);
  });
});
