import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { TrackAudio } from '../../src/audio/TrackAudio';
import { Transport } from '../../src/core/Transport';
import { createMockAudioContext } from '../helpers/audioTestUtils';

function harness() {
  const context = createMockAudioContext();
  context.suspend = vi.fn(async () => { Object.defineProperty(context, 'state', { configurable: true, value: 'suspended' }); });
  context.resume = vi.fn(async () => { Object.defineProperty(context, 'state', { configurable: true, value: 'running' }); });
  const engine = new BrowserAudioEngine({ context, loadDevicePreferences: false, deferTransportBpmChangeSubscription: true });
  const runtime = engine.createRc505MemoryRuntime();
  const seed = (value: number) => {
    const buffers = Array.from({ length: 5 }, (_, index) => {
      const buffer = context.createBuffer(1, 4, 44100); buffer.getChannelData(0).fill(value + index); return buffer;
    });
    expect(TrackAudio.restoreProjectBuffersAtomically(engine.tracks, buffers).ok).toBe(true);
  };
  return { context, engine, runtime, seed };
}

beforeEach(() => { Transport.getInstance().stop(); Transport.getInstance().resetMasterTrack(); Transport.getInstance().setBpm(120); });
afterEach(() => vi.unstubAllGlobals());

describe('Browser semantic Memory', () => {
  it('advertises the implemented Browser AutoRec capability independently of its current switch', () => {
    const { engine } = harness();
    expect(engine.getBrowserAutoRecSettings().enabled).toBe(false);
    expect(engine.getRecordPlaySettings().autoRecAvailable).toBe(true);
  });
  it('uses independent stereo analyser channels for nonzero pre-shared-FX meters', () => {
    const { engine } = harness();
    const track = engine.tracks[0] as any;
    track.sharedTrackFxMeterLeft.samples = Float32Array.of(0.25, -0.25);
    track.sharedTrackFxMeterRight.samples = Float32Array.of(0.75, -0.75);
    expect(track.getPostFaderPreSharedTrackFxMeter()).toEqual({ peak: 0.75, rms: Math.sqrt((0.25 ** 2 + 0.75 ** 2) / 2) });
    const other = engine.tracks[1] as any;
    expect(other.getPostFaderPreSharedTrackFxMeter()).toEqual({ peak: 0, rms: 0 });
  });
  it('captures five PCM tracks, settings, private/shared banks and acknowledged gates', async () => {
    const { runtime, engine, seed } = harness(); seed(1);
    engine.tracks[2]!.track.pan = -23;
    const doc = await runtime.capture();
    expect(doc.semantics.fields['track.3.pan']?.value).toBe('L23');
    const state = doc.extensions.WEBRC.browserMemory as any;
    expect(state.tracks).toHaveLength(5); expect(state.fx.privateTracks).toHaveLength(5);
    expect(state.trackFxApply).toEqual([true, true, true, true, true]);
    expect(doc.archive.byteLength).toBeGreaterThan(100);
  });

  it.each(['track.1.pan', 'record.recAction', 'mixer.main'])('rejects a %s semantic/configuration contradiction before preparation', async (address) => {
    const { runtime, engine, seed } = harness(); seed(1);
    const document = await runtime.capture();
    document.semantics.fields[address]!.value = 'inconsistent';
    const prepare = vi.spyOn(engine, 'prepareMemoryConfiguration');
    await expect(runtime.prepare(document, runtime.revision())).rejects.toThrow(/disagrees/);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects unknown supported claims but preserves unavailable fields and foreign WEBRC metadata', async () => {
    const { runtime, seed } = harness(); seed(1);
    const document = await runtime.capture();
    document.semantics.fields['routing.hardwareOutput'] = { availability: 'supported', value: 7 };
    await expect(runtime.prepare(document, runtime.revision())).rejects.toThrow(/unsupported semantic/);
    document.semantics.fields['routing.hardwareOutput'] = { availability: 'unknown', value: null, reason: 'Hardware output not exposed by Browser.' };
    document.extensions.WEBRC.customAuthor = { label: 'preserve' };
    const candidate = await runtime.prepare(document, runtime.revision()); await candidate.commit(); await candidate.dispose();
    const captured = await runtime.capture();
    expect(captured.semantics.fields['routing.hardwareOutput']).toEqual(document.semantics.fields['routing.hardwareOutput']);
    expect(captured.extensions.WEBRC.customAuthor).toEqual({ label: 'preserve' });
  });

  it('rejects settings ABA edits after preparation and retains all five PCM identities', async () => {
    const { runtime, engine, seed } = harness(); seed(1);
    const doc = await runtime.capture(); seed(9);
    const before = engine.tracks.map((track) => track.getRecoverySnapshot().buffer);
    const candidate = await runtime.prepare(doc, runtime.revision());
    const revision = runtime.revision();
    engine.tracks[0]!.track.playLevel = 20; engine.tracks[0]!.track.playLevel = 100;
    expect(runtime.revision()).not.toBe(revision);
    await expect(candidate.commit()).rejects.toThrow(/changed/);
    expect(engine.tracks.map((track) => track.getRecoverySnapshot().buffer)).toEqual(before);
    await candidate.dispose();
  });

  it('publishes prepared settings and all PCM behind a suspension fence without replacing tracks', async () => {
    const { runtime, engine, context, seed } = harness(); seed(1);
    engine.tracks[1]!.track.playLevel = 42;
    engine.setMixerLevel('MAIN', 47); engine.setMixerLevel('MASTER', 83);
    engine.setRecordPlaySettings({ recAction: 'REC->DUB', quantize: 'OFF' });
    const doc = await runtime.capture(); seed(9); engine.tracks[1]!.track.playLevel = 91;
    engine.setMixerLevel('MAIN', 100); engine.setMixerLevel('MASTER', 100);
    engine.setRecordPlaySettings({ recAction: 'REC->PLAY', quantize: 'MEASURE' });
    const identities = engine.tracks.slice();
    const candidate = await runtime.prepare(doc, runtime.revision());
    await candidate.commit(); await candidate.dispose();
    expect(engine.tracks).toEqual(identities);
    expect(engine.tracks[1]!.track.playLevel).toBe(42);
    expect(engine.getMixerState()).toMatchObject({ main: 47, master: 83 });
    expect(engine.getRecordPlaySettings()).toMatchObject({ recAction: 'REC->DUB', quantize: 'OFF' });
    expect(engine.tracks.map((track) => track.getProjectPcmSnapshot()!.channelData[0]![0])).toEqual([1, 2, 3, 4, 5]);
    expect(engine.tracks.every((track) => !track.canUndo && !track.canRedo)).toBe(true);
    expect(context.suspend).toHaveBeenCalledOnce(); expect(context.resume).toHaveBeenCalledOnce();
  });

  it('keeps incumbent PCM and parameters on allocation and graph-publication failures', async () => {
    const { runtime, engine, context, seed } = harness(); seed(1);
    const doc = await runtime.capture(); seed(9); engine.tracks[0]!.track.playLevel = 77;
    const before = engine.tracks.map((track) => track.getRecoverySnapshot().buffer);
    const allocate = context.createBuffer;
    context.createBuffer = vi.fn(() => { throw new Error('allocation budget'); });
    await expect(runtime.prepare(doc, runtime.revision())).rejects.toThrow('allocation budget');
    context.createBuffer = allocate;
    const candidate = await runtime.prepare(doc, runtime.revision());
    vi.spyOn(engine.tracks[2]!, 'replaceTrackFxInsert').mockImplementationOnce(() => { throw new Error('graph connection failure'); });
    await expect(candidate.commit()).rejects.toThrow('graph connection failure');
    expect(engine.tracks.map((track) => track.getRecoverySnapshot().buffer)).toEqual(before);
    expect(engine.tracks[0]!.track.playLevel).toBe(77);
    await candidate.dispose();
  });

  it('recalls CENTER/L/R pans through the Track setter and restores them on a late publication rejection', async () => {
    const { runtime, engine, seed } = harness(); seed(1);
    [0, -50, 31, -12, 50].forEach((pan, index) => { engine.tracks[index]!.track.pan = pan; });
    Transport.getInstance().setBpm(130);
    const document = await runtime.capture();
    [15, 0, -20, 22, -50].forEach((pan, index) => { engine.tracks[index]!.track.pan = pan; });
    Transport.getInstance().setBpm(140);
    const beforePcm = engine.tracks.map((track) => track.getRecoverySnapshot().buffer);
    const candidate = await runtime.prepare(document, runtime.revision());
    const restore = vi.spyOn(TrackAudio, 'restoreProjectBuffersAtomically').mockReturnValueOnce({ ok: false, reason: 'injected publication rejection' });
    await expect(candidate.commit()).rejects.toThrow('injected publication rejection');
    expect(engine.tracks.map((track) => track.track.pan)).toEqual(['R15', 'CENTER', 'L20', 'R22', 'L50']);
    expect(engine.tracks.map((track) => track.getRecoverySnapshot().buffer)).toEqual(beforePcm);
    expect(Transport.getInstance().bpm).toBe(140);
    restore.mockRestore(); await candidate.dispose();
    const valid = await runtime.prepare(document, runtime.revision());
    await valid.commit(); await valid.dispose();
    expect(engine.tracks.map((track) => track.track.pan)).toEqual(['CENTER', 'L50', 'R31', 'L12', 'R50']);
    expect(Transport.getInstance().bpm).toBe(130);
  });

  it.each(['bpm-change', 'time-signature-change'])('restores transport even when %s observers keep throwing', async (event) => {
    const { runtime, engine, seed } = harness(); seed(1);
    const transport = Transport.getInstance();
    transport.timeSignature = [3, 4]; transport.setBpm(130);
    const document = await runtime.capture();
    transport.timeSignature = [4, 4]; transport.setBpm(140); seed(9);
    const before = engine.tracks.map((track) => track.getRecoverySnapshot().buffer);
    const candidate = await runtime.prepare(document, runtime.revision());
    const throwing = () => { throw new Error('observer keeps throwing'); };
    transport.on(event, throwing);
    try {
      await expect(candidate.commit()).rejects.toThrow('observer keeps throwing');
      expect(transport.bpm).toBe(140); expect(transport.timeSignature).toEqual([4, 4]);
      expect(engine.tracks.map((track) => track.getRecoverySnapshot().buffer)).toEqual(before);
    } finally { transport.off(event, throwing); await candidate.dispose(); }
  });

  it('fails closed without a render adapter instead of mutating incumbent gates', async () => {
    const { runtime, engine, seed } = harness(); seed(1);
    const doc = await runtime.capture(); (doc.extensions.WEBRC.browserMemory as any).trackFxApply[0] = false;
    const before = runtime.revision();
    await expect(runtime.prepare(doc, before)).rejects.toThrow(/AudioWorklet/);
    expect(runtime.revision()).toBe(before); expect(engine.getTrackFxApply(1)[0]!.applied).toBe(true);
  });

  it('prepares different gates on replacement worklets and publishes both paths with the PCM', async () => {
    const nodes: any[] = [];
    class Worklet {
      onprocessorerror = null;
      port = { onmessage: null as null | ((event: any) => void), close: vi.fn(), postMessage: (message: any) => {
        if (message.type !== 'SET_TRACK_FX_APPLY') return;
        queueMicrotask(() => this.port.onmessage?.({ data: { type: 'TRACK_FX_APPLY_ACK', route: this.name.includes('input') ? 'input' : 'track',
          trackIndex: message.trackIndex, revision: message.revision, enabled: message.enabled,
          requestedFrame: message.applyFrame, appliedFrame: message.applyFrame, ok: true } }));
      } };
      constructor(_context: AudioContext, readonly name: string) { nodes.push(this); }
      connect() {} disconnect() {}
    }
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const { runtime, engine, seed } = harness(); seed(1);
    const doc = await runtime.capture(); (doc.extensions.WEBRC.browserMemory as any).trackFxApply = [false, true, false, true, false];
    seed(9);
    const before = runtime.revision();
    const candidate = await runtime.prepare(doc, before);
    expect(runtime.revision()).toBe(before);
    expect(engine.getTrackFxApply().map((gate) => gate.applied)).toEqual([true, true, true, true, true]);
    await candidate.commit(); await candidate.dispose();
    expect(engine.getTrackFxApply().map((gate) => gate.applied)).toEqual([false, true, false, true, false]);
    expect(engine.getTrackFxApply().every((gate) => !gate.pending && gate.inputAppliedRevision === gate.trackAppliedRevision)).toBe(true);
    expect(engine.tracks[0]!.getProjectPcmSnapshot()!.channelData[0]![0]).toBe(1);
    expect(nodes).toHaveLength(2);
  });

  it('rejects a staged gate processor failure after readiness without publishing PCM or gates', async () => {
    const nodes: any[] = [];
    class Worklet {
      onprocessorerror: null | (() => void) = null;
      port = { onmessage: null as null | ((event: any) => void), close: vi.fn(), postMessage: (message: any) => {
        if (message.type === 'SET_TRACK_FX_APPLY') queueMicrotask(() => this.port.onmessage?.({ data: {
          ...message, type: 'TRACK_FX_APPLY_ACK', route: this.name.includes('input') ? 'input' : 'track',
          requestedFrame: message.applyFrame, appliedFrame: message.applyFrame, ok: true,
        } }));
      } };
      constructor(_context: AudioContext, readonly name: string) { nodes.push(this); }
      connect() {} disconnect() {}
    }
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const { runtime, engine, seed } = harness(); seed(1);
    const document = await runtime.capture(); (document.extensions.WEBRC.browserMemory as any).trackFxApply[0] = false;
    seed(9); const before = runtime.revision();
    const pcm = engine.tracks.map((track) => track.getRecoverySnapshot().buffer);
    const candidate = await runtime.prepare(document, before);
    nodes[1].onprocessorerror();
    await expect(candidate.commit()).rejects.toThrow(/processor failed/);
    expect(runtime.revision()).toBe(before); expect(engine.getTrackFxApply(1)[0]!.applied).toBe(true);
    expect(engine.tracks.map((track) => track.getRecoverySnapshot().buffer)).toEqual(pcm);
    await candidate.dispose(); expect(nodes.every((node) => node.port.close.mock.calls.length === 1)).toBe(true);
  });
});


describe('Browser AutoRec authored Memory settings', () => {
  it('captures, restores and validates AutoRec semantic settings independently of live arms', async () => {
    const { engine, runtime, seed } = harness(); seed(1);
    engine.setBrowserAutoRecSettings({ enabled: true, sensitivity: 73 });
    const document = await runtime.capture();
    expect(document.semantics.fields['record.autoRecSw']).toMatchObject({ availability: 'supported', value: true });
    expect(document.semantics.fields['record.autoRecSens']).toMatchObject({ availability: 'supported', value: 73 });
    engine.setBrowserAutoRecSettings({ enabled: false, sensitivity: 50 });
    const candidate = await runtime.prepare(document, runtime.revision()); await candidate.commit(); await candidate.dispose();
    expect(engine.getBrowserAutoRecSettings()).toEqual({ enabled: true, sensitivity: 73 });
    document.semantics.fields['record.autoRecSens']!.value = 5;
    await expect(runtime.prepare(document, runtime.revision())).rejects.toThrow(/disagrees/);
  });
  it('opens older Memory envelopes with AutoRec disabled and rejects stale prepared settings', async () => {
    const { engine, runtime, seed } = harness(); seed(1);
    const document = await runtime.capture();
    delete (document.extensions.WEBRC.browserMemory as any).autoRec;
    delete document.semantics.fields['record.autoRecSw']; delete document.semantics.fields['record.autoRecSens'];
    engine.setBrowserAutoRecSettings({ enabled: true, sensitivity: 10 });
    const candidate = await runtime.prepare(document, runtime.revision()); await candidate.commit(); await candidate.dispose();
    expect(engine.getBrowserAutoRecSettings()).toEqual({ enabled: false, sensitivity: 50 });
    const stale = await runtime.prepare(document, runtime.revision());
    engine.setBrowserAutoRecSettings({ enabled: true, sensitivity: 20 });
    await expect(stale.commit()).rejects.toThrow(/changed/); await stale.dispose();
  });
});
