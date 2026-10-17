import { describe, expect, it } from 'vitest';
import {
  BROWSER_FX_ALGORITHM_INFO,
  BrowserFxDspCore,
  type BrowserFxAlgorithm,
} from '../../src/audio/fx/dsp/BrowserFxDspCore';

function createSignal(length: number, sampleRate: number): Float32Array {
  const signal = new Float32Array(length);
  for (let frame = 0; frame < length; frame += 1) {
    signal[frame] = frame === 0 ? 1 : 0.35 * Math.sin((2 * Math.PI * 997 * frame) / sampleRate);
  }
  return signal;
}

function runMono(core: BrowserFxDspCore, input: Float32Array, blockSizes?: readonly number[]): Float32Array {
  const output = new Float32Array(input.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < input.length) {
    const requested = blockSizes?.[blockIndex % blockSizes.length] ?? input.length;
    const length = Math.min(Math.max(1, requested), input.length - offset);
    core.processBlock(input.subarray(offset, offset + length), null, output.subarray(offset, offset + length), null, length);
    offset += length;
    blockIndex += 1;
  }
  return output;
}

function runStereo(
  core: BrowserFxDspCore,
  inputLeft: Float32Array,
  inputRight: Float32Array,
  blockSizes?: readonly number[],
): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(inputLeft.length);
  const right = new Float32Array(inputRight.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < inputLeft.length) {
    const requested = blockSizes?.[blockIndex % blockSizes.length] ?? inputLeft.length;
    const length = Math.min(Math.max(1, requested), inputLeft.length - offset);
    core.processBlock(
      inputLeft.subarray(offset, offset + length),
      inputRight.subarray(offset, offset + length),
      left.subarray(offset, offset + length),
      right.subarray(offset, offset + length),
      length,
    );
    offset += length;
    blockIndex += 1;
  }
  return { left, right };
}

function stereoSideEnergy(left: Float32Array, right: Float32Array, start = 0): number {
  let energy = 0;
  for (let frame = start; frame < left.length; frame += 1) {
    const side = 0.5 * ((left[frame] ?? 0) - (right[frame] ?? 0));
    energy += side * side;
  }
  return energy;
}

function sumEnergy(samples: Float32Array, start = 0, end = samples.length): number {
  let energy = 0;
  for (let frame = start; frame < end; frame += 1) {
    const value = samples[frame] ?? 0;
    energy += value * value;
  }
  return energy;
}

function createTone(length: number, sampleRate: number, frequency: number, amplitude = 0.5): Float32Array {
  const signal = new Float32Array(length);
  for (let frame = 0; frame < length; frame += 1) {
    signal[frame] = amplitude * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
  }
  return signal;
}

function toneMagnitude(samples: Float32Array, sampleRate: number, frequency: number, start: number, end: number): number {
  let real = 0;
  let imaginary = 0;
  const length = end - start;
  for (let frame = start; frame < end; frame += 1) {
    const angle = (2 * Math.PI * frequency * frame) / sampleRate;
    const value = samples[frame] ?? 0;
    real += value * Math.cos(angle);
    imaginary -= value * Math.sin(angle);
  }
  return (2 * Math.hypot(real, imaginary)) / length;
}

describe('bounded Browser FX DSP core', () => {
  it('registers every actual clean-room Browser FX with nonnegative declared latency', () => {
    expect(Object.keys(BROWSER_FX_ALGORITHM_INFO).sort()).toEqual(['auto-pan', 'auto-riff', 'beat-repeat', 'beat-scatter', 'beat-shift', 'bpf', 'chorus', 'delay', 'distortion', 'dynamics', 'electric', 'eq', 'flanger', 'freeze', 'g2b', 'gate-reverb', 'granular-delay', 'hpf', 'hrm-auto', 'isolator', 'lo-fi', 'lpf', 'manual-pan', 'mod-delay', 'osc-bot', 'osc-voc', 'panning-delay', 'pattern-slicer', 'phaser', 'preamp', 'radio', 'reverb', 'reverse-delay', 'reverse-reverb', 'ring-mod', 'robot', 'roll', 'slow-gear', 'step-slicer', 'stereo-enhance', 'sustainer', 'synth', 'tape-echo', 'tremolo', 'twist', 'vibrato', 'vinyl-flick', 'vocoder', 'warp']);
    for (const info of Object.values(BROWSER_FX_ALGORITHM_INFO)) {
      expect(info.algorithmicLatencySamples).toBeGreaterThanOrEqual(0);
      expect(info.cleanRoomProvenance).toContain('no ');
    }
    expect(BROWSER_FX_ALGORITHM_INFO.reverb.formulaIds).toContain('F17');
    expect(BROWSER_FX_ALGORITHM_INFO['gate-reverb'].formulaIds).toEqual(['F01', 'F08', 'F17']);
    expect(BROWSER_FX_ALGORITHM_INFO['gate-reverb'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO['gate-reverb'].cleanRoomProvenance).toContain('provisional');
    expect(BROWSER_FX_ALGORITHM_INFO['reverse-delay'].formulaIds).toEqual(['F14', 'F20', 'F25']);
    expect(BROWSER_FX_ALGORITHM_INFO['reverse-delay'].algorithmicLatencySamples).toBe(24_000);
    expect(BROWSER_FX_ALGORITHM_INFO['reverse-reverb'].formulaIds).toEqual(['F17', 'F18', 'F25']);
    expect(BROWSER_FX_ALGORITHM_INFO['reverse-reverb'].implementationStatus).toBe('experimental');
    expect(BROWSER_FX_ALGORITHM_INFO['reverse-reverb'].algorithmicLatencySamples).toBe(12_000);
    expect(BROWSER_FX_ALGORITHM_INFO['auto-riff'].implementationStatus).toBe('experimental');
    expect(BROWSER_FX_ALGORITHM_INFO['auto-riff'].formulaIds).toContain('F09');
    expect(BROWSER_FX_ALGORITHM_INFO['hrm-auto'].implementationStatus).toBe('experimental');
    expect(BROWSER_FX_ALGORITHM_INFO['hrm-auto'].formulaIds).toEqual(['F09', 'F10', 'F11']);
    expect(BROWSER_FX_ALGORITHM_INFO.lpf.formulaIds).toEqual(['F01', 'F03']);
    expect(BROWSER_FX_ALGORITHM_INFO.flanger.formulaIds).toEqual(['F01', 'F05', 'F06', 'F14']);
    expect(BROWSER_FX_ALGORITHM_INFO.flanger.algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.distortion.algorithmicLatencySamples).toBe(16);
    expect(BROWSER_FX_ALGORITHM_INFO.g2b.formulaIds).toEqual(['F09', 'F10', 'F11']);
    expect(BROWSER_FX_ALGORITHM_INFO.g2b.algorithmicLatencySamples).toBe(2_868);
    expect(BROWSER_FX_ALGORITHM_INFO.g2b.cleanRoomProvenance).toContain('No TD-PSOLA');
    expect(BROWSER_FX_ALGORITHM_INFO.electric.formulaIds).toEqual(['F03', 'F09', 'F10', 'F13', 'F28', 'F29']);
    expect(BROWSER_FX_ALGORITHM_INFO.electric.algorithmicLatencySamples).toBe(2_868);
    expect(BROWSER_FX_ALGORITHM_INFO.electric.cleanRoomProvenance).toContain('no Roland');
    expect(BROWSER_FX_ALGORITHM_INFO['beat-scatter'].formulaIds).toEqual(['F05', 'F09', 'F15', 'F20', 'F25']);
    expect(BROWSER_FX_ALGORITHM_INFO['beat-scatter'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.roll.formulaIds).toEqual(['F05', 'F15', 'F20', 'F25']);
    expect(BROWSER_FX_ALGORITHM_INFO.roll.algorithmicLatencySamples).toBe(12_000);
    expect(BROWSER_FX_ALGORITHM_INFO.freeze.formulaIds).toEqual(['F12', 'F19', 'F25']);
    expect(BROWSER_FX_ALGORITHM_INFO.freeze.algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.roll.cleanRoomProvenance).toContain('pitch changes playback rate');
    expect(BROWSER_FX_ALGORITHM_INFO['pattern-slicer'].formulaIds).toEqual(['F16', 'F20']);
    expect(BROWSER_FX_ALGORITHM_INFO['pattern-slicer'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO['step-slicer'].formulaIds).toEqual(['F01', 'F16', 'F20', 'F21']);
    expect(BROWSER_FX_ALGORITHM_INFO['step-slicer'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO['beat-shift'].formulaIds).toEqual(['F20', 'F25']);
    expect(BROWSER_FX_ALGORITHM_INFO['beat-shift'].algorithmicLatencySamples).toBe(72_000);
    expect(BROWSER_FX_ALGORITHM_INFO['beat-shift'].implementationStatus).toBe('experimental');
    expect(BROWSER_FX_ALGORITHM_INFO['beat-shift'].cleanRoomProvenance).toContain('four-beat look-ahead baseline');
    expect(BROWSER_FX_ALGORITHM_INFO['beat-shift'].cleanRoomProvenance).toContain('72,000 reference samples at 48 kHz / 120 BPM');
    expect(BROWSER_FX_ALGORITHM_INFO.dynamics.formulaIds).toEqual(['F01', 'F08']);
    expect(BROWSER_FX_ALGORITHM_INFO.delay.formulaIds).toEqual(['F01', 'F05', 'F14', 'F20']);
    expect(BROWSER_FX_ALGORITHM_INFO.delay.algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO['panning-delay'].formulaIds).toEqual(['F05', 'F14', 'F20', 'F21']);
    expect(BROWSER_FX_ALGORITHM_INFO['panning-delay'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.chorus.formulaIds).toEqual(['F01', 'F05', 'F06', 'F21']);
    expect(BROWSER_FX_ALGORITHM_INFO.chorus.algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.phaser.formulaIds).toEqual(['F01', 'F04', 'F06']);
    expect(BROWSER_FX_ALGORITHM_INFO.phaser.algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.phaser.cleanRoomProvenance).toContain('no BI-PHASE');
    expect(BROWSER_FX_ALGORITHM_INFO.tremolo.formulaIds).toEqual(['F01', 'F06']);
    expect(BROWSER_FX_ALGORITHM_INFO.tremolo.algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO['auto-pan'].formulaIds).toEqual(['F01', 'F06', 'F21']);
    expect(BROWSER_FX_ALGORITHM_INFO['auto-pan'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO['stereo-enhance'].formulaIds).toEqual(['F01', 'F04', 'F22']);
    expect(BROWSER_FX_ALGORITHM_INFO['stereo-enhance'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO['lo-fi'].formulaIds).toEqual(['F28']);
    expect(BROWSER_FX_ALGORITHM_INFO['lo-fi'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.eq.formulaIds).toEqual(['F01', 'F02']);
    expect(BROWSER_FX_ALGORITHM_INFO.eq.algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO['manual-pan'].formulaIds).toEqual(['F01', 'F21']);
    expect(BROWSER_FX_ALGORITHM_INFO['manual-pan'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO['tape-echo'].formulaIds).toEqual(['F02', 'F05', 'F06', 'F07', 'F14', 'F20']);
    expect(BROWSER_FX_ALGORITHM_INFO['tape-echo'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.twist.formulaIds).toEqual(['F01', 'F03', 'F05', 'F06', 'F07', 'F14', 'F21']);
    expect(BROWSER_FX_ALGORITHM_INFO.twist.algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.twist.implementationStatus).toBe('experimental');
    expect(BROWSER_FX_ALGORITHM_INFO['granular-delay'].formulaIds).toEqual(['F05', 'F09', 'F15', 'F20']);
    expect(BROWSER_FX_ALGORITHM_INFO['granular-delay'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.radio.formulaIds).toEqual(['F02', 'F07', 'F28']);
    expect(BROWSER_FX_ALGORITHM_INFO.radio.algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.vibrato.formulaIds).toEqual(['F01', 'F05', 'F06']);
    expect(BROWSER_FX_ALGORITHM_INFO.vibrato.algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.sustainer.formulaIds).toEqual(['F01', 'F08']);
    expect(BROWSER_FX_ALGORITHM_INFO.sustainer.algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO['slow-gear'].formulaIds).toEqual(['F01', 'F27']);
    expect(BROWSER_FX_ALGORITHM_INFO['slow-gear'].algorithmicLatencySamples).toBe(0);
    expect(BROWSER_FX_ALGORITHM_INFO.isolator.formulaIds).toEqual(['F01', 'F03', 'F16', 'F20']);
    expect(BROWSER_FX_ALGORITHM_INFO.isolator.algorithmicLatencySamples).toBe(0);
  });

  it('sweeps filter and FDN8 processing across sample rates with finite, bounded output', () => {
    const sampleRates = [8000, 16000, 22050, 44100, 48000, 96000];
    const algorithms: readonly BrowserFxAlgorithm[] = ['lpf', 'bpf', 'hpf', 'flanger', 'distortion', 'preamp', 'dynamics', 'sustainer', 'delay', 'panning-delay', 'chorus', 'phaser', 'tremolo', 'auto-pan', 'reverb', 'gate-reverb', 'beat-shift', 'stereo-enhance', 'tape-echo', 'twist', 'granular-delay', 'radio', 'vibrato', 'slow-gear', 'isolator', 'vocoder'];
    for (const sampleRate of sampleRates) {
      const frames = Math.round(sampleRate * 0.75);
      const input = createSignal(frames, sampleRate);
      for (const algorithm of algorithms) {
        const parameters = algorithm === 'vocoder' ? { mix: 1, vocoderBands: 16, vocoderCarrier: 1 } : {
          cutoffHz: 1200, q: 0.8, decaySeconds: 2.4,
          mix: 1, gateThresholdDb: -30, gateHoldMs: 120, gateReleaseMs: 160,
        };
        const core = new BrowserFxDspCore(algorithm, sampleRate, parameters);
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        core.processBlock(input, input, left, right);
        expect(left.every(Number.isFinite), `${algorithm} at ${sampleRate} Hz`).toBe(true);
        expect(right.every(Number.isFinite), `${algorithm} right at ${sampleRate} Hz`).toBe(true);
        let peak = 0;
        for (let frame = 0; frame < frames; frame += 1) {
          peak = Math.max(peak, Math.abs(left[frame] ?? 0), Math.abs(right[frame] ?? 0));
        }
        expect(peak, `${algorithm} peak at ${sampleRate} Hz`).toBeLessThan(2);
        expect(core.nonFiniteInputSamples).toBe(0);
        expect(core.nonFiniteOutputSamples).toBe(0);
        if (algorithm === 'reverb' || algorithm === 'gate-reverb') expect(sumEnergy(left, 32) + sumEnergy(right, 32)).toBeGreaterThan(0);
      }
    }
  }, 15_000);

  it('is block-size invariant for filters, modulated delay, oversampled distortion, and FDN8 feedback', () => {
    const sampleRate = 48000;
    const input = createSignal(4097, sampleRate);
    const blockSizes = [1, 7, 64, 127, 257, 3, 511] as const;
    for (const algorithm of ['lpf', 'bpf', 'hpf', 'flanger', 'distortion', 'preamp', 'dynamics', 'sustainer', 'delay', 'panning-delay', 'chorus', 'phaser', 'tremolo', 'auto-pan', 'reverb', 'gate-reverb', 'stereo-enhance', 'tape-echo', 'twist', 'granular-delay'] as const) {
      const parameters = { cutoffHz: 3300, q: 1.8, decaySeconds: 3.1, mix: 0.8, gateThresholdDb: -32, gateHoldMs: 97, gateReleaseMs: 223 };
      const oneBlock = new BrowserFxDspCore(algorithm, sampleRate, parameters);
      const variedBlocks = new BrowserFxDspCore(algorithm, sampleRate, parameters);
      const whole = runMono(oneBlock, input);
      const split = runMono(variedBlocks, input, blockSizes);
      expect(split).toEqual(whole);
      expect(variedBlocks.framesProcessed).toBe(input.length);
    }
  });

  it('runs the integrated granular core with real wet audio, bounded output and block-invariant stereo state', () => {
    const sampleRate = 16000;
    const frames = 32017;
    const leftInput = createTone(frames, sampleRate, 317, 0.6);
    const rightInput = createTone(frames, sampleRate, 733, 0.4);
    const parameters = {
      mix: 1,
      granularGrainSizeMs: 230,
      granularDensityHz: 18,
      granularPitchSemitones: 7,
      granularPositionJitterPercent: 70,
      granularFeedbackPercent: 40,
    };
    const wholeCore = new BrowserFxDspCore('granular-delay', sampleRate, parameters);
    const segmentedCore = new BrowserFxDspCore('granular-delay', sampleRate, parameters);
    const whole = runStereo(wholeCore, leftInput, rightInput);
    const segmented = runStereo(segmentedCore, leftInput, rightInput, [1, 7, 64, 127, 257, 3, 511]);

    expect(whole.left).not.toEqual(leftInput);
    expect(whole.right).not.toEqual(rightInput);
    expect(segmented.left).toEqual(whole.left);
    expect(segmented.right).toEqual(whole.right);
    expect(whole.left.every(Number.isFinite) && whole.right.every(Number.isFinite)).toBe(true);
    expect(whole.left.every((sample) => Math.abs(sample) <= 2)).toBe(true);
    expect(whole.right.every((sample) => Math.abs(sample) <= 2)).toBe(true);
    expect(wholeCore.nonFiniteOutputSamples).toBe(0);

    const dry = new BrowserFxDspCore('granular-delay', sampleRate, { mix: 0 });
    expect(runMono(dry, leftInput)).toEqual(leftInput);
  });

  it('provides bit-exact bypass, dry-mix identity, and a smoothed equal-power bypass transition', () => {
    const algorithms: readonly BrowserFxAlgorithm[] = ['lpf', 'bpf', 'hpf', 'flanger', 'ring-mod', 'distortion', 'preamp', 'dynamics', 'delay', 'panning-delay', 'chorus', 'phaser', 'tremolo', 'auto-pan', 'reverb', 'gate-reverb', 'stereo-enhance', 'lo-fi', 'eq', 'manual-pan', 'tape-echo', 'twist', 'granular-delay', 'vibrato', 'slow-gear', 'freeze', 'vocoder'];
    const inputLeft = new Float32Array([0.25, -0.5, 1, -1, 0.125, 0.875, -0.25]);
    const inputRight = new Float32Array([-0.75, 0.625, -0.125, 0.5, 0.25, -0.875, 0.375]);
    for (const algorithm of algorithms) {
      const bypassed = new BrowserFxDspCore(algorithm, 48000);
      bypassed.setBypass(true);
      const outputLeft = new Float32Array(inputLeft.length);
      const outputRight = new Float32Array(inputRight.length);
      bypassed.processBlock(inputLeft, inputRight, outputLeft, outputRight);
      expect(outputLeft).toEqual(inputLeft);
      expect(outputRight).toEqual(inputRight);
    }

    const dryCore = new BrowserFxDspCore('reverb', 48000, { mix: 0 });
    const dryOutput = new Float32Array(inputLeft.length);
    dryCore.processBlock(inputLeft, inputRight, dryOutput, null);
    expect(dryOutput).toEqual(inputLeft);

    const transitioning = new BrowserFxDspCore('hpf', 48000);
    const constant = new Float32Array(64).fill(0.4);
    const transition = new Float32Array(64);
    transitioning.setBypass(true, 64);
    transitioning.processBlock(constant, null, transition, null);
    expect(transition.every(Number.isFinite)).toBe(true);
    expect(transition[0]).toBeGreaterThan(0);
    expect(transition[63]).toBeCloseTo(0.4, 6);
  });

  it('keeps FREEZE capture history warm in exact-dry bypass and freezes the last requested loop', () => {
    const sampleRate = 8000;
    const captured = createTone(640, sampleRate, 311, 0.6);
    const core = new BrowserFxDspCore('freeze', sampleRate, { mix: 1, freezeCaptureLengthMs: 40 });
    core.setBypass(true, 0);

    const bypassLeft = new Float32Array(captured.length);
    const bypassRight = new Float32Array(captured.length);
    core.processBlock(captured, captured, bypassLeft, bypassRight);
    expect(bypassLeft).toEqual(captured);
    expect(bypassRight).toEqual(captured);

    core.setParameters({ freezeEnabled: 1 });
    const silence = new Float32Array(128);
    const silentBypassLeft = new Float32Array(silence.length);
    const silentBypassRight = new Float32Array(silence.length);
    core.processBlock(silence, silence, silentBypassLeft, silentBypassRight);
    expect(silentBypassLeft).toEqual(silence);
    expect(silentBypassRight).toEqual(silence);

    core.setBypass(false, 0);
    const frozenLeft = new Float32Array(512);
    const frozenRight = new Float32Array(512);
    core.processBlock(silence, silence, frozenLeft, frozenRight);
    expect(sumEnergy(frozenLeft)).toBeGreaterThan(0.1);
    expect(sumEnergy(frozenRight)).toBeGreaterThan(0.1);
    expect(frozenLeft.every(Number.isFinite) && frozenRight.every(Number.isFinite)).toBe(true);
  });

  it('exposes meaningful filter, modulation, reverb-mix, and decay controls', () => {
    const sampleRate = 48000;
    const frames = 8192;
    const highTone = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) highTone[frame] = Math.sin((2 * Math.PI * 8000 * frame) / sampleRate);

    const lowCutoff = new BrowserFxDspCore('lpf', sampleRate, { cutoffHz: 180, mix: 1 });
    const highCutoff = new BrowserFxDspCore('lpf', sampleRate, { cutoffHz: 10000, mix: 1 });
    const lowOutput = runMono(lowCutoff, highTone);
    const highOutput = runMono(highCutoff, highTone);
    expect(sumEnergy(lowOutput, 512)).toBeLessThan(sumEnergy(highOutput, 512) * 0.08);

    const modulatorA = new BrowserFxDspCore('ring-mod', sampleRate, { ringModHz: 200, ringModDepth: 1, mix: 1 });
    const modulatorB = new BrowserFxDspCore('ring-mod', sampleRate, { ringModHz: 1400, ringModDepth: 1, mix: 1 });
    const ringInput = new Float32Array(512);
    for (let frame = 0; frame < ringInput.length; frame += 1) ringInput[frame] = Math.sin((2 * Math.PI * 220 * frame) / sampleRate);
    expect(runMono(modulatorA, ringInput)).not.toEqual(runMono(modulatorB, ringInput));

    const wetCore = new BrowserFxDspCore('reverb', sampleRate, { mix: 1, decaySeconds: 3.5 });
    const dryCore = new BrowserFxDspCore('reverb', sampleRate, { mix: 0 });
    const impulse = new Float32Array(sampleRate);
    impulse[0] = 1;
    const wetTail = runMono(wetCore, impulse);
    const dryTail = runMono(dryCore, impulse);
    expect(sumEnergy(wetTail, 2000)).toBeGreaterThan(sumEnergy(dryTail, 2000));

    const longDecay = new BrowserFxDspCore('reverb', sampleRate, { mix: 1, decaySeconds: 7 });
    const shortDecay = new BrowserFxDspCore('reverb', sampleRate, { mix: 1, decaySeconds: 0.3 });
    const longTail = runMono(longDecay, impulse);
    const shortTail = runMono(shortDecay, impulse);
    expect(sumEnergy(shortTail, 18000)).toBeLessThan(sumEnergy(longTail, 18000));
  });

  it('gates the FDN8 return with bounded threshold, hold, release, and dry mix', () => {
    const sampleRate = 48000;
    const impulse = new Float32Array(16000);
    impulse[0] = 1;
    const shortRelease = new BrowserFxDspCore('gate-reverb', sampleRate, {
      mix: 1, decaySeconds: 5, gateThresholdDb: -24, gateHoldMs: 40, gateReleaseMs: 40,
    });
    const longRelease = new BrowserFxDspCore('gate-reverb', sampleRate, {
      mix: 1, decaySeconds: 5, gateThresholdDb: -24, gateHoldMs: 40, gateReleaseMs: 300,
    });
    const shortTail = runMono(shortRelease, impulse);
    const longTail = runMono(longRelease, impulse);
    const dry = new BrowserFxDspCore('gate-reverb', sampleRate, { mix: 0 });
    expect(sumEnergy(shortTail, 0, 2000)).toBeGreaterThan(0);
    expect(sumEnergy(shortTail, 9000)).toBeLessThan(sumEnergy(longTail, 9000));
    expect(shortTail.every(Number.isFinite) && longTail.every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from(shortTail, Math.abs))).toBeLessThan(2);

    const dryOutput = runMono(dry, impulse);
    expect(dryOutput).toEqual(impulse);
  });

  it('implements stereo-enhance width, low-frequency mono protection, decorrelation, wet mix and bypass', () => {
    const sampleRate = 48000;
    const frames = 8192;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const mid = 0.3;
      const side = 0.2 * Math.sin((2 * Math.PI * 1100 * frame) / sampleRate);
      left[frame] = mid + side;
      right[frame] = mid - side;
    }

    const collapsed = runStereo(new BrowserFxDspCore('stereo-enhance', sampleRate, {
      mix: 1, stereoWidth: 0, stereoLowMonoCutoffHz: 120, stereoDecorrelation: 0,
    }), left, right);
    expect(collapsed.left).toEqual(collapsed.right);

    const normalWidth = runStereo(new BrowserFxDspCore('stereo-enhance', sampleRate, {
      mix: 1, stereoWidth: 1, stereoLowMonoCutoffHz: 120, stereoDecorrelation: 0,
    }), left, right);
    const expandedWidth = runStereo(new BrowserFxDspCore('stereo-enhance', sampleRate, {
      mix: 1, stereoWidth: 2, stereoLowMonoCutoffHz: 120, stereoDecorrelation: 0,
    }), left, right);
    expect(stereoSideEnergy(expandedWidth.left, expandedWidth.right, 512))
      .toBeGreaterThan(stereoSideEnergy(normalWidth.left, normalWidth.right, 512) * 1.1);

    const antiPhaseLeft = createTone(sampleRate, sampleRate, 80, 0.5);
    const antiPhaseRight = new Float32Array(antiPhaseLeft.length);
    for (let frame = 0; frame < antiPhaseRight.length; frame += 1) antiPhaseRight[frame] = -(antiPhaseLeft[frame] ?? 0);
    const lowMonoCut = runStereo(new BrowserFxDspCore('stereo-enhance', sampleRate, {
      mix: 1, stereoWidth: 1, stereoLowMonoCutoffHz: 80, stereoDecorrelation: 0,
    }), antiPhaseLeft, antiPhaseRight);
    const highMonoCut = runStereo(new BrowserFxDspCore('stereo-enhance', sampleRate, {
      mix: 1, stereoWidth: 1, stereoLowMonoCutoffHz: 1000, stereoDecorrelation: 0,
    }), antiPhaseLeft, antiPhaseRight);
    expect(stereoSideEnergy(highMonoCut.left, highMonoCut.right, 12000))
      .toBeLessThan(stereoSideEnergy(lowMonoCut.left, lowMonoCut.right, 12000) * 0.2);

    const decorrelationInputLeft = new Float32Array(frames);
    const decorrelationInputRight = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const side = 0.2 * Math.sin((2 * Math.PI * 1700 * frame) / sampleRate);
      decorrelationInputLeft[frame] = 0.3 + side;
      decorrelationInputRight[frame] = 0.3 - side;
    }
    const undecorrelated = runStereo(new BrowserFxDspCore('stereo-enhance', sampleRate, {
      mix: 1, stereoWidth: 1, stereoLowMonoCutoffHz: 80, stereoDecorrelation: 0,
    }), decorrelationInputLeft, decorrelationInputRight);
    const decorrelated = runStereo(new BrowserFxDspCore('stereo-enhance', sampleRate, {
      mix: 1, stereoWidth: 1, stereoLowMonoCutoffHz: 80, stereoDecorrelation: 1,
    }), decorrelationInputLeft, decorrelationInputRight);
    expect(decorrelated.left).not.toEqual(undecorrelated.left);

    const dry = runStereo(new BrowserFxDspCore('stereo-enhance', sampleRate, {
      mix: 0, stereoWidth: 2, stereoLowMonoCutoffHz: 900, stereoDecorrelation: 1,
    }), left, right);
    expect(dry.left).toEqual(left);
    expect(dry.right).toEqual(right);
    const bypass = new BrowserFxDspCore('stereo-enhance', sampleRate, {
      mix: 1, stereoWidth: 2, stereoLowMonoCutoffHz: 900, stereoDecorrelation: 1,
    });
    bypass.setBypass(true, 0);
    const bypassed = runStereo(bypass, left, right);
    expect(bypassed.left).toEqual(left);
    expect(bypassed.right).toEqual(right);
  });

  it('keeps stereo-enhance stable and invariant across variable block sizes', () => {
    const sampleRate = 48000;
    const frames = 4097;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      left[frame] = 0.6 * Math.sin((2 * Math.PI * 1300 * frame) / sampleRate);
      right[frame] = 0.55 * Math.sin((2 * Math.PI * 1700 * frame) / sampleRate + 0.3);
    }
    const parameters = { mix: 1, stereoWidth: 1.7, stereoLowMonoCutoffHz: 320, stereoDecorrelation: 0.8 };
    const wholeCore = new BrowserFxDspCore('stereo-enhance', sampleRate, parameters);
    const variableCore = new BrowserFxDspCore('stereo-enhance', sampleRate, parameters);
    const whole = runStereo(wholeCore, left, right);
    const variable = runStereo(variableCore, left, right, [1, 7, 64, 127, 257, 3, 511]);
    expect(variable.left).toEqual(whole.left);
    expect(variable.right).toEqual(whole.right);
    expect(variableCore.framesProcessed).toBe(frames);

    for (const rate of [8000, 16000, 22050, 44100, 48000, 96000]) {
      const count = Math.round(rate * 0.25);
      const inputLeft = createTone(count, rate, Math.min(2100, rate * 0.2), 0.7);
      const inputRight = createTone(count, rate, Math.min(900, rate * 0.12), 0.65);
      const core = new BrowserFxDspCore('stereo-enhance', rate, {
        mix: 1, stereoWidth: 2, stereoLowMonoCutoffHz: 1000, stereoDecorrelation: 1,
      });
      const output = runStereo(core, inputLeft, inputRight, [1, 127, 257, 64]);
      expect(output.left.every(Number.isFinite), `left output at ${rate} Hz`).toBe(true);
      expect(output.right.every(Number.isFinite), `right output at ${rate} Hz`).toBe(true);
      expect(core.nonFiniteOutputSamples).toBe(0);
      expect(Math.max(...output.left.subarray(0, 1000).map(Math.abs))).toBeLessThan(2);
    }
  });

  it('keeps nonlinear output bounded and measurably suppresses foldback aliases with 4x oversampling', () => {
    const sampleRate = 48000;
    const input = createTone(sampleRate * 2, sampleRate, 7000, 0.5);
    const antiAliased = new BrowserFxDspCore('distortion', sampleRate, {
      mix: 1,
      driveDb: 30,
      outputDb: 0,
      distortionMode: 'overdrive',
    });
    const output = runMono(antiAliased, input, [63, 127, 257, 511]);
    expect(output.every(Number.isFinite)).toBe(true);
    expect(antiAliased.algorithmicLatencySamples).toBe(16);
    let peak = 0;
    for (const sample of output) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeLessThanOrEqual(1.25);

    // The 5th harmonic of 7 kHz (35 kHz) folds to 13 kHz at 48 kHz when a
    // waveshaper is run directly at 1x. The oversampled decimator rejects it.
    const naiveOneX = new Float32Array(input.length);
    const drive = 10 ** (30 / 20);
    for (let frame = 0; frame < input.length; frame += 1) naiveOneX[frame] = Math.tanh((input[frame] ?? 0) * drive);
    const start = sampleRate;
    const end = sampleRate * 2;
    const aliasMagnitude = toneMagnitude(output, sampleRate, 13000, start, end);
    const naiveAliasMagnitude = toneMagnitude(naiveOneX, sampleRate, 13000, start, end);
    expect(naiveAliasMagnitude).toBeGreaterThan(0.05);
    expect(aliasMagnitude).toBeLessThan(naiveAliasMagnitude * 0.2);
    expect(antiAliased.nonFiniteOutputSamples).toBe(0);
  });

  it('smooths distortion curve/drive/level controls and applies all three real waveshaping modes', () => {
    const sampleRate = 48000;
    const input = createTone(12000, sampleRate, 1100, 0.9);
    const core = new BrowserFxDspCore('distortion', sampleRate, { mix: 1, driveDb: 6, outputDb: 0, distortionMode: 'overdrive' });
    const soft = runMono(core, input);
    core.setParameters({ driveDb: 30, outputDb: -6, distortionMode: 'hard-clip' });
    const hard = runMono(core, input, [1, 7, 129, 31]);
    core.setParameters({ distortionMode: 'fuzz' });
    const fuzz = runMono(core, input, [64, 255, 3]);
    expect(soft.every(Number.isFinite) && hard.every(Number.isFinite) && fuzz.every(Number.isFinite)).toBe(true);
    expect(soft).not.toEqual(hard);
    expect(hard).not.toEqual(fuzz);
    expect(sumEnergy(hard, 1024)).toBeLessThan(sumEnergy(runMono(new BrowserFxDspCore('distortion', sampleRate, { mix: 1, driveDb: 30, outputDb: 0, distortionMode: 'hard-clip' }), input), 1024));
  });

  it('uses a smooth Lagrange flanger read head and remains bounded at maximum signed feedback', () => {
    const sampleRate = 48000;
    const frames = sampleRate * 2;
    const constantInput = new Float32Array(frames).fill(0.25);
    const flanger = new BrowserFxDspCore('flanger', sampleRate, {
      mix: 1,
      flangerDelayMs: 3,
      flangerRateHz: 0.8,
      flangerDepth: 1,
      flangerFeedback: 0.65,
    });
    const swept = runMono(flanger, constantInput, [1, 64, 128, 257, 7]);
    let maxStep = 0;
    for (let frame = 2000; frame < swept.length; frame += 1) {
      maxStep = Math.max(maxStep, Math.abs((swept[frame] ?? 0) - (swept[frame - 1] ?? 0)));
    }
    expect(maxStep).toBeLessThan(0.015);
    expect(swept.every(Number.isFinite)).toBe(true);

    for (const feedback of [-0.95, 0.95]) {
      const impulse = new Float32Array(frames);
      impulse[0] = 1;
      const extreme = new BrowserFxDspCore('flanger', sampleRate, {
        mix: 1,
        flangerDelayMs: 0.2,
        flangerRateHz: 7,
        flangerDepth: 1,
        flangerFeedback: feedback,
      });
      const tail = runMono(extreme, impulse, [127, 255, 511]);
      let peak = 0;
      for (const sample of tail) peak = Math.max(peak, Math.abs(sample));
      expect(peak).toBeLessThan(2);
      expect(tail.every(Number.isFinite)).toBe(true);
      expect(sumEnergy(tail, sampleRate)).toBeLessThan(sumEnergy(tail, 0, sampleRate) * 1.1 + 1e-8);
    }
  });

  it('responds to flanger delay/rate/depth/feedback and has exact dry mix at zero', () => {
    const sampleRate = 48000;
    const input = createTone(8192, sampleRate, 440, 0.5);
    const first = new BrowserFxDspCore('flanger', sampleRate, { mix: 1, flangerDelayMs: 1, flangerRateHz: 0.1, flangerDepth: 0.1, flangerFeedback: 0 });
    const second = new BrowserFxDspCore('flanger', sampleRate, { mix: 1, flangerDelayMs: 8, flangerRateHz: 4, flangerDepth: 1, flangerFeedback: -0.7 });
    expect(runMono(first, input)).not.toEqual(runMono(second, input));
    const dry = new BrowserFxDspCore('flanger', sampleRate, { mix: 0 });
    expect(runMono(dry, input)).toEqual(input);
  });

  it('implements stereo-linked compressor transfer with a continuous F08 soft knee', () => {
    const sampleRate = 48000;
    const duration = sampleRate;
    const config = { mix: 1, thresholdDb: -18, ratio: 4, kneeDb: 0, attackMs: 1, releaseMs: 100, dynamicsDetector: 'peak' as const };
    const lowInput = new Float32Array(duration).fill(0.1);
    const highInput = new Float32Array(duration).fill(1);
    const lowOutput = runMono(new BrowserFxDspCore('dynamics', sampleRate, config), lowInput);
    const highOutput = runMono(new BrowserFxDspCore('dynamics', sampleRate, config), highInput);
    expect(lowOutput.at(-1)).toBeCloseTo(0.1, 3);
    // 0 dBFS at a -18 dB threshold and 4:1 ratio maps to roughly -13.5 dBFS.
    expect(highOutput.at(-1)).toBeCloseTo(10 ** (-13.5 / 20), 2);

    const stereoLinked = new BrowserFxDspCore('dynamics', sampleRate, config);
    const left = new Float32Array(duration).fill(0.1);
    const right = new Float32Array(duration).fill(1);
    const linkedLeft = new Float32Array(duration);
    const linkedRight = new Float32Array(duration);
    stereoLinked.processBlock(left, right, linkedLeft, linkedRight);
    expect(linkedLeft.at(-1)).toBeCloseTo(0.1 * (highOutput.at(-1) ?? 1), 3);
    expect(linkedRight.at(-1)).toBeCloseTo(highOutput.at(-1) ?? 1, 3);

    const kneeSignal = new Float32Array(duration).fill(0.1); // -20 dBFS: inside a 12 dB knee around -18 dB.
    const hardKnee = runMono(new BrowserFxDspCore('dynamics', sampleRate, config), kneeSignal);
    const softKnee = runMono(new BrowserFxDspCore('dynamics', sampleRate, { ...config, kneeDb: 12 }), kneeSignal);
    expect(softKnee.at(-1)).toBeLessThan((hardKnee.at(-1) ?? 0) - 0.004);
    expect(softKnee.every(Number.isFinite)).toBe(true);
  });

  it('honors attack/release timing, RMS detection, level, and bounded transient gain', () => {
    const sampleRate = 48000;
    const config = { mix: 1, thresholdDb: -20, ratio: 10, kneeDb: 0, dynamicsDetector: 'peak' as const };
    const hot = new Float32Array(24000).fill(1);
    const low = new Float32Array(9600).fill(0.25);
    const fast = new BrowserFxDspCore('dynamics', sampleRate, { ...config, attackMs: 1, releaseMs: 10 });
    const slow = new BrowserFxDspCore('dynamics', sampleRate, { ...config, attackMs: 100, releaseMs: 500 });
    const fastAttack = runMono(fast, hot.subarray(0, 256));
    const slowAttack = runMono(slow, hot.subarray(0, 256));
    expect(fastAttack[64] ?? 1).toBeLessThan(slowAttack[64] ?? 0);
    runMono(fast, hot.subarray(256));
    runMono(slow, hot.subarray(256));
    const fastRelease = runMono(fast, low);
    const slowRelease = runMono(slow, low);
    expect(fastRelease.at(-1)).toBeGreaterThan(slowRelease.at(-1) ?? 0);
    expect(fastRelease.every(Number.isFinite) && slowRelease.every(Number.isFinite)).toBe(true);

    const rmsInput = createTone(sampleRate, sampleRate, 1000, 0.8);
    const peakCore = new BrowserFxDspCore('dynamics', sampleRate, { ...config, attackMs: 1, releaseMs: 100, dynamicsDetector: 'peak' });
    const rmsCore = new BrowserFxDspCore('dynamics', sampleRate, { ...config, attackMs: 1, releaseMs: 100, dynamicsDetector: 'rms' });
    const peakOutput = runMono(peakCore, rmsInput);
    const rmsOutput = runMono(rmsCore, rmsInput);
    expect(sumEnergy(rmsOutput, 24000)).toBeLessThan(sumEnergy(peakOutput, 24000));

    const overshootInput = new Float32Array(24000).fill(2);
    const limiter = new BrowserFxDspCore('dynamics', sampleRate, { ...config, thresholdDb: -12, ratio: 20, attackMs: 0.1, releaseMs: 40 });
    const limited = runMono(limiter, overshootInput);
    expect(limited.every(Number.isFinite)).toBe(true);
    let peak = 0;
    for (const sample of limited) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeLessThanOrEqual(2.001);
  });

  it('implements SUSTAINER upward/downward transfer and hysteretic noise gating', () => {
    const sampleRate = 48000;
    const settledLevel = (level: number, parameters: { thresholdDb?: number; ratio?: number } = {}): number => {
      const rendered = runMono(new BrowserFxDspCore('sustainer', sampleRate, {
        mix: 1, thresholdDb: -24, ratio: 4, releaseMs: 180, outputDb: 0, ...parameters,
      }), new Float32Array(sampleRate / 5).fill(level));
      return rendered[rendered.length - 1] ?? 0;
    };

    const belowThreshold = settledLevel(0.03);
    const aboveThreshold = settledLevel(0.8);
    const unityRatio = settledLevel(0.03, { ratio: 1 });
    expect(belowThreshold).toBeGreaterThan(0.03); // upward compression
    expect(belowThreshold).toBeCloseTo(0.052, 2);
    expect(aboveThreshold).toBeLessThan(0.8); // downward compression
    expect(aboveThreshold).toBeCloseTo(0.119, 2);
    expect(unityRatio).toBeCloseTo(0.03, 5);

    const closedGate = runMono(new BrowserFxDspCore('sustainer', sampleRate, { mix: 1 }), new Float32Array(4800).fill(0.0001));
    const openGate = runMono(new BrowserFxDspCore('sustainer', sampleRate, { mix: 1 }), new Float32Array(4800).fill(0.02));
    expect(sumEnergy(closedGate, 2400)).toBeLessThan(1e-12);
    expect(sumEnergy(openGate, 2400)).toBeGreaterThan(0.1);

    const linkedLeft = new Float32Array(4800).fill(0.5);
    const linkedRight = new Float32Array(4800).fill(0.25);
    const linked = runStereo(new BrowserFxDspCore('sustainer', sampleRate, { mix: 1 }), linkedLeft, linkedRight);
    expect(linked.left[4799]).toBeCloseTo(2 * (linked.right[4799] ?? 0), 5);
  });

  it('uses the configured SUSTAINER release time and keeps the output limiter bounded', () => {
    const sampleRate = 48000;
    const highFrames = 24000;
    const lowFrames = 4800;
    const input = new Float32Array(highFrames + lowFrames);
    input.fill(0.8, 0, highFrames);
    input.fill(0.02, highFrames);
    const renderRelease = (releaseMs: number) => runMono(new BrowserFxDspCore('sustainer', sampleRate, {
      mix: 1, thresholdDb: -24, ratio: 4, releaseMs, outputDb: 0,
    }), input);
    const fastRelease = renderRelease(10);
    const slowRelease = renderRelease(1000);
    expect(fastRelease[highFrames + 960] ?? 0).toBeGreaterThan(slowRelease[highFrames + 960] ?? 0);

    const limited = runMono(new BrowserFxDspCore('sustainer', sampleRate, {
      mix: 1, thresholdDb: -24, ratio: 1, releaseMs: 180, outputDb: 12,
    }), new Float32Array(4096).fill(0.5));
    expect(limited.every((sample) => Math.abs(sample) <= 0.966051)).toBe(true);
    expect(Math.max(...limited)).toBeCloseTo(0.966051, 5);

    const limiterParameters = { mix: 1, thresholdDb: -24, ratio: 1, releaseMs: 180, outputDb: 12 };
    const linked = runStereo(new BrowserFxDspCore('sustainer', sampleRate, limiterParameters),
      new Float32Array(2048).fill(0.5), new Float32Array(2048).fill(0.1));
    expect(linked.left.at(-1)).toBeCloseTo(0.966051, 5);
    expect(linked.right.at(-1)).toBeCloseTo(0.2 * (linked.left.at(-1) ?? 0), 5);

    const releaseLeft = new Float32Array(1024 + 4800);
    const releaseRight = new Float32Array(releaseLeft.length);
    releaseLeft.fill(0.5, 0, 1024);
    releaseRight.fill(0.1, 0, 1024);
    releaseLeft.fill(0.1, 1024);
    releaseRight.fill(0.02, 1024);
    const released = runStereo(new BrowserFxDspCore('sustainer', sampleRate, limiterParameters), releaseLeft, releaseRight);
    expect(released.left[1024] ?? 1).toBeLessThan(0.3);
    expect(released.left.at(-1) ?? 0).toBeGreaterThan(released.left[1024] ?? 1);
    expect(released.left.at(-1) ?? 0).toBeLessThan(0.4);

    const hot = new Float32Array(4099).fill(0.5);
    const cold = new Float32Array(4099).fill(0.1);
    const whole = runStereo(new BrowserFxDspCore('sustainer', sampleRate, limiterParameters), hot, cold);
    const split = runStereo(new BrowserFxDspCore('sustainer', sampleRate, limiterParameters), hot, cold, [1, 7, 64, 127, 257, 3, 511]);
    expect(split.left).toEqual(whole.left);
    expect(split.right).toEqual(whole.right);

    const resetCore = new BrowserFxDspCore('sustainer', sampleRate, limiterParameters);
    const hotOutput = new Float32Array(256);
    const hotRightOutput = new Float32Array(256);
    resetCore.processBlock(new Float32Array(256).fill(0.5), new Float32Array(256).fill(0.1), hotOutput, hotRightOutput);
    resetCore.reset();
    const resetInput = new Float32Array(256).fill(0.1);
    const resetOutput = new Float32Array(256);
    const resetRight = new Float32Array(256);
    const freshOutput = new Float32Array(256);
    const freshRight = new Float32Array(256);
    resetCore.processBlock(resetInput, resetInput, resetOutput, resetRight);
    new BrowserFxDspCore('sustainer', sampleRate, limiterParameters).processBlock(resetInput, resetInput, freshOutput, freshRight);
    expect(resetOutput).toEqual(freshOutput);
    expect(resetRight).toEqual(freshRight);
  });

  it('is block-size invariant for SUSTAINER stereo detector and gate state', () => {
    const sampleRate = 48000;
    const inputLeft = createSignal(12017, sampleRate);
    const inputRight = createTone(12017, sampleRate, 1387, 0.18);
    const parameters = { mix: 1, thresholdDb: -26, ratio: 7, releaseMs: 430, outputDb: 3 };
    const whole = runStereo(new BrowserFxDspCore('sustainer', sampleRate, parameters), inputLeft, inputRight);
    const split = runStereo(new BrowserFxDspCore('sustainer', sampleRate, parameters), inputLeft, inputRight, [1, 7, 64, 127, 257, 3, 511]);
    expect(split.left).toEqual(whole.left);
    expect(split.right).toEqual(whole.right);
    expect(whole.left.every(Number.isFinite) && whole.right.every(Number.isFinite)).toBe(true);
  });

  it('produces exact fractional-delay impulse taps and a stable filtered feedback curve', () => {
    const sampleRate = 48000;
    const input = new Float32Array(sampleRate * 3);
    input[0] = 1;
    const first = new BrowserFxDspCore('delay', sampleRate, {
      mix: 1,
      delayTimeMs: 100,
      delayFeedback: 0.5,
      delayToneHz: 16000,
    });
    const firstEcho = runMono(first, input, [1, 127, 511, 64]);
    expect(firstEcho[0]).toBeCloseTo(0, 12);
    expect(firstEcho[4800]).toBeCloseTo(1, 5);
    expect(firstEcho[9600]).toBeGreaterThan(0.25);
    expect(firstEcho[9600]).toBeLessThan(firstEcho[4800] ?? 2);
    expect(firstEcho.every(Number.isFinite)).toBe(true);

    const otherTime = new BrowserFxDspCore('delay', sampleRate, {
      mix: 1,
      delayTimeMs: 250,
      delayFeedback: 0,
      delayToneHz: 8000,
      outputDb: 6,
    });
    const secondEcho = runMono(otherTime, input);
    expect(secondEcho[12000]).toBeCloseTo(2 ** (6 / 6.020599913), 4);
    expect(secondEcho[4800]).toBeCloseTo(0, 12);
    expect(secondEcho[12001]).toBeCloseTo(0, 12);
  });

  it('routes PANNING DELAY repeats with equal-power pan through the shared core', () => {
    const frames = 128;
    const inputLeft = new Float32Array(frames);
    const inputRight = new Float32Array(frames);
    inputLeft[0] = 1;
    const output = runStereo(new BrowserFxDspCore('panning-delay', 8000, {
      mix: 1,
      panningDelayTimeMs: 4,
      panningDelayFeedback: 0,
      panningDelayPan: 100,
    }), inputLeft, inputRight);

    expect(output.left.slice(0, 32).every((sample) => Math.abs(sample) < 1e-6)).toBe(true);
    expect(output.right.slice(0, 32).every((sample) => Math.abs(sample) < 1e-6)).toBe(true);
    expect(output.left[32]).toBeCloseTo(0, 6);
    expect(output.right[32]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(output.left.every(Number.isFinite) && output.right.every(Number.isFinite)).toBe(true);
  });

  it('bounds long feedback, has immediate zero-mix identity, and honors bypass', () => {
    const sampleRate = 48000;
    const longInput = new Float32Array(sampleRate * 5).fill(1);
    const saturated = new BrowserFxDspCore('delay', sampleRate, {
      mix: 1,
      delayTimeMs: 7.25,
      delayFeedback: 0.95,
      delayToneHz: 16000,
    });
    const output = runMono(saturated, longInput, [3, 127, 257, 511]);
    expect(output.every(Number.isFinite)).toBe(true);
    let peak = 0;
    for (const sample of output) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeLessThan(4);

    const input = new Float32Array([0.25, -0.5, 1, -1, 0.125, 0.875, -0.25]);
    const dry = new BrowserFxDspCore('delay', sampleRate, { mix: 0 });
    expect(runMono(dry, input)).toEqual(input);
    const bypassed = new BrowserFxDspCore('delay', sampleRate);
    bypassed.setBypass(true);
    expect(runMono(bypassed, input)).toEqual(input);
  });

  it('creates decorrelated multi-voice stereo chorus with wet/dry control and bounded feedback', () => {
    const sampleRate = 48000;
    const frames = sampleRate * 3;
    const tone = createTone(frames, sampleRate, 440, 0.5);
    const stereo = new BrowserFxDspCore('chorus', sampleRate, {
      mix: 1,
      chorusDelayMs: 15,
      chorusRateHz: 0.7,
      chorusDepthMs: 7,
      chorusVoices: 2,
      chorusFeedback: 0.35,
      chorusToneHz: 7000,
    });
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    stereo.processBlock(tone, tone, left, right, frames);
    expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true);
    expect(left).not.toEqual(right);
    expect(left.slice(sampleRate).some((sample) => Math.abs(sample) > 1e-4)).toBe(true);

    const fourVoice = new BrowserFxDspCore('chorus', sampleRate, {
      mix: 1,
      chorusDelayMs: 15,
      chorusRateHz: 0.7,
      chorusDepthMs: 7,
      chorusVoices: 4,
      chorusFeedback: 0.35,
      chorusToneHz: 7000,
    });
    expect(runMono(fourVoice, tone)).not.toEqual(left);

    const dry = new BrowserFxDspCore('chorus', sampleRate, { mix: 0 });
    expect(runMono(dry, tone.subarray(0, 256))).toEqual(tone.subarray(0, 256));
    const bypassed = new BrowserFxDspCore('chorus', sampleRate);
    bypassed.setBypass(true);
    expect(runMono(bypassed, tone.subarray(0, 256))).toEqual(tone.subarray(0, 256));

    const hot = new Float32Array(frames).fill(1);
    const extreme = new BrowserFxDspCore('chorus', sampleRate, {
      mix: 1,
      chorusDelayMs: 25,
      chorusRateHz: 9,
      chorusDepthMs: 20,
      chorusVoices: 4,
      chorusFeedback: 0.5,
      chorusToneHz: 16000,
    });
    const bounded = runMono(extreme, hot, [1, 127, 257, 511]);
    expect(bounded.every(Number.isFinite)).toBe(true);
    let peak = 0;
    for (const sample of bounded) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeLessThan(3);
  });

  it('clamps chorus controls to safe bounds without changing block behavior', () => {
    const sampleRate = 48000;
    const input = createTone(16384, sampleRate, 733, 0.6);
    const bounded = new BrowserFxDspCore('chorus', sampleRate, {
      mix: 1,
      chorusDelayMs: 30,
      chorusRateHz: 10,
      chorusDepthMs: 20,
      chorusVoices: 4,
      chorusFeedback: 0.5,
      chorusToneHz: 16000,
    });
    const outOfRange = new BrowserFxDspCore('chorus', sampleRate, {
      mix: 1,
      chorusDelayMs: 300,
      chorusRateHz: 100,
      chorusDepthMs: 200,
      chorusVoices: 40,
      chorusFeedback: 10,
      chorusToneHz: 160000,
    });
    expect(runMono(outOfRange, input)).toEqual(runMono(bounded, input));
  });

  it('sweeps real four/eight-stage phaser notches with stereo offset and stable feedback', () => {
    const sampleRate = 48000;
    const seconds = 2;
    const frames = sampleRate * seconds;
    const frequencies = [180, 300, 500, 800, 1200, 1800, 2600, 3800, 5200];
    const response: number[] = [];
    for (const frequency of frequencies) {
      const tone = createTone(frames, sampleRate, frequency, 0.5);
      const core = new BrowserFxDspCore('phaser', sampleRate, {
        mix: 1,
        phaserRateHz: 0.5,
        phaserDepth: 0,
        phaserFeedback: 0,
        phaserStages: 8,
      });
      response.push(toneMagnitude(runMono(core, tone), sampleRate, frequency, sampleRate, frames));
    }
    const minimumResponse = Math.min(...response);
    const maximumResponse = Math.max(...response);
    expect(maximumResponse).toBeGreaterThan(0.2);
    expect(minimumResponse).toBeLessThan(maximumResponse * 0.35);

    const sweepTone = createTone(frames, sampleRate, 733, 0.5);
    const staticOutput = runMono(new BrowserFxDspCore('phaser', sampleRate, {
      mix: 1,
      phaserRateHz: 0.5,
      phaserDepth: 0,
      phaserStages: 8,
    }), sweepTone);
    const sweptCore = new BrowserFxDspCore('phaser', sampleRate, {
      mix: 1,
      phaserRateHz: 2.5,
      phaserDepth: 1,
      phaserStages: 8,
    });
    const sweptOutput = runMono(sweptCore, sweepTone, [1, 127, 257, 64, 511]);
    expect(sweptOutput).not.toEqual(staticOutput);
    expect(sweptOutput.every(Number.isFinite)).toBe(true);

    const stereoCore = new BrowserFxDspCore('phaser', sampleRate, {
      mix: 1,
      phaserRateHz: 0.7,
      phaserDepth: 0.9,
      phaserFeedback: 0.2,
      phaserStages: 4,
    });
    const stereoLeft = new Float32Array(frames);
    const stereoRight = new Float32Array(frames);
    stereoCore.processBlock(sweepTone, sweepTone, stereoLeft, stereoRight);
    expect(stereoLeft).not.toEqual(stereoRight);
    expect(stereoLeft.every(Number.isFinite) && stereoRight.every(Number.isFinite)).toBe(true);

    const impulse = new Float32Array(frames);
    impulse[0] = 1;
    const extremeFeedback = new BrowserFxDspCore('phaser', sampleRate, {
      mix: 1,
      phaserRateHz: 12,
      phaserDepth: 1,
      phaserFeedback: 0.95,
      phaserStages: 8,
    });
    const tail = runMono(extremeFeedback, impulse, [3, 127, 511, 64]);
    expect(tail.every(Number.isFinite)).toBe(true);
    let peak = 0;
    for (const sample of tail) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeLessThan(8);
    expect(extremeFeedback.nonFiniteOutputSamples).toBe(0);

    const dry = new BrowserFxDspCore('phaser', sampleRate, { mix: 0 });
    expect(runMono(dry, sweepTone.subarray(0, 257))).toEqual(sweepTone.subarray(0, 257));
    const bypassed = new BrowserFxDspCore('phaser', sampleRate);
    bypassed.setBypass(true);
    expect(runMono(bypassed, sweepTone.subarray(0, 257))).toEqual(sweepTone.subarray(0, 257));
  }, 15_000);

  it('clamps phaser parameters to 4/8 stages and stays invariant across arbitrary callback quanta', () => {
    const sampleRate = 44100;
    const input = createTone(32771, sampleRate, 911, 0.7);
    const bounded = new BrowserFxDspCore('phaser', sampleRate, {
      mix: 1,
      phaserRateHz: 20,
      phaserDepth: 1,
      phaserFeedback: 0.95,
      phaserStages: 8,
    });
    const clamped = new BrowserFxDspCore('phaser', sampleRate, {
      mix: 1,
      phaserRateHz: 200,
      phaserDepth: 4,
      phaserFeedback: 2,
      phaserStages: 12,
    });
    expect(runMono(clamped, input)).toEqual(runMono(bounded, input));

    const whole = runMono(new BrowserFxDspCore('phaser', sampleRate, {
      mix: 1,
      phaserRateHz: 0.85,
      phaserDepth: 0.75,
      phaserFeedback: 0.4,
      phaserStages: 4,
    }), input);
    const segmentedCore = new BrowserFxDspCore('phaser', sampleRate, {
      mix: 1,
      phaserRateHz: 0.85,
      phaserDepth: 0.75,
      phaserFeedback: 0.4,
      phaserStages: 4,
    });
    const segmented = runMono(segmentedCore, input, [1, 7, 64, 127, 257, 3, 511]);
    expect(segmented).toEqual(whole);
    expect(segmentedCore.framesProcessed).toBe(input.length);

    const eightStages = runMono(new BrowserFxDspCore('phaser', sampleRate, {
      mix: 1,
      phaserRateHz: 0.85,
      phaserDepth: 0.75,
      phaserFeedback: 0.4,
      phaserStages: 8,
    }), input);
    expect(eightStages).not.toEqual(whole);

    const reconfigured = new BrowserFxDspCore('phaser', sampleRate, {
      mix: 1,
      phaserRateHz: 0.5,
      phaserDepth: 0.2,
      phaserFeedback: 0.1,
    });
    const firstHalf = input.subarray(0, 4096);
    runMono(reconfigured, firstHalf);
    reconfigured.setParameters({ phaserRateHz: 8, phaserDepth: 1, phaserFeedback: 0.8, phaserStages: 4 });
    const secondHalfOutput = runMono(reconfigured, input.subarray(4096, 8192), [7, 64, 1, 127]);
    expect(secondHalfOutput.every(Number.isFinite)).toBe(true);
  });

  it('modulates amplitude with sine, triangle, and band-limited square tremolo waveforms', () => {
    const sampleRate = 48000;
    const frames = sampleRate * 2;
    const steady = new Float32Array(frames).fill(0.5);
    const sineCore = new BrowserFxDspCore('tremolo', sampleRate, {
      mix: 1,
      tremoloRateHz: 4,
      tremoloDepth: 1,
      tremoloWaveform: 'sine',
    });
    const sine = runMono(sineCore, steady, [1, 63, 127, 257, 511]);
    expect(sine.every(Number.isFinite)).toBe(true);
    let sineMinimum = Number.POSITIVE_INFINITY;
    let sineMaximum = Number.NEGATIVE_INFINITY;
    for (const sample of sine) {
      sineMinimum = Math.min(sineMinimum, sample);
      sineMaximum = Math.max(sineMaximum, sample);
    }
    expect(sineMinimum).toBeLessThan(0.01);
    expect(sineMaximum).toBeCloseTo(0.5, 3);
    expect(sine.every((sample) => sample >= -1e-6 && sample <= 0.500001)).toBe(true);

    const triangle = runMono(new BrowserFxDspCore('tremolo', sampleRate, {
      mix: 1,
      tremoloRateHz: 4,
      tremoloDepth: 1,
      tremoloWaveform: 'triangle',
    }), steady);
    const square = runMono(new BrowserFxDspCore('tremolo', sampleRate, {
      mix: 1,
      tremoloRateHz: 4,
      tremoloDepth: 1,
      tremoloWaveform: 'square',
    }), steady);
    expect(triangle).not.toEqual(sine);
    expect(square).not.toEqual(triangle);
    for (const output of [triangle, square]) {
      expect(output.every(Number.isFinite)).toBe(true);
      expect(output.every((sample) => sample >= -1e-6 && sample <= 0.500001)).toBe(true);
    }

    const dryInput = createTone(257, sampleRate, 733, 0.7);
    const zeroDepth = new BrowserFxDspCore('tremolo', sampleRate, { mix: 1, tremoloDepth: 0 });
    expect(runMono(zeroDepth, dryInput)).toEqual(dryInput);
    const zeroMix = new BrowserFxDspCore('tremolo', sampleRate, { mix: 0, tremoloDepth: 1 });
    expect(runMono(zeroMix, dryInput)).toEqual(dryInput);
    const bypassed = new BrowserFxDspCore('tremolo', sampleRate, { mix: 1, tremoloDepth: 1 });
    bypassed.setBypass(true);
    expect(runMono(bypassed, dryInput)).toEqual(dryInput);
  });

  it('keeps tremolo rate/depth updates bounded and invariant across arbitrary block segmentation', () => {
    const sampleRate = 44100;
    const input = createTone(44117, sampleRate, 911, 0.8);
    const parameters = { mix: 1, tremoloRateHz: 7.3, tremoloDepth: 0.82, tremoloWaveform: 'square' as const };
    const whole = runMono(new BrowserFxDspCore('tremolo', sampleRate, parameters), input);
    const segmented = runMono(new BrowserFxDspCore('tremolo', sampleRate, parameters), input, [1, 7, 64, 127, 257, 3, 511]);
    expect(segmented).toEqual(whole);

    const bounded = new BrowserFxDspCore('tremolo', sampleRate, {
      mix: 1,
      tremoloRateHz: 20,
      tremoloDepth: 1,
      tremoloWaveform: 'sine',
    });
    const outOfRange = new BrowserFxDspCore('tremolo', sampleRate, {
      mix: 1,
      tremoloRateHz: 200,
      tremoloDepth: 3,
      tremoloWaveform: 'invalid' as 'sine',
    });
    expect(runMono(outOfRange, input)).toEqual(runMono(bounded, input));

    const reconfigured = new BrowserFxDspCore('tremolo', sampleRate, { mix: 1, tremoloRateHz: 0.2, tremoloDepth: 0.2 });
    runMono(reconfigured, input.subarray(0, 2048));
    reconfigured.setParameters({ tremoloRateHz: 15, tremoloDepth: 1, tremoloWaveform: 'triangle' });
    const updated = runMono(reconfigured, input.subarray(2048, 4096), [1, 7, 64, 257]);
    expect(updated.every(Number.isFinite)).toBe(true);
    expect(updated.every((sample) => Math.abs(sample) <= 0.800001)).toBe(true);
  });

  it('implements equal-power mono autopan and independent stereo mid/side behavior', () => {
    const sampleRate = 48000;
    const frames = sampleRate;
    const mono = new Float32Array(frames).fill(0.4);
    const monoCore = new BrowserFxDspCore('auto-pan', sampleRate, {
      mix: 1,
      autoPanRateHz: 2,
      autoPanDepth: 1,
      autoPanWaveform: 'sine',
    });
    const monoLeft = new Float32Array(frames);
    const monoRight = new Float32Array(frames);
    monoCore.processBlock(mono, null, monoLeft, monoRight);
    expect(monoLeft.every(Number.isFinite) && monoRight.every(Number.isFinite)).toBe(true);
    expect(monoLeft).not.toEqual(monoRight);
    let maximumMonoEnergyError = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const energy = (monoLeft[frame] ?? 0) ** 2 + (monoRight[frame] ?? 0) ** 2;
      maximumMonoEnergyError = Math.max(maximumMonoEnergyError, Math.abs(energy - 0.16));
    }
    expect(maximumMonoEnergyError).toBeLessThan(1e-6);
    expect(monoLeft.some((sample) => Math.abs(sample) < 1e-4)).toBe(true);
    expect(monoRight.some((sample) => Math.abs(sample) < 1e-4)).toBe(true);

    const inputLeft = createTone(frames, sampleRate, 220, 0.6);
    const inputRight = createTone(frames, sampleRate, 440, 0.3);
    const centered = new BrowserFxDspCore('auto-pan', sampleRate, {
      mix: 1,
      autoPanRateHz: 1,
      autoPanDepth: 0,
    });
    const centeredLeft = new Float32Array(frames);
    const centeredRight = new Float32Array(frames);
    centered.processBlock(inputLeft, inputRight, centeredLeft, centeredRight);
    let maximumCenteredChannelError = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      maximumCenteredChannelError = Math.max(maximumCenteredChannelError,
        Math.abs((centeredLeft[frame] ?? 0) - (inputLeft[frame] ?? 0)),
        Math.abs((centeredRight[frame] ?? 0) - (inputRight[frame] ?? 0)));
    }
    expect(maximumCenteredChannelError).toBeLessThan(1e-6);

    const stereoPan = new BrowserFxDspCore('auto-pan', sampleRate, {
      mix: 1,
      autoPanRateHz: 1.3,
      autoPanDepth: 0.8,
      autoPanWaveform: 'triangle',
    });
    const pannedLeft = new Float32Array(frames);
    const pannedRight = new Float32Array(frames);
    stereoPan.processBlock(inputLeft, inputRight, pannedLeft, pannedRight);
    expect(pannedLeft).not.toEqual(centeredLeft);
    expect(pannedRight).not.toEqual(centeredRight);
    expect(pannedLeft.every(Number.isFinite) && pannedRight.every(Number.isFinite)).toBe(true);
    let stereoPeak = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      stereoPeak = Math.max(stereoPeak, Math.abs(pannedLeft[frame] ?? 0), Math.abs(pannedRight[frame] ?? 0));
    }
    expect(stereoPeak).toBeLessThan(1.2);

    const dryLeft = new Float32Array(64);
    const dryRight = new Float32Array(64);
    const shortMono = mono.subarray(0, 64);
    new BrowserFxDspCore('auto-pan', sampleRate, { mix: 0 }).processBlock(shortMono, null, dryLeft, dryRight);
    expect(dryLeft).toEqual(shortMono);
    expect(dryRight).toEqual(shortMono);
    const bypass = new BrowserFxDspCore('auto-pan', sampleRate);
    bypass.setBypass(true);
    const bypassLeft = new Float32Array(64);
    const bypassRight = new Float32Array(64);
    bypass.processBlock(shortMono, null, bypassLeft, bypassRight);
    expect(bypassLeft).toEqual(shortMono);
    expect(bypassRight).toEqual(shortMono);
  });

  it('keeps autopan waveform/rate updates block-invariant and clamps unsafe controls', () => {
    const sampleRate = 44100;
    const input = createTone(44117, sampleRate, 733, 0.7);
    const parameters = { mix: 1, autoPanRateHz: 3.2, autoPanDepth: 0.9, autoPanWaveform: 'square' as const };
    const whole = runMono(new BrowserFxDspCore('auto-pan', sampleRate, parameters), input);
    const segmented = runMono(new BrowserFxDspCore('auto-pan', sampleRate, parameters), input, [1, 7, 64, 127, 257, 3, 511]);
    expect(segmented).toEqual(whole);

    const bounded = new BrowserFxDspCore('auto-pan', sampleRate, {
      mix: 1,
      autoPanRateHz: 20,
      autoPanDepth: 1,
      autoPanWaveform: 'sine',
    });
    const outOfRange = new BrowserFxDspCore('auto-pan', sampleRate, {
      mix: 1,
      autoPanRateHz: 200,
      autoPanDepth: 3,
      autoPanWaveform: 'invalid' as 'sine',
    });
    expect(runMono(outOfRange, input)).toEqual(runMono(bounded, input));

    const reconfigured = new BrowserFxDspCore('auto-pan', sampleRate, { mix: 1, autoPanRateHz: 0.2, autoPanDepth: 0.2 });
    runMono(reconfigured, input.subarray(0, 2048));
    reconfigured.setParameters({ autoPanRateHz: 15, autoPanDepth: 1, autoPanWaveform: 'square' });
    const updated = runMono(reconfigured, input.subarray(2048, 4096), [1, 7, 64, 257]);
    expect(updated.every(Number.isFinite)).toBe(true);
  });

  it('implements deterministic Lo-Fi sample-rate hold and bit reduction across variable blocks', () => {
    const sampleRate = 48000;
    const length = 48000 + 117;
    const left = createTone(length, sampleRate, 733, 0.7);
    const right = createTone(length, sampleRate, 1103, 0.5);
    const parameters = { mix: 1, loFiBitDepth: 8, loFiSampleRateHz: 6000, loFiFilterHz: 18000 };
    const whole = runStereo(new BrowserFxDspCore('lo-fi', sampleRate, parameters), left, right);
    const segmented = runStereo(
      new BrowserFxDspCore('lo-fi', sampleRate, parameters),
      left,
      right,
      [1, 7, 64, 127, 257, 3, 511],
    );

    expect(segmented.left).toEqual(whole.left);
    expect(segmented.right).toEqual(whole.right);
    expect(whole.left).not.toEqual(left);
    expect(whole.right).not.toEqual(right);
    expect(whole.left.every(Number.isFinite) && whole.right.every(Number.isFinite)).toBe(true);

    const otherSettings = runStereo(new BrowserFxDspCore('lo-fi', sampleRate, {
      mix: 1, loFiBitDepth: 20, loFiSampleRateHz: 24000, loFiFilterHz: 20000,
    }), left, right);
    expect(otherSettings.left).not.toEqual(whole.left);
  });

  it('implements four-band EQ boost/cut controls and keeps the cascade block-invariant', () => {
    const sampleRate = 48000;
    const frames = sampleRate;
    const low = createTone(frames, sampleRate, 60, 0.3);
    const high = createTone(frames, sampleRate, 10000, 0.3);
    const neutral = runMono(new BrowserFxDspCore('eq', sampleRate, { mix: 1 }), low);
    const lowBoost = runMono(new BrowserFxDspCore('eq', sampleRate, {
      mix: 1, eqLowFrequencyHz: 180, eqLowGainDb: 12,
    }), low);
    const highCut = runMono(new BrowserFxDspCore('eq', sampleRate, {
      mix: 1, eqHighFrequencyHz: 6000, eqHighGainDb: -12,
    }), high);
    expect(sumEnergy(neutral, 8192)).toBeCloseTo(sumEnergy(low, 8192), 3);
    expect(sumEnergy(lowBoost, 8192)).toBeGreaterThan(sumEnergy(low, 8192) * 3);
    expect(sumEnergy(highCut, 8192)).toBeLessThan(sumEnergy(high, 8192) * 0.3);

    const broadband = createSignal(24017, sampleRate);
    const parameters = { mix: 1, eqLowGainDb: 4, eqMid1GainDb: -6, eqMid1Q: 1.4, eqHighGainDb: 3 };
    const whole = runMono(new BrowserFxDspCore('eq', sampleRate, parameters), broadband);
    const segmented = runMono(new BrowserFxDspCore('eq', sampleRate, parameters), broadband, [1, 7, 64, 127, 257, 3, 511]);
    expect(segmented).toEqual(whole);
    expect(whole.every(Number.isFinite)).toBe(true);
  });

  it('pans mono input with equal-power gains and preserves center/edge behavior across blocks', () => {
    const sampleRate = 48000;
    const input = new Float32Array(12017).fill(0.35);
    const renderPan = (position: number, blocks?: readonly number[]) => {
      const core = new BrowserFxDspCore('manual-pan', sampleRate, { mix: 1, manualPanPosition: position });
      const left = new Float32Array(input.length);
      const right = new Float32Array(input.length);
      let offset = 0;
      let block = 0;
      while (offset < input.length) {
        const count = Math.min(blocks?.[block % blocks.length] ?? input.length, input.length - offset);
        core.processBlock(input.subarray(offset, offset + count), null, left.subarray(offset, offset + count), right.subarray(offset, offset + count), count);
        offset += count;
        block += 1;
      }
      return { left, right };
    };
    const center = renderPan(0);
    const left = renderPan(-1);
    const right = renderPan(1);
    const segmentedCenter = renderPan(0, [1, 7, 64, 127, 257, 3, 511]);
    expect(segmentedCenter.left).toEqual(center.left);
    expect(segmentedCenter.right).toEqual(center.right);
    expect(center.left.every((sample) => Math.abs(sample - 0.35 / Math.SQRT2) < 1e-6)).toBe(true);
    expect(center.right).toEqual(center.left);
    expect(left.left).toEqual(input);
    expect(left.right.every((sample) => Math.abs(sample) < 1e-7)).toBe(true);
    expect(right.left.every((sample) => Math.abs(sample) < 1e-7)).toBe(true);
    expect(right.right).toEqual(input);
  });
});
