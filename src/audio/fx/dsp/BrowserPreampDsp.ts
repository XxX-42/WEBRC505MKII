import { EqualizerDsp } from './EqualizerDsp';
import { designRbjBiquad } from '../../dsp/RbjBiquad';
import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';

/**
 * Clean-room PREAMP model for Browser FX #23. This is a functional amp/speaker
 * approximation, not a Roland circuit model or factory impulse response.
 * Two-times Blackman-windowed sinc interpolation/decimation surrounds an
 * antiderivative anti-aliased asymmetric soft-clipping stage. A smoothed
 * three-band RBJ tone stack is followed by a fixed 129-tap causal cabinet
 * impulse response synthesized from minimum-phase high/low-pass, presence,
 * and cone-breakup sections. All render state and buffers are fixed at
 * construction; setParameters is called from the worklet message handler.
 */
export interface BrowserPreampParameters {
  model?: number;
  gainPercent?: number;
  bassDb?: number;
  middleDb?: number;
  trebleDb?: number;
  levelDb?: number;
}

const FIR_TAPS = 33;
const FIR_CENTER = (FIR_TAPS - 1) / 2;
const FIR_CUTOFF = 0.235;
const CABINET_TAPS = 129;
const TWO_PI = Math.PI * 2;
const MAX_OUTPUT = 4;
const MODEL_RAMP_FRAMES_SECONDS = 0.025;

// Clean-room voicing profiles: input sensitivity, curvature, bias and nonlinear
// blend. They distinguish the five broad styles without claiming brand circuits.
const MODEL_DRIVE = new Float64Array([0.78, 1.0, 1.16, 1.08, 0.88]);
const MODEL_SHAPE = new Float64Array([1.2, 1.65, 2.2, 2.7, 1.55]);
const MODEL_BIAS = new Float64Array([0, 0.085, 0.02, -0.045, 0.055]);
const MODEL_WET = new Float64Array([0.68, 0.82, 0.92, 1.0, 0.76]);

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-12) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function createOversamplingFilters(): { interpolation: Float64Array; decimation: Float64Array } {
  const interpolation = new Float64Array(FIR_TAPS);
  let sum = 0;
  for (let tap = 0; tap < FIR_TAPS; tap += 1) {
    const centered = tap - FIR_CENTER;
    const position = tap / (FIR_TAPS - 1);
    const window = 0.42 - (0.5 * Math.cos(TWO_PI * position)) + (0.08 * Math.cos(2 * TWO_PI * position));
    const coefficient = 2 * FIR_CUTOFF * sinc(2 * FIR_CUTOFF * centered) * window;
    interpolation[tap] = coefficient;
    sum += coefficient;
  }
  const decimation = new Float64Array(FIR_TAPS);
  for (let tap = 0; tap < FIR_TAPS; tap += 1) {
    interpolation[tap] = (interpolation[tap] ?? 0) * (2 / sum);
    decimation[tap] = (interpolation[tap] ?? 0) * 0.5;
  }
  return { interpolation, decimation };
}

// Immutable coefficients are authored once at module initialization, never in process().
const OVERSAMPLING_FILTERS = createOversamplingFilters();

function logCosh(value: number): number {
  const absolute = Math.abs(value);
  return absolute + Math.log1p(Math.exp(-2 * absolute)) - Math.LN2;
}

function antiderivative(shape: number, bias: number, value: number): number {
  return logCosh(shape * (value + bias)) / shape - value * Math.tanh(shape * bias);
}

function directFormBiquad(input: number, coefficients: ReturnType<typeof designRbjBiquad>, state: Float64Array, offset: number): number {
  const output = coefficients.b0 * input + (state[offset] ?? 0);
  state[offset] = coefficients.b1 * input - coefficients.a1 * output + (state[offset + 1] ?? 0);
  state[offset + 1] = coefficients.b2 * input - coefficients.a2 * output;
  return output;
}

/** Build a causal, minimum-phase-style speaker impulse from analytic sections. */
function createCabinetResponse(sampleRate: number): Float64Array {
  const highPass = designRbjBiquad('highpass', sampleRate, Math.min(105, sampleRate * 0.08), Math.SQRT1_2);
  const lowPass = designRbjBiquad('lowpass', sampleRate, Math.min(5600, sampleRate * 0.42), 0.72);
  const presence = designRbjBiquad('peaking', sampleRate, Math.min(1750, sampleRate * 0.32), 0.9, 2.2);
  const coneBreakup = designRbjBiquad('peaking', sampleRate, Math.min(3950, sampleRate * 0.42), 1.8, -4.5);
  const state = new Float64Array(8);
  const response = new Float64Array(CABINET_TAPS);
  for (let tap = 0; tap < CABINET_TAPS; tap += 1) {
    let value = tap === 0 ? 1 : 0;
    value = directFormBiquad(value, highPass, state, 0);
    value = directFormBiquad(value, lowPass, state, 2);
    value = directFormBiquad(value, presence, state, 4);
    value = directFormBiquad(value, coneBreakup, state, 6);
    response[tap] = value;
  }

  // Calibrate the analytic FIR to unity at 500 Hz, a neutral reference tone.
  let real = 0;
  let imaginary = 0;
  for (let tap = 0; tap < CABINET_TAPS; tap += 1) {
    const angle = (TWO_PI * 500 * tap) / sampleRate;
    const coefficient = response[tap] ?? 0;
    real += coefficient * Math.cos(angle);
    imaginary -= coefficient * Math.sin(angle);
  }
  const magnitude = Math.max(1e-6, Math.hypot(real, imaginary));
  const normalization = 1 / magnitude;
  for (let tap = 0; tap < CABINET_TAPS; tap += 1) response[tap] = (response[tap] ?? 0) * normalization;
  return response;
}

class OnePoleSmoother {
  private current: number;
  private target: number;
  private readonly oneMinusAlpha: number;

  constructor(sampleRate: number, initial: number, seconds = 0.015) {
    this.current = initial;
    this.target = initial;
    this.oneMinusAlpha = 1 - Math.exp(-1 / (sampleRate * seconds));
  }

  setTarget(value: number): void { this.target = value; }

  next(): number {
    this.current += (this.target - this.current) * this.oneMinusAlpha;
    return this.current;
  }
}

/** Stereo PREAMP processor; one call advances exactly one sample frame. */
export class BrowserPreampDsp {
  readonly sampleRate: number;
  outputLeft = 0;
  outputRight = 0;

  private readonly model: LinearParameterSmoother;
  private readonly gain: OnePoleSmoother;
  private readonly level: OnePoleSmoother;
  private readonly equalizer: EqualizerDsp;
  private readonly cabinet: Float64Array;
  private readonly upsampleHistory: Float64Array[] = [new Float64Array(FIR_TAPS), new Float64Array(FIR_TAPS)];
  private readonly waveshapedHistory: Float64Array[] = [new Float64Array(FIR_TAPS), new Float64Array(FIR_TAPS)];
  private readonly upsampleWriteIndex = new Int32Array(2);
  private readonly waveshapedWriteIndex = new Int32Array(2);
  private readonly previousDriven = new Float64Array(2);
  private readonly cabinetHistory: Float64Array[] = [new Float64Array(CABINET_TAPS), new Float64Array(CABINET_TAPS)];
  private readonly cabinetWriteIndex = new Int32Array(2);

  constructor(sampleRate: number, parameters: BrowserPreampParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    const initialModel = Number.isFinite(parameters.model) ? parameters.model as number : 0;
    const initialGain = Number.isFinite(parameters.gainPercent) ? parameters.gainPercent as number : 35;
    const initialBass = Number.isFinite(parameters.bassDb) ? parameters.bassDb as number : 0;
    const initialMiddle = Number.isFinite(parameters.middleDb) ? parameters.middleDb as number : 0;
    const initialTreble = Number.isFinite(parameters.trebleDb) ? parameters.trebleDb as number : 0;
    const initialLevel = Number.isFinite(parameters.levelDb) ? parameters.levelDb as number : 0;
    this.model = new LinearParameterSmoother(clamp(Math.round(initialModel), 0, 4));
    this.gain = new OnePoleSmoother(this.sampleRate, clamp(initialGain, 0, 100));
    this.level = new OnePoleSmoother(this.sampleRate, clamp(initialLevel, -24, 12));
    this.equalizer = new EqualizerDsp(this.sampleRate, {
      lowFrequencyHz: Math.min(170, this.sampleRate * 0.2),
      lowGainDb: initialBass,
      mid1FrequencyHz: Math.min(820, this.sampleRate * 0.32),
      mid1Q: 0.8,
      mid1GainDb: initialMiddle,
      highFrequencyHz: Math.min(3600, this.sampleRate * 0.42),
      highGainDb: initialTreble,
    });
    this.cabinet = createCabinetResponse(this.sampleRate);
  }

  setParameters(parameters: BrowserPreampParameters): void {
    if (Number.isFinite(parameters.model)) {
      this.model.setTarget(clamp(Math.round(parameters.model as number), 0, 4), Math.round(this.sampleRate * MODEL_RAMP_FRAMES_SECONDS));
    }
    if (Number.isFinite(parameters.gainPercent)) this.gain.setTarget(clamp(parameters.gainPercent as number, 0, 100));
    if (Number.isFinite(parameters.levelDb)) this.level.setTarget(clamp(parameters.levelDb as number, -24, 12));

    this.equalizer.setParameters({
      lowGainDb: Number.isFinite(parameters.bassDb) ? parameters.bassDb : undefined,
      mid1GainDb: Number.isFinite(parameters.middleDb) ? parameters.middleDb : undefined,
      highGainDb: Number.isFinite(parameters.trebleDb) ? parameters.trebleDb : undefined,
    });
  }

  processSample(inputLeft: number, inputRight: number): void {
    const modelPosition = this.model.next();
    const lowerModel = Math.floor(modelPosition);
    const upperModel = Math.min(4, lowerModel + 1);
    const modelBlend = modelPosition - lowerModel;
    const modelDrive = lerpTable(MODEL_DRIVE, lowerModel, upperModel, modelBlend);
    const shape = lerpTable(MODEL_SHAPE, lowerModel, upperModel, modelBlend);
    const bias = lerpTable(MODEL_BIAS, lowerModel, upperModel, modelBlend);
    const nonlinearBlend = lerpTable(MODEL_WET, lowerModel, upperModel, modelBlend);
    const gainPercent = this.gain.next() / 100;
    const stageDrive = modelDrive * (1 + (gainPercent * gainPercent * 28));
    const levelLinear = 10 ** (this.level.next() / 20);

    const preEqLeft = this.processOversampledChannel(Number.isFinite(inputLeft) ? inputLeft : 0, 0, stageDrive, shape, bias, nonlinearBlend);
    const preEqRight = this.processOversampledChannel(Number.isFinite(inputRight) ? inputRight : 0, 1, stageDrive, shape, bias, nonlinearBlend);
    this.equalizer.process(preEqLeft, preEqRight);
    this.outputLeft = this.processCabinet(this.equalizer.outputLeft, 0) * levelLinear;
    this.outputRight = this.processCabinet(this.equalizer.outputRight, 1) * levelLinear;
    this.outputLeft = clamp(Number.isFinite(this.outputLeft) ? this.outputLeft : 0, -MAX_OUTPUT, MAX_OUTPUT);
    this.outputRight = clamp(Number.isFinite(this.outputRight) ? this.outputRight : 0, -MAX_OUTPUT, MAX_OUTPUT);

  }

  reset(): void {
    for (let channel = 0; channel < 2; channel += 1) {
      this.upsampleHistory[channel]!.fill(0);
      this.waveshapedHistory[channel]!.fill(0);
      this.cabinetHistory[channel]!.fill(0);
    }
    this.upsampleWriteIndex.fill(0);
    this.waveshapedWriteIndex.fill(0);
    this.previousDriven.fill(0);
    this.cabinetWriteIndex.fill(0);
    this.equalizer.reset();
    this.outputLeft = 0;
    this.outputRight = 0;
  }

  private processOversampledChannel(input: number, channel: 0 | 1, drive: number, shape: number, bias: number, blend: number): number {
    const inputHistory = this.upsampleHistory[channel]!;
    const shapedHistory = this.waveshapedHistory[channel]!;
    let upIndex = this.upsampleWriteIndex[channel] ?? 0;
    let downIndex = this.waveshapedWriteIndex[channel] ?? 0;
    let output = 0;
    const biasValue = Math.tanh(shape * bias);
    const slopeAtZero = Math.max(0.2, shape * (1 - (biasValue * biasValue)));

    for (let phase = 0; phase < 2; phase += 1) {
      inputHistory[upIndex] = phase === 0 ? input : 0;
      let reconstructed = 0;
      for (let tap = 0; tap < FIR_TAPS; tap += 1) {
        const historyIndex = upIndex >= tap ? upIndex - tap : upIndex + FIR_TAPS - tap;
        reconstructed += (inputHistory[historyIndex] ?? 0) * (OVERSAMPLING_FILTERS.interpolation[tap] ?? 0);
      }
      const driven = reconstructed * drive;
      const previous = this.previousDriven[channel] ?? 0;
      const difference = driven - previous;
      const shaped = Math.abs(difference) < 1e-8
        ? (Math.tanh(shape * (0.5 * (driven + previous) + bias)) - biasValue) / slopeAtZero
        : (antiderivative(shape, bias, driven) - antiderivative(shape, bias, previous)) / (difference * slopeAtZero);
      this.previousDriven[channel] = driven;
      const normalized = reconstructed * (1 - blend) + shaped * blend;
      shapedHistory[downIndex] = normalized;
      if (phase === 0) {
        let decimated = 0;
        for (let tap = 0; tap < FIR_TAPS; tap += 1) {
          const historyIndex = downIndex >= tap ? downIndex - tap : downIndex + FIR_TAPS - tap;
          decimated += (shapedHistory[historyIndex] ?? 0) * (OVERSAMPLING_FILTERS.decimation[tap] ?? 0);
        }
        output = decimated;
      }
      downIndex += 1;
      if (downIndex >= FIR_TAPS) downIndex = 0;
      upIndex += 1;
      if (upIndex >= FIR_TAPS) upIndex = 0;
    }
    this.upsampleWriteIndex[channel] = upIndex;
    this.waveshapedWriteIndex[channel] = downIndex;
    return output;
  }

  private processCabinet(input: number, channel: 0 | 1): number {
    const history = this.cabinetHistory[channel]!;
    let index = this.cabinetWriteIndex[channel] ?? 0;
    history[index] = input;
    let output = 0;
    for (let tap = 0; tap < CABINET_TAPS; tap += 1) {
      const historyIndex = index >= tap ? index - tap : index + CABINET_TAPS - tap;
      output += (history[historyIndex] ?? 0) * (this.cabinet[tap] ?? 0);
    }
    index += 1;
    if (index >= CABINET_TAPS) index = 0;
    this.cabinetWriteIndex[channel] = index;
    return output;
  }
}

function lerpTable(table: Float64Array, low: number, high: number, blend: number): number {
  const first = table[low] ?? table[0] ?? 0;
  const second = table[high] ?? first;
  return first + ((second - first) * blend);
}
