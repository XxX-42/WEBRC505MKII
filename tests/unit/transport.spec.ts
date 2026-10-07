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

  it('keeps the master loop epoch and sample length fixed when BPM is rounded', async () => {
    vi.resetModules();
    const { Transport } = await import('../../src/core/Transport');
    const transport = Transport.getInstance();
    const origin = 2 ** 32 + 960;
    const loopFrames = 123_457;

    transport.setMasterTrack(1, loopFrames / 48_000, 48_000, loopFrames, origin);
    const boundary = transport.getNextMeasureStartFrame(origin + loopFrames + 1);
    transport.setBpm(119);

    expect(transport.masterOriginFrame).toBe(origin);
    expect(transport.masterLoopLengthSamples).toBe(loopFrames);
    expect(boundary).toBe(origin + loopFrames * 2);
    expect(transport.getNextMeasureStartFrame(origin + loopFrames + 1)).toBe(boundary);
  });
});
