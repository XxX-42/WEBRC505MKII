import { officialPitchDefaults } from './dsp/OfficialPitchParameters';
import { createLiveInputTransposeNode, type LiveInputTransposeNode } from '../pitch/signalsmith';
import type { FXBase } from './FXBase';

type FailureHandler = (error: Error) => void;
type FailureKind = 'parameter' | 'runtime' | null;

const MAX_PITCH_POINT_INTERVAL_MS = 20;
const MAX_BEND_TIME_MS = 4000;

/** Connected Signalsmith pitch-bend voice for the Browser Input/Track FX banks. */
export class BrowserPitchBendFX implements FXBase {
  readonly name = 'PITCH BEND';
  readonly algorithm = 'pitch-bend';
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
  private failureKind: FailureKind = null;
  private recoveryPending = false;
  private recoveryRequested = false;
  private range = 12;
  private officialPitchOctaves = 4;
  private officialBendPercent = 50;
  private officialBendActive = false;
  private timeMs = 500;
  private direction: 0 | 1 = 0;
  private mix = 1;
  private sweepGeneration = 0;
  private readonly officialParameters: Record<string, number> = {};
  private officialInitialized = false;
  public error = '';

  /** The private A–D chain waits for this voice before acknowledging it. */
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

    // Bypass is truly zero-latency. Active dry is delayed to match Signalsmith.
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

  /** Shared macro contract: 0–100 maps linearly to the 0–24 semitone range. */
  setAmount(value: number): void {
    if (!Number.isFinite(value)) return;
    const official = { ...this.officialParameters };
    this.setParam('range', Math.max(0, Math.min(1, value)) * 24);
    for (const [key, selected] of Object.entries(official)) this.setParam(key, selected);
  }

  setParam(key: string, value: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(value)) {
      this.failClosed(`PITCH BEND ${key} must be a finite number.`);
      return;
    }

    if (key === 'official_mode') {
      this.unsupportedOfficialMode = true;
      this.failClosed('PITCH BEND official MODE 1/2 algorithms are unsupported; this implementation uses Signalsmith.');
      return;
    }
    if (key === 'official_pitch' || key === 'official_bend') {
      const valid = Number.isInteger(value) && (key === 'official_pitch' ? value >= -3 && value <= 4 : value >= 0 && value <= 100);
      if (!valid) {
        this.failClosed(`PITCH BEND ${key} is outside its official range.`);
        return;
      }
      this.initializeOfficialParameters(key);
      this.officialParameters[key] = value;
      this.officialBendActive = true;
      if (key === 'official_pitch') this.officialPitchOctaves = value;
      else this.officialBendPercent = value;
      this.recoverParameterFailureWhileBypassed();
      this.restartIfActive();
      this.applyRouting();
      return;
    }

    if (key === 'range') {
      this.officialBendActive = false;
      if (value < 0 || value > 24) {
        this.failClosed('PITCH BEND range must be between 0 and 24 semitones.');
        return;
      }
      if (value === this.range) {
        this.recoverParameterFailureWhileBypassed();
        this.restartIfActive();
        this.applyRouting();
        return;
      }
      this.range = value;
      this.recoverParameterFailureWhileBypassed();
      this.restartIfActive();
      this.applyRouting();
      return;
    }

    if (key === 'time_ms') {
      if (value < 20 || value > MAX_BEND_TIME_MS) {
        this.failClosed('PITCH BEND time_ms must be between 20 and 4000 milliseconds.');
        return;
      }
      if (value === this.timeMs) {
        this.recoverParameterFailureWhileBypassed();
        this.restartIfActive();
        this.applyRouting();
        return;
      }
      this.officialBendActive = false;
      this.timeMs = value;
      this.recoverParameterFailureWhileBypassed();
      this.restartIfActive();
      this.applyRouting();
      return;
    }

    if (key === 'direction') {
      if (value !== 0 && value !== 1) {
        this.failClosed('PITCH BEND direction must be 0 (Up) or 1 (Down).');
        return;
      }
      if (value === this.direction) {
        this.recoverParameterFailureWhileBypassed();
        this.restartIfActive();
        this.applyRouting();
        return;
      }
      this.officialBendActive = false;
      this.direction = value;
      this.recoverParameterFailureWhileBypassed();
      this.restartIfActive();
      this.applyRouting();
      return;
    }

    if (key === 'mix_percent') {
      if (value < 0 || value > 100) {
        this.failClosed('PITCH BEND mix_percent must be between 0 and 100 percent.');
        return;
      }
      this.mix = value / 100;
      this.applyRouting();
      return;
    }

    this.failClosed(`PITCH BEND does not support the ${key} parameter.`);
  }

  private initializeOfficialParameters(exceptKey: string): void {
    if (this.officialInitialized) return;
    this.officialInitialized = true;
    for (const [key, value] of Object.entries(officialPitchDefaults(this.name, this.algorithm))) {
      if (key !== exceptKey) this.setParam(key, value);
    }
  }

  setBypass(bypass: boolean): void {
    if (this.disposed || this.bypassed === bypass) return;
    this.bypassed = bypass;
    if (bypass) {
      this.sweepGeneration += 1;
      void this.schedulePitch(0, this.nextOutputTime(), this.sweepGeneration, true).catch(() => undefined);
    } else if (this.pitchNode) {
      // A valid bypass/reactivate cycle may retry a transient scheduler failure.
      // Invalid-parameter failures still require a valid pitch control update.
      if (this.failureKind === 'runtime') this.recoveryRequested = true;
      this.startSweep();
    }
    this.applyRouting();
  }

  getParameterSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({ range: this.range, time_ms: this.timeMs, direction: this.direction, mix_percent: this.mix * 100, ...this.officialParameters });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sweepGeneration += 1;
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
      const node = await createLiveInputTransposeNode(this.context, {
        mode: 'LIVE_FX',
        pitchRange: 'official-bend',
        channels: 2,
        semitones: 0,
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
      if (this.failureKind !== 'parameter' && !this.unsupportedOfficialMode) {
        this.failed = false; this.failureKind = null;
        this.recoveryPending = false; this.recoveryRequested = false; this.error = '';
      }
      if (!this.bypassed) this.startSweep();
      this.applyRouting();
    } catch (cause) {
      if (this.disposed) return;
      this.failed = true;
      this.failureKind = 'runtime';
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.reportError(`Browser PITCH BEND unavailable: ${error.message}`);
      this.applyRouting();
    }
  }

  private restartIfActive(): void {
    if (!this.pitchNode || this.bypassed || this.unsupportedOfficialMode) return;
    if (this.failed) this.recoveryRequested = true;
    this.startSweep();
  }

  private startSweep(): void {
    const node = this.pitchNode;
    if (!node || this.disposed || this.bypassed || (this.failed && !this.recoveryRequested)) return;
    this.recoveryPending = this.failed;
    const generation = ++this.sweepGeneration;
    const startOutputTime = this.nextOutputTime();
    const target = this.direction === 0 ? this.range : -this.range;
    const durationMs = Math.max(20, Math.min(MAX_BEND_TIME_MS, this.timeMs));
    const pointCount = Math.max(1, Math.ceil(durationMs / MAX_PITCH_POINT_INTERVAL_MS));
    const scheduledPoints: Promise<void>[] = [];
    if (this.officialBendActive) {
      // BEND is a position, not a timed sweep. OCT units become semitones here.
      scheduledPoints.push(this.schedulePitch((this.officialPitchOctaves * 12 * this.officialBendPercent / 100) || 0, startOutputTime, generation, true));
    }

    // Points are inserted into the worklet's timeMap up front. The Signalsmith
    // adapter's bounded scheduler patch preserves pending future points until
    // the audio render clock reaches them.
    for (let index = 0; !this.officialBendActive && index <= pointCount; index += 1) {
      const elapsedMs = durationMs * (index / pointCount);
      const semitones = index === 0 ? 0 : target * (elapsedMs / durationMs);
      scheduledPoints.push(this.schedulePitch(
        semitones,
        startOutputTime + elapsedMs / 1000,
        generation,
        index === 0,
      ));
    }
    // Keep a recovering instance closed until every point in this retry has
    // been acknowledged, so a partial schedule can't expose a stale trajectory.
    void Promise.all(scheduledPoints).then(() => {
      if (this.disposed || generation !== this.sweepGeneration || !this.recoveryPending) return;
      if (!this.unsupportedOfficialMode) {
        this.failed = false; this.failureKind = null;
        this.recoveryPending = false; this.recoveryRequested = false; this.error = '';
      }
      this.applyRouting();
    }).catch(() => undefined);
  }

  private nextOutputTime(): number {
    return this.context.currentTime + (this.pitchNode?.latencySeconds ?? 0);
  }

  private schedulePitch(
    semitones: number,
    outputTime: number,
    generation: number,
    replaceFuture = false,
  ): Promise<void> {
    const node = this.pitchNode;
    if (!node || this.disposed || generation !== this.sweepGeneration) return Promise.resolve();
    try {
      return Promise.resolve(node.setPitch(semitones, outputTime, replaceFuture)).then(() => undefined).catch((cause: unknown) => {
        if (this.disposed || generation !== this.sweepGeneration) return;
        this.failed = true;
        this.failureKind = 'runtime';
        this.recoveryPending = false;
        this.recoveryRequested = false;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.reportError(`Browser PITCH BEND pitch scheduling failed: ${error.message}`);
        this.applyRouting();
        throw cause;
      });
    } catch (cause) {
      if (this.disposed || generation !== this.sweepGeneration) return Promise.resolve();
      this.failed = true;
      this.failureKind = 'runtime';
      this.recoveryPending = false;
      this.recoveryRequested = false;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.reportError(`Browser PITCH BEND pitch scheduling failed: ${error.message}`);
      this.applyRouting();
      return Promise.reject(cause);
    }
  }

  private failClosed(message: string): void {
    this.failed = true;
    this.failureKind = 'parameter';
    this.recoveryPending = false;
    this.recoveryRequested = false;
    this.sweepGeneration += 1;
    this.reportError(message);
    this.applyRouting();
  }

  private recoverParameterFailureWhileBypassed(): void {
    if (!this.pitchNode || this.unsupportedOfficialMode) return;
    if (this.bypassed && this.failureKind === 'parameter') {
      if (!this.unsupportedOfficialMode) {
        this.failed = false; this.failureKind = null;
        this.recoveryPending = false; this.recoveryRequested = false; this.error = '';
      }
    } else if (this.failureKind === 'runtime') {
      this.recoveryRequested = true;
    }
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
