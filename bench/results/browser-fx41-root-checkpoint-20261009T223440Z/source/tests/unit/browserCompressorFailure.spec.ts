import { describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserRealtimeOpcode, BrowserRealtimeStatus } from '../../src/audio/browserRealtimeProtocol';
import { TrackState } from '../../src/core/types';
import { Transport } from '../../src/core/Transport';
import type { BrowserRealtimeRuntime } from '../../src/audio/BrowserRealtimeRuntime';

describe('browser compressor failure status', () => {
  it('reports degraded FX but keeps track STOP and CLEAR commands available', async () => {
    const engine = new BrowserAudioEngine();
    (engine as unknown as { initialized: boolean }).initialized = true;

    const enqueue = vi.fn(async (
      opcode: number,
      track: number,
      _value: number,
      _value2: number,
      targetFrame: number,
    ) => ({
      sequence: 1,
      opcode,
      track,
      intentFrame: targetFrame,
      targetFrame,
      executedFrame: targetFrame,
      status: BrowserRealtimeStatus.OK,
      loopFrames: 128,
      recordingFrames: 0,
    }));
    const releaseTrackHistory = vi.fn(async () => undefined);
    engine.realtimeRuntime = {
      getImmediateTargetFrame: () => 4_096,
      enqueue,
      releaseTrackHistory,
    } as unknown as BrowserRealtimeRuntime;

    const track = engine.tracks[0]!;
    track.state = TrackState.PLAYING;
    engine.inputFxChain.compressor.onFailure?.(new Error('processorerror test'));

    expect(engine.getUiStatus()).toMatchObject({
      engineRunning: true,
      ready: true,
      message: 'BROWSER AUDIO DEGRADED: COMPRESSOR DISABLED',
      lastError: expect.stringContaining('processorerror test'),
    });
    expect(track.transportEnabled).toBe(true);

    await track.stop();
    await track.clear();

    expect(enqueue).toHaveBeenCalledWith(BrowserRealtimeOpcode.STOP, 0, 0, 0, 4_096);
    expect(enqueue).toHaveBeenCalledWith(BrowserRealtimeOpcode.CANCEL_PENDING, 0, 0, 0, 4_096);
    expect(enqueue).toHaveBeenCalledWith(BrowserRealtimeOpcode.CLEAR, 0, 0, 0, 4_096);
    expect(releaseTrackHistory).toHaveBeenCalledWith(0);
    expect(track.getLastActionError()).toBeNull();
    expect(track.state).toBe(TrackState.EMPTY);
    Transport.getInstance().stop();
    engine.tracks.forEach((item) => item.fxChain.compressor.dispose());
    engine.inputFxChain.compressor.dispose();
    engine.outputFxChain.compressor.dispose();
  });
});
