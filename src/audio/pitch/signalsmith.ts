import type { PitchMode } from './contracts';
import createSignalsmithStretchWasm from './vendor/SignalsmithStretchWasm.mjs';
import {
  signalsmithLiveWasmLedger,
  type SignalsmithLiveWasmLease,
} from './signalsmithWasmBudget';

export interface OfflinePitchOptions {
  readonly mode: 'HQ_RENDER';
  readonly sampleRate: number;
  readonly semitones?: number;
  /** Input frames per output frame. 0.8 makes the output 1.25x as long. */
  readonly playbackRate?: number;
  readonly tonalityLimitHz?: number;
  /** Work is chunked internally; this is not the Web Audio render quantum. */
  readonly chunkFrames?: number;
  /** Optional offline-only progress hook; never called by a real-time callback. */
  readonly onProgress?: (fraction: number) => void;
}

export interface OfflinePitchResult {
  readonly mode: 'HQ_RENDER';
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
  readonly latencySamples: number;
  readonly inputLatencySamples: number;
  readonly outputLatencySamples: number;
  readonly windowSamples: number;
  readonly hopSamples: number;
  readonly playbackRate: number;
  readonly semitones: number;
  /** Caller must account for this delay when aligning/exporting the result. */
  readonly leadingLatencySamples: number;
}

export interface LivePolyPitchOptions {
  readonly mode: 'LIVE_POLY';
  readonly channels: 1 | 2;
  readonly semitones?: number;
  readonly playbackRate?: number;
  readonly tonalityLimitHz?: number;
}

/** Options for a connected, streaming Signalsmith transpose effect. */
export interface LiveInputTransposeOptions {
  readonly mode: 'LIVE_FX';
  /** Opt-in extended bend endpoints; existing adapters retain their ±24 range. */
  readonly pitchRange?: 'official-bend';
  readonly channels: 1 | 2;
  readonly semitones?: number;
  readonly tonalityLimitHz?: number;
}

export interface LiveInputTransposeNode extends AudioWorkletNode {
  readonly mode: 'LIVE_FX';
  readonly latencySamples: number;
  readonly latencySeconds: number;
  /** Current reserved linear-memory capacity reported by this Worklet's WASM instance. */
  readonly wasmHeapBytes: number;
  /** Query the live instance; never treat this as browser RSS or allocator-used bytes. */
  getWasmHeapBytes(): Promise<number>;
  /** Disconnect and release the bounded Worklet lease after its disposal ACK. */
  releaseWasmMemory(): Promise<void>;
  /** Schedule a validated input-pitch target in the output time domain. */
  /** Immediate retunes replace pending events by default; ordered queues pass false. */
  /**
   * Pitch and formant points share one vendor schedule event. ROBOT enables
   * compensation for preservation/independent shifting and anchors it to its
   * tracked source F0; a base frequency of 0 requests vendor autodetection.
   */
  setPitch(
    semitones: number,
    outputTime?: number,
    replaceFuture?: boolean,
    formantSemitones?: number,
    formantBaseHz?: number,
    formantCompensation?: boolean,
  ): Promise<unknown>;
}

export interface LivePolyPitchLoopOptions {
  /** Input position and loop bounds are seconds in the loaded buffer. */
  readonly inputOffsetSeconds: number;
  readonly loopStartSeconds: number;
  readonly loopEndSeconds: number;
  /** Output-domain time at which this playback segment becomes active. */
  readonly outputTime?: number;
  readonly semitones?: number;
  readonly playbackRate?: number;
  readonly tonalityLimitHz?: number;
}

export interface LivePolyPitchRateRampOptions {
  /** Seconds spent smoothly retuning the source/output time ratio. */
  readonly durationSeconds?: number;
  /** Lets the owning track cancel future ramp points after a route/state change. */
  readonly isCurrent?: () => boolean;
}

export interface LivePolyPitchRateRampResult {
  readonly startTime: number;
  readonly endTime: number;
  readonly fromRate: number;
  readonly toRate: number;
}

export interface LivePolyPitchSegmentOptions {
  /** Input position and exclusive end of this finite pass, in seconds. */
  readonly inputOffsetSeconds: number;
  readonly inputEndSeconds: number;
  readonly outputTime?: number;
  readonly semitones?: number;
  readonly playbackRate?: number;
  readonly tonalityLimitHz?: number;
}

export interface LivePolyPitchNode extends AudioWorkletNode {
  readonly mode: 'LIVE_POLY';
  readonly latencySamples: number;
  readonly latencySeconds: number;
  readonly wasmHeapBytes: number;
  getWasmHeapBytes(): Promise<number>;
  releaseWasmMemory(): Promise<void>;
  /** Copies one mono or stereo loop into the Worklet-owned buffer queue. */
  loadBuffer(channels: readonly Float32Array[]): Promise<number>;
  /** Clears all buffered audio from the Worklet. */
  clearBuffers(): Promise<unknown>;
  /** Starts/replaces a looping internal-buffer segment (not a connected live input). */
  scheduleLoop(options: LivePolyPitchLoopOptions): Promise<unknown>;
  /** Schedules one finite read without loop bounds. */
  scheduleSegment(options: LivePolyPitchSegmentOptions): Promise<unknown>;
  setPitch(semitones: number, outputTime?: number, playbackRate?: number): Promise<unknown>;
  /** Smoothly retunes an active internal-buffer loop without replacing its PCM. */
  setPlaybackRate(playbackRate: number, options?: LivePolyPitchRateRampOptions): Promise<LivePolyPitchRateRampResult>;
  startProcessing(outputTime?: number): Promise<unknown>;
  stopProcessing(outputTime?: number): Promise<unknown>;
}

const DEFAULT_CHUNK_FRAMES = 128;

type ManagedSignalsmithNode = AudioWorkletNode & {
  wasmHeapBytes(): Promise<unknown>;
  disposeWasmMemory(): Promise<unknown>;
  configure(config: { preset?: 'cheaper'; blockMs?: number; intervalMs?: number; splitComputation?: boolean }): Promise<unknown>;
  latency(): Promise<unknown>;
  start(when?: number, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<unknown>;
  stop(when?: number): Promise<unknown>;
  schedule(change: Record<string, unknown>): Promise<unknown>;
  addBuffers(buffers: Float32Array[], transfer?: Transferable[]): Promise<number>;
  dropBuffers(toSeconds?: number): Promise<unknown>;
};

type BudgetedSignalsmithNode = Omit<ManagedSignalsmithNode, 'wasmHeapBytes'> & {
  readonly wasmHeapBytes: number;
  getWasmHeapBytes(): Promise<number>;
  releaseWasmMemory(): Promise<void>;
};

function unwrapSignalsmithResult<T>(result: unknown, operation: string): T {
  if (
    result && typeof result === 'object' && '__signalsmithError' in result &&
    typeof (result as { __signalsmithError?: unknown }).__signalsmithError === 'string'
  ) {
    throw new Error(`Signalsmith ${operation} failed: ${(result as { __signalsmithError: string }).__signalsmithError}`);
  }
  return result as T;
}

function attachWasmLease<Node extends ManagedSignalsmithNode>(
  node: Node,
  context: BaseAudioContext,
  lease: SignalsmithLiveWasmLease,
): Omit<Node, 'wasmHeapBytes'> & {
  readonly wasmHeapBytes: number;
  getWasmHeapBytes(): Promise<number>;
  releaseWasmMemory(): Promise<void>;
} {
  let observedHeapBytes = 0;
  let releasePromise: Promise<void> | null = null;
  const remoteHeapQuery = node.wasmHeapBytes.bind(node);
  const nativeDisconnect = node.disconnect.bind(node) as (...args: unknown[]) => void;
  const releaseAfterClosedContext = () => {
    if (context.state !== 'closed') return;
    lease.release();
    node.port.close();
    context.removeEventListener('statechange', releaseAfterClosedContext);
  };
  context.addEventListener('statechange', releaseAfterClosedContext);

  const getWasmHeapBytes = async (): Promise<number> => {
    const reported = unwrapSignalsmithResult<number>(await remoteHeapQuery(), 'heap query');
    if (observedHeapBytes === 0) lease.confirm(reported);
    else lease.observe(reported);
    observedHeapBytes = reported;
    return reported;
  };
  const releaseWasmMemory = (): Promise<void> => {
    if (releasePromise) return releasePromise;
    nativeDisconnect();
    if (context.state === 'closed') {
      lease.release();
      node.port.close();
      context.removeEventListener('statechange', releaseAfterClosedContext);
      releasePromise = Promise.resolve();
      return releasePromise;
    }
    releasePromise = (async () => {
      try {
        const reported = unwrapSignalsmithResult<number>(await node.disposeWasmMemory(), 'dispose');
        if (!Number.isSafeInteger(reported) || reported <= 0 || reported % 65536 !== 0) {
          throw new RangeError(`Signalsmith dispose ACK returned invalid memory size: ${reported}`);
        }
        if (observedHeapBytes > 0 && reported < observedHeapBytes) {
          throw new RangeError('Signalsmith dispose ACK reported a shrinking WASM memory capacity');
        }
        // The ACK confirms the processor dropped its instance. No new memory
        // reservation is needed while retiring it, even if a bad module
        // reported a capacity above its role ceiling before disposal.
        lease.release();
        node.port.close();
        context.removeEventListener('statechange', releaseAfterClosedContext);
      } catch (cause) {
        // Do not free aggregate capacity until the processor confirms disposal.
        // A closed AudioContext is the other reliable lifetime boundary.
        const detail = cause instanceof Error ? cause.message : String(cause);
        lease.markReleaseUnconfirmed(detail);
        releaseAfterClosedContext();
      }
    })();
    return releasePromise;
  };

  Object.defineProperties(node, {
    wasmHeapBytes: { enumerable: true, get: () => observedHeapBytes },
    getWasmHeapBytes: { enumerable: true, value: getWasmHeapBytes },
    releaseWasmMemory: { enumerable: true, value: releaseWasmMemory },
    disconnect: {
      configurable: true,
      value: (...args: unknown[]) => {
        // All project call sites use disconnect() only when retiring a node.
        // Targeted disconnects are graph edits and keep the WASM lease resident.
        if (args.length === 0) void releaseWasmMemory();
        else nativeDisconnect(...args);
      },
    },
  });
  node.addEventListener('processorerror', () => {
    lease.markReleaseUnconfirmed('AudioWorklet processorerror; reservation held until dispose ACK or context close');
  }, { once: true });
  return node as unknown as Omit<Node, 'wasmHeapBytes'> & {
    readonly wasmHeapBytes: number;
    getWasmHeapBytes(): Promise<number>;
    releaseWasmMemory(): Promise<void>;
  };
}

async function createBudgetedSignalsmithNode(
  context: BaseAudioContext,
  role: 'LIVE_FX' | 'LIVE_POLY',
  channels: number,
  initialConfig: { preset?: 'cheaper'; blockMs?: number; intervalMs?: number; splitComputation?: boolean },
): Promise<BudgetedSignalsmithNode> {
  if (context.state === 'closed') throw new Error('Cannot allocate a Signalsmith pitch node on a closed AudioContext');
  const lease = signalsmithLiveWasmLedger(context).reserve(role);
  let managedNode: BudgetedSignalsmithNode | null = null;
  try {
    const { default: createNode } = await import('./vendor/SignalsmithStretch.mjs');
    const rawNode = await createNode(context, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      channelCount: channels,
      channelCountMode: 'explicit',
      ...(role === 'LIVE_FX' ? { channelInterpretation: 'speakers' as const } : {}),
      processorOptions: {
        signalsmithMaxWasmHeapBytes: lease.ceilingBytes,
        signalsmithInitialConfig: initialConfig,
      },
    });
    managedNode = attachWasmLease(rawNode as ManagedSignalsmithNode, context, lease);
    await managedNode.getWasmHeapBytes();
    return managedNode;
  } catch (cause) {
    if (managedNode) {
      await managedNode.releaseWasmMemory();
    } else {
      // Worklet bootstrap failures before an AudioWorkletNode is returned do
      // not expose an RPC handle. Keep the reservation until context shutdown
      // rather than assume that a timed-out processor released its instance.
      const message = cause instanceof Error ? cause.message : String(cause);
      const releaseConfirmed = Boolean(cause && typeof cause === 'object' && 'wasmMemoryReleased' in cause && (cause as { wasmMemoryReleased?: unknown }).wasmMemoryReleased === true);
      const releaseUnconfirmed = Boolean(cause && typeof cause === 'object' && 'wasmMemoryReleased' in cause && (cause as { wasmMemoryReleased?: unknown }).wasmMemoryReleased === false);
      if (releaseConfirmed || !releaseUnconfirmed) {
        lease.release();
      } else {
        lease.markReleaseUnconfirmed(`Worklet startup could not be confirmed: ${message}`);
      }
    }
    throw cause;
  }
}

function validateChannels(input: readonly Float32Array[]): number {
  if (input.length < 1 || input.length > 2) {
    throw new RangeError('Signalsmith pitch supports one or two channels in this adapter');
  }
  const sampleCount = input[0]?.length ?? 0;
  if (sampleCount === 0 || input.some((channel) => channel.length !== sampleCount)) {
    throw new RangeError('Pitch input channels must be non-empty and have equal lengths');
  }
  return sampleCount;
}

function validateRate(value: number): void {
  if (!Number.isFinite(value) || value < 0.5 || value > 2) {
    throw new RangeError('playbackRate must be between 0.5 and 2');
  }
}

function validateSemitones(value: number): void {
  if (!Number.isFinite(value) || value < -24 || value > 24) {
    throw new RangeError('semitones must be between -24 and +24');
  }
}

function validateContextSampleRate(context: BaseAudioContext): void {
  if (!Number.isFinite(context.sampleRate) || context.sampleRate < 8000 || context.sampleRate > 192000) {
    throw new RangeError('Signalsmith live sample rate must be between 8 kHz and 192 kHz');
  }
}

/**
 * Offline KeepPitch/pitch-shift renderer backed by the upstream Signalsmith WASM.
 * It is deliberately not suitable for a live callback: it performs a complete
 * render synchronously and returns a latency-aligned result for caller review.
 */
export async function renderPitchOffline(
  input: readonly Float32Array[],
  options: OfflinePitchOptions,
): Promise<OfflinePitchResult> {
  if (options.mode !== 'HQ_RENDER') throw new Error('Offline rendering requires HQ_RENDER mode');
  const sampleCount = validateChannels(input);
  const rate = options.playbackRate ?? 1;
  validateRate(rate);
  const sampleRate = options.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('sampleRate must be between 8 kHz and 192 kHz');
  }
  const semitones = options.semitones ?? 0;
  if (!Number.isFinite(semitones) || semitones < -24 || semitones > 24) {
    throw new RangeError('semitones must be between -24 and +24');
  }
  const chunkFrames = options.chunkFrames ?? DEFAULT_CHUNK_FRAMES;
  if (!Number.isInteger(chunkFrames) || chunkFrames < 16 || chunkFrames > 2048) {
    throw new RangeError('chunkFrames must be an integer from 16 through 2048');
  }

  const engine = await createSignalsmithStretchWasm();
  engine._presetDefault(input.length, sampleRate);
  engine._setTransposeSemitones(semitones, (options.tonalityLimitHz ?? 8000) / sampleRate);

  const inputLatencySamples = engine._inputLatency();
  const outputLatencySamples = engine._outputLatency();
  const latencySamples = inputLatencySamples + outputLatencySamples;
  const coreOutputFrames = Math.ceil(sampleCount / rate);
  const outputFrames = coreOutputFrames + latencySamples;
  const maxInputFrames = Math.ceil(chunkFrames * Math.max(rate, 1)) + 1;
  const bufferFrames = Math.max(chunkFrames, maxInputFrames);
  const bufferPointer = engine._setBuffers(input.length, bufferFrames);
  const output = input.map(() => new Float32Array(outputFrames));
  let inputCursor = 0;

  for (let outputCursor = 0; outputCursor < outputFrames;) {
    const outputFramesThisChunk = Math.min(chunkFrames, outputFrames - outputCursor);
    const inputEnd = Math.round((outputCursor + outputFramesThisChunk) * rate);
    const inputFramesThisChunk = inputEnd - inputCursor;
    if (inputFramesThisChunk > bufferFrames) {
      throw new RangeError('internal pitch buffer capacity exceeded');
    }

    const memory = engine.HEAP8.buffer;
    for (let channel = 0; channel < input.length; channel += 1) {
      const inputView = new Float32Array(
        memory,
        bufferPointer + channel * bufferFrames * Float32Array.BYTES_PER_ELEMENT,
        inputFramesThisChunk,
      );
      for (let i = 0; i < inputFramesThisChunk; i += 1) {
        const sourceIndex = inputCursor + i;
        inputView[i] = sourceIndex < sampleCount ? input[channel]![sourceIndex]! : 0;
      }
    }

    engine._process(inputFramesThisChunk, outputFramesThisChunk);
    const outputMemory = engine.HEAP8.buffer;
    for (let channel = 0; channel < input.length; channel += 1) {
      const outputView = new Float32Array(
        outputMemory,
        bufferPointer + (channel + input.length) * bufferFrames * Float32Array.BYTES_PER_ELEMENT,
        outputFramesThisChunk,
      );
      output[channel]!.set(outputView, outputCursor);
    }
    inputCursor = inputEnd;
    outputCursor += outputFramesThisChunk;
    options.onProgress?.(outputCursor / outputFrames);
  }

  return Object.freeze({
    mode: 'HQ_RENDER' as const,
    channels: Object.freeze(output),
    sampleRate,
    latencySamples,
    inputLatencySamples,
    outputLatencySamples,
    windowSamples: engine._blockSamples(),
    hopSamples: engine._intervalSamples(),
    playbackRate: rate,
    semitones,
    leadingLatencySamples: latencySamples,
  });
}

/** Creates a real-time polyphonic pitch node using Signalsmith's AudioWorklet. */
export async function createLivePolyPitchNode(
  context: BaseAudioContext,
  options: LivePolyPitchOptions,
): Promise<LivePolyPitchNode> {
  if ((options.mode as PitchMode) !== 'LIVE_POLY') {
    throw new Error('The live Worklet adapter only implements LIVE_POLY');
  }
  validateContextSampleRate(context);
  validateRate(options.playbackRate ?? 1);
  const semitones = options.semitones ?? 0;
  validateSemitones(semitones);
  const tonalityLimitHz = options.tonalityLimitHz ?? Math.min(8000, context.sampleRate * 0.45);
  if (!Number.isFinite(tonalityLimitHz) || tonalityLimitHz <= 0 || tonalityLimitHz > context.sampleRate / 2) {
    throw new RangeError('tonalityLimitHz must be positive, finite, and no greater than Nyquist');
  }

  const node = await createBudgetedSignalsmithNode(context, 'LIVE_POLY', options.channels, { preset: 'cheaper' });
  let latencySeconds: number;
  try {
    latencySeconds = unwrapSignalsmithResult<number>(await node.latency(), 'latency query');
    if (!Number.isFinite(latencySeconds) || latencySeconds < 0) throw new RangeError('Signalsmith returned invalid LIVE_POLY latency');
  } catch (cause) {
    await node.releaseWasmMemory();
    throw cause;
  }
  const latencySamples = Math.round(latencySeconds * context.sampleRate);
  const initialSemitones = options.semitones ?? 0;
  const initialPlaybackRate = options.playbackRate ?? 1;
  let activeLoop: {
    readonly loopStartSeconds: number;
    readonly loopEndSeconds: number;
    playbackRate: number;
    semitones: number;
    readonly tonalityLimitHz: number;
  } | null = null;
  let activeRateRamp: { readonly startTime: number; readonly endTime: number; readonly from: number; readonly to: number } | null = null;

  const liveNode = node as unknown as LivePolyPitchNode;
  Object.defineProperties(liveNode, {
    mode: { value: 'LIVE_POLY', enumerable: true },
    latencySamples: { value: latencySamples, enumerable: true },
    latencySeconds: { value: latencySeconds, enumerable: true },
    loadBuffer: {
      value: (channels: readonly Float32Array[]) => {
        if (channels.length < 1 || channels.length > 2) {
          throw new RangeError('Signalsmith pitch supports one or two buffer channels');
        }
        const length = channels[0]?.length ?? 0;
        if (length === 0 || channels.some((channel) => channel.length !== length)) {
          throw new RangeError('Pitch buffer channels must be non-empty and have equal lengths');
        }
        // Transfer a private copy so structured cloning doesn't copy a large loop a
        // second time. AudioBuffer storage remains attached to the main thread.
        // Connecting a BufferSource instead uses Signalsmith's live-input branch,
        // which is a different, 1:1 path and does not apply the stretch rate.
        const copiedChannels = channels.map((channel) => new Float32Array(channel));
        return node.addBuffers(copiedChannels, copiedChannels.map((channel) => channel.buffer));
      },
    },
    clearBuffers: { value: () => node.dropBuffers() },
    scheduleLoop: {
      value: (loop: LivePolyPitchLoopOptions) => {
        const rate = loop.playbackRate ?? initialPlaybackRate;
        validateRate(rate);
        const semitones = loop.semitones ?? initialSemitones;
        if (!Number.isFinite(semitones) || semitones < -24 || semitones > 24) {
          throw new RangeError('semitones must be between -24 and +24');
        }
        const currentTonalityLimitHz = loop.tonalityLimitHz ?? tonalityLimitHz;
        if (!Number.isFinite(currentTonalityLimitHz) || currentTonalityLimitHz <= 0 || currentTonalityLimitHz > context.sampleRate / 2) {
          throw new RangeError('tonalityLimitHz must be positive, finite, and no greater than Nyquist');
        }
        const { inputOffsetSeconds, loopStartSeconds, loopEndSeconds } = loop;
        if (
          !Number.isFinite(inputOffsetSeconds) ||
          !Number.isFinite(loopStartSeconds) ||
          !Number.isFinite(loopEndSeconds) ||
          loopEndSeconds <= loopStartSeconds ||
          inputOffsetSeconds < loopStartSeconds ||
          inputOffsetSeconds >= loopEndSeconds
        ) {
          throw new RangeError('Loop offset and bounds must describe a non-empty region');
        }
        const outputTime = loop.outputTime ?? context.currentTime + latencySeconds;
        activeLoop = {
          loopStartSeconds,
          loopEndSeconds,
          playbackRate: rate,
          semitones,
          tonalityLimitHz: currentTonalityLimitHz,
        };
        activeRateRamp = null;
        return node.schedule({
          active: true,
          input: inputOffsetSeconds,
          // The upstream adapter uses output for the time-map segment and
          // outputTime to decide which future segments should be replaced.
          output: outputTime,
          outputTime,
          rate,
          semitones,
          tonalityHz: currentTonalityLimitHz,
          loopStart: loopStartSeconds,
          loopEnd: loopEndSeconds,
        });
      },
    },
    scheduleSegment: {
      value: (segment: LivePolyPitchSegmentOptions) => {
        const rate = segment.playbackRate ?? initialPlaybackRate;
        validateRate(rate);
        const semitones = segment.semitones ?? initialSemitones;
        validateSemitones(semitones);
        const currentTonalityLimitHz = segment.tonalityLimitHz ?? tonalityLimitHz;
        if (!Number.isFinite(currentTonalityLimitHz) || currentTonalityLimitHz <= 0 || currentTonalityLimitHz > context.sampleRate / 2) {
          throw new RangeError('Signalsmith tonality limit must be positive, finite, and no greater than Nyquist');
        }
        if (!Number.isFinite(segment.inputOffsetSeconds) || !Number.isFinite(segment.inputEndSeconds)
            || segment.inputOffsetSeconds < 0 || segment.inputEndSeconds <= segment.inputOffsetSeconds) {
          throw new RangeError('Finite pitch segment must describe a non-empty input range');
        }
        activeLoop = null;
        activeRateRamp = null;
        const outputTime = segment.outputTime ?? context.currentTime + latencySeconds;
        return node.schedule({
          active: true,
          input: segment.inputOffsetSeconds,
          output: outputTime,
          outputTime,
          rate,
          semitones,
          tonalityHz: currentTonalityLimitHz,
        });
      },
    },
    setPitch: {
      value: (nextSemitones: number, outputTime = context.currentTime + latencySeconds, playbackRate?: number) => {
        const rate = playbackRate ?? activeLoop?.playbackRate ?? initialPlaybackRate;
        validateRate(rate);
        if (!Number.isFinite(nextSemitones) || nextSemitones < -24 || nextSemitones > 24) {
          throw new RangeError('semitones must be between -24 and +24');
        }
        const loopBounds = activeLoop
          ? { loopStart: activeLoop.loopStartSeconds, loopEnd: activeLoop.loopEndSeconds }
          : {};
        if (activeLoop) activeLoop.semitones = nextSemitones;
        return node.schedule({
          active: true,
          outputTime,
          output: outputTime,
          rate,
          semitones: nextSemitones,
          tonalityHz: activeLoop?.tonalityLimitHz ?? tonalityLimitHz,
          ...loopBounds,
        });
      },
    },
    setPlaybackRate: {
      value: async (nextRate: number, ramp: LivePolyPitchRateRampOptions = {}) => {
        validateRate(nextRate);
        if (!activeLoop) throw new Error('Signalsmith playback-rate follow requires an active LIVE_POLY loop.');
        const loop = activeLoop;
        const durationSeconds = ramp.durationSeconds ?? 0.4;
        if (!Number.isFinite(durationSeconds) || durationSeconds < 0.1 || durationSeconds > 2) {
          throw new RangeError('LIVE_POLY playback-rate ramp duration must be between 0.1 and 2 seconds.');
        }

        const startTime = context.currentTime + latencySeconds;
        const currentRate = activeRateRamp && startTime < activeRateRamp.endTime
          ? activeRateRamp.from + (activeRateRamp.to - activeRateRamp.from)
            * Math.max(0, Math.min(1, (startTime - activeRateRamp.startTime) / (activeRateRamp.endTime - activeRateRamp.startTime)))
          : loop.playbackRate;
        const steps = Math.max(4, Math.ceil(durationSeconds / 0.05));
        const endTime = startTime + durationSeconds;
        const scheduledRates: number[] = [];
        try {
          // A short series of contiguous source-time-map points gives a gentle
          // rate ramp while preserving the reader cursor. No AudioBuffer is
          // rewritten or reloaded, and pitch remains an independent parameter.
          for (let step = 0; step <= steps; step += 1) {
            if (ramp.isCurrent && !ramp.isCurrent()) {
              throw new Error('LIVE_POLY playback-rate ramp was cancelled after the track route changed.');
            }
            const fraction = step / steps;
            const rate = currentRate + (nextRate - currentRate) * fraction;
            const outputTime = startTime + durationSeconds * fraction;
            await node.schedule({
              active: true,
              output: outputTime,
              outputTime,
              rate,
              semitones: loop.semitones,
              tonalityHz: loop.tonalityLimitHz,
              loopStart: loop.loopStartSeconds,
              loopEnd: loop.loopEndSeconds,
            });
            scheduledRates.push(rate);
          }
        } catch (error) {
          const lastScheduled = scheduledRates[scheduledRates.length - 1];
          if (lastScheduled !== undefined) {
            loop.playbackRate = lastScheduled;
            activeRateRamp = {
              startTime,
              endTime: startTime + durationSeconds * (scheduledRates.length - 1) / steps,
              from: currentRate,
              to: lastScheduled,
            };
          }
          throw error;
        }
        loop.playbackRate = nextRate;
        activeRateRamp = { startTime, endTime, from: currentRate, to: nextRate };
        return Object.freeze({ startTime, endTime, fromRate: currentRate, toRate: nextRate });
      },
    },
    startProcessing: {
      value: (outputTime = context.currentTime + latencySeconds) => node.start(outputTime, undefined, undefined, options.playbackRate ?? 1, semitones),
    },
    stopProcessing: {
      value: (outputTime = context.currentTime + latencySeconds) => node.stop(outputTime),
    },
  });
  return liveNode;
}

/**
 * Creates a lower-latency connected live-input pitch-shift node for Browser
 * FX. Unlike the loop adapter, this always schedules the streaming input path;
 * it never uses playback-rate/varispeed or a BufferSource loop.
 */
export async function createLiveInputTransposeNode(
  context: BaseAudioContext,
  options: LiveInputTransposeOptions,
): Promise<LiveInputTransposeNode> {
  if (options.mode !== 'LIVE_FX') throw new Error('Connected input transposition requires LIVE_FX mode');
  validateContextSampleRate(context);
  if (options.channels !== 1 && options.channels !== 2) {
    throw new RangeError('Signalsmith pitch supports one or two live channels');
  }
  const semitones = options.semitones ?? 0;
  const validateLiveSemitones = (value: number): void => {
    if (options.pitchRange !== 'official-bend') return validateSemitones(value);
    if (!Number.isFinite(value) || value < -36 || value > 48) {
      throw new RangeError('official bend semitones must be between -36 and +48');
    }
  };
  validateLiveSemitones(semitones);
  const tonalityLimitHz = options.tonalityLimitHz ?? Math.min(8000, context.sampleRate * 0.45);
  if (!Number.isFinite(tonalityLimitHz) || tonalityLimitHz <= 0 || tonalityLimitHz > context.sampleRate / 2) {
    throw new RangeError('tonalityLimitHz must be positive, finite, and no greater than Nyquist');
  }

  // The default/cheaper presets use 120–140 ms of processing latency. A 24 ms
  // STFT block with quarter-block hops stays responsive while preserving
  // pitch accuracy at both ends of the supported ±24-semitone range.
  const node = await createBudgetedSignalsmithNode(context, 'LIVE_FX', options.channels, {
    blockMs: 24,
    intervalMs: 6,
    splitComputation: false,
  });
  let latencySeconds: number;
  try {
    latencySeconds = unwrapSignalsmithResult<number>(await node.latency(), 'latency query');
  } catch (cause) {
    await node.releaseWasmMemory();
    throw cause;
  }
  if (!Number.isFinite(latencySeconds) || latencySeconds < 0 || latencySeconds > 0.025) {
    await node.releaseWasmMemory();
    throw new Error('Signalsmith returned an unsupported live-FX latency');
  }
  const latencySamples = Math.round(latencySeconds * context.sampleRate);
  let currentSemitones = semitones;
  let currentFormantSemitones = 0;
  let currentFormantBaseHz = 0;
  let currentFormantCompensation = false;
  let lastScheduledOutputTime = Number.NEGATIVE_INFINITY;

  const liveNode = node as unknown as LiveInputTransposeNode;
  Object.defineProperties(liveNode, {
    mode: { value: 'LIVE_FX', enumerable: true },
    latencySamples: { value: latencySamples, enumerable: true },
    latencySeconds: { value: latencySeconds, enumerable: true },
    setPitch: {
      value: (
        nextSemitones: number,
        outputTime = context.currentTime + latencySeconds,
        replaceFuture = true,
        nextFormantSemitones = currentFormantSemitones,
        nextFormantBaseHz = currentFormantBaseHz,
        nextFormantCompensation = currentFormantCompensation,
      ) => {
        validateLiveSemitones(nextSemitones);
        if (!Number.isFinite(nextFormantSemitones) || nextFormantSemitones < -12 || nextFormantSemitones > 12) {
          throw new RangeError('formantSemitones must be between -12 and +12');
        }
        if (!Number.isFinite(nextFormantBaseHz) || nextFormantBaseHz < 0 || nextFormantBaseHz > context.sampleRate / 2) {
          throw new RangeError('formantBaseHz must be zero for autodetection or within the audible Nyquist range');
        }
        if (typeof nextFormantCompensation !== 'boolean') {
          throw new TypeError('formantCompensation must be a boolean');
        }
        if (!Number.isFinite(outputTime) || outputTime < context.currentTime) {
          throw new RangeError('outputTime must be a finite time at or after the current AudioContext time');
        }
        if (!replaceFuture && outputTime <= lastScheduledOutputTime) {
          throw new RangeError('outputTime must increase; use replaceFuture only to restart or cancel pending points');
        }
        const previousScheduledOutputTime = lastScheduledOutputTime;
        const previousSemitones = currentSemitones;
        const previousFormantSemitones = currentFormantSemitones;
        const previousFormantBaseHz = currentFormantBaseHz;
        const previousFormantCompensation = currentFormantCompensation;
        lastScheduledOutputTime = outputTime;
        currentSemitones = nextSemitones;
        currentFormantSemitones = nextFormantSemitones;
        currentFormantBaseHz = nextFormantBaseHz;
        currentFormantCompensation = nextFormantCompensation;
        return Promise.resolve(node.schedule({
          active: true,
          output: outputTime,
          outputTime,
          rate: 1,
          semitones: currentSemitones,
          tonalityHz: tonalityLimitHz,
          formantSemitones: currentFormantSemitones,
          formantCompensation: currentFormantCompensation,
          formantBaseHz: currentFormantBaseHz,
        })).then((result: unknown) => {
          if (
            result &&
            typeof result === 'object' &&
            '__signalsmithError' in result &&
            typeof (result as { __signalsmithError?: unknown }).__signalsmithError === 'string'
          ) {
            throw new Error((result as { __signalsmithError: string }).__signalsmithError);
          }
          return result;
        }).catch((cause: unknown) => {
          if (lastScheduledOutputTime === outputTime) {
            lastScheduledOutputTime = previousScheduledOutputTime;
            currentSemitones = previousSemitones;
            currentFormantSemitones = previousFormantSemitones;
            currentFormantBaseHz = previousFormantBaseHz;
            currentFormantCompensation = previousFormantCompensation;
          }
          throw cause;
        });
      },
    },
  });

  try {
    await liveNode.setPitch(semitones);
    return liveNode;
  } catch (cause) {
    await liveNode.releaseWasmMemory();
    throw cause;
  }
}
