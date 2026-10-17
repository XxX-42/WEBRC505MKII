import { describe, expect, it } from 'vitest';
import { BrowserDspProcessor } from '../../src/audio/worklet/BrowserDspProcessor';

describe('BrowserDspProcessor skeleton', () => {
  it('uses actual short channel lengths, silences missing input and exposes stress counters', () => {
    const processor = new BrowserDspProcessor();
    const inputLeft = new Float32Array([0.25, -0.5, 1]);
    const inputRight = new Float32Array([0.75]);
    const outputLeft = new Float32Array(5);
    const outputRight = new Float32Array(3);
    const running = processor.process([[inputLeft, inputRight]], [[outputLeft, outputRight]]);

    expect(running).toBe(true);
    expect([...outputLeft]).toEqual([0.25, -0.5, 1, 0, 0]);
    expect([...outputRight]).toEqual([0.75, 0, 0]);
    expect(processor.blocksProcessed).toBe(1);
    expect(processor.framesProcessed).toBe(5);
    expect(processor.samplesProcessed).toBe(8);
    expect(processor.mismatchedBlocks).toBe(1);
    expect(processor.maxBlockLength).toBe(5);
  });

  it('does not assume 128-frame blocks and tracks channel shape changes', () => {
    const processor = new BrowserDspProcessor();
    const out = new Float32Array(257);
    const inBuffer = new Float32Array(257).fill(0.125);
    processor.process([[inBuffer]], [[out]]);
    const monoOut = new Float32Array(7);
    processor.process([[new Float32Array([0.5])]], [[monoOut, new Float32Array(7)]]);

    expect(out[256]).toBe(0.125);
    expect(monoOut[0]).toBe(0.5);
    expect([...monoOut.slice(1)]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(processor.blocksProcessed).toBe(2);
    expect(processor.maxBlockLength).toBe(257);
    expect(processor.channelShapeChanges).toBe(1);
    expect(processor.mismatchedBlocks).toBe(1);
  });

  it('supports a single constructor-allocated smoothed gain state', () => {
    const processor = new BrowserDspProcessor();
    processor.setOutputGainTarget(0, 2);
    const input = new Float32Array([1, 1, 1]);
    const output = new Float32Array(3);
    processor.process([[input]], [[output]]);
    expect([...output]).toEqual([0.5, 0, 0]);
  });
});
