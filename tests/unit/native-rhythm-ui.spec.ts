import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { NativeBridgeClient, NativeRhythmConfig, NativeStatus } from '../../src/audio/NativeBridgeClient';
import { nativeRhythmStatus } from '../helpers/nativeRhythmStatus';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.resetModules();
  vi.doUnmock('../../src/audio/AudioEngine');
});

async function mountNativeControls(initial = nativeRhythmStatus({ patternIndex: 198, kitIndex: 13, variation: 'C', section: 'intro', swingPercent: 67, quantizeGrid: '1/8', volume: 73 })) {
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
    getCapabilities: () => ({ supportsRhythm: rhythm.available, rhythmReason: rhythm.unavailableReason }),
    onStatusChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => audio } }));
  const Top = (await import('../../src/components/RhythmControls.vue')).default;
  const Center = (await import('../../src/components/panel/CenterMainPanel.vue')).default;
  const top = mount(Top);
  const center = mount(Center, { global: { stubs: { HardwareKnob: true } } });
  wrappers.push(top, center);
  await flushPromises();
  return { top, center, rhythm, setRhythm, setStatus: async (next: NativeStatus) => { status = next; notify(); await nextTick(); } };
}

describe('Native ACK-backed shared rhythm panels', () => {
  it('reads settings on mount and synchronizes all shared selections and volume between panels', async () => {
    const { top, center, setRhythm } = await mountNativeControls();
    expect(setRhythm).not.toHaveBeenCalled();
    expect(top.get('[data-testid="rhythm-pattern-select"]').element.value).toBe('198');
    expect(center.get('[data-testid="center-rhythm-pattern-select"]').element.value).toBe('198');
    expect(top.get('[data-testid="rhythm-kit-select"]').element.value).toBe('13');
    expect(top.get('[data-testid="rhythm-variation-select"]').element.value).toBe('C');
    expect(top.get('[data-testid="rhythm-section-select"]').element.value).toBe('intro');
    expect(top.get('[data-testid="rhythm-swing"]').element.value).toBe('67');
    expect(top.get('[data-testid="rhythm-quantize-select"]').element.value).toBe('1/8');
    expect(top.get('input[aria-label="Rhythm volume"]').element.value).toBe('73');
    await top.get('[data-testid="rhythm-pattern-select"]').setValue('240');
    await top.get('[data-testid="rhythm-kit-select"]').setValue('16');
    await top.get('[data-testid="rhythm-variation-select"]').setValue('D');
    await top.get('[data-testid="rhythm-section-select"]').setValue('fill');
    await top.get('[data-testid="rhythm-swing"]').setValue('75');
    await top.get('[data-testid="rhythm-quantize-select"]').setValue('1/4');
    await center.get('input[aria-label="Rhythm volume"]').setValue('84');
    await flushPromises();
    expect(setRhythm).toHaveBeenLastCalledWith(expect.objectContaining({ patternIndex: 240, kitIndex: 16, variation: 'D', section: 'fill', swingPercent: 75, quantizeGrid: '1/4', volume: 84 }));
    expect(center.get('[data-testid="center-rhythm-pattern-select"]').element.value).toBe('240');
    expect(top.get('input[aria-label="Rhythm volume"]').element.value).toBe('84');
  });

  it('waits for the start ACK, blocks duplicate transport presses, and stops consistently from either panel', async () => {
    const { top, center, rhythm, setRhythm } = await mountNativeControls();
    let acknowledge!: (status: NativeStatus) => void;
    setRhythm.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    await top.get('button[aria-label="Start rhythm"]').trigger('click');
    await Promise.resolve();
    expect(top.get('button[aria-label="Start rhythm"]').attributes('disabled')).toBeDefined();
    expect(center.get('button[aria-label="Toggle rhythm"]').attributes('disabled')).toBeDefined();
    expect(center.get('button[aria-label="Toggle rhythm"]').classes()).not.toContain('active');
    expect(rhythm.isRunning).toBe(false);
    acknowledge(nativeRhythmStatus({ ...rhythm.settings!, enabled: true }));
    await flushPromises();
    expect(top.find('button[aria-label="Stop rhythm"]').exists()).toBe(true);
    expect(center.get('button[aria-label="Toggle rhythm"]').classes()).toContain('active');
    await center.get('button[aria-label="Toggle rhythm"]').trigger('click');
    await flushPromises();
    expect(top.find('button[aria-label="Start rhythm"]').exists()).toBe(true);
    expect(center.get('button[aria-label="Toggle rhythm"]').classes()).not.toContain('active');
    expect(setRhythm).toHaveBeenCalledTimes(2);
  });

  it('reacts to unavailable and incomplete old statuses, then re-enables only on a complete available status', async () => {
    const incomplete = nativeRhythmStatus();
    delete (incomplete.nativeRhythm as Partial<NativeRhythmConfig>).swingPercent;
    const { top, center, setStatus, setRhythm } = await mountNativeControls(incomplete);
    expect(top.get('[data-testid="rhythm-pattern-select"]').attributes('disabled')).toBeDefined();
    expect(top.get('button[aria-label="Start rhythm"]').attributes('disabled')).toBeDefined();
    expect(center.get('input[aria-label="Rhythm volume"]').attributes('disabled')).toBeDefined();
    expect(top.get('[data-testid="rhythm-status"]').text()).toContain('does not report');
    const unavailable = nativeRhythmStatus();
    unavailable.nativeRhythm!.available = false;
    unavailable.nativeRhythm!.statusNote = 'Rhythm DSP unavailable on this bridge';
    await setStatus(unavailable);
    expect(top.get('[data-testid="rhythm-status"]').text()).toBe('Rhythm DSP unavailable on this bridge');
    await setStatus(nativeRhythmStatus());
    expect(top.get('[data-testid="rhythm-pattern-select"]').attributes('disabled')).toBeUndefined();
    expect(center.get('button[aria-label="Toggle rhythm"]').attributes('disabled')).toBeUndefined();
    expect(setRhythm).not.toHaveBeenCalled();
  });

  it('shows Native failures in both panels, preserves acknowledged settings, and clears errors after retry', async () => {
    const { top, center, setRhythm } = await mountNativeControls();
    setRhythm.mockRejectedValueOnce(new Error('Native rhythm endpoint unsupported'));
    await top.get('[data-testid="rhythm-pattern-select"]').setValue('240');
    await flushPromises();
    expect(top.get('[data-testid="rhythm-status"]').text()).toBe('Native rhythm endpoint unsupported');
    expect(center.get('.rhythm-note').text()).toBe('Native rhythm endpoint unsupported');
    expect(top.get('[data-testid="rhythm-pattern-select"]').element.value).toBe('198');
    expect(top.find('button[aria-label="Start rhythm"]').exists()).toBe(true);
    await top.get('[data-testid="rhythm-pattern-select"]').setValue('240');
    await flushPromises();
    expect(top.find('[data-testid="rhythm-status"]').exists()).toBe(false);
    expect(center.find('.rhythm-note').exists()).toBe(false);
    expect(center.get('[data-testid="center-rhythm-pattern-select"]').element.value).toBe('240');
  });
});
