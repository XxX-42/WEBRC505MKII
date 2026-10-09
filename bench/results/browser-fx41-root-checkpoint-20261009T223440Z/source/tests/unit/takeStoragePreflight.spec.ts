import { afterEach, describe, expect, it } from 'vitest';
import { createCoreAudioHarness } from '../helpers/coreAudioHarness';
import {
  BROWSER_REALTIME_MAX_STORAGE_BYTES,
  BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
  BrowserRealtimeOpcode,
  TrackMetaWord,
} from '../../src/audio/browserRealtimeProtocol';

interface StorageAccountingProbe {
  storageAllocatedBytes: number;
  writeTakeSample(track: number, slot: number, frame: number, left: number, right: number, replace: boolean): boolean;
}

function metadata(harness: ReturnType<typeof createCoreAudioHarness>, track: number): Int32Array {
  const value = harness.runtime.getTrackMetadata(track);
  if (!value) throw new Error(`Track ${track + 1} metadata is unavailable.`);
  return value;
}

describe('take storage budget preflight', () => {
  const harnesses: Array<ReturnType<typeof createCoreAudioHarness>> = [];

  afterEach(() => {
    harnesses.splice(0).forEach((harness) => harness.dispose());
  });

  it('rejects an oversized import before PREPARE_TAKE drops redo PCM', async () => {
    const harness = createCoreAudioHarness(48_000);
    harnesses.push(harness);
    const track = 0;
    const baseLeft = new Float32Array(256).fill(0.125);
    const baseRight = new Float32Array(256).fill(-0.25);
    await harness.run(harness.runtime.loadTrack(track, harness.createAudioBuffer(baseLeft, baseRight)));
    await harness.command(BrowserRealtimeOpcode.PLAY, track, 1, 0, 1);
    await harness.run(harness.runtime.beginTake(track, 'OVERDUB'));
    await harness.command(BrowserRealtimeOpcode.START_OVERDUB, track);
    const workletProbe = harness.processor as typeof harness.processor & StorageAccountingProbe;
    for (let frame = 0; frame < 256; frame += 1) {
      expect(workletProbe.writeTakeSample(track, 1, frame, 0.25, -0.5, false)).toBe(true);
    }
    await harness.command(BrowserRealtimeOpcode.STOP_OVERDUB, track);
    await harness.command(BrowserRealtimeOpcode.UNDO, track);

    const before = metadata(harness, track);
    expect(Atomics.load(before, TrackMetaWord.HISTORY_CURSOR)).toBe(1);
    expect(Atomics.load(before, TrackMetaWord.HISTORY_LENGTH)).toBe(2);

    // Simulate a nearly exhausted global budget without allocating hundreds of
    // megabytes; the old eight-segment redo can be released, but the requested
    // nine-segment import still has an unavoidable one-segment net increase.
    const storageProbe = harness.runtime as unknown as StorageAccountingProbe;
    storageProbe.storageAllocatedBytes = BROWSER_REALTIME_MAX_STORAGE_BYTES - 64 * 1024;
    const importFrames = 9 * BROWSER_REALTIME_STORAGE_BLOCK_FRAMES;
    const imported = harness.createAudioBuffer(new Float32Array(importFrames).fill(0.7), new Float32Array(importFrames).fill(-0.3));
    await expect(harness.run(harness.runtime.loadTrack(track, imported))).rejects.toThrow(/budget.*existing history was preserved/i);

    expect(Atomics.load(before, TrackMetaWord.HISTORY_CURSOR)).toBe(1);
    expect(Atomics.load(before, TrackMetaWord.HISTORY_LENGTH)).toBe(2);
    expect((await harness.command(BrowserRealtimeOpcode.REDO, track)).status).toBe(0);
    const context = {
      sampleRate: 48_000,
      createBuffer(channels: number, length: number, sampleRate: number) {
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData(channel: number) { return data[channel]!; },
          copyFromChannel() {},
          copyToChannel() {},
        } as unknown as AudioBuffer;
      },
    } as unknown as AudioContext;
    const afterRedo = await harness.run(harness.runtime.exportTrack(track, context));
    expect(afterRedo.getChannelData(0)).toEqual(new Float32Array(256).fill(0.375));
    expect(afterRedo.getChannelData(1)).toEqual(new Float32Array(256).fill(-0.75));
  }, 30_000);
});
