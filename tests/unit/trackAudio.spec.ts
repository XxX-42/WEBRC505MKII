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
    ramps: [] as Array<{ value: number; time: number }>,
    cancelScheduledValues(time: number) { this.canceledAt.push(time); },
    setValueAtTime(value: number, time: number) { this.value = value; this.setValues.push({ value, time }); },
    linearRampToValueAtTime(value: number, time: number) { this.value = value; this.ramps.push({ value, time }); },
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

  it('rejects source-readhead edits while a canonical-frame overdub is active', async () => {
    const { context, TrackState, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    (trackAudio as any).audioBuffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
    trackAudio.configureLoopTransportFx(0, 'BEAT SHIFT', { offset: 0.5 });
    await trackAudio.play();
    trackAudio.state = TrackState.OVERDUBBING;

    expect(trackAudio.setLoopTransportFxParameter(0, 'offset', -0.5)).toBe(false);
    expect(trackAudio.state).toBe(TrackState.OVERDUBBING);
    expect(nodes.sources).toHaveLength(1);
    expect((trackAudio as any).loopTransportFxSlots[0]).toMatchObject({ type: 'BEAT SHIFT', beatShiftOffsetBeats: 0.5 });
  });

  it('suspends and restores the source reader around an actual overdub worklet session', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const { context, TrackState, trackAudio } = await createTrackAudioHarness();
    installPlaybackNodeSpies(context);
    (trackAudio as any).audioBuffer = context.createBuffer(1, 32, context.sampleRate);
    trackAudio.configureLoopTransportFx(0, 'BEAT SHIFT', { offset: 0.5, crossfade: 5 });
    await trackAudio.play();

    trackAudio.triggerRecord();
    expect(trackAudio.state).toBe(TrackState.OVERDUBBING);
    expect((trackAudio as any).loopTransportFxSlots[0]).toBeNull();
    expect(trackAudio.loopTransportUnavailableReason).toContain('suspended during overdub');
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    const node = FakeAudioWorkletNode.instances.at(-1);
    expect(node?.name).toBe('rc505-overdub-processor');
    expect(node?.port.posted[0]?.message.type).toBe('OVERDUB_INIT');
    trackAudio.triggerRecord();
    expect(trackAudio.state).toBe(TrackState.PLAYING);
    expect((trackAudio as any).loopTransportFxSlots[0]).toBeNull();
    node?.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 0, overflowFrames: 0, overflowEvents: 0,
      requestedStopFrame: 0, appliedExclusiveEnd: 0, processorStopFrame: 0 });

    expect((trackAudio as any).loopTransportFxSlots[0]).toMatchObject({
      type: 'BEAT SHIFT', beatShiftOffsetBeats: 0.5, beatShiftCrossfadeMs: 5,
    });
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

  it('uses bounded variable-rate curves while keeping the Vinyl transport cursor canonical', async () => {
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
    expect(firstCurve.values).toHaveLength(1025);
    expect(firstCurve.duration).toBeLessThanOrEqual(200);
    expect(firstCurve.values[0]).toBeCloseTo(1);
    expect(firstCurve.values.at(-1)).toBeCloseTo(2);
    expect((trackAudio as any).loopTransportFxSlots[2]).toMatchObject({
      vinylFlickReturnTimeSeconds: 0.05,
      vinylFlickBrakePercent: 100,
    });

    context.currentTime = 0.5;
    const position = (trackAudio as any).getCurrentPlaybackPosition();
    expect(position).toBeCloseTo(0.5);
    expect((trackAudio as any).loopTransportPhaseBaseSeconds).toBeGreaterThan(position);
    expect((trackAudio as any).loopTransportPhaseBaseSeconds).toBeLessThan(1.2);

    expect(trackAudio.setLoopTransportFxParameter(2, 'speed', -100)).toBe(true);
    const brakingCurve = nodes.sources[0].playbackRate.curves.at(-1)!;
    expect(brakingCurve.values).toHaveLength(1025);
    expect(brakingCurve.values.at(-1)).toBeCloseTo(0);
    expect(nodes.sources[0].playbackRate.canceledAt.at(-1)).toBe(0.5);
    trackAudio.stop();
    expect(nodes.sources[0].playbackRate.canceledAt.at(-1)).toBe(0.5);
  });


  it.each([0, 50, 100])('uses the Native motor coefficients at brake %s', async (brake) => {
    const { context, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    (trackAudio as any).audioBuffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
    trackAudio.configureLoopTransportFx(0, 'VINYL FLICK', { speed: 50, mixPercent: 100, 'return-time': 0.05, brake });
    await trackAudio.play();
    const curve = nodes.sources[0].playbackRate.curves[0];
    expect(curve.duration).toBe(1);
    let rate = 1;
    let velocity = 0;
    const dt = 1 / 48000;
    const omega = 2 / 0.05;
    const damping = 0.7 + 1.2 * brake / 100;
    for (let frame = 1; frame <= 4800; frame += 1) {
      velocity += (omega * omega * (1.5 - rate) - 2 * damping * omega * velocity) * dt;
      rate += velocity * dt;
      if (frame % 1200 !== 0) continue;
      const position = frame * dt / curve.duration * (curve.values.length - 1);
      const index = Math.floor(position);
      const fraction = position - index;
      const renderedRate = curve.values[index] + (curve.values[index + 1] - curve.values[index]) * fraction;
      expect(Math.abs(renderedRate - rate)).toBeLessThan(0.0005);
    }
    trackAudio.stop();
  });

  it.each([0, 50, 100])('keeps Vinyl speed independent of mix %s and blends canonical/wet stereo readers', async (mix) => {
    const { context, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    const buffer = context.createBuffer(2, context.sampleRate * 4, context.sampleRate);
    (trackAudio as any).audioBuffer = buffer;
    (trackAudio as any).startOffset = 3.75;
    trackAudio.configureLoopTransportFx(0, 'VINYL FLICK', { speed: 50, mixPercent: mix, 'return-time': 0.05 });
    await trackAudio.play();

    expect(nodes.sources).toHaveLength(2);
    const [wet, dry] = nodes.sources;
    for (const source of [wet, dry]) {
      expect(source.buffer).toBe(buffer);
      expect(source.loop).toBe(true);
      expect(source.starts[0]).toEqual({ when: 0, offset: 3.75 });
    }
    expect(wet.playbackRate.curves[0].values.at(-1)).toBeCloseTo(1.5);
    expect(dry.playbackRate.value).toBe(1);
    expect(dry.playbackRate.curves).toHaveLength(0);
    expect((trackAudio as any).loopTransportWetMixGainNode.gain.value).toBeCloseTo(mix / 100);
    expect((trackAudio as any).loopTransportDryGainNode.gain.value).toBeCloseTo(1 - mix / 100);
    // Unity source envelope feeds the shared wet-mix gain; the canonical source
    // has its own direct gain. Both streams retain all original PCM channels.
    expect(wet.connect).toHaveBeenCalledWith((trackAudio as any).sourceGainNode);
    expect((trackAudio as any).sourceGainNode.connect).toHaveBeenLastCalledWith((trackAudio as any).loopTransportWetMixGainNode);
    expect(dry.connect).toHaveBeenCalledWith((trackAudio as any).loopTransportDryGainNode);
    context.currentTime = 0.5;
    expect((trackAudio as any).getCurrentPlaybackPosition()).toBeCloseTo(0.25);
    trackAudio.stop();
  });

  it.each([-100, 0, 100])('keeps a fixed 50 percent dry/wet blend at Vinyl speed %s', async (speed) => {
    const { context, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    (trackAudio as any).audioBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    trackAudio.configureLoopTransportFx(0, 'VINYL FLICK', { speed, mixPercent: 50 });
    await trackAudio.play();
    expect((trackAudio as any).loopMotorStates[0].targetRate).toBe(1 + speed / 100);
    expect((trackAudio as any).loopTransportWetMixGainNode.gain.value).toBe(0.5);
    expect((trackAudio as any).loopTransportDryGainNode.gain.value).toBe(0.5);
    if (speed !== 0) expect(nodes.sources[0].playbackRate.curves[0].values.at(-1)).toBe(1 + speed / 100);
    else expect(nodes.sources[0].playbackRate.value).toBe(1);
    trackAudio.stop();
  });

  it('promotes a running source and edits Vinyl mix without restarting either readhead', async () => {
    const { context, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    (trackAudio as any).audioBuffer = context.createBuffer(2, context.sampleRate * 4, context.sampleRate);
    await trackAudio.play();
    context.currentTime = 0.25;
    expect(trackAudio.configureLoopTransportFx(0, 'VINYL FLICK', { speed: 50, mixPercent: 100 })).toBe(true);
    expect(nodes.sources).toHaveLength(2);
    expect(nodes.sources[1].starts[0]).toEqual({ when: 0.25, offset: 0.25 });
    const dry = (trackAudio as any).loopTransportDrySourceNode;
    const wet = (trackAudio as any).sourceNode;
    context.currentTime = 0.5;
    expect(trackAudio.setLoopTransportFxParameter(0, 'mixPercent', 1)).toBe(true);
    expect((trackAudio as any).loopTransportWetMixGainNode.gain.value).toBeCloseTo(0.01);
    expect((trackAudio as any).loopTransportDryGainNode.gain.value).toBeCloseTo(0.99);
    expect((trackAudio as any).loopMotorStates[0].targetRate).toBe(1.5);
    expect((trackAudio as any).loopTransportWetMixGainNode.gain.ramps.at(-1).time).toBeCloseTo(0.505);
    expect((trackAudio as any).loopTransportDryGainNode.gain.ramps.at(-1)).toEqual({ value: 0.99, time: 0.505 });
    expect((trackAudio as any).loopTransportDrySourceNode).toBe(dry);
    expect((trackAudio as any).sourceNode).toBe(wet);
    expect(nodes.sources).toHaveLength(2);
    expect((trackAudio as any).getCurrentPlaybackPosition()).toBeCloseTo(0.5);
    expect(trackAudio.configureLoopTransportFx(0, null)).toBe(true);
    expect((trackAudio as any).loopTransportWetMixGainNode.gain.value).toBe(0);
    expect((trackAudio as any).loopTransportDryGainNode.gain.value).toBe(1);
    trackAudio.stop();
    for (const source of nodes.sources) {
      expect(source.stopTimes).toContain(0);
      expect(source.disconnect).toHaveBeenCalledOnce();
      expect(source.onended).toBeNull();
    }
    expect((trackAudio as any).loopTransportDrySourceNode).toBeNull();
    expect((trackAudio as any).loopTransportWetMixGainNode).toBeNull();
    await trackAudio.play();
    expect(nodes.sources).toHaveLength(3);
    expect(nodes.sources[2].starts[0].offset).toBeCloseTo(0.5);
    trackAudio.stop();
  });

  it('retargets the wet reader without changing the mix and cleans every reader on stop', async () => {
    const { context, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    (trackAudio as any).audioBuffer = context.createBuffer(2, context.sampleRate * 4, context.sampleRate);
    trackAudio.configureLoopTransportFx(0, 'VINYL FLICK', { speed: 50, mixPercent: 50 });
    await trackAudio.play();
    context.currentTime = 0.2;
    trackAudio.configureLoopTransportFx(1, 'BEAT SHIFT', { offset: 1 });
    expect(nodes.sources).toHaveLength(3);
    expect((trackAudio as any).loopTransportWetMixGainNode.gain.value).toBe(0.5);
    expect((trackAudio as any).loopTransportDryGainNode.gain.value).toBe(0.5);
    const wetMix = (trackAudio as any).loopTransportWetMixGainNode;
    expect((trackAudio as any).sourceGainNode.connect).toHaveBeenLastCalledWith(wetMix);
    trackAudio.setLoopTransportFxParameter(0, 'mixPercent', 25);
    expect((trackAudio as any).sourceGainNode.gain.curves[0].values.at(-1)).toBe(1);
    expect(wetMix.gain.value).toBe(0.25);
    trackAudio.stop();
    for (const source of nodes.sources) {
      expect(source.stopTimes).toContain(0);
      expect(source.disconnect).toHaveBeenCalledOnce();
      expect(source.onended).toBeNull();
    }
    expect(wetMix.disconnect).toHaveBeenCalledOnce();
    expect((trackAudio as any).loopTransportTransitionActive).toBe(false);
  });

  it('reanchors a Vinyl wet reader to canonical phase when selecting BEAT SHIFT', async () => {
    const { context, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    (trackAudio as any).audioBuffer = context.createBuffer(2, context.sampleRate * 4, context.sampleRate);
    trackAudio.configureLoopTransportFx(0, 'VINYL FLICK', { speed: 100, mixPercent: 100, 'return-time': 0.05 });
    await trackAudio.play();
    context.currentTime = 0.5;
    expect((trackAudio as any).getCurrentPlaybackPosition()).toBeCloseTo(0.5);
    expect((trackAudio as any).loopTransportPhaseBaseSeconds).toBeGreaterThan(0.5);
    expect(trackAudio.configureLoopTransportFx(0, 'BEAT SHIFT', { offset: 0 })).toBe(true);
    expect(nodes.sources).toHaveLength(3);
    expect(nodes.sources[2].starts[0]).toEqual({ when: 0.5, offset: 0.5 });
    expect(nodes.sources[2].playbackRate.value).toBe(1);
    expect((trackAudio as any).loopTransportWetMixGainNode.gain.value).toBe(1);
    expect((trackAudio as any).loopTransportDryGainNode.gain.value).toBe(0);
    trackAudio.stop();
  });

  it('rolls back a live Vinyl selection if its canonical dry reader fails to start', async () => {
    const { context, trackAudio } = await createTrackAudioHarness();
    const nodes = installPlaybackNodeSpies(context);
    (trackAudio as any).audioBuffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
    await trackAudio.play();
    (context as any).createBufferSource.mockImplementationOnce(() => null);
    expect(trackAudio.configureLoopTransportFx(0, 'VINYL FLICK', { speed: 50, mixPercent: 50 })).toBe(false);
    expect((trackAudio as any).loopTransportFxSlots[0]).toBeNull();
    expect((trackAudio as any).loopMotorStates[0].targetRate).toBe(1);
    expect(nodes.sources).toHaveLength(1);
    expect(nodes.sources[0].stopTimes).toHaveLength(0);
    expect(trackAudio.loopTransportActive).toBe(false);
    expect(trackAudio.loopTransportUnavailableReason).toContain('Canonical dry reader creation failed');
    trackAudio.stop();
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
    trackAudio.isReverse = false;
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
      reverse: false,
    });
    expect((init?.buffers as unknown[])).toHaveLength(3);
    expect(node?.port.posted[0]?.transferList).toHaveLength(10);

    node?.port.receive({
      type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 2,
      startInputFrame: 100, endInputFrame: 102,
      indices: Uint32Array.from([5, 2]), values: Float32Array.from([0.5, 0.25]),
      oldValues: Float32Array.from([5, 2]),
    });
    node?.port.receive({
      type: 'OVERDUB_PATCH', sequence: 1, slotIndex: 1, validFrames: 1,
      startInputFrame: 102, endInputFrame: 103,
      indices: Uint32Array.from([5]), values: Float32Array.from([0.75]), oldValues: Float32Array.from([0.5]),
    });
    expect(samples[5]).toBe(0.75);
    expect(samples[2]).toBe(0.25);
    expect(node?.port.posted.slice(-2).map(({ message }) => message.type)).toEqual([
      'RECYCLE_OVERDUB_BUFFER', 'RECYCLE_OVERDUB_BUFFER',
    ]);

    trackAudio.triggerRecord();
    expect(trackAudio.state).toBe(TrackState.PLAYING);
    expect(node?.port.posted.at(-1)?.message).toMatchObject({ type: 'OVERDUB_STOP', stopFrame: 0 });
    expect(node?.disconnected).toBe(false);
    node?.port.receive({ type: 'OVERDUB_STOPPED', overflowFrames: 4, overflowEvents: 1, patchesSent: 2,
      requestedStopFrame: 0, appliedExclusiveEnd: 0, processorStopFrame: 0 });
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
