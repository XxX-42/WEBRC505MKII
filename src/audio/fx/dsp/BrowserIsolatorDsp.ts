import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';
import { TptStateVariableFilter } from '../../dsp/TptStateVariableFilter';

export interface BrowserIsolatorParameters {
  lowGainDb?: number;
  midGainDb?: number;
  highGainDb?: number;
  gateRateBeats?: number;
  gateDepthPercent?: number;
  bpm?: number;
}

const CROSSOVER_LOW_HZ = 250;
const CROSSOVER_HIGH_HZ = 2500;
const BAND_GAIN_MIN_DB = -60;
const BAND_GAIN_MAX_DB = 12;
const GATE_RATE_CHOICES = [0.25, 0.5, 1, 2, 4] as const;
const GATE_DEPTH_MIN_PERCENT = 0;
const GATE_DEPTH_MAX_PERCENT = 100;
const BPM_MIN = 20;
const BPM_MAX = 300;
const CONTROL_SMOOTHING_SECONDS = 0.015;
const GATE_EDGE_SMOOTHING_SECONDS = 0.002;
const SVF_Q = Math.SQRT1_2;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const dbToLinear = (valueDb: number): number => 10 ** (valueDb / 20);

const nearestGateRate = (value: number): number => {
  let nearest: number = GATE_RATE_CHOICES[0];
  let smallestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of GATE_RATE_CHOICES) {
    const distance = Math.abs(candidate - value);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      nearest = candidate;
    }
  }
  return nearest;
};

/**
 * Clean-room three-band isolator with LR4-style TPT crossover branches and a
 * sample-clocked, half-open rhythm gate. Control ranges and crossover points
 * are provisional authored choices; this is not Roland factory DSP.
 *
 * The low and high bands are fourth-order cascaded TPT Butterworth branches.
 * The mid band is the residual (input - low - high), which makes the three
 * gains recombine to unity when set to 0 dB. Filter and gate states are fixed
 * at construction, and processSample allocates no objects.
 */
export class BrowserIsolatorDsp {
  readonly sampleRate: number;

  outputLeft = 0;
  outputRight = 0;

  private readonly lowFirst: readonly [TptStateVariableFilter, TptStateVariableFilter];
  private readonly lowSecond: readonly [TptStateVariableFilter, TptStateVariableFilter];
  private readonly highFirst: readonly [TptStateVariableFilter, TptStateVariableFilter];
  private readonly highSecond: readonly [TptStateVariableFilter, TptStateVariableFilter];
  private readonly lowGain: LinearParameterSmoother;
  private readonly midGain: LinearParameterSmoother;
  private readonly highGain: LinearParameterSmoother;
  private readonly gateDepth: LinearParameterSmoother;
  private readonly gateEnvelope: LinearParameterSmoother;
  private gateRateBeats: number;
  private pendingGateRateBeats: number;
  private bpm: number;
  private cycleBeatPosition = 0;
  private isGateOpen = true;
  private officialActive = false;
  private officialBand = 0;
  private officialRate = 2;
  private officialBandLevel = 0.5;
  private officialDepth = 0.5;
  private officialStepRate = 0;
  private officialWaveform = 0;
  private officialPhase = 0;
  private officialStepPhase = 1;
  private officialHeldLfo = 0;
  private officialBandGain = 1;

  constructor(sampleRate: number, parameters: BrowserIsolatorParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    const nyquist = this.sampleRate * 0.499;
    const lowCrossover = Math.min(CROSSOVER_LOW_HZ, nyquist * 0.45);
    const highCrossover = Math.min(CROSSOVER_HIGH_HZ, nyquist * 0.8);
    const initialLowDb = clamp(Number.isFinite(parameters.lowGainDb) ? parameters.lowGainDb as number : 0, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB);
    const initialMidDb = clamp(Number.isFinite(parameters.midGainDb) ? parameters.midGainDb as number : 0, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB);
    const initialHighDb = clamp(Number.isFinite(parameters.highGainDb) ? parameters.highGainDb as number : 0, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB);
    const initialGateRate = nearestGateRate(clamp(Number.isFinite(parameters.gateRateBeats) ? parameters.gateRateBeats as number : 0.5, 0.25, 4));
    const initialGateDepth = clamp(Number.isFinite(parameters.gateDepthPercent) ? parameters.gateDepthPercent as number : 0, GATE_DEPTH_MIN_PERCENT, GATE_DEPTH_MAX_PERCENT) / 100;
    this.bpm = clamp(Number.isFinite(parameters.bpm) ? parameters.bpm as number : 120, BPM_MIN, BPM_MAX);
    this.gateRateBeats = initialGateRate;
    this.pendingGateRateBeats = initialGateRate;
    this.lowGain = new LinearParameterSmoother(dbToLinear(initialLowDb));
    this.midGain = new LinearParameterSmoother(dbToLinear(initialMidDb));
    this.highGain = new LinearParameterSmoother(dbToLinear(initialHighDb));
    this.gateDepth = new LinearParameterSmoother(initialGateDepth);
    this.gateEnvelope = new LinearParameterSmoother(1);
    const makePair = (cutoffHz: number): readonly [TptStateVariableFilter, TptStateVariableFilter] => [
      new TptStateVariableFilter(this.sampleRate, cutoffHz, SVF_Q),
      new TptStateVariableFilter(this.sampleRate, cutoffHz, SVF_Q),
    ];
    this.lowFirst = makePair(lowCrossover);
    this.lowSecond = makePair(lowCrossover);
    this.highFirst = makePair(highCrossover);
    this.highSecond = makePair(highCrossover);
  }

  setParameters(parameters: BrowserIsolatorParameters): void {
    const rampFrames = Math.max(1, Math.round(this.sampleRate * CONTROL_SMOOTHING_SECONDS));
    if (Number.isFinite(parameters.lowGainDb)) {
      this.lowGain.setTarget(dbToLinear(clamp(parameters.lowGainDb as number, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB)), rampFrames);
    }
    if (Number.isFinite(parameters.midGainDb)) {
      this.midGain.setTarget(dbToLinear(clamp(parameters.midGainDb as number, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB)), rampFrames);
    }
    if (Number.isFinite(parameters.highGainDb)) {
      this.highGain.setTarget(dbToLinear(clamp(parameters.highGainDb as number, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB)), rampFrames);
    }
    if (Number.isFinite(parameters.gateRateBeats)) {
      this.pendingGateRateBeats = nearestGateRate(clamp(parameters.gateRateBeats as number, 0.25, 4));
    }
    if (Number.isFinite(parameters.gateDepthPercent)) {
      this.gateDepth.setTarget(clamp(parameters.gateDepthPercent as number, GATE_DEPTH_MIN_PERCENT, GATE_DEPTH_MAX_PERCENT) / 100, rampFrames);
    }
    if (Number.isFinite(parameters.bpm)) {
      this.bpm = clamp(parameters.bpm as number, BPM_MIN, BPM_MAX);
    }
  }

  setOfficialParameters(parameters: { band: number; rateHz: number; bandLevel: number; depth: number; stepRateHz: number; waveform: number }): void {
    this.officialActive = true;
    this.officialBand = Math.round(clamp(parameters.band, 0, 2));
    this.officialRate = clamp(parameters.rateHz, 0, 160);
    this.officialBandLevel = clamp(parameters.bandLevel, 0, 100) / 100;
    this.officialDepth = clamp(parameters.depth, 0, 100) / 100;
    this.officialStepRate = clamp(parameters.stepRateHz, 0, 160);
    this.officialWaveform = parameters.waveform === 1 ? 1 : 0;
  }

  processSample(inputLeft: number, inputRight: number): void {
    const leftLow = this.processLow(inputLeft, 0);
    const rightLow = this.processLow(inputRight, 1);
    const leftHigh = this.processHigh(inputLeft, 0);
    const rightHigh = this.processHigh(inputRight, 1);
    const lowGain = this.lowGain.next();
    const midGain = this.midGain.next();
    const highGain = this.highGain.next();
    const beatIncrement = this.bpm / (60 * this.sampleRate);
    this.cycleBeatPosition += beatIncrement;
    if (this.cycleBeatPosition >= this.gateRateBeats) {
      this.cycleBeatPosition -= this.gateRateBeats;
      this.gateRateBeats = this.pendingGateRateBeats;
    }
    const targetIsOpen = this.cycleBeatPosition < (this.gateRateBeats * 0.5);
    if (targetIsOpen !== this.isGateOpen) {
      this.isGateOpen = targetIsOpen;
      this.gateEnvelope.setTarget(targetIsOpen ? 1 : 0, Math.max(1, Math.round(this.sampleRate * GATE_EDGE_SMOOTHING_SECONDS)));
    }
    const gateDepth = this.gateDepth.next();
    const gateGain = 1 - (gateDepth * (1 - this.gateEnvelope.next()));
    const leftMid = inputLeft - leftLow - leftHigh;
    const rightMid = inputRight - rightLow - rightHigh;
    if (this.officialActive) {
      this.officialPhase = (this.officialPhase + this.officialRate / this.sampleRate) % 1;
      if (this.officialStepRate === 0 || this.officialStepPhase >= 1) {
        this.officialHeldLfo = this.officialWaveform === 0 ? 1 - 4 * Math.abs(this.officialPhase - 0.5) : this.officialPhase < 0.5 ? 1 : -1;
        this.officialStepPhase %= 1;
      }
      this.officialStepPhase += this.officialStepRate / this.sampleRate;
      const target = this.officialBandLevel * (1 - this.officialDepth * (1 - this.officialHeldLfo) * 0.5);
      this.officialBandGain += (target - this.officialBandGain) * (1 - Math.exp(-1 / (this.sampleRate * 0.002)));
      const selectedLeft = this.officialBand === 0 ? leftLow : this.officialBand === 1 ? leftMid : leftHigh;
      const selectedRight = this.officialBand === 0 ? rightLow : this.officialBand === 1 ? rightMid : rightHigh;
      this.outputLeft = clamp(inputLeft + selectedLeft * (this.officialBandGain - 1), -16, 16);
      this.outputRight = clamp(inputRight + selectedRight * (this.officialBandGain - 1), -16, 16);
      return;
    }
    this.outputLeft = clamp(((leftLow * lowGain) + (leftMid * midGain) + (leftHigh * highGain)) * gateGain, -16, 16);
    this.outputRight = clamp(((rightLow * lowGain) + (rightMid * midGain) + (rightHigh * highGain)) * gateGain, -16, 16);
  }

  reset(): void {
    for (let channel = 0; channel < 2; channel += 1) {
      this.lowFirst[channel]!.reset();
      this.lowSecond[channel]!.reset();
      this.highFirst[channel]!.reset();
      this.highSecond[channel]!.reset();
    }
    this.lowGain.reset();
    this.midGain.reset();
    this.highGain.reset();
    this.gateDepth.reset();
    this.gateEnvelope.reset(1);
    this.cycleBeatPosition = 0;
    this.officialPhase = 0;
    this.officialStepPhase = 1;
    this.officialHeldLfo = 0;
    this.officialBandGain = 1;
    this.gateRateBeats = this.pendingGateRateBeats;
    this.isGateOpen = true;
    this.outputLeft = 0;
    this.outputRight = 0;
  }

  private processLow(input: number, channel: 0 | 1): number {
    const first = this.lowFirst[channel]!;
    const second = this.lowSecond[channel]!;
    first.processSample(input);
    second.processSample(first.lowpass);
    return second.lowpass;
  }

  private processHigh(input: number, channel: 0 | 1): number {
    const first = this.highFirst[channel]!;
    const second = this.highSecond[channel]!;
    first.processSample(input);
    second.processSample(first.highpass);
    return second.highpass;
  }
}
