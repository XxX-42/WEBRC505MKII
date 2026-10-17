import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

const { engineMock } = vi.hoisted(() => ({
  engineMock: {
    getMode: vi.fn(() => 'browser'),
    setBrowserStepSlicerStep: vi.fn(),
    setBrowserStepSlicerControl: vi.fn(),
  },
}));

vi.mock('../../src/audio/AudioEngine', () => ({
  AudioEngine: { getInstance: () => engineMock },
}));

import StepSlicerEditor from '../../src/components/fx/StepSlicerEditor.vue';
import {
  DEFAULT_STEP_SLICER_SEQUENCE,
  STEP_SLICER_SEQUENCE_STORAGE_KEY,
  loadStepSlicerSettings,
  loadStepSlicerSequence,
  saveStepSlicerSettings,
  saveStepSlicerSequence,
} from '../../src/composables/stepSlicerSequenceState';

describe('Browser STEP SLICER sequence editor', () => {
  beforeEach(() => {
    localStorage.clear();
    engineMock.setBrowserStepSlicerStep.mockClear();
    engineMock.setBrowserStepSlicerControl.mockClear();
    engineMock.getMode.mockReturnValue('browser');
  });

  it('persists independent amplitude sequences by Browser bank and slot with safe values', () => {
    const changed = Array.from({ length: 16 }, (_, index) => index * 7);
    changed[1] = -20;
    changed[2] = 135;
    changed[3] = Number.NaN;

    const saved = saveStepSlicerSequence('input', 'B', changed);
    expect(saved).toHaveLength(16);
    expect(saved.slice(0, 5)).toEqual([0, 0, 100, 100, 28]);
    expect(loadStepSlicerSequence('input', 'B')).toEqual(saved);
    expect(loadStepSlicerSequence('track', 'B')).toEqual([...DEFAULT_STEP_SLICER_SEQUENCE]);
    expect(loadStepSlicerSequence('input', 'A')).toEqual([...DEFAULT_STEP_SLICER_SEQUENCE]);
    expect(JSON.parse(localStorage.getItem(STEP_SLICER_SEQUENCE_STORAGE_KEY) ?? '{}')).toHaveProperty('input:B');
  });

  it('persists musical and stereo controls per slot and migrates legacy sequence-only state', () => {
    const settings = {
      steps: Array.from({ length: 16 }, (_, index) => index * 4),
      stepCount: 8 as const,
      rateBeats: 2 as const,
      panDepthPercent: 63,
      filterHz: 3200,
    };
    saveStepSlicerSettings('input', 'B', settings);
    expect(loadStepSlicerSettings('input', 'B')).toEqual(settings);
    expect(loadStepSlicerSettings('track', 'B')).toMatchObject({ stepCount: 16, rateBeats: 0.25, panDepthPercent: 0, filterHz: 20000 });

    localStorage.setItem(STEP_SLICER_SEQUENCE_STORAGE_KEY, JSON.stringify({ 'track:D': settings.steps }));
    expect(loadStepSlicerSettings('track', 'D')).toMatchObject({
      steps: settings.steps,
      stepCount: 16,
      rateBeats: 0.25,
      panDepthPercent: 0,
      filterHz: 20000,
    });
  });

  it('restores and syncs all settings, then persists edits and sends each change to its worklet slot', async () => {
    const preset = Array.from({ length: 16 }, (_, index) => index * 5);
    saveStepSlicerSettings('track', 'C', {
      steps: preset,
      stepCount: 16,
      rateBeats: 0.5,
      panDepthPercent: 20,
      filterHz: 10000,
    });

    const wrapper = mount(StepSlicerEditor, {
      props: { bank: 'track', slotIndex: 2, slotId: 'C' },
    });

    expect(wrapper.findAll('input[type="range"]')).toHaveLength(18);
    expect(wrapper.get('legend').text()).toContain('TRACK C');
    expect(engineMock.setBrowserStepSlicerStep).toHaveBeenCalledTimes(16);
    expect(engineMock.setBrowserStepSlicerStep).toHaveBeenNthCalledWith(1, 'track', 2, 0, 0);
    expect(engineMock.setBrowserStepSlicerStep).toHaveBeenNthCalledWith(16, 'track', 2, 15, 75);
    expect(engineMock.setBrowserStepSlicerControl).toHaveBeenCalledTimes(4);
    expect(engineMock.setBrowserStepSlicerControl).toHaveBeenNthCalledWith(1, 'track', 2, 'step_count', 16);
    expect(engineMock.setBrowserStepSlicerControl).toHaveBeenNthCalledWith(2, 'track', 2, 'rate_beats', 0.5);
    expect(engineMock.setBrowserStepSlicerControl).toHaveBeenNthCalledWith(3, 'track', 2, 'pan_depth_percent', 20);
    expect(engineMock.setBrowserStepSlicerControl).toHaveBeenNthCalledWith(4, 'track', 2, 'filter_hz', 10000);

    await wrapper.get('[aria-label="Step 4 amplitude"]').setValue('37');
    expect(engineMock.setBrowserStepSlicerStep).toHaveBeenLastCalledWith('track', 2, 3, 37);
    expect((wrapper.get('[aria-label="Step 4 amplitude"]').element as HTMLInputElement).value).toBe('37');

    await wrapper.get('[aria-label="Step count"]').setValue('8');
    await wrapper.get('[aria-label="Step rate in beats"]').setValue('2');
    await wrapper.get('[aria-label="Alternating pan depth"]').setValue('73');
    await wrapper.get('[aria-label="Low-pass filter cutoff"]').setValue('50');
    expect(wrapper.get('[aria-label="Step 9 amplitude"]').attributes('disabled')).toBeDefined();
    expect(engineMock.setBrowserStepSlicerControl).toHaveBeenLastCalledWith('track', 2, 'filter_hz', 632);
    expect(loadStepSlicerSettings('track', 'C')).toMatchObject({
      stepCount: 8,
      rateBeats: 2,
      panDepthPercent: 73,
      filterHz: 632,
    });
    expect(loadStepSlicerSequence('track', 'C')[3]).toBe(37);

    wrapper.unmount();
  });
});
