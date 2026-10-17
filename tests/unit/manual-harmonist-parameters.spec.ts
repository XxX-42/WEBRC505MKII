import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ManualHarmonistFxEditor from '../../src/components/fx/ManualHarmonistFxEditor.vue';
import {
  createDefaultManualHarmonistParameters,
  sanitizeManualHarmonistParameters,
  toCatalogManualHarmonistParameters,
} from '../../src/audio/manualHarmonistParameters';

describe('HRM MANUAL controls', () => {
  it('sanitizes two intervals, a shared pan, and additive harmony mix', () => {
    expect(createDefaultManualHarmonistParameters()).toEqual({
      voice1Interval: 7, voice2Interval: 12, panPercent: 0, mixPercent: 70,
    });
    expect(sanitizeManualHarmonistParameters({
      voice1Interval: -30, voice2Interval: Number.NaN, panPercent: 120, mixPercent: -5,
    })).toEqual({
      voice1Interval: -24, voice2Interval: 12, panPercent: 100, mixPercent: 0,
    });
    expect(toCatalogManualHarmonistParameters({
      voice1Interval: -5, voice2Interval: 12, panPercent: -30, mixPercent: 65,
    })).toEqual({
      voice_1_interval: -5, voice_2_interval: 12, pan_percent: -30, mix_percent: 65,
    });
  });

  it('exposes both interval controls and explicitly labels unsupported formant preservation', async () => {
    const wrapper = mount(ManualHarmonistFxEditor, {
      props: { modelValue: createDefaultManualHarmonistParameters() },
    });
    expect(wrapper.get('[aria-label="Harmony voice 1 interval in semitones"]').element.getAttribute('min')).toBe('-24');
    expect(wrapper.get('[aria-label="Harmony voice 2 interval in semitones"]').element.getAttribute('max')).toBe('24');
    expect(wrapper.get('[aria-label="Harmony pan percent"]').element.getAttribute('min')).toBe('-100');
    expect(wrapper.text()).toContain('Formant preservation is unsupported');
    await wrapper.get('[aria-label="Harmony voice 1 interval in semitones"]').setValue(-12);
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ voice1Interval: -12 });
    wrapper.unmount();
  });
});
