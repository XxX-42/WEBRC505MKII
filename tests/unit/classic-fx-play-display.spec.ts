import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, reactive, ref } from 'vue';

const fixture = vi.hoisted(() => ({ engine: null as any, memory: null as any }));
vi.mock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => fixture.engine } }));
vi.mock('../../src/composables/useRc505Memory', () => ({ useRc505Memory: () => fixture.memory }));
vi.mock('../../src/composables/useFxPanelState', () => ({ useFxPanelState: () => ({}) }));
vi.mock('../../src/composables/useTrackFxTargetState', () => ({ useTrackFxTargetState: () => ({}) }));
vi.mock('../../src/composables/useDeviceScreenEditor', () => ({ useDeviceScreenEditor: () => ({
  active: ref(true), status: ref('EDITING'), fields: ref([]), pageIndex: ref(0), pageCount: ref(1),
  pageTitle: ref('FX EDIT'), selectedFieldIndex: ref(0), selectField: vi.fn(), stepPage: vi.fn(), enter: vi.fn(),
}) }));
vi.mock('../../src/composables/rhythmUiState', () => ({ rhythmUiState: {}, useRhythmUiControls: () => ({
  isPlaying: ref(false), volume: ref(100), disabled: ref(false), pending: ref(false), message: ref(''),
  toggleRhythm: vi.fn(), updateVolume: vi.fn(), updateSelection: vi.fn(),
}) }));

import CenterMainPanel from '../../src/components/panel/CenterMainPanel.vue';
import { useDevicePanel } from '../../src/composables/useDevicePanel';
import { useRc505Controls } from '../../src/composables/useRc505Controls';
import { Transport } from '../../src/core/Transport';

let wrapper: VueWrapper | null = null;
let notify: () => void;
const panel = useDevicePanel();
const slots = () => wrapper!.findAll('[data-fx-slot]');
async function pageTo(index: number) {
  const view = panel.classicState.value.view;
  if (view.kind !== 'play') throw new Error('Expected Play');
  for (let i = view.pageIndex; i < index; i++) panel.classicDispatch({ type: 'PAGE', direction: 1 });
  await nextTick();
}
async function render(index = 6) {
  wrapper = mount(CenterMainPanel, {
    props: { inputFxValue: 80, trackFxValue: 90, inputFxDisabled: false, inputFxReason: '', trackFxDisabled: false, trackFxReason: '' },
    global: { stubs: { HardwareKnob: true } },
  });
  await pageTo(index);
  return wrapper;
}

beforeEach(() => {
  useRc505Controls().reset();
  while (panel.classicState.value.returnStack.length) panel.classicDispatch({ type: 'EXIT' });
  const view = panel.classicState.value.view;
  if (view.kind === 'play') for (let i = view.pageIndex; i > 0; i--) panel.classicDispatch({ type: 'PAGE', direction: -1 });
  panel.goHome();
  fixture.memory = { state: reactive({ number: 23, name: 'Session 23', available: true, busy: false, reason: '', error: '' }),
    refresh: vi.fn(), load: vi.fn(async () => {}), save: vi.fn(), clear: vi.fn() };
  const listeners = new Set<() => void>();
  notify = () => listeners.forEach(listener => listener());
  fixture.engine = {
    tracks: [], getMode: () => 'browser', getMixerControlIdentity: () => 'fixture-browser',
    getCapabilities: () => ({ supportsInputFx: true, supportsTrackFx: true, supportsOutputLevel: true }),
    getUiStatus: () => ({ ready: true, engineRunning: true, message: 'READY', lastError: '' }),
    getTrackHasPhrase: () => false, getOutputLevel: () => 100, getMixerState: () => ({ available: true, main: 100, tracks: [] }),
    getBrowserSharedFxSnapshot: vi.fn(() => ['FILTER', 'DELAY', 'REVERB', 'SLICER'].map((type, index) => ({
      type, active: index === 0 || index === 2, state: 'ready', error: null,
    }))),
    getNativeCatalogFxSlotStatus: vi.fn(),
    onStatusChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  Transport.getInstance().setBpm(137.5);
});
afterEach(() => { wrapper?.unmount(); wrapper = null; });

describe('Classic FX Play component', () => {
  it.each([5, 6])('renders four horizontal type columns with real Memory/tempo on Play %s', async index => {
    const center = await render(index);
    expect(center.get('[data-classic-fx-display]').attributes('data-classic-fx-display')).toBe(index === 5 ? 'input' : 'track');
    expect(slots().map(slot => slot.attributes('data-fx-slot'))).toEqual(['A', 'B', 'C', 'D']);
    expect(slots().map(slot => slot.find('.fx-play-type').text())).toEqual(['FLT', 'DLY', 'REV', 'SLC']);
    expect(slots().map(slot => slot.classes().includes('is-on'))).toEqual([true, false, true, false]);
    expect(slots().every(slot => slot.attributes('data-confirmed') === 'true')).toBe(true);
    expect(center.get('[data-fx-memory-number]').text()).toBe('23');
    expect(center.get('[data-fx-memory-name]').text()).toBe('Session 23');
    expect(center.get('[data-fx-tempo]').text()).toBe('♩=137.5');
    expect(center.find('.lcd-row.top').exists()).toBe(false);
    expect(center.find('.lcd-name').exists()).toBe(false);
    expect(center.find('.lcd-status').exists()).toBe(false);
    expect(center.get('[data-fx-knob-label="1"]').text()).toBe('MEMORY');
    expect(center.get('[data-fx-knob-label="4"]').text()).toBe('');
  });
  it('uses only Native acknowledged bypass and hides pending, faulted and missing results', async () => {
    fixture.engine.getMode = () => 'native';
    fixture.engine.getNativeCatalogFxSlotStatus = (_location: string, index: number) => index === 3 ? null : ({
      acknowledged: true, acknowledgedEffectId: 'delay', appliedBypassed: false, pendingApply: index === 1,
      pendingRestart: false, outcomeUnknown: false, processingFaulted: index === 2, controlFaulted: false, error: '',
    });
    await render();
    expect(slots().map(slot => slot.attributes('data-active'))).toEqual(['ON', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    expect(slots().map(slot => slot.classes().includes('is-on'))).toEqual([true, false, false, false]);
    expect(slots().slice(1).every(slot => slot.find('.fx-play-type').text() === '--')).toBe(true);
    expect(slots()[2]!.attributes('title')).toContain('processor faulted');
    expect(wrapper!.get('.fx-play-error').text()).toContain('processor faulted');
  });
  it('does not render OFF while stopped, unsupported, or Browser processing is unresolved', async () => {
    const center = await render();
    fixture.engine.getUiStatus = () => ({ ready: false, engineRunning: false, message: 'Start audio', lastError: '' });
    notify(); await nextTick();
    expect(slots().every(slot => slot.attributes('data-active') === 'UNKNOWN' && slot.text().includes('--'))).toBe(true);
    expect(slots().some(slot => slot.classes().includes('is-on'))).toBe(false);
    fixture.engine.getUiStatus = () => ({ ready: true, engineRunning: true, message: 'READY', lastError: '' });
    fixture.engine.getBrowserSharedFxSnapshot = () => [
      { type: 'FILTER', active: false, state: 'loading', error: null },
      { type: 'DELAY', active: false, state: 'error', error: 'Delay DSP failed' },
    ];
    notify(); await nextTick();
    expect(slots().every(slot => slot.attributes('data-active') === 'UNKNOWN')).toBe(true);
    expect(center.get('.fx-play-error').attributes('title')).toBe('Delay DSP failed');
    fixture.engine.getCapabilities = () => ({ supportsInputFx: true, supportsTrackFx: false, fxReason: 'Host FX disabled' });
    notify(); await nextTick();
    expect(slots().every(slot => slot.attributes('title')!.includes('Host FX disabled'))).toBe(true);
  });
  it('keeps Memory and the running session through Play/MIXER/editor navigation; encoders are not FX columns', async () => {
    const center = await render();
    const originalEngine = fixture.engine;
    const knobs = center.findAllComponents({ name: 'HardwareKnob' });
    knobs[0]!.vm.$emit('rotate', 1); await flushPromises();
    expect(fixture.memory.load).toHaveBeenCalledWith(24);
    knobs[1]!.vm.$emit('rotate', 1); knobs[3]!.vm.$emit('rotate', 1); await nextTick();
    expect(fixture.memory.load).toHaveBeenCalledTimes(1);
    await center.get('[data-panel-control="enter"]').trigger('click');
    expect(panel.classicState.value.view).toMatchObject({ kind: 'mixer', pageIndex: 0 });
    await center.get('[data-panel-control="exit"]').trigger('click');
    expect(center.get('[data-classic-screen]').attributes('data-classic-screen')).toBe('track-fx');
    panel.classicDispatch({ type: 'OPEN_EDITOR', target: 'track-fx', category: 'track-fx' }); await nextTick();
    expect(center.find('[data-classic-fx-display]').exists()).toBe(false);
    expect(center.findComponent({ name: 'LcdFieldGrid' }).exists()).toBe(true);
    await center.get('[data-panel-control="exit"]').trigger('click');
    expect(center.get('[data-fx-memory-name]').text()).toBe('Session 23');
    expect(center.get('[data-fx-tempo]').text()).toBe('♩=137.5');
    expect(fixture.engine).toBe(originalEngine);
    fixture.memory.state.available = false; await nextTick();
    expect(center.get('[data-fx-knob-label="1"]').text()).toBe('');
  });
  it('shows serious runtime failures instead of normal footer labels', async () => {
    const center = await render();
    fixture.engine.getUiStatus = () => ({ ready: false, engineRunning: true, message: 'Waiting', lastError: 'Native callback failed' });
    notify(); await nextTick();
    expect(center.get('.fx-play-error').attributes('title')).toBe('Native callback failed');
    expect(center.find('[data-fx-knob-label]').exists()).toBe(false);
  });
  it('preserves Native restart/error readback while audio is not ready, but never advertises ACK ON', async () => {
    fixture.engine.getMode = () => 'native';
    fixture.engine.getUiStatus = () => ({ ready: false, engineRunning: false, message: 'Start Native', lastError: '' });
    fixture.engine.getNativeCatalogFxSlotStatus = (_location: string, index: number) => ({
      acknowledged: true, acknowledgedEffectId: 'delay', appliedBypassed: false, pendingApply: false,
      pendingRestart: index === 0, outcomeUnknown: false, processingFaulted: index === 1, controlFaulted: false, error: '',
    });
    await render();
    expect(slots().map(slot => slot.attributes('data-state'))).toEqual(['RESTART', 'ERROR', 'UNAVAILABLE', 'UNAVAILABLE']);
    expect(slots().every(slot => slot.attributes('data-active') === 'UNKNOWN' && !slot.classes().includes('is-on'))).toBe(true);
    expect(slots()[0]!.attributes('title')).toContain('Restart Native');
  });
  it('renders MENU and LOOP categories horizontally without software OPEN/DISABLED text', async () => {
    const center = await render(0);
    for (const root of ['menu', 'loop'] as const) {
      panel.classicDispatch({ type: 'OPEN_ROOT', root }); await nextTick();
      const group = center.get(`[data-classic-root="${root}"]`);
      expect(group.findAll('[data-root-item]')).toHaveLength(3);
      expect(group.findAll('[data-root-item]').map(item => item.attributes('data-root-encoder'))).toEqual(['1', '2', '3']);
      expect(group.text()).not.toMatch(/OPEN|DISABLED/);
      panel.classicDispatch({ type: 'EXIT' }); await nextTick();
    }
  });
  it('binds the new TRACK1-4 MIXER to actual track gains and independent measured peak data', async () => {
    const gains = [20, 40, 60, 80, 100];
    fixture.engine.getMixerState = () => ({ available: true, main: 100, tracks: [...gains] });
    fixture.engine.getTrackCapabilities = () => ({ supportsTrackLevel: true, levelReason: '' });
    fixture.engine.getTrackMeter = (id: number) => id === 1 ? { available: true, peak: 0.25, rms: 0.1, reason: '' }
      : { available: false, peak: 0, rms: 0, reason: 'Meter unavailable' };
    fixture.engine.setMixerLevel = vi.fn(async (channel: number, value: number) => { gains[channel - 1] = value; });
    const center = await render(0);
    panel.classicDispatch({ type: 'ENTER' }); panel.classicDispatch({ type: 'PAGE', direction: 1 }); await nextTick();
    const group = center.get('[data-classic-mixer="tracks"]');
    expect(group.findAll('[data-mixer-channel]').map(channel => channel.attributes('data-mixer-channel'))).toEqual(['TRACK1', 'TRACK2', 'TRACK3', 'TRACK4']);
    expect(group.findAll('.lcd-mixer-gain').map(gain => gain.text())).toEqual(['20', '40', '60', '80']);
    expect(group.findAll('[data-meter-available]').map(meter => meter.attributes('data-meter-available'))).toEqual(['true', 'false', 'false', 'false']);
    expect(group.get('[data-meter-available="true"] span').attributes('style')).toContain('25%');
    center.findAllComponents({ name: 'HardwareKnob' })[2]!.vm.$emit('rotate', 1); await flushPromises();
    expect(fixture.engine.setMixerLevel).toHaveBeenCalledWith(3, 61);
    expect(group.findAll('.lcd-mixer-gain')[2]!.text()).toBe('61');
    expect(group.findAll('[data-meter-available]')[2]!.text()).toBe('--');
  });
  it('reverts a tap session after a hold despite unchanged status polling', async () => {
    vi.useFakeTimers();
    const center = await render(0);
    const tap = center.get('[data-panel-control="tap-tempo"]');
    await tap.trigger('keydown', { key: ' ' }); await tap.trigger('keyup', { key: ' ' });
    await vi.advanceTimersByTimeAsync(500); notify(); await nextTick();
    await tap.trigger('keydown', { key: ' ' }); await tap.trigger('keyup', { key: ' ' });
    expect(Transport.getInstance().bpm).toBe(120);
    await tap.trigger('keydown', { key: ' ' }); notify(); await nextTick();
    await vi.advanceTimersByTimeAsync(1999);
    expect(Transport.getInstance().bpm).toBe(120);
    await vi.advanceTimersByTimeAsync(1);
    expect(Transport.getInstance().bpm).toBe(137.5);
    await tap.trigger('keyup', { key: ' ' });
    vi.useRealTimers();
  });

  it('invalidates the tap restoration when Memory starts', async () => {
    vi.useFakeTimers();
    const center = await render(0); const tap = center.get('[data-panel-control="tap-tempo"]');
    await tap.trigger('keydown', { key: ' ' }); await tap.trigger('keyup', { key: ' ' });
    await vi.advanceTimersByTimeAsync(500);
    await tap.trigger('keydown', { key: ' ' }); await tap.trigger('keyup', { key: ' ' });
    expect(Transport.getInstance().bpm).toBe(120);
    await tap.trigger('keydown', { key: ' ' }); fixture.memory.state.busy = true;
    fixture.memory.state.busy = false; await vi.advanceTimersByTimeAsync(2000);
    expect(Transport.getInstance().bpm).toBe(120);
    await tap.trigger('keyup', { key: ' ' }); vi.useRealTimers();
  });
  it.each([0, 1, 2, 3, 4, 5, 6])('keeps default Play knob mapping on page %s', async index => {
    const center = await render(index);
    const knobs = center.findAllComponents({ name: 'HardwareKnob' }).filter(item => item.attributes('data-panel-control')?.startsWith('screen-encoder-'));
    expect(knobs).toHaveLength(4);
    expect(knobs[0]!.props('label')).toBe('MEMORY');
    expect(knobs[0]!.props('disabled')).toBe(false);
    expect(knobs.slice(1).every(item => item.props('disabled'))).toBe(true);
    knobs[0]!.vm.$emit('rotate', 1); await flushPromises();
    expect(fixture.memory.load).toHaveBeenCalledWith(24);
  });

  it('shows a concise Browser startup hint and preserves the diagnostic title', async () => {
    fixture.engine.getUiStatus = () => ({ mode: 'browser', ready: false, engineRunning: false, message: 'BROWSER AUDIO NOT INITIALIZED', lastError: '' });
    const center = await render(0); const status = center.get('.lcd-status');
    expect(status.text()).toBe('AUDIO OFF');
    expect(status.attributes('title')).toBe('BROWSER AUDIO NOT INITIALIZED');
  });

  it('changes encoder gesture context when the Native host identity changes', async () => {
    let identity = 'host-a'; fixture.engine.getMixerControlIdentity = () => identity;
    const center = await render(0);
    const knob = () => center.findAllComponents({ name: 'HardwareKnob' }).find(item => item.attributes('data-panel-control') === 'screen-encoder-1')!;
    const before = knob().props('interactionContextKey');
    identity = 'host-b'; notify(); await nextTick();
    expect(knob().props('interactionContextKey')).not.toBe(before);
    expect(knob().props('interactionContextKey')).toContain('host-b');
  });

  it('refreshes Browser output from applied gain after a delayed render quantum', async () => {
    vi.useFakeTimers(); let applied = 100;
    fixture.engine.getOutputLevel = () => applied;
    fixture.engine.setMixerLevel = vi.fn(async () => {});
    const center = await render(0);
    const output = () => center.findAllComponents({ name: 'HardwareKnob' }).find(item => item.attributes('data-panel-control') === 'output-level')!;
    output().vm.$emit('update:modelValue', 0); await Promise.resolve(); await nextTick();
    expect(output().props('modelValue')).toBe(100);
    applied = 0; await vi.advanceTimersByTimeAsync(150); await nextTick();
    expect(output().props('modelValue')).toBe(0);
    vi.useRealTimers();
  });

});
