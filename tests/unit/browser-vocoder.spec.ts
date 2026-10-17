import { describe, expect, it, vi } from 'vitest';
import { BrowserVocoderFX } from '../../src/audio/fx/BrowserVocoderFX';
import { BrowserVocoderCore } from '../../src/audio/fx/vocoder/BrowserVocoderCore';
import { BROWSER_FX_ALGORITHM_INFO, BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

function tone(sampleRate: number, frequency: number, frames: number, amplitude = 0.3, start = 0, end = frames): Float32Array {
  const output = new Float32Array(frames);
  for (let frame = start; frame < end; frame += 1) {
    output[frame] = amplitude * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
  }
  return output;
}

function rms(samples: Float32Array, start: number, end: number): number {
  let energy = 0;
  const count = Math.max(1, Math.min(end, samples.length) - start);
  for (let frame = start; frame < start + count; frame += 1) {
    const value = samples[frame] ?? 0;
    energy += value * value;
  }
  return Math.sqrt(energy / count);
}

/** Independent Goertzel magnitude oracle for a known spectral component. */
function goertzelMagnitude(samples: Float32Array, sampleRate: number, frequencyHz: number, start: number, count: number): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequencyHz) / sampleRate);
  let previous = 0;
  let previous2 = 0;
  for (let frame = start; frame < start + count; frame += 1) {
    const current = (samples[frame] ?? 0) + (coefficient * previous) - previous2;
    previous2 = previous;
    previous = current;
  }
  const power = Math.max(0, (previous * previous) + (previous2 * previous2) - (coefficient * previous * previous2));
  return (2 * Math.sqrt(power)) / Math.max(1, count);
}

function renderProcessor(
  processor: FxProcessor,
  input: Float32Array,
  blockSizes: readonly number[],
): Float32Array {
  const output = new Float32Array(input.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < input.length) {
    const requested = blockSizes[blockIndex % blockSizes.length] ?? input.length;
    const frames = Math.min(Math.max(1, requested), input.length - offset);
    const leftIn = input.subarray(offset, offset + frames);
    const rightIn = input.subarray(offset, offset + frames);
    const leftOut = new Float32Array(frames);
    const rightOut = new Float32Array(frames);
    expect(processor.process([[leftIn, rightIn]], [[leftOut, rightOut]])).toBe(true);
    output.set(leftOut, offset);
    offset += frames;
    blockIndex += 1;
  }
  return output;
}

describe('clean-room Browser VOCODER', () => {
  it('uses modulator envelope followers to gate the known polyBLEP saw carrier', () => {
    const sampleRate = 48_000;
    const frames = sampleRate;
    const modulator = new Float32Array(frames);
    for (let frame = Math.floor(sampleRate * 0.25); frame < Math.floor(sampleRate * 0.65); frame += 1) {
      modulator[frame] = 0.4 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
    }

    const vocoder = new BrowserVocoderCore(sampleRate, { bands: 16, carrier: 1 });
    const output = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      vocoder.processSample(modulator[frame] ?? 0, modulator[frame] ?? 0);
      output[frame] = vocoder.outputLeft;
    }

    const gatedEnergy = rms(output, Math.floor(sampleRate * 0.32), Math.floor(sampleRate * 0.55));
    const silentEnergy = rms(output, Math.floor(sampleRate * 0.85), Math.floor(sampleRate * 0.98));
    const carrier440Magnitude = goertzelMagnitude(output, sampleRate, 440, Math.floor(sampleRate * 0.32), Math.floor(sampleRate * 0.23));

    expect(vocoder.algorithmicLatencySamples).toBe(0);
    expect(gatedEnergy).toBeGreaterThan(0.002);
    expect(gatedEnergy).toBeGreaterThan(silentEnergy * 3);
    expect(carrier440Magnitude).toBeGreaterThan(0.002);
    expect([...output].every(Number.isFinite)).toBe(true);
    let maximum = 0;
    for (const sample of output) maximum = Math.max(maximum, Math.abs(sample));
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it('changes its ERB filterbank response with band count and rejects invalid bands/carriers', () => {
    const sampleRate = 48_000;
    const frames = sampleRate / 2;
    const modulation = new Float32Array(frames);
    const carrier = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      modulation[frame] = (0.3 * Math.sin((2 * Math.PI * 350 * frame) / sampleRate))
        + (0.19 * Math.sin((2 * Math.PI * 1800 * frame) / sampleRate));
      carrier[frame] = 0.4 * Math.sin((2 * Math.PI * 700 * frame) / sampleRate);
    }
    const eightBands = new BrowserVocoderCore(sampleRate, { bands: 8 });
    const twentyFourBands = new BrowserVocoderCore(sampleRate, { bands: 24 });
    const eightOutput = new Float32Array(frames);
    const twentyFourOutput = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      eightOutput[frame] = eightBands.processWithCarrier(modulation[frame] ?? 0, carrier[frame] ?? 0);
      twentyFourOutput[frame] = twentyFourBands.processWithCarrier(modulation[frame] ?? 0, carrier[frame] ?? 0);
    }
    let differenceEnergy = 0;
    for (let frame = 6000; frame < frames; frame += 1) {
      const difference = (eightOutput[frame] ?? 0) - (twentyFourOutput[frame] ?? 0);
      differenceEnergy += difference * difference;
    }

    expect(BROWSER_FX_ALGORITHM_INFO.vocoder.algorithmicLatencySamples).toBe(0);
    expect(eightBands.bands).toBe(8);
    expect(twentyFourBands.bands).toBe(24);
    expect(differenceEnergy).toBeGreaterThan(0.0001);
    expect(() => eightBands.setParameters({ bands: 7 })).toThrow(/integer from 8 to 24/);
    expect(() => eightBands.setParameters({ bands: 8.5 })).toThrow(/integer from 8 to 24/);
    expect(() => eightBands.setParameters({ bands: Number.NaN })).toThrow(/integer from 8 to 24/);
    expect(() => eightBands.setParameters({ carrier: -1 })).toThrow(/carrier must be 0/);
    expect(() => eightBands.setParameters({ carrier: 3 })).toThrow(/carrier must be 0/);
  });

  it('provides distinct voice-input, anti-aliased saw and anti-aliased square carriers', () => {
    const sampleRate = 48_000;
    const frames = sampleRate;
    const modulator = tone(sampleRate, 440, frames, 0.4);
    const modes = [0, 1, 2] as const;
    const outputs = modes.map((carrier) => {
      const vocoder = new BrowserVocoderCore(sampleRate, { bands: 16, carrier });
      const output = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        vocoder.processSample(modulator[frame] ?? 0, modulator[frame] ?? 0);
        output[frame] = vocoder.outputLeft;
      }
      return output;
    });
    const analysisStart = Math.floor(sampleRate * 0.25);
    const analysisCount = Math.floor(sampleRate * 0.5);
    const voice440 = goertzelMagnitude(outputs[0]!, sampleRate, 440, analysisStart, analysisCount);
    const saw330 = goertzelMagnitude(outputs[1]!, sampleRate, 330, analysisStart, analysisCount);
    const square330 = goertzelMagnitude(outputs[2]!, sampleRate, 330, analysisStart, analysisCount);

    expect(voice440).toBeGreaterThan(0.02);
    expect(saw330).toBeGreaterThan(0.002);
    expect(square330).toBeGreaterThan(saw330 * 1.15);
    expect(outputs[0]).not.toEqual(outputs[1]);
    expect(outputs[1]).not.toEqual(outputs[2]);
  });

  it('exports the ERB centers and accepts distinct preallocated per-band carriers', () => {
    const sampleRate = 48_000;
    const bankCore = new BrowserVocoderCore(sampleRate, { bands: 16, carrier: 0 });
    const scalarCore = new BrowserVocoderCore(sampleRate, { bands: 16, carrier: 0 });
    const carriers = new Float32Array(24);
    const frames = 12_000;
    let bankEnergy = 0;
    let scalarEnergy = 0;
    let differenceEnergy = 0;
    let invalidCenter: { frame: number; band: number; centerHz: number } | null = null;
    for (let frame = 0; frame < frames; frame += 1) {
      const modulation = 0.35 * Math.sin((2 * Math.PI * 180 * frame) / sampleRate);
      for (let band = 0; band < bankCore.bands; band += 1) {
        const centerHz = bankCore.getBandCenterFrequencyHz(band);
        // Check every frame/band without constructing 372,000 assertion
        // objects; retain the first failing coordinate for a useful failure.
        if (!(centerHz > 0) || (band > 0 && !(centerHz > bankCore.getBandCenterFrequencyHz(band - 1)))) {
          invalidCenter ??= { frame, band, centerHz };
        }
        carriers[band] = 0.2 * Math.sin((2 * Math.PI * centerHz * frame) / sampleRate);
      }
      const bankOutput = bankCore.processWithCarrierBank(modulation, carriers);
      const scalarOutput = scalarCore.processWithCarrier(modulation, 0.2 * Math.sin((2 * Math.PI * 180 * frame) / sampleRate));
      bankEnergy += bankOutput * bankOutput;
      scalarEnergy += scalarOutput * scalarOutput;
      differenceEnergy += (bankOutput - scalarOutput) ** 2;
    }

    expect(invalidCenter).toBeNull();
    expect(Math.sqrt(bankEnergy / frames)).toBeGreaterThan(0.001);
    expect(Math.sqrt(scalarEnergy / frames)).toBeGreaterThan(0.001);
    expect(differenceEnergy).toBeGreaterThan(0.01);
    expect(() => bankCore.processWithCarrierBank(0.1, new Float32Array(15))).toThrow(/at least 16 samples/);
  });

  it('produces identical worklet output across arbitrary variable block sizes', () => {
    const sampleRate = 48_000;
    const frames = 12_347;
    const input = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const gate = frame % 2400 < 1550 ? 1 : 0;
      input[frame] = gate * (0.27 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate));
    }
    const makeProcessor = (): FxProcessor => {
      const processor = new FxProcessor({
        processorOptions: {
          algorithm: 'vocoder', sampleRate, bypassed: false,
          parameters: { vocoderBands: 16, vocoderCarrier: 1, mix: 1 },
        },
      });
      expect(processor.core.algorithm).toBe('vocoder');
      return processor;
    };

    const whole = renderProcessor(makeProcessor(), input, [frames]);
    const variable = renderProcessor(makeProcessor(), input, [1, 17, 128, 257, 31, 511, 73]);
    expect(variable).toEqual(whole);
    expect([...variable].every(Number.isFinite)).toBe(true);
  });

  it('fails closed on unsupported formant shifting and invalid worklet controls', () => {
    expect(() => new BrowserFxDspCore('vocoder', 48_000, { vocoderBands: 25 })).toThrow(/integer from 8 to 24/);
    expect(() => new BrowserFxDspCore('vocoder', 48_000, { formant: 0 } as never)).toThrow(/formant shifting is unsupported/);
    const core = new BrowserFxDspCore('vocoder', 48_000, { mix: 0.7 });
    expect(() => core.setParameters({ formant: 0 } as never)).toThrow(/formant shifting is unsupported/);
    expect(() => core.setParameters({ vocoderBands: 25 })).toThrow(/integer from 8 to 24/);
    expect(() => core.setParameters({ vocoderCarrier: 1.5 })).toThrow(/carrier must be 0/);
    expect(() => core.setParameters({ mix: 1.1 })).toThrow(/mix must be between 0 and 1/);
    expect(core.algorithmicLatencySamples).toBe(0);
  });

  it('bounds non-finite sample input instead of leaking NaN into the output', () => {
    const vocoder = new BrowserVocoderCore(48_000, { bands: 16, carrier: 2 });
    for (let frame = 0; frame < 4096; frame += 1) {
      vocoder.processSample(frame % 2 === 0 ? Number.NaN : Number.POSITIVE_INFINITY, 0.2);
      expect(Number.isFinite(vocoder.outputLeft)).toBe(true);
      expect(Math.abs(vocoder.outputLeft)).toBeLessThanOrEqual(4);
    }
  });

  it('routes dry and reports an explicit error when the advertised formant control is requested', async () => {
    const gainNodes: Array<{ value: number; connect: () => void; disconnect: () => void }> = [];
    const fakeContext = {
      currentTime: 0,
      sampleRate: 48_000,
      createGain: () => {
        const gainNode = {
          value: 0,
          gain: {
            setTargetAtTime(value: number) { gainNode.value = value; },
          },
          connect() {},
          disconnect() {},
        };
        gainNodes.push(gainNode);
        return gainNode;
      },
    };
    const workletMessages: unknown[] = [];
    class FakeAudioWorkletNode {
      onprocessorerror: (() => void) | null = null;
      port = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: (message: unknown) => workletMessages.push(message),
        close() {},
      };
      constructor(_context: AudioContext, _name: string, _options: AudioWorkletNodeOptions) {}
      connect() {}
      disconnect() {}
    }
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const failures: Error[] = [];
    const vocoder = new BrowserVocoderFX(
      fakeContext as unknown as AudioContext,
      async () => undefined,
      (error) => failures.push(error),
    );
    await vocoder.ready;
    vocoder.setBypass(false);
    expect(gainNodes[2]?.value).toBe(0);
    expect(gainNodes[3]?.value).toBe(1);

    vocoder.setParam('formant', 0);
    expect(vocoder.error).toMatch(/formant shifting is unsupported/);
    expect(failures[0]?.message).toMatch(/formant shifting is unsupported/);
    expect(gainNodes[2]?.value).toBe(1);
    expect(gainNodes[3]?.value).toBe(0);
    expect(workletMessages.some((message) => JSON.stringify(message).includes('vocoderFormant'))).toBe(false);
    vocoder.dispose();
  });
});
