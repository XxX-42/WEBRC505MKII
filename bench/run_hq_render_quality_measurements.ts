/**
 * Deterministic objective measurement harness for Signalsmith HQ_RENDER.
 *
 * This is a synthetic regression/measurement fixture, not a listening test,
 * quality-acceptance gate, device/hardware benchmark, or Roland comparison.
 * It calls the production renderPitchOffline adapter and writes raw metrics.
 *
 * Run from WEBRC505MKII with:
 *   ./node_modules/.bin/vite-node bench/run_hq_render_quality_measurements.ts
 * Override the JSON destination with HQ_RENDER_MEASUREMENTS_OUTPUT=/path/file.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { platform, arch, release } from 'node:os';
import { renderPitchOffline } from '../src/audio/pitch/signalsmith';

const SAMPLE_RATES = [44_100, 48_000] as const;
const SHIFT_SEMITONES = 7;
const SHIFT_RATIO = 2 ** (SHIFT_SEMITONES / 12);
const DURATION_SECONDS = 2.4;
const ANALYSIS_START_SECONDS = 0.55;
const ANALYSIS_DURATION_SECONDS = 1.0;
const REPORT_PATH = resolve(process.env.HQ_RENDER_MEASUREMENTS_OUTPUT ?? 'bench/results/hq_render_quality_measurements_2026-10-17.json');

type Spectrum = { readonly binHz: number; readonly power: Float64Array };

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function fftInPlace(real: Float64Array, imaginary: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j]!, real[i]!];
      [imaginary[i], imaginary[j]] = [imaginary[j]!, imaginary[i]!];
    }
  }
  for (let length = 2; length <= n; length *= 2) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      const half = length / 2;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = real[odd]! * twiddleReal - imaginary[odd]! * twiddleImaginary;
        const oddImaginary = real[odd]! * twiddleImaginary + imaginary[odd]! * twiddleReal;
        const evenReal = real[even]!;
        const evenImaginary = imaginary[even]!;
        real[even] = evenReal + oddReal;
        imaginary[even] = evenImaginary + oddImaginary;
        real[odd] = evenReal - oddReal;
        imaginary[odd] = evenImaginary - oddImaginary;
        const nextTwiddleReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }
}

function spectrumOf(signal: Float32Array, start: number, length: number, sampleRate: number): Spectrum {
  if (start < 0 || length < 2 || start + length > signal.length) throw new RangeError('spectrum window is outside the signal');
  const n = nextPowerOfTwo(length);
  const real = new Float64Array(n);
  const imaginary = new Float64Array(n);
  for (let i = 0; i < length; i += 1) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    real[i] = signal[start + i]! * hann;
  }
  fftInPlace(real, imaginary);
  const power = new Float64Array(n / 2 + 1);
  for (let i = 0; i < power.length; i += 1) power[i] = real[i]! * real[i]! + imaginary[i]! * imaginary[i]!;
  return { binHz: sampleRate / n, power };
}

function peakFrequency(spectrum: Spectrum, lowHz: number, highHz: number): number {
  const lowBin = Math.max(1, Math.ceil(lowHz / spectrum.binHz));
  const highBin = Math.min(spectrum.power.length - 2, Math.floor(highHz / spectrum.binHz));
  let best = lowBin;
  for (let bin = lowBin + 1; bin <= highBin; bin += 1) {
    if (spectrum.power[bin]! > spectrum.power[best]!) best = bin;
  }
  const left = Math.log(Math.max(spectrum.power[best - 1]!, 1e-300));
  const center = Math.log(Math.max(spectrum.power[best]!, 1e-300));
  const right = Math.log(Math.max(spectrum.power[best + 1]!, 1e-300));
  const denominator = left - 2 * center + right;
  const correction = denominator === 0 ? 0 : 0.5 * (left - right) / denominator;
  return (best + Math.max(-0.5, Math.min(0.5, correction))) * spectrum.binHz;
}

function harmonicSignal(sampleRate: number, duration: number, fundamentalHz: number, phaseOffset = 0): Float32Array {
  const frames = Math.round(sampleRate * duration);
  const signal = new Float32Array(frames);
  const amplitudes = [1, 0.54, 0.33, 0.22, 0.15, 0.11, 0.08];
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / sampleRate;
    const fade = Math.min(1, time / 0.04, (duration - time) / 0.04);
    let value = 0;
    for (let harmonic = 1; harmonic <= amplitudes.length; harmonic += 1) {
      const phase = phaseOffset + harmonic * 0.19 + harmonic * harmonic * 0.013;
      value += amplitudes[harmonic - 1]! * Math.sin(2 * Math.PI * fundamentalHz * harmonic * time + phase);
    }
    signal[frame] = 0.18 * Math.max(0, fade) * value;
  }
  return signal;
}

function vowelLikeSignal(sampleRate: number, duration: number, fundamentalHz: number): Float32Array {
  const frames = Math.round(sampleRate * duration);
  const signal = new Float32Array(frames);
  const formants = [
    { centerHz: 650, sigmaHz: 105, weight: 1.0 },
    { centerHz: 1_200, sigmaHz: 155, weight: 0.82 },
    { centerHz: 2_500, sigmaHz: 235, weight: 0.58 },
  ];
  const maxHarmonic = Math.floor((sampleRate * 0.46) / fundamentalHz);
  const amps = new Float64Array(maxHarmonic + 1);
  for (let harmonic = 1; harmonic <= maxHarmonic; harmonic += 1) {
    const frequency = harmonic * fundamentalHz;
    let envelope = 0;
    for (const formant of formants) {
      const normalized = (frequency - formant.centerHz) / formant.sigmaHz;
      envelope += formant.weight * Math.exp(-0.5 * normalized * normalized);
    }
    amps[harmonic] = envelope / Math.sqrt(harmonic);
  }
  const phaseFor = (harmonic: number) => harmonic * 0.17 + harmonic * harmonic * 0.007;
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / sampleRate;
    const fade = Math.max(0, Math.min(1, time / 0.04, (duration - time) / 0.04));
    let value = 0;
    for (let harmonic = 1; harmonic <= maxHarmonic; harmonic += 1) {
      value += amps[harmonic]! * Math.sin(2 * Math.PI * harmonic * fundamentalHz * time + phaseFor(harmonic));
    }
    signal[frame] = 0.35 * fade * value;
  }
  return signal;
}

function transientSignal(sampleRate: number, duration: number, startSeconds: number): Float32Array {
  const signal = new Float32Array(Math.round(sampleRate * duration));
  const start = Math.round(sampleRate * startSeconds);
  const burstFrames = Math.round(sampleRate * 0.018);
  const frequencies = [2_300, 3_700, 6_100, 8_900];
  const phases = [0.31, 1.22, 2.09, 0.73];
  for (let frame = 0; frame < burstFrames && start + frame < signal.length; frame += 1) {
    const time = frame / sampleRate;
    const decay = Math.exp(-time / 0.0045);
    let value = 0;
    for (let partial = 0; partial < frequencies.length; partial += 1) {
      value += Math.sin(2 * Math.PI * frequencies[partial]! * time + phases[partial]!) / frequencies.length;
    }
    signal[start + frame] = 0.8 * decay * value;
  }
  return signal;
}

function stereoCorrelation(left: Float32Array, right: Float32Array, start: number, length: number): number {
  let leftMean = 0;
  let rightMean = 0;
  for (let i = start; i < start + length; i += 1) {
    leftMean += left[i]!;
    rightMean += right[i]!;
  }
  leftMean /= length;
  rightMean /= length;
  let cross = 0;
  let leftPower = 0;
  let rightPower = 0;
  for (let i = start; i < start + length; i += 1) {
    const l = left[i]! - leftMean;
    const r = right[i]! - rightMean;
    cross += l * r;
    leftPower += l * l;
    rightPower += r * r;
  }
  return cross / Math.sqrt(leftPower * rightPower);
}

function transientMetrics(input: Float32Array, output: Float32Array, sampleRate: number, clickStart: number, latency: number) {
  const halfWindow = Math.round(sampleRate * 0.12);
  const inputStart = Math.max(0, clickStart - halfWindow);
  const outputExpectedStart = latency + clickStart;
  const outputStart = Math.max(0, outputExpectedStart - halfWindow);
  const length = Math.min(input.length - inputStart, output.length - outputStart, 2 * halfWindow);
  let inputWeightedIndex = 0;
  let outputWeightedIndex = 0;
  let inputEnergy = 0;
  let outputEnergy = 0;
  let inputPeak = 0;
  let outputPeak = 0;
  let outputPeakIndex = outputStart;
  for (let offset = 0; offset < length; offset += 1) {
    const x = input[inputStart + offset]!;
    const y = output[outputStart + offset]!;
    const ex = x * x;
    const ey = y * y;
    inputEnergy += ex;
    outputEnergy += ey;
    inputWeightedIndex += (inputStart + offset) * ex;
    outputWeightedIndex += (outputStart + offset) * ey;
    if (Math.abs(x) > inputPeak) inputPeak = Math.abs(x);
    if (Math.abs(y) > outputPeak) {
      outputPeak = Math.abs(y);
      outputPeakIndex = outputStart + offset;
    }
  }
  const inputCentroid = inputWeightedIndex / inputEnergy;
  const outputCentroid = outputWeightedIndex / outputEnergy;
  return {
    roiHalfWidthMs: 120,
    inputEnergyCentroidSeconds: inputCentroid / sampleRate,
    outputEnergyCentroidSecondsAfterLatencyRemoval: (outputCentroid - latency) / sampleRate,
    energyCentroidAlignmentErrorMs: 1_000 * (outputCentroid - latency - inputCentroid) / sampleRate,
    outputPeakOffsetFromTransientOnsetMs: 1_000 * (outputPeakIndex - latency - clickStart) / sampleRate,
    transientPeakAbsRatio: outputPeak / inputPeak,
    inputRmsInRoi: Math.sqrt(inputEnergy / length),
    outputRmsInRoi: Math.sqrt(outputEnergy / length),
  };
}

function bandPower(spectrum: Spectrum, sampleRate: number, lowHz: number, highHz: number): number {
  const low = Math.max(0, Math.ceil(lowHz / spectrum.binHz));
  const high = Math.min(spectrum.power.length - 1, Math.floor(highHz / spectrum.binHz));
  let sum = 0;
  for (let bin = low; bin <= high; bin += 1) sum += spectrum.power[bin]!;
  return sum * spectrum.binHz / sampleRate;
}

function centsBetween(measuredHz: number, expectedHz: number): number {
  return 1_200 * Math.log2(measuredHz / expectedHz);
}

async function render(input: readonly Float32Array[], sampleRate: number) {
  return renderPitchOffline(input, {
    mode: 'HQ_RENDER',
    sampleRate,
    semitones: SHIFT_SEMITONES,
    playbackRate: 1,
    chunkFrames: 128,
  });
}

async function runRate(sampleRate: number) {
  const duration = DURATION_SECONDS;
  const analysisStart = Math.round(sampleRate * ANALYSIS_START_SECONDS);
  const analysisLength = Math.round(sampleRate * ANALYSIS_DURATION_SECONDS);
  const sourceF0 = 220;
  const expectedF0 = sourceF0 * SHIFT_RATIO;
  const tone = harmonicSignal(sampleRate, duration, sourceF0);
  const toneRender = await render([tone], sampleRate);
  const toneSpectrum = spectrumOf(toneRender.channels[0]!, toneRender.leadingLatencySamples + analysisStart, analysisLength, sampleRate);
  const outputPitchHz = peakFrequency(toneSpectrum, expectedF0 * 0.78, expectedF0 * 1.22);
  const f0Result = {
    inputFundamentalHz: sourceF0,
    shiftSemitones: SHIFT_SEMITONES,
    expectedOutputFundamentalHz: expectedF0,
    measuredDominantFundamentalHz: outputPitchHz,
    signedCentsError: centsBetween(outputPitchHz, expectedF0),
    analysisWindow: { startSecondsAfterLatencyRemoval: ANALYSIS_START_SECONDS, durationSeconds: ANALYSIS_DURATION_SECONDS, fftSize: toneSpectrum.power.length - 1, window: 'Hann', peakEstimator: 'largest FFT power bin in +/-22% target range with parabolic interpolation of log power' },
    renderLatencySamples: toneRender.leadingLatencySamples,
  };

  const clickStartSeconds = 0.8;
  const clickStart = Math.round(sampleRate * clickStartSeconds);
  const click = transientSignal(sampleRate, duration, clickStartSeconds);
  const clickRender = await render([click], sampleRate);
  const transient = transientMetrics(click, clickRender.channels[0]!, sampleRate, clickStart, clickRender.leadingLatencySamples);

  const stereoLeft = harmonicSignal(sampleRate, duration, 220, 0.0);
  const stereoRight = harmonicSignal(sampleRate, duration, 220, 0.92);
  const stereoRender = await render([stereoLeft, stereoRight], sampleRate);
  const stereoStart = stereoRender.leadingLatencySamples + analysisStart;
  const stereo = {
    inputZeroLagPearsonCorrelation: stereoCorrelation(stereoLeft, stereoRight, analysisStart, analysisLength),
    outputZeroLagPearsonCorrelation: stereoCorrelation(stereoRender.channels[0]!, stereoRender.channels[1]!, stereoStart, analysisLength),
    deltaCorrelation: stereoCorrelation(stereoRender.channels[0]!, stereoRender.channels[1]!, stereoStart, analysisLength)
      - stereoCorrelation(stereoLeft, stereoRight, analysisStart, analysisLength),
    note: 'Pearson correlation is measured without additional lag search over the aligned steady-state window; both channels are the same harmonic template with a fixed 0.92 rad phase offset.'
  };

  const vowelF0 = 110;
  const vowel = vowelLikeSignal(sampleRate, duration, vowelF0);
  const vowelRender = await render([vowel], sampleRate);
  const inputVowelSpectrum = spectrumOf(vowel, analysisStart, analysisLength, sampleRate);
  const outputVowelSpectrum = spectrumOf(vowelRender.channels[0]!, vowelRender.leadingLatencySamples + analysisStart, analysisLength, sampleRate);
  const nominalFormants = [650, 1_200, 2_500];
  const formantMovement = nominalFormants.map((centerHz, index) => {
    const targetHz = centerHz * SHIFT_RATIO;
    const bandFraction = 0.18;
    const sourcePowerIn = bandPower(inputVowelSpectrum, sampleRate, centerHz * (1 - bandFraction), centerHz * (1 + bandFraction));
    const targetPowerIn = bandPower(inputVowelSpectrum, sampleRate, targetHz * (1 - bandFraction), targetHz * (1 + bandFraction));
    const sourcePowerOut = bandPower(outputVowelSpectrum, sampleRate, centerHz * (1 - bandFraction), centerHz * (1 + bandFraction));
    const targetPowerOut = bandPower(outputVowelSpectrum, sampleRate, targetHz * (1 - bandFraction), targetHz * (1 + bandFraction));
    const inputTargetVsSourceDb = 10 * Math.log10(Math.max(1e-300, targetPowerIn) / Math.max(1e-300, sourcePowerIn));
    const outputTargetVsSourceDb = 10 * Math.log10(Math.max(1e-300, targetPowerOut) / Math.max(1e-300, sourcePowerOut));
    return {
      formantBand: index + 1,
      inputNominalCenterHz: centerHz,
      targetShiftedCenterHz: targetHz,
      sourceBandHz: [centerHz * (1 - bandFraction), centerHz * (1 + bandFraction)],
      shiftedBandHz: [targetHz * (1 - bandFraction), targetHz * (1 + bandFraction)],
      inputTargetVsSourceBandPowerDb: inputTargetVsSourceDb,
      outputTargetVsSourceBandPowerDb: outputTargetVsSourceDb,
      changeTowardShiftedBandDb: outputTargetVsSourceDb - inputTargetVsSourceDb,
      interpretation: 'Positive change means relatively more energy in the pitch-shifted band than the unshifted source band; it is not a formant-preservation score.'
    };
  });

  return {
    sampleRate,
    sampleCountPerInputChannel: Math.round(sampleRate * duration),
    renderer: {
      mode: 'HQ_RENDER',
      implementation: 'production renderPitchOffline from src/audio/pitch/signalsmith.ts',
      playbackRate: 1,
      semitones: SHIFT_SEMITONES,
      chunkFrames: 128,
      measured: {
        latencySamples: toneRender.latencySamples,
        inputLatencySamples: toneRender.inputLatencySamples,
        outputLatencySamples: toneRender.outputLatencySamples,
        windowSamples: toneRender.windowSamples,
        hopSamples: toneRender.hopSamples,
      },
    },
    dominantPitch: f0Result,
    transientAlignmentAndOvershoot: transient,
    stereoCoherence: stereo,
    formantBandMovement: {
      source: { type: 'deterministic harmonic synthesis with Gaussian amplitude bands', fundamentalHz: vowelF0, nominalFormantsHz: nominalFormants },
      bandMethod: 'integrated Hann-window FFT power in +/-18% bands about each synthetic source center and the same center multiplied by the semitone ratio, compared before and after pitch shift',
      measurements: formantMovement,
    },
  };
}

async function main() {
  const results = [];
  for (const sampleRate of SAMPLE_RATES) results.push(await runRate(sampleRate));
  const report = {
    title: 'Signalsmith HQ_RENDER synthetic objective measurements',
    classification: 'objective regression/measurement only; synthetic fixtures do not establish sound-quality acceptance, listening quality, device performance, hardware behavior, or Roland fidelity',
    generatedAtUtc: new Date().toISOString(),
    exactCommand: './node_modules/.bin/vite-node bench/run_hq_render_quality_measurements.ts',
    environment: {
      node: process.version,
      platform: platform(),
      architecture: arch(),
      osRelease: release(),
      runtime: 'Node.js invoking production TypeScript adapter and pinned Signalsmith Stretch WASM; no browser AudioWorklet or audio device used',
    },
    methodology: {
      input: 'deterministic synthetic signals, no random generator; 2.4 seconds/channel; harmonic mono pitch source at 220 Hz; four-partial decaying broadband transient; stereo phase-offset harmonic pair; vowel-like harmonic source at 110 Hz with Gaussian spectral bands centered at 650, 1200, and 2500 Hz',
      ratesHz: SAMPLE_RATES,
      shiftSemitones: SHIFT_SEMITONES,
      playbackRate: 1,
      steadyWindow: { startSecondsAfterLatencyRemoval: ANALYSIS_START_SECONDS, durationSeconds: ANALYSIS_DURATION_SECONDS, window: 'Hann', fftZeroPadding: 'next power of two', sampleAlignment: 'input analysis window index is offset by result.leadingLatencySamples in rendered output' },
      transient: '18 ms deterministic four-partial decaying burst beginning at 0.8 s; energy centroid measured within +/-120 ms; output centroid has result.leadingLatencySamples removed; peak ratio compares max absolute output/input samples in the ROI',
      stereo: 'zero-lag Pearson correlation over the same 1-second steady-state window in both channels, no lag search',
      formants: 'integrated FFT power in +/-18% nominal bands and pitch-shifted bands; reports relative band-energy movement, not formant-preservation quality',
      limitations: ['Synthetic signals only', 'No listening panel or subjective quality rating', 'No hardware or real-time load benchmark', 'No acceptance threshold is applied', 'The offline render API does not expose an independent formant-preservation control'],
    },
    results,
  };
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ reportPath: REPORT_PATH, rates: results.map((result: any) => ({ sampleRate: result.sampleRate, centsError: result.dominantPitch.signedCentsError, transientAlignmentErrorMs: result.transientAlignmentAndOvershoot.energyCentroidAlignmentErrorMs, transientPeakRatio: result.transientAlignmentAndOvershoot.transientPeakAbsRatio, stereoOutputCorrelation: result.stereoCoherence.outputZeroLagPearsonCorrelation, formantMovementDb: result.formantBandMovement.measurements.map((item: any) => item.changeTowardShiftedBandDb) })) }, null, 2)}\n`);
}

await main();
