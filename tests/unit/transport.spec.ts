import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Transport events', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits beat and measure events only when the worklet clock reports samples', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { Transport } = await import('../../src/core/Transport');

    const transport = Transport.getInstance();
    transport.stop();
    transport.setBpm(120);

    const events: string[] = [];
    const measureFrames: number[] = [];
    transport.on('start', () => events.push('start'));
    transport.on('beat', () => events.push('beat'));
    transport.on('measure', (value) => measureFrames.push((value as { frame: number }).frame));
    transport.on('stop', () => events.push('stop'));

    transport.start();
    vi.advanceTimersByTime(10_000);
    expect(events.filter((event) => event === 'beat')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    transport.emitWorkletBeat(0, 128);
    transport.emitWorkletBeat(1, 24_128);
    transport.emitWorkletBeat(4, 96_128);
    transport.stop();

    expect(events[0]).toBe('start');
    expect(events.filter((event) => event === 'beat')).toHaveLength(3);
    expect(measureFrames).toEqual([128, 96_128]);
    expect(events.at(-1)).toBe('stop');
  });

  it('emits bpm-change when bpm updates', async () => {
    vi.resetModules();
    const { Transport } = await import('../../src/core/Transport');

    const transport = Transport.getInstance();
    const events: string[] = [];
    transport.on('bpm-change', () => events.push('bpm-change'));

    transport.setBpm(132);

    expect(transport.bpm).toBe(132);
    expect(events).toEqual(['bpm-change']);
  });

  it('aligns measures to the master epoch and recomputes the measure grid after BPM changes', async () => {
    vi.resetModules();
    const { Transport } = await import('../../src/core/Transport');
    const transport = Transport.getInstance();
    const origin = 2 ** 32 + 960;
    const loopFrames = 123_457;

    transport.setMasterTrack(1, loopFrames / 48_000, 48_000, loopFrames, origin);
    const currentFrame = origin + loopFrames + 1;
    const firstMeasureFrames = 48_000 * 60 * 4 / transport.bpm;
    const firstOrdinal = Math.ceil((currentFrame - origin) / firstMeasureFrames - 1e-9);
    const firstBoundary = Math.round(origin + firstOrdinal * firstMeasureFrames);
    expect(transport.getNextMeasureStartFrame(currentFrame)).toBe(firstBoundary);
    transport.setBpm(119);
    const updatedMeasureFrames = 48_000 * 60 * 4 / 119;
    const updatedOrdinal = Math.ceil((currentFrame - origin) / updatedMeasureFrames - 1e-9);
    const updatedBoundary = Math.round(origin + updatedOrdinal * updatedMeasureFrames);

    expect(transport.masterOriginFrame).toBe(origin);
    expect(transport.masterLoopLengthSamples).toBe(loopFrames);
    expect(transport.getNextMeasureStartFrame(currentFrame)).toBe(updatedBoundary);
    expect(transport.getNextLoopBoundaryFrame(currentFrame)).toBe(origin + loopFrames * 2);
  });

  it('maps immediate play targets to the shared master phase for normal and reverse playback', async () => {
    vi.resetModules();
    const { Transport } = await import('../../src/core/Transport');
    const transport = Transport.getInstance();
    const origin = 2 ** 32 + 8_000;
    transport.setMasterTrack(1, 4, 48_000, 192_000, origin);
    const trackFrames = 96_000;
    const targetFrame = origin + 48_000;

    expect(transport.getTrackFrameAtMasterPhase(targetFrame, trackFrames)).toBe(24_000);
    expect(transport.getTrackFrameAtMasterPhase(targetFrame, trackFrames, true)).toBe(71_999);
  });

  it('uses the live master speed and phase anchor for loop boundaries without a mid-loop jump', async () => {
    vi.resetModules();
    const { Transport } = await import('../../src/core/Transport');
    const transport = Transport.getInstance();
    const origin = 1_000;
    const loopFrames = 192_000;
    transport.setMasterTrack(1, 4, 48_000, loopFrames, origin);
    transport.setMasterPlaybackSpeed(2, origin, 0);

    expect(transport.getNextLoopBoundaryFrame(origin + 48_000)).toBe(origin + 96_000);
    expect(transport.getTrackFrameAtMasterPhase(origin + 24_000, 96_000)).toBe(24_000);

    const speedChangeFrame = origin + 48_000;
    const sourcePositionAtSpeedChange = 96_000;
    transport.setMasterPlaybackSpeed(0.5, speedChangeFrame, sourcePositionAtSpeedChange);
    expect(transport.getMasterPlaybackPeriodFrames()).toBe(384_000);
    expect(transport.getNextLoopBoundaryFrame(speedChangeFrame)).toBe(speedChangeFrame + 192_000);
    expect(transport.getTrackFrameAtMasterPhase(speedChangeFrame + 96_000, 96_000)).toBe(72_000);

    transport.setMasterPlaybackSpeed(2, speedChangeFrame, loopFrames - 1, -1);
    expect(transport.getNextLoopBoundaryFrame(speedChangeFrame)).toBe(speedChangeFrame + 96_000);
    expect(transport.getTrackFrameAtMasterPhase(speedChangeFrame + 1, loopFrames)).toBe(loopFrames - 3);
  });

  it('keeps fractional BPM measure boundaries on the unrounded master epoch grid', async () => {
    vi.resetModules();
    const { Transport } = await import('../../src/core/Transport');
    const transport = Transport.getInstance();
    const origin = 2 ** 33 + 317;
    transport.setMasterTrack(1, 2, 48_000, 96_000, origin);
    transport.setBpm(120.5);
    const measureFrames = 48_000 * 60 * 4 / 120.5;
    const measureOrdinal = 3;
    const target = origin + Math.floor(measureOrdinal * measureFrames) + 1;

    expect(transport.getNextMeasureStartFrame(target)).toBe(
      Math.round(origin + (measureOrdinal + 1) * measureFrames),
    );
  });

  it('keeps external MIDI beat/measure phase without a master and independent of master PCM phase', async () => {
    vi.resetModules();
    const { Transport } = await import('../../src/core/Transport');
    const transport = Transport.getInstance();
    const sampleRate = 48_000;
    const bpm = 120.5;
    const beatOrdinal = 7;
    const ackFrame = 2 ** 33 + 91_337;
    const beatFrames = sampleRate * 60 / bpm;
    const externalOrigin = ackFrame - beatOrdinal * beatFrames;

    transport.setClockEpoch(externalOrigin, bpm, sampleRate);
    const target = ackFrame + Math.floor(beatFrames * 3.2);
    const measureFrames = sampleRate * 60 * 4 / bpm;
    const expectedOrdinal = Math.ceil((target - externalOrigin) / measureFrames - 1e-9);
    expect(transport.hasMasterTrack()).toBe(false);
    expect(transport.getNextMeasureStartFrame(target)).toBe(
      Math.round(externalOrigin + expectedOrdinal * measureFrames),
    );

    transport.setMasterTrack(1, 4, sampleRate, sampleRate * 4, 10_000);
    transport.setMasterPlaybackSpeed(2, 20_000, 15_000);
    const phaseFrame = 25_000;
    const phaseBeforeClockResync = transport.getTrackFrameAtMasterPhase(phaseFrame, sampleRate * 4);
    transport.setClockEpoch(externalOrigin + 1_000, bpm, sampleRate);

    expect(transport.masterOriginFrame).toBe(10_000);
    expect(transport.getTrackFrameAtMasterPhase(phaseFrame, sampleRate * 4)).toBe(phaseBeforeClockResync);
    expect(transport.getNextMeasureStartFrame(target)).toBe(
      Math.round(externalOrigin + 1_000 + expectedOrdinal * measureFrames),
    );

    transport.resetMasterTrack();
    expect(transport.hasClockEpoch).toBe(true);
    expect(transport.getNextMeasureStartFrame(target)).toBe(
      Math.round(externalOrigin + 1_000 + expectedOrdinal * measureFrames),
    );
  });
});
