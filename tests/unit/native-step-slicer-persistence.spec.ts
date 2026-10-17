import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

async function loadNativePanel(location: 'input' | 'track', preserveStorage = false) {
  vi.resetModules();
  if (!preserveStorage) localStorage.clear();
  window.history.replaceState({}, '', '/?audio=native');
  const module = await import('../../src/composables/useFxPanelState');
  return module.useFxPanelState(location);
}

describe('Native STEP SLICER per-slot persistence', () => {
  beforeEach(() => localStorage.clear());

  it('persists edited sequence parameters independently for Input and Track slots', async () => {
    const inputPanel = await loadNativePanel('input');
    const panelModule = await import('../../src/composables/useFxPanelState');
    const trackPanel = panelModule.useFxPanelState('track');
    const inputSlot = inputPanel.slots.value[1]!;
    const trackSlot = trackPanel.slots.value[3]!;

    inputSlot.type = 'STEP SLICER';
    trackSlot.type = 'STEP SLICER';
    await nextTick();
    inputSlot.stepSlicerParameters!.step_count = 8;
    inputSlot.stepSlicerParameters!.step_05 = 37;
    inputSlot.stepSlicerParameters!.rate_beats = 0.5;
    trackSlot.stepSlicerParameters!.step_count = 4;
    trackSlot.stepSlicerParameters!.step_16 = 12;
    trackSlot.stepSlicerParameters!.pan_depth_percent = 66;
    await nextTick();

    const saved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}') as {
      inputSlots?: Array<{ type: string; stepSlicerParameters?: Record<string, number> }>;
      trackSlots?: Array<{ type: string; stepSlicerParameters?: Record<string, number> }>;
    };
    expect(saved.inputSlots?.[1]).toMatchObject({
      type: 'STEP SLICER', stepSlicerParameters: { step_count: 8, rate_beats: 0.5, step_05: 37 },
    });
    expect(saved.trackSlots?.[3]).toMatchObject({
      type: 'STEP SLICER', stepSlicerParameters: { step_count: 4, pan_depth_percent: 66, step_16: 12 },
    });

    const restoredInput = await loadNativePanel('input', true);
    const restoredTrack = await loadNativePanel('track', true);
    expect(restoredInput.slots.value[1]?.stepSlicerParameters).toMatchObject({ step_count: 8, rate_beats: 0.5, step_05: 37 });
    expect(restoredTrack.slots.value[3]?.stepSlicerParameters).toMatchObject({ step_count: 4, pan_depth_percent: 66, step_16: 12 });
  });
});
