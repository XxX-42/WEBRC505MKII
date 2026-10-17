import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

const HardwareButtonStub = defineComponent({
  props: { label: { type: String, default: '' }, disabled: Boolean, active: Boolean, ariaLabel: { type: String, default: '' } },
  emits: ['press'],
  template: '<button type="button" :data-label="label" :disabled="disabled" :aria-label="ariaLabel" @click="$emit(\'press\')">{{ label }}</button>',
});
const HardwareFaderStub = defineComponent({
  props: { disabled: Boolean, disabledReason: { type: String, default: '' }, ariaLabel: { type: String, default: '' }, modelValue: { type: Number, default: 100 } },
  emits: ['update:modelValue'],
  template: '<input type="range" data-testid="track-level-fader" :disabled="disabled" :value="modelValue">',
});

describe('TrackStrip live KeepPitch controls and HQ memory budget', () => {
  let wrapper: VueWrapper | null = null;
  let trackAudio: any;
  let runtime: { ready: boolean };
  let nativeHqCapability: { available: boolean; engines: Array<'R2' | 'R3'> };
  let browserLikeState: any;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    browserLikeState = {
      monoEnabled: false,
      monoActive: false,
      monoFallback: null as string | null,
      monoLatency: null as number | null,
      polyEnabled: false,
      polyActive: false,
      polyFallback: null as string | null,
      polyLatency: null as number | null,
    };
    runtime = { ready: true };
    nativeHqCapability = { available: true, engines: ['R2', 'R3'] };
    const setMono = vi.fn(async (enabled: boolean, options?: { semitones?: number }) => {
      browserLikeState.monoEnabled = enabled;
      browserLikeState.monoActive = enabled && !browserLikeState.monoFallback;
      browserLikeState.monoLatency = 2_206;
      if (enabled) browserLikeState.polyEnabled = false;
      expect(options?.semitones).toBeGreaterThanOrEqual(-12);
      expect(options?.semitones).toBeLessThanOrEqual(12);
    });
    const setPoly = vi.fn(async (enabled: boolean, options?: { semitones?: number }) => {
      browserLikeState.polyEnabled = enabled;
      browserLikeState.polyActive = enabled && !browserLikeState.polyFallback;
      browserLikeState.polyLatency = 6_720;
      if (enabled) browserLikeState.monoEnabled = false;
      expect(options?.semitones).toBeGreaterThanOrEqual(-12);
      expect(options?.semitones).toBeLessThanOrEqual(12);
    });
    trackAudio = {
      state: 'STOPPED',
      track: { playLevel: 100, fxSw: 'OFF' },
      isAvailable: true,
      transportEnabled: true,
      disabledReason: '',
      setLiveMonoPitchEnabled: setMono,
      setLivePolyPitchEnabled: setPoly,
      setMono,
      setPoly,
      triggerRecord: vi.fn(),
      triggerStop: vi.fn(),
      clear: vi.fn(),
      updateSettings: vi.fn(),
      canExportHqWav: true,
      exportHqWav: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3, 4]) })),
    };
    for (const [name, value] of Object.entries({
      liveMonoPitchEnabled: 'monoEnabled',
      liveMonoPitchActive: 'monoActive',
      liveMonoPitchFallbackReason: 'monoFallback',
      liveMonoPitchLatencySamples: 'monoLatency',
      livePolyPitchEnabled: 'polyEnabled',
      livePolyPitchActive: 'polyActive',
      livePolyPitchFallbackReason: 'polyFallback',
      livePolyPitchLatencySamples: 'polyLatency',
    })) {
      Object.defineProperty(trackAudio, name, { configurable: true, get: () => browserLikeState[value] });
    }
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.doUnmock('../../src/audio/AudioEngine');
    vi.clearAllMocks();
  });

  async function mountTrack(options: { mode?: 'browser' | 'native'; backend?: string } = {}) {
    const mode = options.mode ?? 'browser';
    const engine = {
      tracks: [trackAudio],
      selectedBackend: options.backend ?? (mode === 'browser' ? 'BROWSER' : 'ASIO'),
      selectedSampleRate: 48_000,
      getMode: () => mode,
      getNativeHqRenderer: () => mode === 'native' ? nativeHqCapability : { available: false, engines: [] },
      getUiStatus: () => ({ ready: runtime.ready }),
      getTrackCapabilities: () => ({
        trackId: 1,
        isAvailable: true,
        availabilityReason: '',
        supportsTrackLevel: false,
        levelReason: 'TRACK MIX IN BROWSER ONLY',
        supportsTrackFx: false,
        trackFxReason: 'PER-TRACK FX UNAVAILABLE',
        supportsReverse: false,
        reverseReason: 'REVERSE UNAVAILABLE',
      }),
    };
    vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine } }));
    const component = (await import('../../src/components/panel/TrackStrip.vue')).default;
    wrapper = mount(component, {
      props: { trackId: 1 },
      global: { stubs: { HardwareButton: HardwareButtonStub, HardwareFader: HardwareFaderStub, LoopHalo: true } },
    });
    await flushPromises();
    return wrapper;
  }

  it('starts OFF without activating anything, then disables the prior mode before switching', async () => {
    const view = await mountTrack();
    expect(view.get('[data-testid="keep-pitch-mode"]').element.value).toBe('OFF');
    expect(trackAudio.setMono).not.toHaveBeenCalled();
    expect(trackAudio.setPoly).not.toHaveBeenCalled();

    await view.get('[data-testid="keep-pitch-mode"]').setValue('LIVE_MONO');
    await flushPromises();
    expect(trackAudio.setMono).toHaveBeenNthCalledWith(1, true, { semitones: 0 });
    expect(view.get('[data-testid="keep-pitch-status"]').text()).toContain('LIVE_MONO ACTIVE');

    await view.get('[data-testid="keep-pitch-mode"]').setValue('LIVE_POLY');
    await flushPromises();
    expect(trackAudio.setMono).toHaveBeenNthCalledWith(2, false, { semitones: 0 });
    expect(trackAudio.setPoly).toHaveBeenCalledWith(true, { semitones: 0 });
    expect(browserLikeState.monoEnabled).toBe(false);
    expect(browserLikeState.polyEnabled).toBe(true);

    await view.get('[data-testid="keep-pitch-mode"]').setValue('OFF');
    await flushPromises();
    expect(trackAudio.setPoly).toHaveBeenLastCalledWith(false, { semitones: 0 });
    expect(browserLikeState.polyEnabled).toBe(false);
  });

  it('clamps pitch to ±12 and reports fallback plus algorithmic frames/ms', async () => {
    browserLikeState.monoFallback = 'loop is shorter than the processor latency';
    await mountTrack();
    await wrapper!.get('[data-testid="keep-pitch-mode"]').setValue('LIVE_MONO');
    await wrapper!.get('[data-testid="keep-pitch-semitones"]').setValue(99);
    await flushPromises();

    expect(wrapper!.get('[data-testid="keep-pitch-semitones"]').element.value).toBe('12');
    expect(trackAudio.setMono).toHaveBeenLastCalledWith(true, { semitones: 12 });
    expect(wrapper!.get('[data-testid="keep-pitch-fallback"]').text()).toContain('loop is shorter');
    expect(wrapper!.get('[data-testid="keep-pitch-status"]').text()).toContain('FALLBACK');
    expect(wrapper!.get('[data-testid="keep-pitch-latency"]').text()).toContain('ALGORITHMIC LATENCY ONLY');
    expect(wrapper!.get('[data-testid="keep-pitch-latency"]').text()).toContain('algorithmic latency: 2206 samples');
    expect(wrapper!.get('[data-testid="keep-pitch-latency"]').text()).toContain('45.96 ms');
  });

  it('restores saved Native settings only after runtime readiness and explains the single target limit', async () => {
    runtime.ready = false;
    window.localStorage.setItem('webrc505_track_strip_settings_v1:native:ASIO:track:1', JSON.stringify({
      mode: 'LIVE_POLY', semitones: -7, hqMemoryBudgetMiB: 1024,
    }));
    const view = await mountTrack({ mode: 'native', backend: 'ASIO' });

    expect(trackAudio.setPoly).not.toHaveBeenCalled();
    expect(view.get('[data-testid="keep-pitch-status"]').text()).toContain('WAITING FOR AUDIO RUNTIME');
    expect(view.get('[data-testid="keep-pitch-native-limit"]').text()).toContain('one selected track target at a time');
    expect((view.get('[data-testid="hq-memory-budget-mib"]').element as HTMLInputElement).value).toBe('1024');

    runtime.ready = true;
    await vi.advanceTimersByTimeAsync(60);
    await flushPromises();
    expect(trackAudio.setPoly).toHaveBeenCalledWith(true, { semitones: -7 });
  });

  it('keeps a mode chosen before startup saved and applies it once the runtime becomes ready', async () => {
    runtime.ready = false;
    const view = await mountTrack();
    await view.get('[data-testid="keep-pitch-mode"]').setValue('LIVE_MONO');
    await view.get('[data-testid="keep-pitch-semitones"]').setValue(-5);
    await flushPromises();
    expect(trackAudio.setMono).not.toHaveBeenCalled();
    expect(view.get('[data-testid="keep-pitch-status"]').text()).toContain('WAITING FOR AUDIO RUNTIME');

    runtime.ready = true;
    await vi.advanceTimersByTimeAsync(60);
    await flushPromises();
    expect(trackAudio.setMono).toHaveBeenCalledWith(true, { semitones: -5 });
  });

  it('locks live controls during recording and exposes asynchronous setter errors', async () => {
    trackAudio.state = 'RECORDING';
    const view = await mountTrack();
    expect(view.get('[data-testid="keep-pitch-mode"]').attributes('disabled')).toBeDefined();
    expect(trackAudio.setMono).not.toHaveBeenCalled();

    trackAudio.state = 'STOPPED';
    trackAudio.setLiveMonoPitchEnabled.mockRejectedValueOnce(new Error('pitch processor failed'));
    await vi.advanceTimersByTimeAsync(60);
    await view.get('[data-testid="keep-pitch-mode"]').setValue('LIVE_MONO');
    await flushPromises();
    expect(view.get('[data-testid="keep-pitch-error"]').text()).toContain('pitch processor failed');
  });

  it('persists and passes the configurable HQ estimate to export without changing the default', async () => {
    const urlStub = { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() };
    vi.stubGlobal('URL', urlStub);
    const view = await mountTrack();
    expect((view.get('[data-testid="hq-memory-budget-mib"]').element as HTMLInputElement).value).toBe('512');
    expect(view.text()).toContain('not an OS memory guarantee');

    await view.get('[data-testid="hq-memory-budget-mib"]').setValue(1024);
    await flushPromises();
    expect(JSON.parse(window.localStorage.getItem('webrc505_track_strip_settings_v1:browser:BROWSER:track:1')!).hqMemoryBudgetMiB).toBe(1024);
    await view.get('.hq-export-controls button').trigger('click');
    await flushPromises();
    expect(trackAudio.exportHqWav).toHaveBeenCalledWith(expect.objectContaining({
      memoryBudgetBytes: 1024 * 1024 * 1024,
    }), expect.any(Function));
    expect(trackAudio.exportHqWav.mock.calls[0][0]).not.toHaveProperty('nativeHqEngine');
  });

  it('shows the advertised Native R2/R3 selector, defaults to R3, and passes the selected engine', async () => {
    const urlStub = { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() };
    vi.stubGlobal('URL', urlStub);
    const view = await mountTrack({ mode: 'native' });

    const selector = view.get('[data-testid="native-hq-engine"]');
    expect((selector.element as HTMLSelectElement).value).toBe('R3');
    expect(selector.findAll('option').map((option) => option.element.value)).toEqual(['R2', 'R3']);
    await selector.setValue('R2');
    await view.get('.hq-export-controls button').trigger('click');
    await flushPromises();

    expect(trackAudio.exportHqWav).toHaveBeenCalledWith(expect.objectContaining({ nativeHqEngine: 'R2' }), expect.any(Function));
  });

  it('uses an advertised R2-only renderer and clamps HQ controls to their supported ranges', async () => {
    nativeHqCapability = { available: true, engines: ['R2'] };
    const view = await mountTrack({ mode: 'native' });
    expect((view.get('[data-testid="native-hq-engine"]').element as HTMLSelectElement).value).toBe('R2');
    expect(view.get('[data-testid="native-hq-engine"]').findAll('option').map((option) => option.element.value)).toEqual(['R2']);
    const numberControls = view.findAll('.hq-export-panel input[type="number"]');
    await numberControls[0]!.setValue(99);
    await numberControls[1]!.setValue(3);
    await flushPromises();
    expect((numberControls[0]!.element as HTMLInputElement).value).toBe('24');
    expect((numberControls[1]!.element as HTMLInputElement).value).toBe('2');
  });

  it('treats missing Native HQ capability as unavailable', async () => {
    nativeHqCapability = { available: false, engines: [] };
    const urlStub = { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() };
    vi.stubGlobal('URL', urlStub);
    const nativeView = await mountTrack({ mode: 'native' });
    expect(nativeView.get('[data-testid="native-hq-engine"]').attributes('disabled')).toBeDefined();
    expect(nativeView.get('[data-testid="native-hq-unavailable"]').text()).toContain('unavailable');
    expect(nativeView.get('.hq-export-controls button').attributes('disabled')).toBeDefined();
    expect(trackAudio.exportHqWav).not.toHaveBeenCalled();
  });
});
