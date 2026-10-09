import { describe, expect, it } from 'vitest';
import { TrackAudio } from '../../src/audio/TrackAudio';
import { Track, TrackState } from '../../src/core/types';
import { Transport } from '../../src/core/Transport';
import type { IAudioEngine } from '../../src/audio/AudioEngineInterface';
import { createCoreAudioHarness } from '../helpers/coreAudioHarness';
import {
  BROWSER_REALTIME_TRACK_COUNT,
  CONTROL_TRACK_STATES_BYTE_OFFSET,
  TrackMetaWord,
} from '../../src/audio/browserRealtimeProtocol';

function audioParam() {
  return {
    value: 0,
    setTargetAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime() {},
  };
}

function audioNode() {
  return {
    gain: audioParam(),
    pan: audioParam(),
    frequency: audioParam(),
    Q: audioParam(),
    delayTime: audioParam(),
    type: 'lowpass',
    buffer: null as AudioBuffer | null,
    connect() {},
    disconnect() {},
  };
}

function createContext() {
  return {
    sampleRate: 48_000,
    currentTime: 0,
    createGain: audioNode,
    createStereoPanner: audioNode,
    createBiquadFilter: audioNode,
    createDelay: audioNode,
    createConvolver: audioNode,
    createBuffer(channelCount: number, length: number, sampleRate: number) {
      const channels = Array.from({ length: channelCount }, () => new Float32Array(length));
      return {
        numberOfChannels: channelCount,
        length,
        sampleRate,
        getChannelData(channel: number) { return channels[channel]!; },
      } as AudioBuffer;
    },
  } as unknown as AudioContext;
}

describe('imported track state publication', () => {
  it('publishes STOPPED before load ACK, refreshes TrackAudio, and plays the imported stereo PCM after clear/reload', async () => {
    const harness = createCoreAudioHarness();
    const context = createContext();
    const transport = Transport.getInstance();
    transport.stop();
    transport.resetMasterTrack();

    const tracks: TrackAudio[] = [];
    const engine = {
      context,
      trackMixNode: audioNode(),
      realtimeRuntime: harness.runtime,
      isReady: true,
      tracks,
      checkAndResetMaster() { transport.resetMasterTrack(); },
      reportRuntimeError() {},
      selectedInputDeviceId: null,
      selectedOutputDeviceId: null,
      selectedBufferFrames: 128,
      roundTripLatency: 0,
    } as unknown as IAudioEngine;
    const sharedStates = new Int32Array(
      harness.controlBuffer,
      CONTROL_TRACK_STATES_BYTE_OFFSET,
      BROWSER_REALTIME_TRACK_COUNT,
    );
    const trackAudio = new TrackAudio(engine, new Track(1), 0, sharedStates, null);
    tracks.push(trackAudio);
    let stateNotifications = 0;
    harness.runtime.setMessageHandler((message) => {
      if (message.type === 'TRACK_STATE_CHANGED' && message.track === 0) {
        stateNotifications += 1;
        trackAudio.refreshRuntimeStateFromWorklet();
      }
    });

    const loadAndPlay = async (leftValue: number, rightValue: number) => {
      const left = new Float32Array(2_048).fill(leftValue);
      const right = new Float32Array(2_048).fill(rightValue);
      const source = harness.createAudioBuffer(left, right);
      const token = harness.runtime.beginProjectLock();
      try {
        await harness.run(harness.runtime.loadTrackForProject(0, source, token));
      } finally {
        harness.runtime.endProjectLock(token);
      }

      const metadata = harness.runtime.getTrackMetadata(0);
      expect(metadata && Atomics.load(metadata, TrackMetaWord.STATE)).toBe(6);
      expect(harness.runtime.getMetrics().trackStates[0]).toBe(6);
      expect(trackAudio.state).toBe(TrackState.STOPPED);
      expect(stateNotifications).toBeGreaterThan(0);

      await harness.run(trackAudio.play());
      const [outputLeft, outputRight] = harness.lastQuantumOutput()[0]!;
      expect(outputLeft?.[0]).toBeCloseTo(leftValue, 6);
      expect(outputRight?.[0]).toBeCloseTo(rightValue, 6);
    };

    try {
      await loadAndPlay(0.25, -0.375);
      await harness.run(trackAudio.stop());
      await harness.run(trackAudio.clear());
      expect(trackAudio.state).toBe(TrackState.EMPTY);
      stateNotifications = 0;
      await loadAndPlay(-0.125, 0.5);
    } finally {
      harness.dispose();
    }
  });
});
