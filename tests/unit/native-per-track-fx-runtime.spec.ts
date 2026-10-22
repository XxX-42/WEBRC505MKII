import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { createDefaultNativeStepSlicerParameters } from '../../src/audio/nativeStepSlicerParameters';
import { NativeBridgeRequestTimeoutError, type NativeBridgeClient, type NativeCatalogMidiEvent, type NativeCatalogSlotConfig, type NativeCatalogSlotStatus, type NativePerTrackCatalogBank, type NativeStatus } from '../../src/audio/NativeBridgeClient';

const slots = ['A', 'B', 'C', 'D'] as const;
const types = ['DSP LPF', 'DSP HPF', 'CHORUS', 'PREAMP'];
const effectIds = ['filter.lpf', 'filter.hpf', 'chorus', 'preamp', 'osc_voc_m'];
type Internals = {
  bridge: NativeBridgeClient;
  bridgeAvailable: boolean;
  engineRunning: boolean;
  latestStatus: NativeStatus | null;
  nativeCatalogFxStates: Record<'input' | 'track', Array<{ type: string; active: boolean; value: number; parameters: Record<string, number> }>>;
  nativePerTrackFxStates: Array<Array<{ type: string; active: boolean; value: number; parameters: Record<string, number> }>>;
  nativePerTrackFxEdited: Set<number>;
  nativeCatalogFxRuntime: Map<string, unknown>;
  nativeCatalogSlotEditRevisions: Map<string, number>;
  syncNativeFxCatalogSlots(allowTypeChange: boolean): Promise<void>;
  applyStatus(status: NativeStatus): void;
  handleBridgeFailure(error: unknown): void;
};

function install(engine: NativeAudioEngine) {
  const internals = engine as unknown as Internals;
  const banks: NativePerTrackCatalogBank[] = [1, 2, 3, 4, 5].map((trackId) => ({
    trackId, midiSlots: [], slots: slots.map((slot): NativeCatalogSlotStatus => ({
      slot, effectId: '', bypassed: false, appliedBypassed: false, prepared: false, processingFaulted: false, controlFaulted: false, requestedRevision: 0, appliedRevision: 0,
    })),
  }));
  const shared = slots.map((slot) => ({ slot, effectId: '', bypassed: false }));
  let autoApply = true;
  let running = false;
  const parameters = new Map<string, Record<string, number>>();
  const status = (): NativeStatus => JSON.parse(JSON.stringify({
    ok: true, bridgeHealthy: true, engineRunning: running, backend: 'WASAPI', inputDeviceId: '', outputDeviceId: '',
    inputDeviceName: '', outputDeviceName: '', sampleRate: 48000, bufferFrames: 64, monitoringEnabled: false,
    state: 'Empty', loopProgress: 0, inputLatencyMs: 0, outputLatencyMs: 0, roundTripEstimateMs: 0,
    inputPeak: 0, outputPeak: 0, xrunsOrDropouts: 0, lastError: '',
    nativeFx: {
      catalogGraphAvailable: true, implementedCatalogEffects: effectIds,
      catalogEffectAvailability: effectIds.map((effectId) => ({ effectId, input: true, track: true })),
      catalogSlots: shared, inputCatalogSlots: shared, perTrackCatalogAvailable: true,
      perTrackCatalogBanks: banks, catalogControlFaultCount: 0,
    },
  }));
  const setCatalogSlot = vi.fn(async (config: NativeCatalogSlotConfig) => {
    if (config.trackId) {
      const slot = banks[config.trackId - 1]!.slots.find((entry) => entry.slot === config.slot)!;
      Object.assign(slot, { effectId: config.effectId, bypassed: config.bypassed, prepared: !!config.effectId, processingFaulted: false, requestedRevision: slot.requestedRevision + 1 });
      if (autoApply) Object.assign(slot, { appliedBypassed: slot.bypassed, appliedRevision: slot.requestedRevision });
      parameters.set(`${config.trackId}:${config.slot}`, { ...config.parameters });
    } else Object.assign(shared.find((entry) => entry.slot === config.slot)!, { effectId: config.effectId, bypassed: config.bypassed });
    return status();
  });
  const queueCatalogMidiEvent = vi.fn(async (_event: NativeCatalogMidiEvent) => status());
  const queueOscVocMidiEvent = vi.fn(async () => status());
  internals.bridge = { setCatalogSlot, queueCatalogMidiEvent, queueOscVocMidiEvent } as unknown as NativeBridgeClient;
  internals.applyStatus(status());
  // Configure desired state without scheduling background work; tests flush explicitly.
  internals.bridgeAvailable = false;
  return {
    internals, banks, shared, parameters, setCatalogSlot, queueCatalogMidiEvent, status,
    setRunning(value: boolean) { running = value; internals.applyStatus(status()); internals.bridgeAvailable = false; },
    setAutoApply(value: boolean) { autoApply = value; },
    applyPending() {
      for (const bank of banks) for (const slot of bank.slots) Object.assign(slot, { appliedRevision: slot.requestedRevision, appliedBypassed: slot.bypassed });
      internals.applyStatus(status());
    },
    async sync(allowTypeChange = false) { internals.bridgeAvailable = true; await internals.syncNativeFxCatalogSlots(allowTypeChange); internals.bridgeAvailable = false; },
  };
}

beforeEach(() => {
  const internals = NativeAudioEngine.getInstance() as unknown as Internals;
  internals.bridgeAvailable = false;
  internals.nativePerTrackFxEdited.clear();
  internals.nativeCatalogFxRuntime.clear();
  internals.nativeCatalogSlotEditRevisions.clear();
  for (const bank of [...Object.values(internals.nativeCatalogFxStates), ...internals.nativePerTrackFxStates]) {
    bank.forEach((state) => Object.assign(state, { type: '', active: false, value: 0, parameters: {} }));
  }
});

describe('Native five-track A–D adapter', () => {
  it('exposes only a versioned, well-formed Native parameter schema with compatibility aliases separate', () => {
    const engine = NativeAudioEngine.getInstance();
    const { internals } = install(engine);
    expect(engine.getCatalogFxParameterSchema('PHASER', 'track', 1)).toBeNull();
    const status = internals.latestStatus!;
    status.nativeFx!.parameterSchemaVersion = 1;
    status.nativeFx!.catalogEffectAvailability = [
      { effectId: 'phaser', input: true, track: true, perTrackInsert: true, parameters: [
        { id: 'rate_hz', label: 'Rate', minimum: Math.fround(0.05), maximum: 10, defaultValue: 0.5, smoothingMs: 20, discrete: false },
        { id: 'stages', label: 'Stages', minimum: 4, maximum: 12, defaultValue: 8, smoothingMs: 40, discrete: true, discreteValues: [4, 8, 12] },
      ], legacyParameterAliases: [] },
      { effectId: 'filter.lpf', input: true, track: true, perTrackInsert: true,
        parameters: [{ id: 'resonance_percent', label: 'Resonance', minimum: 0, maximum: 100, defaultValue: 15, smoothingMs: 15, discrete: false }],
        legacyParameterAliases: [{ id: 'q', label: 'Legacy Q compatibility alias', minimum: 0.5, maximum: 12,
          defaultValue: 0.70710678, smoothingMs: 15, discrete: false, legacyAlias: true }] },
    ];
    expect(engine.getCatalogFxParameterSchema('PHASER', 'track', 1)).toMatchObject({
      version: 1,
      parameters: [{ id: 'rate_hz', minimum: 0.05, maximum: 10 }, { id: 'stages', discreteValues: [4, 8, 12] }],
      legacyAliases: [],
    });
    expect(engine.getCatalogFxParameterSchema('DSP LPF', 'track', 1)?.legacyAliases[0]?.id).toBe('q');
    status.nativeFx!.catalogEffectAvailability[0]!.parameters![1]!.discreteValues = [4, 6, 12];
    expect(engine.getCatalogFxParameterSchema('PHASER', 'track', 1)).toBeNull();
  });

  it('orders and preserves 20 independently configured slots without touching the shared bank', async () => {
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    for (let trackId = 1; trackId <= 5; trackId += 1) for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) {
      expect(engine.setTrackFxType(trackId, slotIndex, types[slotIndex]!)).toBe(true);
      engine.setTrackFxParameter(trackId, slotIndex, trackId * 10 + slotIndex);
      engine.setTrackFxNamedParameters(trackId, slotIndex, { custom: trackId * 100 + slotIndex });
      engine.setTrackFxActive(trackId, slotIndex, slotIndex !== 2);
    }
    await bridge.sync();
    expect(bridge.setCatalogSlot.mock.calls.map(([config]) => `${config.trackId}:${config.slot}`)).toEqual(
      [1, 2, 3, 4, 5].flatMap((trackId) => slots.map((slot) => `${trackId}:${slot}`)),
    );
    expect(bridge.shared.every((slot) => slot.effectId === '')).toBe(true);
    for (let trackId = 1; trackId <= 5; trackId += 1) for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) {
      expect(engine.getCatalogFxSlotStatus('track', slotIndex, trackId)).toMatchObject({
        trackId, slot: slots[slotIndex], acknowledged: true, pendingApply: false, pendingRestart: false,
        acknowledgedParameters: { custom: trackId * 100 + slotIndex }, requestedBypassed: slotIndex === 2,
      });
      expect(engine.getCatalogFxSlotStates('track', trackId)[slotIndex]?.parameters).toEqual({ custom: trackId * 100 + slotIndex });
    }
    const copy = engine.getCatalogFxSlotStates('track', 2);
    copy[1]!.parameters!.custom = 9999;
    expect(engine.getCatalogFxSlotStates('track', 2)[1]!.parameters!.custom).toBe(201);
    engine.setTrackFxNamedParameters(3, 1, { custom: 777 });
    await bridge.sync();
    expect(bridge.setCatalogSlot).toHaveBeenCalledTimes(21);
    expect(bridge.setCatalogSlot.mock.lastCall?.[0]).toMatchObject({ trackId: 3, slot: 'B' });
    expect(bridge.parameters.get('3:B')).toMatchObject({ custom: 777 });
    expect(bridge.parameters.get('2:B')).toMatchObject({ custom: 201 });
    bridge.internals.bridgeAvailable = true;
    expect(engine.getTrackFxStatus().map((bank) => [bank.trackId, bank.available, bank.routeMode, bank.slots.length])).toEqual(
      [1, 2, 3, 4, 5].map((id) => [id, true, 'per-track-pre-mix', 4]),
    );
    expect(engine.getTrackFxStatus(3)[0]?.slots[1]).toMatchObject({ slotIndex: 1, slot: 'B', state: 'ready', active: true });
  });

  it('keeps detailed Step Slicer sequences and named overrides independent by loop target', async () => {
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    const capable = bridge.status();
    capable.nativeFx!.implementedCatalogEffects!.push('step_slicer');
    capable.nativeFx!.catalogEffectAvailability!.push({ effectId: 'step_slicer', input: true, track: true, perTrackInsert: true });
    bridge.internals.applyStatus(capable);
    bridge.internals.bridgeAvailable = false;
    // All subsequent ACKs keep advertising Step Slicer availability.
    const original = bridge.setCatalogSlot.getMockImplementation()!;
    bridge.setCatalogSlot.mockImplementation(async (config) => {
      const status = await original(config);
      status.nativeFx!.implementedCatalogEffects!.push('step_slicer');
      status.nativeFx!.catalogEffectAvailability!.push({ effectId: 'step_slicer', input: true, track: true, perTrackInsert: true });
      return status;
    });
    engine.setTrackFxType(1, 0, 'STEP SLICER');
    engine.setTrackFxType(5, 3, 'STEP SLICER');
    engine.setCatalogStepSlicerParameters('track', 0, { ...createDefaultNativeStepSlicerParameters(), step_01: 14 }, 1);
    engine.setCatalogStepSlicerParameters('track', 3, { ...createDefaultNativeStepSlicerParameters(), step_01: 85 }, 5);
    engine.setTrackFxNamedParameters(1, 0, { step_02: 33 });
    await bridge.sync();
    expect(bridge.parameters.get('1:A')).toMatchObject({ step_01: 14, step_02: 33 });
    expect(bridge.parameters.get('5:D')).toMatchObject({ step_01: 85, step_02: 100 });
    expect(engine.getCatalogFxSlotStatus('track', 0, 1).acknowledgedParameters).toMatchObject({ step_01: 14, step_02: 33 });
  });

  it('distinguishes accepted controls, callback application, same-bypass parameter revisions and faults', async () => {
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    engine.setTrackFxType(1, 0, 'DSP LPF');
    engine.setTrackFxActive(1, 0, true);
    await bridge.sync();
    bridge.setRunning(true);
    bridge.setAutoApply(false);
    engine.setTrackFxNamedParameters(1, 0, { cutoff_hz: 2345 });
    await bridge.sync();
    expect(engine.getCatalogFxSlotStatus('track', 0, 1)).toMatchObject({
      acknowledged: false, pendingApply: true, prepared: true, requestedBypassed: false, appliedBypassed: false,
      requestedRevision: 2, appliedRevision: 1,
    });
    bridge.applyPending();
    expect(engine.getCatalogFxSlotStatus('track', 0, 1)).toMatchObject({ acknowledged: true, pendingApply: false, acknowledgedParameters: { cutoff_hz: 2345 } });
    bridge.banks[0]!.slots[0]!.processingFaulted = true;
    bridge.internals.applyStatus(bridge.status());
    expect(engine.getTrackFxStatus(1)[0]?.slots[0]).toMatchObject({ state: 'error', acknowledged: false, processingFaulted: true });
    expect(engine.getCatalogFxSlotStatus('track', 0, 1).error).toContain('processor faulted');
    bridge.internals.handleBridgeFailure(new Error('bridge disconnected'));
    expect(engine.getTrackFxStatus(1)[0]).toMatchObject({ available: false, routeMode: 'unavailable' });
    expect(engine.getCatalogFxSlotStatus('track', 0, 1)).toMatchObject({ acknowledged: false, error: 'bridge disconnected' });
  });

  it('keeps a timed-out Native write unknown unless status exactly identifies its baseline-plus-one applied revision', async () => {
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    engine.setTrackFxType(1, 0, 'DSP LPF');
    engine.setTrackFxActive(1, 0, true);
    const status = bridge.status();
    Object.assign(status.nativeFx!.perTrackCatalogBanks![0]!.slots[0]!, {
      effectId: 'filter.lpf', bypassed: false, appliedBypassed: false, prepared: true,
      requestedRevision: 2, appliedRevision: 2,
    });
    bridge.setCatalogSlot.mockRejectedValueOnce(new NativeBridgeRequestTimeoutError(
      '/v1/native-fx/catalog-slot', 'POST', 5000, status,
    ));
    await bridge.sync();
    expect(engine.getCatalogFxSlotStatus('track', 0, 1)).toMatchObject({
      acknowledged: false, pendingApply: true, outcomeUnknown: true,
      error: expect.stringContaining('does not uniquely confirm'),
    });
  });

  it('reconciles a timed-out Native write when the exact next applied slot revision is reported', async () => {
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    engine.setTrackFxType(1, 0, 'DSP LPF');
    engine.setTrackFxActive(1, 0, true);
    const status = bridge.status();
    Object.assign(status.nativeFx!.perTrackCatalogBanks![0]!.slots[0]!, {
      effectId: 'filter.lpf', bypassed: false, appliedBypassed: false, prepared: true,
      requestedRevision: 1, appliedRevision: 1,
    });
    bridge.setCatalogSlot.mockRejectedValueOnce(new NativeBridgeRequestTimeoutError(
      '/v1/native-fx/catalog-slot', 'POST', 5000, status,
    ));
    await bridge.sync();
    expect(engine.getCatalogFxSlotStatus('track', 0, 1)).toMatchObject({
      acknowledged: true, pendingApply: false, outcomeUnknown: false,
      requestedRevision: 1, appliedRevision: 1,
    });
  });

  it('never lets an older in-flight response acknowledge newer desired parameters', async () => {
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    engine.setTrackFxType(1, 0, 'DSP LPF');
    engine.setTrackFxNamedParameters(1, 0, { cutoff_hz: 1000 });
    const original = bridge.setCatalogSlot.getMockImplementation()!;
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    bridge.setCatalogSlot.mockImplementation(async (config) => {
      if (config.trackId === 1 && config.slot === 'A') {
        markStarted();
        await gate;
      }
      return original(config);
    });
    const syncing = bridge.sync();
    await started;
    bridge.internals.bridgeAvailable = false;
    engine.setTrackFxNamedParameters(1, 0, { cutoff_hz: 3000 });
    release();
    await syncing;
    expect(engine.getCatalogFxSlotStatus('track', 0, 1)).toMatchObject({
      acknowledged: false, pendingApply: false, requestedParameters: { cutoff_hz: 3000 },
      acknowledgedParameters: { cutoff_hz: 1000 },
    });
    await bridge.sync();
    expect(engine.getCatalogFxSlotStatus('track', 0, 1)).toMatchObject({
      acknowledged: true, requestedParameters: { cutoff_hz: 3000 }, acknowledgedParameters: { cutoff_hz: 3000 },
    });
  });

  it('applies bypass and stopped slot removal only to their selected loop and slot', async () => {
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    engine.setTrackFxType(1, 0, 'CHORUS');
    engine.setTrackFxActive(1, 0, true);
    engine.setTrackFxType(2, 0, 'CHORUS');
    engine.setTrackFxActive(2, 0, true);
    await bridge.sync();
    engine.setTrackFxActive(2, 0, false);
    await bridge.sync();
    expect(engine.getCatalogFxSlotStatus('track', 0, 2)).toMatchObject({ acknowledged: true, requestedBypassed: true, appliedBypassed: true });
    expect(engine.getCatalogFxSlotStatus('track', 0, 1)).toMatchObject({ acknowledged: true, appliedBypassed: false });
    engine.setTrackFxType(2, 0, 'NONE');
    await bridge.sync();
    expect(engine.getCatalogFxSlotStatus('track', 0, 2)).toMatchObject({ acknowledged: true, acknowledgedEffectId: null, prepared: false, appliedBypassed: false });
    bridge.internals.bridgeAvailable = true;
    expect(engine.getTrackFxStatus(2)[0]?.slots[0]).toMatchObject({ state: 'empty', type: null });
    expect(bridge.banks[0]!.slots[0]!.effectId).toBe('chorus');
  });

  it('keeps per-slot rejection/restart errors isolated and never falls back to shared routing', async () => {
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    engine.setTrackFxType(2, 0, 'CHORUS');
    engine.setTrackFxType(3, 1, 'DSP LPF');
    await bridge.sync();
    bridge.setRunning(true);
    engine.setTrackFxType(2, 0, 'PREAMP');
    const original = bridge.setCatalogSlot.getMockImplementation()!;
    bridge.setCatalogSlot.mockImplementation(async (config) => {
      if (config.trackId === 3 && config.slot === 'B') throw new Error('Track 3 B: parameter outside range');
      return original(config);
    });
    engine.setTrackFxParameter(3, 1, 72);
    await bridge.sync();
    expect(engine.getCatalogFxSlotStatus('track', 0, 2)).toMatchObject({ acknowledged: false, pendingRestart: true, requestedEffectId: 'preamp', acknowledgedEffectId: 'chorus' });
    expect(engine.getCatalogFxSlotStatus('track', 1, 3)).toMatchObject({ acknowledged: false, pendingRestart: false, error: 'Track 3 B: parameter outside range' });
    expect(engine.getCatalogFxSlotStatus('track', 2, 4).acknowledged).toBe(true);
    expect(bridge.setCatalogSlot.mock.calls.every(([config]) => !!config.trackId)).toBe(true);
    expect(bridge.shared.every((slot) => !slot.effectId)).toBe(true);
  });

  it('rejects invalid IDs, indices, values and unknown selections, and reports old-host unavailability', async () => {
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    for (const id of [0, 6, -1, 1.5, NaN]) {
      expect(engine.setTrackFxType(id, 0, 'CHORUS')).toBe(false);
      expect(engine.getTrackFxStatus(id)).toEqual([]);
    }
    expect(engine.setTrackFxType(1, 4, 'CHORUS')).toBe(false);
    expect(engine.setTrackFxParameter(1, 0, 101)).toBe(false);
    expect(engine.setTrackFxNamedParameters(1, 0, { mix: NaN })).toBe(false);
    expect(engine.setTrackFxActive(1, 0, 1 as unknown as boolean)).toBe(false);
    expect(engine.setTrackFxType(4, 2, 'UNKNOWN')).toBe(false);
    await bridge.sync();
    expect(engine.getCatalogFxSlotStatus('track', 2, 4)).toMatchObject({ acknowledged: false, requestedEffectId: null, error: expect.stringContaining('no implemented effect ID') });
    const oldStatus = bridge.status();
    delete oldStatus.nativeFx!.perTrackCatalogAvailable;
    delete oldStatus.nativeFx!.perTrackCatalogBanks;
    bridge.internals.applyStatus(oldStatus);
    bridge.internals.bridgeAvailable = false;
    engine.setTrackFxType(5, 3, 'CHORUS');
    await bridge.sync();
    expect(engine.getCatalogFxSlotStatus('track', 3, 5)).toMatchObject({ acknowledged: false, error: expect.stringContaining('per-track catalog FX is unavailable') });
  });

  it('surfaces callback control rejection rather than waiting forever and excludes pre-insert transports', async () => {
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    engine.setTrackFxType(1, 0, 'DSP LPF');
    await bridge.sync();
    bridge.setRunning(true);
    bridge.setAutoApply(false);
    engine.setTrackFxParameter(1, 0, 70);
    await bridge.sync();
    bridge.banks[0]!.slots[0]!.controlFaulted = true;
    bridge.internals.applyStatus(bridge.status());
    expect(engine.getCatalogFxSlotStatus('track', 0, 1)).toMatchObject({
      acknowledged: false, pendingApply: false, controlFaulted: true, error: expect.stringContaining('control application failed'),
    });
    expect(bridge.setCatalogSlot.mock.calls.filter(([config]) => config.effectId === '')).toHaveLength(0);
    const extended = bridge.status();
    extended.nativeFx!.implementedCatalogEffects!.push('vinyl_flick');
    extended.nativeFx!.catalogEffectAvailability!.push({ effectId: 'vinyl_flick', input: false, track: true, perTrackInsert: false });
    bridge.internals.applyStatus(extended);
    expect(engine.getCatalogFxOptions('track')).toContain('VINYL FLICK (EXPERIMENTAL)');
    expect(engine.getCatalogFxOptions('track', 1)).not.toContain('VINYL FLICK (EXPERIMENTAL)');
    bridge.internals.bridgeAvailable = false;
    expect(engine.setTrackFxType(1, 2, 'VINYL FLICK (EXPERIMENTAL)')).toBe(false);
  });

  it('requires the exact bank/slot/revision ACK and exposes target-aware MIDI routing', async () => {
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    engine.setTrackFxType(5, 3, 'OSC VOC (M)');
    await bridge.sync();
    const event: NativeCatalogMidiEvent = { trackId: 5, path: 'track', slot: 'D', effectId: 'osc_voc_m', type: 'noteOn', note: 64, velocity: 100, channel: 2, frame: 48000 };
    await engine.queueCatalogMidiEvent(event);
    expect(bridge.queueCatalogMidiEvent).toHaveBeenCalledWith(event);
    bridge.banks[4]!.midiSlots.push({ slot: 'D', effectId: 'osc_voc_m', selected: true, queueCapacity: 128, queuedEvents: 1,
      currentFrame: 48000, overflowEventCount: 0, lateEventCount: 0, rejectedEventCount: 0 });
    bridge.internals.applyStatus(bridge.status());
    const midi = engine.getCatalogMidiSlotStatus('track', 3, 5)!;
    expect(midi).toMatchObject({ selected: true, effectId: 'osc_voc_m', queuedEvents: 1 });
    midi.queuedEvents = 99;
    expect(engine.getCatalogMidiSlotStatus('track', 3, 5)?.queuedEvents).toBe(1);
    expect(engine.getCatalogMidiSlotStatus('track', 3, 4)).toBeNull();
    bridge.banks[4]!.slots[3]!.requestedRevision += 1;
    bridge.internals.applyStatus(bridge.status());
    expect(engine.getCatalogFxSlotStatus('track', 3, 5)).toMatchObject({ acknowledged: false, error: expect.stringContaining('different per-track slot selection or revision') });
    const original = bridge.setCatalogSlot.getMockImplementation()!;
    bridge.setCatalogSlot.mockImplementation(async (config) => {
      const result = await original(config);
      if (config.trackId === 5 && config.slot === 'D') result.nativeFx!.perTrackCatalogBanks![4]!.slots = [];
      return result;
    });
    await bridge.sync();
    expect(engine.getCatalogFxSlotStatus('track', 3, 5)).toMatchObject({ acknowledged: false, error: expect.stringContaining('no per-track slot application acknowledgement') });
  });

  it('dispatches the facade methods to the active runtime and preserves legacy setFxType target zero', () => {
    const facade = AudioEngine.getInstance();
    const engine = NativeAudioEngine.getInstance();
    const bridge = install(engine);
    facade.setMode('native');
    expect(facade.setTrackFxType(5, 3, 'CHORUS')).toBe(true);
    expect(facade.setTrackFxParameter(5, 3, 75)).toBe(true);
    expect(facade.setTrackFxNamedParameters(5, 3, { rate_hz: 1.5 })).toBe(true);
    expect(facade.setTrackFxActive(5, 3, true)).toBe(true);
    facade.setFxType('track', 0, 'PREAMP');
    expect(engine.getCatalogFxSlotStates('track', 5)[3]).toMatchObject({ type: 'CHORUS', value: 75, active: true, parameters: { rate_hz: 1.5 } });
    expect(engine.getCatalogFxSlotStates('track')[0]?.type).toBe('PREAMP');
    bridge.internals.bridgeAvailable = true;
    expect(facade.getTrackFxStatus(5)[0]).toMatchObject({ trackId: 5, available: true, perTrackFxChainAvailable: true, legacySharedPostmix: true });
    const browser = { setTrackFxType: vi.fn(() => true), setTrackFxParameter: vi.fn(() => true), setTrackFxNamedParameters: vi.fn(() => true), setTrackFxActive: vi.fn(() => true), getTrackFxStatus: vi.fn(() => []) };
    const facadeInternals = facade as unknown as { currentMode: string; browserEngine: unknown };
    facadeInternals.currentMode = 'browser';
    facadeInternals.browserEngine = browser;
    facade.setTrackFxType(1, 2, 'CHORUS');
    facade.setTrackFxParameter(1, 2, 44);
    facade.setTrackFxNamedParameters(1, 2, { wetMix: 0.5 });
    facade.setTrackFxActive(1, 2, false);
    facade.getTrackFxStatus(1);
    expect(browser.setTrackFxType).toHaveBeenCalledWith(1, 2, 'CHORUS');
    expect(browser.setTrackFxParameter).toHaveBeenCalledWith(1, 2, 44);
    expect(browser.setTrackFxNamedParameters).toHaveBeenCalledWith(1, 2, { wetMix: 0.5 });
    expect(browser.setTrackFxActive).toHaveBeenCalledWith(1, 2, false);
    expect(browser.getTrackFxStatus).toHaveBeenCalledWith(1);
    facadeInternals.currentMode = 'native';
    facadeInternals.browserEngine = null;
    bridge.internals.bridgeAvailable = false;
  });
});
