import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockAudioContext } from '../helpers/audioTestUtils';

describe('TrackAudio retirement lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function createHarness() {
    const [{ TrackAudio }, { Track }] = await Promise.all([
      import('../../src/audio/TrackAudio'),
      import('../../src/core/types'),
    ]);
    const context = createMockAudioContext();
    const engine = {
      context,
      trackMixNode: context.createGain(),
      roundTripLatency: 0,
      tracks: [] as TrackAudio[],
      selectedInputDeviceId: null,
      selectedOutputDeviceId: null,
      selectedBufferFrames: 128,
      checkAndResetMaster: vi.fn(),
    };
    const track = new TrackAudio(engine as never, new Track(1), 0, null, null);
    engine.tracks = [track];
    return { context, engine, track };
  }

  it('cancels its pending animation frame and never reschedules or writes shared state after disposal', async () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    const request = vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    });
    const cancel = vi.fn((id: number) => callbacks.delete(id));
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const { track } = await createHarness();

    expect(request).toHaveBeenCalledTimes(1);
    const scheduledId = request.mock.results[0]!.value;
    const staleCallback = callbacks.get(scheduledId)!;
    const sharedPositions = new Float32Array([0.625]);
    (track as any).sharedPositions = sharedPositions;
    (track as any).audioBuffer = createMockAudioContext().createBuffer(1, 128, 44_100);
    (track as any).engine.context.state = 'closed';

    track.dispose();
    expect(track.isDisposed).toBe(true);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(scheduledId);

    sharedPositions[0] = 0.375;
    staleCallback(0);
    expect(sharedPositions[0]).toBe(0.375);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('detaches quantized measure listeners and keeps PCM readable after idempotent disposal', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 7));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { context, track } = await createHarness();
    const pcm = context.createBuffer(2, 16, context.sampleRate);
    pcm.getChannelData(0)[0] = 0.25;
    pcm.getChannelData(1)[0] = -0.5;
    const history = context.createBuffer(1, 8, context.sampleRate);
    history.getChannelData(0)[0] = 0.75;
    (track as any).audioBuffer = pcm;
    (track as any).pcmHistory = {
      snapshot: { buffer: history, isReverse: false, master: null },
      direction: 'undo',
    };

    const transport = (track as any).transport;
    const listener = vi.fn();
    const removeListener = vi.spyOn(transport, 'off');
    transport.on('measure', listener);
    (track as any).quantizeStartListener = listener;
    (track as any).waitingForQuantize = true;
    (track as any).engine.context.state = 'closed';
    const disposeFx = [
      vi.spyOn(track.fxChain.compressor, 'dispose'),
      vi.spyOn(track.fxChain.filter, 'dispose'),
      vi.spyOn(track.fxChain.delay, 'dispose'),
      vi.spyOn(track.fxChain.reverb, 'dispose'),
    ];

    track.dispose();
    track.dispose();

    expect(removeListener).toHaveBeenCalledWith('measure', listener);
    expect(listener).not.toHaveBeenCalled();
    expect(disposeFx.map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(track.getProjectPcmSnapshot()?.channelData.map((channel) => channel[0])).toEqual([0.25, -0.5]);
    expect((track as any).pcmHistory.snapshot.buffer).toBe(history);
    expect(track.canUndo).toBe(false);
    expect(track.canExportHqWav).toBe(true);
    expect(track.configureLoopTransportFx(0, 'BEAT SHIFT', { offset: 1 })).toBe(false);
    expect(() => track.stop()).not.toThrow();
  });

  it('disconnects all active playback readers and ignores late transport work after disposal', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 11));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { context, track } = await createHarness();
    const source = context.createBufferSource();
    const sourceGain = context.createGain();
    const dryReader = context.createBufferSource();
    const dryGain = context.createGain();
    const wetGain = context.createGain();
    const retiringSource = context.createBufferSource();
    const retiringGain = context.createGain();
    const onended = vi.fn();
    source.onended = onended;
    retiringSource.onended = onended;
    const sourceStop = vi.spyOn(source, 'stop');
    const sourceDisconnect = vi.spyOn(source, 'disconnect');
    const dryStop = vi.spyOn(dryReader, 'stop');
    const dryDisconnect = vi.spyOn(dryReader, 'disconnect');
    const retiringStop = vi.spyOn(retiringSource, 'stop');
    const retiringDisconnect = vi.spyOn(retiringSource, 'disconnect');
    const sourceGainDisconnect = vi.spyOn(sourceGain, 'disconnect');
    const dryGainDisconnect = vi.spyOn(dryGain, 'disconnect');
    const wetGainDisconnect = vi.spyOn(wetGain, 'disconnect');
    const retiringGainDisconnect = vi.spyOn(retiringGain, 'disconnect');
    Object.assign(track as any, {
      audioBuffer: context.createBuffer(1, 256, context.sampleRate),
      sourceNode: source,
      sourceGainNode: sourceGain,
      loopTransportDrySourceNode: dryReader,
      loopTransportDryGainNode: dryGain,
      loopTransportWetMixGainNode: wetGain,
      retiringSourceNode: retiringSource,
      retiringSourceGainNode: retiringGain,
      loopTransportPlaybackInitialized: true,
      loopTransportTransitionActive: true,
    });
    (track as any).state = 'PLAYING';
    (track as any).engine.context.state = 'closed';

    track.dispose();

    expect(source.onended).toBeNull();
    expect(retiringSource.onended).toBeNull();
    expect(sourceStop).toHaveBeenCalledOnce();
    expect(sourceDisconnect).toHaveBeenCalledOnce();
    expect(dryStop).toHaveBeenCalledOnce();
    expect(dryDisconnect).toHaveBeenCalledOnce();
    expect(retiringStop).toHaveBeenCalledOnce();
    expect(retiringDisconnect).toHaveBeenCalledOnce();
    expect(sourceGainDisconnect).toHaveBeenCalledOnce();
    expect(dryGainDisconnect).toHaveBeenCalledOnce();
    expect(wetGainDisconnect).toHaveBeenCalledOnce();
    expect(retiringGainDisconnect).toHaveBeenCalledOnce();
    track.refreshLoopTransportTempo();
    expect(onended).not.toHaveBeenCalled();
  });

  it('refuses retirement while an edit is busy instead of risking a partial take', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 3));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { track } = await createHarness();
    (track as any).recordingStarting = true;
    (track as any).engine.context.state = 'closed';

    expect(() => track.dispose()).toThrow(/busy/);
    expect(track.isDisposed).toBe(false);
  });
});
