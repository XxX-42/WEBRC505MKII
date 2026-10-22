import { afterEach, describe, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/audio/pitch/vendor/SignalsmithStretch.mjs', () => ({ default: harness.create }));
import { createLiveInputTransposeNode } from '../../src/audio/pitch/signalsmith';
import createWasm from '../../src/audio/pitch/vendor/SignalsmithStretchWasm.mjs';

async function render(semitones: number, sourceHz: number, formant = 0, harmonic = false): Promise<Float32Array> {
  const wasm = await createWasm() as Awaited<ReturnType<typeof createWasm>> & {
    _configure(channels: number, block: number, hop: number, split: boolean): void;
    _setFormantSemitones(value: number, compensate: boolean): void;
    _setFormantBase(frequency: number): void;
  };
  const sr = 48000, quantum = 128;
  wasm._configure(1, 1152, 288, false);
  wasm._setTransposeSemitones(semitones, 8000 / sr);
  wasm._setFormantSemitones(formant, harmonic);
  wasm._setFormantBase(sourceHz / sr);
  const pointer = wasm._setBuffers(1, quantum);
  const output = new Float32Array(sr * 2);
  for (let frame = 0; frame < output.length; frame += quantum) {
    const count = Math.min(quantum, output.length - frame);
    const input = new Float32Array(wasm.HEAP8.buffer, pointer, quantum);
    for (let i = 0; i < count; i += 1) {
      let sample = Math.sin(2 * Math.PI * sourceHz * (frame + i) / sr);
      if (harmonic) {
        sample = 0;
        for (let h = 1; h <= 35; h += 1) {
          const hz = sourceHz * h;
          const amplitude = 0.03 + Math.exp(-(((hz - 900) / 250) ** 2)) + 0.7 * Math.exp(-(((hz - 1700) / 350) ** 2));
          sample += amplitude * Math.sin(2 * Math.PI * hz * (frame + i) / sr) / 10;
        }
      }
      input[i] = sample * 0.2;
    }
    wasm._process(count, count);
    output.set(new Float32Array(wasm.HEAP8.buffer, pointer + quantum * 4, count), frame);
  }
  return output;
}
function tonePower(signal: Float32Array, hz: number): number {
  let re = 0, im = 0;
  for (let i = 48000; i < signal.length; i += 1) {
    const phase = 2 * Math.PI * hz * i / 48000;
    re += signal[i]! * Math.cos(phase); im += signal[i]! * Math.sin(phase);
  }
  return re * re + im * im;
}
function centroid(signal: Float32Array, fundamental: number): number {
  let total = 0, weighted = 0;
  for (let h = 1; h <= 60; h += 1) {
    const hz = h * fundamental; const power = tonePower(signal, hz);
    total += power; weighted += power * hz;
  }
  return weighted / total;
}
describe('official pitch range reaches Signalsmith DSP', () => {
  afterEach(() => harness.create.mockReset());
  it('extends only explicitly opted-in live nodes and forwards exact endpoints to the vendor schedule', async () => {
    const context = { sampleRate: 48000, currentTime: 0, state: 'running', addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as BaseAudioContext;
    const nodes: { schedule: ReturnType<typeof vi.fn> }[] = [];
    harness.create.mockImplementation(async () => {
      const node = { latency: vi.fn(async () => 0.024), schedule: vi.fn(async () => undefined), wasmHeapBytes: vi.fn(async () => 65536), disposeWasmMemory: vi.fn(async () => 65536), disconnect: vi.fn(), addEventListener: vi.fn(), port: { close: vi.fn() } };
      nodes.push(node); return node;
    });
    const legacy = await createLiveInputTransposeNode(context, { mode: 'LIVE_FX', channels: 1 });
    expect(() => legacy.setPitch(48)).toThrow(/-24/);
    const bend = await createLiveInputTransposeNode(context, { mode: 'LIVE_FX', channels: 1, pitchRange: 'official-bend' });
    await bend.setPitch(48); expect(nodes[1]!.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ semitones: 48 }));
    await bend.setPitch(-36); expect(nodes[1]!.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ semitones: -36 }));
    expect(() => bend.setPitch(49)).toThrow(/-36/);
    await legacy.releaseWasmMemory(); await bend.releaseWasmMemory();
  });
  it.each([[-36, 440, 55], [48, 220, 3520]])('renders finite non-silent audio at %s semitones with the real 24ms WASM configuration', async (shift, source, target) => {
    const output = await render(shift!, source!);
    expect(output.every(Number.isFinite)).toBe(true);
    const targetPower = tonePower(output, target!);
    expect(targetPower).toBeGreaterThan(100);
    expect(targetPower).toBeGreaterThan(tonePower(output, source!) * 50);
  });
  it('FORMANT changes the real spectral envelope in the requested direction', async () => {
    const low = await render(0, 110, -6, true); const high = await render(0, 110, 6, true);
    expect(low.every(Number.isFinite) && high.every(Number.isFinite)).toBe(true);
    expect(centroid(high, 110)).toBeGreaterThan(centroid(low, 110) * 1.4);
  });
});
