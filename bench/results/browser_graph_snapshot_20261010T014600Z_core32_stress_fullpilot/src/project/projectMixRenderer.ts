import type { ProjectDocument, ProjectFxUnit, ProjectOfflineFxGraph } from './projectTypes';
import type { TrackRuntimeSettings } from '../core/types';
import {
  BOUNCE_CAPTURE_CHUNK_FRAMES,
  BOUNCE_CAPTURE_HEADER_BYTES,
  BOUNCE_CAPTURE_HEADER_WORDS,
  BOUNCE_CAPTURE_RING_SLOTS,
  BounceCaptureError,
  BounceCaptureState,
  BounceCaptureWord,
  assertBounceCaptureBuffer,
  createBounceCaptureBuffer,
} from './bounceCaptureProtocol';

const DEFAULT_MAX_RENDER_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_RENDER_FRAMES = 259_200_000;
const WORKLET_STARTUP_LEAD_FRAMES = 2_048;
const WORKLET_MODULE = '/worklets/bounce-capture-processor.js';
const CAPTURE_PROCESSOR_NAME = 'webrc505mk2-bounce-capture';
const CAPTURE_POLL_INTERVAL_MS = 4;
const CAPTURE_WATCHDOG_EXTRA_MS = 15_000;
const QUANTUM_FRAMES = 128;

interface PlannedTrack {
  trackId: number;
  audio: AudioBuffer;
  runtime: TrackRuntimeSettings;
  fixedFxEnabled: boolean;
  trackFxSend: boolean;
  level: number;
  pan: number;
  effectiveSpeed: number;
  keepPitch: boolean;
}

interface RenderPlan {
  options: ProjectMixRenderOptions;
  tracks: PlannedTrack[];
  durationFrames: number;
  sampleRate: number;
  sourceBytes: number;
  workingBytes: number;
  outputBytes: number;
  captureBytes: number;
  selectedTrackFxRequired: boolean;
  masterFxRequired: boolean;
}

interface GraphResources {
  sources: AudioBufferSourceNode[];
  nodes: AudioNode[];
  fxGraphs: ProjectOfflineFxGraph[];
}

interface PreparedMixGraph {
  attach(destination: AudioNode, startTime: number): void;
}

type AudioContextWithWorklet = AudioContext & {
  audioWorklet: AudioWorklet;
};

let timeStretchCorePromise: Promise<TimeStretchCoreApi> | null = null;
const captureWorkletContexts = new WeakSet<AudioContext>();

/** Inputs required by the shared OfflineAudioContext and live capture renderers. */
export interface ProjectMixRenderOptions {
  /** The live browser context supplies the supported sample rate and realtime timeline. */
  context: BaseAudioContext;
  document: ProjectDocument;
  audioByTrackId: ReadonlyMap<number, AudioBuffer>;
  selectedTrackIds: number[];
  durationFrames: number;
  /** Per-track fixed FX chain, before level, pan and the shared track-bank send. */
  createTrackFxGraph(
    context: BaseAudioContext,
    trackId: number,
    document: ProjectDocument,
  ): Promise<ProjectOfflineFxGraph | null>;
  /** Shared active-bank TRACK chain, constructed once for the rendered source mix. */
  createSelectedTrackFxGraph(
    context: BaseAudioContext,
    document: ProjectDocument,
  ): Promise<ProjectOfflineFxGraph | null>;
  /** Shared master FX chain, after the rendered track mix. */
  createMasterFxGraph(
    context: BaseAudioContext,
    document: ProjectDocument,
  ): Promise<ProjectOfflineFxGraph | null>;
  maxMemoryBytes?: number;
  timeStretchCore?: TimeStretchCoreApi;
}

/** Public subset of the worklet module shared with real-time and offline speed paths. */
export interface TimeStretchCoreApi {
  TIME_STRETCH_WINDOW_FRAMES: number;
  TIME_STRETCH_HOP_FRAMES: number;
  createTimeStretchState(windowFrames: number, hopFrames: number): ProjectTimeStretchState;
  resetTimeStretchState(state: ProjectTimeStretchState, sourceFrame?: number, playbackFrame?: number): void;
  processTimeStretchFrame(
    state: ProjectTimeStretchState,
    loopFrames: number,
    speed: number,
    reverse: boolean,
    readLeft: (frame: number) => number,
    readRight: (frame: number) => number,
  ): void;
}

export interface ProjectTimeStretchState {
  outLeft: number;
  outRight: number;
}

export interface ProjectMixRenderEstimate {
  sourceBytes: number;
  workingBytes: number;
  outputBytes: number;
  captureBytes: number;
  totalBytes: number;
}

/** Compute the runtime's tempo-sync factor for a project track. */
export function getEffectiveProjectTrackSpeed(runtime: TrackRuntimeSettings, globalBpm: number): number {
  const factor = runtime.tempoSyncSpeed === 'HALF' ? 0.5 : runtime.tempoSyncSpeed === 'DOUBLE' ? 2 : 1;
  const recordedBpm = runtime.recordBpm;
  const tempoRatio = runtime.tempoSyncEnabled && recordedBpm !== null && recordedBpm > 0
    ? globalBpm / recordedBpm
    : 1;
  const tempoFactor = runtime.tempoSyncEnabled ? factor * tempoRatio : 1;
  const speed = runtime.speed * tempoFactor;
  return Math.max(0.25, Math.min(4, Number.isFinite(speed) ? speed : 1));
}

export function isProjectTrackPitchPreserved(runtime: TrackRuntimeSettings): boolean {
  return runtime.keepPitch || (runtime.tempoSyncEnabled && runtime.tempoSyncMode === 'XFADE');
}

/** Default to one effective loop/one-shot length, not the unscaled PCM header length. */
export function getProjectMixDefaultDurationFrames(
  document: ProjectDocument,
  audioByTrackId: ReadonlyMap<number, AudioBuffer>,
  selectedTrackIds: number[],
): number {
  const sampleRate = selectedTrackIds
    .map((trackId) => audioByTrackId.get(trackId)?.sampleRate)
    .find((rate): rate is number => typeof rate === 'number' && Number.isInteger(rate) && rate >= 8_000);
  if (!sampleRate) throw new Error('Selected source tracks do not contain valid PCM audio.');
  const plan = createRenderPlan({
    context: { sampleRate } as BaseAudioContext,
    document,
    audioByTrackId,
    selectedTrackIds,
    durationFrames: 1,
    createTrackFxGraph: async () => null,
    createSelectedTrackFxGraph: async () => null,
    createMasterFxGraph: async () => null,
  }, true);
  return Math.max(...plan.tracks.map((track) => Math.ceil(track.audio.length / track.effectiveSpeed)));
}

export function estimateProjectMixRenderBytes(options: ProjectMixRenderOptions, realtime = false): ProjectMixRenderEstimate {
  const plan = createRenderPlan(options, realtime);
  return {
    sourceBytes: plan.sourceBytes,
    workingBytes: plan.workingBytes,
    outputBytes: plan.outputBytes,
    captureBytes: plan.captureBytes,
    totalBytes: plan.sourceBytes + plan.workingBytes + plan.outputBytes + plan.captureBytes,
  };
}

/** Render a project mix into offline PCM or capture a scheduled live-context mix. */
export class ProjectMixRenderer {
  private cancelActiveCapture: (() => void) | null = null;

  public cancel(): void {
    this.cancelActiveCapture?.();
  }

  public async renderOffline(options: ProjectMixRenderOptions): Promise<AudioBuffer> {
    if (typeof OfflineAudioContext === 'undefined') throw new Error('OfflineAudioContext is unavailable.');
    const plan = createRenderPlan(options, false);
    this.assertMemoryBudget(plan, options.maxMemoryBytes);
    const offline = new OfflineAudioContext(2, plan.durationFrames, plan.sampleRate);
    const resources: GraphResources = { sources: [], nodes: [], fxGraphs: [] };
    try {
      const graph = await this.prepareMixGraph(offline, plan, resources);
      graph.attach(offline.destination, 0);
      const result = await offline.startRendering();
      if (result.numberOfChannels !== 2 || result.length !== plan.durationFrames) {
        throw new Error('Offline bounce did not return the requested stereo frame count.');
      }
      return result;
    } finally {
      disposeGraphResources(resources, offline.currentTime);
    }
  }

  public async renderRealtime(options: ProjectMixRenderOptions): Promise<AudioBuffer> {
    if (this.cancelActiveCapture) throw new Error('A realtime bounce capture is already active.');
    const plan = createRenderPlan(options, true);
    this.assertMemoryBudget(plan, options.maxMemoryBytes);
    const context = options.context as AudioContextWithWorklet;
    if (typeof SharedArrayBuffer === 'undefined' || !context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      throw new Error('Realtime bounce requires cross-origin isolated AudioWorklet and SharedArrayBuffer support.');
    }
    if (context.state === 'closed') throw new Error('The browser AudioContext is closed.');
    if (context.state === 'suspended') await context.resume();
    if (!captureWorkletContexts.has(context)) {
      await context.audioWorklet.addModule(getCaptureWorkletUrl());
      captureWorkletContexts.add(context);
    }

    const resources: GraphResources = { sources: [], nodes: [], fxGraphs: [] };
    try {
      // Prepare every PCM buffer and initialize every FX graph before arming the
      // capture clock. A slow WSOLA render or graph initialization must not eat
      // the scheduled lead-in and make the capture contain early silence.
      const graph = await this.prepareMixGraph(context, plan, resources);
      const nowFrame = Math.ceil(context.currentTime * plan.sampleRate);
      const startFrame = Math.ceil((nowFrame + WORKLET_STARTUP_LEAD_FRAMES) / QUANTUM_FRAMES) * QUANTUM_FRAMES;
      const chunkFrames = BOUNCE_CAPTURE_CHUNK_FRAMES;
      const slotCount = BOUNCE_CAPTURE_RING_SLOTS;
      const sharedBuffer = createBounceCaptureBuffer({
        targetFrames: plan.durationFrames,
        startFrame,
        chunkFrames,
        slotCount,
      });
      assertBounceCaptureBuffer(sharedBuffer, { targetFrames: plan.durationFrames, startFrame });
      const captureNode = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { buffer: sharedBuffer, targetFrames: plan.durationFrames, startFrame },
      });
      const silentOutput = context.createGain();
      silentOutput.gain.value = 0;
      captureNode.connect(silentOutput);
      silentOutput.connect(context.destination);
      resources.nodes.push(captureNode, silentOutput);
      const output = context.createBuffer(2, plan.durationFrames, plan.sampleRate);
      const outputLeft = output.getChannelData(0);
      const outputRight = output.getChannelData(1);
      const header = new Int32Array(sharedBuffer, 0, BOUNCE_CAPTURE_HEADER_WORDS);
      const ring = new Float32Array(sharedBuffer, BOUNCE_CAPTURE_HEADER_BYTES);
      let copiedFrames = 0;
      let cancelRequested = false;
      let processorError = false;
      captureNode.onprocessorerror = () => { processorError = true; };
      this.cancelActiveCapture = () => {
        cancelRequested = true;
        Atomics.store(header, BounceCaptureWord.STATE, BounceCaptureState.CANCELLED);
        try { captureNode.port.postMessage({ type: 'CANCEL' }); } catch { /* shared cancellation state remains authoritative */ }
        stopSources(resources.sources, context.currentTime);
      };
      // No awaited setup remains after the fresh frame epoch is chosen.
      graph.attach(captureNode, startFrame / plan.sampleRate);

      const deadline = Date.now() + Math.max(CAPTURE_WATCHDOG_EXTRA_MS, plan.durationFrames / plan.sampleRate * 3_000 + CAPTURE_WATCHDOG_EXTRA_MS);
      while (true) {
        if (cancelRequested) throw new Error('Realtime bounce capture was cancelled.');
        if (processorError) throw new Error('Realtime bounce capture Worklet failed.');
        copiedFrames = drainCaptureRing(header, ring, outputLeft, outputRight, copiedFrames, chunkFrames, slotCount);
        const state = Atomics.load(header, BounceCaptureWord.STATE);
        if (state === BounceCaptureState.FAILED) {
          const code = Atomics.load(header, BounceCaptureWord.ERROR);
          const reason = code === BounceCaptureError.RING_OVERFLOW
            ? 'Realtime bounce capture could not drain its bounded sample ring fast enough.'
            : 'Realtime bounce capture rejected its shared-buffer header.';
          throw new Error(reason);
        }
        if (state === BounceCaptureState.CANCELLED) throw new Error('Realtime bounce capture was cancelled.');
        if (state === BounceCaptureState.COMPLETE && copiedFrames === plan.durationFrames &&
            Atomics.load(header, BounceCaptureWord.READ_SEQUENCE) === Atomics.load(header, BounceCaptureWord.WRITE_SEQUENCE)) {
          if (Atomics.load(header, BounceCaptureWord.CAPTURED_FRAMES) !== plan.durationFrames) {
            throw new Error('Realtime bounce stopped before the complete requested PCM frame count was captured.');
          }
          return output;
        }
        if (Date.now() > deadline) throw new Error('Realtime bounce capture timed out before all requested frames arrived.');
        await delay(CAPTURE_POLL_INTERVAL_MS);
      }
    } finally {
      this.cancelActiveCapture = null;
      disposeGraphResources(resources, context.currentTime);
    }
  }

  private assertMemoryBudget(plan: RenderPlan, limit = DEFAULT_MAX_RENDER_MEMORY_BYTES): void {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Bounce memory limit must be a positive safe byte count.');
    const totalBytes = plan.sourceBytes + plan.workingBytes + plan.outputBytes + plan.captureBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limit) {
      throw new RangeError(`Bounce needs ${totalBytes} bytes, above the configured ${limit}-byte memory limit.`);
    }
  }

  private async prepareMixGraph(
    context: BaseAudioContext,
    plan: RenderPlan,
    resources: GraphResources,
  ): Promise<PreparedMixGraph> {
    const automations: Array<(startTime: number) => void> = [];
    const trackMix = context.createGain();
    resources.nodes.push(trackMix);
    const sendTracks = plan.tracks.filter((track) => track.trackFxSend);
    const sharedTrackFx = sendTracks.length > 0
      ? await plan.options.createSelectedTrackFxGraph(context, plan.options.document)
      : null;
    if (sharedTrackFx) {
      assertFxGraph(sharedTrackFx, 'Shared track FX');
      resources.fxGraphs.push(sharedTrackFx);
      sharedTrackFx.output.connect(trackMix);
    }
    if (plan.selectedTrackFxRequired && !sharedTrackFx) {
      throw new Error('Enabled shared track-bank FX are unavailable in the bounce renderer; refusing to render a dry signal.');
    }

    const durationSeconds = plan.durationFrames / plan.sampleRate;
    for (const track of plan.tracks) {
      const sourceBuffer = await prepareTrackBuffer(context, track, plan.options.timeStretchCore);
      const source = context.createBufferSource();
      resources.sources.push(source);
      source.buffer = sourceBuffer;
      source.loop = !track.runtime.oneShot;
      source.playbackRate.value = track.keepPitch && track.effectiveSpeed !== 1 ? 1 : track.effectiveSpeed;

      let chainOutput: AudioNode = source;
      if (track.fixedFxEnabled) {
        const fixedFx = await plan.options.createTrackFxGraph(context, track.trackId, plan.options.document);
        if (!fixedFx) throw new Error(`Track ${track.trackId} has enabled fixed FX, but the bounce renderer could not reproduce them.`);
        assertFxGraph(fixedFx, `Track ${track.trackId} fixed FX`);
        resources.fxGraphs.push(fixedFx);
        source.connect(fixedFx.input);
        chainOutput = fixedFx.output;
      }

      const levelGain = context.createGain();
      levelGain.gain.value = track.level;
      chainOutput.connect(levelGain);
      resources.nodes.push(levelGain);
      let fadeOutput: AudioNode = levelGain;
      if (track.runtime.startMode === 'FADE' && track.runtime.fadeInMs > 0) {
        const fadeIn = context.createGain();
        const fadeEnd = Math.min(durationSeconds, track.runtime.fadeInMs / 1000);
        automations.push((startTime) => {
          fadeIn.gain.setValueAtTime(0, startTime);
          fadeIn.gain.linearRampToValueAtTime(1, startTime + fadeEnd);
        });
        levelGain.connect(fadeIn);
        resources.nodes.push(fadeIn);
        fadeOutput = fadeIn;
      }
      if (track.runtime.stopMode === 'FADE' && track.runtime.fadeOutMs > 0) {
        const fadeOut = context.createGain();
        const fadeLength = Math.min(durationSeconds, track.runtime.fadeOutMs / 1000);
        const fadeStartOffset = Math.max(0, durationSeconds - fadeLength);
        automations.push((startTime) => {
          fadeOut.gain.setValueAtTime(1, startTime + fadeStartOffset);
          fadeOut.gain.linearRampToValueAtTime(0, startTime + durationSeconds);
        });
        fadeOutput.connect(fadeOut);
        resources.nodes.push(fadeOut);
        fadeOutput = fadeOut;
      }
      const panner = context.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, track.pan));
      fadeOutput.connect(panner);
      resources.nodes.push(panner);
      if (track.trackFxSend && sharedTrackFx) panner.connect(sharedTrackFx.input);
      else panner.connect(trackMix);
    }

    const masterFx = plan.masterFxRequired
      ? await plan.options.createMasterFxGraph(context, plan.options.document)
      : null;
    if (plan.masterFxRequired && !masterFx) {
      throw new Error('Enabled master FX are unavailable in the bounce renderer; refusing to render a dry signal.');
    }
    let postFx: AudioNode = trackMix;
    if (masterFx) {
      assertFxGraph(masterFx, 'Master FX');
      resources.fxGraphs.push(masterFx);
      trackMix.connect(masterFx.input);
      postFx = masterFx.output;
    }
    const masterGain = context.createGain();
    masterGain.gain.value = Math.max(0, Math.min(2, plan.options.document.mixer.masterLevel));
    postFx.connect(masterGain);
    resources.nodes.push(masterGain);
    return {
      attach(destination, startTime) {
        masterGain.connect(destination);
        for (const schedule of automations) schedule(startTime);
        for (const source of resources.sources) source.start(startTime);
      },
    };
  }
}

function createRenderPlan(options: ProjectMixRenderOptions, realtime: boolean): RenderPlan {
  if (!options || !options.context || !Number.isInteger(options.context.sampleRate) || options.context.sampleRate < 8_000) {
    throw new TypeError('Project mix rendering needs a live AudioContext with a valid sample rate.');
  }
  if (!Number.isSafeInteger(options.durationFrames) || options.durationFrames < 1 || options.durationFrames > MAX_RENDER_FRAMES) {
    throw new RangeError(`Bounce frame count must be between 1 and ${MAX_RENDER_FRAMES}.`);
  }
  if (!Array.isArray(options.selectedTrackIds) || options.selectedTrackIds.length < 1 || options.selectedTrackIds.length > 5) {
    throw new TypeError('Select between one and five source tracks.');
  }
  const uniqueIds = new Set(options.selectedTrackIds);
  if (uniqueIds.size !== options.selectedTrackIds.length ||
      [...uniqueIds].some((trackId) => !Number.isInteger(trackId) || trackId < 1 || trackId > 5)) {
    throw new RangeError('Selected source tracks must be unique track numbers from 1 through 5.');
  }
  if (options.document.tracks.length !== 5 || options.document.mixer.tracks.length !== 5) {
    throw new TypeError('A project mix must contain exactly five track documents and mixer channels.');
  }
  createRenderPlanContext(options.document);
  const activeBank = options.document.fxBanks.find((bank) => bank.id === options.document.activeFxBankId);
  if (!activeBank) throw new Error(`Active FX bank ${options.document.activeFxBankId} is missing.`);
  const selectedTrackFxRequired = activeBank.track.some((unit) => unit?.enabled === true);
  const masterFxRequired = hasEnabledProjectFx(options.document.masterFxChain) || activeBank.output.some((unit) => unit?.enabled === true);
  const anySolo = options.document.mixer.tracks.some((track) => track.solo);
  const tracks: PlannedTrack[] = [];
  for (const trackId of options.selectedTrackIds) {
    const audio = options.audioByTrackId.get(trackId);
    const track = options.document.tracks[trackId - 1];
    const mixer = options.document.mixer.tracks[trackId - 1];
    if (!audio || !track || !mixer || track.id !== trackId || mixer.trackId !== trackId || audio.length <= 0) {
      throw new Error(`Track ${trackId} has no valid project PCM buffer.`);
    }
    if (audio.sampleRate !== options.context.sampleRate || audio.numberOfChannels < 1 || audio.numberOfChannels > 2) {
      throw new TypeError(`Track ${trackId} audio must be mono/stereo PCM at the project AudioContext sample rate.`);
    }
    if (mixer.muted || (anySolo && !mixer.solo)) continue;
    const runtime = track.settings.runtime;
    const effectiveSpeed = getEffectiveProjectTrackSpeed(runtime, options.document.global.bpm);
    tracks.push({
      trackId,
      audio,
      runtime,
      fixedFxEnabled: hasEnabledProjectFx(track.settings.fxChain) || hasEnabledProjectFx(track.settings.fxSlots),
      trackFxSend: track.settings.fxSw === 'ON' && selectedTrackFxRequired,
      level: Math.max(0, track.settings.playLevel / 100 * mixer.level),
      pan: Math.max(-1, Math.min(1, track.settings.pan / 50 + mixer.pan)),
      effectiveSpeed,
      keepPitch: isProjectTrackPitchPreserved(runtime),
    });
  }
  if (tracks.length === 0) throw new Error('No selected source track remains after mute and solo routing.');

  let sourceBytes = 0;
  let workingBytes = 0;
  for (const track of tracks) {
    sourceBytes += track.audio.length * track.audio.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    if (track.keepPitch && track.effectiveSpeed !== 1) {
      workingBytes += Math.ceil(track.audio.length / track.effectiveSpeed) * 2 * Float32Array.BYTES_PER_ELEMENT;
      workingBytes += TIME_STRETCH_STATE_BUDGET_BYTES;
    } else if (track.runtime.reverse) {
      workingBytes += track.audio.length * track.audio.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    }
  }
  const outputBytes = options.durationFrames * 2 * Float32Array.BYTES_PER_ELEMENT;
  const captureBytes = realtime
    ? BOUNCE_CAPTURE_HEADER_BYTES + BOUNCE_CAPTURE_RING_SLOTS * BOUNCE_CAPTURE_CHUNK_FRAMES * 2 * Float32Array.BYTES_PER_ELEMENT
    : 0;
  if (![sourceBytes, workingBytes, outputBytes, captureBytes].every(Number.isSafeInteger)) {
    throw new RangeError('Project bounce memory estimate exceeded JavaScript safe integer bounds.');
  }
  const plan: RenderPlan = {
    options,
    tracks,
    durationFrames: options.durationFrames,
    sampleRate: options.context.sampleRate,
    sourceBytes,
    workingBytes,
    outputBytes,
    captureBytes,
    selectedTrackFxRequired: selectedTrackFxRequired && tracks.some((track) => track.trackFxSend),
    masterFxRequired,
  };
  const limit = options.maxMemoryBytes ?? DEFAULT_MAX_RENDER_MEMORY_BYTES;
  const totalBytes = sourceBytes + workingBytes + outputBytes + captureBytes;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(totalBytes) || totalBytes > limit) {
    throw new RangeError(`Bounce needs ${totalBytes} bytes, above the configured ${limit}-byte memory limit.`);
  }
  return plan;
}

const TIME_STRETCH_STATE_BUDGET_BYTES = 384 * 1024;

function hasEnabledProjectFx(value: Record<string, ProjectFxUnit> | Array<ProjectFxUnit | null>): boolean {
  const units = Array.isArray(value) ? value : Object.values(value);
  return units.some((unit) => unit?.enabled === true);
}

async function prepareTrackBuffer(
  context: BaseAudioContext,
  track: PlannedTrack,
  suppliedCore?: TimeStretchCoreApi,
): Promise<AudioBuffer> {
  if (track.keepPitch && track.effectiveSpeed !== 1) {
    const core = suppliedCore ?? await loadTimeStretchCore();
    const outputFrames = Math.max(1, Math.ceil(track.audio.length / track.effectiveSpeed));
    return renderTimeStretchedBuffer(context, track.audio, outputFrames, track.effectiveSpeed, track.runtime.reverse, !track.runtime.oneShot, core);
  }
  if (!track.runtime.reverse) return track.audio;
  return reverseBuffer(context, track.audio);
}

async function renderTimeStretchedBuffer(
  context: BaseAudioContext,
  input: AudioBuffer,
  outputFrames: number,
  speed: number,
  reverse: boolean,
  loop: boolean,
  core: TimeStretchCoreApi,
): Promise<AudioBuffer> {
  const state = core.createTimeStretchState(core.TIME_STRETCH_WINDOW_FRAMES, core.TIME_STRETCH_HOP_FRAMES);
  core.resetTimeStretchState(state, reverse ? input.length - 1 : 0, 0);
  const left = input.getChannelData(0);
  const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left;
  const output = context.createBuffer(2, outputFrames, context.sampleRate);
  const outputLeft = output.getChannelData(0);
  const outputRight = output.getChannelData(1);
  const createReader = (samples: Float32Array) => (frame: number): number => {
    if (!Number.isFinite(frame)) return 0;
    let sourceFrame = frame;
    if (loop) {
      sourceFrame %= input.length;
      if (sourceFrame < 0) sourceFrame += input.length;
    } else if (sourceFrame < 0 || sourceFrame >= input.length) return 0;
    const first = Math.floor(sourceFrame);
    const next = first + 1 < input.length ? first + 1 : loop ? 0 : first;
    const fraction = sourceFrame - first;
    return samples[first]! + (samples[next]! - samples[first]!) * fraction;
  };
  const readLeft = createReader(left);
  const readRight = createReader(right);
  for (let frame = 0; frame < outputFrames; frame += 1) {
    core.processTimeStretchFrame(state, loop ? input.length : 0, speed, reverse, readLeft, readRight);
    outputLeft[frame] = state.outLeft;
    outputRight[frame] = state.outRight;
    if (frame > 0 && frame % 32_768 === 0) await delay(0);
  }
  return output;
}

function reverseBuffer(context: BaseAudioContext, input: AudioBuffer): AudioBuffer {
  const output = context.createBuffer(input.numberOfChannels, input.length, input.sampleRate);
  for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
    const source = input.getChannelData(channel);
    const reversed = output.getChannelData(channel);
    for (let frame = 0; frame < input.length; frame += 1) reversed[frame] = source[input.length - frame - 1]!;
  }
  return output;
}

function drainCaptureRing(
  header: Int32Array,
  ring: Float32Array,
  outputLeft: Float32Array,
  outputRight: Float32Array,
  copiedFrames: number,
  chunkFrames: number,
  slotCount: number,
): number {
  let readSequence = Atomics.load(header, BounceCaptureWord.READ_SEQUENCE);
  const writeSequence = Atomics.load(header, BounceCaptureWord.WRITE_SEQUENCE);
  while (readSequence !== writeSequence) {
    const slot = readSequence % slotCount;
    const length = Atomics.load(header, BounceCaptureWord.SLOT_LENGTHS + slot);
    if (!Number.isInteger(length) || length < 1 || length > chunkFrames || copiedFrames + length > outputLeft.length) {
      throw new Error('Realtime bounce capture ring reported an invalid PCM chunk length.');
    }
    const base = slot * chunkFrames * 2;
    outputLeft.set(ring.subarray(base, base + length), copiedFrames);
    outputRight.set(ring.subarray(base + chunkFrames, base + chunkFrames + length), copiedFrames);
    copiedFrames += length;
    Atomics.store(header, BounceCaptureWord.SLOT_LENGTHS + slot, 0);
    readSequence = (readSequence + 1) >>> 0;
    Atomics.store(header, BounceCaptureWord.READ_SEQUENCE, readSequence);
  }
  return copiedFrames;
}

function createRenderPlanContext(document: ProjectDocument): void {
  if (!Number.isFinite(document.global.bpm) || document.global.bpm < 40 || document.global.bpm > 300 ||
      !Number.isFinite(document.mixer.masterLevel) || document.mixer.masterLevel < 0 || document.mixer.masterLevel > 2) {
    throw new RangeError('Project BPM or master level is outside supported range.');
  }
}

function assertFxGraph(graph: ProjectOfflineFxGraph, label: string): void {
  if (!graph || !graph.input || typeof graph.input.connect !== 'function' || !graph.output || typeof graph.output.connect !== 'function') {
    throw new TypeError(`${label} factory returned an invalid audio graph.`);
  }
}

function disposeGraphResources(resources: GraphResources, stopTime: number): void {
  stopSources(resources.sources, stopTime);
  for (const node of resources.nodes) {
    try { node.disconnect(); } catch { /* node is already disconnected */ }
  }
  for (const graph of resources.fxGraphs) {
    const disposable = graph as ProjectOfflineFxGraph & { dispose?: () => void };
    if (typeof disposable.dispose === 'function') disposable.dispose();
    else {
      try { graph.input.disconnect(); } catch { /* node is already disconnected */ }
      try { graph.output.disconnect(); } catch { /* node is already disconnected */ }
    }
  }
}

function stopSources(sources: AudioBufferSourceNode[], stopTime: number): void {
  for (const source of sources) {
    try { source.stop(stopTime); } catch { /* source is not started or already stopped */ }
    try { source.disconnect(); } catch { /* source is already disconnected */ }
  }
}

function getCaptureWorkletUrl(): string {
  return typeof window === 'undefined'
    ? new URL('../../public/worklets/bounce-capture-processor.js', import.meta.url).href
    : new URL(WORKLET_MODULE, window.location.href).href;
}

async function loadTimeStretchCore(): Promise<TimeStretchCoreApi> {
  if (!timeStretchCorePromise) {
    const url = typeof window === 'undefined'
      ? new URL('../../public/worklets/time-stretch-core.js', import.meta.url).href
      : new URL('/worklets/time-stretch-core.js', window.location.href).href;
    timeStretchCorePromise = import(/* @vite-ignore */ url) as Promise<TimeStretchCoreApi>;
  }
  return await timeStretchCorePromise;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
