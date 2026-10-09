import { afterEach, describe, expect, it } from 'vitest';
import { createCoreAudioHarness, recordBaseTrack } from '../helpers/coreAudioHarness';
import {
  BROWSER_REALTIME_QUANTUM_FRAMES,
  BrowserRealtimeOpcode,
  BrowserRealtimeStatus,
  ControlWord,
  TrackMetaWord,
} from '../../src/audio/browserRealtimeProtocol';
import type { RhythmKitDocument, RhythmPatternDocument } from '../../src/audio/rhythmTypes';
import { Transport } from '../../src/core/Transport';

const SAMPLE_RATE = 48_000;
const harnesses: Array<ReturnType<typeof createCoreAudioHarness>> = [];

function makeHarness() {
  const harness = createCoreAudioHarness(SAMPLE_RATE);
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  harnesses.splice(0).forEach((harness) => harness.dispose());
});

function meta(harness: ReturnType<typeof createCoreAudioHarness>, track: number, word: number) {
  const view = harness.runtime.getTrackMetadata(track);
  if (!view) throw new Error(`Track ${track + 1} metadata is unavailable.`);
  return Atomics.load(view, word);
}

function constant(left: number, right = left) {
  return (_frame: number, channel: 0 | 1) => channel === 0 ? left : right;
}

function tone(frequency: number, leftAmplitude = 0.4, rightAmplitude = 0.4) {
  return (frame: number, channel: 0 | 1) => Math.sin(2 * Math.PI * frequency * frame / SAMPLE_RATE) * (channel === 0 ? leftAmplitude : rightAmplitude);
}

describe('integrated browser worklet audio behavior', () => {
  it('AutoRec rejects low noise and a short spike, then records a sustained 250 Hz input after 20 ms', async () => {
    const harness = makeHarness();
    const track = 0;
    await harness.run(harness.runtime.prepareTrack(track));
    await harness.run(harness.runtime.beginTake(track, 'BASE'));
    const debounceFrames = Math.round(SAMPLE_RATE * 0.020);
    await harness.command(BrowserRealtimeOpcode.SET_AUTO_REC, track, 1, Math.round(0.2 * 32_767), debounceFrames);
    await harness.command(BrowserRealtimeOpcode.START_RECORD, track);
    expect(meta(harness, track, TrackMetaWord.STATE)).toBe(1); // REC_STANDBY

    let seed = 0x12345678;
    await harness.processFrames(SAMPLE_RATE / 2, () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return ((seed >>> 0) / 0xffff_ffff - 0.5) * 0.04;
    });
    expect(meta(harness, track, TrackMetaWord.STATE)).toBe(1);
    expect(meta(harness, track, TrackMetaWord.RECORDING_FRAMES)).toBe(0);

    await harness.processFrames(4, constant(0.95, -0.95));
    await harness.processFrames(SAMPLE_RATE / 4, constant(0));
    expect(meta(harness, track, TrackMetaWord.STATE)).toBe(1);

    await harness.processFrames(SAMPLE_RATE / 10, tone(250, 0.4, 0.25));
    expect(meta(harness, track, TrackMetaWord.STATE)).toBe(2); // RECORDING
    expect(meta(harness, track, TrackMetaWord.RECORDING_FRAMES)).toBeGreaterThan(2_000);
    const stopped = await harness.command(BrowserRealtimeOpcode.STOP_RECORD, track);
    expect(stopped.status).toBe(BrowserRealtimeStatus.OK);
    expect(stopped.loopFrames).toBeGreaterThan(2_000);
    const exported = await harness.run(harness.runtime.exportTrack(track, {
      sampleRate: SAMPLE_RATE,
      createBuffer: (channels: number, length: number, sampleRate: number) => makeAudioBuffer(channels, length, sampleRate),
    } as unknown as AudioContext));
    const left = exported.getChannelData(0);
    expect(left.some((sample) => Math.abs(sample) > 0.1)).toBe(true);
    const crossingCount = countZeroCrossings(left.subarray(0, Math.min(left.length, 1_000)));
    expect(crossingCount).toBeGreaterThanOrEqual(8);
    expect(crossingCount).toBeLessThanOrEqual(14);
  }, 30_000);

  it('keeps the committed BASE when AutoRec is armed and cancelled before threshold', async () => {
    const harness = makeHarness();
    const track = 0;
    const base = constant(0.125, -0.25);
    const firstFrames = await recordBaseTrack(harness, track, 512, base);
    const before = await harness.run(harness.runtime.exportTrack(track, {
      sampleRate: SAMPLE_RATE,
      createBuffer: (channels: number, length: number, sampleRate: number) => makeAudioBuffer(channels, length, sampleRate),
    } as unknown as AudioContext));
    expect(firstFrames).toBeGreaterThan(0);

    await harness.command(BrowserRealtimeOpcode.SET_AUTO_REC, track, 1, Math.round(0.3 * 32_767), Math.round(SAMPLE_RATE * 0.02));
    await harness.run(harness.runtime.beginTake(track, 'BASE'));
    await harness.command(BrowserRealtimeOpcode.START_RECORD, track);
    expect(meta(harness, track, TrackMetaWord.STATE)).toBe(1);
    const cancelled = await harness.command(BrowserRealtimeOpcode.CANCEL_PENDING, track);
    expect(cancelled.status).toBe(BrowserRealtimeStatus.OK);
    expect(meta(harness, track, TrackMetaWord.HISTORY_CURSOR)).toBe(1);
    expect(meta(harness, track, TrackMetaWord.LOOP_FRAMES)).toBe(firstFrames);

    const after = await harness.run(harness.runtime.exportTrack(track, {
      sampleRate: SAMPLE_RATE,
      createBuffer: (channels: number, length: number, sampleRate: number) => makeAudioBuffer(channels, length, sampleRate),
    } as unknown as AudioContext));
    expect(after.length).toBe(before.length);
    expect(after.getChannelData(0)).toEqual(before.getChannelData(0));
    expect(after.getChannelData(1)).toEqual(before.getChannelData(1));
  }, 30_000);

  it('records two different BASE takes through the real processor and round-trips exact PCM across Empty, Undo, and Redo', async () => {
    const harness = makeHarness();
    const track = 0;
    const firstFrames = await recordBaseTrack(harness, track, 257, constant(0.125, -0.25));
    const first = await exportTrack(harness, track);
    expect(firstFrames).toBe(first.length);
    expect(first.length).toBeGreaterThan(0);
    expect(first.getChannelData(0)).toEqual(new Float32Array(first.length).fill(0.125));
    expect(first.getChannelData(1)).toEqual(new Float32Array(first.length).fill(-0.25));
    expect(meta(harness, track, TrackMetaWord.HISTORY_CURSOR)).toBe(1);

    const undoFirst = await harness.command(BrowserRealtimeOpcode.UNDO, track);
    expect(undoFirst.status).toBe(BrowserRealtimeStatus.OK);
    expect(meta(harness, track, TrackMetaWord.HISTORY_CURSOR)).toBe(0);
    expect(meta(harness, track, TrackMetaWord.LOOP_FRAMES)).toBe(0);
    expect(meta(harness, track, TrackMetaWord.STATE)).toBe(0); // EMPTY after Undo of the initial BASE take.

    const redoFirst = await harness.command(BrowserRealtimeOpcode.REDO, track);
    expect(redoFirst.status).toBe(BrowserRealtimeStatus.OK);
    expect(meta(harness, track, TrackMetaWord.LOOP_FRAMES)).toBe(first.length);
    const restoredFirst = await exportTrack(harness, track);
    expect(restoredFirst.getChannelData(0)).toEqual(first.getChannelData(0));
    expect(restoredFirst.getChannelData(1)).toEqual(first.getChannelData(1));

    const secondFrames = await recordBaseTrack(harness, track, 389, constant(-0.375, 0.5));
    const second = await exportTrack(harness, track);
    expect(secondFrames).toBe(second.length);
    expect(second.length).toBeGreaterThan(first.length);
    expect(second.getChannelData(0)).toEqual(new Float32Array(second.length).fill(-0.375));
    expect(second.getChannelData(1)).toEqual(new Float32Array(second.length).fill(0.5));

    const undoSecond = await harness.command(BrowserRealtimeOpcode.UNDO, track);
    expect(undoSecond.status).toBe(BrowserRealtimeStatus.OK);
    expect(meta(harness, track, TrackMetaWord.LOOP_FRAMES)).toBe(first.length);
    const restoredAfterUndo = await exportTrack(harness, track);
    expect(restoredAfterUndo.getChannelData(0)).toEqual(first.getChannelData(0));
    expect(restoredAfterUndo.getChannelData(1)).toEqual(first.getChannelData(1));

    const redoSecond = await harness.command(BrowserRealtimeOpcode.REDO, track);
    expect(redoSecond.status).toBe(BrowserRealtimeStatus.OK);
    expect(meta(harness, track, TrackMetaWord.LOOP_FRAMES)).toBe(second.length);
    const restoredSecond = await exportTrack(harness, track);
    expect(restoredSecond.getChannelData(0)).toEqual(second.getChannelData(0));
    expect(restoredSecond.getChannelData(1)).toEqual(second.getChannelData(1));
  }, 30_000);

  it('plays a one-shot to completion, retriggers from the start, and rejects overdub while one-shot is enabled', async () => {
    const harness = makeHarness();
    const track = 0;
    const loopFrames = await recordBaseTrack(harness, track, 512, tone(220));
    await harness.command(BrowserRealtimeOpcode.SET_ONE_SHOT, track, 1);
    await harness.command(BrowserRealtimeOpcode.PLAY, track, 1);
    await harness.processFrames(loopFrames + BROWSER_REALTIME_QUANTUM_FRAMES);
    expect(meta(harness, track, TrackMetaWord.STATE)).toBe(6); // STOPPED

    await harness.command(BrowserRealtimeOpcode.PLAY, track, 1);
    expect(meta(harness, track, TrackMetaWord.STATE)).toBe(4); // PLAYING
    await harness.run(harness.runtime.beginTake(track, 'OVERDUB'));
    const overdub = await harness.command(BrowserRealtimeOpcode.START_OVERDUB, track);
    expect(overdub.status).toBe(BrowserRealtimeStatus.INVALID_STATE);
    expect(meta(harness, track, TrackMetaWord.STATE)).toBe(4);
    expect(meta(harness, track, TrackMetaWord.HISTORY_CURSOR)).toBe(1);
  }, 30_000);

  it('applies fade stop and waits for the loop boundary before stopping, with a second stop acknowledged', async () => {
    const harness = makeHarness();
    const track = 0;
    const loopFrames = await recordBaseTrack(harness, track, 512, constant(0.25, -0.5));
    await harness.command(BrowserRealtimeOpcode.SET_STOP_MODE, track, 1);
    await harness.command(BrowserRealtimeOpcode.SET_FADE, track, 0, 96);
    await harness.command(BrowserRealtimeOpcode.PLAY, track, 1);

    const fadeStopPromise = harness.runtime.enqueue(BrowserRealtimeOpcode.STOP, track);
    const fadeOutput = harness.processQuantum();
    const fadeAck = await fadeStopPromise;
    expect(fadeAck.status).toBe(BrowserRealtimeStatus.OK);
    expect(fadeOutput[track]![0]![0]).toBeGreaterThan(0.2);
    expect(Math.max(...fadeOutput[track]![0]!.subarray(96))).toBe(0);
    expect(meta(harness, track, TrackMetaWord.STATE)).toBe(6);
    expect((await harness.command(BrowserRealtimeOpcode.STOP, track)).status).toBe(BrowserRealtimeStatus.OK);

    await harness.command(BrowserRealtimeOpcode.SET_STOP_MODE, track, 2);
    await harness.command(BrowserRealtimeOpcode.PLAY, track, 1);
    await harness.processFrames(BROWSER_REALTIME_QUANTUM_FRAMES);
    const stopAtLoopEnd = harness.runtime.enqueue(BrowserRealtimeOpcode.STOP, track);
    await harness.run(stopAtLoopEnd);
    expect(meta(harness, track, TrackMetaWord.PENDING_STOP_MODE)).toBe(2);
    const position = meta(harness, track, TrackMetaWord.PLAY_POSITION);
    const remaining = loopFrames - position;
    await harness.processFrames(remaining);
    expect(meta(harness, track, TrackMetaWord.STATE)).toBe(6);
    expect((await harness.command(BrowserRealtimeOpcode.STOP, track)).status).toBe(BrowserRealtimeStatus.OK);
  }, 30_000);

  it('preserves untouched PCM around REPLACE1/REPLACE2 takes and interpolates replace masks at 0.5x', async () => {
    const harness = makeHarness();
    const track = 0;
    const baseLeft = Float32Array.from({ length: 2_048 }, (_, index) => 0.1 + index / 20_000);
    const baseRight = Float32Array.from({ length: 2_048 }, (_, index) => -0.2 - index / 20_000);
    await harness.run(harness.runtime.loadTrack(track, harness.createAudioBuffer(baseLeft, baseRight)));

    await harness.command(BrowserRealtimeOpcode.PLAY, track, 1, 128, 1);
    await harness.run(harness.runtime.beginTake(track, 'REPLACE1'));
    await harness.command(BrowserRealtimeOpcode.START_OVERDUB, track, 0, 0, 0, constant(0.75, -0.75));
    await harness.command(BrowserRealtimeOpcode.STOP_OVERDUB, track);

    await harness.command(BrowserRealtimeOpcode.PLAY, track, 1, 472, 1);
    await harness.run(harness.runtime.beginTake(track, 'REPLACE2'));
    await harness.command(BrowserRealtimeOpcode.START_OVERDUB, track, 0, 0, 0, constant(-0.5, 0.5));
    await harness.command(BrowserRealtimeOpcode.STOP_OVERDUB, track);

    const afterReplace = await exportTrack(harness, track);
    const actualLeft = afterReplace.getChannelData(0);
    const actualRight = afterReplace.getChannelData(1);
    for (let index = 0; index < baseLeft.length; index += 1) {
      if (index >= 256 && index < 384) {
        expect(actualLeft[index]).toBeCloseTo(0.75, 6);
        expect(actualRight[index]).toBeCloseTo(-0.75, 6);
      } else if (index >= 600 && index < 728) {
        expect(actualLeft[index]).toBeCloseTo(-0.5, 6);
        expect(actualRight[index]).toBeCloseTo(0.5, 6);
      } else {
        expect(actualLeft[index]).toBeCloseTo(baseLeft[index]!, 6);
        expect(actualRight[index]).toBeCloseTo(baseRight[index]!, 6);
      }
    }

    await harness.command(BrowserRealtimeOpcode.SET_SPEED, track, Math.round(0.5 * 65_536));
    const baseFrames = meta(harness, track, TrackMetaWord.LOOP_FRAMES);
    await harness.command(BrowserRealtimeOpcode.PLAY, track, 1, baseFrames - 64, 1);
    await harness.run(harness.runtime.beginTake(track, 'REPLACE1'));
    await harness.command(BrowserRealtimeOpcode.START_OVERDUB, track, 0, 0, 0, constant(0.9, -0.9));
    await harness.command(BrowserRealtimeOpcode.STOP_OVERDUB, track);
    const afterHalfSpeed = await exportTrack(harness, track);
    expect(afterHalfSpeed.getChannelData(0).subarray(0, 65)).toEqual(new Float32Array(65).fill(0.9));
    expect(afterHalfSpeed.getChannelData(1).subarray(0, 65)).toEqual(new Float32Array(65).fill(-0.9));
    expect(afterHalfSpeed.getChannelData(0)[65]).toBeCloseTo(baseLeft[65]!, 6);
  }, 30_000);

  it('uses variable speed, tempo factors with effective clamp, and executes scheduled commands on their sample frame', async () => {
    const harness = makeHarness();
    const track = 0;
    await recordBaseTrack(harness, track, 4_096, constant(0.1, -0.1));

    for (const speed of [0.5, 1.375, 2]) {
      await harness.command(BrowserRealtimeOpcode.SET_SPEED, track, Math.round(speed * 65_536));
      const startPosition = meta(harness, track, TrackMetaWord.PLAY_POSITION);
      await harness.command(BrowserRealtimeOpcode.PLAY, track, 1, startPosition, 1);
      expect(meta(harness, track, TrackMetaWord.PLAY_POSITION)).toBe(Math.floor(startPosition + speed * BROWSER_REALTIME_QUANTUM_FRAMES));
      await harness.command(BrowserRealtimeOpcode.STOP, track);
    }

    await harness.command(BrowserRealtimeOpcode.SET_RECORD_BPM, track, 40_000);
    await harness.run(harness.runtime.setBpm(300));
    await harness.command(BrowserRealtimeOpcode.SET_SPEED, track, 4 * 65_536);
    await harness.command(BrowserRealtimeOpcode.SET_TEMPO_SYNC, track, 1, 131_072);
    const seekFrame = meta(harness, track, TrackMetaWord.PLAY_POSITION);
    await harness.command(BrowserRealtimeOpcode.PLAY, track, 1, seekFrame, 1);
    expect(meta(harness, track, TrackMetaWord.PLAY_POSITION)).toBe(seekFrame + 4 * BROWSER_REALTIME_QUANTUM_FRAMES);
    await harness.command(BrowserRealtimeOpcode.STOP, track);

    const scheduledFrame = harness.currentFrame() + 257;
    const ack = await harness.command(BrowserRealtimeOpcode.PLAY, track, 1, 0, 1, undefined, scheduledFrame);
    expect(ack.executedFrame).toBe(scheduledFrame);
  }, 30_000);

  it('keeps fractional-BPM external-clock phase continuous across multiple measures', async () => {
    const harness = makeHarness();
    const bpm = 123.45;
    const beatFrames = SAMPLE_RATE * 60 / bpm;
    const startFrame = harness.currentFrame();
    const firstAck = await harness.run(harness.runtime.syncExternalClock(bpm, 4, startFrame));
    expect(firstAck.status).toBe(BrowserRealtimeStatus.OK);
    const targetFrame = startFrame + Math.round(beatFrames * 20);
    const consumed = harness.currentFrame() - startFrame;
    await harness.processFrames(Math.max(0, targetFrame - harness.currentFrame()));
    const resyncAck = await harness.run(harness.runtime.syncExternalClock(bpm, 24, targetFrame));
    expect(resyncAck.status).toBe(BrowserRealtimeStatus.OK);
    await harness.processFrames(Math.ceil(beatFrames * 12));

    const ticks = harness.processor.port.messages.filter((message) => message.type === 'CLOCK_TICK')
      .map((message) => ({ beatOrdinal: Number(message.beatOrdinal), frame: Number(message.frame) }))
      .filter((tick) => tick.beatOrdinal >= 24);
    expect(ticks.length).toBeGreaterThanOrEqual(11);
    for (const tick of ticks) {
      const expected = targetFrame + Math.round((tick.beatOrdinal - 24) * beatFrames);
      expect(Math.abs(tick.frame - expected)).toBeLessThanOrEqual(1);
    }
    expect(consumed).toBeGreaterThan(0);
    expect(Atomics.load(new Int32Array(harness.controlBuffer), ControlWord.BPM)).toBe(123);
  }, 30_000);

  it('starts global clock ticks on the configured master sample epoch', async () => {
    const harness = makeHarness();
    const bpm = 137.5;
    const originFrame = BROWSER_REALTIME_QUANTUM_FRAMES * 32;
    const epochAck = await harness.run(harness.runtime.setMasterClockEpoch(originFrame, bpm, undefined, true));
    expect(epochAck.status).toBe(BrowserRealtimeStatus.OK);
    const beatFrames = SAMPLE_RATE * 60 / bpm;
    await harness.processFrames(originFrame + Math.ceil(beatFrames * 8));
    const ticks = harness.processor.port.messages.filter((message) => message.type === 'CLOCK_TICK')
      .map((message) => ({ beatOrdinal: Number(message.beatOrdinal), frame: Number(message.frame) }));
    expect(ticks.length).toBeGreaterThanOrEqual(8);
    for (const tick of ticks) {
      expect(tick.frame).toBe(originFrame + Math.round(tick.beatOrdinal * beatFrames));
    }
  }, 30_000);

  it('keeps master PCM and the phase-aligned slave in sync across a quarter-phase 1x→2x speed change', async () => {
    const harness = makeHarness();
    const transport = resetTransportForAudioTest();
    const frames = 512;
    const masterLeft = Float32Array.from({ length: frames }, (_, index) => index / 1_024);
    const masterRight = Float32Array.from({ length: frames }, (_, index) => -index / 2_048);
    const slaveLeft = Float32Array.from({ length: frames }, (_, index) => 0.2 + index / 4_096);
    const slaveRight = Float32Array.from({ length: frames }, (_, index) => -0.1 - index / 8_192);
    await harness.run(harness.runtime.loadTrack(0, harness.createAudioBuffer(masterLeft, masterRight)));
    await harness.run(harness.runtime.loadTrack(1, harness.createAudioBuffer(slaveLeft, slaveRight)));

    const originFrame = harness.currentFrame();
    transport.setMasterTrack(1, frames / SAMPLE_RATE, SAMPLE_RATE, frames, originFrame);
    transport.setMasterPlaybackSpeed(1, originFrame, 0, 1);
    await harness.command(BrowserRealtimeOpcode.PLAY, 0, 1, 0, 1, undefined, originFrame);
    expect(meta(harness, 0, TrackMetaWord.PLAY_POSITION)).toBe(frames / 4);
    expect(transport.getMasterLoopPosition(harness.currentFrame(), SAMPLE_RATE)).toBeCloseTo(0.25, 6);

    const quarterFrame = harness.currentFrame();
    const quarterPosition = meta(harness, 0, TrackMetaWord.PLAY_POSITION);
    transport.setMasterPlaybackSpeed(2, quarterFrame, quarterPosition, 1);
    await harness.command(BrowserRealtimeOpcode.SET_SPEED, 0, 2 * 65_536);
    expect(meta(harness, 0, TrackMetaWord.PLAY_POSITION)).toBe((frames * 3) / 4);
    const boundaryFrame = transport.getNextLoopBoundaryFrame(harness.currentFrame());
    expect(boundaryFrame).toBe(originFrame + 320);
    expect(transport.getTrackFrameAtMasterPhase(boundaryFrame, frames)).toBe(0);

    const sourceStart = harness.currentFrame();
    await harness.command(
      BrowserRealtimeOpcode.PLAY,
      1,
      1,
      transport.getTrackFrameAtMasterPhase(boundaryFrame, frames),
      1,
      undefined,
      boundaryFrame,
    );
    const frameOffset = boundaryFrame - sourceStart;
    const output = harness.lastQuantumOutput();
    const masterOutput = output[0]![0]!;
    const slaveOutput = output[1]![0]!;
    expect(masterOutput[frameOffset - 1]).toBeCloseTo(masterLeft[510]!, 6);
    expect(masterOutput[frameOffset]).toBeCloseTo(masterLeft[0]!, 6);
    expect(masterOutput[frameOffset + 1]).toBeCloseTo(masterLeft[2]!, 6);
    expect(slaveOutput[frameOffset - 1]).toBe(0);
    expect(slaveOutput[frameOffset]).toBeCloseTo(slaveLeft[0]!, 6);
    expect(slaveOutput[frameOffset + 1]).toBeCloseTo(slaveLeft[1]!, 6);
    expect(transport.getMasterLoopPosition(harness.currentFrame(), SAMPLE_RATE)).toBeCloseTo(0.25, 6);
  }, 30_000);

  it('uses the reverse 1.3x master anchor for real PCM wrap and slave phase targeting', async () => {
    const harness = makeHarness();
    const transport = resetTransportForAudioTest();
    const frames = 512;
    const speed = Math.round(1.3 * 65_536) / 65_536;
    const masterLeft = Float32Array.from({ length: frames }, (_, index) => index / frames);
    const masterRight = Float32Array.from({ length: frames }, (_, index) => -index / frames);
    const slaveLeft = Float32Array.from({ length: frames }, (_, index) => 0.2 + index / 2_048);
    const slaveRight = Float32Array.from({ length: frames }, (_, index) => -0.1 - index / 4_096);
    await harness.run(harness.runtime.loadTrack(0, harness.createAudioBuffer(masterLeft, masterRight)));
    await harness.run(harness.runtime.loadTrack(1, harness.createAudioBuffer(slaveLeft, slaveRight)));
    await harness.command(BrowserRealtimeOpcode.SET_REVERSE, 0, 1);
    await harness.command(BrowserRealtimeOpcode.SET_SPEED, 0, Math.round(speed * 65_536));

    const originFrame = harness.currentFrame();
    transport.setMasterTrack(1, frames / SAMPLE_RATE, SAMPLE_RATE, frames, originFrame);
    transport.setMasterPlaybackSpeed(speed, originFrame, frames - 1, -1);
    await harness.command(BrowserRealtimeOpcode.PLAY, 0, 1, frames - 1, 1, undefined, originFrame);
    const currentFrame = harness.currentFrame();
    const masterPosition = meta(harness, 0, TrackMetaWord.PLAY_POSITION);
    expect(masterPosition).toBe(344);
    expect(transport.getMasterLoopPosition(currentFrame, SAMPLE_RATE)).toBeCloseTo((frames - 1 - 128 * speed) / frames, 5);

    const boundaryFrame = transport.getNextLoopBoundaryFrame(currentFrame);
    expect(boundaryFrame).toBe(originFrame + 394);
    const slavePosition = transport.getTrackFrameAtMasterPhase(boundaryFrame, frames);
    expect(slavePosition).toBe(510);
    const sourceStart = harness.currentFrame();
    await harness.command(BrowserRealtimeOpcode.PLAY, 1, 1, slavePosition, 1, undefined, boundaryFrame);
    const frameOffset = boundaryFrame - (sourceStart + BROWSER_REALTIME_QUANTUM_FRAMES * 2);
    const output = harness.lastQuantumOutput();
    const masterOutput = output[0]![0]!;
    const slaveOutput = output[1]![0]!;
    expect(frameOffset).toBe(10);
    expect(masterOutput[frameOffset - 1]).toBeLessThan(0.001);
    expect(masterOutput[frameOffset]).toBeGreaterThan(0.99);
    expect(slaveOutput[frameOffset - 1]).toBe(0);
    expect(slaveOutput[frameOffset]).toBeCloseTo(slaveLeft[slavePosition]!, 6);
    expect(slaveOutput[frameOffset + 1]).toBeCloseTo(slaveLeft[slavePosition + 1]!, 6);
  }, 30_000);

  it('renders custom rhythm PCM and swaps patterns on the next step boundary', async () => {
    const harness = makeHarness();
    const kickOnlyKit: RhythmKitDocument = {
      version: 1,
      id: 'kick-only-test',
      name: 'Kick only test',
      voices: {
        kick: { pitchHz: 150, decayMs: 1, noiseAmount: 0, toneGain: 1 },
        snare: { pitchHz: 180, decayMs: 1, noiseAmount: 0, toneGain: 0 },
        hat: { pitchHz: 7_000, decayMs: 1, noiseAmount: 0, toneGain: 0 },
      },
    };
    const kickPattern: RhythmPatternDocument = {
      version: 1,
      id: 'kick-silent-test',
      name: 'Kick / silent alternating',
      steps: 4,
      stepsPerBeat: 4,
      lanes: [{ voice: 'kick', velocities: [1, 0, 1, 0] }],
    };
    const silentPattern: RhythmPatternDocument = {
      ...kickPattern,
      id: 'silent-test',
      name: 'Silent',
      lanes: [{ voice: 'kick', velocities: [0, 0, 0, 0] }],
    };

    await harness.run(harness.runtime.setBpm(300));
    await harness.run(harness.runtime.loadRhythmKit(kickOnlyKit));
    await harness.run(harness.runtime.loadRhythmPattern(kickPattern));
    const initialPatternAck = [...harness.processor.port.messages].reverse().find((message) => message.type === 'RHYTHM_UPDATE_ACK');
    expect(initialPatternAck).toMatchObject({
      ok: true,
      appliedFrame: harness.currentFrame() - BROWSER_REALTIME_QUANTUM_FRAMES,
    });

    const startAck = await harness.run(harness.runtime.setRhythm(true, 0, undefined, true));
    expect(startAck.status).toBe(BrowserRealtimeStatus.OK);
    const kickOnset = harness.lastQuantumOutput()[6]![0]!;
    expect(Math.max(...kickOnset.map(Math.abs))).toBeGreaterThan(0.25);

    // At 300 BPM with four steps per beat, each sample-clock step is exactly
    // 2,400 frames. The first kick decays fully before the silent second step.
    await harness.processFrames(2_400 - 128, () => 0);
    const silentStep = harness.processQuantum()[6]![0]!;
    expect(Math.max(...silentStep.map(Math.abs))).toBeLessThan(1e-6);
    expect(harness.processor.rhythmStep).toBe(2);

    await harness.processFrames(2_400 - 128, () => 0);
    const secondKick = harness.processQuantum()[6]![0]!;
    expect(Math.max(...secondKick.map(Math.abs))).toBeGreaterThan(0.25);
    const expectedBoundary = harness.processor.rhythmNextStepFrame;
    await harness.run(harness.runtime.loadRhythmPattern(silentPattern), () => 0, expectedBoundary);
    const updateAck = [...harness.processor.port.messages].reverse().find((message) => message.type === 'RHYTHM_UPDATE_ACK');
    expect(updateAck).toMatchObject({ ok: true, appliedFrame: expectedBoundary });
    const afterSwap = harness.lastQuantumOutput()[6]![0]!;
    expect(Math.max(...afterSwap.map(Math.abs))).toBeLessThan(1e-6);
    expect(harness.runtime.getRhythmSnapshot().pattern.id).toBe('silent-test');
  }, 30_000);

  it('records 185 accelerated seconds through real chunk growth and exports the final stereo PCM without overruns', async () => {
    // This low-rate case makes the true 185-second duration/capacity check
    // quick. The separate 48 kHz test below verifies the production sample rate.
    await verifyLongRecordingRoundTrip(16_000);
  }, 30_000);

  it('records 185 accelerated seconds at 48 kHz through real chunk growth and exports the final stereo PCM', async () => {
    await verifyLongRecordingRoundTrip(48_000);
  }, 120_000);
});

async function verifyLongRecordingRoundTrip(durationSampleRate: number) {
  const harness = createCoreAudioHarness(durationSampleRate);
  harnesses.push(harness);
  const track = 0;
  const input = constant(0.3125, -0.4375);
  await harness.run(harness.runtime.prepareTrack(track));
  await harness.run(harness.runtime.beginTake(track, 'BASE'));
  await harness.command(BrowserRealtimeOpcode.START_RECORD, track, 0, 0, 0, input);
  const targetFrames = durationSampleRate * 185;
  await harness.processFrames(targetFrames, input, 16_384);
  const stopped = await harness.command(BrowserRealtimeOpcode.STOP_RECORD, track);
  expect(stopped.status).toBe(BrowserRealtimeStatus.OK);
  expect(stopped.loopFrames).toBeGreaterThan(durationSampleRate * 180);
  const metrics = harness.runtime.getMetrics();
  expect(metrics.storageGrowthRequests).toBeGreaterThan(0);
  expect(metrics.storageGrowthFailures).toBe(0);
  expect(metrics.trackCapacityOverruns).toBe(0);
  expect(metrics.underruns).toBe(0);
  expect(Atomics.load(new Int32Array(harness.controlBuffer), ControlWord.INPUT_DROPOUT_FRAMES)).toBe(0);

  const exported = await exportTrack(harness, track, durationSampleRate);
  expect(exported.length).toBe(stopped.loopFrames);
  expect(exported.duration).toBeGreaterThan(180);
  const left = exported.getChannelData(0);
  const right = exported.getChannelData(1);
  for (const index of [0, 1, 47, left.length - 128, left.length - 2, left.length - 1]) {
    expect(left[index]).toBeCloseTo(0.3125, 7);
    expect(right[index]).toBeCloseTo(-0.4375, 7);
  }
}

function resetTransportForAudioTest(): Transport {
  const transport = Transport.getInstance();
  transport.stop();
  transport.resetMasterTrack();
  transport.clearClockEpoch();
  transport.setBpm(120);
  return transport;
}

async function exportTrack(
  harness: ReturnType<typeof createCoreAudioHarness>,
  track: number,
  sampleRate = SAMPLE_RATE,
) {
  return await harness.run(harness.runtime.exportTrack(track, {
    sampleRate,
    createBuffer: (channels: number, length: number, outputSampleRate: number) => makeAudioBuffer(channels, length, outputSampleRate),
  } as unknown as AudioContext));
}

function makeAudioBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
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
}

function countZeroCrossings(samples: Float32Array) {
  let count = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if ((samples[index - 1]! < 0) !== (samples[index]! < 0)) count += 1;
  }
  return count;
}
