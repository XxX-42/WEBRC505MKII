/** Shared clean-room voice primitives. Coefficient curves are authored, not Roland DSP. */
export type OfficialVoiceWaveform = 0 | 1 | 2 | 3 | 4;
export type VoiceControlLimits = Readonly<Record<string, readonly [number, number]>>;

/** Parameter-thread validation, never called by a sample-render method. */
export function validateVoiceControls(parameters: object, limits: VoiceControlLimits, effect: string): void {
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined) continue;
    const range = limits[key];
    if (!range || typeof value !== 'number' || !Number.isInteger(value) || value < range[0] || value > range[1]) {
      throw new RangeError(`${effect} official ${key} is unsupported or outside its integer domain.`);
    }
  }
}

export function voiceAttackSeconds(value: number): number { return 0.00025 * 256 ** (value / 100); }
export function voiceReleaseSeconds(value: number): number { return 0.005 * 144 ** (value / 100); }

function blep(phase: number, step: number): number {
  if (phase < step) { const t = phase / step; return 2 * t - t * t - 1; }
  if (phase > 1 - step) { const t = (phase - 1) / step; return t * t + 2 * t + 1; }
  return 0;
}
function saw(phase: number, step: number): number { return 2 * phase - 1 - blep(phase, step); }

/** Five genuinely distinct, bounded carrier spectra with preallocated scalar state. */
export class BrowserOfficialVoiceOscillator {
  private phase = 0;
  private lowerPhase = 0.31;
  private upperPhase = 0.67;
  private step = 110 / 48000;
  private lowerStep = this.step;
  private upperStep = this.step;
  private waveform: OfficialVoiceWaveform = 0;
  readonly sampleRate: number;
  constructor(sampleRate: number) { this.sampleRate = sampleRate; this.setFrequency(110); }
  setWaveform(waveform: OfficialVoiceWaveform): void { this.waveform = waveform; }
  setFrequency(frequencyHz: number): void {
    this.step = Math.max(0, Math.min(0.44, frequencyHz / this.sampleRate));
    this.lowerStep = this.step * 2 ** (-7 / 1200);
    this.upperStep = this.step * 2 ** (7 / 1200);
  }
  processSample(): number {
    const phase = this.phase;
    const step = this.step;
    if (step <= 0) return 0;
    let output: number;
    if (this.waveform === 0) output = saw(phase, step);
    else if (this.waveform === 1) {
      // A rounded saw: a different harmonic distribution, not a gain alias.
      output = 0.72 * saw(phase, step) - 0.28 * Math.sin(2 * Math.PI * phase);
    } else if (this.waveform === 2) {
      output = (saw(phase, step) + saw(this.lowerPhase, this.lowerStep) + saw(this.upperPhase, this.upperStep)) / 3;
    } else {
      const duty = this.waveform === 3 ? 0.5 : 0.25;
      const edge = phase >= duty ? phase - duty : phase + 1 - duty;
      output = (phase < duty ? 1 : -1) + blep(phase, step) - blep(edge, step) - (2 * duty - 1);
    }
    this.phase += step; if (this.phase >= 1) this.phase -= 1;
    this.lowerPhase += this.lowerStep; if (this.lowerPhase >= 1) this.lowerPhase -= 1;
    this.upperPhase += this.upperStep; if (this.upperPhase >= 1) this.upperPhase -= 1;
    return output;
  }
  reset(): void { this.phase = 0; this.lowerPhase = 0.31; this.upperPhase = 0.67; }
}
