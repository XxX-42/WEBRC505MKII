import type { PitchMode } from './contracts';
import createSignalsmithStretchWasm from './vendor/SignalsmithStretchWasm.mjs';

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
  readonly channels: 1 | 2;
  readonly semitones?: number;
  readonly tonalityLimitHz?: number;
}

export interface LiveInputTransposeNode extends AudioWorkletNode {
  readonly mode: 'LIVE_FX';
  readonly latencySamples: number;
  readonly latencySeconds: number;
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

export interface LivePolyPitchNode extends AudioWorkletNode {
  readonly mode: 'LIVE_POLY';
  readonly latencySamples: number;
  readonly latencySeconds: number;
  /** Copies one mono or stereo loop into the Worklet-owned buffer queue. */
  loadBuffer(channels: readonly Float32Array[]): Promise<number>;
  /** Clears all buffered audio from the Worklet. */
  clearBuffers(): Promise<unknown>;
  /** Starts/replaces a looping internal-buffer segment (not a connected live input). */
  scheduleLoop(options: LivePolyPitchLoopOptions): Promise<unknown>;
  setPitch(semitones: number, outputTime?: number, playbackRate?: number): Promise<unknown>;
  startProcessing(outputTime?: number): Promise<unknown>;
  stopProcessing(outputTime?: number): Promise<unknown>;
}

const DEFAULT_CHUNK_FRAMES = 128;

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
  validateRate(options.playbackRate ?? 1);
  const semitones = options.semitones ?? 0;
  validateSemitones(semitones);

  const { default: createNode } = await import('./vendor/SignalsmithStretch.mjs');
  const node = await createNode(context, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [options.channels],
    channelCount: options.channels,
    channelCountMode: 'explicit',
  });
  await node.configure({ preset: 'cheaper' });
  const latencySeconds = await node.latency();
  const latencySamples = Math.round(latencySeconds * context.sampleRate);
  const initialSemitones = options.semitones ?? 0;
  const initialPlaybackRate = options.playbackRate ?? 1;
  const tonalityLimitHz = options.tonalityLimitHz ?? 8000;
  let activeLoop: {
    readonly loopStartSeconds: number;
    readonly loopEndSeconds: number;
    readonly playbackRate: number;
    readonly tonalityLimitHz: number;
  } | null = null;

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
        if (!Number.isFinite(currentTonalityLimitHz) || currentTonalityLimitHz <= 0) {
          throw new RangeError('tonalityLimitHz must be positive and finite');
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
          tonalityLimitHz: currentTonalityLimitHz,
        };
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
  if (options.channels !== 1 && options.channels !== 2) {
    throw new RangeError('Signalsmith pitch supports one or two live channels');
  }
  const semitones = options.semitones ?? 0;
  validateSemitones(semitones);
  const tonalityLimitHz = options.tonalityLimitHz ?? Math.min(8000, context.sampleRate * 0.45);
  if (!Number.isFinite(tonalityLimitHz) || tonalityLimitHz <= 0 || tonalityLimitHz > context.sampleRate / 2) {
    throw new RangeError('tonalityLimitHz must be positive, finite, and no greater than Nyquist');
  }

  const { default: createNode } = await import('./vendor/SignalsmithStretch.mjs');
  const node = await createNode(context, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [options.channels],
    channelCount: options.channels,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  // The default/cheaper presets use 120–140 ms of processing latency. A 24 ms
  // STFT block with quarter-block hops stays responsive while preserving
  // pitch accuracy at both ends of the supported ±24-semitone range.
  await node.configure({ blockMs: 24, intervalMs: 6, splitComputation: false });
  const latencySeconds = await node.latency();
  if (!Number.isFinite(latencySeconds) || latencySeconds < 0 || latencySeconds > 0.025) {
    node.disconnect();
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
        validateSemitones(nextSemitones);
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

  await liveNode.setPitch(semitones);
  return liveNode;
}
