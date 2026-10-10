import { describe, expect, it } from 'vitest';
import { NativeTrackProxy } from '../../src/audio/NativeTrackProxy';
import type { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';

describe('NativeTrackProxy unsupported controls', () => {
  it('fails visibly when reverse has no Native host route', () => {
    const engine = {
      isTrackAvailable: () => true,
      isNativeReady: () => true,
    } as unknown as NativeAudioEngine;
    const track = new NativeTrackProxy(engine, 1);

    expect(() => track.toggleReverse()).toThrow('Reverse playback is not available from this Native host build.');
    expect(track.isReverse).toBe(false);
  });
});
