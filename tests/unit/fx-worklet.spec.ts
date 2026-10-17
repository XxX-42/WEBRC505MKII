import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface TestPort {
  onmessage: ((event: { data: unknown }) => void) | null;
}

interface TestWorkletProcessor {
  readonly port: TestPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  readonly core: {
    readonly algorithm: string;
    readonly fullyBypassed: boolean;
    readonly framesProcessed: number;
    readonly nonFiniteOutputSamples: number;
    readonly beatRepeatDiagnostics: { boundaryCount: number; activeBpm: number; activeDivision: number } | null;
    readonly beatScatterDiagnostics: { boundaryCount: number; activeBpm: number; activeSliceBeats: number; hasCapturedSlice: boolean } | null;
    readonly patternSlicerDiagnostics: { boundaryCount: number; activeBpm: number; activePattern: number; activeStepIndex: number } | null;
    readonly stepSlicerDiagnostics: { boundaryCount: number; activeBpm: number; activeStepCount: number; activeStepIndex: number; activeStepLevelPercent: number } | null;
  };
}

type TestProcessorConstructor = new (options?: unknown) => TestWorkletProcessor;

class MockAudioWorkletProcessor {
  readonly port: TestPort = { onmessage: null };
}

function loadProcessorBundle(): { name: string; Processor: TestProcessorConstructor } {
  const bundle = readFileSync(resolve(process.cwd(), 'public/worklets/fx-processor.js'), 'utf8');
  let registeredName = '';
  let registeredProcessor: TestProcessorConstructor | null = null;
  runInNewContext(bundle, {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    registerProcessor: (name: string, processor: TestProcessorConstructor): void => {
      registeredName = name;
      registeredProcessor = processor;
    },
    sampleRate: 48000,
  });
  if (!registeredProcessor) throw new Error('FX worklet bundle did not register a processor');
  return { name: registeredName, Processor: registeredProcessor };
}

describe('checked-in Browser FX AudioWorklet bundle', () => {
  it('registers the documented name and defaults to true pass-through bypass', () => {
    const { name, Processor } = loadProcessorBundle();
    expect(name).toBe('rc505-fx-processor');

    const processor = new Processor({ processorOptions: { algorithm: 'reverb', sampleRate: 48000 } });
    expect(processor.core.algorithm).toBe('reverb');
    expect(processor.core.fullyBypassed).toBe(true);
    const inputLeft = new Float32Array([0.25, -0.5, 0.75, -1]);
    const inputRight = new Float32Array([-0.125, 0.5, -0.75, 1]);
    const outputLeft = new Float32Array(4);
    const outputRight = new Float32Array(4);
    expect(processor.process([[inputLeft, inputRight]], [[outputLeft, outputRight]])).toBe(true);
    expect(outputLeft).toEqual(inputLeft);
    expect(outputRight).toEqual(inputRight);
    expect(processor.core.framesProcessed).toBe(4);
  });

  it('handles changing actual quantum/channel arrays, message controls, and missing inputs', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({ processorOptions: { algorithm: 'lpf', sampleRate: 48000 } });

    const wide = new Float32Array(257).fill(0.2);
    const wideLeft = new Float32Array(257);
    const wideRight = new Float32Array(257);
    processor.process([[wide]], [[wideLeft, wideRight]]);
    expect(wideLeft).toEqual(wide);
    expect(wideRight).toEqual(wide);

    const tinyMono = new Float32Array([0.1, -0.2, 0.3]);
    const tinyOutput = new Float32Array(3);
    processor.process([[tinyMono]], [[tinyOutput]]);
    expect(tinyOutput).toEqual(tinyMono);

    const disconnected = new Float32Array(19).fill(9);
    processor.process([[]], [[disconnected]]);
    expect(disconnected.every((sample) => sample === 0)).toBe(true);

    processor.port.onmessage?.({ data: { type: 'configure', parameters: { cutoffHz: 320, q: 1.1 } } });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
    expect(processor.core.fullyBypassed).toBe(false);
    const tone = new Float32Array(511);
    for (let frame = 0; frame < tone.length; frame += 1) tone[frame] = Math.sin((2 * Math.PI * 7000 * frame) / 48000);
    const filtered = new Float32Array(tone.length);
    processor.process([[tone]], [[filtered]]);
    expect(filtered).not.toEqual(tone);
    expect(filtered.every(Number.isFinite)).toBe(true);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
    expect(processor.core.framesProcessed).toBe(257 + 3 + 19 + 511);
  });

  it('runs SLOW GEAR onset shaping across variable worklet quanta', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({
      processorOptions: {
        algorithm: 'slow-gear',
        sampleRate: 48000,
        parameters: { slowGearAttackMs: 50, slowGearSensitivityPercent: 100, mix: 1 },
        bypassed: false,
      },
    });
    const totalFrames = 4800;
    const input = new Float32Array(totalFrames).fill(0.25);
    const outputLeft = new Float32Array(totalFrames);
    const outputRight = new Float32Array(totalFrames);
    const quanta = [1, 31, 128, 257];
    let offset = 0;
    let block = 0;
    while (offset < totalFrames) {
      const frames = Math.min(quanta[block % quanta.length]!, totalFrames - offset);
      processor.process(
        [[input.subarray(offset, offset + frames)]],
        [[outputLeft.subarray(offset, offset + frames), outputRight.subarray(offset, offset + frames)]],
      );
      offset += frames;
      block += 1;
    }

    expect(processor.core.algorithm).toBe('slow-gear');
    expect(outputLeft[0]).toBeCloseTo(0, 6);
    expect(outputRight[0]).toBeCloseTo(0, 6);
    expect(outputLeft[2400]).toBeCloseTo(0.25, 3);
    expect(outputLeft.every(Number.isFinite)).toBe(true);
    expect(outputRight.every(Number.isFinite)).toBe(true);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
    expect(processor.core.framesProcessed).toBe(totalFrames);
  });

  it('runs clean-room PREAMP through the checked-in bundle with variable quanta and live controls', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({
      processorOptions: {
        algorithm: 'preamp',
        sampleRate: 48000,
        parameters: { preampModel: 2, preampGainPercent: 76, preampBassDb: 2, preampMiddleDb: -1, preampTrebleDb: 3, preampLevelDb: -2 },
        bypassed: false,
      },
    });
    const input = new Float32Array(2049);
    for (let frame = 0; frame < input.length; frame += 1) input[frame] = 0.5 * Math.sin((2 * Math.PI * 431 * frame) / 48000);
    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);
    const quanta = [1, 31, 127, 257, 3];
    let offset = 0;
    let block = 0;
    while (offset < input.length) {
      const frames = Math.min(quanta[block % quanta.length]!, input.length - offset);
      processor.process(
        [[input.subarray(offset, offset + frames)]],
        [[left.subarray(offset, offset + frames), right.subarray(offset, offset + frames)]],
      );
      offset += frames;
      block += 1;
    }
    expect(processor.core.algorithm).toBe('preamp');
    expect(left).not.toEqual(input);
    expect(right).toEqual(left);
    expect(left.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 4)).toBe(true);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);

    processor.port.onmessage?.({ data: { type: 'configure', parameters: { preampModel: 4, preampGainPercent: 35, preampBassDb: -8, preampLevelDb: 2 } } });
    processor.port.onmessage?.({ data: { type: 'reset' } });
    expect(processor.core.framesProcessed).toBe(input.length);
  });

  it('runs PATTERN SLICER tables at sample-clocked tempo boundaries in the built bundle', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({
      processorOptions: {
        algorithm: 'pattern-slicer',
        sampleRate: 8000,
        parameters: {
          bpm: 120,
          patternSlicerPattern: 3,
          patternSlicerRateBeats: 0.25,
          patternSlicerDepthPercent: 100,
          patternSlicerEdgeMs: 0.5,
        },
        bypassed: false,
      },
    });
    const input = new Float32Array(9000).fill(0.4);
    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);
    const quanta = [1, 31, 128, 257, 3];
    let offset = 0;
    let block = 0;
    while (offset < input.length) {
      const frames = Math.min(quanta[block % quanta.length]!, input.length - offset);
      processor.process(
        [[input.subarray(offset, offset + frames)]],
        [[left.subarray(offset, offset + frames), right.subarray(offset, offset + frames)]],
      );
      offset += frames;
      block += 1;
    }
    expect(left.slice(0, 7900)).toEqual(input.slice(0, 7900));
    expect(left.slice(8004).every((sample) => Math.abs(sample) < 1e-7)).toBe(true);
    expect(right).toEqual(left);
    expect(processor.core.patternSlicerDiagnostics).toMatchObject({ boundaryCount: 9, activeBpm: 120, activePattern: 3, activeStepIndex: 9 });
  });

  it('runs STEP SLICER editable levels in the checked-in worklet across variable quanta and reset messages', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({
      processorOptions: {
        algorithm: 'step-slicer',
        sampleRate: 8000,
        parameters: {
          bpm: 120,
          stepSlicerStepCount: 16,
          stepSlicerRateBeats: 0.25,
          stepSlicerDepthPercent: 100,
          stepSlicerFilterHz: 20000,
          stepSlicerStep01: 0,
          stepSlicerStep02: 80,
        },
        bypassed: false,
      },
    });
    const input = new Float32Array(2400).fill(0.4);
    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);
    const quanta = [1, 31, 128, 257, 3];
    let offset = 0;
    let block = 0;
    while (offset < input.length) {
      const frames = Math.min(quanta[block % quanta.length]!, input.length - offset);
      processor.process(
        [[input.subarray(offset, offset + frames)]],
        [[left.subarray(offset, offset + frames), right.subarray(offset, offset + frames)]],
      );
      offset += frames;
      block += 1;
    }
    expect(left.slice(0, 1000).every((sample) => Math.abs(sample) < 1e-8)).toBe(true);
    expect(left.slice(1015, 1100).some((sample) => sample > 0.2)).toBe(true);
    expect(right).toEqual(left);
    expect(left.every(Number.isFinite)).toBe(true);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
    expect(processor.core.stepSlicerDiagnostics).toMatchObject({
      boundaryCount: 2,
      activeBpm: 120,
      activeStepCount: 16,
      activeStepIndex: 2,
      activeStepLevelPercent: 100,
    });

    processor.port.onmessage?.({ data: { type: 'configure', parameters: { stepSlicerStepCount: 0, stepSlicerRateBeats: 1, stepSlicerStep03: 25 } } });
    processor.port.onmessage?.({ data: { type: 'reset' } });
    expect(processor.core.stepSlicerDiagnostics).toMatchObject({
      boundaryCount: 0,
      activeStepCount: 4,
      activeStepIndex: 0,
      activeStepLevelPercent: 0,
    });
  });

  it('runs configured GATE REVERB through variable worklet quanta with bounded gated tail', () => {
    const { Processor } = loadProcessorBundle();
    const frames = 16000;
    const input = new Float32Array(frames);
    input[0] = 1;
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    const processor = new Processor({ processorOptions: {
      algorithm: 'gate-reverb', sampleRate: 48000, bypassed: false,
      parameters: { mix: 1, decaySeconds: 5, gateThresholdDb: -24, gateHoldMs: 40, gateReleaseMs: 50 },
    } });
    let offset = 0;
    const quanta = [1, 127, 257, 31, 511, 7];
    let block = 0;
    while (offset < frames) {
      const count = Math.min(quanta[block % quanta.length]!, frames - offset);
      processor.process(
        [[input.subarray(offset, offset + count)]],
        [[outputLeft.subarray(offset, offset + count), outputRight.subarray(offset, offset + count)]],
      );
      offset += count;
      block += 1;
    }
    expect(processor.core.algorithm).toBe('gate-reverb');
    expect(processor.core.framesProcessed).toBe(frames);
    expect(outputLeft.every(Number.isFinite) && outputRight.every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from(outputLeft, Math.abs), ...Array.from(outputRight, Math.abs))).toBeLessThan(2);
    const earlyEnergy = outputLeft.slice(0, 2000).reduce((sum, sample) => sum + sample * sample, 0);
    const lateEnergy = outputLeft.slice(9000).reduce((sum, sample) => sum + sample * sample, 0);
    expect(earlyEnergy).toBeGreaterThan(0);
    expect(lateEnergy).toBeLessThan(earlyEnergy);
  });

  it('runs ISOLATOR gating in the checked-in worklet across variable quanta', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({
      processorOptions: {
        algorithm: 'isolator',
        sampleRate: 8000,
        parameters: {
          bpm: 120,
          isolatorGateRateBeats: 0.5,
          isolatorGateDepthPercent: 100,
          mix: 1,
        },
        bypassed: false,
      },
    });
    const totalFrames = 2200;
    const input = new Float32Array(totalFrames).fill(0.25);
    const outputLeft = new Float32Array(totalFrames);
    const outputRight = new Float32Array(totalFrames);
    const quanta = [1, 31, 128, 257];
    let offset = 0;
    let block = 0;
    while (offset < totalFrames) {
      const frames = Math.min(quanta[block % quanta.length]!, totalFrames - offset);
      processor.process(
        [[input.subarray(offset, offset + frames)]],
        [[outputLeft.subarray(offset, offset + frames), outputRight.subarray(offset, offset + frames)]],
      );
      offset += frames;
      block += 1;
    }

    expect(processor.core.algorithm).toBe('isolator');
    expect(outputLeft[20]).toBeCloseTo(0.25, 6);
    expect(outputLeft[1100]).toBeLessThan(0.001);
    expect(outputLeft[2020]).toBeCloseTo(0.25, 6);
    expect(outputLeft.every(Number.isFinite)).toBe(true);
    expect(outputRight.every(Number.isFinite)).toBe(true);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
    expect(processor.core.framesProcessed).toBe(totalFrames);
  });

  it('runs BEAT SCATTER capture and read heads across variable worklet quanta', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({
      processorOptions: {
        algorithm: 'beat-scatter',
        sampleRate: 8000,
        parameters: {
          bpm: 120,
          beatScatterSliceBeats: 0.25,
          beatScatterScatterPercent: 60,
          beatScatterPitchSemitones: 7,
          beatScatterRepeats: 4,
          mix: 1,
        },
        bypassed: false,
      },
    });
    const totalFrames = 3400;
    const inputLeft = new Float32Array(totalFrames);
    const inputRight = new Float32Array(totalFrames);
    for (let frame = 0; frame < totalFrames; frame += 1) {
      inputLeft[frame] = 0.3 * Math.sin((2 * Math.PI * frame) / 127);
      inputRight[frame] = 0.25 * Math.cos((2 * Math.PI * frame) / 131);
    }
    const outputLeft = new Float32Array(totalFrames);
    const outputRight = new Float32Array(totalFrames);
    const quanta = [1, 31, 128, 257, 3, 511];
    let offset = 0;
    let block = 0;
    while (offset < totalFrames) {
      const frames = Math.min(quanta[block % quanta.length]!, totalFrames - offset);
      processor.process(
        [[inputLeft.subarray(offset, offset + frames), inputRight.subarray(offset, offset + frames)]],
        [[outputLeft.subarray(offset, offset + frames), outputRight.subarray(offset, offset + frames)]],
      );
      offset += frames;
      block += 1;
    }

    expect(processor.core.algorithm).toBe('beat-scatter');
    expect(outputLeft.slice(0, 1000)).toEqual(inputLeft.slice(0, 1000));
    expect(outputRight.slice(0, 1000)).toEqual(inputRight.slice(0, 1000));
    expect(outputLeft.slice(1000)).not.toEqual(inputLeft.slice(1000));
    expect(processor.core.beatScatterDiagnostics).toMatchObject({
      boundaryCount: 3,
      activeBpm: 120,
      activeSliceBeats: 0.25,
      hasCapturedSlice: true,
    });
    expect(outputLeft.every(Number.isFinite)).toBe(true);
    expect(outputRight.every(Number.isFinite)).toBe(true);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
    expect(processor.core.framesProcessed).toBe(totalFrames);
  });

  it('crossfades bypass, then skips effect DSP at its steady endpoint', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({ processorOptions: { algorithm: 'reverb', sampleRate: 48000 } });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: true, rampFrames: 32 } });
    const input = new Float32Array(32).fill(0.25);
    const fading = new Float32Array(32);
    processor.process([[input]], [[fading]]);
    expect(fading[31]).toBe(0.25);
    expect(processor.core.fullyBypassed).toBe(true);

    const frameCountBeforeSteadyBypass = processor.core.framesProcessed;
    const steady = new Float32Array(257).fill(-0.375);
    const steadyOutput = new Float32Array(257);
    processor.process([[steady]], [[steadyOutput]]);
    expect(steadyOutput).toEqual(steady);
    expect(processor.core.framesProcessed).toBe(frameCountBeforeSteadyBypass + steady.length);
  });

  it('runs configured oversampled distortion and Lagrange flanger through variable worklet quanta', () => {
    const { Processor } = loadProcessorBundle();
    const frames = 2048;
    const input = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) input[frame] = 0.5 * Math.sin((2 * Math.PI * 1100 * frame) / 48000);

    for (const algorithm of ['distortion', 'flanger', 'dynamics', 'delay', 'chorus', 'phaser', 'tremolo', 'auto-pan']) {
      const processor = new Processor({ processorOptions: { algorithm, sampleRate: 48000 } });
      processor.port.onmessage?.({ data: { type: 'set-bypass', value: false } });
      processor.port.onmessage?.({ data: {
        type: 'configure',
        parameters: algorithm === 'distortion'
          ? { mix: 1, driveDb: 30, outputDb: -3, distortionMode: 'fuzz' }
          : algorithm === 'flanger'
            ? { mix: 1, flangerDelayMs: 4, flangerRateHz: 2, flangerDepth: 0.8, flangerFeedback: 0.7 }
            : algorithm === 'dynamics'
              ? { mix: 1, thresholdDb: -18, ratio: 4, kneeDb: 6, attackMs: 2, releaseMs: 100, dynamicsDetector: 'rms' }
              : algorithm === 'delay'
                ? { mix: 1, delayTimeMs: 12, delayFeedback: 0.4, delayToneHz: 9000 }
                : algorithm === 'chorus'
                  ? { mix: 1, chorusDelayMs: 15, chorusRateHz: 1.2, chorusDepthMs: 5, chorusVoices: 3, chorusFeedback: 0.2, chorusToneHz: 8000 }
                  : algorithm === 'phaser'
                    ? { mix: 1, phaserRateHz: 1.3, phaserDepth: 0.8, phaserFeedback: 0.45, phaserStages: 8 }
                    : algorithm === 'tremolo'
                      ? { mix: 1, tremoloRateHz: 5, tremoloDepth: 0.8, tremoloWaveform: 'square' }
                      : { mix: 1, autoPanRateHz: 1.2, autoPanDepth: 0.9, autoPanWaveform: 'triangle' },
      } });
      const output = new Float32Array(frames);
      let offset = 0;
      for (const block of [1, 127, 257, 64, 511, 7]) {
        if (offset >= frames) break;
        const count = Math.min(block, frames - offset);
        processor.process([[input.subarray(offset, offset + count)]], [[output.subarray(offset, offset + count)]]);
        offset += count;
      }
      if (offset < frames) {
        processor.process([[input.subarray(offset)]], [[output.subarray(offset)]]);
      }
      expect(processor.core.algorithm).toBe(algorithm);
      expect(output.every(Number.isFinite)).toBe(true);
      expect(output).not.toEqual(input);
      expect(processor.core.nonFiniteOutputSamples).toBe(0);
      expect(processor.core.framesProcessed).toBe(frames);
    }
  });

  it('runs stereo-enhance through a stereo worklet stream with variable callback sizes and controls', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({ processorOptions: { algorithm: 'stereo-enhance', sampleRate: 48000 } });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
    processor.port.onmessage?.({ data: { type: 'configure', parameters: {
      mix: 1, stereoWidth: 1.7, stereoLowMonoCutoffHz: 240, stereoDecorrelation: 0.75,
    } } });

    const frames = 2048;
    const inputLeft = new Float32Array(frames);
    const inputRight = new Float32Array(frames);
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const mid = 0.25 * Math.sin((2 * Math.PI * 220 * frame) / 48000);
      const side = 0.2 * Math.sin((2 * Math.PI * 1500 * frame) / 48000);
      inputLeft[frame] = mid + side;
      inputRight[frame] = mid - side;
    }

    let offset = 0;
    for (const requested of [1, 127, 257, 64, 511, 7]) {
      if (offset >= frames) break;
      const count = Math.min(requested, frames - offset);
      processor.process(
        [[inputLeft.subarray(offset, offset + count), inputRight.subarray(offset, offset + count)]],
        [[outputLeft.subarray(offset, offset + count), outputRight.subarray(offset, offset + count)]],
      );
      offset += count;
    }
    if (offset < frames) {
      processor.process(
        [[inputLeft.subarray(offset), inputRight.subarray(offset)]],
        [[outputLeft.subarray(offset), outputRight.subarray(offset)]],
      );
    }

    expect(processor.core.algorithm).toBe('stereo-enhance');
    expect(outputLeft.every(Number.isFinite)).toBe(true);
    expect(outputRight.every(Number.isFinite)).toBe(true);
    expect(outputLeft).not.toEqual(inputLeft);
    expect(outputRight).not.toEqual(inputRight);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
    expect(processor.core.framesProcessed).toBe(frames);
  });

  it('runs BEAT REPEAT in the real worklet bundle with sample-clock slices and variable callback sizes', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({ processorOptions: {
      algorithm: 'beat-repeat',
      sampleRate: 48000,
      parameters: { bpm: 300, division: 0.25, decay: 0, direction: 1, mix: 1 },
    } });
    expect(processor.core.algorithm).toBe('beat-repeat');
    expect(processor.core.fullyBypassed).toBe(true);
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });

    const frames = 7200; // three 2400-frame 1/16-beat slices at 300 BPM
    const input = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) input[frame] = frame / frames;
    const output = new Float32Array(frames);
    let offset = 0;
    for (const requested of [1, 127, 257, 64, 511, 7]) {
      if (offset >= frames) break;
      const count = Math.min(requested, frames - offset);
      processor.process([[input.subarray(offset, offset + count)]], [[output.subarray(offset, offset + count)]]);
      offset += count;
    }
    if (offset < frames) {
      processor.process([[input.subarray(offset)]], [[output.subarray(offset)]]);
    }

    expect(output.every(Number.isFinite)).toBe(true);
    expect(output.slice(2400)).not.toEqual(input.slice(2400));
    expect(processor.core.beatRepeatDiagnostics).toMatchObject({
      boundaryCount: 3,
      activeBpm: 300,
      activeDivision: 0.25,
    });
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
  });

  it('runs LO-FI sample-rate hold and quantization through the shipped variable-quantum worklet', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({ processorOptions: {
      algorithm: 'lo-fi', sampleRate: 48000,
      parameters: { mix: 1, loFiBitDepth: 7, loFiSampleRateHz: 8000, loFiFilterHz: 16000 },
    } });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });

    const frames = 2048;
    const inputLeft = new Float32Array(frames);
    const inputRight = new Float32Array(frames);
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      inputLeft[frame] = 0.6 * Math.sin((2 * Math.PI * 1103 * frame) / 48000);
      inputRight[frame] = 0.4 * Math.sin((2 * Math.PI * 877 * frame) / 48000);
    }

    let offset = 0;
    for (const requested of [1, 127, 257, 64, 511, 7]) {
      if (offset >= frames) break;
      const count = Math.min(requested, frames - offset);
      processor.process(
        [[inputLeft.subarray(offset, offset + count), inputRight.subarray(offset, offset + count)]],
        [[outputLeft.subarray(offset, offset + count), outputRight.subarray(offset, offset + count)]],
      );
      offset += count;
    }
    if (offset < frames) {
      processor.process(
        [[inputLeft.subarray(offset), inputRight.subarray(offset)]],
        [[outputLeft.subarray(offset), outputRight.subarray(offset)]],
      );
    }

    expect(processor.core.algorithm).toBe('lo-fi');
    expect(outputLeft.every(Number.isFinite) && outputRight.every(Number.isFinite)).toBe(true);
    expect(outputLeft).not.toEqual(inputLeft);
    expect(outputRight).not.toEqual(inputRight);
    expect(processor.core.framesProcessed).toBe(frames);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
  });

  it('runs the four-section EQ through the shipped worklet with actual variable block sizes', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({ processorOptions: {
      algorithm: 'eq', sampleRate: 48000,
      parameters: {
        mix: 1, eqLowFrequencyHz: 180, eqLowGainDb: 9,
        eqMid1FrequencyHz: 700, eqMid1Q: 1.2, eqMid1GainDb: 3,
        eqMid2FrequencyHz: 3000, eqMid2Q: 0.9, eqMid2GainDb: -2,
        eqHighFrequencyHz: 6000, eqHighGainDb: -6,
      },
    } });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });

    const frames = 4099;
    const inputLeft = new Float32Array(frames);
    const inputRight = new Float32Array(frames);
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      inputLeft[frame] = 0.3 * Math.sin((2 * Math.PI * 60 * frame) / 48000);
      inputRight[frame] = 0.3 * Math.sin((2 * Math.PI * 10000 * frame) / 48000);
    }

    let offset = 0;
    for (const requested of [1, 7, 64, 127, 257, 3, 511]) {
      if (offset >= frames) break;
      const count = Math.min(requested, frames - offset);
      processor.process(
        [[inputLeft.subarray(offset, offset + count), inputRight.subarray(offset, offset + count)]],
        [[outputLeft.subarray(offset, offset + count), outputRight.subarray(offset, offset + count)]],
      );
      offset += count;
    }
    if (offset < frames) {
      processor.process(
        [[inputLeft.subarray(offset), inputRight.subarray(offset)]],
        [[outputLeft.subarray(offset), outputRight.subarray(offset)]],
      );
    }

    expect(processor.core.algorithm).toBe('eq');
    expect(outputLeft.every(Number.isFinite) && outputRight.every(Number.isFinite)).toBe(true);
    expect(outputLeft).not.toEqual(inputLeft);
    expect(outputRight).not.toEqual(inputRight);
    expect(processor.core.framesProcessed).toBe(frames);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
  });

  it('pans mono worklet input to one channel on the actual callback-sized stream', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({ processorOptions: {
      algorithm: 'manual-pan', sampleRate: 48000, parameters: { mix: 1, manualPanPosition: -1 },
    } });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
    const frames = 1031;
    const input = new Float32Array(frames).fill(0.375);
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);

    let offset = 0;
    for (const requested of [1, 127, 257, 64, 511, 7]) {
      if (offset >= frames) break;
      const count = Math.min(requested, frames - offset);
      processor.process([[input.subarray(offset, offset + count)]], [[outputLeft.subarray(offset, offset + count), outputRight.subarray(offset, offset + count)]]);
      offset += count;
    }
    if (offset < frames) {
      processor.process([[input.subarray(offset)]], [[outputLeft.subarray(offset), outputRight.subarray(offset)]]);
    }

    expect(processor.core.algorithm).toBe('manual-pan');
    expect(outputLeft).toEqual(input);
    expect(outputRight.every((sample) => Math.abs(sample) < 1e-7)).toBe(true);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
  });

  it('preserves mono bypass and renders active equal-power AUTO PAN to a stereo worklet output', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({ processorOptions: { algorithm: 'auto-pan', sampleRate: 48000 } });
    const mono = new Float32Array(511).fill(0.4);
    const bypassLeft = new Float32Array(mono.length);
    const bypassRight = new Float32Array(mono.length);
    processor.process([[mono]], [[bypassLeft, bypassRight]]);
    expect(bypassLeft).toEqual(mono);
    expect(bypassRight).toEqual(mono);

    processor.port.onmessage?.({ data: { type: 'configure', parameters: {
      mix: 1, autoPanRateHz: 2, autoPanDepth: 1, autoPanWaveform: 'square',
    } } });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
    const activeLeft = new Float32Array(mono.length);
    const activeRight = new Float32Array(mono.length);
    processor.process([[mono]], [[activeLeft, activeRight]]);
    expect(activeLeft.every(Number.isFinite) && activeRight.every(Number.isFinite)).toBe(true);
    expect(activeLeft).not.toEqual(activeRight);
    for (let frame = 0; frame < mono.length; frame += 1) {
      const energy = (activeLeft[frame] ?? 0) ** 2 + (activeRight[frame] ?? 0) ** 2;
      expect(Math.abs(energy - 0.16)).toBeLessThan(1e-6);
    }
  });

  it('runs TAPE ECHO in the shipped worklet and delays an impulse through variable callbacks', () => {
    const { Processor } = loadProcessorBundle();
    const makeProcessor = (): TestWorkletProcessor => {
      const processor = new Processor({ processorOptions: {
        algorithm: 'tape-echo', sampleRate: 48000,
        parameters: {
          tapeEchoTimeMs: 20, tapeEchoFeedback: 0, tapeEchoWow: 0,
          tapeEchoSaturation: 0, tapeEchoToneHz: 16000, mix: 1,
        },
      } });
      processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
      return processor;
    };
    const impulseProcessor = makeProcessor();
    const silenceProcessor = makeProcessor();
    const frames = 2400;
    const impulse = new Float32Array(frames);
    impulse[0] = 1;
    const silence = new Float32Array(frames);
    const impulseOutput = new Float32Array(frames);
    const silenceOutput = new Float32Array(frames);

    let offset = 0;
    for (const requested of [1, 127, 257, 64, 511, 7]) {
      if (offset >= frames) break;
      const count = Math.min(requested, frames - offset);
      impulseProcessor.process([[impulse.subarray(offset, offset + count)]], [[impulseOutput.subarray(offset, offset + count)]]);
      silenceProcessor.process([[silence.subarray(offset, offset + count)]], [[silenceOutput.subarray(offset, offset + count)]]);
      offset += count;
    }
    if (offset < frames) {
      impulseProcessor.process([[impulse.subarray(offset)]], [[impulseOutput.subarray(offset)]]);
      silenceProcessor.process([[silence.subarray(offset)]], [[silenceOutput.subarray(offset)]]);
    }

    expect(impulseProcessor.core.algorithm).toBe('tape-echo');
    expect(impulseOutput.every(Number.isFinite)).toBe(true);
    // The same deterministic hiss is present in both runs. A difference only
    // after the 20 ms head delay demonstrates the actual worklet echo path.
    let preDelayMaximumDifference = 0;
    for (let frame = 1; frame < 900; frame += 1) {
      preDelayMaximumDifference = Math.max(preDelayMaximumDifference, Math.abs((impulseOutput[frame] ?? 0) - (silenceOutput[frame] ?? 0)));
    }
    expect(preDelayMaximumDifference).toBeLessThan(1e-7);
    expect(impulseOutput.slice(960, 1200)).not.toEqual(silenceOutput.slice(960, 1200));
    expect(impulseProcessor.core.framesProcessed).toBe(frames);
    expect(impulseProcessor.core.nonFiniteOutputSamples).toBe(0);
  });

  it('runs PANNING DELAY through the shipped variable-quantum worklet with bypass, impulse and reset', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({ processorOptions: {
      algorithm: 'panning-delay', sampleRate: 48000,
      parameters: {
        mix: 1, panningDelayTimeMs: 20, panningDelayFeedback: 0, panningDelayPan: 100,
      },
    } });

    // Worklet nodes start in the safe, bit-exact bypass state.
    const bypassInput = new Float32Array([0.25, -0.5, 0.75]);
    const bypassRight = new Float32Array([0, 0, 0]);
    const bypassOutputLeft = new Float32Array(3);
    const bypassOutputRight = new Float32Array(3);
    processor.process([[bypassInput, bypassRight]], [[bypassOutputLeft, bypassOutputRight]]);
    expect(processor.core.algorithm).toBe('panning-delay');
    expect(bypassOutputLeft).toEqual(bypassInput);
    expect(bypassOutputRight).toEqual(bypassRight);

    processor.port.onmessage?.({ data: { type: 'reset' } });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
    const frames = 2400;
    const impulseLeft = new Float32Array(frames);
    const impulseRight = new Float32Array(frames);
    impulseLeft[0] = 1;
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    let offset = 0;
    for (const requested of [1, 127, 257, 64, 511, 7]) {
      if (offset >= frames) break;
      const count = Math.min(requested, frames - offset);
      processor.process(
        [[impulseLeft.subarray(offset, offset + count), impulseRight.subarray(offset, offset + count)]],
        [[outputLeft.subarray(offset, offset + count), outputRight.subarray(offset, offset + count)]],
      );
      offset += count;
    }
    if (offset < frames) {
      processor.process(
        [[impulseLeft.subarray(offset), impulseRight.subarray(offset)]],
        [[outputLeft.subarray(offset), outputRight.subarray(offset)]],
      );
    }

    expect(outputLeft.slice(0, 960).every((sample) => Math.abs(sample) < 1e-6)).toBe(true);
    expect(outputRight.slice(0, 960).every((sample) => Math.abs(sample) < 1e-6)).toBe(true);
    expect(outputLeft[960]).toBeCloseTo(0, 6);
    expect(outputRight[960]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(outputLeft.every(Number.isFinite) && outputRight.every(Number.isFinite)).toBe(true);

    processor.port.onmessage?.({ data: { type: 'reset' } });
    const silence = new Float32Array(1200);
    const afterResetLeft = new Float32Array(silence.length);
    const afterResetRight = new Float32Array(silence.length);
    processor.process([[silence, silence]], [[afterResetLeft, afterResetRight]]);
    expect(afterResetLeft.every((sample) => sample === 0)).toBe(true);
    expect(afterResetRight.every((sample) => sample === 0)).toBe(true);
    expect(processor.core.framesProcessed).toBe(3 + frames + silence.length);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
  });

  it('runs real stereo granular grains with controls through variable worklet quanta', () => {
    const { Processor } = loadProcessorBundle();
    const parameters = {
      mix: 1,
      granularGrainSizeMs: 90,
      granularDensityHz: 20,
      granularPitchSemitones: 5,
      granularPositionJitterPercent: 65,
      granularFeedbackPercent: 30,
    };
    const makeProcessor = () => {
      const processor = new Processor({ processorOptions: { algorithm: 'granular-delay', sampleRate: 48000, parameters } });
      processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
      return processor;
    };
    const wholeProcessor = makeProcessor();
    const segmentedProcessor = makeProcessor();
    const frames = 24017;
    const inputLeft = new Float32Array(frames);
    const inputRight = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      inputLeft[frame] = 0.4 * Math.sin((2 * Math.PI * 330 * frame) / 48000);
      inputRight[frame] = 0.3 * Math.sin((2 * Math.PI * 660 * frame) / 48000);
    }
    const wholeLeft = new Float32Array(frames);
    const wholeRight = new Float32Array(frames);
    const segmentedLeft = new Float32Array(frames);
    const segmentedRight = new Float32Array(frames);
    wholeProcessor.process([[inputLeft, inputRight]], [[wholeLeft, wholeRight]]);

    let offset = 0;
    for (const requested of [1, 127, 257, 64, 511, 7]) {
      if (offset >= frames) break;
      const count = Math.min(requested, frames - offset);
      segmentedProcessor.process(
        [[inputLeft.subarray(offset, offset + count), inputRight.subarray(offset, offset + count)]],
        [[segmentedLeft.subarray(offset, offset + count), segmentedRight.subarray(offset, offset + count)]],
      );
      offset += count;
    }
    if (offset < frames) {
      segmentedProcessor.process(
        [[inputLeft.subarray(offset), inputRight.subarray(offset)]],
        [[segmentedLeft.subarray(offset), segmentedRight.subarray(offset)]],
      );
    }

    expect(wholeProcessor.core.algorithm).toBe('granular-delay');
    expect(wholeLeft).not.toEqual(inputLeft);
    expect(wholeRight).not.toEqual(inputRight);
    expect(segmentedLeft).toEqual(wholeLeft);
    expect(segmentedRight).toEqual(wholeRight);
    expect(wholeLeft.every(Number.isFinite) && wholeRight.every(Number.isFinite)).toBe(true);
    expect(wholeLeft.every((sample) => Math.abs(sample) <= 2)).toBe(true);
    expect(wholeRight.every((sample) => Math.abs(sample) <= 2)).toBe(true);
    expect(wholeProcessor.core.nonFiniteOutputSamples).toBe(0);
    expect(wholeProcessor.core.framesProcessed).toBe(frames);
  });

  it('ships the clean-room RADIO processor and renders stereo variable quanta', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({
      processorOptions: {
        algorithm: 'radio',
        sampleRate: 48000,
        parameters: { radioBand: 2, radioDrive: 70, radioNoise: 0, mix: 1 },
      },
    });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
    const input = new Float32Array(777);
    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);
    for (let frame = 0; frame < input.length; frame += 1) input[frame] = 0.7 * Math.sin(frame * 0.14);
    for (const [start, end] of [[0, 1], [1, 129], [129, 386], [386, 777]]) {
      processor.process([[input.subarray(start, end)]], [[left.subarray(start, end), right.subarray(start, end)]]);
    }
    expect(processor.core.algorithm).toBe('radio');
    expect(left).not.toEqual(input);
    expect(right).toEqual(left);
    expect(left.every(Number.isFinite)).toBe(true);
    expect(processor.core.framesProcessed).toBe(input.length);
  });

  it('ships the SUSTAINER processor with parameter updates, linked stereo and variable quanta', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({
      processorOptions: {
        algorithm: 'sustainer',
        sampleRate: 48000,
        parameters: { thresholdDb: -24, ratio: 4, releaseMs: 180, outputDb: 0, mix: 1 },
      },
    });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
    processor.port.onmessage?.({ data: { type: 'configure', parameters: { outputDb: 3 } } });
    const input = new Float32Array(777).fill(0.2);
    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);
    for (const [start, end] of [[0, 1], [1, 129], [129, 386], [386, 777]]) {
      processor.process([[input.subarray(start, end)]], [[left.subarray(start, end), right.subarray(start, end)]]);
    }
    expect(processor.core.algorithm).toBe('sustainer');
    expect(left).not.toEqual(input);
    expect(right).toEqual(left);
    expect(left.every(Number.isFinite)).toBe(true);
    expect(left.every((sample) => Math.abs(sample) <= 0.966051)).toBe(true);
    expect(processor.core.framesProcessed).toBe(input.length);
  });

  it('ships VIBRATO through the worklet and renders mono-upmixed stereo across variable quanta', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({
      processorOptions: {
        algorithm: 'vibrato',
        sampleRate: 48000,
        parameters: { vibratoRateHz: 7.2, vibratoDepthPercent: 64, vibratoDelayMs: 3.1, mix: 1 },
      },
    });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
    const input = new Float32Array(2305);
    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);
    for (let frame = 0; frame < input.length; frame += 1) input[frame] = 0.7 * Math.sin(frame * 0.09);
    let offset = 0;
    for (const requested of [1, 17, 127, 257, 3, 511, 64]) {
      const count = Math.min(requested, input.length - offset);
      processor.process([[input.subarray(offset, offset + count)]], [[left.subarray(offset, offset + count), right.subarray(offset, offset + count)]]);
      offset += count;
      if (offset === input.length) break;
    }
    if (offset < input.length) {
      processor.process([[input.subarray(offset)]], [[left.subarray(offset), right.subarray(offset)]]);
    }
    expect(processor.core.algorithm).toBe('vibrato');
    expect(left).not.toEqual(input);
    expect(right).not.toEqual(left);
    expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true);
    expect(left.every((sample) => Math.abs(sample) <= 8)).toBe(true);
    expect(right.every((sample) => Math.abs(sample) <= 8)).toBe(true);
    expect(processor.core.framesProcessed).toBe(input.length);
  });

  it('runs VINYL FLICK through the built worklet with matched stereo latency, variable quanta, and controls', () => {
    const { Processor } = loadProcessorBundle();
    const processor = new Processor({
      processorOptions: {
        algorithm: 'vinyl-flick',
        sampleRate: 8000,
        parameters: { vinylFlickSpeed: 0, vinylFlickReturnTimeSeconds: 1.5, vinylFlickBrakePercent: 35, mix: 1 },
        bypassed: false,
      },
    });
    const totalFrames = 4096;
    const inputLeft = new Float32Array(totalFrames);
    const inputRight = new Float32Array(totalFrames);
    const outputLeft = new Float32Array(totalFrames);
    const outputRight = new Float32Array(totalFrames);
    for (let frame = 0; frame < totalFrames; frame += 1) {
      inputLeft[frame] = 0.3 * Math.sin((2 * Math.PI * 220 * frame) / 8000);
      inputRight[frame] = 0.2 * Math.cos((2 * Math.PI * 330 * frame) / 8000);
    }
    const quanta = [1, 31, 128, 257, 3];
    let offset = 0;
    let block = 0;
    while (offset < totalFrames) {
      const frames = Math.min(quanta[block % quanta.length]!, totalFrames - offset);
      processor.process(
        [[inputLeft.subarray(offset, offset + frames), inputRight.subarray(offset, offset + frames)]],
        [[outputLeft.subarray(offset, offset + frames), outputRight.subarray(offset, offset + frames)]],
      );
      offset += frames;
      block += 1;
    }
    expect(processor.core.algorithm).toBe('vinyl-flick');
    expect(outputLeft[2]).toBeCloseTo(inputLeft[0]!, 6);
    expect(outputRight[2]).toBeCloseTo(inputRight[0]!, 6);
    expect(outputLeft.slice(2)).toEqual(inputLeft.slice(0, -2));
    expect(outputRight.slice(2)).toEqual(inputRight.slice(0, -2));

    processor.port.onmessage?.({ data: { type: 'configure', parameters: { vinylFlickSpeed: -100, vinylFlickReturnTimeSeconds: 0.05 } } });
    processor.port.onmessage?.({ data: { type: 'reset' } });
    processor.port.onmessage?.({ data: { type: 'set-bypass', value: false, rampFrames: 0 } });
    const heldLeft = new Float32Array(257).fill(0.25);
    const heldRight = new Float32Array(257).fill(-0.15);
    const heldOutputLeft = new Float32Array(257);
    const heldOutputRight = new Float32Array(257);
    processor.process([[heldLeft, heldRight]], [[heldOutputLeft, heldOutputRight]]);
    expect(heldOutputLeft.every(Number.isFinite)).toBe(true);
    expect(heldOutputRight.every(Number.isFinite)).toBe(true);
    expect(processor.core.nonFiniteOutputSamples).toBe(0);
  });
});
