import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PitchBendFxEditor from '../../src/components/fx/PitchBendFxEditor.vue';
import {
  createDefaultPitchBendParameters,
  sanitizePitchBendParameters,
  toCatalogPitchBendParameters,
} from '../../src/audio/pitchBendParameters';

describe('PITCH BEND controls', () => {
  it('sanitizes the bounded semitone, duration, direction, and mix contract', () => {
    expect(createDefaultPitchBendParameters()).toEqual({
      rangeSemitones: 12, timeMs: 500, direction: 0, mixPercent: 100,
    });
    expect(sanitizePitchBendParameters({ rangeSemitones: 30, timeMs: 5, direction: 8, mixPercent: -1 })).toEqual({
      rangeSemitones: 24, timeMs: 20, direction: 0, mixPercent: 0,
    });
    expect(toCatalogPitchBendParameters({ rangeSemitones: 6, timeMs: 1200, direction: 1, mixPercent: 75 })).toEqual({
      range: 6, time_ms: 1200, direction: 1, mix_percent: 75,
    });
  });

  it('exposes logarithmic duration, direction, range, and mix in the editor', async () => {
    const wrapper = mount(PitchBendFxEditor, { props: { modelValue: createDefaultPitchBendParameters() } });
    expect(wrapper.get('[aria-label="Pitch bend range in semitones"]').element.getAttribute('min')).toBe('0');
    expect(wrapper.get('[aria-label="Pitch bend range in semitones"]').element.getAttribute('max')).toBe('24');
    expect((wrapper.get('[aria-label="Pitch bend direction"]').element as HTMLSelectElement).value).toBe('0');
    expect(wrapper.text()).toContain('500 MS');

    await wrapper.get('[aria-label="Pitch bend direction"]').setValue('1');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ direction: 1 });
    await wrapper.get('[aria-label="Pitch bend time in milliseconds"]').setValue('100');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ timeMs: 4000 });
    wrapper.unmount();
  });
});
