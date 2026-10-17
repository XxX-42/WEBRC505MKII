export type TptSvfOutput = 'lowpass' | 'bandpass' | 'highpass';

/**
 * Topology-preserving-transform (TPT) state-variable filter. All three modes
 * are updated together so one instance can feed a multi-mode FX without
 * repeated filter work. `processSample` returns the lowpass value and stores
 * the current band/highpass values in public scalar fields.
 */
export class TptStateVariableFilter {
  readonly sampleRate: number;
  lowpass = 0;
  bandpass = 0;
  highpass = 0;

  private integrator1 = 0;
  private integrator2 = 0;
  private k = Math.SQRT2;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;

  constructor(sampleRate: number, cutoffHz = 1000, q = Math.SQRT1_2) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    this.setParameters(cutoffHz, q);
  }

  setParameters(cutoffHz: number, q = Math.SQRT1_2): boolean {
    if (!Number.isFinite(cutoffHz) || !Number.isFinite(q)) return false;
    const cutoff = Math.max(0.001, Math.min(this.sampleRate * 0.499, cutoffHz));
    const safeQ = Math.max(0.05, Math.min(100, q));
    const g = Math.tan((Math.PI * cutoff) / this.sampleRate);
    const k = 1 / safeQ;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    this.k = k;
    this.a1 = a1;
    this.a2 = a2;
    this.a3 = g * a2;
    return true;
  }

  processSample(input: number): number {
    const v3 = input - this.integrator2;
    const v1 = this.a1 * this.integrator1 + this.a2 * v3;
    const v2 = this.integrator2 + this.a2 * this.integrator1 + this.a3 * v3;
    this.integrator1 = 2 * v1 - this.integrator1;
    this.integrator2 = 2 * v2 - this.integrator2;

    this.lowpass = v2;
    this.bandpass = v1;
    this.highpass = input - this.k * v1 - v2;
    return this.lowpass;
  }

  processBuffer(
    input: Float32Array,
    output: Float32Array,
    mode: TptSvfOutput = 'lowpass',
    length = Math.min(input.length, output.length),
  ): void {
    const count = Math.max(0, Math.min(Math.floor(length), input.length, output.length));
    for (let index = 0; index < count; index += 1) {
      this.processSample(input[index] ?? 0);
      output[index] = mode === 'bandpass' ? this.bandpass : mode === 'highpass' ? this.highpass : this.lowpass;
    }
  }

  reset(): void {
    this.integrator1 = 0;
    this.integrator2 = 0;
    this.lowpass = 0;
    this.bandpass = 0;
    this.highpass = 0;
  }
}
