import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForAudioStartup } from '../../src/audio/browserAudioStartup';

describe('browser audio startup permission waits', () => {
  afterEach(() => vi.useRealTimers());

  it('releases a pending permission wait and disposes a stream granted after timeout', async () => {
    vi.useFakeTimers();
    let grant!: (stream: { stop: () => void }) => void;
    const request = new Promise<{ stop: () => void }>(resolve => { grant = resolve; });
    const stop = vi.fn();
    const pending = waitForAudioStartup(request, 'Allow microphone access', 20_000, stream => stream.stop());
    const rejection = expect(pending).rejects.toThrow('Allow microphone access');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    grant({ stop });
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('preserves a permission rejection so retry can report the actual browser error', async () => {
    const denied = new DOMException('Permission denied', 'NotAllowedError');
    await expect(waitForAudioStartup(Promise.reject(denied), 'timeout')).rejects.toBe(denied);
  });

  it('does not dispose a stream granted within the wait', async () => {
    const discard = vi.fn();
    const stream = {};
    await expect(waitForAudioStartup(Promise.resolve(stream), 'timeout', 20_000, discard)).resolves.toBe(stream);
    expect(discard).not.toHaveBeenCalled();
  });
});
