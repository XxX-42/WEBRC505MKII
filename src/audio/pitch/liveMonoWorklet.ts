import { LiveMonoPitchProcessor, type LiveMonoPitchProcessorOptions } from './liveMono';

interface LiveMonoWorkletMessageEvent {
  readonly data: unknown;
}

interface LiveMonoWorkletPort {
  onmessage: ((event: LiveMonoWorkletMessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

interface LiveMonoProcessorLike {
  readonly port: LiveMonoWorkletPort;
}

type LiveMonoProcessorBaseConstructor = new (options?: LiveMonoWorkletProcessorOptions) => LiveMonoProcessorLike;

class FallbackLiveMonoProcessor implements LiveMonoProcessorLike {
  readonly port: LiveMonoWorkletPort & { readonly messages: unknown[] } = {
    onmessage: null,
    messages: [],
    postMessage(message: unknown): void {
      this.messages.push(message);
    },
  };
}

const workletGlobals = globalThis as unknown as {
  AudioWorkletProcessor?: LiveMonoProcessorBaseConstructor;
  registerProcessor?: (name: string, processor: LiveMonoProcessorBaseConstructor) => void;
  sampleRate?: number;
};

const LiveMonoProcessorBase = workletGlobals.AudioWorkletProcessor ?? FallbackLiveMonoProcessor;

export interface LiveMonoWorkletProcessorOptions {
  readonly processorOptions?: LiveMonoPitchProcessorOptions;
}

export type LiveMonoWorkletMessage =
  | { readonly type: 'set-semitones'; readonly semitones: number }
  | { readonly type: 'get-status'; readonly requestId: number };

export interface LiveMonoPitchStatus {
  readonly type: 'ready' | 'status';
  readonly requestId?: number;
  readonly sampleRate: number;
  readonly latencySamples: number;
  readonly latencySeconds: number;
  readonly semitones: number;
  readonly voiced: boolean;
  readonly frequencyHz: number;
  readonly confidence: number;
}

/**
 * AudioWorklet adapter for the clean-room mono YIN/PSOLA engine. Its render
 * callback only reads/copies channel data and runs the fixed-storage core: it
 * creates no scratch arrays, typed-array views, status objects or port messages.
 * Status is returned only on explicit requests, never once per render quantum.
 */
export class LiveMonoPitchWorkletProcessor extends LiveMonoProcessorBase {
  readonly core: LiveMonoPitchProcessor;
  private readonly silence = new Float32Array(128);

  constructor(options: LiveMonoWorkletProcessorOptions = {}) {
    super(options);
    const supplied = options.processorOptions;
    const sampleRate = Number.isFinite(supplied?.sampleRate)
      ? (supplied?.sampleRate as number)
      : (Number.isFinite(workletGlobals.sampleRate) ? (workletGlobals.sampleRate as number) : 48_000);
    const coreOptions: LiveMonoPitchProcessorOptions = { sampleRate };
    this.core = new LiveMonoPitchProcessor({
      ...coreOptions,
      ...(supplied?.semitones === undefined ? {} : { semitones: supplied.semitones }),
      ...(supplied?.minimumFrequencyHz === undefined
        ? {}
        : { minimumFrequencyHz: supplied.minimumFrequencyHz }),
      ...(supplied?.maximumFrequencyHz === undefined
        ? {}
        : { maximumFrequencyHz: supplied.maximumFrequencyHz }),
    });

    const port = this.port as unknown as LiveMonoWorkletPort;
    port.onmessage = (event: LiveMonoWorkletMessageEvent): void => {
      const message = event.data as Partial<LiveMonoWorkletMessage> | null;
      if (message?.type === 'set-semitones' && Number.isFinite(message.semitones)) {
        const semitones = message.semitones as number;
        if (semitones >= -12 && semitones <= 12) this.core.setSemitones(semitones);
      } else if (message?.type === 'get-status' && Number.isInteger(message.requestId)) {
        port.postMessage(this.createStatus('status', message.requestId as number));
      }
    };
    port.postMessage(this.createStatus('ready'));
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const inputChannels = inputs[0];
    const outputChannels = outputs[0];
    const monoOutput = outputChannels?.[0];
    if (!monoOutput) return true;

    const monoInput = inputChannels?.[0];
    let outputOffset = 0;
    if (monoInput) {
      const inputFrames = Math.min(monoInput.length, monoOutput.length);
      if (inputFrames > 0) {
        this.core.process(monoInput, monoOutput, inputFrames, 0, 0);
        outputOffset = inputFrames;
      }
    }
    while (outputOffset < monoOutput.length) {
      const frames = Math.min(this.silence.length, monoOutput.length - outputOffset);
      this.core.process(this.silence, monoOutput, frames, 0, outputOffset);
      outputOffset += frames;
    }

    // A mono input is deliberately downmixed by the node's explicit mono
    // input configuration. Multi-channel outputs receive the same shifted
    // mono signal, which keeps the processor's pitch model unambiguously mono.
    for (let channel = 1; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel];
      if (!output) continue;
      const copiedFrames = Math.min(output.length, monoOutput.length);
      for (let frame = 0; frame < copiedFrames; frame += 1) output[frame] = monoOutput[frame]!;
      for (let frame = copiedFrames; frame < output.length; frame += 1) output[frame] = 0;
    }
    return true;
  }

  private createStatus(type: 'ready' | 'status', requestId?: number): LiveMonoPitchStatus {
    return {
      type,
      ...(requestId === undefined ? {} : { requestId }),
      sampleRate: this.core.sampleRate,
      latencySamples: this.core.latencySamples,
      latencySeconds: this.core.latencySeconds,
      semitones: this.core.semitones,
      voiced: this.core.voiced,
      frequencyHz: this.core.frequencyHz,
      confidence: this.core.confidence,
    };
  }
}

if (typeof workletGlobals.registerProcessor === 'function') {
  workletGlobals.registerProcessor(
    'rc505-live-mono-pitch',
    LiveMonoPitchWorkletProcessor as LiveMonoProcessorBaseConstructor,
  );
}
