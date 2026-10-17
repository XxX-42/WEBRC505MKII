import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';
import { TptStateVariableFilter } from '../../dsp/TptStateVariableFilter';
import { LoFiDsp } from './LoFiDsp';
import { BrowserSynthDsp } from './BrowserSynthDsp';
import { BrowserVocoderCore } from '../vocoder/BrowserVocoderCore';

export type BrowserElectricCharacter = 0 | 1 | 2 | 3;

export interface BrowserElectricParameters {
  character?: number;
  pitchSnapPercent?: number;
  toneHz?: number;
}

const DEFAULT_CHARACTER: BrowserElectricCharacter = 0;
const DEFAULT_PITCH_SNAP_PERCENT = 50;
const DEFAULT_TONE_HZ = 5_000;
const MAX_INPUT = 8;
const MAX_OUTPUT = 4;
const RING_CARRIER_RATIO = Math.SQRT2;
const TONE_UPDATE_INTERVAL = 16;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function bounded(value: number, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}

/**
 * Clean-room Browser ELECTRIC character bank. It reuses the bounded decimated
 * YIN/polyBLEP voice, ERB/TPT vocoder and sample-rate-hold/quantizer primitives
 * already in this project. Classic resynthesizes at a pitch-snap blended
 * equal-tempered target; Metallic ring-modulates the source with a sine whose
 * frequency follows that target; Vocoder uses the quantized resynthesis as a
 * carrier for voiced input (and a bounded internal carrier for unvoiced
 * speech); Bit crush sample-rate-holds and quantizes the voice or raw input.
 * Tone is a smoothed post-low-pass. These authored paths are perceptual
 * inferences from the public functional description, not Roland topology,
 * firmware, or a sound-quality acceptance claim.
 */
export class BrowserElectricDsp {
  readonly sampleRate: number;
  private readonly voice: BrowserSynthDsp;
  private readonly vocoder: BrowserVocoderCore;
  private readonly bitCrusher: LoFiDsp;
  private readonly toneHz: LinearParameterSmoother;
  private readonly toneLeft: TptStateVariableFilter;
  private readonly toneRight: TptStateVariableFilter;
  private characterValue: BrowserElectricCharacter;
  private toneCountdown = 0;
  private carrierPhase = 0;
  private outputLeftValue = 0;
  private outputRightValue = 0;

  constructor(sampleRate: number, parameters: BrowserElectricParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8_000 ? sampleRate : 48_000;
    this.characterValue = BrowserElectricDsp.validateCharacter(parameters.character ?? DEFAULT_CHARACTER);
    const pitchSnap = bounded(parameters.pitchSnapPercent ?? DEFAULT_PITCH_SNAP_PERCENT, DEFAULT_PITCH_SNAP_PERCENT, 0, 100);
    const tone = bounded(parameters.toneHz ?? DEFAULT_TONE_HZ, DEFAULT_TONE_HZ, 100, 16_000);
    const safeTone = Math.min(tone, this.sampleRate * 0.45);
    this.toneHz = new LinearParameterSmoother(safeTone);
    this.toneLeft = new TptStateVariableFilter(this.sampleRate, safeTone, Math.SQRT1_2);
    this.toneRight = new TptStateVariableFilter(this.sampleRate, safeTone, Math.SQRT1_2);
    this.voice = new BrowserSynthDsp(this.sampleRate, {
      sensitivity: 75,
      waveform: 0,
      octave: 0,
      tone: safeTone,
      mix: 100,
      pitchSnapPercent: pitchSnap,
      subMixPercent: 0,
    });
    this.vocoder = new BrowserVocoderCore(this.sampleRate, { bands: 16, carrier: 1 });
    this.bitCrusher = new LoFiDsp(this.sampleRate, {
      bitDepth: 7,
      sampleRateHz: Math.min(8_000, this.sampleRate),
      filterHz: safeTone,
    });
  }

  get outputLeft(): number { return this.outputLeftValue; }
  get outputRight(): number { return this.outputRightValue; }
  get character(): BrowserElectricCharacter { return this.characterValue; }
  get pitchSnapPercent(): number { return this.voice.targetPitchSnapPercent; }
  get detectedFrequencyHz(): number { return this.voice.detectedFrequencyHz; }
  get targetPitchHz(): number { return this.voice.targetPitchHz; }
  get isVoiced(): boolean { return this.voice.isVoiced; }
  get detectorConfidence(): number { return this.voice.detectorConfidence; }

  /** Classic and Metallic need an accepted F0; those paths fail dry until voiced. */
  get requiresVoicedInput(): boolean {
    return this.characterValue === 0 || this.characterValue === 1;
  }

  setParameters(parameters: BrowserElectricParameters): void {
    if (parameters.character !== undefined) {
      this.characterValue = BrowserElectricDsp.validateCharacter(parameters.character);
    }
    const rampFrames = Math.max(1, Math.round(this.sampleRate * 0.02));
    if (Number.isFinite(parameters.pitchSnapPercent)) {
      this.voice.setParameters({ pitchSnapPercent: bounded(parameters.pitchSnapPercent as number, DEFAULT_PITCH_SNAP_PERCENT, 0, 100) });
    }
    if (Number.isFinite(parameters.toneHz)) {
      const nextTone = Math.min(bounded(parameters.toneHz as number, DEFAULT_TONE_HZ, 100, 16_000), this.sampleRate * 0.45);
      this.toneHz.setTarget(nextTone, rampFrames);
      this.voice.setParameters({ tone: nextTone });
      this.bitCrusher.setParameters({ filterHz: nextTone }, rampFrames);
    }
  }

  processSample(inputLeft: number, inputRight: number): void {
    const left = Number.isFinite(inputLeft) ? clamp(inputLeft, -MAX_INPUT, MAX_INPUT) : 0;
    const right = Number.isFinite(inputRight) ? clamp(inputRight, -MAX_INPUT, MAX_INPUT) : 0;
    const mono = (left + right) * 0.5;
    this.voice.processSample(left, right);
    const voiced = this.voice.isVoiced;
    const voiceLeft = this.voice.outputLeft;
    const voiceRight = this.voice.outputRight;
    const voiceMono = (voiceLeft + voiceRight) * 0.5;
    let wetLeft: number;
    let wetRight: number;

    switch (this.characterValue) {
      case 0:
        wetLeft = voiceLeft;
        wetRight = voiceRight;
        break;
      case 1: {
        const fundamental = this.voice.targetPitchHz;
        const carrierHz = clamp(fundamental * RING_CARRIER_RATIO, 0, this.sampleRate * 0.45);
        const step = carrierHz / this.sampleRate;
        const carrier = Math.sin(2 * Math.PI * this.carrierPhase);
        this.carrierPhase += step;
        if (this.carrierPhase >= 1) this.carrierPhase -= Math.floor(this.carrierPhase);
        wetLeft = left * carrier * 1.8;
        wetRight = right * carrier * 1.8;
        break;
      }
      case 2: {
        let output: number;
        if (voiced) {
          output = this.vocoder.processWithCarrier(mono, voiceMono);
        } else {
          this.vocoder.processSample(mono, mono);
          output = this.vocoder.outputLeft;
        }
        wetLeft = output;
        wetRight = output;
        break;
      }
      case 3:
        this.bitCrusher.process(voiced ? voiceLeft : left, voiced ? voiceRight : right);
        wetLeft = this.bitCrusher.wetLeft;
        wetRight = this.bitCrusher.wetRight;
        break;
    }

    const tone = this.toneHz.next();
    if (this.toneCountdown <= 0) {
      const cutoff = clamp(tone, 100, this.sampleRate * 0.45);
      this.toneLeft.setParameters(cutoff, Math.SQRT1_2);
      this.toneRight.setParameters(cutoff, Math.SQRT1_2);
      this.toneCountdown = TONE_UPDATE_INTERVAL - 1;
    } else {
      this.toneCountdown -= 1;
    }
    const filteredLeft = this.toneLeft.processSample(wetLeft);
    const filteredRight = this.toneRight.processSample(wetRight);
    this.outputLeftValue = Number.isFinite(filteredLeft) ? clamp(filteredLeft, -MAX_OUTPUT, MAX_OUTPUT) : 0;
    this.outputRightValue = Number.isFinite(filteredRight) ? clamp(filteredRight, -MAX_OUTPUT, MAX_OUTPUT) : 0;
  }

  reset(): void {
    this.voice.reset();
    this.vocoder.reset();
    this.bitCrusher.reset();
    this.toneLeft.reset();
    this.toneRight.reset();
    this.toneHz.reset();
    this.toneCountdown = 0;
    this.carrierPhase = 0;
    this.outputLeftValue = 0;
    this.outputRightValue = 0;
  }

  private static validateCharacter(value: number): BrowserElectricCharacter {
    if (!Number.isInteger(value) || value < 0 || value > 3) {
      throw new RangeError('Browser ELECTRIC character must be an integer from 0 to 3.');
    }
    return value as BrowserElectricCharacter;
  }
}
