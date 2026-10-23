import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

async function loadPanel(search: string, location: 'input' | 'track' = 'track', preserveStorage = false) {
  vi.resetModules();
  if (!preserveStorage) localStorage.clear();
  window.history.replaceState({}, '', search);
  const module = await import('../../src/composables/useFxPanelState');
  return module.useFxPanelState(location);
}

describe('FX panel runtime selection', () => {
  beforeEach(async () => {
    localStorage.clear();
    // Warm cold transformation in the hook; loadPanel still resets singleton state.
    await import('../../src/composables/useFxPanelState');
  });

  it('keeps Native FX disabled until a bridge status confirms catalog support', async () => {
    const panel = await loadPanel('/?audio=native');

    expect(panel.fxDisabled.value).toBe(true);
    expect(panel.fxOptions.value).toEqual(['NONE']);
    expect(panel.slots.value).toEqual([
      { id: 'A', type: '', value: 0, active: false },
      { id: 'B', type: '', value: 0, active: false },
      { id: 'C', type: '', value: 0, active: false },
      { id: 'D', type: '', value: 0, active: false },
    ]);
    expect(panel.fxUnavailableReason.value).toContain('Connect the Native bridge');
  });

  it('lists WARP only as an experimental option in both Browser A–D banks', async () => {
    const input = await loadPanel('/?audio=browser', 'input');
    expect(input.fxOptions.value).toContain('WARP (EXPERIMENTAL)');
    const track = await loadPanel('/?audio=browser', 'track');
    expect(track.fxOptions.value).toContain('WARP (EXPERIMENTAL)');
  });

  it('exposes HRM AUTO (M) from its experimental Browser catalog route in both A-D banks', async () => {
    const input = await loadPanel('/?audio=browser', 'input');
    const track = await loadPanel('/?audio=browser', 'track', true);
    expect(input.fxOptions.value).toContain('HRM AUTO (M) (EXPERIMENTAL)');
    expect(track.fxOptions.value).toContain('HRM AUTO (M) (EXPERIMENTAL)');
    expect(input.fxOptions.value).not.toContain('HRM AUTO (M)');
    expect(track.fxOptions.value).not.toContain('HRM AUTO (M)');
  });

  it('persists Native Input and Track A–D selector values independently', async () => {
    const panel = await loadPanel('/?audio=native');
    panel.slots.value[2]!.type = 'CHORUS';
    panel.slots.value[2]!.value = 67;
    panel.slots.value[2]!.active = true;
    await nextTick();

    const saved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}') as {
      inputSlots?: Array<{ type: string }>;
      trackSlots?: Array<{ type: string; value: number; active: boolean }>;
    };
    expect(saved.inputSlots?.[2]?.type).toBe('');
    expect(saved.trackSlots?.[2]).toMatchObject({ type: 'CHORUS', value: 67, active: true });

    const restored = await loadPanel('/?audio=native', 'track', true);
    expect(restored.slots.value[2]).toMatchObject({ id: 'C', type: 'CHORUS', value: 67, active: true });
  });

  it('centers TRANSPOSE when newly selected so the first sound is unshifted', async () => {
    const native = await loadPanel('/?audio=native');
    const nativeSlot = native.slots.value[0]!;
    nativeSlot.value = 0;
    nativeSlot.type = 'TRANSPOSE';
    await nextTick();
    expect(nativeSlot.value).toBe(50);

    const browser = await loadPanel('/?audio=browser');
    const browserSlot = browser.slots.value[0]!;
    browserSlot.value = 0;
    browserSlot.type = 'TRANSPOSE';
    await nextTick();
    expect(browserSlot.value).toBe(50);
  });

  it('initializes PITCH BEND defaults while leaving the activation-triggered sweep bypassed', async () => {
    const browserInput = await loadPanel('/?audio=browser', 'input');
    expect(browserInput.fxOptions.value).toContain('PITCH BEND');

    const native = await loadPanel('/?audio=native');
    const nativeSlot = native.slots.value[0]!;
    nativeSlot.active = true;
    nativeSlot.type = 'PITCH BEND';
    await nextTick();
    expect(nativeSlot.active).toBe(false);
    expect(nativeSlot.value).toBe(50);
    expect(nativeSlot.pitchBendParameters).toEqual({
      rangeSemitones: 12, timeMs: 500, direction: 0, mixPercent: 100,
    });

    const browser = await loadPanel('/?audio=browser');
    expect(browser.fxOptions.value).toContain('PITCH BEND');
    const browserSlot = browser.slots.value[0]!;
    browserSlot.active = true;
    browserSlot.type = 'PITCH BEND';
    await nextTick();
    expect(browserSlot.active).toBe(false);
    expect(browserSlot.value).toBe(50);
    expect(browserSlot.pitchBendParameters).toEqual({
      rangeSemitones: 12, timeMs: 500, direction: 0, mixPercent: 100,
    });
  });

  it('initializes, updates, and persists HRM MANUAL controls in both runtime slot stores', async () => {
    const browser = await loadPanel('/?audio=browser', 'input');
    expect(browser.fxOptions.value).toContain('HRM MANUAL');
    const browserSlot = browser.slots.value[0]!;
    browserSlot.type = 'HRM MANUAL';
    await nextTick();
    expect(browserSlot.manualHarmonistParameters).toEqual({
      voice1Interval: 7, voice2Interval: 12, panPercent: 0, mixPercent: 70,
    });
    browserSlot.manualHarmonistParameters!.voice2Interval = -5;
    browserSlot.manualHarmonistParameters!.panPercent = 35;
    await nextTick();
    const browserSaved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ manualHarmonistParameters?: { voice2Interval?: number; panPercent?: number } }>;
    };
    expect(browserSaved.inputSlots?.[0]?.manualHarmonistParameters).toMatchObject({ voice2Interval: -5, panPercent: 35 });

    const native = await loadPanel('/?audio=native', 'track');
    const nativeSlot = native.slots.value[0]!;
    nativeSlot.type = 'HRM MANUAL';
    await nextTick();
    expect(nativeSlot.manualHarmonistParameters).toEqual({
      voice1Interval: 7, voice2Interval: 12, panPercent: 0, mixPercent: 70,
    });
    nativeSlot.manualHarmonistParameters!.voice1Interval = 5;
    await nextTick();
    const nativeSaved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}') as {
      trackSlots?: Array<{ manualHarmonistParameters?: { voice1Interval?: number } }>;
    };
    expect(nativeSaved.trackSlots?.[0]?.manualHarmonistParameters?.voice1Interval).toBe(5);
  });

  it('initializes and persists supported OCTAVE voices and mix in both runtime slot stores', async () => {
    const browser = await loadPanel('/?audio=browser', 'input');
    expect(browser.fxOptions.value).toContain('OCTAVE');
    const browserSlot = browser.slots.value[0]!;
    browserSlot.type = 'OCTAVE';
    await nextTick();
    expect(browserSlot.octaveParameters).toEqual({
      minus24Level: 0, minus12Level: 40, plus12Level: 0, mixPercent: 70,
    });
    browserSlot.octaveParameters!.minus24Level = 20;
    browserSlot.octaveParameters!.plus12Level = 35;
    browserSlot.octaveParameters!.mixPercent = 55;
    await nextTick();
    const browserSaved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ octaveParameters?: { minus24Level?: number; plus12Level?: number; mixPercent?: number } }>;
    };
    expect(browserSaved.inputSlots?.[0]?.octaveParameters).toMatchObject({
      minus24Level: 20, plus12Level: 35, mixPercent: 55,
    });

    const native = await loadPanel('/?audio=native', 'track');
    const nativeSlot = native.slots.value[0]!;
    nativeSlot.type = 'OCTAVE';
    await nextTick();
    expect(nativeSlot.octaveParameters).toEqual({
      minus24Level: 0, minus12Level: 40, plus12Level: 0, mixPercent: 70,
    });
    nativeSlot.octaveParameters!.minus12Level = 65;
    nativeSlot.octaveParameters!.mixPercent = 80;
    await nextTick();
    const nativeSaved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}') as {
      trackSlots?: Array<{ octaveParameters?: { minus12Level?: number; mixPercent?: number } }>;
    };
    expect(nativeSaved.trackSlots?.[0]?.octaveParameters).toMatchObject({ minus12Level: 65, mixPercent: 80 });
  });

  it('initializes and persists the Browser VOCODER filterbank, carrier and mix', async () => {
    const browser = await loadPanel('/?audio=browser', 'input');
    expect(browser.fxOptions.value).toContain('VOCODER');
    const slot = browser.slots.value[0]!;
    slot.type = 'VOCODER';
    await nextTick();
    expect(slot.vocoderParameters).toEqual({ bands: 16, carrier: 1, mixPercent: 70 });
    slot.vocoderParameters!.bands = 12;
    slot.vocoderParameters!.carrier = 2;
    slot.vocoderParameters!.mixPercent = 55;
    await nextTick();
    const saved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ vocoderParameters?: { bands?: number; carrier?: number; mixPercent?: number } }>;
    };
    expect(saved.inputSlots?.[0]?.vocoderParameters).toEqual({ bands: 12, carrier: 2, mixPercent: 55 });
  });

  it('retains the shared Browser A–D selector and full option list', async () => {
    const panel = await loadPanel('/?audio=browser');

    expect(panel.fxDisabled.value).toBe(false);
    expect(panel.slots.value).toHaveLength(4);
    expect(panel.fxOptions.value).toContain('PHASER');
    expect(panel.fxOptions.value).toContain('CHORUS');
    expect(panel.fxOptions.value).toContain('TREMOLO');
    expect(panel.fxOptions.value).toContain('AUTO PAN');
    expect(panel.fxOptions.value).toContain('FDN8 REVERB');
    expect(panel.fxOptions.value).toContain('GATE REVERB');
    expect(panel.fxOptions.value).toContain('BEAT REPEAT');
    expect(panel.fxOptions.value).toContain('STEREO ENHANCE');
    expect(panel.fxOptions.value).toContain('LO-FI');
    expect(panel.fxOptions.value).toContain('EQ');
    expect(panel.fxOptions.value).toContain('MANUAL PAN');
    expect(panel.fxOptions.value).toContain('TAPE ECHO');
    expect(panel.fxOptions.value).toContain('PANNING DELAY');
    expect(panel.fxOptions.value).toContain('ISOLATOR');
    expect(panel.fxOptions.value).toContain('REVERSE DELAY');
    expect(panel.fxOptions.value).toContain('REVERSE REVERB (EXPERIMENTAL)');
    expect(panel.fxOptions.value).toContain('MOD DELAY');
    expect(panel.fxOptions.value).toContain('VIBRATO');
    expect(panel.fxOptions.value).toContain('GRANULAR DELAY');
    expect(panel.fxOptions.value).toContain('RADIO');
    expect(panel.fxOptions.value).toContain('PATTERN SLICER');
    expect(panel.fxOptions.value).toContain('OCTAVE');
    expect(panel.fxOptions.value).toContain('BEAT SCATTER');
    expect(panel.fxOptions.value).toContain('ROLL');
    // BEAT SHIFT has an experimental multi-beat look-ahead and remains
    // explicitly outside the production selector until quality acceptance.
    expect(panel.fxOptions.value).not.toContain('BEAT SHIFT');
    expect(panel.fxOptions.value).not.toContain('VINYL FLICK (EXPERIMENTAL)');
  });

  it('keeps BEAT REPEAT out of the Browser input selector', async () => {
    const panel = await loadPanel('/?audio=browser', 'input');
    expect(panel.fxOptions.value).toContain('GATE REVERB');
    expect(panel.fxOptions.value).toContain('REVERSE REVERB (EXPERIMENTAL)');
    expect(panel.fxOptions.value).not.toContain('BEAT REPEAT');
    expect(panel.fxOptions.value).not.toContain('BEAT SCATTER');
    expect(panel.fxOptions.value).toContain('ROLL');
  });

  it('exposes AUTO RIFF experimentally only when its Browser bank route is catalogued', async () => {
    const { FX_CATALOG } = await import('../../src/audio/fx/catalog');
    const autoRiff = FX_CATALOG.find((effect) => effect.id === 'auto-riff');
    const hasBrowserRoute = (target: 'input-bank-slot' | 'track-bank-slot') => autoRiff?.implementationStatus === 'experimental'
      && autoRiff.runtimeImplementations?.some((item) => item.runtime === 'browser' && item.target === target);
    const input = await loadPanel('/?audio=browser', 'input');
    const track = await loadPanel('/?audio=browser', 'track', true);

    expect(input.fxOptions.value.includes('AUTO RIFF (EXPERIMENTAL)')).toBe(Boolean(hasBrowserRoute('input-bank-slot')));
    expect(track.fxOptions.value.includes('AUTO RIFF (EXPERIMENTAL)')).toBe(Boolean(hasBrowserRoute('track-bank-slot')));
  });

  it('persists AUTO RIFF named controls per slot in Browser and Native stores without dropping older slot fields', async () => {
    localStorage.setItem('webrc505_top_panel', JSON.stringify({
      inputSlots: [{
        id: 'A', type: 'AUTO RIFF (EXPERIMENTAL)', value: 65, active: false,
        rollParameters: { sliceBeats: 1, decayPercent: 50, pitchSemitones: 2, direction: 0 },
        autoRiffParameters: { scale: 4, rateBeats: 2, sensitivityPercent: 32, mixPercent: 65 },
      }, {
        id: 'B', type: 'AUTO RIFF (EXPERIMENTAL)', value: 50, active: false,
        autoRiffParameters: { scale: 1, rateBeats: 0.5, sensitivityPercent: 44, mixPercent: 50 },
      }],
    }));
    const browser = await loadPanel('/?audio=browser', 'input', true);
    const { AudioEngine } = await import('../../src/audio/AudioEngine');
    const browserSetCatalogParameters = vi.spyOn(AudioEngine.getInstance(), 'setCatalogFxParameters');
    const browserSlot = browser.slots.value[0]!;
    expect(browserSlot.autoRiffParameters).toEqual({ scale: 4, rateBeats: 2, sensitivityPercent: 32, mixPercent: 65 });
    expect(browser.slots.value[1]?.autoRiffParameters).toEqual({ scale: 1, rateBeats: 0.5, sensitivityPercent: 44, mixPercent: 50 });
    browserSetCatalogParameters.mockClear();
    browserSlot.autoRiffParameters!.sensitivityPercent = 71;
    await nextTick();
    expect(browserSetCatalogParameters).toHaveBeenCalledWith('input', 0, {
      scale: 4, rate_beats: 2, sensitivity_percent: 71, mix_percent: 65,
    });
    const browserSaved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{
        autoRiffParameters?: { scale?: number; rateBeats?: number; sensitivityPercent?: number; mixPercent?: number };
        rollParameters?: { sliceBeats?: number };
      }>;
    };
    expect(browserSaved.inputSlots?.[0]?.autoRiffParameters).toMatchObject({ scale: 4, rateBeats: 2, sensitivityPercent: 71, mixPercent: 65 });
    expect(browserSaved.inputSlots?.[0]?.rollParameters?.sliceBeats).toBe(1);
    expect(browserSaved.inputSlots?.[1]?.autoRiffParameters).toEqual({ scale: 1, rateBeats: 0.5, sensitivityPercent: 44, mixPercent: 50 });
    const restoredBrowser = await loadPanel('/?audio=browser', 'input', true);
    expect(restoredBrowser.slots.value[0]?.autoRiffParameters?.sensitivityPercent).toBe(71);

    const native = await loadPanel('/?audio=native', 'track');
    const { AudioEngine: NativeAudioEngineForTest } = await import('../../src/audio/AudioEngine');
    const nativeSetCatalogParameters = vi.spyOn(NativeAudioEngineForTest.getInstance(), 'setCatalogFxParameters');
    const nativeSlot = native.slots.value[1]!;
    nativeSlot.type = 'AUTO RIFF (EXPERIMENTAL)';
    await nextTick();
    nativeSetCatalogParameters.mockClear();
    nativeSlot.autoRiffParameters = { scale: 3, rateBeats: 0.25, sensitivityPercent: 88, mixPercent: 46 };
    await nextTick();
    expect(nativeSetCatalogParameters).toHaveBeenCalledWith('track', 1, {
      scale: 3, rate_beats: 0.25, sensitivity_percent: 88, mix_percent: 46,
    });
    const nativeSaved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}') as {
      trackSlots?: Array<{ autoRiffParameters?: { scale?: number; rateBeats?: number; sensitivityPercent?: number; mixPercent?: number } }>;
    };
    expect(nativeSaved.trackSlots?.[1]?.autoRiffParameters).toEqual({ scale: 3, rateBeats: 0.25, sensitivityPercent: 88, mixPercent: 46 });
    const restoredNative = await loadPanel('/?audio=native', 'track', true);
    expect(restoredNative.slots.value[1]?.autoRiffParameters).toEqual({ scale: 3, rateBeats: 0.25, sensitivityPercent: 88, mixPercent: 46 });
  });

  it('persists HRM AUTO named controls per Input/Track slot in Browser and Native and routes catalog parameters', async () => {
    localStorage.setItem('webrc505_top_panel', JSON.stringify({
      inputSlots: [{
        id: 'A', type: 'HRM AUTO (M) (EXPERIMENTAL)', value: 70, active: true,
        rollParameters: { sliceBeats: 1, decayPercent: 40, pitchSemitones: 2, direction: 0 },
        hrmAutoParameters: { key: 0, scale: 0, midiChannel: 1, mixPercent: 70 },
      }, {
        id: 'B', type: 'HRM AUTO (M)', value: 48, active: false,
        hrmAutoParameters: { key: 7, scale: 3, midiChannel: 8, mixPercent: 48 },
      }],
      trackSlots: [{
        id: 'A', type: 'HRM AUTO (M)', value: 52, active: false,
        hrmAutoParameters: { key: 9, scale: 4, midiChannel: 3, mixPercent: 52 },
      }],
    }));
    const browserInput = await loadPanel('/?audio=browser', 'input', true);
    const { AudioEngine } = await import('../../src/audio/AudioEngine');
    const browserSetCatalogParameters = vi.spyOn(AudioEngine.getInstance(), 'setCatalogFxParameters');
    const browserInputSlot = browserInput.slots.value[0]!;
    expect(browserInputSlot.hrmAutoParameters).toEqual({ key: 0, scale: 0, midiChannel: 1, mixPercent: 70 });
    expect(browserInput.slots.value[1]?.hrmAutoParameters).toEqual({ key: 7, scale: 3, midiChannel: 8, mixPercent: 48 });
    browserSetCatalogParameters.mockClear();
    browserInputSlot.hrmAutoParameters = { key: 5, scale: 2, midiChannel: 11, mixPercent: 63 };
    await nextTick();
    expect(browserSetCatalogParameters).toHaveBeenCalledWith('input', 0, {
      key: 5, scale: 2, 'midi-channel': 11, mix: 63,
    });
    let browserSaved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ hrmAutoParameters?: Record<string, number>; rollParameters?: { sliceBeats?: number } }>;
      trackSlots?: Array<{ hrmAutoParameters?: Record<string, number> }>;
    };
    expect(browserSaved.inputSlots?.[0]?.hrmAutoParameters).toEqual({ key: 5, scale: 2, midiChannel: 11, mixPercent: 63 });
    expect(browserSaved.inputSlots?.[0]?.rollParameters?.sliceBeats).toBe(1);
    expect(browserSaved.inputSlots?.[1]?.hrmAutoParameters).toEqual({ key: 7, scale: 3, midiChannel: 8, mixPercent: 48 });

    const browserTrack = await loadPanel('/?audio=browser', 'track', true);
    const browserTrackSlot = browserTrack.slots.value[0]!;
    browserTrackSlot.hrmAutoParameters = { key: 2, scale: 1, midiChannel: 6, mixPercent: 57 };
    await nextTick();
    browserSaved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as typeof browserSaved;
    expect(browserSaved.trackSlots?.[0]?.hrmAutoParameters).toEqual({ key: 2, scale: 1, midiChannel: 6, mixPercent: 57 });
    const restoredBrowser = await loadPanel('/?audio=browser', 'input', true);
    expect(restoredBrowser.slots.value[0]?.hrmAutoParameters).toEqual({ key: 5, scale: 2, midiChannel: 11, mixPercent: 63 });
    expect(restoredBrowser.slots.value[1]?.hrmAutoParameters).toEqual({ key: 7, scale: 3, midiChannel: 8, mixPercent: 48 });

    localStorage.setItem('webrc505_native_fx_catalog', JSON.stringify({
      inputSlots: [{ id: 'A', type: '', value: 0, active: false }, {
        id: 'B', type: 'HRM AUTO (M)', value: 46, active: false,
        synthParameters: { waveform: 2, octave: 0, mix: 46 },
        hrmAutoParameters: { key: 4, scale: 1, midiChannel: 5, mixPercent: 46 },
      }],
      trackSlots: [{ id: 'A', type: '', value: 0, active: false }, { id: 'B', type: '', value: 0, active: false },
        { id: 'C', type: '', value: 0, active: false }, {
          id: 'D', type: 'HRM AUTO (M)', value: 72, active: false,
          rollParameters: { sliceBeats: 0.5, decayPercent: 30, pitchSemitones: 0, direction: 0 },
          hrmAutoParameters: { key: 10, scale: 2, midiChannel: 14, mixPercent: 72 },
        }],
    }));
    const nativeInput = await loadPanel('/?audio=native', 'input', true);
    const nativePanelModule = await import('../../src/composables/useFxPanelState');
    const nativeTrack = nativePanelModule.useFxPanelState('track');
    const { AudioEngine: NativeAudioEngineForTest } = await import('../../src/audio/AudioEngine');
    const nativeSetCatalogParameters = vi.spyOn(NativeAudioEngineForTest.getInstance(), 'setCatalogFxParameters');
    const nativeInputSlot = nativeInput.slots.value[1]!;
    const nativeTrackSlot = nativeTrack.slots.value[3]!;
    expect(nativeInputSlot.hrmAutoParameters).toEqual({ key: 4, scale: 1, midiChannel: 5, mixPercent: 46 });
    expect(nativeTrackSlot.hrmAutoParameters).toEqual({ key: 10, scale: 2, midiChannel: 14, mixPercent: 72 });
    nativeSetCatalogParameters.mockClear();
    nativeInputSlot.hrmAutoParameters = { key: 6, scale: 4, midiChannel: 9, mixPercent: 51 };
    nativeTrackSlot.hrmAutoParameters = { key: 3, scale: 3, midiChannel: 2, mixPercent: 69 };
    await nextTick();
    expect(nativeSetCatalogParameters).toHaveBeenCalledWith('input', 1, {
      key: 6, scale: 4, 'midi-channel': 9, mix: 51,
    });
    expect(nativeSetCatalogParameters).toHaveBeenCalledWith('track', 3, {
      key: 3, scale: 3, 'midi-channel': 2, mix: 69,
    });
    const nativeSaved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}') as {
      inputSlots?: Array<{ hrmAutoParameters?: Record<string, number>; synthParameters?: { waveform?: number } }>;
      trackSlots?: Array<{ hrmAutoParameters?: Record<string, number>; rollParameters?: { sliceBeats?: number } }>;
    };
    expect(nativeSaved.inputSlots?.[1]?.hrmAutoParameters).toEqual({ key: 6, scale: 4, midiChannel: 9, mixPercent: 51 });
    expect(nativeSaved.inputSlots?.[1]?.synthParameters?.waveform).toBe(2);
    expect(nativeSaved.trackSlots?.[3]?.hrmAutoParameters).toEqual({ key: 3, scale: 3, midiChannel: 2, mixPercent: 69 });
    expect(nativeSaved.trackSlots?.[3]?.rollParameters?.sliceBeats).toBe(0.5);
    const restoredNative = await loadPanel('/?audio=native', 'input', true);
    expect(restoredNative.slots.value[1]?.hrmAutoParameters).toEqual({ key: 6, scale: 4, midiChannel: 9, mixPercent: 51 });
    const restoredNativeTrack = (await import('../../src/composables/useFxPanelState')).useFxPanelState('track');
    expect(restoredNativeTrack.slots.value[3]?.hrmAutoParameters).toEqual({ key: 3, scale: 3, midiChannel: 2, mixPercent: 69 });
  });

  it('keeps BEAT REPEAT bypassed when a previously active slot changes effect', async () => {
    const panel = await loadPanel('/?audio=browser');
    const slot = panel.slots.value[0]!;
    slot.active = true;
    slot.type = 'BEAT REPEAT';
    await nextTick();
    expect(slot.active).toBe(false);

    slot.active = true;
    await nextTick();
    expect(slot.active).toBe(true);
  });

  it('requires explicit activation when a track slot changes to BEAT SCATTER', async () => {
    const panel = await loadPanel('/?audio=browser');
    const slot = panel.slots.value[0]!;
    slot.active = true;
    slot.type = 'BEAT SCATTER';
    await nextTick();
    expect(slot.active).toBe(false);

    slot.active = true;
    await nextTick();
    expect(slot.active).toBe(true);
  });

  it('requires explicit activation for ROLL on either Browser bank', async () => {
    const inputPanel = await loadPanel('/?audio=browser', 'input');
    const inputSlot = inputPanel.slots.value[0]!;
    inputSlot.active = true;
    inputSlot.type = 'ROLL';
    await nextTick();
    expect(inputSlot.active).toBe(false);
    expect(inputSlot.rollParameters).toMatchObject({ sliceBeats: 0.5, decayPercent: 20, pitchSemitones: 0, direction: 0 });

    const trackPanel = await loadPanel('/?audio=browser', 'track', true);
    const trackSlot = trackPanel.slots.value[0]!;
    trackSlot.active = true;
    trackSlot.type = 'ROLL';
    await nextTick();
    expect(trackSlot.active).toBe(false);
  });

  it('persists bounded ROLL controls with the selected FX slot', async () => {
    const panel = await loadPanel('/?audio=browser', 'input');
    const slot = panel.slots.value[0]!;
    slot.type = 'ROLL';
    await nextTick();
    slot.rollParameters = { sliceBeats: 2, decayPercent: 63, pitchSemitones: 9, direction: 1 };
    await nextTick();
    const saved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ rollParameters?: { sliceBeats: number; decayPercent: number; pitchSemitones: number; direction: number } }>;
    };
    expect(saved.inputSlots?.[0]?.rollParameters).toEqual({ sliceBeats: 2, decayPercent: 63, pitchSemitones: 9, direction: 1 });

    const restored = await loadPanel('/?audio=browser', 'input', true);
    expect(restored.slots.value[0]?.rollParameters).toEqual({ sliceBeats: 2, decayPercent: 63, pitchSemitones: 9, direction: 1 });
  });

  it('persists bounded ROBOT controls per slot when the Native route is unavailable', async () => {
    localStorage.setItem('webrc505_native_fx_catalog', JSON.stringify({
      trackSlots: [{
        id: 'A', type: 'ROBOT (EXPERIMENTAL)', value: 62, active: false,
        robotParameters: { targetPitchSemitones: 30, formantShiftSemitones: -18, mixPercent: 62 },
        rollParameters: { sliceBeats: 1, decayPercent: 40, pitchSemitones: 2, direction: 0 },
      }],
    }));
    const panel = await loadPanel('/?audio=native', 'track', true);
    const slot = panel.slots.value[0]!;
    expect(slot.robotParameters).toEqual({ targetPitchSemitones: 24, formantShiftSemitones: -12, mixPercent: 62 });

    const { AudioEngine } = await import('../../src/audio/AudioEngine');
    const setCatalogParameters = vi.spyOn(AudioEngine.getInstance(), 'setCatalogFxParameters');
    setCatalogParameters.mockClear();
    slot.robotParameters!.targetPitchSemitones = -14;
    slot.robotParameters!.formantShiftSemitones = 11;
    slot.robotParameters!.mixPercent = 61;
    await nextTick();
    expect(setCatalogParameters).not.toHaveBeenCalled();

    const saved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}') as {
      trackSlots?: Array<{
        robotParameters?: { targetPitchSemitones: number; formantShiftSemitones: number; mixPercent: number };
        rollParameters?: { sliceBeats: number };
      }>;
    };
    expect(saved.trackSlots?.[0]?.robotParameters).toEqual({
      targetPitchSemitones: -14, formantShiftSemitones: 11, mixPercent: 61,
    });
    expect(saved.trackSlots?.[0]?.rollParameters?.sliceBeats).toBe(1);
    const restored = await loadPanel('/?audio=native', 'track', true);
    expect(restored.slots.value[0]?.robotParameters).toEqual({
      targetPitchSemitones: -14, formantShiftSemitones: 11, mixPercent: 61,
    });
  });

  it('sends the same supported ROBOT pitch/formant/mix keys in Browser and Native modes', async () => {
    const expected = { pitch_semitones: -7.5, formant_semitones: 4.5, mix_percent: 58 };
    const browser = await loadPanel('/?audio=browser', 'input');
    expect(browser.fxOptions.value).toContain('ROBOT (EXPERIMENTAL)');
    const { AudioEngine } = await import('../../src/audio/AudioEngine');
    const browserEngine = AudioEngine.getInstance();
    vi.spyOn(browserEngine, 'setFxType').mockImplementation(() => {});
    vi.spyOn(browserEngine, 'setFxParam').mockImplementation(() => {});
    vi.spyOn(browserEngine, 'setFxActive').mockImplementation(() => {});
    const browserSetParameters = vi.spyOn(browserEngine, 'setCatalogFxParameters').mockImplementation(() => {});

    const browserSlot = browser.slots.value[0]!;
    browserSlot.type = 'ROBOT (EXPERIMENTAL)';
    await nextTick();
    browserSlot.robotParameters = {
      targetPitchSemitones: -7.5, formantShiftSemitones: 4.5, mixPercent: 58,
    };
    await nextTick();
    expect(browserSetParameters).toHaveBeenLastCalledWith('input', 0, expected);
    const browserSaved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ robotParameters?: { targetPitchSemitones: number; formantShiftSemitones: number; mixPercent: number } }>;
    };
    expect(browserSaved.inputSlots?.[0]?.robotParameters).toEqual({
      targetPitchSemitones: -7.5, formantShiftSemitones: 4.5, mixPercent: 58,
    });

    const native = await loadPanel('/?audio=native', 'track', true);
    const { AudioEngine: NativeAudioEngineForTest } = await import('../../src/audio/AudioEngine');
    const nativeEngine = NativeAudioEngineForTest.getInstance();
    vi.spyOn(nativeEngine, 'getNativeCatalogFxOptions').mockReturnValue(['ROBOT (EXPERIMENTAL)']);
    vi.spyOn(nativeEngine, 'getNativeCatalogFxSlotStatus').mockReturnValue({
      path: 'track', slot: 'A', requestedEffectId: 'robot', acknowledgedEffectId: 'robot',
      requestedParameters: expected, acknowledgedParameters: expected, acknowledged: true,
      pendingRestart: false, error: '',
    });
    vi.spyOn(nativeEngine, 'setFxType').mockImplementation(() => {});
    vi.spyOn(nativeEngine, 'setFxParam').mockImplementation(() => {});
    vi.spyOn(nativeEngine, 'setFxActive').mockImplementation(() => {});
    const nativeSetParameters = vi.spyOn(nativeEngine, 'setCatalogFxParameters').mockImplementation(() => {});
    expect(native.fxOptions.value).toContain('ROBOT (EXPERIMENTAL)');

    const nativeSlot = native.slots.value[0]!;
    nativeSlot.type = 'ROBOT (EXPERIMENTAL)';
    await nextTick();
    nativeSlot.robotParameters = {
      targetPitchSemitones: -7.5, formantShiftSemitones: 4.5, mixPercent: 58,
    };
    await nextTick();
    expect(nativeSetParameters).toHaveBeenLastCalledWith('track', 0, expected);
    const nativeSaved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}') as {
      trackSlots?: Array<{ robotParameters?: { targetPitchSemitones: number; formantShiftSemitones: number; mixPercent: number } }>;
    };
    expect(nativeSaved.trackSlots?.[0]?.robotParameters).toEqual({
      targetPitchSemitones: -7.5, formantShiftSemitones: 4.5, mixPercent: 58,
    });
    expect(native.runtimeStatus.value).toMatchObject({
      acknowledged: true, acknowledgedParameters: expected, error: '',
    });
  });
});
