import { describe, expect, it, vi } from 'vitest';
import { TrackState } from '../../src/core/types';
import { NativeBridgeClient } from '../../src/audio/NativeBridgeClient';
import { NativeTrackProxy } from '../../src/audio/NativeTrackProxy';
import type { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';

function createProxy(appliedOneShot: boolean | null, playTrack: (trackId: number) => Promise<unknown>, toggleOverdub: (trackId: number) => Promise<unknown>, appliedReverse = false) {
  const engine = {
    isNativeTrackAvailable: () => true,
    isNativeReady: () => true,
    getOneShot: () => appliedOneShot,
    getReverse: () => appliedReverse,
    playTrack,
    toggleOverdub,
  } as unknown as NativeAudioEngine;
  const proxy = new NativeTrackProxy(engine, 3);
  proxy.state = TrackState.PLAYING;
  return proxy;
}

describe('Native 1SHOT panel retrigger', () => {
  it('sends the PLAY endpoint for a playing loop only after 1SHOT is applied', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const bridge = new NativeBridgeClient();
    const playTrack = vi.fn((trackId: number) => bridge.playTrack(trackId));
    const toggleOverdub = vi.fn(async () => ({ ok: true }));
    const proxy = createProxy(true, playTrack, toggleOverdub);

    await proxy.triggerRecord();

    expect(playTrack).toHaveBeenCalledWith(3);
    expect(toggleOverdub).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17755/v1/transport/play?trackId=3',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it.each([false, null])('preserves the normal overdub action when applied 1SHOT is %s', async (appliedOneShot) => {
    const playTrack = vi.fn(async () => ({ ok: true }));
    const toggleOverdub = vi.fn(async () => ({ ok: true }));
    const proxy = createProxy(appliedOneShot, playTrack, toggleOverdub);

    await proxy.triggerRecord();

    expect(toggleOverdub).toHaveBeenCalledWith(3);
    expect(playTrack).not.toHaveBeenCalled();
  });

  it('makes a reverse-only REC/PLAY press a no-op instead of requesting overdub', async () => {
    const playTrack = vi.fn(async () => ({ ok: true }));
    const toggleOverdub = vi.fn(async () => ({ ok: true }));
    const proxy = createProxy(false, playTrack, toggleOverdub, true);

    await proxy.triggerRecord();

    expect(playTrack).not.toHaveBeenCalled();
    expect(toggleOverdub).not.toHaveBeenCalled();
  });

  it('keeps explicit 1SHOT retrigger behavior when REVERSE is also enabled', async () => {
    const playTrack = vi.fn(async () => ({ ok: true }));
    const toggleOverdub = vi.fn(async () => ({ ok: true }));
    const proxy = createProxy(true, playTrack, toggleOverdub, true);

    await proxy.triggerRecord();

    expect(playTrack).toHaveBeenCalledWith(3);
    expect(toggleOverdub).not.toHaveBeenCalled();
  });
});
