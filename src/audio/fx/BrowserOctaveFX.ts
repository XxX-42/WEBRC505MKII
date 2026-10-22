import { officialPitchDefaults } from './dsp/OfficialPitchParameters';
import { createLiveInputTransposeNode, type LiveInputTransposeNode } from '../pitch/signalsmith';
import type { FXBase } from './FXBase';

type FailureHandler = (error: Error) => void;
type FailureKind = 'parameter' | 'runtime' | null;

const VOICE_SEMITONES = [-24, -12, 12] as const;
const MAX_LIVE_LATENCY_SECONDS = 0.025;
const MAX_ALIGNMENT_DELAY_SECONDS = 0.1;

/**
 * Three independent connected Signalsmith voices for the browser OCTAVE FX.
 * The effect keeps dry audio at unity and aligns it to the slowest voice;
 * bypass switches directly to a separate zero-latency dry route. Formant and
 * tracking controls are not implemented by the current live-input adapter.
 */
export class BrowserOctaveFX implements FXBase {
  readonly name = 'OCTAVE';
  readonly algorithm = 'octave';
  readonly input: GainNode;
  readonly output: GainNode;
  readonly ready: Promise<void>;

  private readonly context: AudioContext;
  private readonly directGain: GainNode;
  private readonly dryDelay: DelayNode;
  private readonly dryGain: GainNode;
  private readonly voiceAlignmentDelays: [DelayNode, DelayNode, DelayNode];
  private readonly voiceGains: [GainNode, GainNode, GainNode];
  private readonly onFailure?: FailureHandler;
  private voiceNodes: [LiveInputTransposeNode, LiveInputTransposeNode, LiveInputTransposeNode] | null = null;
  private levels: [number, number, number] = [0, 40, 0];
  private mixPercent = 70;
  private officialOctave = 0;
  private officialOctLevel = 50;
  private officialActive = false;
  private bypassed = true;
  private disposed = false;
  private failed = false;
  private failureKind: FailureKind = null;
  private failedParameterKey: string | null = null;
  private voicesReady = false;
  private readonly officialParameters: Record<string, number> = {};
  private officialInitialized = false;
  public error = '';

  /** The private A–D chain acknowledges OCTAVE after all three voices exist. */
  get processorReady(): boolean { return this.voicesReady && !this.disposed && !this.error; }

  constructor(context: AudioContext, onFailure?: FailureHandler) {
    this.context = context;
    this.onFailure = onFailure;
    this.input = context.createGain();
    this.output = context.createGain();
    this.directGain = context.createGain();
    this.dryDelay = context.createDelay(MAX_ALIGNMENT_DELAY_SECONDS);
    this.dryGain = context.createGain();
    this.voiceAlignmentDelays = [
      context.createDelay(MAX_ALIGNMENT_DELAY_SECONDS),
      context.createDelay(MAX_ALIGNMENT_DELAY_SECONDS),
      context.createDelay(MAX_ALIGNMENT_DELAY_SECONDS),
    ];
    this.voiceGains = [context.createGain(), context.createGain(), context.createGain()];

    // Keep bypass on a direct route so it has no Signalsmith/dry alignment latency.
    this.input.connect(this.directGain);
    this.directGain.connect(this.output);
    this.input.connect(this.dryDelay);
    this.dryDelay.connect(this.dryGain);
    this.dryGain.connect(this.output);
    for (let index = 0; index < this.voiceAlignmentDelays.length; index += 1) {
      this.voiceAlignmentDelays[index]!.connect(this.voiceGains[index]!);
      this.voiceGains[index]!.connect(this.output);
    }
    this.applyRouting();
    this.ready = this.installVoices();
  }

  get latencySeconds(): number {
    if (!this.voiceNodes) return 0;
    return Math.max(...this.voiceNodes.map((node) => node.latencySeconds));
  }

  get latencySamples(): number {
    if (!this.voiceNodes) return 0;
    return Math.max(...this.voiceNodes.map((node) => node.latencySamples));
  }

  /** Shared Browser amount macro controls the overall harmony-layer mix. */
  setAmount(value: number): void {
    if (!Number.isFinite(value)) return;
    const official = { ...this.officialParameters };
    this.setParam('mix_percent', Math.max(0, Math.min(1, value)) * 100);
    for (const [key, selected] of Object.entries(official)) this.setParam(key, selected);
  }

  setParam(key: string, value: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(value)) {
      this.failClosed(`OCTAVE ${key} must be a finite number.`, key);
      return;
    }

    if (key === 'official_mode') {
      this.failClosed('OCTAVE official MODE 1/2 algorithms are unsupported; this implementation uses Signalsmith.', key);
      return;
    }
    if (key === 'official_octave' || key === 'official_oct_level') {
      const max = key === 'official_octave' ? 2 : 100;
      if (!Number.isInteger(value) || value < 0 || value > max) {
        this.failClosed(`OCTAVE ${key} must be an integer from 0 to ${max}.`, key);
        return;
      }
      this.initializeOfficialParameters(key);
      this.officialParameters[key] = value;
      this.officialActive = true;
      if (key === 'official_octave') this.officialOctave = value;
      else this.officialOctLevel = value;
      this.clearParameterFailure(key);
      this.applyRouting();
      return;
    }

    if (key === 'mix_percent') {
      this.officialActive = false;
      if (value < 0 || value > 100) {
        this.failClosed('OCTAVE mix_percent must be between 0 and 100 percent.', key);
        return;
      }
      this.mixPercent = value;
      this.clearParameterFailure(key);
      this.applyRouting();
      return;
    }

    const voiceIndex = this.voiceIndexForKey(key);
    if (voiceIndex !== null) {
      if (value < 0 || value > 100) {
        this.failClosed(`OCTAVE ${key} must be between 0 and 100 percent.`, key);
        return;
      }
      this.officialActive = false;
      this.levels[voiceIndex] = value;
      this.clearParameterFailure(key);
      this.applyRouting();
      return;
    }

    const unsupported = key === 'formant'
      ? 'OCTAVE formant processing is unavailable in the Browser Signalsmith live-input adapter.'
      : key === 'tracking_sensitivity' || key === 'tracking_percent' || key === 'tracking'
        ? 'OCTAVE tracking sensitivity is unavailable in the Browser Signalsmith live-input adapter.'
        : `OCTAVE does not support the ${key} parameter.`;
    this.failClosed(unsupported, key);
  }

  private initializeOfficialParameters(exceptKey: string): void {
    if (this.officialInitialized) return;
    this.officialInitialized = true;
    for (const [key, value] of Object.entries(officialPitchDefaults(this.name, this.algorithm))) {
      if (key !== exceptKey) this.setParam(key, value);
    }
  }

  setBypass(bypass: boolean): void {
    if (this.disposed) return;
    this.bypassed = bypass;
    this.applyRouting();
  }

  getParameterSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      minus_24_level: this.levels[0],
      minus_12_level: this.levels[1],
      plus_12_level: this.levels[2],
      mix_percent: this.mixPercent,
      ...this.officialParameters,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.disconnect();
    this.directGain.disconnect();
    this.dryDelay.disconnect();
    this.dryGain.disconnect();
    for (const delay of this.voiceAlignmentDelays) delay.disconnect();
    for (const gain of this.voiceGains) gain.disconnect();
    for (const node of this.voiceNodes ?? []) node.disconnect();
    this.output.disconnect();
    this.voiceNodes = null;
  }

  private async installVoices(): Promise<void> {
    const results = await Promise.allSettled(
      VOICE_SEMITONES.map((semitones) => createLiveInputTransposeNode(this.context, {
        mode: 'LIVE_FX',
        channels: 2,
        semitones,
      })),
    );
    const createdNodes = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failedResult = results.find((result) => result.status === 'rejected');

    if (this.disposed) {
      createdNodes.forEach((node) => node.disconnect());
      return;
    }
    if (failedResult?.status === 'rejected') {
      createdNodes.forEach((node) => node.disconnect());
      const cause = failedResult.reason;
      this.failRuntime(`Browser OCTAVE voices unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    if (createdNodes.length !== VOICE_SEMITONES.length) {
      createdNodes.forEach((node) => node.disconnect());
      this.failRuntime('Browser OCTAVE did not receive all three independent voices.');
      return;
    }

    const [minus24, minus12, plus12] = createdNodes as [
      LiveInputTransposeNode,
      LiveInputTransposeNode,
      LiveInputTransposeNode,
    ];
    const latencies = [minus24.latencySeconds, minus12.latencySeconds, plus12.latencySeconds];
    if (latencies.some((latency) => !Number.isFinite(latency) || latency < 0 || latency > MAX_LIVE_LATENCY_SECONDS)) {
      createdNodes.forEach((node) => node.disconnect());
      this.failRuntime('Browser OCTAVE received an unsupported voice latency.');
      return;
    }

    const maxLatency = Math.max(...latencies);
    if (maxLatency > MAX_ALIGNMENT_DELAY_SECONDS) {
      createdNodes.forEach((node) => node.disconnect());
      this.failRuntime('Browser OCTAVE received a voice latency beyond the available alignment delay.');
      return;
    }

    this.voiceNodes = [minus24, minus12, plus12];
    this.dryDelay.delayTime.value = maxLatency;
    for (let index = 0; index < this.voiceAlignmentDelays.length; index += 1) {
      this.voiceAlignmentDelays[index]!.delayTime.value = maxLatency - latencies[index]!;
    }

    try {
      this.input.connect(minus24);
      this.input.connect(minus12);
      this.input.connect(plus12);
      minus24.connect(this.voiceAlignmentDelays[0]);
      minus12.connect(this.voiceAlignmentDelays[1]);
      plus12.connect(this.voiceAlignmentDelays[2]);
    } catch (cause) {
      createdNodes.forEach((node) => node.disconnect());
      this.voiceNodes = null;
      this.failRuntime(`Browser OCTAVE voice routing failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }

    this.voicesReady = true;
    this.applyRouting();
  }

  private voiceIndexForKey(key: string): 0 | 1 | 2 | null {
    if (key === 'minus_24_level') return 0;
    if (key === 'minus_12_level') return 1;
    if (key === 'plus_12_level') return 2;
    return null;
  }

  private failClosed(message: string, parameterKey: string): void {
    this.failed = true;
    if (this.failureKind !== 'runtime') {
      this.failureKind = 'parameter';
      this.failedParameterKey = parameterKey;
    }
    this.reportError(message);
    this.applyRouting();
  }

  private failRuntime(message: string): void {
    this.failed = true;
    this.failureKind = 'runtime';
    this.failedParameterKey = null;
    this.reportError(message);
    this.applyRouting();
  }

  private clearParameterFailure(parameterKey: string): void {
    if (this.failureKind !== 'parameter' || this.failedParameterKey !== parameterKey) return;
    this.failed = false;
    this.failureKind = null;
    this.failedParameterKey = null;
    this.error = '';
  }

  private reportError(message: string): void {
    if (this.error === message) return;
    this.error = message;
    this.onFailure?.(new Error(message));
  }

  private applyRouting(): void {
    const direct = this.bypassed || this.failed || !this.voicesReady ? 1 : 0;
    const dry = direct ? 0 : 1;
    const now = this.context.currentTime;
    this.directGain.gain.setTargetAtTime(direct, now, 0.005);
    this.dryGain.gain.setTargetAtTime(dry, now, 0.005);
    for (let index = 0; index < this.voiceGains.length; index += 1) {
      const selected = index === 0 ? this.officialOctave !== 0 : index === 1 ? this.officialOctave !== 1 : false;
      const voice = direct ? 0 : this.officialActive
        ? (selected ? this.officialOctLevel / 100 : 0)
        : (this.levels[index]! / 100) * (this.mixPercent / 100);
      this.voiceGains[index]!.gain.setTargetAtTime(voice, now, 0.005);
    }
  }
}
