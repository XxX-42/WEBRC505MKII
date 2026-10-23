import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

const emptySlots = () => ['A', 'B', 'C', 'D'].map((id) => ({ id, type: '', value: 0, active: false }));

async function loadRuntime(mode: 'browser' | 'native', location: 'input' | 'track' = 'track') {
  vi.resetModules();
  window.history.replaceState({}, '', `/?audio=${mode}`);
  const { AudioEngine } = await import('../../src/audio/AudioEngine');
  const engine = AudioEngine.getInstance();
  vi.spyOn(engine, 'onStatusChange').mockImplementation(() => () => {});
  if (mode === 'native') {
    vi.spyOn(engine, 'getCapabilities').mockReturnValue({
      mode: 'native', modeSummary: 'test', supportedTrackCount: 5,
      supportsInputFx: true, supportsTrackFx: true, supportsReverse: true, supportsRhythm: true,
      supportsBeatFeedback: true, fxReason: '', reverseReason: '', rhythmReason: '', beatReason: '',
      trackLevelReason: '', supportsOutputLevel: true, outputLevelReason: '',
    });
    vi.spyOn(engine, 'setFxType').mockImplementation(() => {});
    vi.spyOn(engine, 'setFxParam').mockImplementation(() => {});
  }
  const { useFxPanelState } = await import('../../src/composables/useFxPanelState');
  const panel = useFxPanelState(location);
  if (mode === 'browser') {
    vi.spyOn(engine, 'getBrowserSharedFxSnapshot').mockImplementation(() => panel.slots.value.map((slot) => ({
      slot: slot.id,
      type: slot.type || null,
      requestedType: slot.type || null,
      active: slot.type ? slot.active : false,
      requestedActive: slot.type ? slot.active : false,
      state: slot.type ? 'ready' : 'empty',
      amount: slot.value,
      parameters: {},
      parametersCaptured: false,
      error: null,
    })));
  }
  const scope = effectScope();
  const memoryRegistry = await import('../../src/composables/wrapRc505MemoryUiRuntime');
  const register = vi.spyOn(memoryRegistry, 'registerRc505MemoryBankUiPort');
  const banks = await import('../../src/composables/useRc505FxBanks').then((module) =>
    scope.run(() => module.useRc505FxBanks(location))!);
  const memoryPort = register.mock.calls.at(-1)![2];
  return { engine, panel, banks, scope, memoryPort };
}

async function loadNativeBankScenario(unacknowledged = new Set<number>()) {
  vi.resetModules();
  window.history.replaceState({}, '', '/?audio=native');
  const store = await import('../../src/ui/rc505/Rc505FxBankStore');
  const document = store.createFxPresetBankDocument('native', 'track', emptySlots() as never);
  document.banks.B.slots[0]!.type = 'DELAY';
  document.activeBank = 'A';
  localStorage.setItem(store.fxPresetBankStorageKey('native', 'track'), store.serializeFxPresetBankDocument(document));

  const { AudioEngine } = await import('../../src/audio/AudioEngine');
  const engine = AudioEngine.getInstance();
  const statusListeners = new Set<Parameters<typeof engine.onStatusChange>[0]>();
  vi.spyOn(engine, 'onStatusChange').mockImplementation((listener) => {
    statusListeners.add(listener);
    return () => { statusListeners.delete(listener); };
  });
  const emitStatus = () => { for (const listener of statusListeners) listener(engine.getUiStatus()); };
  const parameters = { delay_ms: 275 };
  const rejected = new Set<number>();
  vi.spyOn(engine, 'getCapabilities').mockReturnValue({
    mode: 'native', modeSummary: 'test', supportedTrackCount: 5,
    supportsInputFx: true, supportsTrackFx: true, supportsReverse: true, supportsRhythm: true,
    supportsBeatFeedback: true, fxReason: '', reverseReason: '', rhythmReason: '', beatReason: '',
    trackLevelReason: '', supportsOutputLevel: true, outputLevelReason: '',
  });
  const setFxType = vi.spyOn(engine, 'setFxType').mockImplementation(() => {});
  vi.spyOn(engine, 'setFxParam').mockImplementation(() => {});
  const { nativeCatalogEffectId } = await import('../../src/audio/nativeFxCatalog');
  vi.spyOn(engine, 'getNativeCatalogFxParameterSnapshot').mockImplementation((_path, index) =>
    index === 0 ? { ...parameters } : null);
  vi.spyOn(engine, 'getNativeCatalogFxSlotStatus').mockImplementation((_path, index) => {
    const row = document.banks.B.slots[index]!;
    const effectId = row.type ? nativeCatalogEffectId(row.type) : null;
    const slotParameters = effectId ? { ...parameters } : {};
    return {
      path: 'track', slot: (['A', 'B', 'C', 'D'] as const)[index]!, trackId: 0,
      requestedBypassed: effectId ? !row.active : false,
      appliedBypassed: effectId ? !row.active : false,
      prepared: true, processingFaulted: false, controlFaulted: false, pendingApply: false,
      outcomeUnknown: false, requestedRevision: 2, appliedRevision: 2,
      requestedEffectId: effectId, acknowledgedEffectId: effectId,
      requestedParameters: slotParameters, acknowledgedParameters: slotParameters,
      acknowledged: !unacknowledged.has(index) && !rejected.has(index), pendingRestart: false,
      error: rejected.has(index) ? 'Native rejected this parameter write.' : '',
    };
  });
  const { useFxPanelState } = await import('../../src/composables/useFxPanelState');
  const panel = useFxPanelState('track');
  const initialTypeWrites = setFxType.mock.calls.length;
  const scope = effectScope();
  const { useRc505FxBanks } = await import('../../src/composables/useRc505FxBanks');
  const banks = scope.run(() => useRc505FxBanks('track'))!;
  return { engine, panel, banks, document, initialTypeWrites, setFxType, scope, unacknowledged,
    emitStatus, parameters, rejected };
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('RC-505 shared FX preset banks', () => {
  it('adopts Memory bank documents without DSP writes and confirms blue only from runtime readback', async () => {
    vi.useFakeTimers();
    const { engine, banks, scope, memoryPort } = await loadRuntime('browser');
    const setType = vi.spyOn(engine, 'setFxType');
    const setAmount = vi.spyOn(engine, 'setFxParam');
    const setActive = vi.spyOn(engine, 'setFxActive');
    const document = memoryPort.capture();
    document.activeBank = 'C'; document.banks.C = structuredClone(document.banks.A);
    memoryPort.adopt(document);
    expect(banks.state.requestedBank).toBe('C'); expect(banks.state.appliedBank).toBeNull();
    await nextTick(); await vi.advanceTimersByTimeAsync(100);
    expect(banks.state.appliedBank).toBe('C');
    expect(setType).not.toHaveBeenCalled(); expect(setAmount).not.toHaveBeenCalled(); expect(setActive).not.toHaveBeenCalled();
    memoryPort.adopt(document); memoryPort.finishAdoption?.();
    const hydratedRevision = memoryPort.revision();
    await nextTick(); await vi.advanceTimersByTimeAsync(100);
    expect(memoryPort.revision()).toBe(hydratedRevision);
    memoryPort.adopt(document, 'Storage failed after audio committed.');
    await nextTick(); await vi.advanceTimersByTimeAsync(100);
    expect(banks.state.appliedBank).toBeNull(); expect(banks.canSelect.value).toBe(false);
    scope.stop();
  }, 45_000);
  it('migrates the existing four rows to A by deep copy and initializes B–D empty', async () => {
    vi.resetModules();
    const { createFxPresetBankDocument } = await import('../../src/ui/rc505/Rc505FxBankStore');
    const legacy = emptySlots() as Array<{ id: string; type: string; value: number; active: boolean; namedParametersByType?: Record<string, Record<string, number>> }>;
    legacy[0]!.type = 'DELAY';
    legacy[0]!.namedParametersByType = { DELAY: { delay_ms: 275 } };

    const migrated = createFxPresetBankDocument('browser', 'track', legacy as never);
    expect(migrated.activeBank).toBe('A');
    expect(migrated.banks.A.slots).toEqual(legacy);
    expect(migrated.banks.B.slots).toEqual(emptySlots());
    expect(migrated.banks.C.slots).toEqual(emptySlots());
    expect(migrated.banks.D.slots).toEqual(emptySlots());
    legacy[0]!.namedParametersByType!.DELAY!.delay_ms = 20;
    expect(migrated.banks.A.slots[0]!.namedParametersByType?.DELAY?.delay_ms).toBe(275);
  });

  it('accepts and normalizes an explicitly undefined optional slot field during migration', async () => {
    vi.resetModules();
    const { createFxPresetBankDocument } = await import('../../src/ui/rc505/Rc505FxBankStore');
    const legacy = emptySlots() as Array<{
      id: string; type: string; value: number; active: boolean;
      namedParametersByType?: Record<string, Record<string, number>> | undefined;
    }>;
    legacy[0]!.type = 'DELAY';
    legacy[0]!.namedParametersByType = undefined;

    const migrated = createFxPresetBankDocument('native', 'track', legacy as never);

    expect(migrated.banks.A.slots[0]).toMatchObject({ id: 'A', type: 'DELAY', value: 0, active: false });
    expect(migrated.banks.A.slots[0]).not.toHaveProperty('namedParametersByType');
  });

  it('preserves legacy live rows and disables bank selection when sidecar data is corrupt', async () => {
    localStorage.setItem('webrc505_top_panel', JSON.stringify({
      trackSlots: [
        { id: 'A', type: 'CHORUS', value: 42, active: true },
        { id: 'B', type: '', value: 0, active: false },
        { id: 'C', type: '', value: 0, active: false },
        { id: 'D', type: '', value: 0, active: false },
      ],
    }));
    const key = 'webrc505_fx_preset_banks_v1_browser_track';
    localStorage.setItem(key, '{not-json');
    const corruptSidecar = localStorage.getItem(key);
    const { panel, banks, scope } = await loadRuntime('browser');
    const originalRows = JSON.parse(JSON.stringify(panel.slots.value));

    expect(panel.slots.value).toEqual(originalRows);
    expect(panel.slots.value[0]).toMatchObject({ id: 'A', type: 'CHORUS', value: 42, active: true });
    expect(banks.canSelect.value).toBe(false);
    expect(banks.state.unavailableReason).toMatch(/corrupt/i);
    expect(localStorage.getItem(key)).toBe(corruptSidecar);
    scope.stop();
  }, 15_000);

  it('leaves a partially acknowledged Native bank unapplied without rollback or automatic resend', async () => {
    vi.useFakeTimers();
    const { panel, banks, scope, initialTypeWrites, setFxType } = await loadNativeBankScenario(new Set([3]));

    expect(banks.canSelect.value).toBe(true);
    const pending = banks.selectBank('B');
    await nextTick();
    await vi.advanceTimersByTimeAsync(5_100);

    expect(await pending).toBe(false);
    expect(banks.state.appliedBank).toBe(null);
    expect(banks.state.requestedBank).toBe('B');
    expect(panel.slots.value[0]).toMatchObject({ id: 'A', type: 'DELAY' });
    expect(setFxType).toHaveBeenCalledTimes(initialTypeWrites + 1);
    expect(banks.state.error).toMatch(/did not confirm all four/i);
    scope.stop();
  }, 15_000);

  it('does not treat an undefined optional row property as a change during Native confirmation', async () => {
    vi.useFakeTimers();
    const scenario = await loadNativeBankScenario(new Set([3]));

    const pending = scenario.banks.selectBank('B');
    await nextTick();
    Object.assign(scenario.panel.slots.value[0]!, { namedParametersByType: undefined });
    scenario.unacknowledged.clear();
    await vi.advanceTimersByTimeAsync(100);

    expect(await pending).toBe(true);
    expect(scenario.banks.state.appliedBank).toBe('B');
    expect(scenario.banks.state.error).toBe('');
    scenario.scope.stop();
  }, 15_000);

  it('does not mark a Browser bank applied when the stored processor parameters differ', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const store = await import('../../src/ui/rc505/Rc505FxBankStore');
    const document = store.createFxPresetBankDocument('browser', 'track', emptySlots() as never);
    document.banks.B.slots[0]!.type = 'FILTER';
    document.banks.B.slots[0]!.value = 15;
    document.banks.B.browserParameters = [{ stale_parameter: 99 }, null, null, null];
    document.activeBank = 'A';
    localStorage.setItem(store.fxPresetBankStorageKey('browser', 'track'), store.serializeFxPresetBankDocument(document));
    const { panel, banks, scope } = await loadRuntime('browser');

    const pending = banks.selectBank('B');
    await nextTick();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await pending).toBe(false);
    expect(panel.slots.value[0]).toMatchObject({ id: 'A', type: 'FILTER', value: 15 });
    expect(banks.state.requestedBank).toBe('B');
    expect(banks.state.appliedBank).toBe(null);
    scope.stop();
  }, 15_000);

  it('requires Browser named overrides to appear in the actual slot snapshot', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const store = await import('../../src/ui/rc505/Rc505FxBankStore');
    const document = store.createFxPresetBankDocument('browser', 'track', emptySlots() as never);
    document.banks.B.slots[0]!.type = 'FILTER';
    document.banks.B.slots[0]!.namedParametersByType = { FILTER: { cutoff_hz: 55 } };
    document.activeBank = 'A';
    localStorage.setItem(store.fxPresetBankStorageKey('browser', 'track'), store.serializeFxPresetBankDocument(document));
    const { banks, scope } = await loadRuntime('browser');

    const pending = banks.selectBank('B');
    await nextTick();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await pending).toBe(false);
    expect(banks.state.appliedBank).toBe(null);
    scope.stop();
  }, 15_000);

  it('clears the applied bank when a later runtime readback shows drift', async () => {
    vi.useFakeTimers();
    const scenario = await loadNativeBankScenario();
    const applied = scenario.banks.selectBank('B');
    await nextTick();
    expect(await applied).toBe(true);
    expect(scenario.banks.state.appliedBank).toBe('B');

    scenario.unacknowledged.add(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(scenario.banks.state.appliedBank).toBe(null);
    expect(scenario.banks.state.error).toMatch(/no longer matches/i);
    scenario.scope.stop();
  }, 15_000);

  it('recovers the same bank when runtime loses ACK before named rows receive their ACK', async () => {
    vi.useFakeTimers();
    const scenario = await loadNativeBankScenario();
    const applied = scenario.banks.selectBank('B');
    await nextTick();
    expect(await applied).toBe(true);
    const storageKey = 'webrc505_fx_preset_banks_v1_native_track';
    const savedBefore = localStorage.getItem(storageKey);
    const rowBefore = JSON.stringify(scenario.panel.slots.value);
    scenario.parameters.delay_ms = 300;
    scenario.unacknowledged.add(0);
    scenario.emitStatus();
    expect(JSON.stringify(scenario.panel.slots.value)).toBe(rowBefore);
    expect(scenario.banks.state.appliedBank).toBeNull();
    expect(scenario.banks.state.error).toMatch(/no longer matches/i);
    expect(localStorage.getItem(storageKey)).toBe(savedBefore);

    scenario.unacknowledged.delete(0);
    // useFxPanelState writes these rows only after the parameter ACK arrives.
    scenario.panel.slots.value[0]!.namedParametersByType = { DELAY: { delay_ms: 300 } };
    scenario.emitStatus();
    expect(scenario.banks.state.appliedBank).toBe('B');
    expect(scenario.banks.state.error).toBe('');
    expect(JSON.parse(localStorage.getItem(storageKey)!).banks.B.slots[0].namedParametersByType)
      .toEqual({ DELAY: { delay_ms: 300 } });
    scenario.scope.stop();
  }, 15_000);

  it.each(['unacknowledged', 'rejected'] as const)('does not save or restore a bank while a named write remains %s', async (failure) => {
    vi.useFakeTimers();
    const scenario = await loadNativeBankScenario();
    const applied = scenario.banks.selectBank('B');
    await nextTick();
    expect(await applied).toBe(true);
    const storageKey = 'webrc505_fx_preset_banks_v1_native_track';
    const savedBefore = localStorage.getItem(storageKey);
    const writesBefore = scenario.setFxType.mock.calls.length;
    scenario.parameters.delay_ms = 300;
    if (failure === 'rejected') scenario.rejected.add(0);
    else scenario.unacknowledged.add(0);
    scenario.emitStatus();
    await vi.advanceTimersByTimeAsync(300);
    scenario.emitStatus();
    expect(scenario.banks.state.appliedBank).toBeNull();
    expect(scenario.banks.state.error).toMatch(/no longer matches/i);
    expect(localStorage.getItem(storageKey)).toBe(savedBefore);
    expect(scenario.setFxType).toHaveBeenCalledTimes(writesBefore);
    scenario.scope.stop();
  }, 15_000);

  it('disables the runtime-specific bank after the audio runtime changes', async () => {
    vi.useFakeTimers();
    const { engine, banks, scope } = await loadRuntime('browser');
    engine.setMode('native');
    await vi.advanceTimersByTimeAsync(100);
    expect(banks.canSelect.value).toBe(false);
    expect(banks.state.unavailableReason).toMatch(/runtime changed/i);
    expect(await banks.selectBank('B')).toBe(false);
    expect(localStorage.getItem('webrc505_fx_preset_banks_v1_native_track')).toBeNull();
    scope.stop();
  }, 15_000);

  it('stops a pending apply immediately on disposal without later bank writes', async () => {
    vi.useFakeTimers();
    const scenario = await loadNativeBankScenario(new Set([3]));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const pending = scenario.banks.selectBank('B');
    await nextTick();
    await Promise.resolve();
    const writesAtDispose = setItem.mock.calls.length;
    scenario.scope.stop();
    await expect(pending).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(setItem).toHaveBeenCalledTimes(writesAtDispose);
    expect(scenario.banks.state.appliedBank).toBe(null);
  }, 15_000);
});
