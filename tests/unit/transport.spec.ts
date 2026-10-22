import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Transport events', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits start, beat, and stop events from the transport clock', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    vi.resetModules();
    const { Transport } = await import('../../src/core/Transport');

    const transport = Transport.getInstance();
    transport.stop();
    transport.setBpm(120);

    const events: string[] = [];
    transport.on('start', () => events.push('start'));
    transport.on('beat', () => events.push('beat'));
    transport.on('stop', () => events.push('stop'));

    transport.start();
    vi.advanceTimersByTime(550);
    transport.stop();

    expect(events[0]).toBe('start');
    expect(events.filter((event) => event === 'beat').length).toBeGreaterThanOrEqual(2);
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

  it('tracks project transport edits, including edit-and-revert ABA changes', async () => {
    vi.resetModules();
    const { Transport } = await import('../../src/core/Transport');

    const transport = Transport.getInstance();
    const initial = transport.projectMutationRevision;
    transport.setBpm(121);
    const afterBpm = transport.projectMutationRevision;
    transport.setBpm(120);
    const afterBpmRevert = transport.projectMutationRevision;
    expect(afterBpm).toBeGreaterThan(initial);
    expect(afterBpmRevert).toBeGreaterThan(afterBpm);

    transport.timeSignature = [5, 8];
    const afterTimeSignature = transport.projectMutationRevision;
    transport.timeSignature = [4, 4];
    expect(transport.projectMutationRevision).toBeGreaterThan(afterTimeSignature);
    expect(Object.isFrozen(transport.timeSignature)).toBe(true);
    expect(() => { (transport.timeSignature as [number, number])[0] = 6; }).toThrow();

    const beforeMasterValues = transport.projectMutationRevision;
    transport.masterTrackId = 2;
    const afterMasterId = transport.projectMutationRevision;
    transport.masterLoopLengthSamples = 48_000;
    const afterLoopLength = transport.projectMutationRevision;
    transport.measureLength = 1;
    expect(afterMasterId).toBeGreaterThan(beforeMasterValues);
    expect(afterLoopLength).toBeGreaterThan(afterMasterId);
    expect(transport.projectMutationRevision).toBeGreaterThan(afterLoopLength);

    const beforeState = transport.projectMutationRevision;
    transport.start();
    const afterStart = transport.projectMutationRevision;
    transport.stop();
    expect(afterStart).toBeGreaterThan(beforeState);
    expect(transport.projectMutationRevision).toBeGreaterThan(afterStart);
  });

  it.each([
    { numerator: 6, denominator: 8, expectedSeconds: 1.5 },
    { numerator: 3, denominator: 4, expectedSeconds: 1.5 },
    { numerator: 5, denominator: 8, expectedSeconds: 1.25 },
  ])('uses quarter-note BPM when deriving $numerator/$denominator measure duration', async ({ numerator, denominator, expectedSeconds }) => {
    vi.resetModules();
    const { Transport } = await import('../../src/core/Transport');
    const transport = Transport.getInstance();
    transport.stop();
    transport.resetMasterTrack();
    transport.timeSignature = [numerator, denominator];
    transport.setBpm(120);

    expect(transport.getMeasureDuration()).toBeCloseTo(expectedSeconds, 12);
    transport.setMasterTrack(1, expectedSeconds, 48_000, expectedSeconds * 48_000);
    expect(transport.bpm).toBe(120);
    expect(transport.measureLength).toBeCloseTo(expectedSeconds, 12);
  });
});
