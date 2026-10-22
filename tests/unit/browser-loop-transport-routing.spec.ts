import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import type { TrackAudio } from '../../src/audio/TrackAudio';
import { TrackState } from '../../src/core/types';

class MockAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly gain = { setTargetAtTime: vi.fn(), value: 1 };
}

class MockWorkletNode {
  static instances: MockWorkletNode[] = [];
  readonly port = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor(
    readonly context: BaseAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    MockWorkletNode.instances.push(this);
  }
}

type LoopFxName = 'BEAT SHIFT' | 'VINYL FLICK';
type LoopFxConfig = { type: LoopFxName | null; parameters: Record<string, number> };

function makeTrack(id: number, unavailableReason: string | null = null) {
  const configurations: Array<LoopFxConfig | null> = [null, null, null, null];
  const track = {
    track: { id },
    loopTransportActive: false,
    loopTransportUnavailableReason: unavailableReason,
    configurations,
    configureLoopTransportFx: vi.fn((slotIndex: number, type: LoopFxName | null, parameters: Readonly<Record<string, number>> = {}) => {
      configurations[slotIndex] = type === null ? null : { type, parameters: { ...parameters } };
      return true;
    }),
    refreshLoopTransportTempo: vi.fn(),
  };
  return track;
}

function makeEngine() {
  const inputHead = new MockAudioNode();
  const inputTail = new MockAudioNode();
  const trackHead = new MockAudioNode();
  const trackTail = new MockAudioNode();
  const trackMix = new MockAudioNode();
  const tracks = Array.from({ length: 5 }, (_, index) => makeTrack(index + 1));
  const addModule = vi.fn(async (_url: string) => undefined);
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const context = {
    sampleRate: 48000,
    currentTime: 2.25,
    audioWorklet: { addModule },
    createGain: () => new MockAudioNode(),
  } as unknown as AudioContext;
  Object.assign(engine, {
    context,
    tracks: tracks as unknown as TrackAudio[],
    inputFxChain: { input: inputHead, output: inputTail },
    outputFxChain: { input: trackHead, output: trackTail },
    trackMixNode: trackMix,
    currentInputStream: null,
    inputFxInstances: [null, null, null, null],
    trackFxInstances: [null, null, null, null],
    inputFxTypes: [null, null, null, null],
    inputFxActive: [false, false, false, false],
    trackFxTypes: [null, null, null, null],
    trackFxActive: [false, false, false, false],
    fxWorkletModuleReady: null,
    fxWorkletGeneration: 0,
    lastError: '',
    statusListeners: new Set(),
  });
  return { engine, tracks, inputHead, inputTail, trackHead, trackTail, trackMix, addModule };
}

describe('Browser Track source-aware BEAT SHIFT and VINYL FLICK routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWorkletNode.instances = [];
  });

  it('syncs active Track A–D types, named parameters, and macro updates to every TrackAudio', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const types: LoopFxName[] = ['BEAT SHIFT', 'VINYL FLICK', 'BEAT SHIFT', 'VINYL FLICK'];

    for (let slot = 0; slot < 4; slot += 1) {
      const { engine, tracks } = makeEngine();
      const type = types[slot]!;
      engine.setFxType('track', slot, type);
      if (type === 'BEAT SHIFT') {
        engine.setFxNamedParameters('track', slot, { offset: slot - 2, crossfade: 4 + slot });
      } else {
        engine.setFxNamedParameters('track', slot, { 'return-time': 0.5 + (slot / 10), brake: 20 + (slot * 10) });
        engine.setFxParam('track', slot, 70 - (slot * 10));
      }
      engine.setFxActive('track', slot, true);

      await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(slot + 1));
      expect(tracks).toHaveLength(5);
      for (const track of tracks) {
        expect(track.configurations.filter(Boolean)).toHaveLength(1);
        const config = track.configurations[slot];
        expect(config?.type).toBe(type);
        if (type === 'BEAT SHIFT') {
          expect(config?.parameters).toMatchObject({
            beatShiftOffsetBeats: slot - 2,
            beatShiftCrossfadeMs: 4 + slot,
          });
          expect(config?.parameters).not.toHaveProperty('bpm');
        } else {
          const amount = (70 - (slot * 10)) / 100;
          expect(config?.parameters).toMatchObject({
            vinylFlickSpeed: (amount * 200) - 100,
            mix: amount,
            vinylFlickReturnTimeSeconds: 0.5 + (slot / 10),
            vinylFlickBrakePercent: 20 + (slot * 10),
          });
        }
      }

      // Named edits and the generic macro continue to reach every loop after activation.
      if (type === 'BEAT SHIFT') {
        engine.setFxNamedParameters('track', slot, { offset: 1.5 });
        expect(tracks.every((track) => track.configurations[slot]?.parameters.beatShiftOffsetBeats === 1.5)).toBe(true);
      } else {
        engine.setFxParam('track', slot, 20);
        expect(tracks.every((track) => track.configurations[slot]?.parameters.vinylFlickSpeed === -60
          && track.configurations[slot]?.parameters.mix === 0.2)).toBe(true);
      }

      expect(engine.getTrackTransportStatus()).toMatchObject(Array.from({ length: 5 }, (_, trackIndex) => ({
        trackIndex,
        trackId: trackIndex + 1,
        routeMode: 'experimental-source-pre-track-mix-shared-postmix',
        perTrackFxChainAvailable: false,
        active: false,
        configuredEffects: [{ slot: ['A', 'B', 'C', 'D'][slot], type }],
        unsupportedEffects: [],
        unavailableReason: null,
      })));
    }
  });

  it('rejects source-aware effects from Input and retains the existing Beat FX rejection behavior', () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail } = makeEngine();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    engine.setFxType('input', 0, 'BEAT SHIFT');
    engine.setFxType('input', 1, 'VINYL FLICK');
    engine.setFxType('input', 2, 'BEAT REPEAT');
    engine.setFxType('input', 3, 'BEAT SCATTER');

    expect(warning).toHaveBeenCalledTimes(4);
    expect(warning).toHaveBeenCalledWith('BEAT SHIFT is available only in the Browser Track FX bank.');
    expect(warning).toHaveBeenCalledWith('VINYL FLICK is available only in the Browser Track FX bank.');
    expect((engine as unknown as { inputFxInstances: unknown[] }).inputFxInstances).toEqual([null, null, null, null]);
    expect(inputHead.connect).not.toHaveBeenCalled();
    expect(inputTail.connect).not.toHaveBeenCalled();
    expect(MockWorkletNode.instances).toHaveLength(0);
  });

  it('routes dedicated BEAT SHIFT and VINYL source transport to one loop with separate speed/mix controls', () => {
    const { engine, tracks } = makeEngine();
    const beatShift = {
      mode: 'beatShift' as const,
      beatOffsetBeats: -1.25,
      bpm: 96,
      crossfadeMs: 7,
      vinylSpeedPercent: 0,
      motorReturnSeconds: 1,
      brakePercent: 0,
      vinylMixPercent: 100,
    };

    expect(engine.setLoopTransport(3, beatShift)).toBe(true);
    expect(tracks[2]!.configurations).toEqual([
      { type: 'BEAT SHIFT', parameters: { offset: -1.25, crossfade: 7 } }, null, null, null,
    ]);
    expect(tracks.filter((_, index) => index !== 2).every((track) => track.configurations.every((slot) => slot === null))).toBe(true);

    const vinylFlick = { ...beatShift, mode: 'vinylFlick' as const };
    expect(engine.setLoopTransport(3, vinylFlick)).toBe(true);
    expect(tracks[2]!.configurations).toEqual([
      { type: 'VINYL FLICK', parameters: { speed: 0, mixPercent: 100, 'return-time': 1, brake: 0 } }, null, null, null,
    ]);
    expect(engine.setLoopTransport(0, beatShift)).toBe(false);
    expect(engine.setLoopTransport(3, { ...beatShift, beatOffsetBeats: 4.1 })).toBe(false);
    expect(tracks[2]!.configurations[0]).toEqual({ type: 'VINYL FLICK', parameters: { speed: 0, mixPercent: 100, 'return-time': 1, brake: 0 } });
  });

  it('clears a per-loop override without changing other tracks and blocks legacy shared sync from overwriting it', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, tracks } = makeEngine();
    const config = {
      mode: 'beatShift' as const, beatOffsetBeats: 0.5, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100,
    };
    expect(engine.setLoopTransport(2, config)).toBe(true);

    engine.setFxType('track', 0, 'BEAT SHIFT');
    engine.setFxNamedParameters('track', 0, { offset: -2, crossfade: 8 });
    engine.setFxActive('track', 0, true);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(1));
    expect(tracks[1]!.configurations[0]).toEqual({ type: 'BEAT SHIFT', parameters: { offset: 0.5, crossfade: 5 } });

    (tracks[1] as unknown as { state: TrackState }).state = TrackState.OVERDUBBING;
    expect(engine.clearLoopTransportOverride(2)).toBe(false);
    expect(engine.setLoopTransport(2, { ...config, mode: 'off' })).toBe(false);
    expect(tracks[1]!.configurations[0]).toEqual({ type: 'BEAT SHIFT', parameters: { offset: 0.5, crossfade: 5 } });
    (tracks[1] as unknown as { state: TrackState }).state = TrackState.STOPPED;
    expect(engine.setLoopTransport(2, { ...config, mode: 'off' })).toBe(true);
    expect(tracks[1]!.configurations.every((slot) => slot === null)).toBe(true);
    expect(tracks[0]!.configurations[0]).toMatchObject({ type: 'BEAT SHIFT', parameters: { beatShiftOffsetBeats: -2 } });
    expect(engine.clearLoopTransportOverride(2)).toBe(true);
    expect(tracks[1]!.configurations[0]).toMatchObject({ type: 'BEAT SHIFT', parameters: { beatShiftOffsetBeats: -2 } });
  });

  it('keeps the shared postmix adapters dry, gates wrong placements, clears bypass/removal, and reports conflicts per track', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, tracks, trackHead, trackTail } = makeEngine();
    engine.setFxType('track', 0, 'BEAT SHIFT');
    engine.setFxNamedParameters('track', 0, { offset: 2, crossfade: 7 });
    engine.setFxActive('track', 0, true);
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(1));

    const postmix = MockWorkletNode.instances[0]!;
    expect(postmix.options.processorOptions?.algorithm).toBe('beat-shift');
    expect(postmix.options.processorOptions?.bypassed).toBe(true);
    const postmixFx = (engine as unknown as { trackFxInstances: Array<{ input: AudioNode; output: AudioNode }> }).trackFxInstances[0]!;
    expect(trackHead.connect).toHaveBeenCalledWith(postmixFx.input);
    expect((postmixFx.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
    const bypassValues = postmix.port.postMessage.mock.calls
      .map(([message]) => message as { type?: string; value?: boolean })
      .filter((message) => message.type === 'set-bypass')
      .map((message) => message.value);
    expect(bypassValues.length).toBeGreaterThan(0);
    expect(bypassValues.every((value) => value === true)).toBe(true);
    expect(tracks.every((track) => track.configurations[0]?.type === 'BEAT SHIFT')).toBe(true);

    // A later transport slot cannot jump ahead of an earlier active effect.
    engine.setFxType('track', 1, 'VINYL FLICK');
    engine.setFxActive('track', 1, true);
    expect(tracks.every((track) => track.configurations[1] === null)).toBe(true);
    expect(engine.getTrackTransportStatus()[0]?.configuredEffects).toEqual([{ slot: 'A', type: 'BEAT SHIFT' }]);
    expect(engine.getTrackTransportStatus()[0]?.unsupportedEffects).toEqual([{
      slot: 'B',
      type: 'VINYL FLICK',
      reason: 'Track FX B source-aware transport is unsupported because active slot A must run before it',
    }]);

    tracks[1]!.loopTransportUnavailableReason = 'BEAT SHIFT is unavailable while LIVE_MONO playback is enabled';
    tracks[2]!.loopTransportUnavailableReason = 'BEAT SHIFT is unavailable while LIVE_POLY playback is enabled';
    tracks[3]!.loopTransportUnavailableReason = 'BEAT SHIFT requires forward playback while reverse is active';
    expect(engine.getTrackTransportStatus().map((status) => status.unavailableReason)).toEqual([
      null,
      'BEAT SHIFT is unavailable while LIVE_MONO playback is enabled',
      'BEAT SHIFT is unavailable while LIVE_POLY playback is enabled',
      'BEAT SHIFT requires forward playback while reverse is active',
      null,
    ]);

    engine.setFxActive('track', 0, false);
    expect(tracks.every((track) => track.configurations[0] === null)).toBe(true);
    expect(tracks.every((track) => track.configurations[1]?.type === 'VINYL FLICK')).toBe(true);
    engine.setFxType('track', 1, '');
    expect(tracks.every((track) => track.configurations[1] === null)).toBe(true);
    expect((engine as unknown as { trackFxInstances: unknown[] }).trackFxInstances[1]).toBeNull();
  });
});
