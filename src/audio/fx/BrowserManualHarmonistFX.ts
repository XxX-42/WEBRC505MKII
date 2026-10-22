import { officialFormantSemitones, officialPitchDefaults } from './dsp/OfficialPitchParameters';
import { createLiveInputTransposeNode, type LiveInputTransposeNode } from '../pitch/signalsmith';
import type { FXBase } from './FXBase';

type FailureHandler = (error: Error) => void;
type FailureKind = 'parameter' | 'runtime' | null;
type VoiceIndex = 0 | 1;

const MAX_INTERVAL_SEMITONES = 24;

/**
 * Browser HRM MANUAL: full-level latency-aligned dry audio plus two
 * independently Signalsmith-transposed harmony voices. Their sum is panned
 * as one harmony bus and added to dry audio using mix_percent. The optional
 * official path uses a mono-F0 analyzer and a single key/degree-aware voice;
 * FORMANT is an authored spectral-envelope shift, not a measured Roland law.
 */
export class BrowserManualHarmonistFX implements FXBase {
  readonly name = 'HRM MANUAL';
  readonly algorithm = 'hrm-manual';
  readonly input: GainNode;
  readonly output: GainNode;
  readonly ready: Promise<void>;

  private readonly context: AudioContext;
  private readonly directGain: GainNode;
  private readonly dryDelay: DelayNode;
  private readonly dryGain: GainNode;
  private readonly voiceAlignmentDelays: [DelayNode, DelayNode];
  private readonly voicePan: StereoPannerNode;
  private readonly voiceMutes: [GainNode, GainNode];
  private readonly voiceGain: GainNode;
  private readonly onFailure?: FailureHandler;
  private voiceNodes: [LiveInputTransposeNode, LiveInputTransposeNode] | null = null;
  private bypassed = true;
  private disposed = false;
  private failed = false;
  private failureKind: FailureKind = null;
  private failedParameterKey: string | null = null;
  private failureSerial = 0;
  private voiceReady = false;
  private voice1Interval = 7;
  private voice2Interval = 12;
  private mixPercent = 50;
  private panPercent = 0;
  private officialActive = false;
  private officialVoiced = false;
  private officialTarget = 0;
  private officialValues: Record<string, number> = { voice: 6, formant: 0, pan: 0, key: 0, d_level: 100, hrm_level: 80 };
  private analyzerNode: AudioWorkletNode | null = null;
  private analyzerSink: GainNode | null = null;
  private analyzerReady: Promise<void> | null = null;
  private readonly officialParameters: Record<string, number> = {};
  private officialInitialized = false;
  public error = '';

  /** The private A–D chain waits until both independent voices are installed. */
  get processorReady(): boolean { return this.voiceReady && (!this.officialActive || this.analyzerNode !== null) && !this.disposed && !this.error; }

  constructor(context: AudioContext, onFailure?: FailureHandler) {
    this.context = context;
    this.onFailure = onFailure;
    this.input = context.createGain();
    this.output = context.createGain();
    this.directGain = context.createGain();
    this.dryDelay = context.createDelay(0.1);
    this.dryGain = context.createGain();
    this.voiceAlignmentDelays = [context.createDelay(0.1), context.createDelay(0.1)];
    this.voicePan = context.createStereoPanner();
    this.voiceMutes = [context.createGain(), context.createGain()];
    this.voiceGain = context.createGain();

    // Bypass is a separate, true zero-latency path. Active dry remains at
    // unity, centered, and aligned to the slower of the two pitch processors.
    this.input.connect(this.directGain);
    this.directGain.connect(this.output);
    this.input.connect(this.dryDelay);
    this.dryDelay.connect(this.dryGain);
    this.dryGain.connect(this.output);
    for (let voice = 0; voice < 2; voice += 1) {
      this.voiceAlignmentDelays[voice]!.connect(this.voiceMutes[voice]!);
      this.voiceMutes[voice]!.connect(this.voicePan);
    }
    this.voicePan.connect(this.voiceGain);
    this.voiceGain.connect(this.output);
    this.applyPan();
    this.applyRouting();
    this.ready = this.installVoices();
  }

  get latencySeconds(): number {
    if (!this.voiceNodes) return 0;
    return Math.max(this.voiceNodes[0].latencySeconds, this.voiceNodes[1].latencySeconds);
  }

  get latencySamples(): number {
    if (!this.voiceNodes) return 0;
    return Math.max(this.voiceNodes[0].latencySamples, this.voiceNodes[1].latencySamples);
  }

  /** Shared Browser amount macro controls harmony level (0–1 → 0–100%). */
  setAmount(value: number): void {
    if (!Number.isFinite(value)) return;
    const official = { ...this.officialParameters };
    this.setParam('mix_percent', Math.max(0, Math.min(1, value)) * 100);
    for (const [key, selected] of Object.entries(official)) this.setParam(key, selected);
  }

  setParam(key: string, value: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(value)) {
      this.failClosed(`HRM MANUAL ${key} must be a finite number.`, key);
      return;
    }

    if (key.startsWith('official_')) {
      this.setOfficialParameter(key, value);
      return;
    }

    if (key === 'voice_1_interval' || key === 'voice_2_interval') {
      if (value < -MAX_INTERVAL_SEMITONES || value > MAX_INTERVAL_SEMITONES) {
        this.failClosed(`HRM MANUAL ${key} must be between -24 and +24 semitones.`, key);
        return;
      }
      this.officialActive = false;
      this.analyzerNode?.port.postMessage({ type: 'set-bypass', value: true, rampFrames: 0 });
      const voice: VoiceIndex = key === 'voice_1_interval' ? 0 : 1;
      if (voice === 0) this.voice1Interval = value;
      else this.voice2Interval = value;

      if (this.voiceNodes) {
        const failureSerial = this.failureSerial;
        this.scheduleVoicePitch(voice, value, failureSerial, key);
      } else {
        this.clearParameterFailure(key);
      }
      this.applyRouting();
      return;
    }

    if (key === 'mix_percent') {
      if (value < 0 || value > 100) {
        this.failClosed('HRM MANUAL mix_percent must be between 0 and 100 percent.', key);
        return;
      }
      this.mixPercent = value;
      this.clearParameterFailure(key);
      this.applyRouting();
      return;
    }

    if (key === 'pan_percent') {
      if (value < -100 || value > 100) {
        this.failClosed('HRM MANUAL pan_percent must be between -100 and +100 percent.', key);
        return;
      }
      this.panPercent = value;
      this.clearParameterFailure(key);
      this.applyPan();
      this.applyRouting();
      return;
    }

    this.failClosed(
      key === 'formant'
        ? 'HRM MANUAL formant processing is unavailable in the Browser Signalsmith live-input adapter.'
        : `HRM MANUAL does not support the ${key} parameter.`,
      key,
    );
  }

  private setOfficialParameter(key: string, value: number): void {
    const name = key.slice('official_'.length);
    const ranges: Record<string, readonly [number, number]> = {
      voice: [0, 10], formant: [-50, 50], pan: [-50, 50], key: [0, 11], d_level: [0, 100], hrm_level: [0, 100],
    };
    const range = ranges[name];
    if (!range || !Number.isInteger(value) || value < range[0] || value > range[1]) {
      this.failClosed(`HRM MANUAL unsupported or out-of-range ${key}.`, key);
      return;
    }
    this.initializeOfficialParameters(key);
    this.officialParameters[key] = value;
    this.officialActive = true;
    this.officialValues[name] = value;
    if (name === 'pan') { this.panPercent = value * 2; this.applyPan(); }
    this.clearParameterFailure(key);
    this.configureOfficialAnalyzer();
    void this.ensureOfficialAnalyzer();
    if (name === 'formant' && this.officialVoiced) this.scheduleOfficialVoice(this.officialTarget);
    this.applyRouting();
  }

  private configureOfficialAnalyzer(): void {
    this.analyzerNode?.port.postMessage({ type: 'configure', parameters: {
      hrmAutoKey: this.officialValues.key!, hrmAutoScale: 0,
      hrmAutoOfficialManualVoice: this.officialValues.voice!,
    } });
    this.analyzerNode?.port.postMessage({ type: 'set-bypass', value: this.bypassed || !this.officialActive, rampFrames: 0 });
  }

  private ensureOfficialAnalyzer(): Promise<void> {
    if (this.analyzerReady) return this.analyzerReady;
    this.analyzerReady = (async () => {
      try {
        if (!this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet is unavailable.');
        await this.context.audioWorklet.addModule('/worklets/fx-processor.js');
        if (this.disposed) return;
        const analyzer = new AudioWorkletNode(this.context, 'rc505-fx-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          channelCount: 2, channelCountMode: 'explicit',
          processorOptions: { algorithm: 'hrm-auto', sampleRate: this.context.sampleRate,
            parameters: { hrmAutoKey: this.officialValues.key!, hrmAutoScale: 0, hrmAutoOfficialManualVoice: this.officialValues.voice! },
            bypassed: this.bypassed },
        });
        this.analyzerNode = analyzer;
        this.analyzerSink = this.context.createGain();
        this.analyzerSink.gain.value = 0;
        this.input.connect(analyzer);
        analyzer.connect(this.analyzerSink);
        this.analyzerSink.connect(this.output);
        analyzer.onprocessorerror = () => this.failRuntime('HRM MANUAL pitch analyzer failed.');
        analyzer.port.onmessage = (event: MessageEvent<unknown>) => this.handleOfficialTarget(event.data);
        this.configureOfficialAnalyzer();
        this.applyRouting();
      } catch (cause) {
        if (this.analyzerNode) this.analyzerNode.port.onmessage = null;
        this.analyzerNode?.disconnect(); this.analyzerSink?.disconnect();
        this.analyzerNode = null; this.analyzerSink = null;
        if (!this.disposed) this.failRuntime(`HRM MANUAL official analyzer unavailable: ${String(cause)}`);
      }
    })();
    return this.analyzerReady;
  }

  private handleOfficialTarget(raw: unknown): void {
    if (this.disposed || !this.officialActive) return;
    const message = raw as { type?: string; message?: string; frame?: number; voiceCount?: number; target1?: number } | null;
    if (message?.type === 'error') { this.failRuntime(`HRM MANUAL analyzer failed: ${message.message}`); return; }
    if (message?.type !== 'hrm-auto-target') return;
    if (!Number.isSafeInteger(message.frame) || (message.voiceCount !== 0 && message.voiceCount !== 1) ||
        !Number.isFinite(message.target1) || (message.voiceCount === 1 && Math.abs(message.target1!) > 24)) {
      this.failRuntime('HRM MANUAL analyzer emitted a malformed harmony target.'); return;
    }
    this.officialVoiced = message.voiceCount === 1;
    if (this.officialVoiced) {
      this.officialTarget = message.target1!;
      this.scheduleOfficialVoice(this.officialTarget, message.frame! / this.context.sampleRate);
    }
    this.applyRouting();
  }

  private scheduleOfficialVoice(target: number, sourceTime = this.context.currentTime): void {
    const node = this.voiceNodes?.[0];
    if (!node) return;
    const outputTime = sourceTime + node.latencySeconds;
    if (outputTime < this.context.currentTime) { this.failRuntime('HRM MANUAL target missed its pitch-scheduling deadline.'); return; }
    try {
      void node.setPitch(target, outputTime, true, officialFormantSemitones(this.officialValues.formant!), 0, true)
        .catch((cause: unknown) => this.failRuntime(`HRM MANUAL pitch/formant schedule failed: ${String(cause)}`));
    } catch (cause) { this.failRuntime(`HRM MANUAL pitch/formant schedule failed: ${String(cause)}`); }
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
    this.analyzerNode?.port.postMessage({ type: 'set-bypass', value: bypass || !this.officialActive, rampFrames: 0 });
    this.applyRouting();
  }

  getParameterSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      voice_1_interval: this.voice1Interval,
      voice_2_interval: this.voice2Interval,
      pan_percent: this.panPercent,
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
    for (const node of this.voiceNodes ?? []) node.disconnect();
    for (const gain of this.voiceMutes) gain.disconnect();
    if (this.analyzerNode) this.analyzerNode.port.onmessage = null;
    this.analyzerNode?.disconnect();
    this.analyzerSink?.disconnect();
    this.analyzerNode = null;
    this.analyzerSink = null;
    this.voicePan.disconnect();
    this.voiceGain.disconnect();
    this.output.disconnect();
    this.voiceNodes = null;
  }

  private async installVoices(): Promise<void> {
    const initialIntervals: [number, number] = [this.voice1Interval, this.voice2Interval];
    const results = await Promise.allSettled([
      createLiveInputTransposeNode(this.context, {
        mode: 'LIVE_FX', channels: 2, semitones: initialIntervals[0],
      }),
      createLiveInputTransposeNode(this.context, {
        mode: 'LIVE_FX', channels: 2, semitones: initialIntervals[1],
      }),
    ]);

    const createdNodes = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failedResult = results.find((result) => result.status === 'rejected');
    if (this.disposed) {
      createdNodes.forEach((node) => node.disconnect());
      return;
    }
    if (failedResult?.status === 'rejected') {
      createdNodes.forEach((node) => node.disconnect());
      const cause = failedResult.reason;
      this.failRuntime(
        `Browser HRM MANUAL harmony voices unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }

    const [voice1, voice2] = createdNodes;
    if (!voice1 || !voice2) {
      createdNodes.forEach((node) => node.disconnect());
      this.failRuntime('Browser HRM MANUAL did not receive both independent harmony voices.');
      return;
    }

    const latencies = [voice1.latencySeconds, voice2.latencySeconds];
    if (latencies.some((latency) => !Number.isFinite(latency) || latency < 0 || latency > 0.1)) {
      voice1.disconnect();
      voice2.disconnect();
      this.failRuntime('Browser HRM MANUAL received an unsupported harmony-voice latency.');
      return;
    }

    this.voiceNodes = [voice1, voice2];
    const maxLatency = Math.max(...latencies);
    this.dryDelay.delayTime.value = maxLatency;
    this.voiceAlignmentDelays[0].delayTime.value = maxLatency - latencies[0]!;
    this.voiceAlignmentDelays[1].delayTime.value = maxLatency - latencies[1]!;

    try {
      this.input.connect(voice1);
      this.input.connect(voice2);
      voice1.connect(this.voiceAlignmentDelays[0]);
      voice2.connect(this.voiceAlignmentDelays[1]);
    } catch (cause) {
      voice1.disconnect();
      voice2.disconnect();
      this.voiceNodes = null;
      this.failRuntime(
        `Browser HRM MANUAL harmony routing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }

    this.voiceReady = true;
    if (this.officialActive && this.officialVoiced) this.scheduleOfficialVoice(this.officialTarget);
    // Parameters can change before the asynchronous Worklet modules finish.
    if (this.voice1Interval !== initialIntervals[0]) {
      this.scheduleVoicePitch(0, this.voice1Interval, this.failureSerial, 'voice_1_interval');
    }
    if (this.voice2Interval !== initialIntervals[1]) {
      this.scheduleVoicePitch(1, this.voice2Interval, this.failureSerial, 'voice_2_interval');
    }
    this.applyRouting();
    // Legacy instances incur no additional promise hops or analyzer setup.
    if (this.officialActive) await this.ensureOfficialAnalyzer();
  }

  private scheduleVoicePitch(
    voice: VoiceIndex,
    semitones: number,
    failureSerial: number,
    parameterKey: 'voice_1_interval' | 'voice_2_interval',
  ): void {
    const node = this.voiceNodes?.[voice];
    if (!node || this.disposed) return;
    try {
      void Promise.resolve(node.setPitch(semitones)).then(() => {
        if (
          !this.disposed &&
          this.failureKind === 'parameter' &&
          this.failureSerial === failureSerial
        ) {
          this.clearParameterFailure(parameterKey);
          this.applyRouting();
        }
      }).catch((cause: unknown) => {
        if (this.disposed) return;
        this.failRuntime(
          `Browser HRM MANUAL voice ${voice + 1} scheduling failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
    } catch (cause) {
      this.failRuntime(
        `Browser HRM MANUAL voice ${voice + 1} scheduling failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private failClosed(message: string, parameterKey: string): void {
    this.failed = true;
    if (this.failureKind !== 'runtime') this.failureKind = 'parameter';
    if (this.failureKind === 'parameter') this.failedParameterKey = parameterKey;
    this.failureSerial += 1;
    this.reportError(message);
    this.applyRouting();
  }

  private failRuntime(message: string): void {
    this.failed = true;
    this.failureKind = 'runtime';
    this.failedParameterKey = null;
    this.failureSerial += 1;
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

  private applyPan(): void {
    this.voicePan.pan.setTargetAtTime(this.panPercent / 100, this.context.currentTime, 0.005);
  }

  private applyRouting(): void {
    const direct = this.bypassed || this.failed || !this.voiceReady ? 1 : 0;
    const dry = direct ? 0 : this.officialActive ? this.officialValues.d_level! / 100 : 1;
    const voice = direct ? 0 : this.officialActive ? this.officialValues.hrm_level! / 100 : this.mixPercent / 100;
    this.voiceMutes[0].gain.setTargetAtTime(this.officialActive && !this.officialVoiced ? 0 : 1, this.context.currentTime, 0.005);
    this.voiceMutes[1].gain.setTargetAtTime(this.officialActive ? 0 : 1, this.context.currentTime, 0.005);
    const now = this.context.currentTime;
    for (const [gain, value] of [
      [this.directGain, direct],
      [this.dryGain, dry],
      [this.voiceGain, voice],
    ] as const) {
      gain.gain.setTargetAtTime(value, now, 0.005);
    }
  }
}
