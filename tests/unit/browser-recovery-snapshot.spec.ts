import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { audioBufferPcmBytes } from '../../src/audio/PcmHistoryBudget';
import { TrackState, TransportState } from '../../src/core/types';
import { Transport } from '../../src/core/Transport';
import { createMockAudioContext } from '../helpers/audioTestUtils';

class SnapshotWorklet {
  static instances: SnapshotWorklet[] = [];
  readonly port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  onprocessorerror: (() => void) | null = null;

  constructor(readonly context: BaseAudioContext, readonly name: string, readonly options: AudioWorkletNodeOptions) {
    SnapshotWorklet.instances.push(this);
  }
}

describe('Browser closed-context recovery snapshot contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    SnapshotWorklet.instances = [];
    const transport = Transport.getInstance();
    transport.stop();
    transport.resetMasterTrack();
  });

  it('captures PCM/history references, shared budget, acknowledged FX/rhythm and transport without mutating the old graph', async () => {
    const context = createMockAudioContext();
    const AudioContextForTest = function () { return context; } as unknown as typeof AudioContext;
    const previousAudioContext = globalThis.AudioContext;
    globalThis.AudioContext = AudioContextForTest;
    vi.stubGlobal('AudioWorkletNode', SnapshotWorklet);
    let engine: BrowserAudioEngine;
    try { engine = new BrowserAudioEngine(); } finally { globalThis.AudioContext = previousAudioContext; }
    const transport = Transport.getInstance();
    transport.timeSignature = [5, 8];
    transport.setBpm(107);
    engine.selectedInputDeviceId = 'remembered-input-only';
    engine.selectedOutputDeviceId = 'remembered-output-only';
    engine.selectedBufferFrames = 256;

    const [track] = engine.tracks;
    const current = context.createBuffer(2, 256, context.sampleRate);
    const undo = context.createBuffer(2, 128, context.sampleRate);
    (track as any).audioBuffer = current;
    (track as any).pcmHistory = {
      snapshot: { buffer: undo, isReverse: true, master: { bpm: 96, measureLength: 1.25, lengthSamples: 55_125 } },
      direction: 'undo',
    };
    (track as any).projectPcmRevision = 17;
    const historyBudget = (track as any).pcmHistoryBudget;
    expect(historyBudget.replace(track, audioBufferPcmBytes(undo))).toBe(true);
    track.track.playLevel = 137;
    track.track.pan = -23;
    track.track.filterEnabled = true;
    track.track.filterValue = 0.42;
    (track as any).liveMonoPitchEnabledInternal = true;
    (track as any).liveMonoPitchSemitones = -3.5;
    (track as any).liveMonoPitchMinimumFrequencyHz = 60;
    (track as any).liveMonoPitchMaximumFrequencyHz = 1_100;
    track.state = TrackState.PLAYING;

    engine.setFxType('input', 0, 'RING.MOD');
    await vi.waitFor(() => expect(SnapshotWorklet.instances).toHaveLength(1));
    engine.setFxParam('input', 0, 35);
    engine.setFxNamedParameters('input', 0, { ringModWaveform: 1, ringModHz: 1_250 });
    engine.setFxActive('input', 0, true);

    expect(engine.setTrackFxType(1, 0, 'DSP HPF')).toBe(true);
    await vi.waitFor(() => expect(engine.getTrackFxStatus(1)[0]?.slots[0]?.state).toBe('ready'));
    expect(engine.setTrackFxNamedParameters(1, 0, { cutoffHz: 380, q: 2, mix: 55 })).toBe(true);
    expect(engine.setTrackFxActive(1, 0, true)).toBe(true);
    expect(engine.setLoopTransport(1, {
      mode: 'vinylFlick', beatOffsetBeats: 0, bpm: 107, crossfadeMs: 5,
      vinylSpeedPercent: 20, motorReturnSeconds: 1.2, brakePercent: 40, vinylMixPercent: 60,
    })).toBe(true);

    expect(engine.rhythmEngine.setSettings({
      patternIndex: 106, kitIndex: 3, variation: 'A', section: 'fill', swingPercent: 60, quantizeGrid: '1/8',
    })).toBe(true);
    engine.rhythmEngine.setVolume(73);
    transport.state = TransportState.PLAYING;
    expect(() => engine.getRecoverySnapshot()).toThrow(/only after the old AudioContext has closed/);
    (context as unknown as { state: AudioContextState }).state = 'closed';
    engine.masterGainNode.gain.value = 0.72;
    engine.mainGainNode.gain.value = 0.64;
    engine.trackMixNode.gain.value = 0.88;

    const beforeBudget = historyBudget.retainedBytes;
    const snapshot = engine.getRecoverySnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.source).toEqual({ contextState: 'closed', sampleRate: context.sampleRate,
      inputDevicePreference: 'remembered-input-only', outputDevicePreference: 'remembered-output-only', lastObservedRenderBlockFrames: 256 });
    expect(snapshot.transport).toMatchObject({ bpm: 107, timeSignature: [5, 8], state: 'PLAYING' });
    expect(snapshot.rhythm).toMatchObject({ patternIndex: 106, kitIndex: 3, section: 'fill', swingPercent: 60, quantizeGrid: '1/8', volumePercent: 73, wasRunning: false });
    expect(snapshot.tracks[0]).toMatchObject({
      trackId: 1, state: TrackState.PLAYING, wasPlaying: true, projectPcmRevision: 17,
      bufferBytes: audioBufferPcmBytes(current), isReverse: false,
      settings: { playLevel: 137, pan: 'L23', filterEnabled: true, filterValue: 0.42 },
      history: { direction: 'undo', retainedBytes: audioBufferPcmBytes(undo), isReverse: true },
      pitch: { mode: 'LIVE_MONO', liveMono: { semitones: -3.5, minimumFrequencyHz: 60, maximumFrequencyHz: 1_100 } },
    });
    expect(snapshot.pcmHistoryBudget).toEqual({ retainedBytes: beforeBudget, limitBytes: historyBudget.limitBytes });
    expect(snapshot.tracks[0]?.buffer).toBe(current);
    expect(snapshot.tracks[0]?.history.buffer).toBe(undo);
    expect(snapshot.tracks[0]?.sourceTransport[0]?.type).toBe('VINYL FLICK');
    expect(snapshot.pcmHistoryBudget).toEqual({ retainedBytes: beforeBudget, limitBytes: historyBudget.limitBytes });
    expect(snapshot.tracks.reduce((total, item) => total + item.history.retainedBytes, 0)).toBe(beforeBudget);
    expect(snapshot.fx.input[0]).toMatchObject({ type: 'RING.MOD', active: true, state: 'ready', parametersCaptured: true });
    expect(snapshot.fx.input[0]?.parameters).toMatchObject({ ringModWaveform: 1, ringModHz: 1_250 });
    expect(snapshot.fx.privateTracks[0]?.[0]).toMatchObject({ type: 'DSP HPF', active: true, state: 'ready', parametersCaptured: true });
    expect(snapshot.fx.privateTracks[0]?.[0]?.parameters).toMatchObject({ cutoffHz: 380, q: 2, mix: 55 });
    expect(snapshot.fx.sourceOverrides[0]?.trackId).toBe(1);
    expect(snapshot.fx.sourceOverrides[0]?.config.mode).toBe('vinylFlick');
    expect(snapshot.midi).toMatchObject({ sourceInputState: 'disconnected', target: null });
    expect(snapshot).toMatchObject({ outputGainValue: 0.72, mainGainValue: 0.64, trackMixGainValue: 0.88, monitoringWasEnabled: false });
    expect(snapshot.recoveryPolicy).toEqual({
      playback: 'start-stopped', monitoring: 'start-muted', input: 'explicit-user-reconnect',
      midi: 'target-restored-disconnected', dynamicDspState: 'not-captured', effectTails: 'discarded',
    });
    expect(historyBudget.retainedBytes).toBe(beforeBudget);

    track.track.playLevel = 40;
    expect(snapshot.tracks[0]?.settings.playLevel).toBe(137);
    expect(snapshot.tracks[0]?.buffer).toBe((track as any).audioBuffer);
    (track as any).recordingStarting = true;
    expect(() => engine.getRecoverySnapshot()).toThrow(/Finish recording/);
  });
});
