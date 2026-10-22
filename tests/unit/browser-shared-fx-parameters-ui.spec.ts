import { afterEach, describe, expect, it, vi } from 'vitest';
import { shallowMount, type VueWrapper } from '@vue/test-utils';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.doUnmock('../../src/audio/AudioEngine');
  localStorage.clear();
});

async function loadPanel(surface: 'face' | 'tech', path: 'input' | 'track', type: string) {
  vi.resetModules();
  localStorage.clear();
  const makeSlots = () => ['A', 'B', 'C', 'D'].map((id) => ({ id, type, value: 40, active: false }));
  localStorage.setItem('webrc505_top_panel', JSON.stringify({ inputSlots: makeSlots(), trackSlots: makeSlots() }));
  const engine = {
    getMode: () => 'browser', onStatusChange: vi.fn(() => () => {}),
    getCapabilities: () => ({ supportsInputFx: true, supportsTrackFx: true, fxReason: '' }),
    getNativeCatalogFxOptions: () => [], getNativeCatalogFxSlotStatus: () => null,
    setFxType: vi.fn(), setFxParam: vi.fn(), setFxActive: vi.fn(),
    setCatalogFxParameters: vi.fn(), setPreampParameters: vi.fn(), setNativeStepSlicerParameters: vi.fn(),
    setTrackFxType: vi.fn(() => true), setTrackFxParameter: vi.fn(() => true),
    setTrackFxNamedParameters: vi.fn(() => true), setTrackFxActive: vi.fn(() => true),
    getTrackFxStatus: vi.fn(() => []),
  };
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine } }));
  const component = surface === 'tech'
    ? (await import('../../src/components/TopPanel.vue')).default
    : path === 'input'
      ? (await import('../../src/components/panel/InputFxPanel.vue')).default
      : (await import('../../src/components/panel/TrackFxPanel.vue')).default;
  const wrapper = shallowMount(component, { global: { stubs: { BrowserCatalogParametersEditor: false } } });
  wrappers.push(wrapper);
  const state = (await import('../../src/composables/useFxPanelState')).useFxPanelState(path);
  const title = `${path === 'input' ? 'Input' : 'Track'} FX slot A`;
  const editor = wrapper.get(`[data-${path}-named-controls]`);
  engine.setCatalogFxParameters.mockClear();
  return { wrapper, editor, engine, state, title };
}

describe.each([
  ['face', 'input'], ['face', 'track'], ['tech', 'input'], ['tech', 'track'],
] as const)('Browser %s %s shared FX controls', (surface, path) => {
  it('preserves the dedicated editor while exposing official controls and dispatching/persisting the edit', async () => {
    const { wrapper, editor, engine, state, title } = await loadPanel(surface, path, 'PREAMP');
    expect(wrapper.find('preamp-fx-editor-stub').exists()).toBe(true);
    const gain = editor.get(`[aria-label="${title} official_gain"]`);
    expect(gain.attributes()).toMatchObject({ min: '0', max: '120', step: '1' });
    expect(editor.find(`[aria-label="${title} preampGainPercent"]`).exists()).toBe(false);
    expect(editor.get(`[aria-label="${title} official_amp_type"]`).findAll('option').map(option => option.text())).toContain('JC-120');
    await gain.setValue('112');
    expect(engine.setCatalogFxParameters).toHaveBeenCalledWith(path, 0, { official_gain: 112 });
    expect(state.slots.value[0]!.namedParametersByType?.PREAMP).toEqual({ official_gain: 112 });
    const saved = JSON.parse(localStorage.getItem('webrc505_top_panel')!);
    expect(saved[`${path}Slots`][0].namedParametersByType.PREAMP).toEqual({ official_gain: 112 });
    expect(editor.text()).toContain('hardware sound parity not verified');
  });

  it('requires an explicit ROLL variant and clears incompatible official fields on a variant change', async () => {
    const { wrapper, editor, state, title } = await loadPanel(surface, path, 'ROLL');
    const variant = editor.get(`[aria-label="${title} official_variant"]`);
    expect(editor.find(`[aria-label="${title} official_feedback"]`).exists()).toBe(false);
    await variant.setValue('1');
    await editor.get(`[aria-label="${title} official_feedback"]`).setValue('72');
    expect(state.slots.value[0]!.namedParametersByType?.ROLL).toEqual({ official_variant: 1, official_feedback: 72 });
    await variant.setValue('2');
    expect(editor.find(`[aria-label="${title} official_feedback"]`).exists()).toBe(false);
    expect(editor.get(`[aria-label="${title} official_repeat"]`).exists()).toBe(true);
    expect(state.slots.value[0]!.namedParametersByType?.ROLL).toEqual({ official_variant: 2 });
    expect(wrapper.find('roll-fx-editor-stub').exists()).toBe(true);
  });

  it('keeps explicit official values when the amount macro retakes legacy extension controls', async () => {
    const { wrapper, editor, engine, state, title } = await loadPanel(surface, path, 'PHASER');
    await editor.get(`[aria-label="${title} official_depth"]`).setValue('63');
    await editor.get(`[aria-label="${title} official_rate"]`).setValue('-16');
    await editor.get(`[aria-label="${title} phaserDepth"]`).setValue('0.2');
    const macro = surface === 'face'
      ? wrapper.getComponent({ name: 'HardwareKnob' })
      : wrapper.findAllComponents({ name: 'FxUnit' })[path === 'input' ? 0 : 4]!;
    macro.vm.$emit('update:modelValue', 58);
    await wrapper.vm.$nextTick();
    expect(state.slots.value[0]!.namedParametersByType?.PHASER).toEqual({ official_depth: 63, official_rate: -16 });
    expect(engine.setCatalogFxParameters).toHaveBeenCalledWith(path, 0, { official_depth: 63, official_rate: -16 });
    await editor.get('.reset-named-controls').trigger('click');
    expect(state.slots.value[0]!.namedParametersByType?.PHASER).toBeUndefined();
    expect(engine.setFxType).toHaveBeenCalledWith(path, 0, 'NONE');
    expect(engine.setFxType).toHaveBeenCalledWith(path, 0, 'PHASER');
  });
});
