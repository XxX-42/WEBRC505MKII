import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { Track } from '../../src/core/types';
import { TrackAudio } from '../../src/audio/TrackAudio';
import { useDevicePanel } from '../../src/composables/useDevicePanel';
import { useDeviceScreenEditor } from '../../src/composables/useDeviceScreenEditor';
import { useRc505Memory } from '../../src/composables/useRc505Memory';

const fixture = vi.hoisted(() => ({ engine: null as any }));
vi.mock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => fixture.engine } }));
vi.mock('../../src/composables/useFxPanelState', () => ({ useFxPanelState: () => ({}) }));
vi.mock('../../src/composables/useTrackFxTargetState', () => ({ useTrackFxTargetState: () => ({}) }));
vi.mock('../../src/composables/useBrowserTrackFxState', () => ({ useBrowserTrackFxState: () => ({}) }));
vi.mock('../../src/composables/useNativeTrackFxState', () => ({ useNativeTrackFxState: () => ({}) }));
vi.mock('../../src/composables/rhythmUiState', () => ({ useRhythmUiControls: () => ({}), rhythmUiState: {} }));
vi.mock('../../src/composables/deviceTrackControllers', () => ({ getDeviceTrackController: () => new Proxy({}, { get: (_, key) => ({ value: key === 'nativeHqRendererEngines' ? [] : key === 'livePitchMode' ? 'OFF' : key === 'hqWavFormat' ? 'pcm16' : 0 }) }) }));

const scopes: ReturnType<typeof effectScope>[] = [];
const panel = useDevicePanel();
function createEditor(category: string, target: 'track' | 'menu' = 'track', confirm = vi.fn(async () => true)) {
  panel.openPage(target);
  panel.classicDispatch({ type: 'OPEN_EDITOR', target, category });
  const scope = effectScope(); scopes.push(scope);
  return { editor: scope.run(() => useDeviceScreenEditor({ surface: 'classic', confirm }))!, confirm };
}
async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); }

beforeEach(() => {
  const track = new Track(1);
  const audio = { track, disposed: false, gainNode: { gain: { value: 1 } }, panNode: { pan: { value: 0 } },
    updateSettings() { TrackAudio.prototype.updateSettings.call(this as any); } };
  fixture.engine = { tracks: [audio], monitoringEnabled: false, getMode: () => 'browser',
    getUiStatus: () => ({ ready: true }), onStatusChange: () => () => {},
    getTrackCapabilities: () => ({ supportsReverse: true }), getTrackFxApply: () => [],
    setMonitoring: vi.fn(async (enabled: boolean) => { fixture.engine.monitoringEnabled = enabled; }),
    getDevices: vi.fn(async () => ({ inputs: [], outputs: [] })) };
});
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); panel.goHome(); useRc505Memory().state.busy = false; });

describe('Classic existing audio controls', () => {
  it('blocks stale LCD edit callbacks while Memory is publishing and restores editing afterwards', async () => {
    const { editor } = createEditor('track');
    const stalePan = editor.fields.value.find(field => field.key === 'track-pan')!;
    useRc505Memory().state.busy = true;
    expect(editor.fields.value.every(field => field.disabled)).toBe(true);
    stalePan.setValue!(50); await settle();
    expect(fixture.engine.tracks[0].track.pan).toBe('CENTER');
    useRc505Memory().state.busy = false;
    editor.fields.value.find(field => field.key === 'track-pan')!.setValue!(-10); await settle();
    expect(fixture.engine.tracks[0].track.pan).toBe('L10');
  });
  it('binds official L50–CENTER–R50 PAN to the real Browser panner update', async () => {
    const { editor } = createEditor('track');
    expect(editor.fields.value.map(field => field.key)).toEqual(['track-level', 'track-reverse', 'track-fx-apply', 'track-pan']);
    for (const [value, text, dsp] of [[-50, 'L50', -1], [0, 'CENTER', 0], [50, 'R50', 1]] as const) {
      const field = editor.fields.value.find(field => field.key === 'track-pan')!;
      expect([field.min, field.max, field.step]).toEqual([-50, 50, 1]);
      field.setValue!(value); await settle();
      expect(fixture.engine.tracks[0].track.pan).toBe(text);
      expect(fixture.engine.tracks[0].panNode.pan.value).toBe(dsp);
      expect(editor.fields.value.find(field => field.key === 'track-pan')!.format!(value)).toBe(text);
    }
  });
  it('leaves Native PAN explicitly disabled without changing its track', () => {
    fixture.engine.getMode = () => 'native';
    const { editor } = createEditor('track');
    const field = editor.fields.value.find(field => field.key === 'track-pan')!;
    expect(field.disabled).toBe(true); expect(field.reason).toContain('no audio provider');
    field.setValue!(50); expect(fixture.engine.tracks[0].track.pan).toBe('CENTER');
  });
  it('places global INPUT THRU under OUTPUT / ROUTING / INPUT/RHYTHM and retains confirmation', async () => {
    const { editor, confirm } = createEditor('output', 'menu');
    expect(editor.fields.value.map(field => field.label)).toEqual(['ROUTING']);
    editor.fields.value[0]!.activate!(); await settle();
    expect(editor.pageTitle.value).toBe('OUTPUT / ROUTING');
    expect(editor.fields.value.slice(1).every(field => field.disabled)).toBe(true);
    editor.fields.value[0]!.activate!(); await settle();
    expect(editor.pageTitle.value).toBe('ROUTING / INPUT/RHYTHM');
    expect(editor.status.value).toContain('PARTIAL SOFTWARE ROUTE');
    editor.fields.value[0]!.setValue!(100); await settle(); await settle();
    expect(confirm).toHaveBeenCalledOnce(); expect(fixture.engine.setMonitoring).toHaveBeenCalledWith(true);
    expect(editor.fields.value[0]!.value).toBe(100);
    expect(editor.fields.value[1]!.disabled).toBe(true);
  });
  it('does not enable monitoring after canceled confirmation and surfaces provider errors', async () => {
    const { editor } = createEditor('output-input-rhythm', 'menu', vi.fn(async () => false));
    editor.fields.value[0]!.setValue!(100); await settle();
    expect(fixture.engine.setMonitoring).not.toHaveBeenCalled();
    fixture.engine.setMonitoring.mockRejectedValueOnce(new Error('monitor rejected'));
    editor.fields.value[0]!.setValue!(0); await settle(); await settle();
    expect(editor.status.value).toBe('monitor rejected');
    expect(editor.fields.value[0]!.value).toBe(0);
  });
});
