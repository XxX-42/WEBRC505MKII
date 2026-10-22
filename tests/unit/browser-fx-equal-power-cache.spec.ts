import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore, type BrowserFxAlgorithm } from '../../src/audio/fx/dsp/BrowserFxDspCore';

type GainCacheAccess = {
  cachedWetPosition: number;
  cachedBypassPosition: number;
};

const algorithms: readonly BrowserFxAlgorithm[] = [
  'lpf', 'ring-mod', 'chorus', 'phaser', 'delay', 'reverb', 'gate-reverb', 'distortion', 'auto-pan',
];

describe('Browser FX equal-power gain cache', () => {
  it('is bit-identical to forcing a cache miss at every sample through automation and resets', () => {
    const frameCount = 2_048;
    const inputLeft = new Float32Array(frameCount);
    const inputRight = new Float32Array(frameCount);
    const optimizedLeft = new Float32Array(frameCount);
    const optimizedRight = new Float32Array(frameCount);
    const referenceLeft = new Float32Array(frameCount);
    const referenceRight = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame += 1) {
      inputLeft[frame] = 0.31 * Math.sin(2 * Math.PI * 431 * frame / 48_000)
        + 0.07 * Math.sin(2 * Math.PI * 1_777 * frame / 48_000);
      inputRight[frame] = 0.27 * Math.sin(2 * Math.PI * 719 * frame / 48_000 + 0.3)
        - 0.05 * Math.sin(2 * Math.PI * 2_111 * frame / 48_000);
    }

    for (const algorithm of algorithms) {
      const optimized = new BrowserFxDspCore(algorithm, 48_000, { mix: 0.17 });
      const reference = new BrowserFxDspCore(algorithm, 48_000, { mix: 0.17 });
      const controlChanges = new Map<number, () => void>([
        [0, () => { optimized.setParameters({ mix: 0.83 }); reference.setParameters({ mix: 0.83 }); }],
        [257, () => { optimized.setBypass(true, 41); reference.setBypass(true, 41); }],
        [619, () => { optimized.setParameters({ mix: 0.29 }); reference.setParameters({ mix: 0.29 }); }],
        [911, () => { optimized.setBypass(false, 67); reference.setBypass(false, 67); }],
        [1_341, () => { optimized.setBypass(true, 1); reference.setBypass(true, 1); }],
        [1_342, () => { optimized.setBypass(false, 0); reference.setBypass(false, 0); }],
        [1_701, () => { optimized.reset(); reference.reset(); }],
      ]);

      for (let frame = 0; frame < frameCount; frame += 1) {
        controlChanges.get(frame)?.();
        const inputL = inputLeft.subarray(frame, frame + 1);
        const inputR = inputRight.subarray(frame, frame + 1);
        optimized.processBlock(inputL, inputR, optimizedLeft.subarray(frame, frame + 1), optimizedRight.subarray(frame, frame + 1), 1);

        // This reference follows the same DSP and control sequence, but forces
        // both pure gain pairs to be recomputed on each sample. Thus the test
        // isolates caching from changes to the fade equations or mix order.
        const cache = reference as unknown as GainCacheAccess;
        cache.cachedWetPosition = Number.NaN;
        cache.cachedBypassPosition = Number.NaN;
        reference.processBlock(inputL, inputR, referenceLeft.subarray(frame, frame + 1), referenceRight.subarray(frame, frame + 1), 1);
      }

      expect(optimizedLeft, algorithm).toEqual(referenceLeft);
      expect(optimizedRight, algorithm).toEqual(referenceRight);
    }
  });
});
