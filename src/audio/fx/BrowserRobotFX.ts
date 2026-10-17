import { createLiveInputTransposeNode, type LiveInputTransposeNode } from '../pitch/signalsmith';
import { getLiveMonoPitchLatencySamples } from '../pitch/liveMono';
import type { BrowserRobotModeReason, BrowserRobotProcessingMode } from './dsp/BrowserRobotDsp';
import type { FXBase } from './FXBase';

type FailureHandler = (error: Error) => void;
type FailureKind = 'parameter' | 'runtime' | null;

interface RobotTargetMessage {
  type?: unknown;
  message?: unknown;
  frame?: unknown;
  semitones?: unknown;
  sourceMidi?: unknown;
  targetMidi?: unknown;
  sourceHz?: unknown;
  confidence?: unknown;
  voiced?: unknown;
}

interface RobotModeMessage {
  type?: unknown;
  frame?: unknown;
  mode?: unknown;
  reason?: unknown;
  trackerLatencyFrames?: unknown;
  psolaLatencySamples?: unknown;
}

const MAX_LIVE_LATENCY_SECONDS = 0.1;
const MAX_ALIGNMENT_DELAY_SECONDS = 0.1;

/**
 * Experimental clean-room ROBOT adapter. A mono-F0 worklet tracks and
 * quantizes one source pitch while a separate Signalsmith LIVE_FX node applies
 * the pitch/formant schedule. The output graph uses a latency-aligned dry
 * path and explicit direct-dry bypass/failure routing. Its formant policy
 * uses Signalsmith compensation for preserve-at-zero and independent shifts,
 * anchored to tracked source F0. This is not Roland firmware; polyphonic
 * source tracking and sound-quality acceptance remain unverified.
 */
export class BrowserRobotFX implements FXBase {
  readonly name = 'ROBOT';
  readonly input: GainNode;
  readonly output: GainNode;
  readonly ready: Promise<void>;

  private readonly context: AudioContext;
  private readonly ensureModule: () => Promise<void>;
  private readonly onFailure?: FailureHandler;
  private readonly directGain: GainNode;
  private readonly dryDelay: DelayNode;
  private readonly wetDelay: DelayNode;
  private readonly psolaDelay: DelayNode;
  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly psolaGain: GainNode;
  private readonly psolaLatencySamplesValue: number;
  private analyzerNode: AudioWorkletNode | null = null;
  private pitchNode: LiveInputTransposeNode | null = null;
  private processingModeValue: BrowserRobotProcessingMode = 'signalsmith';
  private modeReasonValue: BrowserRobotModeReason = 'unvoiced';
  private trackerLatencyFramesValue = 0;
  private alignmentLatencySamplesValue = 0;
  private lastModeFrame = -1;
  private parameters = { robotPitch: 0, robotFormantSemitones: 0 };
  private mix = 1;
  private bypassed = true;
  private disposed = false;
  private failed = false;
  private failureKind: FailureKind = null;
  private failedParameterKey = '';
  private lastFrame = -1;
  public error = '';

  constructor(context: AudioContext, ensureModule: () => Promise<void>, onFailure?: FailureHandler) {
    this.context = context;
    this.ensureModule = ensureModule;
    this.onFailure = onFailure;
    this.input = context.createGain();
    this.output = context.createGain();
    this.directGain = context.createGain();
    this.dryDelay = context.createDelay(MAX_ALIGNMENT_DELAY_SECONDS);
    this.wetDelay = context.createDelay(MAX_ALIGNMENT_DELAY_SECONDS);
    this.psolaDelay = context.createDelay(MAX_ALIGNMENT_DELAY_SECONDS);
    this.dryGain = context.createGain();
    this.wetGain = context.createGain();
    this.psolaGain = context.createGain();
    this.psolaLatencySamplesValue = getLiveMonoPitchLatencySamples(context.sampleRate, 130);

    this.input.connect(this.directGain);
    this.directGain.connect(this.output);
    this.dryDelay.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.wetDelay.connect(this.wetGain);
    this.wetGain.connect(this.output);
    this.psolaDelay.connect(this.psolaGain);
    this.psolaGain.connect(this.output);
    this.applyRouting();
    this.ready = this.installProcessor();
  }

  /** Maximum algorithmic path used to align dry, Signalsmith and PSOLA branches. */
  get latencySeconds(): number { return this.alignmentLatencySamplesValue / this.context.sampleRate; }
  get latencySamples(): number { return this.alignmentLatencySamplesValue; }
  get psolaLatencySamples(): number { return this.psolaLatencySamplesValue; }
  get signalsmithLatencySamples(): number { return this.pitchNode?.latencySamples ?? 0; }
  /** Tracker window/hop acquisition estimate, separate from shifter latency. */
  get trackerAcquisitionLatencyFrames(): number { return this.trackerLatencyFramesValue; }
  get processingMode(): BrowserRobotProcessingMode { return this.processingModeValue; }
  get processingModeReason(): BrowserRobotModeReason { return this.modeReasonValue; }

  setParam(key: string, value: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(value)) {
      this.failClosed(`ROBOT ${key} must be finite.`, key);
      return;
    }

    if (key === 'mix' || key === 'mix_percent' || key === 'robot.mix') {
      if (value < 0 || value > 100) {
        this.failClosed('ROBOT mix must be from 0 to 100 percent.', key);
        return;
      }
      this.mix = value / 100;
      this.clearParameterFailure(key);
      this.applyRouting();
      return;
    }

    let parameterKey: 'robotPitch' | 'robotFormantSemitones';
    let bounded = value;
    if (key === 'pitch' || key === 'pitch_semitones' || key === 'robot.pitch' || key === 'robotPitch') {
      if (value < -24 || value > 24) {
        this.failClosed('ROBOT pitch must be between -24 and +24 semitones.', key);
        return;
      }
      parameterKey = 'robotPitch';
    } else if (key === 'formant' || key === 'formant_semitones' || key === 'robot.formant' || key === 'robotFormantSemitones') {
      if (value < -12 || value > 12) {
        this.failClosed('ROBOT formant must be between -12 and +12 semitones.', key);
        return;
      }
      parameterKey = 'robotFormantSemitones';
    } else {
      this.failClosed(`ROBOT does not support the ${key} parameter.`, key);
      return;
    }

    this.parameters[parameterKey] = bounded;
    this.analyzerNode?.port.postMessage({ type: 'configure', parameters: { [parameterKey]: bounded } });
    this.clearParameterFailure(key);
    this.applyRouting();
  }

  setBypass(bypass: boolean): void {
    if (this.disposed) return;
    const reactivating = this.bypassed && !bypass;
    this.bypassed = bypass;
    if (reactivating) {
      this.lastFrame = -1;
      this.processingModeValue = 'signalsmith';
      this.modeReasonValue = 'unvoiced';
      this.analyzerNode?.port.postMessage({ type: 'reset' });
      const node = this.pitchNode;
      if (node) {
        void node.setPitch(0, this.context.currentTime + node.latencySeconds, true,
          this.parameters.robotFormantSemitones, 0, true).catch((cause: unknown) => {
          this.failRuntime(`Browser ROBOT reset schedule failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
      }
    }
    this.analyzerNode?.port.postMessage({ type: 'set-bypass', value: bypass, rampFrames: 0 });
    this.applyRouting();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.disconnect();
    this.directGain.disconnect();
    this.dryDelay.disconnect();
    this.wetDelay.disconnect();
    this.psolaDelay.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.psolaGain.disconnect();
    this.analyzerNode?.disconnect();
    this.pitchNode?.disconnect();
    this.output.disconnect();
    this.analyzerNode = null;
    this.pitchNode = null;
  }

  private async installProcessor(): Promise<void> {
    let pitchNode: LiveInputTransposeNode | null = null;
    try {
      if (!this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
        throw new Error('AudioWorklet is unavailable.');
      }
      await this.ensureModule();
      if (this.disposed) return;
      pitchNode = await createLiveInputTransposeNode(this.context, {
        mode: 'LIVE_FX',
        channels: 2,
        semitones: 0,
      });
      if (this.disposed) {
        pitchNode.disconnect();
        return;
      }
      if (!Number.isFinite(pitchNode.latencySeconds) || pitchNode.latencySeconds < 0 || pitchNode.latencySeconds > MAX_LIVE_LATENCY_SECONDS ||
          !Number.isFinite(pitchNode.latencySamples) || pitchNode.latencySamples < 0) {
        throw new Error('Signalsmith returned an unsupported ROBOT pitch-shifter latency.');
      }

      const analyzerNode = new AudioWorkletNode(this.context, 'rc505-fx-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: {
          algorithm: 'robot',
          sampleRate: this.context.sampleRate,
          parameters: this.parameters,
          bypassed: this.bypassed,
        },
      });
      this.analyzerNode = analyzerNode;
      this.pitchNode = pitchNode;
      this.alignmentLatencySamplesValue = Math.max(this.psolaLatencySamplesValue, pitchNode.latencySamples);
      if (this.alignmentLatencySamplesValue / this.context.sampleRate > MAX_ALIGNMENT_DELAY_SECONDS) {
        throw new Error('ROBOT path latency exceeds the supported alignment delay.');
      }
      const alignmentSeconds = this.alignmentLatencySamplesValue / this.context.sampleRate;
      this.dryDelay.delayTime.value = alignmentSeconds;
      this.wetDelay.delayTime.value = Math.max(0, alignmentSeconds - pitchNode.latencySeconds);
      this.psolaDelay.delayTime.value = Math.max(0, alignmentSeconds - (this.psolaLatencySamplesValue / this.context.sampleRate));
      try {
        this.input.connect(analyzerNode);
        analyzerNode.connect(this.psolaDelay);
        this.input.connect(this.dryDelay);
        this.input.connect(pitchNode);
        pitchNode.connect(this.wetDelay);
      } catch (cause) {
        analyzerNode.disconnect();
        throw cause;
      }

      analyzerNode.port.onmessage = (event: MessageEvent<unknown>) => {
        if (!this.handleModeMessage(event.data)) this.handleAnalyzerMessage(event.data);
      };
      analyzerNode.port.postMessage({ type: 'configure', parameters: this.parameters });
      analyzerNode.port.postMessage({ type: 'set-bypass', value: this.bypassed, rampFrames: 0 });
      this.failed = false;
      this.failureKind = null;
      this.error = '';
      this.applyRouting();
    } catch (cause) {
      pitchNode?.disconnect();
      if (this.disposed) return;
      this.pitchNode = null;
      this.analyzerNode?.disconnect();
      this.analyzerNode = null;
      this.failRuntime(`Browser ROBOT unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  private handleAnalyzerMessage(raw: unknown): void {
    const message = raw as RobotTargetMessage | null;
    if (message?.type === 'error' && typeof message.message === 'string') {
      this.failRuntime(`Browser ROBOT analyzer failed: ${message.message}`);
      return;
    }
    if (message?.type !== 'robot-pitch-target') return;
    if (
      !this.pitchNode || !Number.isSafeInteger(message.frame) ||
      !Number.isFinite(message.semitones) || !Number.isFinite(message.sourceMidi) ||
      !Number.isFinite(message.targetMidi) || !Number.isFinite(message.sourceHz) ||
      !Number.isFinite(message.confidence) || typeof message.voiced !== 'boolean'
    ) {
      this.failRuntime('Browser ROBOT emitted a malformed pitch target.');
      return;
    }
    const frame = message.frame as number;
    const semitones = message.semitones as number;
    const sourceHz = message.sourceHz as number;
    const sourceMidi = message.sourceMidi as number;
    const targetMidi = message.targetMidi as number;
    const confidence = message.confidence as number;
    const voiced = message.voiced;
    if (frame < this.lastFrame || semitones < -24 || semitones > 24 || confidence < 0 || confidence > 1 ||
        (voiced && (sourceHz < 80 || sourceHz > 1000 || Math.abs((sourceMidi + semitones) - targetMidi) > 0.02))) {
      this.failRuntime('Browser ROBOT emitted an out-of-range or unordered pitch target.');
      return;
    }
    this.lastFrame = frame;
    const node = this.pitchNode;
    const outputTime = frame / this.context.sampleRate + node.latencySeconds;
    if (outputTime < this.context.currentTime) {
      this.failRuntime('Browser ROBOT pitch target missed its Signalsmith scheduling deadline.');
      return;
    }
    if (voiced) {
      // The vendor formant path is enabled and anchored to the tracked source
      // F0. Zero formant semitones requests pitch compensation (preserve); a
      // nonzero value shifts the envelope independently from the quantized F0.
      void node.setPitch(semitones, outputTime, false, this.parameters.robotFormantSemitones, sourceHz, true).catch((cause: unknown) => {
        this.failRuntime(`Browser ROBOT pitch/formant schedule failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    }
    this.applyRouting(frame / this.context.sampleRate + this.latencySeconds);
  }

  private handleModeMessage(raw: unknown): boolean {
    const message = raw as RobotModeMessage | null;
    if (message?.type !== 'robot-mode') return false;
    const validMode = message.mode === 'psola' || message.mode === 'signalsmith';
    const validReason = message.reason === 'stable-voiced' || message.reason === 'unvoiced' ||
      message.reason === 'unstable-f0' || message.reason === 'low-confidence' ||
      message.reason === 'source-frequency-out-of-range' || message.reason === 'target-shift-out-of-range' ||
      message.reason === 'formant-control-active';
    if (!validMode || !validReason || !Number.isSafeInteger(message.frame) ||
        !Number.isSafeInteger(message.trackerLatencyFrames) || (message.trackerLatencyFrames as number) < 0 ||
        message.psolaLatencySamples !== this.psolaLatencySamplesValue || (message.frame as number) < this.lastModeFrame) {
      this.failRuntime('Browser ROBOT emitted a malformed processing-mode status.');
      return true;
    }
    this.lastModeFrame = message.frame as number;
    this.processingModeValue = message.mode as BrowserRobotProcessingMode;
    this.modeReasonValue = message.reason as BrowserRobotModeReason;
    this.trackerLatencyFramesValue = message.trackerLatencyFrames as number;
    const outputTime = (message.frame as number) / this.context.sampleRate + this.latencySeconds;
    this.applyRouting(outputTime);
    return true;
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
    this.failedParameterKey = '';
    this.reportError(message);
    this.applyRouting();
  }

  private clearParameterFailure(parameterKey: string): void {
    if (this.failureKind !== 'parameter' || this.failedParameterKey !== parameterKey) return;
    this.failed = false;
    this.failureKind = null;
    this.failedParameterKey = '';
    this.error = '';
  }

  private reportError(message: string): void {
    if (this.error === message) return;
    this.error = message;
    this.onFailure?.(new Error(message));
  }

  private applyRouting(atTime = this.context.currentTime): void {
    const direct = this.bypassed || this.failed || !this.analyzerNode ? 1 : 0;
    const active = !direct;
    const dry = direct ? 0 : active ? 1 - this.mix : 1;
    const psola = active && this.processingModeValue === 'psola' ? this.mix : 0;
    const wet = active && this.processingModeValue === 'signalsmith' ? this.mix : 0;
    this.directGain.gain.setTargetAtTime(direct, atTime, 0.005);
    this.dryGain.gain.setTargetAtTime(dry, atTime, 0.005);
    this.wetGain.gain.setTargetAtTime(wet, atTime, 0.005);
    this.psolaGain.gain.setTargetAtTime(psola, atTime, 0.005);
  }
}
