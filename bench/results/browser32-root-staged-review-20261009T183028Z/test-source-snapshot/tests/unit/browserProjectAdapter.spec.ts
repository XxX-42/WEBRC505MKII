import { describe, expect, it } from 'vitest';
import { BrowserProjectAdapter } from '../../src/project/BrowserProjectAdapter';
import { createDefaultProjectDocument } from '../../src/project/projectValidation';
import { Transport } from '../../src/core/Transport';
import { Track, TrackState, TransportState } from '../../src/core/types';
import type { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import type { TrackAudio } from '../../src/audio/TrackAudio';

function audioBuffer(length: number, sampleRate = 48_000): AudioBuffer {
  const channels = [new Float32Array(length), new Float32Array(length)];
  return {
    length,
    sampleRate,
    numberOfChannels: 2,
    getChannelData: (channel: number) => channels[channel]!,
  } as AudioBuffer;
}

function makeFixture() {
  const transport = Transport.getInstance();
  transport.stop();
  transport.resetMasterTrack();
  transport.setBpm(120);
  let renderedFrame = 10_000;
  const calls: Array<{ name: string; token?: symbol }> = [];
  const buffers: Array<AudioBuffer | null> = Array.from({ length: 5 }, () => null);
  const tracks = Array.from({ length: 5 }, (_, index) => {
    const model = new Track(index + 1);
    return {
      track: model,
      state: TrackState.EMPTY,
      fxChain: {
        getSnapshot: () => ({}),
        applySnapshot: () => undefined,
        filter: { setEnabled: () => undefined, setParam: () => undefined },
      },
      getRuntimeSettings: () => ({
        reverse: false, oneShot: false, startMode: 'IMMEDIATE', stopMode: 'IMMEDIATE',
        fadeInMs: 0, fadeOutMs: 0, speed: 1, keepPitch: false,
        autoRec: { enabled: false, threshold: 0.5, debounceMs: 100 }, dubMode: 'OVERDUB',
      }),
      exportAudioBuffer: async () => buffers[index] ?? audioBuffer(0),
      importAudioBufferForProject: async (buffer: AudioBuffer) => {
        buffers[index] = buffer;
        // Model the legacy per-track import side effect that can nominate the
        // first restored recording as master. The adapter must override it.
        if (!transport.hasMasterTrack()) {
          transport.setMasterTrack(index + 1, buffer.length / buffer.sampleRate, buffer.sampleRate, buffer.length, renderedFrame);
        }
      },
      clearForProject: async () => { buffers[index] = null; },
      updateRuntimeSettingsForProject: async () => undefined,
      updateSettings: () => undefined,
      filterEnabled: false,
    } as unknown as TrackAudio;
  });
  const runtime = {
    beginProjectLock: () => Symbol('project-lock'),
    endProjectLock: () => undefined,
    getMetrics: () => ({
      renderedFrame,
      loopFrames: buffers.map((buffer) => buffer?.length ?? 0),
    }),
  };
  const engine = {
    isReady: true,
    realtimeRuntime: runtime,
    context: { sampleRate: 48_000 },
    tracks,
    memorySettings: {
      loopSyncMode: 'MEASURE', tempoSyncMode: 'PITCH', bounceIn: 'OFF', playMode: 'MULTI', recAction: 'REC->DUB',
      quantize: 'OFF', autoRecSw: 'OFF', autoRecSens: 50, bounceSw: 'OFF', bounceTrack: 5, singleTrackChange: 'IMMEDIATE',
      currentTrack: 1, fadeTimeIn: '2MEAS', fadeTimeOut: '2MEAS', allStartTrk: Array(5).fill(false), allStopTrk: Array(5).fill(false),
      loopLength: 'AUTO', speedChange: 'IMMEDIATE', syncAdjust: 'MEASURE', inputMic1: 'ON', inputMic2: 'ON',
      inputInst1L: 'ON', inputInst1R: 'ON', inputInst2L: 'ON', inputInst2R: 'ON', inputRhythm: 'ON',
    },
    projectMixer: createDefaultProjectDocument().mixer,
    activeFxBankId: 'bank-1',
    fxBanks: createDefaultProjectDocument().fxBanks,
    inputFxChain: { getSnapshot: () => ({}), applySnapshot: () => undefined },
    outputFxChain: { getSnapshot: () => ({}), applySnapshot: () => undefined },
    selectedInputDeviceId: null,
    selectedOutputDeviceId: null,
    monitoringEnabled: false,
    setInputDevice: async () => undefined,
    setOutputDevice: async () => undefined,
    applyMixerState: (state: unknown, token?: symbol) => {
      calls.push({ name: 'applyMixerState', token });
      (engine as { projectMixer: unknown }).projectMixer = state;
    },
    setMasterLevel: () => undefined,
    applyFxBankStateForProject: async (_banks: unknown, _activeId: string, token: symbol) => {
      calls.push({ name: 'applyFxBankStateForProject', token });
    },
    refreshInputRoutingFxForProject: async (token: symbol) => {
      calls.push({ name: 'refreshInputRoutingFxForProject', token });
    },
    applyRoutingStateForProject: async (_state: unknown, token: symbol) => {
      calls.push({ name: 'applyRoutingStateForProject', token });
    },
    resetRoutingStateForProject: async (token: symbol) => {
      calls.push({ name: 'resetRoutingStateForProject', token });
    },
    setTrackFxSend: async (_trackId: number, _enabled: boolean, token?: symbol) => {
      calls.push({ name: 'setTrackFxSend', token });
    },
    applyRhythmSnapshotForProject: async (_snapshot: unknown, token: symbol) => {
      calls.push({ name: 'applyRhythmSnapshotForProject', token });
    },
    setMonitoringForProject: async (enabled: boolean, token: symbol) => {
      calls.push({ name: `setMonitoringForProject:${enabled}`, token });
      (engine as { monitoringEnabled: boolean }).monitoringEnabled = enabled;
    },
    stopTransportForProject: async (token: symbol) => {
      calls.push({ name: 'stopTransportForProject', token });
      transport.stop();
    },
    resetTransportMasterForProject: (token: symbol) => {
      calls.push({ name: 'resetTransportMasterForProject', token });
      transport.resetMasterTrack();
    },
    applyLoopSettingsForProject: async (settings: {
      bpm: number; masterTrackId: number | null; loopSyncMode: string; tempoSyncMode: string; quantize: string;
    }) => {
      engine.memorySettings.loopSyncMode = settings.loopSyncMode;
      engine.memorySettings.tempoSyncMode = settings.tempoSyncMode;
      engine.memorySettings.quantize = settings.quantize;
      transport.resetMasterTrack();
      if (settings.masterTrackId === null) {
        transport.setBpm(settings.bpm);
        return;
      }
      const masterBuffer = buffers[settings.masterTrackId - 1];
      if (!masterBuffer) throw new Error('The restored master track has no audio.');
      transport.setMasterTrack(
        settings.masterTrackId,
        masterBuffer.length / masterBuffer.sampleRate,
        masterBuffer.sampleRate,
        masterBuffer.length,
        renderedFrame,
      );
      transport.setBpm(settings.bpm);
    },
    setMonitoring: (enabled: boolean) => { (engine as { monitoringEnabled: boolean }).monitoringEnabled = enabled; },
  };
  return {
    adapter: new BrowserProjectAdapter(engine as unknown as BrowserAudioEngine),
    engine,
    buffers,
    setFrame: (frame: number) => { renderedFrame = frame; },
    transport,
    calls,
  };
}

describe('BrowserProjectAdapter master clock restoration', () => {
  it('rejects an enabled legacy track FX slot before stopping transport or clearing existing PCM', async () => {
    const fixture = makeFixture();
    const oldBuffer = audioBuffer(32);
    fixture.buffers[0] = oldBuffer;
    const project = createDefaultProjectDocument('unsupported legacy FX');
    project.tracks[0]!.settings.fxSlots[0] = {
      type: 'FILTER', enabled: true, params: { frequency: 0.3, resonance: 0.1 },
    };
    (fixture.adapter as unknown as { projectLockToken: symbol }).projectLockToken = Symbol('lock');

    await expect(fixture.adapter.applyProject(project, new Map())).rejects.toThrow(/enabled legacy FX slots/);

    expect(fixture.buffers[0]).toBe(oldBuffer);
    expect(fixture.calls).toEqual([]);
    expect(fixture.transport.state).toBe(TransportState.STOPPED);
  });

  it('restores A(93 BPM) → B(127 BPM) → A without keeping the prior master or tempo', async () => {
    const fixture = makeFixture();
    const apply = async (bpm: number, masterTrackId: number, lengths: number[]) => {
      const project = createDefaultProjectDocument(`project-${bpm}`);
      project.global.bpm = bpm;
      project.global.masterTrackId = masterTrackId;
      project.routing.monitoringEnabled = masterTrackId === 1;
      project.tracks.forEach((track, index) => {
        track.settings.loopFrames = lengths[index]!;
        if (lengths[index]! > 0) track.audioAssetId = `track-${index + 1}`;
      });
      const assets = new Map<string, AudioBuffer>();
      lengths.forEach((length, index) => { if (length > 0) assets.set(`track-${index + 1}`, audioBuffer(length)); });
      const token = Symbol('lock');
      (fixture.adapter as unknown as { projectLockToken: symbol }).projectLockToken = token;
      try { await fixture.adapter.applyProject(project, assets); }
      finally { (fixture.adapter as unknown as { projectLockToken: symbol | null }).projectLockToken = null; }
      return token;
    };

    await apply(93, 1, [12_345, 0, 0, 0, 0]);
    expect(fixture.transport.bpm).toBe(93);
    expect(fixture.transport.masterTrackId).toBe(1);
    expect(fixture.transport.masterLoopLengthSamples).toBe(12_345);
    expect(fixture.transport.masterOriginFrame).toBe(10_000);

    fixture.setFrame(20_000);
    await apply(127, 2, [24_000, 24_000, 0, 0, 0]);
    expect(fixture.transport.bpm).toBe(127);
    expect(fixture.transport.masterTrackId).toBe(2);
    expect(fixture.transport.masterLoopLengthSamples).toBe(24_000);
    expect(fixture.transport.masterOriginFrame).toBe(20_000);

    fixture.setFrame(30_000);
    const finalToken = await apply(93, 1, [12_345, 0, 0, 0, 0]);
    expect(fixture.transport.bpm).toBe(93);
    expect(fixture.transport.masterTrackId).toBe(1);
    expect(fixture.transport.masterLoopLengthSamples).toBe(12_345);
    expect(fixture.transport.masterOriginFrame).toBe(30_000);
    expect(fixture.transport.state).toBe(TransportState.STOPPED);
    expect(fixture.calls.some((call) => call.name === 'applyFxBankStateForProject' && call.token === finalToken)).toBe(true);
    expect(fixture.calls.some((call) => call.name === 'applyRoutingStateForProject' && call.token === finalToken)).toBe(true);
    expect(fixture.calls.some((call) => call.name === 'setMonitoringForProject:true' && call.token === finalToken)).toBe(true);
    expect(fixture.calls.some((call) => call.name === 'stopTransportForProject' && call.token === finalToken)).toBe(true);
    expect(fixture.calls.some((call) => call.name === 'resetTransportMasterForProject' && call.token === finalToken)).toBe(true);
  });
});
