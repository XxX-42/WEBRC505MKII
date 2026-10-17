import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAudioContext } from '../helpers/audioTestUtils';
import { resetBrowserRecordingOffsetConfig, setBrowserRecordingOffsetConfig } from '../../src/audio/browserRecordingOffset';

interface FakePostedMessage {
  message: Record<string, any>;
  transferList: Transferable[];
}

class FakeWorkletPort {
  onmessage: ((event: { data: any }) => void) | null = null;
  readonly posted: FakePostedMessage[] = [];

  postMessage(message: Record<string, any>, transferList: Transferable[] = []) {
    this.posted.push({ message: { ...message }, transferList });
  }

  receive(message: unknown) {
    this.onmessage?.({ data: message });
  }
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port = new FakeWorkletPort();
  readonly connections: unknown[] = [];
  disconnected = false;

  constructor(
    _context: AudioContext,
    public readonly name: string,
    public readonly options?: AudioWorkletNodeOptions,
  ) {
    FakeAudioWorkletNode.instances.push(this);
  }

  connect(target: unknown) { this.connections.push(target); }
  disconnect() { this.disconnected = true; }
}

function installPlaybackNodeSpies(context: AudioContext) {
  const sources: any[] = [];
  const gains: any[] = [];
  const createParam = (initialValue: number) => ({
    value: initialValue,
    canceledAt: [] as number[],
    setValues: [] as Array<{ value: number; time: number }>,
    curves: [] as Array<{ values: number[]; time: number; duration: number }>,
    cancelScheduledValues(time: number) { this.canceledAt.push(time); },
    setValueAtTime(value: number, time: number) { this.value = value; this.setValues.push({ value, time }); },
    setValueCurveAtTime(values: Float32Array, time: number, duration: number) {
      this.curves.push({ values: Array.from(values), time, duration });
    },
  });
  (context as any).createBufferSource = vi.fn(() => {
    const source: any = {
      buffer: null,
      loop: false,
      playbackRate: createParam(1),
      starts: [] as Array<{ when: number; offset: number }>,
      stopTimes: [] as number[],
      onended: null as null | (() => void),
      connect: vi.fn(),
      disconnect: vi.fn(),
      start(when = 0, offset = 0) { this.starts.push({ when, offset }); },
      stop(when = 0) { this.stopTimes.push(when); },
    };
    sources.push(source);
    return source;
  });
  (context as any).createGain = vi.fn(() => {
    const gain: any = {
      gain: createParam(1),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    gains.push(gain);
    return gain;
  });
  return { sources, gains };
}

describe('TrackAudio transport sync helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    FakeAudioWorkletNode.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function createTrackAudioHarness() {
    const [{ TrackAudio }, { Track, TrackState, TransportState }, { Transport }] = await Promise.all([
      import('../../src/audio/TrackAudio'),
      import('../../src/core/types'),
      import('../../src/core/Transport'),
    ]);

    const context = createMockAudioContext();
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

    return { context, engine, TrackState, TransportState, Transport: Transport.getInstance(), trackAudio };
  }

  it('starts transport when an active track is present', async () => {
    const { TrackState, TransportState, Transport, trackAudio } = await createTrackAudioHarness();
    Transport.stop();
    trackAudio.state = TrackState.PLAYING;

    (trackAudio as any).syncTransportState();

    expect(Transport.state).toBe(TransportState.PLAYING);
  });

  it('stops transport when all tracks are stopped or empty', async () => {
    const { TrackState, TransportState, Transport, trackAudio } = await createTrackAudioHarness();
    trackAudio.state = TrackState.STOPPED;
    Transport.start();

    (trackAudio as any).syncTransportState();

    expect(Transport.state).toBe(TransportState.STOPPED);
  });

  it('keeps default BufferSource playback at unity and uses a source-level Beat Shift crossfade', async () => {
    const { context, TrackState, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    const buffer = context.createBuffer(1, context.sampleRate * 8, context.sampleRate);
    (trackAudio as any).audioBuffer = buffer;

    await trackAudio.play();
    expect(nodes.sources).toHaveLength(1);
    expect(nodes.sources[0]).toMatchObject({ buffer, loop: true });
    expect(nodes.sources[0].starts[0]).toEqual({ when: 0, offset: 0 });
    expect(nodes.sources[0].playbackRate.curves).toHaveLength(0);
    expect(nodes.sources[0].playbackRate.value).toBe(1);
    expect(trackAudio.state).toBe(TrackState.PLAYING);

    expect(trackAudio.configureLoopTransportFx(0, 'BEAT SHIFT', {
      offset: -4,
      crossfade: 50,
      bpm: 120,
    })).toBe(true);

    expect(nodes.sources).toHaveLength(2);
    expect(nodes.sources[1].buffer).toBe(buffer);
    expect(nodes.sources[1].starts[0]).toEqual({ when: 0, offset: 6 });
    expect(nodes.sources[0].stopTimes).toEqual([0.01]);
    expect(nodes.gains).toHaveLength(2);
    expect(nodes.gains[0].gain.curves[0].duration).toBe(0.01);
    expect(nodes.gains[0].gain.curves[0].values[0]).toBeCloseTo(1);
    expect(nodes.gains[0].gain.curves[0].values.at(-1)).toBeCloseTo(0);
    expect(nodes.gains[1].gain.curves[0].values[0]).toBeCloseTo(0);
    expect(nodes.gains[1].gain.curves[0].values.at(-1)).toBeCloseTo(1);
    expect((trackAudio as any).loopTransportFxSlots[0]).toMatchObject({
      beatShiftOffsetBeats: -4,
      beatShiftCrossfadeMs: 10,
    });
    expect(trackAudio.loopTransportActive).toBe(true);
  });

  it('bounds queued Beat Shift retargets and preserves loop phase when the offset changes', async () => {
    const { context, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    const buffer = context.createBuffer(1, context.sampleRate * 8, context.sampleRate);
    (trackAudio as any).audioBuffer = buffer;
    await trackAudio.play();

    trackAudio.configureLoopTransportFx(0, 'BEAT SHIFT', { offset: 1, crossfade: 4, bpm: 120 });
    expect(nodes.sources).toHaveLength(2);
    expect(nodes.sources[1].starts[0].offset).toBeCloseTo(0.5);
    trackAudio.setLoopTransportFxParameter(0, 'offset', -1);
    expect(nodes.sources).toHaveLength(2);
    expect((trackAudio as any).loopTransportPendingRetarget).toBe(true);

    nodes.sources[0].onended?.();
    expect(nodes.sources).toHaveLength(3);
    expect(nodes.sources[2].starts[0].offset).toBeCloseTo(7.5);
    expect((trackAudio as any).loopTransportPendingRetarget).toBe(false);
  });

  it('reanchors Beat Shift to the shared BPM with a short source crossfade', async () => {
    const { context, Transport, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    const buffer = context.createBuffer(1, context.sampleRate * 8, context.sampleRate);
    (trackAudio as any).audioBuffer = buffer;
    Transport.setBpm(120);
    trackAudio.configureLoopTransportFx(0, 'BEAT SHIFT', { offset: 1 });
    await trackAudio.play();
    expect(nodes.sources[0].starts[0].offset).toBeCloseTo(0.5);

    context.currentTime = 0.2;
    Transport.setBpm(60);
    trackAudio.refreshLoopTransportTempo();

    expect(nodes.sources).toHaveLength(2);
    expect(nodes.sources[1].starts[0].offset).toBeCloseTo(1.2);
    expect(nodes.sources[0].stopTimes[0]).toBeCloseTo(0.205);
    Transport.setBpm(120);
  });

  it('keeps the existing read-head controllable while the loop is overdubbing', async () => {
    const { context, TrackState, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    (trackAudio as any).audioBuffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
    trackAudio.configureLoopTransportFx(0, 'BEAT SHIFT', { offset: 0.5 });
    await trackAudio.play();
    trackAudio.state = TrackState.OVERDUBBING;

    expect(trackAudio.setLoopTransportFxParameter(0, 'offset', -0.5)).toBe(true);
    expect(trackAudio.state).toBe(TrackState.OVERDUBBING);
    expect(nodes.sources).toHaveLength(2);
    expect(nodes.sources[1].starts[0].offset).toBeCloseTo(3.75);
  });

  it('returns to direct reverse playback when reverse is toggled during read-head playback', async () => {
    const { context, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    const buffer = context.createBuffer(1, context.sampleRate * 8, context.sampleRate);
    (trackAudio as any).audioBuffer = buffer;
    trackAudio.configureLoopTransportFx(0, 'BEAT SHIFT', { offset: 1, bpm: 120 });
    await trackAudio.play();
    expect(trackAudio.loopTransportActive).toBe(true);

    context.currentTime = 0.25;
    trackAudio.toggleReverse();
    expect(nodes.sources).toHaveLength(2);
    expect(nodes.sources[1].playbackRate.value).toBe(-1);
    expect(nodes.sources[1].starts[0].offset).toBeCloseTo(0.75);
    expect(trackAudio.loopTransportActive).toBe(false);
    expect(trackAudio.loopTransportUnavailableReason).toContain('forward BufferSource');
    expect(nodes.sources[0].stopTimes.at(-1)).toBe(0);
  });

  it('uses bounded variable-rate curves and advances the per-loop vinyl phase', async () => {
    const { context, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    const buffer = context.createBuffer(1, context.sampleRate * 8, context.sampleRate);
    (trackAudio as any).audioBuffer = buffer;
    expect(trackAudio.configureLoopTransportFx(2, 'VINYL FLICK', {
      speed: 100,
      mix: 100,
      'return-time': 0.001,
      brake: 140,
    })).toBe(true);

    await trackAudio.play();
    const firstCurve = nodes.sources[0].playbackRate.curves[0];
    expect(firstCurve.values).toHaveLength(65);
    expect(firstCurve.duration).toBeLessThanOrEqual(40);
    expect(firstCurve.values[0]).toBeCloseTo(1);
    expect(firstCurve.values.at(-1)).toBeCloseTo(2);
    expect((trackAudio as any).loopTransportFxSlots[2]).toMatchObject({
      vinylFlickReturnTimeSeconds: 0.05,
      vinylFlickBrakePercent: 100,
    });

    context.currentTime = 0.5;
    const position = (trackAudio as any).getCurrentPlaybackPosition();
    expect(position).toBeGreaterThan(0.5);
    expect(position).toBeLessThan(1.2);

    expect(trackAudio.setLoopTransportFxParameter(2, 'speed', -100)).toBe(true);
    const brakingCurve = nodes.sources[0].playbackRate.curves.at(-1)!;
    expect(brakingCurve.values).toHaveLength(65);
    expect(brakingCurve.values.at(-1)).toBeCloseTo(0);
    expect(nodes.sources[0].playbackRate.canceledAt.at(-1)).toBe(0.5);
    trackAudio.stop();
    expect(nodes.sources[0].playbackRate.canceledAt.at(-1)).toBe(0.5);
  });

  it('defaults Vinyl Flick to unity and dry when no slot values are supplied', async () => {
    const { context, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    (trackAudio as any).audioBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate);

    expect(trackAudio.configureLoopTransportFx(3, 'VINYL FLICK')).toBe(true);
    await trackAudio.play();

    expect((trackAudio as any).loopTransportFxSlots[3]).toMatchObject({
      vinylFlickSpeed: 0,
      vinylFlickMix: 0,
    });
    expect(nodes.sources[0].playbackRate.value).toBe(1);
    expect(nodes.sources[0].playbackRate.curves).toHaveLength(0);
  });

  it('falls back to ordinary forward playback if the source-aware reader cannot be created', async () => {
    const { context, TrackState, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    const buffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
    (trackAudio as any).audioBuffer = buffer;
    trackAudio.configureLoopTransportFx(0, 'VINYL FLICK', { speed: 100, mix: 100 });
    (context as any).createBufferSource.mockImplementationOnce(() => null);

    await expect(trackAudio.play()).resolves.toBeUndefined();

    expect(nodes.sources).toHaveLength(1);
    expect(nodes.sources[0]).toMatchObject({ buffer, loop: true });
    expect(nodes.sources[0].starts[0]).toEqual({ when: 0, offset: 0 });
    expect(nodes.sources[0].playbackRate.value).toBe(1);
    expect(nodes.sources[0].playbackRate.curves).toHaveLength(0);
    expect(trackAudio.state).toBe(TrackState.PLAYING);
    expect(trackAudio.loopTransportActive).toBe(false);
    expect(trackAudio.loopTransportUnavailableReason).toContain('ordinary BufferSource playback');
  });

  it('reports reverse and LIVE pitch routes as unavailable without replacing their source path', async () => {
    const { context, TrackState, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    (trackAudio as any).audioBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    trackAudio.isReverse = true;
    trackAudio.state = TrackState.PLAYING;
    expect(trackAudio.configureLoopTransportFx(0, 'BEAT SHIFT', { offset: 1 })).toBe(true);
    expect(trackAudio.loopTransportUnavailableReason).toContain('forward BufferSource');
    expect(trackAudio.loopTransportActive).toBe(false);
    expect(nodes.sources).toHaveLength(0);

    trackAudio.isReverse = false;
    (trackAudio as any).livePolyPitchEnabledInternal = true;
    expect(trackAudio.loopTransportUnavailableReason).toContain('LIVE_POLY');
    expect(trackAudio.configureLoopTransportFx(0, 'VINYL FLICK', { speed: 100, mix: 100 })).toBe(true);
    expect(trackAudio.loopTransportUnavailableReason).toContain('LIVE_POLY');
    expect(nodes.sources).toHaveLength(0);

    (trackAudio as any).livePolyPitchEnabledInternal = false;
    (trackAudio as any).liveMonoPitchEnabledInternal = true;
    expect(trackAudio.loopTransportUnavailableReason).toContain('LIVE_MONO');
  });

  it('creates the overdub worklet with sample offsets, applies ordered patches, and stops after the worker acknowledgement', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const { context, engine, TrackState, trackAudio } = await createTrackAudioHarness();
    const addModule = vi.spyOn(context.audioWorklet!, 'addModule');
    const audioBuffer = context.createBuffer(1, 32, context.sampleRate);
    const samples = audioBuffer.getChannelData(0);
    samples.set(Float32Array.from({ length: samples.length }, (_, index) => index));
    (trackAudio as any).audioBuffer = audioBuffer;
    (trackAudio as any).startTime = 2;
    (trackAudio as any).startOffset = 3 / context.sampleRate;
    engine.roundTripLatency = 1 / context.sampleRate;
    engine.selectedBufferFrames = 128;
    trackAudio.isReverse = true;
    trackAudio.state = TrackState.PLAYING;
    setBrowserRecordingOffsetConfig(0.023, {
      inputDeviceId: null,
      outputDeviceId: null,
      sampleRate: context.sampleRate,
      bufferFrames: 128,
    });

    trackAudio.triggerRecord();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    const node = FakeAudioWorkletNode.instances[0];
    expect(node?.name).toBe('rc505-overdub-processor');
    expect(addModule).toHaveBeenCalledWith('/worklets/browser-track-io.js');
    const init = node?.port.posted[0]?.message;
    expect(init).toMatchObject({
      type: 'OVERDUB_INIT',
      startFrame: 2 * context.sampleRate,
      startOffsetSamples: 3,
      latencySamples: 1,
      recordingOffsetSamples: 1,
      reverse: true,
    });
    expect((init?.buffers as unknown[])).toHaveLength(3);
    expect(node?.port.posted[0]?.transferList).toHaveLength(7);

    node?.port.receive({
      type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 2,
      indices: Uint32Array.from([5, 2]), values: Float32Array.from([0.5, 0.25]),
    });
    node?.port.receive({
      type: 'OVERDUB_PATCH', sequence: 1, slotIndex: 1, validFrames: 1,
      indices: Uint32Array.from([5]), values: Float32Array.from([0.75]),
    });
    expect(samples[5]).toBe(0.75);
    expect(samples[2]).toBe(0.25);
    expect(node?.port.posted.slice(-2).map(({ message }) => message.type)).toEqual([
      'RECYCLE_OVERDUB_BUFFER', 'RECYCLE_OVERDUB_BUFFER',
    ]);

    trackAudio.triggerRecord();
    expect(trackAudio.state).toBe(TrackState.PLAYING);
    expect(node?.port.posted.at(-1)?.message).toEqual({ type: 'OVERDUB_STOP' });
    expect(node?.disconnected).toBe(false);
    node?.port.receive({ type: 'OVERDUB_STOPPED', overflowFrames: 4, overflowEvents: 1, patchesSent: 2 });
    expect(node?.disconnected).toBe(true);
    expect(trackAudio.overdubDiagnostic).toContain('dropped 4 input frames');
  });

  it('reports AudioWorklet unavailability and returns the audible track to PLAYING', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    const { TrackState, trackAudio } = await createTrackAudioHarness();
    (trackAudio as any).audioBuffer = (trackAudio as any).engine.context.createBuffer(1, 16, 44_100);
    trackAudio.state = TrackState.PLAYING;

    trackAudio.triggerRecord();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    expect(trackAudio.state).toBe(TrackState.PLAYING);
    expect(trackAudio.overdubDiagnostic).toContain('AudioWorklet is unavailable');
    expect(trackAudio.overdubDiagnostic).toContain('Track playback remains audible');
  });
});
