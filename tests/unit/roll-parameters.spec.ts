import { describe, expect, it } from 'vitest';
import { createDefaultRollParameters, sanitizeRollParameters, toCatalogRollParameters } from '../../src/audio/rollParameters';
import RollFxEditor from '../../src/components/fx/RollFxEditor.vue';
import { mount } from '@vue/test-utils';

describe('clean-room ROLL controls', () => {
  it('sanitizes bounded stepped parameters and maps them to the catalog processor contract', () => {
    expect(createDefaultRollParameters()).toEqual({ sliceBeats: 0.5, decayPercent: 20, pitchSemitones: 0, direction: 0 });
    expect(sanitizeRollParameters({ sliceBeats: 3, decayPercent: 110, pitchSemitones: -40, direction: 9 })).toEqual({
      sliceBeats: 2, decayPercent: 100, pitchSemitones: -24, direction: 0,
    });
    expect(sanitizeRollParameters({ sliceBeats: Number.NaN, decayPercent: Infinity, pitchSemitones: Number.NaN, direction: 2 })).toEqual({
      sliceBeats: 0.5, decayPercent: 20, pitchSemitones: 0, direction: 2,
    });
    expect(toCatalogRollParameters({ sliceBeats: 1, decayPercent: 42, pitchSemitones: -12, direction: 1 })).toEqual({
      slice_beats: 1, decay_percent: 42, pitch_semitones: -12, direction: 1,
    });
  });

  it('renders accessible controls and emits the selected clean-room values', async () => {
    const wrapper = mount(RollFxEditor, { props: { modelValue: createDefaultRollParameters() } });
    expect(wrapper.findAll('input[type="range"]')).toHaveLength(2);
    await wrapper.get('[aria-label="ROLL slice length in beats"]').setValue('1');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ sliceBeats: 1 });
    await wrapper.get('[aria-label="ROLL decay percent"]').setValue('64');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ decayPercent: 64 });
    await wrapper.get('[aria-label="ROLL pitch semitones"]').setValue('-7');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ pitchSemitones: -7 });
    await wrapper.get('[aria-label="ROLL playback direction"]').setValue('2');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ direction: 2 });
    wrapper.unmount();
  });
});
