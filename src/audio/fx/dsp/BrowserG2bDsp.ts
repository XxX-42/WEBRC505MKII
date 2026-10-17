import { BrowserSynthDsp } from './BrowserSynthDsp';

export interface BrowserG2bParameters {
  tracking?: number;
  blend?: number;
  body?: number;
}

/**
 * Clean-room guitar-to-bass function. It shares the bounded decimated-YIN
 * tracker and polyBLEP oscillator primitive with SYNTH, but fixes the detected
 * F0 down one octave, uses a square divider-like voice, disables SYNTH's extra
 * octave subvoice, and maps the independent blend/body controls to wet amount
 * and post-resynthesis TPT-SVF cutoff. This is resynthesis, not TD-PSOLA or a
 * measured original-device topology. The detector needs roughly 60 ms to
 * acquire a 55 Hz source at 48 kHz (plus parameter smoothing); it is therefore
 * functionally routed but not a sound-quality-accepted implementation.
 */
export class BrowserG2bDsp {
  readonly sampleRate: number;
  private readonly voice: BrowserSynthDsp;
  private tracking: number;
  private blend: number;
  private body: number;

  constructor(sampleRate: number, parameters: BrowserG2bParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8_000 ? sampleRate : 48_000;
    this.tracking = this.bound(parameters.tracking, 65, 0, 100);
    this.blend = this.bound(parameters.blend, 65, 0, 100);
    this.body = this.bound(parameters.body, 180, 60, 1200);
    this.voice = new BrowserSynthDsp(this.sampleRate, {
      sensitivity: this.tracking,
      waveform: 1,
      octave: -12,
      tone: this.body,
      mix: this.blend,
      subMixPercent: 0,
    });
  }

  get outputLeft(): number { return this.voice.outputLeft; }
  get outputRight(): number { return this.voice.outputRight; }
  get detectedFrequencyHz(): number { return this.voice.detectedFrequencyHz; }
  get detectorConfidence(): number { return this.voice.detectorConfidence; }
  get isVoiced(): boolean { return this.voice.isVoiced; }
  get targetTrackingPercent(): number { return this.tracking; }
  get targetBlendPercent(): number { return this.blend; }
  get targetBodyHz(): number { return this.body; }

  setParameters(parameters: BrowserG2bParameters): void {
    if (Number.isFinite(parameters.tracking)) this.tracking = this.bound(parameters.tracking, this.tracking, 0, 100);
    if (Number.isFinite(parameters.blend)) this.blend = this.bound(parameters.blend, this.blend, 0, 100);
    if (Number.isFinite(parameters.body)) this.body = this.bound(parameters.body, this.body, 60, 1200);
    this.voice.setParameters({ sensitivity: this.tracking, waveform: 1, octave: -12, tone: this.body, mix: this.blend });
  }

  processSample(left: number, right: number): void {
    this.voice.processSample(left, right);
  }

  reset(): void {
    this.voice.reset();
  }

  private bound(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
    return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value as number)) : fallback;
  }
}
