import { afterEach, describe, expect, it } from 'vitest';
import { createCoreAudioHarness } from '../helpers/coreAudioHarness';

interface WorkletClockState {
  bpm: number;
  clockOriginFrame: number;
  clockRunning: boolean;
}

describe('atomic master-clock epoch start', () => {
  const harnesses: Array<ReturnType<typeof createCoreAudioHarness>> = [];

  afterEach(() => {
    harnesses.splice(0).forEach((harness) => harness.dispose());
  });

  it('starts a stopped Worklet clock at an exact negative fractional epoch in one command', async () => {
    const harness = createCoreAudioHarness(48_000);
    harnesses.push(harness);
    const clock = harness.processor as typeof harness.processor & WorkletClockState;

    const rephase = await harness.run(harness.runtime.setMasterClockEpoch(-1_234.375, 93.457));
    expect(rephase.status).toBe(0);
    expect(clock.clockRunning).toBe(false);

    const start = await harness.run(harness.runtime.setMasterClockEpoch(-1_234.375, 93.457, undefined, true));
    expect(start.status).toBe(0);
    expect(start.targetFrame).toBeGreaterThanOrEqual(0);
    expect(clock.clockRunning).toBe(true);
    expect(clock.clockOriginFrame).toBe(-1_234.375);
    expect(clock.bpm).toBeCloseTo(93.457, 3);
  });
});
