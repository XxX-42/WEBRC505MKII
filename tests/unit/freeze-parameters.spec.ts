import { describe, expect, it } from 'vitest';
import {
  createDefaultFreezeParameters,
  sanitizeFreezeParameters,
  toCatalogFreezeParameters,
} from '../../src/audio/freezeParameters';
import FreezeFxEditor from '../../src/components/fx/FreezeFxEditor.vue';
import { mount } from '@vue/test-utils';

describe('FREEZE micro-loop parameters', () => {
  it('defaults to an unheld 250 ms micro-loop and neutral pitch', () => {
    expect(createDefaultFreezeParameters()).toEqual({ captureLengthMs: 250, pitchSemitones: 0, frozen: false });
  });

  it('bounds capture duration and pitch and rejects non-finite values', () => {
    expect(sanitizeFreezeParameters({ captureLengthMs: 5000, pitchSemitones: -80, frozen: true }))
      .toEqual({ captureLengthMs: 2000, pitchSemitones: -24, frozen: true });
    expect(sanitizeFreezeParameters({ captureLengthMs: Number.NaN, pitchSemitones: Number.POSITIVE_INFINITY, frozen: 1 }))
      .toEqual({ captureLengthMs: 250, pitchSemitones: 0, frozen: false });
  });

  it('converts boolean capture state to explicit catalog controls', () => {
    expect(toCatalogFreezeParameters({ captureLengthMs: 400, pitchSemitones: 7, frozen: true }))
      .toEqual({ capture_ms: 400, mode: 0, pitch_semitones: 7, freeze: 1 });
  });

  it('exposes only the supported micro-loop controls and emits capture/release events', async () => {
    const wrapper = mount(FreezeFxEditor, { props: { modelValue: createDefaultFreezeParameters() } });
    expect(wrapper.text()).toContain('Spectral freeze is unavailable');
    await wrapper.get('[aria-label="FREEZE capture length milliseconds"]').setValue('420');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ captureLengthMs: 420, frozen: false });
    await wrapper.get('[aria-label="FREEZE pitch semitones"]').setValue('-9');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ pitchSemitones: -9 });
    await wrapper.get('[aria-label="Capture or release FREEZE loop"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ frozen: true });
    wrapper.unmount();
  });
});
