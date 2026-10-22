import { describe, expect, it, vi } from 'vitest';
import { BrowserFxDspCore, type BrowserFxAlgorithm } from '../../src/audio/fx/dsp/BrowserFxDspCore';

function bypass(algorithm: BrowserFxAlgorithm = 'lpf') {
  const core = new BrowserFxDspCore(algorithm, 48_000);
  core.setBypass(true, 0);
  return core;
}

describe('Browser FX settled bypass bulk copy', () => {
  it('copies stereo exactly, including signed zero, and advances counters and clock', () => {
    const core = bypass();
    const left = new Float32Array([0, -0, 0.25, -0.5]);
    const right = new Float32Array([-0.75, 0.5, -0, 0]);
    const outLeft = new Float32Array(4), outRight = new Float32Array(4);
    const copy = vi.spyOn(outLeft, 'set');
    core.synchronizeFrame(384);
    core.processBlock(left, right, outLeft, outRight, 4);
    expect(copy).toHaveBeenCalledOnce();
    expect(outLeft).toEqual(left);
    expect(outRight).toEqual(right);
    expect(Object.is(outLeft[1], -0)).toBe(true);
    expect(core.blocksProcessed).toBe(1);
    expect(core.framesProcessed).toBe(4);
    expect((core as unknown as { currentAudioFrame: number }).currentAudioFrame).toBe(388);
  });

  it('handles mono and intentional mono upmix without losing channel semantics', () => {
    const input = new Float32Array([0.1, -0.3, 0.2]);
    const mono = new Float32Array(3);
    bypass().processBlock(input, null, mono, null, 3, true);
    expect(mono).toEqual(input);
    for (const algorithm of ['auto-pan', 'manual-pan', 'stereo-enhance'] as const) {
      const left = new Float32Array(3), right = new Float32Array(3);
      bypass(algorithm).processBlock(input, null, left, right, 3, true);
      expect(left).toEqual(input);
      expect(right).toEqual(input);
    }
  });

  it('retains short/missing/partial-block bounds and leaves unwritten frames untouched', () => {
    const left = new Float32Array([1, 2]), right = new Float32Array([3]);
    const outLeft = new Float32Array(5).fill(7), outRight = new Float32Array(3).fill(7);
    const copy = vi.spyOn(outLeft, 'set');
    bypass().processBlock(left, right, outLeft, outRight, 4);
    expect(copy).not.toHaveBeenCalled();
    expect([...outLeft]).toEqual([1, 2, 0, 0, 7]);
    expect([...outRight]).toEqual([3, 0, 0]);
    bypass().processBlock(null, null, outLeft, outRight, 2);
    expect([...outLeft]).toEqual([0, 0, 0, 0, 7]);
  });

  it('preserves original frame-wise behavior with cross-channel and overlapping aliases', () => {
    for (const mode of ['cross', 'input-overlap', 'output-overlap']) {
      function fixture() {
        const shared = new Float32Array([1, 2, 3, 4, 5]);
        const right = new Float32Array([6, 7, 8, 9]);
        const left = shared.subarray(0, 4);
        return { left, right, outLeft: mode === 'cross' ? right : mode === 'input-overlap' ? shared.subarray(1, 5) : shared.subarray(0, 4), outRight: mode === 'cross' ? left : mode === 'output-overlap' ? shared.subarray(1, 5) : new Float32Array(4) };
      }
      const expected = fixture(), actual = fixture();
      for (let frame = 0; frame < 4; frame++) {
        expected.outLeft[frame] = expected.left[frame] ?? 0;
        expected.outRight[frame] = expected.right[frame] ?? 0;
      }
      const copy = vi.spyOn(actual.outLeft, 'set');
      bypass().processBlock(actual.left, actual.right, actual.outLeft, actual.outRight, 4);
      expect(copy).not.toHaveBeenCalled();
      expect(actual.outLeft, mode).toEqual(expected.outLeft);
      expect(actual.outRight, mode).toEqual(expected.outRight);
    }
  });

  it('does not bulk copy bypassed effects that must keep their histories warm', () => {
    for (const algorithm of ['beat-shift', 'reverse-delay', 'reverse-reverb', 'vinyl-flick', 'freeze', 'osc-voc', 'hrm-auto'] as const) {
      const core = bypass(algorithm);
      const input = new Float32Array(128).fill(0.1);
      const left = new Float32Array(128), right = new Float32Array(128);
      const copy = vi.spyOn(left, 'set');
      core.processBlock(input, input, left, right, 128);
      expect(copy, algorithm).not.toHaveBeenCalled();
      expect(core.framesProcessed, algorithm).toBe(128);
    }
  });

  it('waits for the bypass ramp and does not bulk copy after reactivation or configuration', () => {
    const core = new BrowserFxDspCore('lpf', 48_000);
    core.setBypass(false, 0);
    const input = new Float32Array(128).fill(0.2), output = new Float32Array(128);
    const copy = vi.spyOn(output, 'set');
    core.setBypass(true, 128);
    core.processBlock(input, null, output, null, 128);
    expect(copy).not.toHaveBeenCalled();
    core.processBlock(input, null, output, null, 128);
    expect(copy).toHaveBeenCalledOnce();
    core.setParameters({ cutoffHz: 300, mix: 0.8 });
    core.setBypass(false, 128);
    core.processBlock(input, null, output, null, 128);
    expect(copy).toHaveBeenCalledOnce();
    expect(core.framesProcessed).toBe(384);
  });
});
