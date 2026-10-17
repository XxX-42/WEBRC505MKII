import { describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import type { NativeBridgeClient, NativeCatalogSlotConfig, NativeFxSlot, NativeStatus } from '../../src/audio/NativeBridgeClient';

const slots = ['A', 'B', 'C', 'D'] as const;
const effectIds = [
  'filter.lpf', 'filter.bpf', 'filter.hpf', 'phaser', 'flanger', 'dynamics', 'dist', 'reverb',
  'beat_repeat', 'tape_echo', 'fractional_delay', 'panning_delay', 'granular_delay', 'auto_pan', 'chorus', 'tremolo',
  'ring_mod', 'eq', 'stereo_enhance', 'lo_fi', 'radio', 'sustainer', 'vibrato', 'robot',
];

function nativeStatus(
  engineRunning = false,
  catalogSlots: Array<{ slot: NativeFxSlot; effectId: string; bypassed: boolean }> = slots.map((slot) => ({ slot, effectId: '', bypassed: false })),
  inputCatalogSlots: Array<{ slot: NativeFxSlot; effectId: string; bypassed: boolean }> = slots.map((slot) => ({ slot, effectId: '', bypassed: false })),
): NativeStatus {
  return {
    ok: true,
    bridgeHealthy: true,
    engineRunning,
    backend: 'WASAPI',
    inputDeviceId: 'in',
    outputDeviceId: 'out',
    inputDeviceName: 'Input',
    outputDeviceName: 'Output',
    sampleRate: 48000,
    bufferFrames: 64,
    monitoringEnabled: false,
    state: 'Empty',
    inputLatencyMs: 0,
    outputLatencyMs: 0,
    roundTripEstimateMs: 0,
    inputPeak: 0,
    outputPeak: 0,
    xrunsOrDropouts: 0,
    lastError: '',
    loopProgress: 0,
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: effectIds,
      catalogEffectAvailability: effectIds.map((effectId) => ({ effectId, input: effectId !== 'beat_repeat', track: true })),
      catalogSlots,
      inputCatalogSlots,
    },
  };
}

function installBridge(engine: NativeAudioEngine, startCalls?: string[]) {
  const byPath: Record<'input' | 'track', Array<{ slot: NativeFxSlot; effectId: string; bypassed: boolean }>> = {
    input: slots.map((slot) => ({ slot, effectId: '', bypassed: false })),
    track: slots.map((slot) => ({ slot, effectId: '', bypassed: false })),
  };
  const status = (running = false) => nativeStatus(running, byPath.track, byPath.input);
  const fakeBridge = {
    health: vi.fn(async () => ({ ok: true, version: 'test', engineRunning: false, backends: ['WASAPI'], lastError: '' })),
    getDevices: vi.fn(async () => ({
      ok: true, backends: ['WASAPI'],
      inputsByBackend: { WASAPI: [{ id: 'in', name: 'Input', sampleRates: [48000], isDefault: true }] },
      outputsByBackend: { WASAPI: [{ id: 'out', name: 'Output', sampleRates: [48000], isDefault: true }] },
      defaultInputIdByBackend: { WASAPI: 'in' }, defaultOutputIdByBackend: { WASAPI: 'out' }, bufferOptions: [64],
    })),
    applyConfig: vi.fn(async () => { startCalls?.push('applyConfig'); return status(false); }),
    startEngine: vi.fn(async () => { startCalls?.push('startEngine'); return status(true); }),
    getStatus: vi.fn(async () => status(true)),
    setCatalogSlot: vi.fn(async (config: NativeCatalogSlotConfig) => {
      startCalls?.push(`set:${config.path}:${config.slot}:${config.effectId}`);
      const path = config.path ?? 'track';
      const item = byPath[path].find((entry) => entry.slot === config.slot)!;
      item.effectId = config.effectId;
      item.bypassed = config.bypassed;
      return status(false);
    }),
  };
  const internals = engine as unknown as {
    bridge: NativeBridgeClient; bridgeAvailable: boolean; engineRunning: boolean; latestStatus: NativeStatus | null;
    nativeCatalogFxStates: Record<'input' | 'track', Array<{ type: string; value: number; active: boolean }>>;
  };
  internals.bridge = fakeBridge as unknown as NativeBridgeClient;
  internals.bridgeAvailable = true;
  internals.engineRunning = false;
  internals.latestStatus = status(false);
  for (const path of ['input', 'track'] as const) {
    internals.nativeCatalogFxStates[path].forEach((state) => Object.assign(state, { type: '', value: 0, active: false }));
  }
  return { fakeBridge, byPath };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Native catalog FX runtime and UI adapter', () => {
  it('routes Input and Track A–D selections, maps parameters, and records each API acknowledgement', async () => {
    const engine = NativeAudioEngine.getInstance();
    const { fakeBridge, byPath } = installBridge(engine);
    const types = ['DSP LPF', 'DSP BPF', 'DSP HPF', 'PANNING DELAY'];
    expect(engine.getCatalogFxOptions('input')).toContain('DSP LPF');
    expect(engine.getCatalogFxOptions('input')).not.toContain('BEAT REPEAT');
    expect(engine.getCatalogFxOptions('track')).toContain('BEAT REPEAT');

    for (let index = 0; index < 4; index += 1) {
      engine.setFxType('input', index, types[index]!);
      engine.setFxParam('input', index, 50 + index);
      engine.setFxActive('input', index, true);
      engine.setFxType('track', index, types[3 - index]!);
      engine.setFxParam('track', index, 25 + index);
      engine.setFxActive('track', index, index !== 2);
    }
    await settle();

    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledTimes(8);
    expect(byPath.input.map((slot) => slot.effectId)).toEqual(['filter.lpf', 'filter.bpf', 'filter.hpf', 'panning_delay']);
    expect(byPath.track.map((slot) => slot.effectId)).toEqual(['panning_delay', 'filter.hpf', 'filter.bpf', 'filter.lpf']);
    expect(fakeBridge.setCatalogSlot.mock.calls.map(([config]) => config.path)).toEqual([
      'input', 'input', 'input', 'input', 'track', 'track', 'track', 'track',
    ]);

    const inputPanning = fakeBridge.setCatalogSlot.mock.calls.find(([config]) => config.path === 'input' && config.slot === 'D')?.[0];
    expect(inputPanning?.parameters).toMatchObject({ time_ms: 1 + 1999 * 0.53, mix_percent: 53 });
    expect(engine.getCatalogFxSlotStatus('input', 3)).toMatchObject({
      requestedEffectId: 'panning_delay',
      acknowledgedEffectId: 'panning_delay',
      acknowledged: true,
      pendingRestart: false,
      acknowledgedParameters: { time_ms: 1 + 1999 * 0.53, feedback_percent: 30, pan_percent: 70, mix_percent: 53 },
    });
    expect(engine.getCatalogFxSlotStatus('track', 2)).toMatchObject({
      requestedEffectId: 'filter.bpf', acknowledgedEffectId: 'filter.bpf', acknowledged: true,
      acknowledgedParameters: { cutoff_hz: 20 * (1000 ** 0.27) },
    });
  });

  it('exposes GRANULAR DELAY on both Native paths and applies the mix macro to a real catalog processor', async () => {
    const engine = NativeAudioEngine.getInstance();
    const { fakeBridge, byPath } = installBridge(engine);
    expect(engine.getCatalogFxOptions('input')).toContain('GRANULAR DELAY');
    expect(engine.getCatalogFxOptions('track')).toContain('GRANULAR DELAY');

    engine.setFxType('input', 0, 'GRANULAR DELAY');
    engine.setFxParam('input', 0, 73);
    engine.setFxActive('input', 0, true);
    engine.setFxType('track', 3, 'GRANULAR DELAY');
    engine.setFxParam('track', 3, 45);
    await settle();

    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledTimes(2);
    expect(byPath.input[0]?.effectId).toBe('granular_delay');
    expect(byPath.track[3]?.effectId).toBe('granular_delay');
    expect(fakeBridge.setCatalogSlot.mock.calls[0]?.[0]).toMatchObject({
      path: 'input', slot: 'A', effectId: 'granular_delay', parameters: { mix_percent: 73 }, bypassed: false,
    });
    expect(engine.getCatalogFxSlotStatus('track', 3)).toMatchObject({
      requestedEffectId: 'granular_delay', acknowledgedEffectId: 'granular_delay', acknowledged: true,
      acknowledgedParameters: { mix_percent: 45 },
    });
  });

  it('exposes RADIO on Input and Track and maps the Native macro to Browser-compatible controls', async () => {
    const engine = NativeAudioEngine.getInstance();
    const { fakeBridge, byPath } = installBridge(engine);
    expect(engine.getCatalogFxOptions('input')).toContain('RADIO');
    expect(engine.getCatalogFxOptions('track')).toContain('RADIO');

    engine.setFxType('input', 0, 'RADIO');
    engine.setFxParam('input', 0, 42);
    engine.setFxActive('input', 0, true);
    engine.setFxType('track', 3, 'RADIO');
    engine.setFxParam('track', 3, 73);
    await settle();

    expect(byPath.input[0]?.effectId).toBe('radio');
    expect(byPath.track[3]?.effectId).toBe('radio');
    expect(fakeBridge.setCatalogSlot.mock.calls[0]?.[0]).toMatchObject({
      path: 'input', slot: 'A', effectId: 'radio', parameters: { drive: 42, mix: 42 }, bypassed: false,
    });
    expect(engine.getCatalogFxSlotStatus('track', 3)).toMatchObject({
      requestedEffectId: 'radio', acknowledgedEffectId: 'radio', acknowledged: true,
      acknowledgedParameters: { drive: 73, mix: 73 },
    });
  });

  it('exposes SUSTAINER independently in Input and Track banks with the catalog control law', async () => {
    const engine = NativeAudioEngine.getInstance();
    const { fakeBridge, byPath } = installBridge(engine);
    expect(engine.getCatalogFxOptions('input')).toContain('SUSTAINER');
    expect(engine.getCatalogFxOptions('track')).toContain('SUSTAINER');

    engine.setFxType('input', 1, 'SUSTAINER');
    engine.setFxParam('input', 1, 25);
    engine.setFxActive('input', 1, true);
    engine.setFxType('track', 2, 'SUSTAINER');
    engine.setFxParam('track', 2, 80);
    await settle();

    expect(byPath.input[1]?.effectId).toBe('sustainer');
    expect(byPath.track[2]?.effectId).toBe('sustainer');
    expect(fakeBridge.setCatalogSlot.mock.calls[0]?.[0]).toMatchObject({
      path: 'input', slot: 'B', effectId: 'sustainer',
      parameters: { threshold_db: -24, ratio: 5.75, release_ms: 180, output_db: 0 }, bypassed: false,
    });
    expect(engine.getCatalogFxSlotStatus('track', 2)).toMatchObject({
      requestedEffectId: 'sustainer', acknowledgedEffectId: 'sustainer', acknowledged: true,
      acknowledgedParameters: { threshold_db: -24, release_ms: 180, output_db: 0 },
    });
    expect(engine.getCatalogFxSlotStatus('track', 2).acknowledgedParameters.ratio).toBeCloseTo(16.2, 12);
  });

  it('exposes VIBRATO independently in Input and Track banks with the modulated-delay macro', async () => {
    const engine = NativeAudioEngine.getInstance();
    const { fakeBridge, byPath } = installBridge(engine);
    expect(engine.getCatalogFxOptions('input')).toContain('VIBRATO');
    expect(engine.getCatalogFxOptions('track')).toContain('VIBRATO');

    engine.setFxType('input', 0, 'VIBRATO');
    engine.setFxParam('input', 0, 35);
    engine.setFxActive('input', 0, true);
    engine.setFxType('track', 3, 'VIBRATO');
    engine.setFxParam('track', 3, 70);
    await settle();

    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledTimes(2);
    expect(byPath.input[0]?.effectId).toBe('vibrato');
    expect(byPath.track[3]?.effectId).toBe('vibrato');
    expect(fakeBridge.setCatalogSlot.mock.calls[0]?.[0]).toMatchObject({
      path: 'input', slot: 'A', effectId: 'vibrato',
      parameters: { depth: 35, mix_percent: 35 }, bypassed: false,
    });
    expect(fakeBridge.setCatalogSlot.mock.calls[0]?.[0].parameters.delay_ms).toBeCloseTo(3.63, 12);
    expect(fakeBridge.setCatalogSlot.mock.calls[0]?.[0].parameters.rate_hz).toBeCloseTo(0.05 * (400 ** 0.35), 12);
    expect(engine.getCatalogFxSlotStatus('track', 3)).toMatchObject({
      requestedEffectId: 'vibrato', acknowledgedEffectId: 'vibrato', acknowledged: true,
      acknowledgedParameters: { depth: 70, mix_percent: 70 },
    });
    expect(engine.getCatalogFxSlotStatus('track', 3).acknowledgedParameters.delay_ms).toBeCloseTo(7.06, 12);
    expect(engine.getCatalogFxSlotStatus('track', 3).acknowledgedParameters.rate_hz).toBeCloseTo(0.05 * (400 ** 0.7), 12);
  });

  it('acknowledges Native ROBOT pitch, formant and mix controls on Input and Track routes', async () => {
    const engine = NativeAudioEngine.getInstance();
    const { fakeBridge, byPath } = installBridge(engine);
    expect(engine.getCatalogFxOptions('input')).toContain('ROBOT (EXPERIMENTAL)');
    expect(engine.getCatalogFxOptions('track')).toContain('ROBOT (EXPERIMENTAL)');

    const parameters = { pitch_semitones: -7.5, formant_semitones: 4.5, mix_percent: 58 };
    engine.setFxType('input', 0, 'ROBOT (EXPERIMENTAL)');
    engine.setCatalogFxParameters('input', 0, parameters);
    engine.setFxActive('input', 0, true);
    engine.setFxType('track', 3, 'ROBOT (EXPERIMENTAL)');
    engine.setCatalogFxParameters('track', 3, parameters);
    engine.setFxActive('track', 3, true);
    await settle();

    expect(byPath.input[0]?.effectId).toBe('robot');
    expect(byPath.track[3]?.effectId).toBe('robot');
    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledWith(expect.objectContaining({
      path: 'input', slot: 'A', effectId: 'robot', parameters, bypassed: false,
    }));
    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledWith(expect.objectContaining({
      path: 'track', slot: 'D', effectId: 'robot', parameters, bypassed: false,
    }));
    expect(engine.getCatalogFxSlotStatus('input', 0)).toMatchObject({
      requestedEffectId: 'robot', acknowledgedEffectId: 'robot', acknowledged: true,
      acknowledgedParameters: parameters,
    });
    expect(engine.getCatalogFxSlotStatus('track', 3)).toMatchObject({
      requestedEffectId: 'robot', acknowledgedEffectId: 'robot', acknowledged: true,
      acknowledgedParameters: parameters,
    });
  });

  it('does not claim live type replacement; retains the selected setting for restart and exposes the rejection state', async () => {
    const engine = NativeAudioEngine.getInstance();
    const previous = nativeStatus(true, slots.map((slot, index) => ({ slot, effectId: index === 0 ? 'fractional_delay' : '', bypassed: false })));
    const fakeBridge = { setCatalogSlot: vi.fn(async () => previous) };
    const internals = engine as unknown as {
      bridge: NativeBridgeClient; bridgeAvailable: boolean; engineRunning: boolean; latestStatus: NativeStatus;
    };
    internals.bridge = fakeBridge as unknown as NativeBridgeClient;
    internals.bridgeAvailable = true;
    internals.engineRunning = true;
    internals.latestStatus = previous;

    engine.setFxType('track', 0, 'CHORUS');
    engine.setFxParam('track', 0, 60);
    engine.setFxActive('track', 0, true);
    await settle();

    expect(fakeBridge.setCatalogSlot).not.toHaveBeenCalled();
    expect(engine.getCatalogFxSlotStatus('track', 0)).toMatchObject({
      requestedEffectId: 'chorus', acknowledgedEffectId: 'fractional_delay',
      acknowledged: false, pendingRestart: true,
    });
  });

  it('keeps an unsupported path selection visible and bypasses the previously active Native effect', async () => {
    const engine = NativeAudioEngine.getInstance();
    const { fakeBridge, byPath } = installBridge(engine);
    byPath.input[0]!.effectId = 'phaser';
    const internals = engine as unknown as { engineRunning: boolean; latestStatus: NativeStatus };
    internals.engineRunning = true;
    internals.latestStatus = nativeStatus(true, byPath.track, byPath.input);

    engine.setFxType('input', 0, 'BEAT REPEAT');
    await settle();

    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledWith({
      path: 'input', slot: 'A', effectId: 'phaser', parameters: {}, bypassed: true,
    });
    expect(engine.getCatalogFxSlotStatus('input', 0)).toMatchObject({
      requestedEffectId: 'beat_repeat', acknowledgedEffectId: 'phaser',
      acknowledged: false, pendingRestart: true,
    });
    expect(engine.getCatalogFxSlotStatus('input', 0).error).toContain('does not support BEAT REPEAT');
  });

  it('applies the desired eight slots after config and before starting Native audio', async () => {
    const engine = NativeAudioEngine.getInstance();
    const order: string[] = [];
    const { fakeBridge } = installBridge(engine, order);
    const internals = engine as unknown as { applyAndStart: () => Promise<void> };

    await internals.applyAndStart();

    expect(order[0]).toBe('applyConfig');
    expect(order.slice(1, 9)).toHaveLength(8);
    expect(order[9]).toBe('startEngine');
    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledTimes(8);
  });
});
