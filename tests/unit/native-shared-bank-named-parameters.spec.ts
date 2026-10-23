import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

async function setupNativeBanks() {
  vi.resetModules();
  localStorage.clear();
  window.history.replaceState({}, '', '/?audio=native');
  const { AudioEngine } = await import('../../src/audio/AudioEngine');
  const engine = AudioEngine.getInstance();
  const listeners = new Set<() => void>();
  const { nativeCatalogEffectId } = await import('../../src/audio/nativeFxCatalog');
  vi.spyOn(engine, 'getNativeCatalogFxParameterSnapshot').mockReturnValue(null);
  const schema = {
    version: 1 as const,
    parameters: [
      { id: 'official_depth', label: 'Depth', minimum: 0, maximum: 100, defaultValue: 50, smoothingMs: 20, discrete: false },
      { id: 'stages', label: 'Stages', minimum: 4, maximum: 12, defaultValue: 8, smoothingMs: 40, discrete: true, discreteValues: [4, 8, 12] },
      { id: 'rate_hz', label: 'Rate', minimum: 0.05, maximum: 10, defaultValue: 0.5, smoothingMs: 20, discrete: false },
      { id: 'depth', label: 'Depth', minimum: 0, maximum: 1, defaultValue: 0.65, smoothingMs: 20, discrete: false },
    ],
    legacyAliases: [],
  };
  const runtimes = new Map<string, Record<string, unknown>>();
  const runtimeKey = (path: string, index: number) => `${path}:${index}`;
  const slotName = (index: number) => ['A', 'B', 'C', 'D'][index] as 'A' | 'B' | 'C' | 'D';
  const defaultRuntime = (path: 'input' | 'track', index: number) => ({
    path, slot: slotName(index), trackId: 0, requestedEffectId: 'phaser', acknowledgedEffectId: 'phaser',
    requestedParameters: { depth: 0, wet_mix: 0 }, acknowledgedParameters: { depth: 0, wet_mix: 0 },
    requestedBypassed: false, appliedBypassed: false, prepared: true, processingFaulted: false,
    controlFaulted: false, pendingApply: false, outcomeUnknown: false, requestedRevision: 7,
    appliedRevision: 7, acknowledged: true, pendingRestart: false, error: '',
  });

  vi.spyOn(engine, 'onStatusChange').mockImplementation((callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  });
  vi.spyOn(engine, 'getCapabilities').mockReturnValue({
    mode: 'native', modeSummary: 'NATIVE', supportedTrackCount: 5,
    supportsInputFx: true, supportsTrackFx: true, supportsReverse: false,
    supportsRhythm: false, supportsBeatFeedback: false, fxReason: '', reverseReason: '',
    rhythmReason: '', beatReason: '', trackLevelReason: '',
  });
  vi.spyOn(engine, 'getNativeCatalogFxOptions').mockReturnValue(['PHASER', 'LPF']);
  vi.spyOn(engine, 'getNativeCatalogFxParameterSchema').mockImplementation(() => schema);
  vi.spyOn(engine, 'getNativeCatalogFxSlotStatus').mockImplementation((path, index) => {
    return (runtimes.get(runtimeKey(path, index)) ?? defaultRuntime(path, index)) as never;
  });
  vi.spyOn(engine, 'setFxType').mockImplementation(() => {});
  vi.spyOn(engine, 'setFxParam').mockImplementation(() => {});
  vi.spyOn(engine, 'setFxActive').mockImplementation(() => {});
  const send = vi.spyOn(engine, 'setCatalogFxParameters').mockImplementation((path, index, parameters) => {
    const base = defaultRuntime(path, index) as Record<string, unknown>;
    const previous = (runtimes.get(runtimeKey(path, index)) ?? base) as Record<string, unknown>;
    const slot = (path === 'input' ? input.slots.value : track.slots.value)[index];
    const expected = engine.getNativeCatalogFxParameterSnapshot(path, index, 0, parameters) ?? (path === 'input' || path === 'track'
      ? { depth: (slot?.value ?? 0) / 100, wet_mix: (slot?.value ?? 0) / 100, ...parameters }
      : parameters);
    runtimes.set(runtimeKey(path, index), {
      ...previous, requestedEffectId: nativeCatalogEffectId(slot?.type ?? ''), requestedParameters: expected, acknowledgedParameters: null,
      requestedRevision: (Number(previous.requestedRevision) || 7) + 1,
      pendingApply: true, acknowledged: false, outcomeUnknown: false, error: '',
    });
  });

  const module = await import('../../src/composables/useFxPanelState');
  const input = module.useFxPanelState('input');
  const track = module.useFxPanelState('track');
  const emitStatus = () => listeners.forEach((listener) => listener());
  const acknowledge = (path: 'input' | 'track', index: number) => {
    const runtime = runtimes.get(runtimeKey(path, index))!;
    runtimes.set(runtimeKey(path, index), {
      ...runtime, pendingApply: false, acknowledged: true,
      acknowledgedEffectId: runtime.requestedEffectId, appliedRevision: runtime.requestedRevision, pendingRestart: false,
      acknowledgedParameters: runtime.requestedParameters, error: '',
    });
    emitStatus();
  };
  const reject = (path: 'input' | 'track', index: number, error: string) => {
    const runtime = runtimes.get(runtimeKey(path, index))!;
    runtimes.set(runtimeKey(path, index), { ...runtime, pendingApply: false, acknowledged: false, error });
    emitStatus();
  };
  const markUnknown = (path: 'input' | 'track', index: number) => {
    const runtime = runtimes.get(runtimeKey(path, index))!;
    runtimes.set(runtimeKey(path, index), {
      ...runtime, pendingApply: true, acknowledged: false, outcomeUnknown: true,
      error: 'Native catalog FX write timed out; outcome unknown.',
    });
    emitStatus();
  };
  return { engine, input, track, send, runtimes, acknowledge, reject, markUnknown };
}

let nativeSetup: Awaited<ReturnType<typeof setupNativeBanks>>;
beforeEach(async () => { localStorage.clear(); nativeSetup = await setupNativeBanks(); });
afterEach(() => vi.restoreAllMocks());

describe('Native shared Input and Track named parameter controls', () => {
  it('validates host schema and persists controls only after an exact Native ACK for each bank', async () => {
    const { input, track, engine, send, acknowledge } = nativeSetup;
    input.slots.value[0]!.type = 'PHASER';
    track.slots.value[0]!.type = 'PHASER';
    await nextTick();
    const storageKey = 'webrc505_native_fx_catalog';
    const before = localStorage.getItem(storageKey);

    expect(input.setNativeNamedParameters(0, { rate_hz: 20 })).toBe(false);
    expect(input.setNativeNamedParameters(0, { stages: 6 })).toBe(false);
    expect(input.setNativeNamedParameters(0, { missing: 1 })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(localStorage.getItem(storageKey)).toBe(before);

    expect(input.setNativeNamedParameters(0, { rate_hz: 2 })).toBe(true);
    expect(input.nativeNamedParametersPending.value).toBe(true);
    expect(input.slots.value[0]!.namedParametersByType).toBeUndefined();
    expect(localStorage.getItem(storageKey)).toBe(before);
    expect(send).toHaveBeenCalledWith('input', 0, { depth: 0, wet_mix: 0, rate_hz: 2 });
    acknowledge('input', 0);
    expect(input.nativeNamedParametersPending.value).toBe(false);
    expect(input.slots.value[0]!.namedParametersByType?.PHASER).toEqual({ rate_hz: 2 });
    expect(JSON.parse(localStorage.getItem(storageKey)!).inputSlots[0].namedParametersByType.PHASER).toEqual({ rate_hz: 2 });

    expect(track.setNativeNamedParameters(0, { stages: 12 })).toBe(true);
    expect(track.nativeNamedParametersPending.value).toBe(true);
    expect(track.slots.value[0]!.namedParametersByType).toBeUndefined();
    acknowledge('track', 0);
    expect(track.slots.value[0]!.namedParametersByType?.PHASER).toEqual({ stages: 12 });
    expect(input.slots.value[0]!.namedParametersByType?.PHASER).toEqual({ rate_hz: 2 });
    expect(engine.setCatalogFxParameters).toHaveBeenCalledTimes(2);
  });

  it('keeps confirmed parameters on rejection and retains unknown outcomes without retrying', async () => {
    const { input, send, acknowledge, reject, markUnknown } = nativeSetup;
    input.slots.value[0]!.type = 'PHASER';
    await nextTick();

    expect(input.setNativeNamedParameters(0, { rate_hz: 2 })).toBe(true);
    acknowledge('input', 0);
    const saved = localStorage.getItem('webrc505_native_fx_catalog');
    expect(input.slots.value[0]!.namedParametersByType?.PHASER).toEqual({ rate_hz: 2 });

    expect(input.setNativeNamedParameters(0, { rate_hz: 3 })).toBe(true);
    reject('input', 0, 'Invalid Native catalog FX parameter rate_hz for phaser.');
    expect(input.nativeNamedParametersPending.value).toBe(false);
    expect(input.slots.value[0]!.namedParametersByType?.PHASER).toEqual({ rate_hz: 2 });
    expect(localStorage.getItem('webrc505_native_fx_catalog')).toBe(saved);

    expect(input.setNativeNamedParameters(0, { rate_hz: 4 })).toBe(true);
    markUnknown('input', 0);
    expect(input.nativeNamedParametersPending.value).toBe(true);
    expect(input.setNativeNamedParameters(0, { rate_hz: 5 })).toBe(false);
    expect(input.slots.value[0]!.namedParametersByType?.PHASER).toEqual({ rate_hz: 2 });
    expect(localStorage.getItem('webrc505_native_fx_catalog')).toBe(saved);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it.each(['input', 'track'] as const)('persists %s official ACK despite changing derived tempo and meter', async (path) => {
    const setup = nativeSetup;
    const panel = setup[path];
    panel.slots.value[0]!.type = 'PHASER';
    await nextTick();
    vi.mocked(setup.engine.getNativeCatalogFxParameterSnapshot).mockImplementation((_path, _index, _track, overrides) =>
      ({ depth: 0, wet_mix: 0, ...overrides, official_bpm: 120, official_quarter_notes_per_measure: 4 }));
    expect(panel.setNativeNamedParameters(0, { official_depth: 25 })).toBe(true);
    const runtime = setup.runtimes.get(`${path}:0`)!;
    runtime.requestedParameters = { ...(runtime.requestedParameters as Record<string, number>), official_bpm: 143, official_quarter_notes_per_measure: 3 };
    setup.acknowledge(path, 0);
    expect(panel.nativeNamedParametersPending.value).toBe(false);
    expect(panel.slots.value[0]!.namedParametersByType?.PHASER).toEqual({ official_depth: 25 });
    expect(JSON.parse(localStorage.getItem('webrc505_native_fx_catalog')!)[`${path}Slots`][0].namedParametersByType.PHASER).toEqual({ official_depth: 25 });
  });

  it('retains a rejected live reset until restart ACK updates both UI and persisted controls', async () => {
    const { input, runtimes, acknowledge, reject } = nativeSetup;
    input.slots.value[0]!.type = 'PHASER';
    await nextTick();
    expect(input.setNativeNamedParameters(0, { official_depth: 25 })).toBe(true);
    acknowledge('input', 0);
    expect(input.setNativeNamedParameters(0, {})).toBe(true);
    runtimes.get('input:0')!.pendingRestart = true;
    reject('input', 0, 'Stop Native audio before removing authored parameters; requiresRestart');
    expect(input.nativeNamedParametersPending.value).toBe(true);
    expect(input.slots.value[0]!.namedParametersByType?.PHASER).toEqual({ official_depth: 25 });
    input.slots.value[0]!.active = true;
    input.slots.value[0]!.value = 60;
    await nextTick();
    expect(runtimes.get('input:0')!.requestedParameters).toEqual({ depth: 0.6, wet_mix: 0.6 });
    expect(input.nativeNamedParametersPending.value).toBe(true);
    acknowledge('input', 0); // Simulates the successful explicit stop/restart apply, not an automatic stop.
    expect(input.nativeNamedParametersPending.value).toBe(false);
    expect(input.slots.value[0]!.namedParametersByType).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('webrc505_native_fx_catalog')!).inputSlots[0].namedParametersByType).toBeUndefined();
  });

  it('uses the real typed STEP SLICER submission snapshot rather than rebuilding it from amount', async () => {
    const { input, engine, runtimes, acknowledge } = nativeSetup;
    const { NativeAudioEngine } = await import('../../src/audio/NativeAudioEngine');
    const native = Object.create(NativeAudioEngine.prototype) as InstanceType<typeof NativeAudioEngine>;
    const typed = { depth_percent: 100, step_level_1: 37, step_level_2: 83, rate_index: 4 };
    Object.assign(native, {
      nativeCatalogStates: () => [{ type: 'STEP SLICER', value: 7, active: true, parameters: {} }],
      nativeStepSlicerParameters: { input: [typed], track: [typed] },
      latestStatus: { nativeFx: { catalogEffectAvailability: [{ effectId: 'step_slicer', officialParameters: [{ id: 'official_depth' }] }] } },
    });
    vi.mocked(engine.getNativeCatalogFxParameterSnapshot).mockImplementation((path, index, track, overrides) =>
      native.getCatalogFxParameterSnapshot(path, index, track, overrides));
    input.slots.value[0]!.type = 'STEP SLICER';
    input.slots.value[0]!.value = 7;
    await nextTick();
    expect(input.setNativeNamedParameters(0, { official_depth: 40 })).toBe(true);
    const sent = runtimes.get('input:0')!.requestedParameters as Record<string, number>;
    expect(sent).toMatchObject({ ...typed, official_depth: 40 });
    sent.bpm = 187; // Derived legacy tempo can advance while the authored controls await ACK.
    acknowledge('input', 0);
    expect(input.nativeNamedParametersPending.value).toBe(false);
    expect(input.slots.value[0]!.namedParametersByType?.['STEP SLICER']).toEqual({ official_depth: 40 });
  });

  it('cancels a pending reset when its slot is cleared instead of leaving the editor locked', async () => {
    const { input, runtimes, reject } = nativeSetup;
    input.slots.value[0]!.type = 'PHASER';
    await nextTick();
    expect(input.setNativeNamedParameters(0, {})).toBe(true);
    runtimes.get('input:0')!.pendingRestart = true;
    reject('input', 0, 'Stop Native audio before replacing parameters.');
    expect(input.nativeNamedParametersPending.value).toBe(true);
    input.slots.value[0]!.type = '';
    await nextTick();
    expect(input.nativeNamedParametersPending.value).toBe(false);
  });

});
