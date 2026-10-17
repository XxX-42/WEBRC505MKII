import { createLiveInputTransposeNode, type LiveInputTransposeNode } from '../pitch/signalsmith';
import type { FXBase } from './FXBase';

type FailureHandler = (error: Error) => void;

interface AutoRiffPitchMessage {
  type?: unknown;
  message?: unknown;
  frame?: unknown;
  semitones?: unknown;
}

const RATE_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;

/**
 * Browser AUTO RIFF adapter: a sample-clocked worklet analyzes onsets/F0 and
 * emits bounded pitch-step events; the connected Signalsmith LIVE_FX node
 * performs the actual polyphonic pitch shift. Active dry audio is delayed by
 * the measured Signalsmith algorithm latency, while bypass remains direct.
 */
export class BrowserAutoRiffFX implements FXBase {
  readonly name = 'AUTO RIFF (EXPERIMENTAL)';
  readonly input: GainNode;
  readonly output: GainNode;
  readonly ready: Promise<void>;

  private readonly context: AudioContext;
  private readonly ensureModule: () => Promise<void>;
  private readonly onFailure?: FailureHandler;
  private readonly directGain: GainNode;
  private readonly dryDelay: DelayNode;
  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private analyzerNode: AudioWorkletNode | null = null;
  private pitchNode: LiveInputTransposeNode | null = null;
  private parameters: Record<string, number> = {
    autoRiffScale: 0,
    autoRiffRateBeats: 0.5,
    autoRiffSensitivityPercent: 55,
    bpm: 120,
  };
  private mix = 0.65;
  private bypassed = true;
  private disposed = false;
  private failed = false;
  public error = '';

  constructor(context: AudioContext, ensureModule: () => Promise<void>, onFailure?: FailureHandler) {
    this.context = context;
    this.ensureModule = ensureModule;
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
    this.input.connect(this.directGain);
    this.directGain.connect(this.output);
    this.dryDelay.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);
    this.ready = this.installProcessor();
  }

  get latencySamples(): number { return this.pitchNode?.latencySamples ?? 0; }
  get latencySeconds(): number { return this.pitchNode?.latencySeconds ?? 0; }

  setParam(key: string, value: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(value)) {
      this.failClosed(`AUTO RIFF ${key} must be finite.`);
      return;
    }

    if (key === 'amount') {
      if (value < 0 || value > 1) return this.failClosed('AUTO RIFF amount must be from 0 to 1.');
      this.mix = value;
      this.applyRouting();
      return;
    }

    if (key === 'mix' || key === 'mix_percent') {
      if (value < 0 || value > 100) return this.failClosed('AUTO RIFF mix must be from 0 to 100 percent.');
      this.mix = value / 100;
      this.applyRouting();
      return;
    }

    let parameterKey: string;
    let bounded: number;
    if (key === 'scale' || key === 'autoRiffScale') {
      if (!Number.isInteger(value) || value < 0 || value > 4) return this.failClosed('AUTO RIFF scale must be an integer from 0 to 4.');
      parameterKey = 'autoRiffScale';
      bounded = value;
    } else if (key === 'rate' || key === 'rate_beats' || key === 'autoRiffRateBeats') {
      const nearest = RATE_OPTIONS.reduce((previous, candidate) =>
        Math.abs(candidate - value) < Math.abs(previous - value) ? candidate : previous, RATE_OPTIONS[0]);
      if (Math.abs(nearest - value) > 1e-6) return this.failClosed('AUTO RIFF step rate must be 0.25, 0.5, 1, 2, or 4 beats.');
      parameterKey = 'autoRiffRateBeats';
      bounded = nearest;
    } else if (key === 'sensitivity' || key === 'sensitivity_percent' || key === 'autoRiffSensitivityPercent') {
      if (value < 0 || value > 100) return this.failClosed('AUTO RIFF onset sensitivity must be from 0 to 100 percent.');
      parameterKey = 'autoRiffSensitivityPercent';
      bounded = value;
    } else if (key === 'bpm' || key === 'tempo') {
      if (value < 30 || value > 300) return this.failClosed('AUTO RIFF tempo must be from 30 to 300 BPM.');
      parameterKey = 'bpm';
      bounded = value;
    } else {
      this.failClosed(`AUTO RIFF does not support the ${key} parameter.`);
      return;
    }

    this.parameters = { ...this.parameters, [parameterKey]: bounded };
    this.analyzerNode?.port.postMessage({ type: 'configure', parameters: { [parameterKey]: bounded } });
    this.clearParameterFailure();
  }

  setBypass(bypass: boolean): void {
    if (this.disposed) return;
    const reactivating = this.bypassed && !bypass;
    this.bypassed = bypass;
    if (reactivating) {
      this.analyzerNode?.port.postMessage({ type: 'reset' });
      const node = this.pitchNode;
      if (node) void node.setPitch(0, this.context.currentTime + node.latencySeconds, true).catch((cause) => this.failClosed(`AUTO RIFF reset failed: ${String(cause)}`));
    }
    this.analyzerNode?.port.postMessage({ type: 'set-bypass', value: bypass, rampFrames: 0 });
    this.applyRouting();
  }

  dispose(): void {
    this.disposed = true;
    this.input.disconnect();
    this.directGain.disconnect();
    this.dryDelay.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.analyzerNode?.disconnect();
    this.pitchNode?.disconnect();
    this.output.disconnect();
    this.analyzerNode = null;
    this.pitchNode = null;
  }

  private async installProcessor(): Promise<void> {
    try {
      await this.ensureModule();
      if (this.disposed) return;
      const pitchNode = await createLiveInputTransposeNode(this.context, {
        mode: 'LIVE_FX',
        channels: 2,
        semitones: 0,
      });
      if (this.disposed) {
        pitchNode.disconnect();
        return;
      }
      const analyzerNode = new AudioWorkletNode(this.context, 'rc505-fx-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: {
          algorithm: 'auto-riff',
          sampleRate: this.context.sampleRate,
          parameters: this.parameters,
          bypassed: true,
        },
      });
      this.analyzerNode = analyzerNode;
      this.pitchNode = pitchNode;
      this.dryDelay.delayTime.value = pitchNode.latencySeconds;
      this.input.connect(analyzerNode);
      analyzerNode.connect(pitchNode);
      analyzerNode.connect(this.dryDelay);
      pitchNode.connect(this.wetGain);
      analyzerNode.port.onmessage = (event: MessageEvent<unknown>) => this.handleAnalyzerMessage(event.data);
      analyzerNode.port.postMessage({ type: 'set-bypass', value: this.bypassed, rampFrames: 0 });
      this.failed = false;
      this.error = '';
      this.applyRouting();
    } catch (cause) {
      if (this.disposed) return;
      this.failClosed(`Browser AUTO RIFF unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  private handleAnalyzerMessage(raw: unknown): void {
    const message = raw as AutoRiffPitchMessage | null;
    if (message?.type === 'error' && typeof message.message === 'string') {
      this.failClosed(`Browser AUTO RIFF analyzer failed: ${message.message}`);
      return;
    }
    if (message?.type !== 'auto-riff-pitch') return;
    if (!this.pitchNode || !Number.isSafeInteger(message.frame) || !Number.isFinite(message.semitones)) {
      this.failClosed('Browser AUTO RIFF emitted a malformed pitch event.');
      return;
    }
    const outputTime = (message.frame as number) / this.context.sampleRate + this.pitchNode.latencySeconds;
    if (outputTime < this.context.currentTime) {
      this.failClosed('Browser AUTO RIFF pitch event missed its Signalsmith scheduling deadline.');
      return;
    }
    void this.pitchNode.setPitch(message.semitones as number, outputTime, false).catch((cause) => {
      this.failClosed(`Browser AUTO RIFF pitch schedule failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }

  private failClosed(message: string): void {
    this.failed = true;
    if (this.error !== message) {
      this.error = message;
      this.onFailure?.(new Error(message));
    }
    this.applyRouting();
  }

  private clearParameterFailure(): void {
    if (!this.pitchNode) return;
    this.failed = false;
    this.error = '';
    this.applyRouting();
  }

  private applyRouting(): void {
    const direct = this.bypassed || this.failed || !this.pitchNode ? 1 : 0;
    const wet = direct ? 0 : this.mix;
    const dry = direct ? 0 : 1 - this.mix;
    const now = this.context.currentTime;
    for (const [gain, value] of [[this.directGain.gain, direct], [this.dryGain.gain, dry], [this.wetGain.gain, wet]] as const) {
      gain.cancelScheduledValues(now);
      gain.setTargetAtTime(value, now, 0.004);
    }
  }
}
