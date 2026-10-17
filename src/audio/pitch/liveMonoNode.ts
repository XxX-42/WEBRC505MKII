import liveMonoWorkletUrl from './liveMonoWorklet?worker&url';
import { getLiveMonoPitchLatencySamples, type LiveMonoPitchProcessorOptions } from './liveMono';
import type { LiveMonoPitchStatus } from './liveMonoWorklet';

const PROCESSOR_NAME = 'rc505-live-mono-pitch';

export interface CreateLiveMonoPitchNodeOptions {
  /** Initial transpose. Changes are slewed by the processor over about 12 ms. */
  readonly semitones?: number;
  readonly minimumFrequencyHz?: number;
  readonly maximumFrequencyHz?: number;
  /** Output is mono by default; stereo output duplicates the mono signal. */
  readonly outputChannels?: 1 | 2;
}

export interface LiveMonoPitchNodeControls {
  /** Exact sample latency, available before the worklet's first render quantum. */
  readonly latencySamples: number;
  readonly latencySeconds: number;
  /** Resolves with the worklet's constructor-time status when it starts. */
  readonly ready: Promise<LiveMonoPitchStatus>;
  setPitch(semitones: number): void;
  getStatus(): Promise<LiveMonoPitchStatus>;
}

/** An actual AudioWorkletNode with the LIVE_MONO controls attached. */
export type LiveMonoPitchNode = AudioWorkletNode & LiveMonoPitchNodeControls;

interface StatusRequest {
  readonly resolve: (status: LiveMonoPitchStatus) => void;
  readonly reject: (error: Error) => void;
}

const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();

function finiteInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validateOptions(
  sampleRate: number,
  options: CreateLiveMonoPitchNodeOptions,
): LiveMonoPitchProcessorOptions {
  if (!finiteInRange(sampleRate, 8_000, 192_000)) {
    throw new RangeError('sampleRate must be from 8 kHz through 192 kHz');
  }
  const semitones = options.semitones ?? 0;
  if (!finiteInRange(semitones, -12, 12)) {
    throw new RangeError('LIVE_MONO semitones must be between -12 and +12');
  }
  const minimumFrequencyHz = options.minimumFrequencyHz ?? 70;
  const maximumFrequencyHz = options.maximumFrequencyHz ?? 1_200;
  const decimation = Math.max(1, Math.ceil(sampleRate / 12_000));
  const detectorNyquist = (sampleRate / decimation) / 2;
  if (
    !finiteInRange(minimumFrequencyHz, 20, detectorNyquist) ||
    !finiteInRange(maximumFrequencyHz, minimumFrequencyHz + 1, detectorNyquist)
  ) {
    throw new RangeError('F0 limits must be finite, ordered and below the decimated Nyquist rate');
  }
  return { sampleRate, semitones, minimumFrequencyHz, maximumFrequencyHz };
}

function isPitchStatus(value: unknown): value is LiveMonoPitchStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<LiveMonoPitchStatus>;
  return (status.type === 'ready' || status.type === 'status') &&
    Number.isFinite(status.sampleRate) &&
    Number.isInteger(status.latencySamples) &&
    Number.isFinite(status.latencySeconds) &&
    Number.isFinite(status.semitones) &&
    typeof status.voiced === 'boolean' &&
    Number.isFinite(status.frequencyHz) &&
    Number.isFinite(status.confidence);
}

async function ensureWorkletLoaded(context: BaseAudioContext): Promise<void> {
  let loading = moduleLoads.get(context);
  if (!loading) {
    loading = context.audioWorklet.addModule(liveMonoWorkletUrl);
    moduleLoads.set(context, loading);
    try {
      await loading;
    } catch (error) {
      moduleLoads.delete(context);
      throw error;
    }
    return;
  }
  await loading;
}

/**
 * Loads the Vite-built LIVE_MONO AudioWorklet and returns its direct audio
 * node. The node consumes a mono-downmixed input and emits mono or duplicated
 * stereo output. Connect/disconnect it with standard Web Audio node methods.
 */
export async function createLiveMonoPitchNode(
  context: BaseAudioContext,
  options: CreateLiveMonoPitchNodeOptions = {},
): Promise<LiveMonoPitchNode> {
  const processorOptions = validateOptions(context.sampleRate, options);
  if (typeof context.audioWorklet === 'undefined') {
    throw new Error('LIVE_MONO requires AudioWorklet support in this audio context');
  }
  await ensureWorkletLoaded(context);

  const outputChannels = options.outputChannels ?? 2;
  const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [outputChannels],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions,
  }) as LiveMonoPitchNode;

  const latencySamples = getLiveMonoPitchLatencySamples(
    context.sampleRate,
    processorOptions.minimumFrequencyHz,
  );
  const pending = new Map<number, StatusRequest>();
  let nextRequestId = 1;
  let readyResolved = false;
  let resolveReady: (status: LiveMonoPitchStatus) => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<LiveMonoPitchStatus>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const failOutstanding = (error: Error): void => {
    if (!readyResolved) rejectReady(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  node.port.onmessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isPitchStatus(message)) return;
    if (message.type === 'ready') {
      readyResolved = true;
      resolveReady(message);
    } else if (Number.isInteger(message.requestId)) {
      const requestId = message.requestId as number;
      const request = pending.get(requestId);
      if (request) {
        pending.delete(requestId);
        request.resolve(message);
      }
    }
  };
  node.addEventListener('processorerror', () => {
    failOutstanding(new Error('LIVE_MONO AudioWorklet processor failed'));
  });

  Object.defineProperties(node, {
    latencySamples: { value: latencySamples, enumerable: true },
    latencySeconds: { value: latencySamples / context.sampleRate, enumerable: true },
    ready: { value: ready, enumerable: true },
    setPitch: {
      value: (semitones: number): void => {
        if (!finiteInRange(semitones, -12, 12)) {
          throw new RangeError('LIVE_MONO semitones must be between -12 and +12');
        }
        node.port.postMessage({ type: 'set-semitones', semitones });
      },
    },
    getStatus: {
      value: (): Promise<LiveMonoPitchStatus> => new Promise((resolve, reject) => {
        const requestId = nextRequestId;
        nextRequestId += 1;
        pending.set(requestId, { resolve, reject });
        node.port.postMessage({ type: 'get-status', requestId });
      }),
    },
  });

  return node;
}
