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
function createEditor(category: string, target: 'track' | 'menu' | 'memory' = 'track', confirm = vi.fn(async () => true)) {
  panel.openPage(target);
  panel.classicDispatch({ type: 'OPEN_EDITOR', target, category });
  const scope = effectScope(); scopes.push(scope);
  return { editor: scope.run(() => useDeviceScreenEditor({ surface: 'classic', confirm }))!, confirm };
}
async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); }

beforeEach(() => {
  const track = new Track(1);
  const audio = { track, disposed: false, gainNode: { gain: { value: 1 } }, panNode: { pan: { value: 0 } },
    playbackSourceOutput: { gain: { value: 1 } }, historyBusy: false,
    updateSettings() { TrackAudio.prototype.updateSettings.call(this as any); } };
  fixture.engine = { tracks: [audio], monitoringEnabled: false, getMode: () => 'browser',
    getUiStatus: () => ({ ready: true }), onStatusChange: () => () => {},
    getTrackCapabilities: () => ({ supportsReverse: true }), getTrackFxApply: () => [],
    getNativeDubModeStatus: () => null,
    getBrowserAutoRecSettings: () => null,
    getBrowserBounceSettings: () => null, getNativeBounceSettings: () => null,
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
  it('binds per-track DUB MODE options to the authored track setting on the Classic LCD', async () => {
    const { editor } = createEditor('track');
    editor.stepPage(1);
    const field = editor.fields.value.find(item => item.key === 'track-dub-mode')!;
    expect(field.label).toBe('DUB MODE');
    expect(field.options?.map(option => option.label)).toEqual(['OVERDUB', 'REPLACE1', 'REPLACE2']);
    expect(field.value).toBe(0);
    await field.setValue!(2); await settle();
    expect(fixture.engine.tracks[0].track.dubMode).toBe('REPLACE2');
    expect(editor.fields.value.find(item => item.key === 'track-dub-mode')?.value).toBe(2);
    fixture.engine.tracks[0].historyBusy = true;
    await field.setValue!(0); await settle();
    expect(fixture.engine.tracks[0].track.dubMode).toBe('REPLACE2');
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
  it('disables unsupported Native QUANTIZE and surfaces rejected REC ACTION writes', async () => {
    fixture.engine.getMode = () => 'native';
    fixture.engine.getRecordPlaySettings = vi.fn(() => ({ available: true, recActionAvailable: true,
      quantizeAvailable: false, reason: 'Native recording quantization is unavailable.',
      recAction: 'REC->PLAY', quantize: null, autoRecAvailable: false, bounceAvailable: false }));
    fixture.engine.setRecordPlaySettings = vi.fn(async () => { throw new Error('REC ACTION write rejected'); });
    const { editor } = createEditor('recording', 'memory');
    const recAction = editor.fields.value.find(field => field.key === 'rec-action')!;
    const quantize = editor.fields.value.find(field => field.key === 'record-quantize')!;
    expect(recAction.disabled).toBe(false);
    expect(quantize.disabled).toBe(true);
    expect(quantize.reason).toContain('quantization is unavailable');

    await recAction.setValue!(0);
    await settle(); await settle();
    expect(fixture.engine.setRecordPlaySettings).toHaveBeenCalledWith({ recAction: 'REC->DUB' });
    expect(editor.status.value).toBe('REC ACTION write rejected');
  });
  it('keeps Browser QUANTIZE available when the Browser provider reports availability only', () => {
    fixture.engine.getRecordPlaySettings = vi.fn(() => ({ available: true, reason: '', recAction: 'REC->PLAY',
      quantize: 'MEASURE', autoRecAvailable: false, bounceAvailable: false }));
    const { editor } = createEditor('recording', 'memory');
    expect(editor.fields.value.find(field => field.key === 'record-quantize')?.disabled).toBe(false);
  });
  it('binds Browser Bounce switches to the selected source and destination and keeps Native unavailable without a provider', async () => {
    let bounce = { bounceSw: false, bounceIn: [false, false, false, false, false], bounceTrack: [false, false, false, false, false] };
    fixture.engine.getBrowserBounceSettings = () => ({ ...bounce, bounceIn: [...bounce.bounceIn], bounceTrack: [...bounce.bounceTrack] });
    fixture.engine.setBrowserBounceSettings = vi.fn((value) => { bounce = value; });
    fixture.engine.getRecordPlaySettings = () => ({ available: true, reason: '', recAction: 'REC->PLAY', quantize: 'OFF', autoRecAvailable: false, bounceAvailable: true });
    const recording = createEditor('recording', 'memory').editor;
    recording.fields.value.find(field => field.key === 'bounce-sw')!.setValue!(100);
    await settle(); await settle();
    expect(bounce.bounceSw).toBe(true);
    recording.stepPage(1); await settle();
    recording.fields.value.find(field => field.key === 'bounce-track-2')!.setValue!(100);
    await settle(); await settle();
    expect(bounce.bounceTrack).toEqual([false, true, false, false, false]);
    panel.goHome();
    const track = createEditor('track').editor;
    track.stepPage(1); await settle();
    track.fields.value.find(field => field.key === 'track-bounce-in')!.setValue!(100);
    await settle(); await settle();
    expect(bounce.bounceIn).toEqual([true, false, false, false, false]);
    fixture.engine.getMode = () => 'native';
    fixture.engine.getBrowserBounceSettings = () => null;
    panel.goHome();
    const native = createEditor('recording', 'memory').editor;
    expect(native.fields.value.find(field => field.key === 'bounce')?.disabled).toBe(true);
  });
  it('exposes 1SHOT on the selected Browser track and blocks changes while playing', async () => {
    fixture.engine.tracks[0].state = 'STOPPED';
    const { editor } = createEditor('track');
    editor.stepPage(1); await settle();
    const oneShot = editor.fields.value.find(field => field.key === 'track-one-shot')!;
    expect(oneShot.disabled).toBe(false);
    oneShot.setValue!(100); await settle(); await settle();
    expect(fixture.engine.tracks[0].track.oneShot).toBe('ON');
    fixture.engine.tracks[0].state = 'PLAYING';
    oneShot.setValue!(0); await settle(); await settle();
    expect(fixture.engine.tracks[0].track.oneShot).toBe('ON');
    expect(editor.status.value).toContain('Stop the track');
  });
  it('edits LOOP SYNC for the selected Browser track and rejects edits during recording', async () => {
    const { editor } = createEditor('track');
    editor.stepPage(1); await settle();
    const sync = editor.fields.value.find(field => field.key === 'track-loop-sync')!;
    expect(sync.disabled).toBe(false);
    sync.setValue!(100); await settle(); await settle();
    expect(fixture.engine.tracks[0].track.loopSyncSw).toBe('ON');
    fixture.engine.tracks[0].state = 'RECORDING';
    sync.setValue!(0); await settle(); await settle();
    expect(fixture.engine.tracks[0].track.loopSyncSw).toBe('ON');
    expect(editor.status.value).toContain('Finish recording');
  });
});
