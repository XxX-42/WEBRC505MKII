import { createLiveInputTransposeNode, type LiveInputTransposeNode } from '../pitch/signalsmith';
import type { MidiNoteEvent } from '../MidiInputController';
import type { FXBase } from './FXBase';

type FailureHandler = (error: Error) => void;
type FailureKind = 'parameter' | 'runtime' | null;

interface HrmAutoTargetMessage {
  type?: unknown;
  message?: unknown;
  frame?: unknown;
  reason?: unknown;
  note?: unknown;
  noteOn?: unknown;
  activeNoteCount?: unknown;
  voiceCount?: unknown;
  target1?: unknown;
  target2?: unknown;
}

interface PendingMidiMessage {
  readonly type: 'midi-note-on' | 'midi-note-off';
  readonly channel: number;
  readonly note: number;
  readonly velocity?: number;
  readonly frame: number;
}

const MAX_PENDING_MIDI_MESSAGES = 128;
const MAX_LIVE_LATENCY_SECONDS = 0.1;
const MAX_ALIGNMENT_DELAY_SECONDS = 0.1;
const INACTIVE_TARGET = -128;

/**
 * Browser HRM AUTO (M): sample-stamped MIDI/YIN analysis runs in the shared
 * Browser FX worklet. Its bounded target events retune one or two pinned
 * Signalsmith LIVE_FX nodes. Active dry audio and both harmony voices are
 * latency-aligned; bypass and unavailable-runtime paths remain direct dry.
 *
 * The analysis/voicing algorithm is clean-room and provisional. The mono F0
 * detector does not track polyphonic source audio, and this adapter makes no
 * Roland sound-quality or topology claim.
 */
export class BrowserHrmAutoFX implements FXBase {
  readonly name = 'HRM AUTO (M)';
  readonly input: GainNode;
  readonly output: GainNode;
  readonly ready: Promise<void>;

  private readonly context: AudioContext;
  private readonly ensureModule: () => Promise<void>;
  private readonly onFailure?: FailureHandler;
  private readonly directGain: GainNode;
  private readonly dryDelay: DelayNode;
  private readonly dryGain: GainNode;
  private readonly voiceAlignmentDelays: [DelayNode, DelayNode];
  private readonly voiceGains: [GainNode, GainNode];
  private readonly pendingMidiMessages: PendingMidiMessage[] = [];
  private analyzerNode: AudioWorkletNode | null = null;
  private voiceNodes: [LiveInputTransposeNode, LiveInputTransposeNode] | null = null;
  private parameters = {
    hrmAutoKey: 0,
    hrmAutoScale: 0,
    hrmAutoMidiChannel: 1,
    hrmAutoMixPercent: 70,
  };
  private bypassed = true;
  private disposed = false;
  private failed = false;
  private failureKind: FailureKind = null;
  private failedParameterKey = '';
  private currentVoiceCount = 0;
  private currentTarget1 = INACTIVE_TARGET;
  private currentTarget2 = INACTIVE_TARGET;
  public error = '';

  constructor(context: AudioContext, ensureModule: () => Promise<void>, onFailure?: FailureHandler) {
    this.context = context;
    this.ensureModule = ensureModule;
    this.onFailure = onFailure;
    this.input = context.createGain();
    this.output = context.createGain();
    this.directGain = context.createGain();
    this.dryDelay = context.createDelay(MAX_ALIGNMENT_DELAY_SECONDS);
    this.dryGain = context.createGain();
    this.voiceAlignmentDelays = [
      context.createDelay(MAX_ALIGNMENT_DELAY_SECONDS),
      context.createDelay(MAX_ALIGNMENT_DELAY_SECONDS),
    ];
    this.voiceGains = [context.createGain(), context.createGain()];

    this.input.connect(this.directGain);
    this.directGain.connect(this.output);
    this.dryDelay.connect(this.dryGain);
    this.dryGain.connect(this.output);
    for (let voice = 0; voice < 2; voice += 1) {
      this.voiceAlignmentDelays[voice]!.connect(this.voiceGains[voice]!);
      this.voiceGains[voice]!.connect(this.output);
    }
    this.applyRouting();
    this.ready = this.installProcessor();
  }

  get latencySeconds(): number {
    if (!this.voiceNodes) return 0;
    return Math.max(this.voiceNodes[0].latencySeconds, this.voiceNodes[1].latencySeconds);
  }

  get latencySamples(): number {
    if (!this.voiceNodes) return 0;
    return Math.max(this.voiceNodes[0].latencySamples, this.voiceNodes[1].latencySamples);
  }

  get activeMidiVoiceCount(): number { return this.currentVoiceCount; }

  setParam(key: string, value: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(value)) {
      this.failClosed(`HRM AUTO ${key} must be finite.`, key);
      return;
    }

    let parameterKey: keyof typeof this.parameters;
    let bounded: number;
    if (key === 'key' || key === 'hrmAutoKey' || key === 'hrm-auto.key') {
      if (!Number.isInteger(value) || value < 0 || value > 11) {
        this.failClosed('HRM AUTO key must be an integer from 0 to 11.', key);
        return;
      }
      parameterKey = 'hrmAutoKey';
      bounded = value;
    } else if (key === 'scale' || key === 'hrmAutoScale' || key === 'hrm-auto.scale') {
      if (!Number.isInteger(value) || value < 0 || value > 4) {
        this.failClosed('HRM AUTO scale must be an integer from 0 to 4.', key);
        return;
      }
      parameterKey = 'hrmAutoScale';
      bounded = value;
    } else if (key === 'midi-channel' || key === 'midi_channel' || key === 'midiChannel' || key === 'hrmAutoMidiChannel') {
      if (!Number.isInteger(value) || value < 1 || value > 16) {
        this.failClosed('HRM AUTO MIDI channel must be an integer from 1 to 16.', key);
        return;
      }
      parameterKey = 'hrmAutoMidiChannel';
      bounded = value;
    } else if (key === 'mix' || key === 'mix_percent' || key === 'effect_mix_percent' || key === 'hrmAutoMixPercent') {
      if (value < 0 || value > 100) {
        this.failClosed('HRM AUTO mix must be from 0 to 100 percent.', key);
        return;
      }
      parameterKey = 'hrmAutoMixPercent';
      bounded = value;
    } else {
      this.failClosed(`HRM AUTO does not support the ${key} parameter.`, key);
      return;
    }

    this.parameters = { ...this.parameters, [parameterKey]: bounded };
    this.analyzerNode?.port.postMessage({ type: 'configure', parameters: { [parameterKey]: bounded } });
    this.clearParameterFailure(key);
    this.applyRouting();
  }

  /** Send one absolute-frame MIDI event to this exact FX slot. */
  sendMidiNote(event: MidiNoteEvent & { frame: number }): boolean {
    if (this.disposed) return false;
    if (
      !Number.isInteger(event.channel) || event.channel < 1 || event.channel > 16 ||
      !Number.isInteger(event.note) || event.note < 0 || event.note > 127 ||
      !Number.isSafeInteger(event.frame) || event.frame < 0 ||
      (event.noteOn && (!Number.isInteger(Math.round(event.velocity * 127)) || event.velocity < 0 || event.velocity > 1))
    ) {
      this.reportError('HRM AUTO MIDI event fields are invalid.');
      return false;
    }
    const message: PendingMidiMessage = event.noteOn
      ? {
        type: 'midi-note-on',
        channel: event.channel,
        note: event.note,
        velocity: Math.max(0, Math.min(127, Math.round(event.velocity * 127))),
        frame: event.frame,
      }
      : { type: 'midi-note-off', channel: event.channel, note: event.note, frame: event.frame };
    if (this.analyzerNode) {
      this.analyzerNode.port.postMessage(message);
      return true;
    }
    if (this.pendingMidiMessages.length >= MAX_PENDING_MIDI_MESSAGES) {
      this.reportError(`HRM AUTO MIDI queue is full (${MAX_PENDING_MIDI_MESSAGES} events).`);
      return false;
    }
    this.pendingMidiMessages.push(message);
    return true;
  }

  /** Stop any stale harmony when the engine selects a different MIDI target slot. */
  clearMidiState(): void {
    if (this.disposed) return;
    this.pendingMidiMessages.length = 0;
    this.analyzerNode?.port.postMessage({ type: 'reset' });
    this.currentVoiceCount = 0;
    this.currentTarget1 = INACTIVE_TARGET;
    this.currentTarget2 = INACTIVE_TARGET;
    this.applyRouting();
  }

  setBypass(bypass: boolean): void {
    if (this.disposed) return;
    this.bypassed = bypass;
    this.analyzerNode?.port.postMessage({ type: 'set-bypass', value: bypass, rampFrames: 0 });
    this.applyRouting();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingMidiMessages.length = 0;
    this.input.disconnect();
    this.directGain.disconnect();
    this.analyzerNode?.disconnect();
    this.dryDelay.disconnect();
    this.dryGain.disconnect();
    for (const delay of this.voiceAlignmentDelays) delay.disconnect();
    for (const gain of this.voiceGains) gain.disconnect();
    for (const node of this.voiceNodes ?? []) node.disconnect();
    this.output.disconnect();
    this.analyzerNode = null;
    this.voiceNodes = null;
  }

  private async installProcessor(): Promise<void> {
    let createdNodes: LiveInputTransposeNode[] = [];
    try {
      if (!this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
        throw new Error('AudioWorklet is unavailable.');
      }
      await this.ensureModule();
      if (this.disposed) return;

      const results = await Promise.allSettled([
        createLiveInputTransposeNode(this.context, { mode: 'LIVE_FX', channels: 2, semitones: 0 }),
        createLiveInputTransposeNode(this.context, { mode: 'LIVE_FX', channels: 2, semitones: 0 }),
      ]);
      createdNodes = results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      if (createdNodes.length !== 2) throw new Error('Both harmony pitch voices are required.');
      if (this.disposed) {
        createdNodes.forEach((node) => node.disconnect());
        return;
      }
      if (createdNodes.some((node) =>
        !Number.isFinite(node.latencySeconds) || node.latencySeconds < 0 || node.latencySeconds > MAX_LIVE_LATENCY_SECONDS ||
        !Number.isFinite(node.latencySamples) || node.latencySamples < 0)) {
        throw new Error('Signalsmith returned an unsupported HRM AUTO voice latency.');
      }

      const analyzerNode = new AudioWorkletNode(this.context, 'rc505-fx-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: {
          algorithm: 'hrm-auto',
          sampleRate: this.context.sampleRate,
          parameters: this.parameters,
          bypassed: this.bypassed,
        },
      });

      this.analyzerNode = analyzerNode;
      this.voiceNodes = [createdNodes[0]!, createdNodes[1]!];
      const maxLatency = Math.max(createdNodes[0]!.latencySeconds, createdNodes[1]!.latencySeconds);
      this.dryDelay.delayTime.value = maxLatency;
      this.voiceAlignmentDelays[0].delayTime.value = maxLatency - createdNodes[0]!.latencySeconds;
      this.voiceAlignmentDelays[1].delayTime.value = maxLatency - createdNodes[1]!.latencySeconds;

      try {
        this.input.connect(analyzerNode);
        analyzerNode.connect(this.dryDelay);
        analyzerNode.connect(createdNodes[0]!);
        analyzerNode.connect(createdNodes[1]!);
        createdNodes[0]!.connect(this.voiceAlignmentDelays[0]!);
        createdNodes[1]!.connect(this.voiceAlignmentDelays[1]!);
      } catch (cause) {
        analyzerNode.disconnect();
        throw cause;
      }

      analyzerNode.port.onmessage = (event: MessageEvent<unknown>) => this.handleWorkletMessage(event.data);
      analyzerNode.port.postMessage({ type: 'configure', parameters: this.parameters });
      analyzerNode.port.postMessage({ type: 'set-bypass', value: this.bypassed, rampFrames: 0 });
      this.failed = false;
      this.failureKind = null;
      this.error = '';
      this.flushPendingMidiMessages();
      this.applyRouting();
    } catch (cause) {
      createdNodes.forEach((node) => node.disconnect());
      if (this.disposed) return;
      this.voiceNodes = null;
      this.analyzerNode?.disconnect();
      this.analyzerNode = null;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.failRuntime(`Browser HRM AUTO unavailable: ${error.message}`);
    }
  }

  private handleWorkletMessage(raw: unknown): void {
    const message = raw as HrmAutoTargetMessage | null;
    if (message?.type === 'error' && typeof message.message === 'string') {
      this.failRuntime(`Browser HRM AUTO analyzer failed: ${message.message}`);
      return;
    }
    if (message?.type !== 'hrm-auto-target') return;
    if (
      !this.voiceNodes || !Number.isSafeInteger(message.frame) ||
      !Number.isInteger(message.voiceCount) || (message.voiceCount as number) < 0 || (message.voiceCount as number) > 2 ||
      !Number.isFinite(message.target1) || !Number.isFinite(message.target2)
    ) {
      this.failRuntime('Browser HRM AUTO emitted a malformed target event.');
      return;
    }

    const voiceCount = message.voiceCount as number;
    const target1 = message.target1 as number;
    const target2 = message.target2 as number;
    if (
      (voiceCount >= 1 && (target1 < -24 || target1 > 24)) ||
      (voiceCount >= 2 && (target2 < -24 || target2 > 24)) ||
      (voiceCount === 0 && (target1 !== INACTIVE_TARGET || target2 !== INACTIVE_TARGET))
    ) {
      this.failRuntime('Browser HRM AUTO emitted an out-of-range pitch target.');
      return;
    }

    const oldVoiceCount = this.currentVoiceCount;
    const oldTarget1 = this.currentTarget1;
    const oldTarget2 = this.currentTarget2;
    this.currentVoiceCount = voiceCount;
    this.currentTarget1 = target1;
    this.currentTarget2 = target2;

    const maxLatency = this.latencySeconds;
    const outputTime = (message.frame as number) / this.context.sampleRate + maxLatency;
    if (outputTime < this.context.currentTime) {
      this.failRuntime('Browser HRM AUTO target event missed its Signalsmith scheduling deadline.');
      return;
    }

    const targets = [target1, target2] as const;
    for (let voice = 0; voice < 2; voice += 1) {
      const active = voice < voiceCount;
      const target = targets[voice]!;
      const changed = active && (
        oldVoiceCount <= voice ||
        Math.abs((voice === 0 ? oldTarget1 : oldTarget2) - target) >= 0.01
      );
      if (!changed) continue;
      const node = this.voiceNodes[voice]!;
      const voiceOutputTime = (message.frame as number) / this.context.sampleRate + node.latencySeconds;
      try {
        void node.setPitch(target, voiceOutputTime, false).catch((cause: unknown) => {
          this.failRuntime(`Browser HRM AUTO voice ${voice + 1} scheduling failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
      } catch (cause) {
        this.failRuntime(`Browser HRM AUTO voice ${voice + 1} scheduling failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        return;
      }
    }
    this.applyRouting(outputTime);
  }

  private flushPendingMidiMessages(): void {
    const node = this.analyzerNode;
    if (!node || this.pendingMidiMessages.length === 0) return;
    const firstFrame = this.pendingMidiMessages.reduce((minimum, event) => Math.min(minimum, event.frame), Number.MAX_SAFE_INTEGER);
    const safeFrame = Math.ceil((this.context.currentTime * this.context.sampleRate) + this.context.sampleRate * 0.03);
    const shift = Math.max(0, safeFrame - firstFrame);
    for (const event of this.pendingMidiMessages) node.port.postMessage({ ...event, frame: event.frame + shift });
    this.pendingMidiMessages.length = 0;
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
    const activeVoiceCount = direct ? 0 : this.currentVoiceCount;
    const mix = this.parameters.hrmAutoMixPercent / 100;
    const dry = direct ? 0 : activeVoiceCount === 0 ? 1 : 1 - mix;
    const voiceMix = direct || activeVoiceCount === 0 ? 0 : mix / activeVoiceCount;
    this.directGain.gain.setTargetAtTime(direct, atTime, 0.005);
    this.dryGain.gain.setTargetAtTime(dry, atTime, 0.005);
    this.voiceGains[0].gain.setTargetAtTime(activeVoiceCount >= 1 ? voiceMix : 0, atTime, 0.005);
    this.voiceGains[1].gain.setTargetAtTime(activeVoiceCount >= 2 ? voiceMix : 0, atTime, 0.005);
  }
}
