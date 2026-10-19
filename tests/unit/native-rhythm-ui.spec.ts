import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { NativeBridgeClient, NativeRhythmConfig, NativeStatus } from '../../src/audio/NativeBridgeClient';
import { nativeRhythmStatus } from '../helpers/nativeRhythmStatus';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.replaceChildren();
  vi.resetModules();
  vi.doUnmock('../../src/audio/AudioEngine');
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
    getUiStatus: () => ({ ready: true, message: 'NATIVE READY', lastError: '' }),
    getOutputLevel: () => 100,
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
  await center.get('button[aria-label="Edit rhythm settings"]').trigger('click');
  await flushPromises();
  return { center, rhythm, setRhythm, setStatus: async (next: NativeStatus) => { status = next; notify(); await nextTick(); } };
}

function lcdGet(center: VueWrapper, selector: string): DOMWrapper<any> {
  const element = center.element.querySelector(`[data-testid="rc505-lcd-screen"] ${selector}`);
  if (!element) throw new Error(`Expected LCD rhythm control: ${selector}`);
  return new DOMWrapper(element) as DOMWrapper<any>;
}

async function lcdPage(center: VueWrapper, pageIndex: number): Promise<void> {
  const currentPage = () => Number(center.get('[data-testid="rc505-lcd-screen"] .lcd-row.top span:last-child').text().match(/(\d+)\//)?.[1] ?? '1') - 1;
  while (currentPage() !== pageIndex) {
    await center.get(`button[aria-label="${currentPage() < pageIndex ? 'Next' : 'Previous'} display page"]`).trigger('click');
    await nextTick();
  }
}

describe('Native ACK-backed shared rhythm panels', () => {
  it('reads and applies shared settings from the Native central LCD alongside the physical controls', async () => {
    const { center, setRhythm } = await mountNativeControls();
    expect(setRhythm).not.toHaveBeenCalled();
    expect(lcdGet(center, '[data-testid="lcd-field-pattern"]').element.value).toBe('197');
    expect(lcdGet(center, '[data-testid="lcd-field-kit"]').element.value).toBe('12');
    expect(lcdGet(center, '[data-testid="lcd-field-volume"]').element.value).toBe('73');
    await lcdGet(center, '[data-testid="lcd-field-pattern"]').setValue('239');
    await lcdGet(center, '[data-testid="lcd-field-kit"]').setValue('15');
    await lcdGet(center, '[data-testid="lcd-field-volume"]').setValue('84');
    expect(lcdGet(center, '[data-testid="lcd-field-pattern"]').element.value).toBe('239');
    expect(lcdGet(center, '[data-testid="lcd-field-volume"]').element.value).toBe('84');
    await lcdPage(center, 1);
    expect(lcdGet(center, '[data-testid="lcd-field-variation"]').element.value).toBe('2');
    expect(lcdGet(center, '[data-testid="lcd-field-section"]').element.value).toBe('1');
    expect(lcdGet(center, '[data-testid="lcd-field-swing"]').element.value).toBe('67');
    expect(lcdGet(center, '[data-testid="lcd-field-quantize"]').element.value).toBe('1');
    await lcdGet(center, '[data-testid="lcd-field-variation"]').setValue('3');
    await lcdGet(center, '[data-testid="lcd-field-section"]').setValue('3');
    await lcdGet(center, '[data-testid="lcd-field-swing"]').setValue('75');
    await lcdGet(center, '[data-testid="lcd-field-quantize"]').setValue('2');
    await flushPromises();
    const configs = setRhythm.mock.calls.map(([config]) => config);
    expect(configs).toEqual(expect.arrayContaining([
      expect.objectContaining({ patternIndex: 240 }), expect.objectContaining({ kitIndex: 16 }), expect.objectContaining({ volume: 84 }),
      expect.objectContaining({ variation: 'D' }), expect.objectContaining({ section: 'fill' }),
      expect.objectContaining({ swingPercent: 75 }), expect.objectContaining({ quantizeGrid: '1/4' }),
    ]));
    expect(center.get('button[aria-label="Toggle rhythm playback"]').attributes('disabled')).toBeUndefined();
  });

  it('waits for the start ACK, blocks duplicate transport presses, and stops consistently from either panel', async () => {
    const { center, rhythm, setRhythm } = await mountNativeControls();
    let acknowledge!: (status: NativeStatus) => void;
    setRhythm.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    await lcdPage(center, 2);
    await lcdGet(center, '[data-testid="lcd-field-play-stop"]').trigger('click');
    await Promise.resolve();
    expect(lcdGet(center, '[data-testid="lcd-field-play-stop"]').attributes('disabled')).toBeDefined();
    expect(center.get('button[aria-label="Toggle rhythm playback"]').attributes('disabled')).toBeDefined();
    expect(center.get('button[aria-label="Toggle rhythm playback"]').classes()).not.toContain('active');
    expect(rhythm.isRunning).toBe(false);
    acknowledge(nativeRhythmStatus({ ...rhythm.settings!, enabled: true }));
    await flushPromises();
    expect(lcdGet(center, '[data-testid="lcd-field-play-stop"]').text()).toContain('STOP RHYTHM');
    expect(center.get('button[aria-label="Toggle rhythm playback"]').classes()).toContain('active');
    await lcdGet(center, '[data-testid="lcd-field-play-stop"]').trigger('click');
    await flushPromises();
    expect(lcdGet(center, '[data-testid="lcd-field-play-stop"]').text()).toContain('START RHYTHM');
    expect(center.get('button[aria-label="Toggle rhythm playback"]').classes()).not.toContain('active');
    expect(setRhythm).toHaveBeenCalledTimes(2);
  });

  it('reacts to unavailable and incomplete old statuses, then re-enables only on a complete available status', async () => {
    const incomplete = nativeRhythmStatus();
    delete (incomplete.nativeRhythm as Partial<NativeRhythmConfig>).swingPercent;
    const { center, setStatus, setRhythm } = await mountNativeControls(incomplete);
    expect(lcdGet(center, '[data-testid="lcd-field-pattern"]').attributes('disabled')).toBeDefined();
    await lcdPage(center, 2);
    expect(lcdGet(center, '[data-testid="lcd-field-play-stop"]').attributes('disabled')).toBeDefined();
    expect(center.get('.lcd-status').text()).toContain('does not report');
    const unavailable = nativeRhythmStatus();
    unavailable.nativeRhythm!.available = false;
    unavailable.nativeRhythm!.statusNote = 'Rhythm DSP unavailable on this bridge';
    await setStatus(unavailable);
    expect(center.get('.lcd-status').text()).toBe('Rhythm DSP unavailable on this bridge');
    await setStatus(nativeRhythmStatus());
    await lcdPage(center, 0);
    expect(lcdGet(center, '[data-testid="lcd-field-pattern"]').attributes('disabled')).toBeUndefined();
    expect(center.get('button[aria-label="Toggle rhythm playback"]').attributes('disabled')).toBeUndefined();
    expect(setRhythm).not.toHaveBeenCalled();
  });

  it('shows Native failures in both panels, preserves acknowledged settings, and clears errors after retry', async () => {
    const { center, setRhythm } = await mountNativeControls();
    setRhythm.mockRejectedValueOnce(new Error('Native rhythm endpoint unsupported'));
    await lcdGet(center, '[data-testid="lcd-field-pattern"]').setValue('239');
    await flushPromises();
    expect(center.get('.lcd-status').text()).toBe('Native rhythm endpoint unsupported');
    expect(lcdGet(center, '[data-testid="lcd-field-pattern"]').element.value).toBe('197');
    await lcdGet(center, '[data-testid="lcd-field-pattern"]').setValue('239');
    await flushPromises();
    expect(center.get('.lcd-status').text()).not.toBe('Native rhythm endpoint unsupported');
    expect(lcdGet(center, '[data-testid="lcd-field-pattern"]').element.value).toBe('239');
  });
});
