import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAudioContext } from '../helpers/audioTestUtils';

const pitchHarness = vi.hoisted(() => {
  const connections = new Set<unknown>();
  const port = { close: vi.fn() };
  const releaseWasmMemory = vi.fn(async () => {
    connections.clear();
    port.close();
  });
  const connect = vi.fn((destination: unknown) => {
    connections.add(destination);
  });
  const disconnect = vi.fn((...args: unknown[]) => {
    if (args.length === 0) {
      void releaseWasmMemory();
      return;
    }
    if (!connections.delete(args[0])) {
      const error = new Error('The requested AudioNode edge is not connected');
      error.name = 'InvalidAccessError';
      throw error;
    }
  });
  const node = {
    mode: 'LIVE_POLY' as const,
    latencySamples: 6_720,
    latencySeconds: 0.14,
    inputTime: 0,
    connect,
    disconnect,
    releaseWasmMemory,
    loadBuffer: vi.fn(async () => 1),
    clearBuffers: vi.fn(async () => undefined),
    scheduleLoop: vi.fn(async () => undefined),
    scheduleSegment: vi.fn(async () => undefined),
    setPitch: vi.fn(async () => undefined),
    startProcessing: vi.fn(async () => undefined),
    stopProcessing: vi.fn(async () => undefined),
    port,
  };
  const monoNode = {
    latencySamples: 2_206,
    latencySeconds: 2_206 / 48_000,
    ready: Promise.resolve({ type: 'ready' as const }),
    setPitch: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    port: { close: vi.fn() },
  };
  return {
    node,
    monoNode,
    createLivePolyPitchNode: vi.fn(async () => node),
    createLiveMonoPitchNode: vi.fn(async () => monoNode),
    connections,
  };
});

vi.mock('../../src/audio/pitch', () => ({
  createLivePolyPitchNode: pitchHarness.createLivePolyPitchNode,
  createLiveMonoPitchNode: pitchHarness.createLiveMonoPitchNode,
}));

describe('TrackAudio KeepPitch opt-in routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
    pitchHarness.createLivePolyPitchNode.mockClear();
    pitchHarness.createLiveMonoPitchNode.mockClear();
    for (const method of [
      pitchHarness.node.connect,
      pitchHarness.node.disconnect,
      pitchHarness.node.loadBuffer,
      pitchHarness.node.clearBuffers,
      pitchHarness.node.scheduleLoop,
      pitchHarness.node.scheduleSegment,
      pitchHarness.node.setPitch,
      pitchHarness.node.startProcessing,
      pitchHarness.node.stopProcessing,
      pitchHarness.node.releaseWasmMemory,
      pitchHarness.node.port.close,
      pitchHarness.monoNode.setPitch,
      pitchHarness.monoNode.connect,
      pitchHarness.monoNode.disconnect,
      pitchHarness.monoNode.port.close,
    ]) method.mockClear();
    pitchHarness.node.latencySamples = 6_720;
    pitchHarness.node.latencySeconds = 0.14;
    pitchHarness.monoNode.latencySamples = 2_206;
    pitchHarness.monoNode.latencySeconds = 2_206 / 48_000;
    pitchHarness.connections.clear();
  });

  async function makeTrack() {
    const [{ TrackAudio }, { Track, TrackState }, { Transport }] = await Promise.all([
      import('../../src/audio/TrackAudio'),
      import('../../src/core/types'),
      import('../../src/core/Transport'),
    ]);
    const context = createMockAudioContext();
    const sourceNodes: any[] = [];
    (context as any).createBufferSource = vi.fn(() => {
      const source = {
        buffer: null,
        loop: false,
        playbackRate: { value: 1 },
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      sourceNodes.push(source);
      return source;
    });
    const engine = {
      context,
      trackMixNode: context.createGain(),
      roundTripLatency: 0,
      selectedInputDeviceId: null,
      selectedOutputDeviceId: null,
      selectedBufferFrames: 128,
      getInputStream: async () => context.createMediaStreamSource({} as MediaStream),
      getProcessedInputNode: async () => context.createGain(),
      checkAndResetMaster: vi.fn(),
      tracks: [] as Array<{ state: typeof TrackState[keyof typeof TrackState] }>,
    };
    const trackAudio = new TrackAudio(engine as never, new Track(1), 0, null, null);
    engine.tracks = [trackAudio];
    trackAudio['audioBuffer'] = context.createBuffer(1, 44_100, 44_100);
    return { context, sourceNodes, trackAudio, TrackState, Transport: Transport.getInstance() };
  }

  it('routes an opted-in loop through Signalsmith internal buffers with measured latency', async () => {
    const { context, sourceNodes, trackAudio, TrackState, Transport } = await makeTrack();
    Transport.stop();

    expect(trackAudio.livePolyPitchEnabled).toBe(false);
    expect(trackAudio.livePolyPitchLatencySamples).toBeNull();
    await trackAudio.setLivePolyPitchEnabled(true, { semitones: 7, playbackRate: 0.8 });
    await trackAudio.play();

    expect(pitchHarness.createLivePolyPitchNode).toHaveBeenCalledWith(context, expect.objectContaining({
      mode: 'LIVE_POLY',
      channels: 1,
      semitones: 7,
      playbackRate: 0.8,
    }));
    expect(pitchHarness.node.loadBuffer).toHaveBeenCalledWith([trackAudio['audioBuffer']!.getChannelData(0)]);
    expect(pitchHarness.node.scheduleLoop).toHaveBeenCalledWith(expect.objectContaining({
      inputOffsetSeconds: 0,
      loopStartSeconds: 0,
      loopEndSeconds: 1,
      semitones: 7,
      playbackRate: 0.8,
    }));
    expect(pitchHarness.node.connect).toHaveBeenCalledWith(trackAudio.fxChain.input);
    expect(sourceNodes).toHaveLength(0);
    expect(trackAudio.livePolyPitchEnabled).toBe(true);
    expect(trackAudio.livePolyPitchActive).toBe(true);
    expect(trackAudio.livePolyPitchLatencySamples).toBe(6_720);
    expect(trackAudio.livePolyPitchLatencySeconds).toBeCloseTo(6_720 / context.sampleRate);
    expect(trackAudio.state).toBe(TrackState.PLAYING);
  });

  it('schedules a finite LIVE_POLY segment and uses audio-clock completion for one-shot playback', async () => {
    const { context, sourceNodes, trackAudio, TrackState, Transport } = await makeTrack();
    Transport.stop();
    trackAudio.track.oneShot = 'ON';
    await trackAudio.setLivePolyPitchEnabled(true, { semitones: 5, playbackRate: 0.75 });
    await trackAudio.play();

    expect(pitchHarness.node.scheduleSegment).toHaveBeenCalledWith(expect.objectContaining({
      inputOffsetSeconds: 0,
      inputEndSeconds: 1,
      playbackRate: 0.75,
    }));
    expect(pitchHarness.node.scheduleLoop).not.toHaveBeenCalled();
    expect(sourceNodes).toHaveLength(1);
    expect(sourceNodes[0]!.loop).toBe(false);
    expect(sourceNodes[0]!.connect).toHaveBeenCalled();
    expect(trackAudio.livePolyPitchActive).toBe(true);
    sourceNodes[0]!.onended?.();
    expect(trackAudio.state).toBe(TrackState.STOPPED);
    expect(trackAudio.livePolyPitchActive).toBe(false);
  });

  it('runs LIVE_MONO one-shot through its Worklet with a finite source reader', async () => {
    const { sourceNodes, trackAudio, TrackState, Transport } = await makeTrack();
    Transport.stop();
    trackAudio.track.oneShot = 'ON';
    await trackAudio.setLiveMonoPitchEnabled(true, { semitones: -4 });
    await trackAudio.play();

    expect(sourceNodes).toHaveLength(1);
    expect(sourceNodes[0]!.loop).toBe(false);
    expect(sourceNodes[0]!.connect).toHaveBeenCalledWith(pitchHarness.monoNode);
    expect(trackAudio.liveMonoPitchActive).toBe(true);
    sourceNodes[0]!.onended?.();
    expect(trackAudio.state).toBe(TrackState.STOPPED);
    expect(trackAudio.liveMonoPitchActive).toBe(false);
  });

  it('tears down an active read-head before switching into LIVE_POLY', async () => {
    const { context, sourceNodes, trackAudio, Transport } = await makeTrack();
    Transport.stop();

    await trackAudio.play();
    trackAudio.configureLoopTransportFx(0, 'BEAT SHIFT', { offset: 1, bpm: 120 });
    expect(trackAudio.loopTransportActive).toBe(true);
    expect(sourceNodes).toHaveLength(2); // legacy source plus the short read-head crossfade source

    await trackAudio.setLivePolyPitchEnabled(true, { semitones: 7, playbackRate: 0.8 });

    expect(trackAudio.loopTransportActive).toBe(false);
    expect(trackAudio.loopTransportUnavailableReason).toContain('LIVE_POLY');
    expect(sourceNodes.every((source: any) => source.stop.mock.calls.length > 0)).toBe(true);
    expect(pitchHarness.node.connect).toHaveBeenCalledWith(trackAudio.fxChain.input);
    expect(trackAudio.livePolyPitchActive).toBe(true);
  });

  it('routes a monophonic loop through the dedicated YIN/PSOLA node at unity source rate', async () => {
    const { context, sourceNodes, trackAudio, TrackState, Transport } = await makeTrack();
    Transport.stop();

    await trackAudio.setLiveMonoPitchEnabled(true, { semitones: 7 });
    await trackAudio.play();

    expect(pitchHarness.createLiveMonoPitchNode).toHaveBeenCalledWith(context, expect.objectContaining({
      semitones: 7,
      minimumFrequencyHz: 70,
      maximumFrequencyHz: 1_200,
      outputChannels: 2,
    }));
    expect(pitchHarness.monoNode.setPitch).toHaveBeenCalledWith(7);
    expect(sourceNodes).toHaveLength(1);
    expect(sourceNodes[0]!.playbackRate.value).toBe(1);
    expect(sourceNodes[0]!.connect).toHaveBeenCalledWith(pitchHarness.monoNode);
    expect(pitchHarness.monoNode.connect).toHaveBeenCalledWith(trackAudio.fxChain.input);
    expect(trackAudio.liveMonoPitchEnabled).toBe(true);
    expect(trackAudio.liveMonoPitchActive).toBe(true);
    expect(trackAudio.liveMonoPitchLatencySamples).toBe(2_206);
    expect(trackAudio.liveMonoPitchLatencySeconds).toBeCloseTo(2_206 / context.sampleRate);
    expect(trackAudio.state).toBe(TrackState.PLAYING);
    expect(trackAudio.livePolyPitchActive).toBe(false);
  });

  it('falls back from LIVE_MONO for reverse and short loops', async () => {
    const { context, sourceNodes, trackAudio, Transport } = await makeTrack();
    Transport.stop();
    await trackAudio.setLiveMonoPitchEnabled(true, { semitones: -5 });
    await trackAudio.play();
    trackAudio.toggleReverse();
    await vi.waitFor(() => expect(sourceNodes).toHaveLength(2));

    expect(trackAudio.liveMonoPitchActive).toBe(false);
    expect(trackAudio.liveMonoPitchFallbackReason).toContain('Reverse playback');
    expect(sourceNodes.at(-1)!.playbackRate.value).toBe(-1);

    trackAudio.toggleReverse();
    await vi.waitFor(() => expect(trackAudio.liveMonoPitchActive).toBe(true));
    trackAudio['audioBuffer'] = context.createBuffer(1, 1_000, context.sampleRate);
    await trackAudio.play();
    expect(trackAudio.liveMonoPitchActive).toBe(false);
    expect(trackAudio.liveMonoPitchFallbackReason).toContain('no longer than');
  });

  it('falls back to legacy reverse playback and tears down the pitch route', async () => {
    const { sourceNodes, trackAudio, TrackState, Transport } = await makeTrack();
    Transport.stop();
    await trackAudio.setLivePolyPitchEnabled(true, { semitones: 5, playbackRate: 1 });
    await trackAudio.play();

    trackAudio.toggleReverse();

    expect(trackAudio.state).toBe(TrackState.PLAYING);
    expect(trackAudio.livePolyPitchEnabled).toBe(true);
    expect(trackAudio.livePolyPitchActive).toBe(false);
    expect(trackAudio.livePolyPitchFallbackReason).toContain('Reverse playback');
    expect(pitchHarness.node.stopProcessing).toHaveBeenCalled();
    expect(pitchHarness.node.disconnect).toHaveBeenCalled();
    expect(sourceNodes).toHaveLength(1);
    expect(sourceNodes[0]!.playbackRate.value).toBe(-1);
    expect(sourceNodes[0]!.connect).toHaveBeenCalledWith(trackAudio.fxChain.input);
  });

  it('replaces the internal loop buffer on source changes and falls back for too-short loops', async () => {
    const { context, sourceNodes, trackAudio, Transport } = await makeTrack();
    Transport.stop();
    await trackAudio.setLivePolyPitchEnabled(true, { semitones: 2, playbackRate: 0.9 });
    await trackAudio.play();

    const replacement = context.createBuffer(1, 88_200, context.sampleRate);
    trackAudio['audioBuffer'] = replacement;
    await trackAudio.play();

    expect(pitchHarness.node.loadBuffer).toHaveBeenCalledTimes(2);
    expect(pitchHarness.node.loadBuffer).toHaveBeenLastCalledWith([replacement.getChannelData(0)]);
    expect(pitchHarness.node.scheduleLoop).toHaveBeenLastCalledWith(expect.objectContaining({ loopEndSeconds: 2 }));
    expect(sourceNodes).toHaveLength(0);

    trackAudio['audioBuffer'] = context.createBuffer(1, 6_000, context.sampleRate);
    await trackAudio.play();
    expect(trackAudio.livePolyPitchActive).toBe(false);
    expect(trackAudio.livePolyPitchFallbackReason).toContain('no longer than');
    expect(sourceNodes).toHaveLength(1);
  });

  it('reuses the LIVE_POLY node across stop and play without releasing its WASM lease', async () => {
    const { trackAudio, Transport } = await makeTrack();
    Transport.stop();
    await trackAudio.setLivePolyPitchEnabled(true, { semitones: 3, playbackRate: 1 });
    await trackAudio.play();
    expect(trackAudio.livePolyPitchActive).toBe(true);

    trackAudio.stop();
    expect(trackAudio.livePolyPitchActive).toBe(false);
    expect(pitchHarness.node.disconnect).toHaveBeenCalledWith(trackAudio.fxChain.input);
    expect(pitchHarness.node.releaseWasmMemory).not.toHaveBeenCalled();
    expect(pitchHarness.node.port.close).not.toHaveBeenCalled();

    await trackAudio.play();
    expect(trackAudio.livePolyPitchActive).toBe(true);
    expect(pitchHarness.createLivePolyPitchNode).toHaveBeenCalledTimes(1);
    expect(pitchHarness.node.loadBuffer).toHaveBeenCalledTimes(2);
    expect(pitchHarness.node.scheduleLoop).toHaveBeenCalledTimes(2);
    expect(pitchHarness.node.releaseWasmMemory).not.toHaveBeenCalled();
    expect(pitchHarness.node.port.close).not.toHaveBeenCalled();
  });

  it('keeps LIVE_POLY leased while PCM undo and redo restart the selected loop', async () => {
    const { context, trackAudio, Transport } = await makeTrack();
    Transport.stop();
    const original = trackAudio['audioBuffer']!;
    const edited = context.createBuffer(1, 88_200, context.sampleRate);
    trackAudio['audioBuffer'] = edited;
    expect(trackAudio['retainPcmEdit'](trackAudio['capturePcmSnapshot'](original))).toBe(true);
    await trackAudio.setLivePolyPitchEnabled(true, { semitones: -2, playbackRate: 1 });
    await trackAudio.play();
    expect(trackAudio.livePolyPitchActive).toBe(true);

    expect(trackAudio.undo()).toBe(true);
    await vi.waitFor(() => expect(pitchHarness.node.loadBuffer).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(trackAudio.livePolyPitchActive).toBe(true));
    expect(pitchHarness.node.loadBuffer).toHaveBeenLastCalledWith([original.getChannelData(0)]);

    expect(trackAudio.redo()).toBe(true);
    await vi.waitFor(() => expect(pitchHarness.node.loadBuffer).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(trackAudio.livePolyPitchActive).toBe(true));
    expect(pitchHarness.node.loadBuffer).toHaveBeenLastCalledWith([edited.getChannelData(0)]);
    expect(pitchHarness.createLivePolyPitchNode).toHaveBeenCalledTimes(1);
    expect(pitchHarness.node.releaseWasmMemory).not.toHaveBeenCalled();
    expect(pitchHarness.node.port.close).not.toHaveBeenCalled();
  });

  it('releases the lease only when clearing/disposal truly retires LIVE_POLY', async () => {
    const { trackAudio, Transport } = await makeTrack();
    Transport.stop();
    await trackAudio.setLivePolyPitchEnabled(true, { semitones: 1, playbackRate: 1 });
    await trackAudio.play();
    expect(trackAudio.livePolyPitchActive).toBe(true);

    expect(trackAudio.clear()).toBe(true);
    await vi.waitFor(() => expect(pitchHarness.node.releaseWasmMemory).toHaveBeenCalledTimes(1));
    expect(pitchHarness.node.port.close).toHaveBeenCalledTimes(1);
    expect(pitchHarness.node.disconnect).toHaveBeenCalledWith(trackAudio.fxChain.input);
    expect(pitchHarness.node.disconnect).not.toHaveBeenCalledWith();
  });

  it('surfaces unexpected graph-disconnect failures while ignoring only absent edges', async () => {
    const { trackAudio, Transport, TrackState } = await makeTrack();
    Transport.stop();
    await trackAudio.setLivePolyPitchEnabled(true, { semitones: 1, playbackRate: 1 });
    await trackAudio.play();
    pitchHarness.node.disconnect.mockImplementationOnce(() => {
      throw new TypeError('unexpected graph disconnect failure');
    });

    expect(() => trackAudio.stop()).toThrow('unexpected graph disconnect failure');
    expect(trackAudio.state).toBe(TrackState.PLAYING);
    expect(pitchHarness.node.releaseWasmMemory).not.toHaveBeenCalled();
  });

  it('stops and clears the Worklet on stop/reset without changing default playback', async () => {
    const { sourceNodes, trackAudio, TrackState, Transport } = await makeTrack();
    Transport.stop();

    await trackAudio.play();
    expect(sourceNodes).toHaveLength(1);
    expect(sourceNodes[0]!.playbackRate.value).toBe(1);
    expect(trackAudio.livePolyPitchActive).toBe(false);

    await trackAudio.setLivePolyPitchEnabled(true, { semitones: -3, playbackRate: 1.2 });
    await trackAudio.play();
    trackAudio.stop();
    expect(trackAudio.state).toBe(TrackState.STOPPED);
    expect(trackAudio.livePolyPitchActive).toBe(false);
    expect(pitchHarness.node.stopProcessing).toHaveBeenCalled();
    expect(pitchHarness.node.disconnect).toHaveBeenCalled();

    trackAudio.clear();
    expect(trackAudio.state).toBe(TrackState.EMPTY);
    expect(trackAudio.livePolyPitchEnabled).toBe(false);
    await vi.waitFor(() => expect(pitchHarness.node.port.close).toHaveBeenCalled());
  });
});
