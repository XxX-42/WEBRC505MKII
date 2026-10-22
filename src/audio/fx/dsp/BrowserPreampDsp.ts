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

/** RC-505mkII manual-domain controls; E.LEVEL is applied by the FX core. */
export interface BrowserPreampOfficialParameters {
  ampType?: number;
  spkType?: number;
  gain?: number;
  tComp?: number;
  bass?: number;
  middle?: number;
  treble?: number;
  presence?: number;
  micType?: number;
  micDis?: number;
  micPos?: number;
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

function antiderivative(shape: number, bias: number, value: number, biasValue: number): number {
  return logCosh(shape * (value + bias)) / shape - value * biasValue;
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

  private official: OfficialPreampControls | null = null;
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
  private readonly previousAntiderivative = new Float64Array(2);
  private readonly antiderivativeValid = new Uint8Array(2);
  private antiderivativeShape = Number.NaN;
  private antiderivativeBias = Number.NaN;
  private biasValue = 0;
  private slopeAtZero = 1;
  private cachedModelPosition = Number.NaN;
  private cachedModelDrive = 1;
  private cachedShape = 1;
  private cachedBias = 0;
  private cachedNonlinearBlend = 1;
  private cachedGainPercent = Number.NaN;
  private cachedDriveModel = Number.NaN;
  private cachedStageDrive = 1;
  private cachedLevelDb = Number.NaN;
  private cachedLevelLinear = 1;
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

  /**
   * Opt-in manual-domain path. Empty/invalid updates preserve the exact legacy
   * five-model path. Once enabled, later legacy updates cannot override these
   * controls. All response synthesis/allocation happens here, never in render.
   */
  setOfficialParameters(parameters: BrowserPreampOfficialParameters): void {
    if (!hasOfficialPreampValue(parameters)) return;
    if (this.official) this.official.setParameters(parameters);
    else this.official = new OfficialPreampControls(this.sampleRate, parameters);
  }

  processSample(inputLeft: number, inputRight: number): void {
    if (this.official) {
      this.processOfficialSample(inputLeft, inputRight, this.official);
      return;
    }
    const modelPosition = this.model.next();
    // Advance every smoother as before; only reuse pure derived values when
    // their exact inputs are unchanged, including after a ramp has settled.
    if (modelPosition !== this.cachedModelPosition) {
      const lowerModel = Math.floor(modelPosition);
      const upperModel = Math.min(4, lowerModel + 1);
      const modelBlend = modelPosition - lowerModel;
      this.cachedModelDrive = lerpTable(MODEL_DRIVE, lowerModel, upperModel, modelBlend);
      this.cachedShape = lerpTable(MODEL_SHAPE, lowerModel, upperModel, modelBlend);
      this.cachedBias = lerpTable(MODEL_BIAS, lowerModel, upperModel, modelBlend);
      this.cachedNonlinearBlend = lerpTable(MODEL_WET, lowerModel, upperModel, modelBlend);
      this.cachedModelPosition = modelPosition;
    }
    const modelDrive = this.cachedModelDrive;
    const shape = this.cachedShape;
    const bias = this.cachedBias;
    const nonlinearBlend = this.cachedNonlinearBlend;
    // The prior primitive is reusable only for exactly the same transfer
    // function. Model ramps change shape/bias and invalidate both channels.
    if (shape !== this.antiderivativeShape || bias !== this.antiderivativeBias) {
      this.antiderivativeValid.fill(0);
      this.antiderivativeShape = shape;
      this.antiderivativeBias = bias;
      this.biasValue = Math.tanh(shape * bias);
      this.slopeAtZero = Math.max(0.2, shape * (1 - (this.biasValue * this.biasValue)));
    }
    const gainPercent = this.gain.next() / 100;
    if (modelDrive !== this.cachedDriveModel || gainPercent !== this.cachedGainPercent) {
      this.cachedStageDrive = modelDrive * (1 + (gainPercent * gainPercent * 28));
      this.cachedDriveModel = modelDrive;
      this.cachedGainPercent = gainPercent;
    }
    const stageDrive = this.cachedStageDrive;
    const levelDb = this.level.next();
    if (levelDb !== this.cachedLevelDb) {
      this.cachedLevelLinear = 10 ** (levelDb / 20);
      this.cachedLevelDb = levelDb;
    }
    const levelLinear = this.cachedLevelLinear;

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
    this.previousAntiderivative.fill(0);
    this.antiderivativeValid.fill(0);
    this.cabinetWriteIndex.fill(0);
    this.equalizer.reset();
    this.official?.reset();
    this.outputLeft = 0;
    this.outputRight = 0;
  }

  private processOfficialSample(inputLeft: number, inputRight: number, controls: OfficialPreampControls): void {
    const left = Number.isFinite(inputLeft) ? clamp(inputLeft, -16, 16) : 0;
    const right = Number.isFinite(inputRight) ? clamp(inputRight, -16, 16) : 0;
    controls.prepareFrame(left, right);
    const shape = controls.shape;
    const bias = controls.bias;
    if (shape !== this.antiderivativeShape || bias !== this.antiderivativeBias) {
      this.antiderivativeValid.fill(0);
      this.antiderivativeShape = shape;
      this.antiderivativeBias = bias;
      this.biasValue = Math.tanh(shape * bias);
      this.slopeAtZero = Math.max(0.2, shape * (1 - this.biasValue * this.biasValue));
    }
    const ampLeft = this.processOversampledChannel(left, 0, controls.drive, shape, bias, controls.blend);
    const ampRight = this.processOversampledChannel(right, 1, controls.drive, shape, bias, controls.blend);
    controls.processToneAndCabinet(ampLeft * controls.dynamicGain, ampRight * controls.dynamicGain);
    this.outputLeft = clamp(Number.isFinite(controls.outputLeft) ? controls.outputLeft : 0, -MAX_OUTPUT, MAX_OUTPUT);
    this.outputRight = clamp(Number.isFinite(controls.outputRight) ? controls.outputRight : 0, -MAX_OUTPUT, MAX_OUTPUT);
  }

  private processOversampledChannel(input: number, channel: 0 | 1, drive: number, shape: number, bias: number, blend: number): number {
    const inputHistory = this.upsampleHistory[channel]!;
    const shapedHistory = this.waveshapedHistory[channel]!;
    let upIndex = this.upsampleWriteIndex[channel] ?? 0;
    let downIndex = this.waveshapedWriteIndex[channel] ?? 0;
    let output = 0;
    const biasValue = this.biasValue;
    const slopeAtZero = this.slopeAtZero;

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
      let shaped: number;
      if (Math.abs(difference) < 1e-8) {
        shaped = (Math.tanh(shape * (0.5 * (driven + previous) + bias)) - biasValue) / slopeAtZero;
        // This branch does not compute the current primitive. Never reuse a
        // stale value when the next oversample returns to the ADAA branch.
        this.antiderivativeValid[channel] = 0;
      } else {
        const currentPrimitive = antiderivative(shape, bias, driven, biasValue);
        const previousPrimitive = this.antiderivativeValid[channel]
          ? this.previousAntiderivative[channel]!
          : antiderivative(shape, bias, previous, biasValue);
        shaped = (currentPrimitive - previousPrimitive) / (difference * slopeAtZero);
        this.previousAntiderivative[channel] = currentPrimitive;
        this.antiderivativeValid[channel] = 1;
      }
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

// Clean-room authored styles, in manual AMP TYPE order: JC-120, NATURAL CLEAN,
// FULL RANGE, COMBO CRUNCH, STACK CRUNCH, HIGAIN STACK, POWER DRIVE,
// EXTREM LEAD, CORE METAL. These are distinct transfer/dynamic profiles, NOT
// measurements of the named amplifiers, licensed circuits, or factory IRs.
const OFFICIAL_DRIVE = new Float64Array([0.68, 0.76, 0.56, 1.02, 1.19, 1.42, 1.27, 1.61, 1.76]);
const OFFICIAL_SHAPE = new Float64Array([1.08, 1.31, 0.85, 1.72, 2.05, 2.68, 2.32, 3.05, 3.48]);
const OFFICIAL_BIAS = new Float64Array([0, 0.052, 0.005, 0.091, -0.034, 0.021, -0.086, 0.047, -0.012]);
const OFFICIAL_BLEND = new Float64Array([0.61, 0.74, 0.48, 0.85, 0.92, 0.98, 0.94, 1, 1]);
const OFFICIAL_SAG = new Float64Array([0.12, 0.26, 0.06, 0.48, 0.39, 0.30, 0.62, 0.44, 0.22]);
const OFFICIAL_ATTACK_MS = new Float64Array([2, 8, 1.2, 12, 8, 3, 18, 5, 1.8]);
const OFFICIAL_RELEASE_MS = new Float64Array([45, 110, 30, 145, 120, 75, 190, 105, 55]);

function hasOfficialPreampValue(p: BrowserPreampOfficialParameters): boolean {
  return Number.isFinite(p.ampType) || Number.isFinite(p.spkType) || Number.isFinite(p.gain)
    || Number.isFinite(p.tComp) || Number.isFinite(p.bass) || Number.isFinite(p.middle)
    || Number.isFinite(p.treble) || Number.isFinite(p.presence) || Number.isFinite(p.micType)
    || Number.isFinite(p.micDis) || Number.isFinite(p.micPos);
}

function officialValue(value: number | undefined, fallback: number, low: number, high: number, integer = false): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(integer ? Math.round(value as number) : value as number, low, high);
}

/** Entire official path is opt-in, so legacy presets retain sample-exact sound. */
class OfficialPreampControls {
  outputLeft = 0;
  outputRight = 0;
  drive = 1;
  shape = 1;
  bias = 0;
  blend = 1;
  dynamicGain = 1;
  private readonly parameters: Required<BrowserPreampOfficialParameters>;
  private readonly model: LinearParameterSmoother;
  private readonly gain: LinearParameterSmoother;
  private readonly compression: LinearParameterSmoother;
  private readonly cabinetWet: LinearParameterSmoother;
  private readonly tone: EqualizerDsp;
  private readonly cabinet = new Float64Array(CABINET_TAPS);
  private readonly targetCabinet = new Float64Array(CABINET_TAPS);
  private readonly cabinetHistory = [new Float64Array(CABINET_TAPS), new Float64Array(CABINET_TAPS)];
  private readonly cabinetIndex = new Int32Array(2);
  private readonly attack = new Float64Array(9);
  private readonly release = new Float64Array(9);
  private readonly rampFrames: number;
  private readonly sampleRate: number;
  private cabinetRamp = 0;
  private envelope = 0;
  private modelPosition = Number.NaN;
  private modelDrive = 1;
  private modelSag = 0;
  private attackStep = 1;
  private releaseStep = 1;

  constructor(sampleRate: number, p: BrowserPreampOfficialParameters) {
    this.sampleRate = sampleRate;
    this.parameters = {
      ampType: officialValue(p.ampType, 3, 0, 8, true),
      spkType: officialValue(p.spkType, 1, 0, 8, true),
      gain: officialValue(p.gain, 50, 0, 120),
      tComp: officialValue(p.tComp, 0, -10, 10),
      bass: officialValue(p.bass, 50, 0, 100),
      middle: officialValue(p.middle, 50, 0, 100),
      treble: officialValue(p.treble, 50, 0, 100),
      presence: officialValue(p.presence, 50, 0, 100),
      micType: officialValue(p.micType, 0, 0, 4, true),
      micDis: officialValue(p.micDis, 0, 0, 1, true),
      micPos: officialValue(p.micPos, 0, 0, 10, true),
    };
    this.rampFrames = Math.max(1, Math.round(sampleRate * MODEL_RAMP_FRAMES_SECONDS));
    this.model = new LinearParameterSmoother(this.parameters.ampType);
    this.gain = new LinearParameterSmoother(this.parameters.gain);
    this.compression = new LinearParameterSmoother(this.parameters.tComp);
    this.cabinetWet = new LinearParameterSmoother(this.parameters.spkType === 0 ? 0 : 1);
    this.tone = new EqualizerDsp(sampleRate, {
      lowFrequencyHz: 150, mid1FrequencyHz: 800, mid1Q: 0.8,
      mid2FrequencyHz: Math.min(2900, sampleRate * 0.32), mid2Q: 0.65,
      highFrequencyHz: Math.min(5800, sampleRate * 0.42),
    });
    this.updateTone(0);
    this.updateCabinet();
    this.cabinet.set(this.targetCabinet);
    this.cabinetRamp = 0;
    for (let model = 0; model < 9; model += 1) {
      this.attack[model] = 1 - Math.exp(-1 / (sampleRate * OFFICIAL_ATTACK_MS[model]! * 0.001));
      this.release[model] = 1 - Math.exp(-1 / (sampleRate * OFFICIAL_RELEASE_MS[model]! * 0.001));
    }
  }

  setParameters(p: BrowserPreampOfficialParameters): void {
    const old = this.parameters;
    const amp = officialValue(p.ampType, old.ampType, 0, 8, true);
    const speaker = officialValue(p.spkType, old.spkType, 0, 8, true);
    const gain = officialValue(p.gain, old.gain, 0, 120);
    const compression = officialValue(p.tComp, old.tComp, -10, 10);
    const bass = officialValue(p.bass, old.bass, 0, 100);
    const middle = officialValue(p.middle, old.middle, 0, 100);
    const treble = officialValue(p.treble, old.treble, 0, 100);
    const presence = officialValue(p.presence, old.presence, 0, 100);
    const microphone = officialValue(p.micType, old.micType, 0, 4, true);
    const distance = officialValue(p.micDis, old.micDis, 0, 1, true);
    const position = officialValue(p.micPos, old.micPos, 0, 10, true);
    const toneChanged = bass !== old.bass || middle !== old.middle || treble !== old.treble || presence !== old.presence;
    const cabinetChanged = speaker !== old.spkType || microphone !== old.micType
      || distance !== old.micDis || position !== old.micPos || (speaker === 1 && amp !== old.ampType);
    if (amp !== old.ampType) this.model.setTarget(amp, this.rampFrames);
    if (gain !== old.gain) this.gain.setTarget(gain, this.rampFrames);
    if (compression !== old.tComp) this.compression.setTarget(compression, this.rampFrames);
    if (speaker !== old.spkType) this.cabinetWet.setTarget(speaker === 0 ? 0 : 1, this.rampFrames);
    old.ampType = amp; old.spkType = speaker; old.gain = gain; old.tComp = compression;
    old.bass = bass; old.middle = middle; old.treble = treble; old.presence = presence;
    old.micType = microphone; old.micDis = distance; old.micPos = position;
    if (toneChanged) this.updateTone(this.rampFrames);
    if (cabinetChanged) this.updateCabinet();
  }

  /** Allocation-free, stereo-linked level detector and dynamic power-stage sag. */
  prepareFrame(left: number, right: number): void {
    const position = this.model.next();
    if (position !== this.modelPosition) {
      const low = Math.floor(position);
      const high = Math.min(8, low + 1);
      const fraction = position - low;
      this.modelDrive = lerpTable(OFFICIAL_DRIVE, low, high, fraction);
      this.shape = lerpTable(OFFICIAL_SHAPE, low, high, fraction);
      this.bias = lerpTable(OFFICIAL_BIAS, low, high, fraction);
      this.blend = lerpTable(OFFICIAL_BLEND, low, high, fraction);
      this.modelSag = lerpTable(OFFICIAL_SAG, low, high, fraction);
      this.attackStep = lerpTable(this.attack, low, high, fraction);
      this.releaseStep = lerpTable(this.release, low, high, fraction);
      this.modelPosition = position;
    }
    const peak = Math.max(Math.abs(left), Math.abs(right));
    this.envelope += (peak - this.envelope) * (peak > this.envelope ? this.attackStep : this.releaseStep);
    // Positive T-COMP increases level-dependent compression and supply sag;
    // negative values reduce it. Below threshold it does not act as a static
    // volume knob. Attack/release memory differs for all nine amp profiles.
    const compression = (0.16 + this.modelSag) * (2 ** (this.compression.next() / 5));
    const pressure = Math.max(0, this.envelope - 0.035) / 0.35;
    this.dynamicGain = 1 / Math.sqrt(1 + compression * pressure);
    const gain = this.gain.next() / 100;
    this.drive = this.modelDrive * (1 + 28 * gain * gain) / (1 + 0.24 * compression * pressure);
  }

  processToneAndCabinet(left: number, right: number): void {
    this.tone.process(left, right);
    if (this.cabinetRamp > 0) {
      const inverseRemaining = 1 / this.cabinetRamp;
      for (let tap = 0; tap < CABINET_TAPS; tap += 1) {
        this.cabinet[tap] = this.cabinet[tap]! + (this.targetCabinet[tap]! - this.cabinet[tap]!) * inverseRemaining;
      }
      this.cabinetRamp -= 1;
    }
    const wet = this.cabinetWet.next();
    // OFF really bypasses both speaker and microphone, including distance and
    // off-axis coloration. Advance histories without running a convolution so
    // re-enabling cannot replay stale pre-bypass samples.
    if (wet === 0) {
      this.processCabinet(this.tone.outputLeft, 0, false);
      this.processCabinet(this.tone.outputRight, 1, false);
      this.outputLeft = this.tone.outputLeft;
      this.outputRight = this.tone.outputRight;
      return;
    }
    this.outputLeft = this.tone.outputLeft * (1 - wet) + this.processCabinet(this.tone.outputLeft, 0) * wet;
    this.outputRight = this.tone.outputRight * (1 - wet) + this.processCabinet(this.tone.outputRight, 1) * wet;
  }

  reset(): void {
    this.model.reset(); this.gain.reset(); this.compression.reset(); this.cabinetWet.reset();
    this.envelope = 0;
    this.modelPosition = Number.NaN;
    this.tone.reset();
    this.cabinet.set(this.targetCabinet);
    this.cabinetRamp = 0;
    this.cabinetHistory[0]!.fill(0); this.cabinetHistory[1]!.fill(0); this.cabinetIndex.fill(0);
    this.outputLeft = 0; this.outputRight = 0;
  }

  private updateTone(rampFrames: number): void {
    const p = this.parameters;
    this.tone.setParameters({
      lowGainDb: (p.bass - 50) * 0.24,
      mid1GainDb: (p.middle - 50) * 0.24,
      mid2GainDb: (p.treble - 50) * 0.24,
      highGainDb: (p.presence - 50) * 0.24,
    }, rampFrames);
  }

  private updateCabinet(): void {
    // Keep the previous response while fading to OFF; changing a microphone
    // while OFF cannot alter the bypassed audio. Rebuild when enabled again.
    if (this.parameters.spkType === 0) return;
    this.targetCabinet.set(createOfficialCabinetResponse(this.sampleRate, this.parameters));
    this.cabinetRamp = this.rampFrames;
  }

  private processCabinet(input: number, channel: 0 | 1, convolve = true): number {
    const history = this.cabinetHistory[channel]!;
    let index = this.cabinetIndex[channel]!;
    history[index] = input;
    let output = 0;
    if (convolve) {
      for (let tap = 0; tap < CABINET_TAPS; tap += 1) {
        const historyIndex = index >= tap ? index - tap : index + CABINET_TAPS - tap;
        output += history[historyIndex]! * this.cabinet[tap]!;
      }
    }
    index += 1;
    this.cabinetIndex[channel] = index === CABINET_TAPS ? 0 : index;
    return output;
  }
}

// Speaker order: OFF, ORIGINAL, 1x8, 1x10, 1x12, 2x12, 4x10, 4x12, 8x12.
// Analytic, authored band limits/resonances, not imported/measured IR data.
const CAB_HIGH_PASS = new Float64Array([0, 94, 155, 116, 83, 71, 89, 59, 47]);
const CAB_LOW_PASS = new Float64Array([0, 5650, 6650, 6200, 5450, 5150, 6050, 4650, 4250]);
const CAB_BODY_HZ = new Float64Array([0, 192, 305, 238, 180, 146, 202, 126, 106]);
const CAB_BODY_DB = new Float64Array([0, 2.3, 1.4, 2.0, 2.7, 3.2, 3.8, 4.3, 4.9]);
const CAB_PRESENCE_HZ = new Float64Array([0, 1900, 2450, 2210, 1840, 1720, 2180, 1630, 1490]);
const CAB_BREAKUP_HZ = new Float64Array([0, 4050, 4700, 4390, 3980, 3760, 4450, 3510, 3190]);

/** Synthesize speaker, mic, distance and off-axis transfer at control rate. */
function createOfficialCabinetResponse(sampleRate: number, p: Required<BrowserPreampOfficialParameters>): Float64Array {
  const type = p.spkType;
  const original = type === 1;
  // ORIGINAL follows the chosen amp: full-range stays wide, combos brighter,
  // high-gain stacks darker and larger. Explicit speaker choices are fixed.
  const width = !original ? 1 : p.ampType === 2 ? 1.5 : 1.13 - p.ampType * 0.045;
  const body = !original ? 1 : p.ampType === 2 ? 0.35 : 0.8 + p.ampType * 0.07;
  const frequency = (value: number): number => Math.min(value, sampleRate * 0.44);
  const sections = [
    designRbjBiquad('highpass', sampleRate, frequency(CAB_HIGH_PASS[type]! * width), 0.71),
    designRbjBiquad('lowpass', sampleRate, frequency(CAB_LOW_PASS[type]! * width), 0.72),
    designRbjBiquad('peaking', sampleRate, frequency(CAB_BODY_HZ[type]!), 0.95, CAB_BODY_DB[type]! * body),
    designRbjBiquad('peaking', sampleRate, frequency(CAB_PRESENCE_HZ[type]! * width), 0.92, 2.1),
    designRbjBiquad('peaking', sampleRate, frequency(CAB_BREAKUP_HZ[type]! * width), 1.75, -4.1 - type * 0.12),
  ];
  const state = new Float64Array(24);
  const speaker = new Float64Array(CABINET_TAPS);
  for (let tap = 0; tap < CABINET_TAPS; tap += 1) {
    let sample = tap === 0 ? 1 : 0;
    for (let section = 0; section < sections.length; section += 1) sample = directFormBiquad(sample, sections[section]!, state, 2 * section);
    speaker[tap] = sample;
  }
  // Normalize only the speaker at 500 Hz. Do not normalize away the microphone
  // proximity effect, distance attenuation or deliberately off-axis response.
  let real = 0;
  let imaginary = 0;
  for (let tap = 0; tap < CABINET_TAPS; tap += 1) {
    real += speaker[tap]! * Math.cos(TWO_PI * 500 * tap / sampleRate);
    imaginary -= speaker[tap]! * Math.sin(TWO_PI * 500 * tap / sampleRate);
  }
  const normalization = 1 / Math.max(1e-6, Math.hypot(real, imaginary));
  // Microphone profiles: DYN57, DYN421, CND451, CND87, FLAT. Three spectral
  // sections per mic. FLAT removes these sections, not physical mic placement.
  const mic = p.micType;
  const micLow = [0, 2.6, -0.6, 1.5, 0][mic]!;
  const micPeakHz = [4350, 3450, 6850, 2850, 1000][mic]!;
  const micPeakDb = [4.2, 2.8, 2.1, 1.6, 0][mic]!;
  const micHigh = [-3.4, -1.8, 2.7, 0.8, 0][mic]!;
  const near = p.micDis === 1;
  const position = p.micPos / 10;
  const micSections = [
    designRbjBiquad('low-shelf', sampleRate, frequency(210), Math.SQRT1_2, micLow),
    designRbjBiquad('peaking', sampleRate, frequency(micPeakHz), 1.1, micPeakDb),
    designRbjBiquad('high-shelf', sampleRate, frequency(5850), Math.SQRT1_2, micHigh),
    designRbjBiquad('low-shelf', sampleRate, frequency(185), Math.SQRT1_2, near ? 2.8 : -3.5),
    designRbjBiquad('high-shelf', sampleRate, frequency(4200 - 1000 * position), Math.SQRT1_2, (near ? 0 : -2.2) - 11 * position),
    designRbjBiquad('peaking', sampleRate, frequency(2750), 0.8, -3 * position),
  ];
  state.fill(0);
  const response = new Float64Array(CABINET_TAPS);
  const distanceGain = near ? 1 : 0.74;
  for (let tap = 0; tap < CABINET_TAPS; tap += 1) {
    let sample = speaker[tap]! * normalization;
    for (let section = 0; section < micSections.length; section += 1) sample = directFormBiquad(sample, micSections[section]!, state, 2 * section);
    response[tap] = sample * distanceGain;
  }
  return response;
}
