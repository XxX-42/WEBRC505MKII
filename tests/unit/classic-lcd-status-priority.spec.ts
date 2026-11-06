import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { NativeBridgeClient, NativeRhythmConfig } from '../../src/audio/NativeBridgeClient';
import { nativeRhythmStatus } from '../helpers/nativeRhythmStatus';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.replaceChildren();
  vi.resetModules();
  vi.doUnmock('../../src/audio/AudioEngine');
  vi.doUnmock('../../src/composables/useDeviceScreenEditor');
});

async function mountNativeControls(initial = nativeRhythmStatus({ patternIndex: 198, kitIndex: 13, variation: 'C', section: 'intro', swingPercent: 67, quantizeGrid: '1/8', volume: 73 })) {
  window.localStorage.clear();
  const { NativeRhythmEngine } = await import('../../src/audio/NativeRhythmEngine');
  let status = initial;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const setRhythm = vi.fn(async (config: NativeRhythmConfig) => ({ ...status, nativeRhythm: { ...status.nativeRhythm!, ...config } }));
  const rhythm = new NativeRhythmEngine({
    bridge: () => ({ setRhythm }) as unknown as NativeBridgeClient,
    status: () => status, bridgeAvailable: () => true,
    applyStatus: (next) => { status = next; notify(); }, reportError: () => {}, notify,
  });
  let uiStatus = { ready: true, engineRunning: true, message: 'NATIVE READY', lastError: '' };
  const audio = {
    rhythmEngine: rhythm, tracks: [], getMode: () => 'native',
    getCapabilities: () => ({
      mode: 'native', modeSummary: 'NATIVE · TEST RUNTIME', supportedTrackCount: 0,
      supportsInputFx: false, supportsTrackFx: false, supportsReverse: false, supportsRhythm: rhythm.available,
      supportsBeatFeedback: false, fxReason: 'FX unavailable in this test runtime.',
      reverseReason: 'Reverse unavailable in this test runtime.', rhythmReason: rhythm.unavailableReason,
      beatReason: 'Beat feedback unavailable in this test runtime.', trackLevelReason: 'Track level unavailable in this test runtime.',
      supportsOutputLevel: false, outputLevelReason: 'Output level unavailable in this test runtime.',
    }),
    getUiStatus: () => uiStatus,
    getOutputLevel: () => 100,
    getTrackHistoryStatus: () => ({ canUndo: false, canRedo: false, busy: false, unavailableReason: 'No history fixture' }),
    getTrackCapabilities: () => ({
      trackId: 1, isAvailable: false, availabilityReason: 'No track fixture',
      supportsTrackLevel: false, levelReason: 'Track level unavailable in this test runtime.',
      supportsTrackFx: false, trackFxReason: 'Track FX unavailable in this test runtime.',
      supportsReverse: false, reverseReason: 'Reverse unavailable in this test runtime.',
    }),
    getNativeCatalogFxOptions: () => [],
    getNativeCatalogFxSlotStatus: () => null,
    setFxType: vi.fn(() => true), setFxParam: vi.fn(() => true), setFxActive: vi.fn(() => true),
    setTrackFxType: vi.fn(() => true),
    setOutputLevel: vi.fn(),
    onStatusChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => audio } }));
  const { ref } = await import('vue');
  vi.doMock('../../src/composables/useDeviceScreenEditor', () => ({ useDeviceScreenEditor: () => ({ active: ref(true), status: ref('FX APPLIED'), fields: ref([]), pageIndex: ref(0), pageCount: ref(1), pageTitle: ref('FX'), selectedFieldIndex: ref(0), selectField: vi.fn(), stepPage: vi.fn(), enter: vi.fn() }) }));
  const Center = (await import('../../src/components/panel/CenterMainPanel.vue')).default;
  const center = mount(Center, {
    props: {
      inputFxValue: 0, trackFxValue: 0, inputFxDisabled: true, inputFxReason: 'Input FX unavailable in this test runtime.',
      trackFxDisabled: true, trackFxReason: 'Track FX unavailable in this test runtime.',
    },
    global: { stubs: { HardwareKnob: true } },
  });
  wrappers.push(center);
  await flushPromises();
  const { useDevicePanel } = await import('../../src/composables/useDevicePanel');
  useDevicePanel().classicDispatch({ type: 'OPEN_EDITOR', target: 'input-fx', category: 'input-fx' });
  await nextTick();
  return { center, setUiStatus: async (next: typeof uiStatus) => { uiStatus = next; notify(); await nextTick(); } };
}


describe('Classic LCD runtime status priority', () => {
  it('shows pending and unknown runtime status over stale FX feedback and scoped errors, then restores notice', async () => {
    const { center, setUiStatus } = await mountNativeControls();
    const lcd = () => center.get('.lcd-status');
    expect(lcd().text()).toBe('FX APPLIED');
    const { useRc505Controls } = await import('../../src/composables/useRc505Controls');
    useRc505Controls().reportError('OLD FX ERROR', 'Old FX error detail', 'input-fx');
    await nextTick();
    const pending = 'Waiting for the exact Native BPM callback acknowledgement.';
    await setUiStatus({ ready: false, engineRunning: true, message: 'Waiting', lastError: pending });
    expect(lcd().attributes('title')).toBe(pending);
    expect(lcd().text()).toContain('Waiting for the exact Native BPM');
    const unknown = 'Native BPM outcome is unknown';
    await setUiStatus({ ready: false, engineRunning: true, message: 'Waiting', lastError: unknown });
    expect(lcd().attributes('title')).toBe(unknown);
    expect(lcd().text()).toBe(unknown);
    await setUiStatus({ ready: false, engineRunning: true, message: 'Host is waiting', lastError: '' });
    expect(lcd().attributes('title')).toBe('Host is waiting');
    expect(lcd().text()).toBe('Host is waiting');
    useRc505Controls().clearError('input-fx');
    await setUiStatus({ ready: true, engineRunning: true, message: 'READY', lastError: '' });
    expect(lcd().text()).toBe('FX APPLIED');
  });

  it('shows a rejected error even when ready, and permits offline editor feedback', async () => {
    const { center, setUiStatus } = await mountNativeControls();
    const lcd = () => center.get('.lcd-status');
    await setUiStatus({ ready: true, engineRunning: true, message: 'READY', lastError: 'BPM change rejected' });
    expect(lcd().attributes('title')).toBe('BPM change rejected');
    expect(lcd().text()).toBe('BPM change rejected');
    await setUiStatus({ ready: false, engineRunning: false, message: 'Audio not started', lastError: '' });
    expect(lcd().attributes('title')).toBe('FX APPLIED');
    expect(lcd().text()).toBe('FX APPLIED');
  });
});
