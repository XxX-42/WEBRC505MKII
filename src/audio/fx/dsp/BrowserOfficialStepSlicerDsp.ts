/** Authored step-level sequencer with linked compression. STEP LENGTH is a
 * shared gate-duty percentage, an explicit clean-room law rather than a
 * measured hardware timing curve. No factory pattern table is implied. */
export interface BrowserOfficialStepSlicerParameters {
  rateHz?: number; stepMax?: number; stepLength?: number; depth?: number;
  compThreshold?: number; compGain?: number; levels?: ArrayLike<number>;
}
const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));
export class BrowserOfficialStepSlicerDsp {
  readonly sampleRate: number;
  wetLeft = 0;
  wetRight = 0;
  private rateHz = 2;
  private stepMax = 16;
  private duty = 0.5;
  private depth = 1;
  private threshold = -30;
  private makeup = 10 ** (6 / 20);
  private readonly levels = new Float64Array(16).fill(1);
  private phase = 0;
  private step = 0;
  private gate = 1;
  private envelope = 0;
  private readonly gateAlpha: number;
  private readonly attackAlpha: number;
  private readonly releaseAlpha: number;
  constructor(sampleRate = 48000, parameters: BrowserOfficialStepSlicerParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.gateAlpha = Math.exp(-1 / (this.sampleRate * 0.002));
    this.attackAlpha = Math.exp(-1 / (this.sampleRate * 0.005));
    this.releaseAlpha = Math.exp(-1 / (this.sampleRate * 0.08));
    this.setParameters(parameters);
  }
  get stepIndex(): number { return this.step; }
  setParameters(parameters: BrowserOfficialStepSlicerParameters): void {
    if (Number.isFinite(parameters.rateHz)) this.rateHz = clamp(parameters.rateHz!, 0.0001, 160);
    if (Number.isFinite(parameters.stepMax)) { this.stepMax = Math.round(clamp(parameters.stepMax!, 1, 16)); this.step %= this.stepMax; }
    if (Number.isFinite(parameters.stepLength)) this.duty = clamp(parameters.stepLength!, 1, 100) / 100;
    if (Number.isFinite(parameters.depth)) this.depth = clamp(parameters.depth!, 0, 100) / 100;
    if (Number.isFinite(parameters.compThreshold)) this.threshold = clamp(parameters.compThreshold!, -30, 0);
    if (Number.isFinite(parameters.compGain)) this.makeup = 10 ** (clamp(parameters.compGain!, 0, 20) / 20);
    if (parameters.levels) for (let i = 0; i < 16; i += 1) {
      const value = parameters.levels[i];
      if (Number.isFinite(value)) this.levels[i] = clamp(value!, 0, 100) / 100;
    }
  }
  processSample(left: number, right: number): this {
    const l = Number.isFinite(left) ? clamp(left, -8, 8) : 0;
    const r = Number.isFinite(right) ? clamp(right, -8, 8) : 0;
    const amplitude = Math.max(Math.abs(l), Math.abs(r));
    const alpha = amplitude > this.envelope ? this.attackAlpha : this.releaseAlpha;
    this.envelope = alpha * this.envelope + (1 - alpha) * amplitude;
    const above = Math.max(0, 20 * Math.log10(Math.max(1e-12, this.envelope)) - this.threshold);
    const compressorGain = this.makeup * 10 ** (-0.75 * above / 20); // 4:1 linked compressor
    const target = this.phase < this.duty ? this.levels[this.step]! : 0;
    this.gate = this.gateAlpha * this.gate + (1 - this.gateAlpha) * target;
    const gain = (1 - this.depth + this.depth * this.gate) * compressorGain;
    this.wetLeft = clamp(l * gain, -8, 8);
    this.wetRight = clamp(r * gain, -8, 8);
    this.phase += this.rateHz / this.sampleRate;
    if (this.phase >= 1) { this.phase -= 1; this.step = (this.step + 1) % this.stepMax; }
    return this;
  }
  reset(): void { this.phase = 0; this.step = 0; this.gate = 1; this.envelope = 0; this.wetLeft = 0; this.wetRight = 0; }
}
