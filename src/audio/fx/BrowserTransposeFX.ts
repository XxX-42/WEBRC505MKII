import { officialPitchDefaults } from './dsp/OfficialPitchParameters';
import { createLiveInputTransposeNode, type LiveInputTransposeNode } from '../pitch/signalsmith';
import type { FXBase } from './FXBase';

type FailureHandler = (error: Error) => void;

/** Signalsmith-backed live-input TRANSPOSE for the Browser Input/Track FX banks. */
export class BrowserTransposeFX implements FXBase {
  readonly name = 'TRANSPOSE';
  readonly algorithm = 'transpose';
  readonly input: GainNode;
  readonly output: GainNode;
  readonly ready: Promise<void>;

  private readonly context: AudioContext;
  private readonly directGain: GainNode;
  private readonly dryDelay: DelayNode;
  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly onFailure?: FailureHandler;
  private pitchNode: LiveInputTransposeNode | null = null;
  private bypassed = true;
  private disposed = false;
  private failed = false;
  private unsupportedOfficialMode = false;
  private semitones = 0;
  private mix = 1;
  private readonly officialParameters: Record<string, number> = {};
  private officialInitialized = false;
  public error = '';

  /** Ready only after the context-wide Signalsmith reservation is confirmed. */
  get processorReady(): boolean { return this.pitchNode !== null && !this.disposed && !this.error; }

  constructor(context: AudioContext, onFailure?: FailureHandler) {
    this.context = context;
    this.onFailure = onFailure;
    this.input = context.createGain();
    this.output = context.createGain();
    this.directGain = context.createGain();
    this.dryDelay = context.createDelay(0.1);
    this.dryGain = context.createGain();
    this.wetGain = context.createGain();
    this.directGain.gain.value = 1;
    this.dryGain.gain.value = 0;
    this.wetGain.gain.value = 0;

    // A true bypass is zero-latency. The active dry path is delayed to match
    // Signalsmith so changing mix cannot create a doubled/comb-filtered signal.
    this.input.connect(this.directGain);
    this.directGain.connect(this.output);
    this.input.connect(this.dryDelay);
    this.dryDelay.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.ready = this.installProcessor();
    this.applyRouting();
  }

  get latencySeconds(): number {
    return this.pitchNode?.latencySeconds ?? 0;
  }

  get latencySamples(): number {
    return this.pitchNode?.latencySamples ?? 0;
  }

  setParam(key: string, value: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(value)) {
      this.failClosed(`TRANSPOSE ${key} must be a finite number.`);
      return;
    }

    if (key === 'official_mode') {
      this.unsupportedOfficialMode = true;
      this.failClosed('TRANSPOSE official MODE 1/2 algorithms are unsupported; this implementation uses Signalsmith.');
      return;
    }
    if (key === 'official_trans') {
      if (!Number.isInteger(value) || value < -12 || value > 12) {
        this.failClosed('TRANSPOSE official TRANS must be an integer from -12 to +12.');
        return;
      }
      this.initializeOfficialParameters(key);
      this.officialParameters[key] = value;
      key = 'shift';
    }

    if (key === 'shift') {
      if (value < -24 || value > 24) {
        this.failClosed('TRANSPOSE shift must be between -24 and +24 semitones.');
        return;
      }
      this.semitones = value;
      this.clearParameterFailure();
      if (this.pitchNode) void this.updatePitch(value);
      this.applyRouting();
      return;
    }

    if (key === 'mix') {
      if (value < 0 || value > 100) {
        this.failClosed('TRANSPOSE mix must be between 0 and 100 percent.');
        return;
      }
      this.mix = value / 100;
      this.clearParameterFailure();
      this.applyRouting();
      return;
    }

    this.failClosed(`TRANSPOSE does not support the ${key} parameter.`);
  }

  private initializeOfficialParameters(exceptKey: string): void {
    if (this.officialInitialized) return;
    this.officialInitialized = true;
    for (const [key, value] of Object.entries(officialPitchDefaults(this.name, this.algorithm))) {
      if (key !== exceptKey) this.setParam(key, value);
    }
  }

  setBypass(bypass: boolean): void {
    this.bypassed = bypass;
    this.applyRouting();
  }

  getParameterSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({ shift: this.semitones, mix: this.mix * 100, ...this.officialParameters });
  }

  dispose(): void {
    this.disposed = true;
    this.input.disconnect();
    this.directGain.disconnect();
    this.dryDelay.disconnect();
    this.dryGain.disconnect();
    this.pitchNode?.disconnect();
    this.wetGain.disconnect();
    this.output.disconnect();
    this.pitchNode = null;
  }

  private async installProcessor(): Promise<void> {
    try {
      const initialSemitones = this.semitones;
      const node = await createLiveInputTransposeNode(this.context, {
        mode: 'LIVE_FX',
        channels: 2,
        semitones: initialSemitones,
      });
      if (this.disposed) {
        node.disconnect();
        return;
      }

      this.pitchNode = node;
      this.dryDelay.delayTime.value = node.latencySeconds;
      this.input.connect(node);
      node.connect(this.wetGain);
      this.wetGain.connect(this.output);
      if (!this.failed && !this.unsupportedOfficialMode) this.error = '';

      if (this.semitones !== initialSemitones) await this.updatePitch(this.semitones);
      this.applyRouting();
    } catch (cause) {
      if (this.disposed) return;
      this.failed = true;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.reportError(`Browser TRANSPOSE unavailable: ${error.message}`);
      this.applyRouting();
    }
  }

  private async updatePitch(value: number): Promise<void> {
    const node = this.pitchNode;
    if (!node) return;
    try {
      await node.setPitch(value);
    } catch (cause) {
      if (this.disposed) return;
      this.failed = true;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.reportError(`Browser TRANSPOSE pitch update failed: ${error.message}`);
      this.applyRouting();
    }
  }

  private failClosed(message: string): void {
    this.failed = true;
    this.reportError(message);
    this.applyRouting();
  }

  private clearParameterFailure(): void {
    // A valid control must never erase an installation/runtime failure while
    // there is no processor to make the effect audible.
    if (!this.pitchNode || this.unsupportedOfficialMode) return;
    this.failed = false;
    this.error = '';
  }

  private reportError(message: string): void {
    if (this.error === message) return;
    this.error = message;
    this.onFailure?.(new Error(message));
  }

  private applyRouting(): void {
    const direct = this.bypassed || this.failed || !this.pitchNode ? 1 : 0;
    const wet = direct ? 0 : this.mix;
    const dry = direct ? 0 : 1 - this.mix;
    const now = this.context.currentTime;
    for (const [gain, value] of [
      [this.directGain, direct],
      [this.dryGain, dry],
      [this.wetGain, wet],
    ] as const) {
      gain.gain.setTargetAtTime(value, now, 0.005);
    }
  }
}
