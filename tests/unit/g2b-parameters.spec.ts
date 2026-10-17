import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { createDefaultG2bParameters, sanitizeG2bParameters, toCatalogG2bParameters } from '../../src/audio/g2bParameters';
import { nativeCatalogEffectId, nativeCatalogFxOptions, nativeCatalogMacroParameters, nativeCatalogSlotConfig } from '../../src/audio/nativeFxCatalog';
import type { NativeStatus } from '../../src/audio/NativeBridgeClient';
import G2bFxEditor from '../../src/components/fx/G2bFxEditor.vue';

describe('clean-room G2B controls', () => {
  it('defines the bounded shared control range and Native-compatible keys', () => {
    expect(createDefaultG2bParameters()).toEqual({ tracking: 65, blend: 65, body: 180 });
    expect(sanitizeG2bParameters({ tracking: 140, blend: -4, body: 20 })).toEqual({ tracking: 100, blend: 0, body: 60 });
    expect(sanitizeG2bParameters({ tracking: Number.NaN, blend: Infinity, body: 3000 })).toEqual({ tracking: 65, blend: 65, body: 1200 });
    expect(toCatalogG2bParameters({ tracking: 41, blend: 72, body: 240 })).toEqual({ tracking_percent: 41, blend_percent: 72, body_hz: 240 });
    expect(nativeCatalogEffectId('G2B')).toBe('g2b');
    expect(nativeCatalogMacroParameters('G2B', 42)).toEqual({ tracking_percent: 65, blend_percent: 42, body_hz: 180 });
    expect(nativeCatalogSlotConfig('input', 0, { type: 'G2B', value: 42, active: true })).toMatchObject({
      path: 'input', slot: 'A', effectId: 'g2b',
      parameters: { tracking_percent: 65, blend_percent: 42, body_hz: 180 },
      bypassed: false,
    });
    const nativeStatus = {
      nativeFx: {
        catalogGraphAvailable: true,
        implementedCatalogEffects: ['g2b'],
        catalogEffectAvailability: [{ effectId: 'g2b', input: true, track: true }],
      },
    } as unknown as NativeStatus;
    expect(nativeCatalogFxOptions(nativeStatus, 'input')).toContain('G2B');
    expect(nativeCatalogFxOptions(nativeStatus, 'track')).toContain('G2B');
  });

  it('routes the canonical named controls to Native and Browser catalog banks', () => {
    const native = { setCatalogFxParameters: vi.fn() };
    const browser = { setFxNamedParameters: vi.fn() };
    const engine = Object.create(AudioEngine.prototype) as AudioEngine;
    Object.assign(engine, { currentMode: 'native', nativeEngine: native, browserEngine: browser });
    const parameters = toCatalogG2bParameters({ tracking: 31, blend: 84, body: 420 });
    engine.setCatalogFxParameters('input', 1, parameters);
    expect(native.setCatalogFxParameters).toHaveBeenCalledWith('input', 1, parameters);
    Object.assign(engine, { currentMode: 'browser' });
    engine.setCatalogFxParameters('track', 2, parameters);
    expect(browser.setFxNamedParameters).toHaveBeenCalledWith('track', 2, parameters);
  });

  it('renders accessible tracking, blend, and body controls and emits sanitized values', async () => {
    const wrapper = mount(G2bFxEditor, { props: { modelValue: createDefaultG2bParameters() } });
    expect(wrapper.findAll('input[type="range"]')).toHaveLength(3);
    await wrapper.get('[aria-label="G2B tracking sensitivity"]').setValue('78');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ tracking: 78 });
    await wrapper.get('[aria-label="G2B sub octave blend"]').setValue('42');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ blend: 42 });
    await wrapper.get('[aria-label="G2B body cutoff hertz"]').setValue('50');
    expect((wrapper.emitted('update:modelValue')?.at(-1)?.[0] as { body: number }).body).toBeCloseTo(60 * Math.sqrt(20));
    wrapper.unmount();
  });
});
