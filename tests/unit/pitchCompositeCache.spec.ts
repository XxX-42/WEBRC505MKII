import { afterEach, describe, expect, it } from 'vitest';
import { createCoreAudioHarness } from '../helpers/coreAudioHarness';
import { BrowserRealtimeOpcode } from '../../src/audio/browserRealtimeProtocol';

interface PitchCompositeCacheProbe {
  pitchVisibleTakes: Int16Array;
  readPitchCompositeStereoSample(track: number, frame: number, visibleTakes: number, loopFrames: number): void;
  readPitchSample(track: number, sourceFrame: number, channel: number): number;
  writeTakeSample(track: number, slot: number, frame: number, left: number, right: number, replace: boolean): boolean;
}

describe('keep-pitch composite PCM cache', () => {
  const harnesses: Array<ReturnType<typeof createCoreAudioHarness>> = [];

  afterEach(() => {
    harnesses.splice(0).forEach((harness) => harness.dispose());
  });

  it('invalidates exact active OD/Replace frames and drops stale branch PCM on same-depth redo replacement', async () => {
    const harness = createCoreAudioHarness(48_000);
    harnesses.push(harness);
    const track = 0;
    const frames = 256;
    const baseLeft = Float32Array.from({ length: frames }, (_, index) => 0.125 + index / 1_000);
    const baseRight = Float32Array.from({ length: frames }, (_, index) => -0.25 - index / 2_000);
    const buffer = harness.createAudioBuffer(baseLeft, baseRight);
    await harness.run(harness.runtime.loadTrack(track, buffer));
    const probe = harness.processor as typeof harness.processor & PitchCompositeCacheProbe;

    await harness.command(BrowserRealtimeOpcode.PLAY, track, 1, 0, 1);
    await harness.run(harness.runtime.beginTake(track, 'OVERDUB'));
    await harness.command(BrowserRealtimeOpcode.START_OVERDUB, track);

    // Warm both samples while the active OD plane is empty, then write into
    // those exact frames without changing visible take count.
    probe.pitchVisibleTakes[track] = 2;
    expect(probe.readPitchSample(track, 100, 0)).toBeCloseTo(baseLeft[100]!, 7);
    expect(probe.readPitchSample(track, 100, 1)).toBeCloseTo(baseRight[100]!, 7);
    expect(probe.writeTakeSample(track, 1, 100, 0.25, -0.5, false)).toBe(true);
    expect(probe.writeTakeSample(track, 1, 101, 0.125, -0.25, false)).toBe(true);
    expect(probe.readPitchSample(track, 100, 0)).toBeCloseTo(baseLeft[100]! + 0.25, 6);
    expect(probe.readPitchSample(track, 100, 1)).toBeCloseTo(baseRight[100]! - 0.5, 6);
    expect(probe.readPitchSample(track, 101, 0)).toBeCloseTo(baseLeft[101]! + 0.125, 6);

    await harness.command(BrowserRealtimeOpcode.STOP_OVERDUB, track);
    await harness.command(BrowserRealtimeOpcode.UNDO, track);
    probe.pitchVisibleTakes[track] = 1;
    expect(probe.readPitchSample(track, 101, 0)).toBeCloseTo(baseLeft[101]!, 7);

    // The new take reuses the undo slot at the same visible history depth.
    // Its untouched frame must not expose the old redo layer through cache.
    await harness.command(BrowserRealtimeOpcode.PLAY, track, 1, 0, 1);
    await harness.run(harness.runtime.beginTake(track, 'OVERDUB'));
    await harness.command(BrowserRealtimeOpcode.START_OVERDUB, track);
    expect(probe.writeTakeSample(track, 1, 100, 0.5, -0.125, false)).toBe(true);
    await harness.command(BrowserRealtimeOpcode.STOP_OVERDUB, track);
    probe.pitchVisibleTakes[track] = 2;
    expect(probe.readPitchSample(track, 100, 0)).toBeCloseTo(baseLeft[100]! + 0.5, 6);
    expect(probe.readPitchSample(track, 101, 0)).toBeCloseTo(baseLeft[101]!, 7);

    await harness.run(harness.runtime.beginTake(track, 'REPLACE1'));
    await harness.command(BrowserRealtimeOpcode.START_OVERDUB, track);
    probe.pitchVisibleTakes[track] = 3;
    expect(probe.readPitchSample(track, 100, 0)).toBeCloseTo(baseLeft[100]! + 0.5, 6);
    expect(probe.writeTakeSample(track, 2, 100, 0.75, -0.75, true)).toBe(true);
    expect(probe.readPitchSample(track, 100, 0)).toBeCloseTo(0.75, 7);
    expect(probe.readPitchSample(track, 100, 1)).toBeCloseTo(-0.75, 7);
    expect(probe.readPitchSample(track, 101, 0)).toBeCloseTo(baseLeft[101]!, 7);
  }, 30_000);

  it('wraps negative fractional reverse-reader positions using both cached stereo edge frames', async () => {
    const harness = createCoreAudioHarness(48_000);
    harnesses.push(harness);
    const track = 0;
    const frames = 256;
    const baseLeft = Float32Array.from({ length: frames }, (_, index) => 0.125 + index / 1_000);
    const baseRight = Float32Array.from({ length: frames }, (_, index) => -0.25 - index / 2_000);
    await harness.run(harness.runtime.loadTrack(track, harness.createAudioBuffer(baseLeft, baseRight)));
    const probe = harness.processor as typeof harness.processor & PitchCompositeCacheProbe;
    probe.pitchVisibleTakes[track] = 1;

    // A reverse stretch reader can request a negative fractional source frame
    // at the loop seam; this must interpolate frame 255 toward frame 0.
    const left = probe.readPitchSample(track, -0.5, 0);
    const right = probe.readPitchSample(track, -0.5, 1);
    expect(left).toBeCloseTo((baseLeft[255]! + baseLeft[0]!) / 2, 7);
    expect(right).toBeCloseTo((baseRight[255]! + baseRight[0]!) / 2, 7);
  });
});
