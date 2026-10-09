import { describe, expect, it } from 'vitest';
import { ControlWord } from '../../src/audio/browserRealtimeProtocol';
import { createCoreAudioHarness } from '../helpers/coreAudioHarness';

interface ClockWorkletState {
  bpm: number;
  clockRunning: boolean;
  clockOriginFrame: number;
  clockNextBeatFrame: number;
}

describe('sample-clock master epoch', () => {
  it('keeps an exact signed fractional origin without starting a stopped clock', async () => {
    const harness = createCoreAudioHarness();
    try {
      const originFrame = -12.375;
      const ack = await harness.run(harness.runtime.setMasterClockEpoch(originFrame, 120.5));
      const worklet = harness.processor as typeof harness.processor & ClockWorkletState;

      expect(ack.status).toBe(0);
      expect(ack.targetFrame).toBe(0);
      expect(worklet.clockOriginFrame).toBe(originFrame);
      expect(worklet.bpm).toBe(120.5);
      expect(worklet.clockRunning).toBe(false);
      expect(Atomics.load(harness.runtime.control, ControlWord.MASTER_ORIGIN_LOW)).toBe(-12);
    } finally {
      harness.dispose();
    }
  });

  it('preserves a running clock and its scheduled fractional grid', async () => {
    const harness = createCoreAudioHarness();
    try {
      await harness.run(harness.runtime.setClock(true));
      const originFrame = -1_234.125;
      const bpm = 120.5;
      const ack = await harness.run(harness.runtime.setMasterClockEpoch(originFrame, bpm));
      const worklet = harness.processor as typeof harness.processor & ClockWorkletState;
      const beatFrames = 48_000 * 60 / bpm;
      const expectedOrdinal = Math.ceil((ack.targetFrame - originFrame) / beatFrames - 1e-9);

      expect(ack.targetFrame).toBe(128);
      expect(worklet.clockRunning).toBe(true);
      expect(worklet.clockOriginFrame).toBe(originFrame);
      expect(worklet.clockNextBeatFrame).toBe(Math.round(originFrame + expectedOrdinal * beatFrames));
    } finally {
      harness.dispose();
    }
  });
});
