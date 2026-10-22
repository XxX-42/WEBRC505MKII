import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

function mockEngine(mode: 'browser' | 'native' = 'browser') {
  return {
    getMode: () => mode,
    onStatusChange: vi.fn(() => () => {}),
    setTrackFxType: vi.fn(() => true),
    setTrackFxParameter: vi.fn(() => true),
    setTrackFxNamedParameters: vi.fn(() => true),
    setTrackFxActive: vi.fn(() => true),
    getTrackFxStatus: vi.fn(() => []),
  };
}

async function loadState(mode: 'browser' | 'native' = 'browser') {
  vi.resetModules();
  const engine = mockEngine(mode);
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine } }));
  const module = await import('../../src/composables/useBrowserTrackFxState');
  return { ...module, panel: module.useBrowserTrackFxState(), engine };
}

async function loadUnifiedState(mode: 'browser' | 'native' = 'browser') {
  vi.resetModules();
  const engine = {
    ...mockEngine(mode),
    isTrackAvailable: () => true,
    getCapabilities: () => ({ supportsTrackFx: true }),
    getTrackCapabilities: () => ({ availabilityReason: '' }),
  };
  const browser = {
    target: ref<number | 'shared'>(2),
    slots: ref([]),
    activeSlot: ref('A'),
    fxOptions: [],
    runtimeStatus: ref(null),
    warning: ref(''),
    selectTarget: vi.fn((value: number | 'shared') => { browser.target.value = value; return true; }),
  };
  const native = {
    target: ref<number | 'shared'>(4),
    slots: ref([]),
    activeSlot: ref('A'),
    fxOptions: ref([]),
    slotRuntime: ref(null),
    warning: ref(''),
    selectTarget: vi.fn((value: number | 'shared') => { native.target.value = value; return true; }),
  };
  const shared = {
    slots: ref([]),
    activeSlot: ref('A'),
    fxOptions: ref([]),
    fxDisabled: ref(false),
    fxUnavailableReason: ref(''),
    runtimeStatus: ref(null),
    nativeNamedParametersPending: ref(false),
    selectSlot: vi.fn(),
    setNativeNamedParameters: vi.fn(() => true),
  };
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine } }));
  vi.doMock('../../src/composables/useFxPanelState', () => ({ useFxPanelState: () => shared }));
  vi.doMock('../../src/composables/useBrowserTrackFxState', () => ({ useBrowserTrackFxState: () => browser }));
  vi.doMock('../../src/composables/useNativeTrackFxState', () => ({ useNativeTrackFxState: () => native }));
  const module = await import('../../src/composables/useTrackFxTargetState');
  return { state: module.useTrackFxTargetState({ sharedOnly: true }), regular: module.useTrackFxTargetState(), browser, native, engine };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.doUnmock('../../src/audio/AudioEngine');
  vi.doUnmock('../../src/composables/useFxPanelState');
  vi.doUnmock('../../src/composables/useBrowserTrackFxState');
  vi.doUnmock('../../src/composables/useNativeTrackFxState');
});

describe('Browser independent per-track FX state', () => {
  it.each(['browser', 'native'] as const)('lets a Classic shared-only view read the shared bank without changing the %s private target', async (mode) => {
    const { state, regular, browser, native } = await loadUnifiedState(mode);

    expect(state.target.value).toBe('shared');
    expect(state.selectTarget(3)).toBe(false);
    expect(regular.target.value).toBe(mode === 'native' ? 4 : 2);
    expect(browser.target.value).toBe(2);
    expect(native.target.value).toBe(4);
    expect(browser.selectTarget).not.toHaveBeenCalled();
    expect(native.selectTarget).not.toHaveBeenCalled();
  });

  it('persists five independent four-slot banks without altering the shared bank', async () => {
    localStorage.setItem('webrc505_top_panel', 'shared-bank-sentinel');
    const { panel, engine, BROWSER_TRACK_FX_STORAGE_KEY } = await loadState();
    expect(panel.state.tracks).toHaveLength(5);
    expect(panel.state.tracks.every((bank) => bank.slots.length === 4)).toBe(true);
    vi.clearAllMocks();

    expect(panel.setType(1, 0, 'DELAY')).toBe(true);
    panel.setValue(1, 0, 37);
    panel.setNamedParameters(1, 0, { delayTimeMs: 333, delayFeedback: 0.42 });
    panel.setActive(1, 0, true);
    panel.setType(2, 1, 'PHASER');
    panel.setValue(2, 1, 65);
    panel.setActive(2, 1, true);
    panel.selectTarget(2);
    panel.selectSlot('B');

    expect(panel.state.tracks[0]!.slots[0]).toMatchObject({ type: 'DELAY', value: 37, active: true, namedParameters: { delayTimeMs: 333, delayFeedback: 0.42 } });
    expect(panel.state.tracks[1]!.slots[0]!.type).toBe('NONE');
    expect(panel.state.tracks[1]!.slots[1]).toMatchObject({ type: 'PHASER', value: 65, active: true, namedParameters: {} });
    expect(panel.state.tracks[0]!.slots[1]!.type).toBe('NONE');
    expect(engine.setTrackFxNamedParameters).toHaveBeenCalledWith(1, 0, { delayTimeMs: 333, delayFeedback: 0.42 });
    expect(localStorage.getItem('webrc505_top_panel')).toBe('shared-bank-sentinel');
    expect(JSON.parse(localStorage.getItem(BROWSER_TRACK_FX_STORAGE_KEY)!)).toMatchObject({ version: 1, target: 2 });

    const restored = await loadState();
    expect(restored.panel.target.value).toBe(2);
    expect(restored.panel.activeSlot.value).toBe('B');
    restored.panel.selectTarget(1);
    expect(restored.panel.activeSlot.value).toBe('A');
    expect(restored.panel.activeFx.value).toMatchObject({ type: 'DELAY', value: 37, active: true, namedParameters: { delayTimeMs: 333, delayFeedback: 0.42 } });
    expect(restored.engine.setTrackFxType).toHaveBeenCalledWith(1, 0, 'DELAY');
    expect(restored.engine.setTrackFxActive).toHaveBeenCalledWith(1, 0, true);
    const calls = restored.engine.setTrackFxActive.mock.invocationCallOrder;
    expect(restored.engine.setTrackFxNamedParameters.mock.invocationCallOrder[0]).toBeLessThan(calls[0]!);
  });

  it('validates persisted shape, slot identity, finite amounts, types, enums and named controls', async () => {
    const { BROWSER_TRACK_FX_STORAGE_KEY } = await loadState();
    localStorage.setItem(BROWSER_TRACK_FX_STORAGE_KEY, JSON.stringify({
      version: 1, target: 99,
      tracks: [
        { trackId: 1, activeSlot: 'Z', slots: [
          { id: 'D', type: 'DELAY', value: 999, active: true, namedParameters: { delayTimeMs: -500, delayFeedback: 8, delayToneHz: 'bad', arbitrary: 50, mix: null } },
          { type: 'BEAT SHIFT', value: 60, active: true, namedParameters: { beatShiftOffsetBeats: 2 } },
          { type: 'VOCODER', value: '50', active: 'yes', namedParameters: { vocoderBands: 900, vocoderCarrier: -8, formant: 10 } },
          null,
        ] },
        { trackId: 5, activeSlot: 'C', slots: [{ type: 'PHASER', active: true }] },
      ],
    }));
    const { panel } = await loadState();
    expect(panel.target.value).toBe('shared');
    panel.selectTarget(1);
    expect(panel.activeSlot.value).toBe('A');
    expect(panel.activeFx.value).toEqual({ id: 'A', type: 'DELAY', value: 100, active: true, namedParameters: { delayTimeMs: 1, delayFeedback: 0.95 } });
    expect(panel.slots.value[1]).toEqual({ id: 'B', type: 'NONE', value: 0, active: false, namedParameters: {} });
    panel.selectSlot('B');
    expect(panel.warning.value).toContain('Unsupported saved per-track FX: BEAT SHIFT');
    expect(panel.slots.value[2]).toMatchObject({ id: 'C', type: 'VOCODER', value: 0, active: false, namedParameters: { vocoderBands: 24, vocoderCarrier: 0 } });
    expect(panel.state.tracks[1]!.slots[0]!.type).toBe('NONE');
    expect(panel.state.tracks[4]!.slots[0]!.type).toBe('NONE');
  });

  it('rejects unsupported effects and invalid destinations without any fallback dispatch', async () => {
    const { panel, engine } = await loadState();
    vi.clearAllMocks();
    panel.selectTarget(1);
    for (const type of ['BEAT SHIFT', 'VINYL FLICK', 'FILTER']) {
      expect(panel.fxOptions).not.toContain(type);
      expect(panel.setType(1, 0, type)).toBe(false);
    }
    expect(panel.fxOptions).toContain('TRANSPOSE');
    expect(panel.fxOptions).toContain('OSC VOC (M)');
    expect(panel.fxOptions).toContain('ROBOT (EXPERIMENTAL)');
    expect(panel.fxOptions).toContain('HRM AUTO (M) (EXPERIMENTAL)');
    expect(panel.fxOptions).not.toContain('ROBOT');
    expect(panel.fxOptions).not.toContain('HRM AUTO (M)');
    expect(panel.fxOptions).toContain('TRANSPOSE');
    expect(panel.warning.value).toContain('Unsupported Browser per-track FX');
    expect(panel.setType(0, 0, 'DELAY')).toBe(false);
    expect(panel.setType(6, 0, 'DELAY')).toBe(false);
    expect(panel.setType(1, 4, 'DELAY')).toBe(false);
    expect(panel.setType(1.5, 0, 'DELAY')).toBe(false);
    expect(engine.setTrackFxType).not.toHaveBeenCalled();
    expect(panel.activeFx.value?.type).toBe('NONE');
  });

  it('restores executable HRM AUTO with catalog-named controls and its 70 percent mix default', async () => {
    localStorage.setItem('webrc505_browser_per_track_fx_v1', JSON.stringify({
      version: 1, target: 1,
      tracks: [{ trackId: 1, activeSlot: 'A', slots: [{
        id: 'A', type: 'HRM AUTO (M)', active: false,
        namedParameters: { key: 5, scale: 2, 'midi-channel': 16, mix: 84 },
      }] }],
    }));

    const { panel, engine } = await loadState();
    expect(panel.fxOptions).toContain('HRM AUTO (M) (EXPERIMENTAL)');
    expect(panel.activeFx.value).toMatchObject({
      type: 'HRM AUTO (M) (EXPERIMENTAL)', value: 70,
      namedParameters: { key: 5, scale: 2, 'midi-channel': 16, mix: 84 },
    });
    expect(engine.setTrackFxParameter).toHaveBeenCalledWith(1, 0, 70);
    expect(engine.setTrackFxNamedParameters).toHaveBeenCalledWith(1, 0, { key: 5, scale: 2, 'midi-channel': 16, mix: 84 });
  });

  it('keeps UI selection and settings when the runtime reports that an occupied slot was preserved', async () => {
    const { panel, engine } = await loadState();
    panel.selectTarget(1);
    panel.setType(1, 0, 'DELAY');
    panel.setNamedParameters(1, 0, { delayTimeMs: 420, delayFeedback: 0.3 });
    engine.getTrackFxStatus.mockReturnValueOnce([{ slots: [{ type: 'DELAY' }] }] as never);
    engine.setTrackFxType.mockReturnValueOnce(false);

    expect(panel.setType(1, 0, 'TRANSPOSE')).toBe(false);
    expect(panel.activeFx.value).toMatchObject({ type: 'DELAY', namedParameters: { delayTimeMs: 420, delayFeedback: 0.3 } });
  });

  it('keeps unrelated named settings when the macro changes and clears them on effect replacement', async () => {
    const { panel, engine } = await loadState();
    panel.selectTarget(3);
    panel.setType(3, 2, 'DELAY');
    panel.selectSlot('C');
    panel.setNamedParameters(3, 2, { delayTimeMs: 700, delayFeedback: 0.38, mix: 0.9 });
    panel.setValue(3, 2, 23);
    expect(panel.activeFx.value?.namedParameters).toEqual({ delayTimeMs: 700, delayFeedback: 0.38 });
    expect(engine.setTrackFxParameter).toHaveBeenLastCalledWith(3, 2, 23);
    expect(panel.setNamedParameters(3, 2, { unknown: 1 })).toBe(false);
    expect(panel.setNamedParameters(3, 2, { delayTimeMs: Number.NaN })).toBe(false);
    panel.setActive(3, 2, true);
    panel.setType(3, 2, 'ELECTRIC');
    expect(panel.activeFx.value).toMatchObject({ type: 'ELECTRIC', value: 0, active: false, namedParameters: {} });
    panel.setNamedParameters(3, 2, { electricCharacter: 100 });
    expect(panel.activeFx.value?.namedParameters).toEqual({ electricCharacter: 3 });
  });

  it('retains Browser settings in Native mode without sending per-track changes there', async () => {
    const initial = await loadState();
    initial.panel.setType(5, 3, 'DELAY');
    initial.panel.setValue(5, 3, 40);
    const { panel, engine } = await loadState('native');
    expect(panel.state.tracks[4]!.slots[3]).toMatchObject({ type: 'DELAY', value: 40 });
    expect(panel.setType(5, 3, 'PHASER')).toBe(false);
    expect(panel.setValue(5, 3, 90)).toBe(false);
    expect(panel.setNamedParameters(5, 3, { delayTimeMs: 800 })).toBe(false);
    expect(panel.setActive(5, 3, true)).toBe(false);
    expect(engine.setTrackFxType).not.toHaveBeenCalled();
    expect(engine.setTrackFxParameter).not.toHaveBeenCalled();
    expect(engine.setTrackFxNamedParameters).not.toHaveBeenCalled();
    expect(engine.setTrackFxActive).not.toHaveBeenCalled();
  });

  it('fails safely on unreadable or unsupported saved schemas', async () => {
    localStorage.setItem('webrc505_browser_per_track_fx_v1', '{bad json');
    let loaded = await loadState();
    expect(loaded.panel.warning.value).toContain('could not be read');
    expect(loaded.panel.state.tracks.every((bank) => bank.slots.every((slot) => slot.type === 'NONE' && !slot.active))).toBe(true);
    localStorage.setItem(loaded.BROWSER_TRACK_FX_STORAGE_KEY, JSON.stringify({ version: 200, target: 4, tracks: [] }));
    loaded = await loadState();
    expect(loaded.panel.warning.value).toContain('unsupported version');
    expect(loaded.panel.target.value).toBe('shared');
  });

  it('reports failed runtime mutations and never persists a rejected activation as active', async () => {
    const { panel, engine, BROWSER_TRACK_FX_STORAGE_KEY } = await loadState();
    panel.selectTarget(1);
    panel.setType(1, 0, 'DELAY');
    engine.setTrackFxActive.mockReturnValueOnce(false);
    expect(panel.setActive(1, 0, true)).toBe(false);
    expect(panel.activeFx.value?.active).toBe(false);
    expect(panel.warning.value).toContain('Activation was rejected');
    expect(JSON.parse(localStorage.getItem(BROWSER_TRACK_FX_STORAGE_KEY)!).tracks[0].slots[0].active).toBe(false);
    engine.setTrackFxNamedParameters.mockReturnValueOnce(false);
    expect(panel.setNamedParameters(1, 0, { delayTimeMs: 500 })).toBe(false);
    expect(panel.warning.value).toContain('Named settings were saved but not applied');
    engine.setTrackFxParameter.mockReturnValueOnce(false);
    expect(panel.setValue(1, 0, 60)).toBe(false);
    expect(panel.warning.value).toContain('Amount was saved but not applied');
    engine.setTrackFxType.mockReturnValueOnce(false);
    expect(panel.setType(1, 0, 'PHASER')).toBe(false);
    expect(panel.activeFx.value).toMatchObject({ type: 'PHASER', active: false });
    expect(panel.warning.value).toContain('could not be installed');
  });

  it('keeps UI selection and settings when the runtime reports that an occupied slot was preserved', async () => {
    const { panel, engine } = await loadState();
    panel.selectTarget(1);
    panel.setType(1, 0, 'DELAY');
    panel.setNamedParameters(1, 0, { delayTimeMs: 420, delayFeedback: 0.3 });
    engine.getTrackFxStatus.mockReturnValueOnce([{ slots: [{ type: 'DELAY' }] }] as never);
    engine.setTrackFxType.mockReturnValueOnce(false);

    expect(panel.setType(1, 0, 'TRANSPOSE')).toBe(false);
    expect(panel.activeFx.value).toMatchObject({ type: 'DELAY', namedParameters: { delayTimeMs: 420, delayFeedback: 0.3 } });
  });
});
