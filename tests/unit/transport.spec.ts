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
});
