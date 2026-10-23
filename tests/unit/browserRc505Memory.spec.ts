import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { TrackAudio } from '../../src/audio/TrackAudio';
import { Transport } from '../../src/core/Transport';
import { createMockAudioContext } from '../helpers/audioTestUtils';

function harness() {
  const context = createMockAudioContext();
  context.createChannelSplitter = () => context.createGain() as unknown as ChannelSplitterNode;
  context.createAnalyser = () => Object.assign(context.createGain(), { fftSize: 256, getFloatTimeDomainData: (values: Float32Array) => values.fill(0) }) as unknown as AnalyserNode;
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

describe('Browser semantic Memory', () => {
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
    const doc = await runtime.capture(); seed(9); engine.tracks[1]!.track.playLevel = 91;
    const identities = engine.tracks.slice();
    const candidate = await runtime.prepare(doc, runtime.revision());
    await candidate.commit(); await candidate.dispose();
    expect(engine.tracks).toEqual(identities);
    expect(engine.tracks[1]!.track.playLevel).toBe(42);
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

  it('fails closed when a saved gate differs instead of mutating incumbent worklets', async () => {
    const { runtime, engine, seed } = harness(); seed(1);
    const doc = await runtime.capture(); (doc.extensions.WEBRC.browserMemory as any).trackFxApply[0] = false;
    const before = runtime.revision();
    await expect(runtime.prepare(doc, before)).rejects.toThrow(/staged render router/);
    expect(runtime.revision()).toBe(before); expect(engine.getTrackFxApply(1)[0]!.applied).toBe(true);
  });
});
