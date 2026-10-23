import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import type { NativeBridgeClient, NativeCatalogSlotConfig, NativeFxSlot, NativeStatus } from '../../src/audio/NativeBridgeClient';
import {
  createDefaultPreampParameters,
  sanitizePreampParameters,
  toBrowserPreampParameters,
  toNativePreampParameters,
} from '../../src/audio/preampParameters';
import { nativeCatalogSlotConfig } from '../../src/audio/nativeFxCatalog';
import PreampFxEditor from '../../src/components/fx/PreampFxEditor.vue';
import { renderedCatalogWrite } from '../helpers/nativeCatalogReadback';

describe('PREAMP controls', () => {
  it('provides bounded six-control defaults and safe values for persisted settings', () => {
    expect(createDefaultPreampParameters()).toEqual({
      model: 0, gainPercent: 35, bassDb: 0, middleDb: 0, trebleDb: 0, levelDb: 0,
    });
    expect(sanitizePreampParameters({
      model: 3.7, gainPercent: 105, bassDb: -30, middleDb: Number.NaN,
      trebleDb: 6.5, levelDb: 30,
    })).toEqual({
      model: 4, gainPercent: 100, bassDb: -12, middleDb: 0, trebleDb: 6.5, levelDb: 12,
    });
    expect(toBrowserPreampParameters(createDefaultPreampParameters())).toEqual({
      model: 0, gain: 35, bass: 0, middle: 0, treble: 0, level: 0,
    });
    expect(toNativePreampParameters(createDefaultPreampParameters())).toEqual({
      model: 0, gain: 35, bass: 0, middle: 0, treble: 0, level: 0,
    });
  });

  it('adapts the same canonical controls to each runtime parameter interface', () => {
    const native = { setCatalogFxParameters: vi.fn() };
    const browser = { setFxNamedParameters: vi.fn() };
    const engine = Object.create(AudioEngine.prototype) as AudioEngine;
    Object.assign(engine, { currentMode: 'native', nativeEngine: native, browserEngine: browser });
    const parameters = { model: 3, gainPercent: 72, bassDb: 4.5, middleDb: -2, trebleDb: 6, levelDb: -3 };

    engine.setPreampParameters('input', 2, parameters);
    expect(native.setCatalogFxParameters).toHaveBeenCalledWith('input', 2, {
      model: 3, gain: 72, bass: 4.5, middle: -2, treble: 6, level: -3,
    });
    Object.assign(engine, { currentMode: 'browser' });
    engine.setPreampParameters('track', 1, parameters);
    expect(browser.setFxNamedParameters).toHaveBeenCalledWith('track', 1, {
      model: 3, gain: 72, bass: 4.5, middle: -2, treble: 6, level: -3,
    });
  });

  it('exposes accessible model, gain, tone-stack and level controls and emits changed values', async () => {
    const wrapper = mount(PreampFxEditor, { props: { modelValue: createDefaultPreampParameters() } });
    expect(wrapper.findAll('input[type="range"]')).toHaveLength(5);
    await wrapper.get('[aria-label="Preamp model"]').setValue('3');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ model: 3 });
    await wrapper.get('[aria-label="Preamp gain percent"]').setValue('72');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ gainPercent: 72 });
    await wrapper.get('[aria-label="Preamp bass in decibels"]').setValue('-4.5');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ bassDb: -4.5 });
    await wrapper.get('[aria-label="Preamp middle in decibels"]').setValue('3.5');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ middleDb: 3.5 });
    await wrapper.get('[aria-label="Preamp treble in decibels"]').setValue('6');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ trebleDb: 6 });
    await wrapper.get('[aria-label="Preamp level in decibels"]').setValue('-3');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ levelDb: -3 });
    wrapper.unmount();
  });

  it('merges named per-slot values over Native macro defaults without changing route or bypass', () => {
    expect(nativeCatalogSlotConfig('track', 2, {
      type: 'PREAMP', value: 35, active: true,
      parameters: { model: 2, gain: 72, bass: 4, middle: -3, treble: 5, level: -2 },
    })).toEqual({
      path: 'track', slot: 'C', effectId: 'preamp',
      parameters: { model: 2, gain: 72, bass: 4, middle: -3, treble: 5, level: -2 },
      bypassed: false,
    });
  });

  it('sends six named controls independently to Native Input A and Track C with ACK status', async () => {
    const slots = ['A', 'B', 'C', 'D'] as const;
    const selected: Record<'input' | 'track', Array<{ slot: NativeFxSlot; effectId: string; bypassed: boolean }>> = {
      input: slots.map((slot) => ({ slot, effectId: '', bypassed: false })),
      track: slots.map((slot) => ({ slot, effectId: '', bypassed: false })),
    };
    const status = (): NativeStatus => ({
      ok: true, bridgeHealthy: true, engineRunning: false, backend: 'WASAPI',
      inputDeviceId: 'in', outputDeviceId: 'out', inputDeviceName: 'Input', outputDeviceName: 'Output',
      sampleRate: 48000, bufferFrames: 64, monitoringEnabled: false, state: 'Empty',
      inputLatencyMs: 0, outputLatencyMs: 0, roundTripEstimateMs: 0, inputPeak: 0, outputPeak: 0,
      xrunsOrDropouts: 0, lastError: '', loopProgress: 0,
      nativeFx: {
        catalogGraphAvailable: true,
        implementedCatalogEffects: ['preamp'],
        catalogEffectAvailability: [{ effectId: 'preamp', input: true, track: true }],
        inputCatalogSlots: selected.input,
        catalogSlots: selected.track,
      },
    });
    const engine = NativeAudioEngine.getInstance();
    const fakeBridge = {
      setCatalogSlot: vi.fn(async (config: NativeCatalogSlotConfig) => {
        const path = config.path ?? 'track';
        selected[path][slots.indexOf(config.slot)] = renderedCatalogWrite(config);
        return status();
      }),
    };
    const internals = engine as unknown as {
      bridge: NativeBridgeClient;
      bridgeAvailable: boolean;
      engineRunning: boolean;
      nativeFxSyncRunning: boolean;
      nativeFxSyncScheduled: boolean;
      nativeFxSyncRevision: number;
      nativeCatalogFxRuntime: Map<string, unknown>;
      latestStatus: NativeStatus | null;
      nativeCatalogFxStates: Record<'input' | 'track', Array<{ type: string; value: number; active: boolean; parameters?: Record<string, number> }>>;
    };
    internals.bridge = fakeBridge as unknown as NativeBridgeClient;
    internals.bridgeAvailable = true;
    internals.engineRunning = false;
    internals.nativeFxSyncRunning = false;
    internals.nativeFxSyncScheduled = false;
    internals.nativeFxSyncRevision = 0;
    internals.nativeCatalogFxRuntime.clear();
    internals.latestStatus = status();
    expect(engine.getCatalogFxOptions('input')).toContain('PREAMP');
    expect(engine.getCatalogFxOptions('track')).toContain('PREAMP');
    const inputParameters = { model: 2, gain: 72, bass: 3, middle: -4, treble: 6, level: -2 };
    const trackParameters = { model: 4, gain: 48, bass: -6, middle: 2, treble: 4, level: 1 };
    engine.setFxType('input', 0, 'PREAMP');
    engine.setFxParam('input', 0, 72);
    engine.setFxActive('input', 0, true);
    engine.setCatalogFxParameters('input', 0, inputParameters);
    engine.setFxType('track', 2, 'PREAMP');
    engine.setFxParam('track', 2, 48);
    engine.setFxActive('track', 2, true);
    engine.setCatalogFxParameters('track', 2, trackParameters);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledTimes(2);
    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledWith(expect.objectContaining({
      path: 'input', slot: 'A', effectId: 'preamp', bypassed: false, parameters: inputParameters,
    }));
    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledWith(expect.objectContaining({
      path: 'track', slot: 'C', effectId: 'preamp', bypassed: false, parameters: trackParameters,
    }));
    expect(engine.getCatalogFxSlotStatus('input', 0)).toMatchObject({
      requestedEffectId: 'preamp', acknowledgedEffectId: 'preamp', acknowledged: true,
      requestedParameters: inputParameters, acknowledgedParameters: inputParameters,
    });
    for (const path of ['input', 'track'] as const) {
      internals.nativeCatalogFxStates[path].forEach((state) => Object.assign(state, { type: '', value: 0, active: false, parameters: {} }));
      selected[path].forEach((slot) => Object.assign(slot, { effectId: '', bypassed: false }));
    }
    internals.latestStatus = status();
    internals.bridgeAvailable = false;
  });
});
