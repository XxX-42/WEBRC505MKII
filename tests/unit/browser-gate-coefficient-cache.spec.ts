import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';

type GateState = {
  gateThresholdKey: number; gateHoldKey: number; gateReleaseKey: number;
  gateDetectorEnvelope: number; gateHoldRemainingSamples: number; gateGain: number;
  updateGateReverbEnvelope(left: number, right: number): void;
};

describe('Gate Reverb exact control coefficient memoization', () => {
  for (const rate of [8000, 44100, 48000, 96000]) {
    it(`preserves all envelope states across gate close, automation and reset at ${rate} Hz`, () => {
      const a = new BrowserFxDspCore('gate-reverb', rate, { gateHoldMs: 5, gateReleaseMs: 10 });
      const b = new BrowserFxDspCore('gate-reverb', rate, { gateHoldMs: 5, gateReleaseMs: 10 });
      const x = a as unknown as GateState, y = b as unknown as GateState;
      let closes = 0;
      let statesIdentical = true;
      for (let frame = 0; frame < rate * 2; frame++) {
        if (frame === Math.floor(rate * .4)) { a.setParameters({gateThresholdDb: -60, gateHoldMs: 7, gateReleaseMs: 30}); b.setParameters({gateThresholdDb: -60, gateHoldMs: 7, gateReleaseMs: 30}); }
        if (frame === rate) { a.setParameters({gateThresholdDb: -0, gateHoldMs: 5, gateReleaseMs: 10}); b.setParameters({gateThresholdDb: -0, gateHoldMs: 5, gateReleaseMs: 10}); }
        if (frame === Math.floor(rate * 1.5)) { a.reset(); b.reset(); }
        y.gateThresholdKey = y.gateHoldKey = y.gateReleaseKey = Number.NaN;
        const input = frame % Math.floor(rate * .2) < 2 ? 1 : 0;
        x.updateGateReverbEnvelope(input, -input * .7);
        y.updateGateReverbEnvelope(input, -input * .7);
        statesIdentical &&= Object.is(x.gateDetectorEnvelope, y.gateDetectorEnvelope)
          && Object.is(x.gateGain, y.gateGain)
          && x.gateHoldRemainingSamples === y.gateHoldRemainingSamples;
        if(x.gateGain === 0) closes++;
      }
      expect(statesIdentical).toBe(true);
      expect(closes).toBeGreaterThan(0);
    });
  }
});
