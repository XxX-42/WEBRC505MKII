import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.doUnmock('../../src/audio/AudioEngine');
  vi.doUnmock('../../src/composables/useFxPanelState');
  vi.doUnmock('../../src/composables/useTrackFxTargetState');
});

async function loadPanel(path: 'input' | 'track', options: { mode?: 'native' | 'browser'; schemaAvailable?: boolean } = {}) {
  vi.resetModules();
  const mode = options.mode ?? 'native';
  const schema = {
    version: 1,
    parameters: [
      {
        id: 'official_depth', label: 'DEPTH', minimum: 0, maximum: 100, defaultValue: 50,
        step: 1, discrete: false, provenance: 'official-interface', officialEffectName: 'PHASER',
        sourcePage: 34, documentedDefault: 50, unit: '%',
      },
      {
        id: 'official_stage', label: 'STAGE', minimum: -1, maximum: 12, defaultValue: 8,
        discrete: true, discreteValues: [4, 8, 12, -1], provenance: 'official-interface', officialEffectName: 'PHASER',
        options: [{ value: 4, label: '4' }, { value: 8, label: '8' }, { value: 12, label: '12' }, { value: -1, label: 'BI-PHASE' }],
        sourcePage: 34, documentedDefault: 8, limitation: 'Clean-room phase response is not hardware-verified.',
      },
    ],
    legacyAliases: [],
  };
  const slots = ref(['A', 'B', 'C', 'D'].map((id) => ({
    id, type: 'PHASER', value: 50, active: false,
    namedParametersByType: undefined as Record<string, Record<string, number>> | undefined,
  })));
  const activeSlot = ref('B');
  const runtimeStatus = ref({
    acknowledged: true, pendingApply: false, outcomeUnknown: false, pendingRestart: false,
    error: '', requestedRevision: 7, appliedRevision: 7, acknowledgedEffectId: 'phaser', acknowledgedParameters: {},
  });
  const nativeNamedParametersPending = ref(false);
  const setNativeNamedParameters = vi.fn(() => {
    nativeNamedParametersPending.value = true;
    return true;
  });
  const fxDisabled = ref(false);
  const panelState = {
    slots, activeSlot, runtimeStatus, nativeNamedParametersPending, setNativeNamedParameters, fxDisabled,
    fxOptions: ref(['NONE', 'PHASER', 'PREAMP']), fxUnavailableReason: ref(''),
    selectSlot: (id: string) => { activeSlot.value = id; },
  };
  const target = ref<string | number>('shared');
  const engine = {
    getMode: () => mode,
    getNativeCatalogFxParameterSchema: vi.fn(() => options.schemaAvailable === false ? null : schema),
  };
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine } }));
  vi.doMock('../../src/composables/useFxPanelState', () => ({ useFxPanelState: () => panelState }));
  vi.doMock('../../src/composables/useTrackFxTargetState', () => ({
    useTrackFxTargetState: () => ({ target, selectTarget: (value: string | number) => { target.value = value; } }),
  }));
  const component = path === 'input'
    ? (await import('../../src/components/panel/InputFxPanel.vue')).default
    : (await import('../../src/components/panel/TrackFxPanel.vue')).default;
  const wrapper = shallowMount(component, { global: { stubs: { NativeCatalogParametersEditor: false } } });
  wrappers.push(wrapper);
  const title = path === 'input' ? 'INPUT B · PHASER' : 'SHARED TRACK B · PHASER';
  return { wrapper, title, engine, panelState, target };
}

describe.each(['input', 'track'] as const)('Native RC505 face %s FX official controls', (path) => {
  let panel: Awaited<ReturnType<typeof loadPanel>>;
  beforeEach(async () => { panel = await loadPanel(path); });
  it('shows host labels, bounds, enum names and partial limitations for the selected slot', async () => {
    const { wrapper, title, engine } = panel;
    const editor = wrapper.get('[data-native-catalog-parameters]');
    expect(editor.text()).toContain('RC · DEPTH');
    expect(editor.text()).toContain('Guide p.34');
    expect(editor.text()).toContain('PARTIAL: Clean-room phase response is not hardware-verified.');
    const depth = editor.get(`[aria-label="${title} official_depth"]`);
    expect(depth.attributes()).toMatchObject({ min: '0', max: '100', step: '1' });
    const stage = editor.get(`[aria-label="${title} official_stage"]`);
    expect(stage.findAll('option').map((option) => option.text())).toContain('BI-PHASE');
    expect(engine.getNativeCatalogFxParameterSchema).toHaveBeenCalledWith('PHASER', path, 0, {}, 1);
  });

  it('uses the ACK-aware setter for valid drafts and reset without directly saving edits', async () => {
    const { wrapper, title, panelState } = panel;
    const editor = wrapper.get('[data-native-catalog-parameters]');
    const depth = editor.get(`[aria-label="${title} official_depth"]`);
    const apply = editor.get('.native-catalog-actions button');
    await depth.setValue('101');
    expect(apply.attributes('disabled')).toBeDefined();
    expect(panelState.setNativeNamedParameters).not.toHaveBeenCalled();

    await depth.setValue('63');
    await editor.get(`[aria-label="${title} official_stage"]`).setValue('-1');
    expect(panelState.slots.value[1]!.namedParametersByType).toBeUndefined();
    await apply.trigger('click');
    expect(panelState.setNativeNamedParameters).toHaveBeenCalledWith(1, { official_depth: 63, official_stage: -1 });
    expect(panelState.slots.value[1]!.namedParametersByType).toBeUndefined();
    expect(editor.text()).toContain('PENDING NATIVE ACK');
    expect(apply.attributes('disabled')).toBeDefined();
    expect(depth.attributes('disabled')).toBeDefined();

    panelState.slots.value[1]!.namedParametersByType = { PHASER: { official_depth: 63, official_stage: -1 } };
    panelState.nativeNamedParametersPending.value = false;
    panelState.runtimeStatus.value.appliedRevision = 8;
    await wrapper.vm.$nextTick();
    expect(editor.text()).toContain('NATIVE ACK · REV 8');
    await editor.findAll('.native-catalog-actions button')[1]!.trigger('click');
    expect(panelState.setNativeNamedParameters).toHaveBeenLastCalledWith(1, {});
    expect(panelState.slots.value[1]!.namedParametersByType).toEqual({ PHASER: { official_depth: 63, official_stage: -1 } });
  });

  it('blocks pending, unknown and unavailable writes and reports setter rejection', async () => {
    const { wrapper, title, panelState } = panel;
    const editor = wrapper.get('[data-native-catalog-parameters]');
    const apply = editor.get('.native-catalog-actions button');
    for (const status of [{ pendingApply: true, outcomeUnknown: false }, { pendingApply: false, outcomeUnknown: true }]) {
      Object.assign(panelState.runtimeStatus.value, status);
      await wrapper.vm.$nextTick();
      expect(apply.attributes('disabled')).toBeDefined();
      await apply.trigger('click');
      expect(panelState.setNativeNamedParameters).not.toHaveBeenCalled();
    }
    Object.assign(panelState.runtimeStatus.value, { pendingApply: false, outcomeUnknown: false });
    panelState.fxDisabled.value = true;
    await wrapper.vm.$nextTick();
    expect(editor.get(`[aria-label="${title} official_depth"]`).attributes('disabled')).toBeDefined();

    panelState.fxDisabled.value = false;
    panelState.setNativeNamedParameters.mockReturnValue(false);
    await wrapper.vm.$nextTick();
    await apply.trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toContain('Native did not accept the named controls');
    panelState.activeSlot.value = 'C';
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('summary').text()).toContain(path === 'input' ? 'INPUT C' : 'SHARED TRACK C');
  });

  it('does not invent Native controls without a host schema and retains dedicated editors', async () => {
    const { wrapper, panelState } = await loadPanel(path, { schemaAvailable: false });
    expect(wrapper.find('[data-native-catalog-parameters]').exists()).toBe(false);
    expect(wrapper.get('[data-native-parameter-schema-unavailable]').text()).toContain('does not advertise a valid descriptor schema');
    panelState.slots.value[1]!.type = 'PREAMP';
    await wrapper.vm.$nextTick();
    expect(wrapper.find('preamp-fx-editor-stub').exists()).toBe(true);
    expect(wrapper.find('[data-native-parameter-schema-unavailable]').exists()).toBe(false);
    panelState.slots.value[1]!.type = 'NONE';
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-native-parameter-schema-unavailable]').exists()).toBe(false);
  });

  it('keeps Browser mode out of the Native descriptor path', async () => {
    const { wrapper, engine } = await loadPanel(path, { mode: 'browser' });
    expect(wrapper.find('[data-native-catalog-parameters]').exists()).toBe(false);
    expect(engine.getNativeCatalogFxParameterSchema).not.toHaveBeenCalled();
    if (path === 'input') expect(wrapper.find('[data-input-named-controls]').exists()).toBe(true);
  });
});

it('keeps independent Native track editing in its existing panel', async () => {
  const { wrapper, target } = await loadPanel('track');
  target.value = 3;
  await wrapper.vm.$nextTick();
  expect(wrapper.find('native-track-fx-panel-stub').exists()).toBe(true);
  expect(wrapper.find('[data-native-catalog-parameters]').exists()).toBe(false);
});
