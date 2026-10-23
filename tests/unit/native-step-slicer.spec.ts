import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import type { NativeBridgeClient, NativeCatalogSlotConfig, NativeFxSlot, NativeStatus } from '../../src/audio/NativeBridgeClient';
import { nativeCatalogEffectId, nativeCatalogFxOptions, nativeCatalogMacroParameters, nativeCatalogSlotConfig } from '../../src/audio/nativeFxCatalog';
import { createDefaultNativeStepSlicerParameters, sanitizeNativeStepSlicerParameters } from '../../src/audio/nativeStepSlicerParameters';
import NativeStepSlicerEditor from '../../src/components/fx/NativeStepSlicerEditor.vue';
import { Transport } from '../../src/core/Transport';
import { renderedCatalogWrite } from '../helpers/nativeCatalogReadback';

const slots = ['A', 'B', 'C', 'D'] as const;

function statusFor(
  selected: Record<'input' | 'track', Array<{ slot: NativeFxSlot; effectId: string; bypassed: boolean }>>,
): NativeStatus {
  const effectIds = ['step_slicer'];
  return {
    ok: true, bridgeHealthy: true, engineRunning: false, backend: 'WASAPI',
    inputDeviceId: 'in', outputDeviceId: 'out', inputDeviceName: 'Input', outputDeviceName: 'Output',
    sampleRate: 48000, bufferFrames: 64, monitoringEnabled: false, state: 'Empty',
    inputLatencyMs: 0, outputLatencyMs: 0, roundTripEstimateMs: 0, inputPeak: 0, outputPeak: 0,
    xrunsOrDropouts: 0, lastError: '', loopProgress: 0,
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: effectIds,
      catalogEffectAvailability: effectIds.map((effectId) => ({ effectId, input: true, track: true })),
      inputCatalogSlots: selected.input,
      catalogSlots: selected.track,
    },
  };
}

describe('Native STEP SLICER parameters and catalog API', () => {
  it('provides the Native label and a complete flat 16-step default mapping', () => {
    expect(nativeCatalogEffectId('STEP SLICER')).toBe('step_slicer');
    const status = statusFor({
      input: slots.map((slot) => ({ slot, effectId: '', bypassed: false })),
      track: slots.map((slot) => ({ slot, effectId: '', bypassed: false })),
    });
    expect(nativeCatalogFxOptions(status, 'input')).toContain('STEP SLICER');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('STEP SLICER');
    expect(nativeCatalogMacroParameters('STEP SLICER', 100)).toMatchObject({
      step_count: 16, rate_beats: 0.25, depth_percent: 100, pan_depth_percent: 0, filter_hz: 20000,
      step_01: 100, step_08: 100, step_16: 100,
    });
    expect(nativeCatalogSlotConfig('track', 3, { type: 'STEP SLICER', value: 100, active: true })).toMatchObject({
      path: 'track', slot: 'D', effectId: 'step_slicer', bypassed: false,
    });
  });

  it('sanitizes editable sequence fields into supported count, rate, and parameter ranges', () => {
    expect(createDefaultNativeStepSlicerParameters()).toMatchObject({
      step_count: 16, rate_beats: 0.25, depth_percent: 100, pan_depth_percent: 0,
      filter_hz: 20000, step_01: 100, step_16: 100,
    });
    expect(sanitizeNativeStepSlicerParameters({
      step_count: 7, rate_beats: 1.25, depth_percent: 140, pan_depth_percent: -4,
      filter_hz: 50000, step_01: -5, step_16: 101,
    })).toMatchObject({
      step_count: 16, rate_beats: 0.25, depth_percent: 100, pan_depth_percent: 0,
      filter_hz: 20000, step_01: 0, step_16: 100,
    });
  });

  it('sends per-slot sequence overrides through Input A and Track D and exposes acknowledged status', async () => {
    const engine = NativeAudioEngine.getInstance();
    const selected: Record<'input' | 'track', Array<{ slot: NativeFxSlot; effectId: string; bypassed: boolean }>> = {
      input: slots.map((slot) => ({ slot, effectId: '', bypassed: false })),
      track: slots.map((slot) => ({ slot, effectId: '', bypassed: false })),
    };
    const fakeBridge = {
      setCatalogSlot: vi.fn(async (config: NativeCatalogSlotConfig) => {
        selected[config.path][slots.indexOf(config.slot)] = renderedCatalogWrite(config);
        return statusFor(selected);
      }),
    };
    const internals = engine as unknown as {
      bridge: NativeBridgeClient; bridgeAvailable: boolean; engineRunning: boolean; latestStatus: NativeStatus | null;
      nativeCatalogFxStates: Record<'input' | 'track', Array<{ type: string; value: number; active: boolean }>>;
    };
    internals.bridge = fakeBridge as unknown as NativeBridgeClient;
    internals.bridgeAvailable = true;
    internals.engineRunning = false;
    internals.latestStatus = statusFor(selected);
    for (const path of ['input', 'track'] as const) {
      internals.nativeCatalogFxStates[path].forEach((state) => Object.assign(state, { type: '', value: 0, active: false }));
    }
    Transport.getInstance().bpm = 245;

    const custom = sanitizeNativeStepSlicerParameters({
      step_count: 8, rate_beats: 0.5, depth_percent: 83, pan_depth_percent: 70,
      filter_hz: 6200, step_01: 15, step_02: 72, step_16: 31,
    });
    engine.setFxType('input', 0, 'STEP SLICER');
    engine.setFxActive('input', 0, true);
    engine.setCatalogStepSlicerParameters('input', 0, custom);
    engine.setFxType('track', 3, 'STEP SLICER');
    engine.setFxActive('track', 3, true);
    engine.setCatalogStepSlicerParameters('track', 3, custom);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledTimes(2);
    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledWith(expect.objectContaining({
      path: 'input', slot: 'A', effectId: 'step_slicer', bypassed: false,
      parameters: { ...custom, bpm: 245 },
    }));
    expect(fakeBridge.setCatalogSlot).toHaveBeenCalledWith(expect.objectContaining({
      path: 'track', slot: 'D', effectId: 'step_slicer', bypassed: false,
      parameters: { ...custom, bpm: 245 },
    }));
    expect(engine.getCatalogFxSlotStatus('input', 0)).toMatchObject({
      requestedEffectId: 'step_slicer', acknowledgedEffectId: 'step_slicer', acknowledged: true,
      requestedParameters: { ...custom, bpm: 245 }, acknowledgedParameters: { ...custom, bpm: 245 },
    });
  });
});

describe('Native STEP SLICER editor', () => {
  it('emits editable step count, tempo division, and individual step amplitudes', async () => {
    const wrapper = mount(NativeStepSlicerEditor, { props: { modelValue: createDefaultNativeStepSlicerParameters() } });
    await wrapper.get('[aria-label="Step count"]').setValue('8');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ step_count: 8 });
    await wrapper.get('[aria-label="STEP 01 amplitude percent"]').setValue('23');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ step_01: 23 });
    expect(wrapper.find('[data-native-step-slicer-editor]').exists()).toBe(true);
    wrapper.unmount();
  });
});
