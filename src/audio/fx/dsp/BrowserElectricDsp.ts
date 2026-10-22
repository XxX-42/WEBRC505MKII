import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';
import { TptStateVariableFilter } from '../../dsp/TptStateVariableFilter';
import { LoFiDsp } from './LoFiDsp';
import { BrowserSynthDsp } from './BrowserSynthDsp';
import { BrowserVocoderCore } from '../vocoder/BrowserVocoderCore';
import { BrowserOfficialVoiceOscillator, validateVoiceControls } from './BrowserOfficialVoiceDsp';

export type BrowserElectricCharacter = 0 | 1 | 2 | 3;

export interface BrowserElectricParameters {
  character?: number;
  pitchSnapPercent?: number;
  toneHz?: number;
}

export interface BrowserElectricOfficialParameters { shift?: number; formant?: number; speed?: number; stability?: number; scale?: number }
const OFFICIAL_LIMITS = { shift: [-12, 12], formant: [-50, 50], speed: [0, 10], stability: [-10, 10], scale: [0, 12] } as const;
// Major-scale membership, also the same pitch classes as its relative minor.
const MAJOR_SCALE_MASK = (1 << 0) | (1 << 2) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 9) | (1 << 11);

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
  private readonly officialOscillator: BrowserOfficialVoiceOscillator;
  private officialEnabled = false;
  private officialShift = 0;
  private officialScale = 0;
  private officialStability = 0;
  private officialSpeed = 5;
  private officialPitchAlpha = 0;
  private officialQuantizedNote: number | null = null;
  private officialPitchTarget = 0;
  private officialPitchFrequency = 0;
  private officialCountdown = 0;
  private characterValue: BrowserElectricCharacter;
  private toneCountdown = 0;
  private carrierPhase = 0;
  private outputLeftValue = 0;
  private outputRightValue = 0;

  constructor(sampleRate: number, parameters: BrowserElectricParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8_000 ? sampleRate : 48_000;
    this.officialOscillator = new BrowserOfficialVoiceOscillator(this.sampleRate);
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
  get targetPitchHz(): number { return this.officialEnabled ? this.officialPitchTarget : this.voice.targetPitchHz; }
  get currentPitchHz(): number { return this.officialEnabled ? this.officialPitchFrequency : this.voice.targetPitchHz; }
  get isVoiced(): boolean { return this.voice.isVoiced; }
  get detectorConfidence(): number { return this.voice.detectorConfidence; }

  /** Classic and Metallic need an accepted F0; those paths fail dry until voiced. */
  get requiresVoicedInput(): boolean {
    return this.officialEnabled || this.characterValue === 0 || this.characterValue === 1;
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

  /** Official pitch-correction route, separate from the provisional legacy character bank. */
  setOfficialParameters(parameters: BrowserElectricOfficialParameters): void {
    validateVoiceControls(parameters, OFFICIAL_LIMITS, 'ELECTRIC');
    if (!Object.values(parameters).some(value => value !== undefined)) return;
    if (!this.officialEnabled) {
      this.vocoder.setVoiceShapingParameters({ formant: 0, tone: 0, attack: 50, release: 50, mod_sens: 0 });
      this.officialEnabled = true;
    }
    if (parameters.shift !== undefined) this.officialShift = parameters.shift;
    if (parameters.stability !== undefined) this.officialStability = parameters.stability;
    if (parameters.speed !== undefined) this.officialSpeed = parameters.speed;
    if (parameters.scale !== undefined && parameters.scale !== this.officialScale) {
      this.officialScale = parameters.scale;
      this.officialQuantizedNote = null;
    }
    if (parameters.formant !== undefined) this.vocoder.setVoiceShapingParameters({ formant: parameters.formant });
    // Authored curve: larger SPEED corrects faster (200 ms .. 1 ms).
    const correctionSeconds = 0.2 * 0.005 ** (this.officialSpeed / 10);
    this.officialPitchAlpha = 1 - Math.exp(-1 / (correctionSeconds * this.sampleRate));
  }

  processSample(inputLeft: number, inputRight: number): void {
    const left = Number.isFinite(inputLeft) ? clamp(inputLeft, -MAX_INPUT, MAX_INPUT) : 0;
    const right = Number.isFinite(inputRight) ? clamp(inputRight, -MAX_INPUT, MAX_INPUT) : 0;
    const mono = (left + right) * 0.5;
    this.voice.processSample(left, right);
    const voiced = this.voice.isVoiced;
    if (this.officialEnabled) {
      this.processOfficialSample(left, right, mono);
      return;
    }
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

  private processOfficialSample(left: number, right: number, mono: number): void {
    if (!this.voice.isVoiced) {
      // No guessed note or artificial carrier on unpitched material.
      this.outputLeftValue = clamp(left, -MAX_OUTPUT, MAX_OUTPUT);
      this.outputRightValue = clamp(right, -MAX_OUTPUT, MAX_OUTPUT);
      return;
    }
    if (this.officialCountdown <= 0) {
      const measured = 69 + 12 * Math.log2(this.voice.detectedFrequencyHz / 440);
      const nearest = this.nearestScaleNote(measured);
      const held = this.officialQuantizedNote;
      const hysteresis = (this.officialStability + 10) * 0.045;
      if (held === null || Math.abs(measured - held) - Math.abs(measured - nearest) > hysteresis) {
        this.officialQuantizedNote = nearest;
      }
      this.officialPitchTarget = Math.min(this.sampleRate * 0.44, 440 * 2 ** (((this.officialQuantizedNote ?? nearest) + this.officialShift - 69) / 12));
      this.officialCountdown = TONE_UPDATE_INTERVAL - 1;
    } else this.officialCountdown -= 1;
    if (this.officialPitchFrequency <= 0) this.officialPitchFrequency = this.officialPitchTarget;
    this.officialPitchFrequency += (this.officialPitchTarget - this.officialPitchFrequency) * this.officialPitchAlpha;
    this.officialOscillator.setFrequency(this.officialPitchFrequency);
    const carrier = this.officialOscillator.processSample();
    const output = this.vocoder.processWithCarrier(mono, carrier);
    this.outputLeftValue = clamp(output, -MAX_OUTPUT, MAX_OUTPUT);
    this.outputRightValue = this.outputLeftValue;
  }

  private nearestScaleNote(note: number): number {
    if (this.officialScale === 0) return Math.round(note);
    const root = this.officialScale - 1;
    let nearest = Math.round(note);
    let distance = Infinity;
    const first = Math.floor(note) - 12;
    for (let candidate = first; candidate <= first + 24; candidate += 1) {
      const pitchClass = ((candidate - root) % 12 + 12) % 12;
      if ((MAJOR_SCALE_MASK & (1 << pitchClass)) === 0) continue;
      const current = Math.abs(candidate - note);
      if (current < distance) { nearest = candidate; distance = current; }
    }
    return nearest;
  }

  reset(): void {
    this.voice.reset();
    this.officialOscillator.reset();
    this.officialQuantizedNote = null;
    this.officialPitchTarget = 0;
    this.officialPitchFrequency = 0;
    this.officialCountdown = 0;
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
