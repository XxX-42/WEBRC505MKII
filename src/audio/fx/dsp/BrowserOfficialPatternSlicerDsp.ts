/** Authored 16-step software patterns, NOT the unavailable factory P01..20 ROM. */
export const BROWSER_AUTHORED_SLICER_PATTERNS: readonly (readonly number[])[] = [
  [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
  [1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0],
  [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0],
  [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1],
];

export interface BrowserOfficialPatternSlicerParameters {
  rateHz?: number; duty?: number; attack?: number; depth?: number;
  compThreshold?: number; compGain?: number; softwarePattern?: number;
}
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
/** Clean-room manual controls. ATTACK controls onset volume, not rise time:
 * 1+3*(ATTACK/100)*exp(-stepPhase/.1), gated by DUTY and the software pattern.
 * Linked compression is 4:1,5ms attack/80ms release; gate smoothing is2ms.
 * Factory PATTERN is deliberately not accepted or claimed. */
export class BrowserOfficialPatternSlicerDsp {
  readonly sampleRate: number;
  wetLeft = 0; wetRight = 0;
  private rateHz = 2; private duty = 0.5; private attack = 0.35; private depth = 1;
  private threshold = -30; private makeup = 10 ** (2 / 20); private pattern = 0;
  private phase = 0; private step = 0; private gate = 1; private envelope = 0;
  private readonly gateAlpha: number; private readonly attackAlpha: number; private readonly releaseAlpha: number;
  constructor(sampleRate = 48000, parameters: BrowserOfficialPatternSlicerParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.gateAlpha = Math.exp(-1 / (this.sampleRate * .002));
    this.attackAlpha = Math.exp(-1 / (this.sampleRate * .005));
    this.releaseAlpha = Math.exp(-1 / (this.sampleRate * .08));
    this.setParameters(parameters);
  }
  get stepIndex(): number { return this.step; }
  setParameters(p: BrowserOfficialPatternSlicerParameters): void {
    if (Number.isFinite(p.rateHz)) this.rateHz = clamp(p.rateHz!, .0001, 160);
    if (Number.isFinite(p.duty)) this.duty = clamp(p.duty!, 1, 99) / 100;
    if (Number.isFinite(p.attack)) this.attack = clamp(p.attack!, 0, 100) / 100;
    if (Number.isFinite(p.depth)) this.depth = clamp(p.depth!, 0, 100) / 100;
    if (Number.isFinite(p.compThreshold)) this.threshold = clamp(p.compThreshold!, -30, 0);
    if (Number.isFinite(p.compGain)) this.makeup = 10 ** (clamp(p.compGain!, 0, 20) / 20);
    if (Number.isFinite(p.softwarePattern)) this.pattern = Math.round(clamp(p.softwarePattern!, 0, 7));
  }
  processSample(left: number, right: number): this {
    const l = Number.isFinite(left) ? clamp(left, -8, 8) : 0, r = Number.isFinite(right) ? clamp(right, -8, 8) : 0;
    const level = Math.max(Math.abs(l), Math.abs(r));
    const alpha = level > this.envelope ? this.attackAlpha : this.releaseAlpha;
    this.envelope = alpha * this.envelope + (1 - alpha) * level;
    const above = Math.max(0, 20 * Math.log10(Math.max(1e-12, this.envelope)) - this.threshold);
    const compressor = this.makeup * 10 ** (-.75 * above / 20);
    const active = BROWSER_AUTHORED_SLICER_PATTERNS[this.pattern]![this.step]!;
    const target = this.phase < this.duty ? active * (1 + 3 * this.attack * Math.exp(-this.phase / .1)) : 0;
    this.gate = this.gateAlpha * this.gate + (1 - this.gateAlpha) * target;
    const gain = (1 - this.depth + this.depth * this.gate) * compressor;
    this.wetLeft = clamp(l * gain, -8, 8); this.wetRight = clamp(r * gain, -8, 8);
    this.phase += this.rateHz / this.sampleRate;
    if (this.phase >= 1) { this.phase -= 1; this.step = (this.step + 1) & 15; }
    return this;
  }
  reset(): void { this.phase = 0; this.step = 0; this.gate = 1; this.envelope = 0; this.wetLeft = this.wetRight = 0; }
}
