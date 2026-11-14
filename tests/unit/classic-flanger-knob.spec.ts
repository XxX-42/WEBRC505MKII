import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, nextTick, reactive, ref } from 'vue';

async function setup(mode: 'browser' | 'native', official = true) {
  vi.resetModules();
  const slots = ref(['A', 'B', 'C', 'D'].map(id => ({ id, type: 'FLANGER', active: false, value: 35, namedParametersByType: official ? { FLANGER: { official_e_level: 50, official_depth: 70 } } : undefined })));
  const activeSlot = ref('A');
  const status = reactive({ acknowledged: true, acknowledgedEffectId: 'flanger', appliedBypassed: false, pendingApply: false, pendingRestart: false, outcomeUnknown: false, processingFaulted: false, controlFaulted: false, error: '', acknowledgedParameters: official ? { official_e_level: 50, official_depth: 70 } : {} });
  const browser = reactive({ type: 'FLANGER', state: 'ready', active: false, parameters: official ? { official_e_level: 50, official_depth: 70 } : {} });
  const setNamed = vi.fn(() => true);
  const engine = { getMode: () => mode, getMixerControlIdentity: () => 'host', getNativeCatalogFxSlotStatus: () => status, getBrowserSharedFxSnapshot: () => [browser, browser, browser, browser] };
  const bank = { slots, activeSlot, fxDisabled: ref(false), fxUnavailableReason: ref(''), nativeNamedParametersPending: ref(false), selectSlot: (id: string) => { activeSlot.value = id; }, setNativeNamedParameters: setNamed };
  const banks = { state: reactive({ busy: false, error: '', unavailableReason: '', requestedBank: 'A', appliedBank: 'A' }), canSelect: ref(true), selectBank: vi.fn() };
  const controls = { state: reactive({ fxLayers: { input: 'NORMAL', track: 'NORMAL' } }), setFxLayer: vi.fn(), setFxBusy: vi.fn(), reportError: vi.fn(), clearError: vi.fn() };
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine } }));
  vi.doMock('../../src/composables/useFxPanelState', () => ({ useFxPanelState: () => bank }));
  vi.doMock('../../src/composables/useRc505FxBanks', () => ({ useRc505FxBanks: () => banks }));
  vi.doMock('../../src/composables/useRc505Controls', () => ({ useRc505Controls: () => controls }));
  vi.doMock('../../src/composables/useRc505Memory', () => ({ useRc505Memory: () => ({ state: reactive({ busy: false }) }) }));
  vi.doMock('../../src/composables/useTrackFxTargetState', () => ({ useTrackFxTargetState: () => ({ target: computed(() => 'shared'), selectTarget: vi.fn() }) }));
  vi.doMock('../../src/composables/useRc505FxSwitchSettings', () => ({ selectRc505FxSwitchBank: vi.fn(), useRc505FxSwitchSettings: () => ({ state: reactive({ error: '', adoptionRevision: 0, settings: { switchModes: { A: 'TOGGLE', B: 'TOGGLE', C: 'TOGGLE', D: 'TOGGLE' } } }) }) }));
  const component = (await import('../../src/components/panel/FxBankControls.vue')).default;
  const wrapper = mount(component, { props: { location: 'input', title: 'INPUT FX', color: 'red', modelValue: 35 }, global: { stubs: { HardwareButton: true } } });
  return { wrapper, slots, activeSlot, status, browser, setNamed, pending: bank.nativeNamedParametersPending };
}
function pointer(type: string, props: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
  window.dispatchEvent(event);
}
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });
describe('Classic FLANGER knob routing', () => {
  it('edits only official E.LEVEL in Browser confirmed official mode', async () => {
    const h = await setup('browser');
    const knob = h.wrapper.get('[role="slider"]');
    expect(knob.attributes('aria-valuenow')).toBe('50');
    await knob.trigger('keydown', { key: 'ArrowUp' });
    expect(h.slots.value[0]!.namedParametersByType!.FLANGER).toEqual({ official_e_level: 51, official_depth: 70 });
    expect(h.slots.value[0]!.value).toBe(35);
    expect(h.wrapper.emitted('update:modelValue')).toBeUndefined();
    h.wrapper.unmount();
  });
  it.each(['browser', 'native'] as const)('keeps %s legacy FLANGER amount usable without converting named parameters', async mode => {
    const h = await setup(mode, false);
    const knob = h.wrapper.get('[role="slider"]');
    expect(knob.attributes('aria-disabled')).toBe('false');
    await knob.trigger('keydown', { key: 'ArrowUp' });
    expect(h.slots.value[0]!.namedParametersByType).toBeUndefined();
    expect(h.wrapper.emitted('update:modelValue')).toEqual([[36]]);
    h.wrapper.unmount();
  });
  it('uses acknowledged Native value and refuses unknown or rejected status', async () => {
    const h = await setup('native');
    const knob = h.wrapper.get('[role="slider"]');
    expect(knob.attributes('aria-valuenow')).toBe('50');
    await knob.trigger('keydown', { key: 'ArrowUp' });
    expect(h.setNamed).toHaveBeenCalledWith(0, { official_e_level: 51, official_depth: 70 });
    expect(knob.attributes('aria-valuenow')).toBe('50');
    h.pending.value = true; h.status.pendingApply = true; h.status.acknowledged = false;
    await nextTick();
    expect(knob.attributes('aria-disabled')).toBe('true');
    expect(knob.attributes('aria-valuenow')).toBe('50');
    h.status.acknowledgedParameters.official_e_level = 51;
    h.status.pendingApply = false; h.status.acknowledged = true; h.pending.value = false;
    await nextTick();
    expect(knob.attributes('aria-valuenow')).toBe('51');
    h.setNamed.mockReturnValueOnce(false);
    await knob.trigger('keydown', { key: 'ArrowUp' });
    expect(h.wrapper.get('[role="status"]').text()).toContain('Native did not accept');
    expect(knob.attributes('aria-valuenow')).toBe('51');
    h.setNamed.mockClear();
    h.status.outcomeUnknown = true;
    await nextTick();
    expect(knob.attributes('aria-disabled')).toBe('true');
    await knob.trigger('keydown', { key: 'ArrowUp' });
    expect(h.setNamed).not.toHaveBeenCalled();
    h.status.outcomeUnknown = false; h.status.acknowledged = false; h.status.error = 'rejected';
    await nextTick();
    expect(knob.attributes('aria-disabled')).toBe('true');
    await knob.trigger('keydown', { key: 'ArrowUp' });
    expect(h.setNamed).not.toHaveBeenCalled();
    h.wrapper.unmount();
  });
  it('cancels a drag after changing the selected slot', async () => {
    const h = await setup('browser');
    const knob = h.wrapper.get('[role="slider"]');
    await knob.trigger('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0 });
    h.activeSlot.value = 'B'; await nextTick();
    pointer('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: -40 });
    await nextTick();
    expect(h.slots.value[1]!.namedParametersByType!.FLANGER.official_e_level).toBe(50);
    expect(h.wrapper.emitted('update:modelValue')).toBeUndefined();
    h.wrapper.unmount();
  });
});
