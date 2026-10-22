import { TrackState, TransportState } from '../core/types';
import { audioBufferPcmBytes } from './PcmHistoryBudget';
import type { BrowserRecoverySnapshot } from './BrowserRecoverySnapshot';
import { addAudioWorkletModuleWithTimeout } from './browserAudioStartup';
import { prepareBrowserRecoveryRuntime, validateBrowserRecoveryRuntimeSettings, type BrowserRecoveryPreparedRuntime } from './BrowserRecoveryRuntime';
import { SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES, SIGNALSMITH_LIVE_WASM_BUDGET_BYTES, signalsmithLiveWasmSnapshot } from './pitch/signalsmithWasmBudget';
import {
  buildBrowserRecoveryFxGraph,
  planBrowserRecoveryFxGraph,
  type BrowserRecoveryFxGraph,
  type RecoveryFxModuleLoader,
} from './BrowserRecoveryFxGraph';

/**
 * An unpublished recovery context. It is not a replacement BrowserAudioEngine:
 * optional private Track FX worklets may be rebuilt here, but there is no live
 * input capture, playback, engine singleton, or global event subscription.
 */
export interface BrowserRecoveryCandidate {
  readonly context: AudioContext;
  readonly silentSink: GainNode;
  readonly snapshot: BrowserRecoverySnapshot;
  readonly estimatedPeakPcmBytes: number;
  readonly estimatedPeakKnownPayloadBytes: number;
  readonly fxGraph: BrowserRecoveryFxGraph | null;
  readonly preparedRuntime: BrowserRecoveryPreparedRuntime | null;
  readonly phase: 'runtime-prepared-not-installed';
  /** Transfer candidate context/graph/runtime ownership once to a future adopter. */
  takeRuntime(): BrowserRecoveryCandidateRuntime;
  dispose(): Promise<void>;
}

export interface BrowserRecoveryCandidateRuntime {
  readonly context: AudioContext;
  readonly silentSink: GainNode;
  readonly snapshot: BrowserRecoverySnapshot;
  readonly estimatedPeakPcmBytes: number;
  readonly estimatedPeakKnownPayloadBytes: number;
  readonly fxGraph: BrowserRecoveryFxGraph | null;
  readonly preparedRuntime: BrowserRecoveryPreparedRuntime | null;
  readonly phase: 'runtime-prepared-not-installed';
  dispose(): Promise<void>;
}

export interface BrowserRecoveryCandidateBuildOptions {
  /** Rebuild the five private Track A–D banks in isolated chains on the suspended context. */
  readonly restorePrivateTrackFxGraph?: boolean;
  /** Also rebuild the shared Input, postmix Track, and output-DSP paths on the muted candidate. */
  readonly restoreAllPersistedFxGraph?: boolean;
  /** Reserve the complete persisted FX/WASM topology without building a detached graph. */
  readonly preflightPersistedFxGraph?: boolean;
  /** Production adoption builds the actual BrowserAudioEngine graph on this context instead. */
  readonly prepareRuntime?: boolean;
  /** Test seam for module failures; production uses the shipped FX worklet bundle. */
  readonly loadFxWorkletModule?: RecoveryFxModuleLoader;
}

export type RecoveryAudioContextFactory = (options: AudioContextOptions) => AudioContext;

/** Match the existing Browser project-operation PCM admission ceiling. */
export const MAX_RECOVERY_CANDIDATE_PEAK_PCM_BYTES = 4 * 1024 * 1024 * 1024;

function validateBuffer(buffer: AudioBuffer, label: string): number {
  if (!Number.isSafeInteger(buffer.length) || buffer.length < 1
    || (buffer.numberOfChannels !== 1 && buffer.numberOfChannels !== 2)
    || !Number.isSafeInteger(buffer.sampleRate) || buffer.sampleRate < 8_000 || buffer.sampleRate > 384_000) {
    throw new Error(`${label} has unsupported PCM dimensions; Browser recovery candidate was not built.`);
  }
  const bytes = audioBufferPcmBytes(buffer);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${label} has invalid PCM size; Browser recovery candidate was not built.`);
  }
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    if (samples.length !== buffer.length) throw new Error(`${label} PCM channel length is inconsistent.`);
    for (let frame = 0; frame < samples.length; frame += 1) {
      if (!Number.isFinite(samples[frame])) throw new Error(`${label} contains non-finite PCM; Browser recovery candidate was not built.`);
    }
  }
  return bytes;
}

function cloneBuffer(source: AudioBuffer, targetContext: AudioContext, label: string): AudioBuffer {
  validateBuffer(source, label);
  const target = targetContext.createBuffer(source.numberOfChannels, source.length, source.sampleRate);
  if (target.length !== source.length || target.numberOfChannels !== source.numberOfChannels
    || target.sampleRate !== source.sampleRate) {
    throw new Error(`${label} could not be represented exactly in the new Browser AudioContext.`);
  }
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const input = source.getChannelData(channel);
    const output = target.getChannelData(channel);
    if (output.length !== input.length) throw new Error(`${label} PCM copy has a mismatched channel length.`);
    output.set(input);
    for (let frame = 0; frame < input.length; frame += 1) {
      if (output[frame] !== input[frame]) throw new Error(`${label} PCM copy failed exact verification.`);
    }
  }
  return target;
}

function validateSnapshot(snapshot: BrowserRecoverySnapshot): { currentBytes: number; historyBytes: number } {
  if (!snapshot || snapshot.schemaVersion !== 2 || snapshot.source.contextState !== 'closed') {
    throw new Error('A recovery candidate requires a version-2 snapshot from a closed Browser AudioContext.');
  }
  validateBrowserRecoveryRuntimeSettings(snapshot);
  if (!Number.isSafeInteger(snapshot.source.sampleRate) || snapshot.source.sampleRate < 8_000 || snapshot.source.sampleRate > 384_000) {
    throw new Error('The closed Browser AudioContext sample rate is invalid; recovery candidate was not built.');
  }
  if (snapshot.tracks.length !== 5 || snapshot.fx.input.length !== 4 || snapshot.fx.sharedTrack.length !== 4
    || snapshot.fx.privateTracks.length !== 5 || snapshot.fx.privateTracks.some((slots) => slots.length !== 4)) {
    throw new Error('A recovery candidate requires all five tracks and all Input/shared/private A–D FX slots.');
  }
  if (!Number.isSafeInteger(snapshot.pcmHistoryBudget.retainedBytes)
    || !Number.isSafeInteger(snapshot.pcmHistoryBudget.limitBytes)
    || snapshot.pcmHistoryBudget.retainedBytes < 0
    || snapshot.pcmHistoryBudget.limitBytes < 0
    || snapshot.pcmHistoryBudget.retainedBytes > snapshot.pcmHistoryBudget.limitBytes) {
    throw new Error('The shared Browser PCM-history budget is invalid; recovery candidate was not built.');
  }

  let currentBytes = 0;
  let historyBytes = 0;
  for (let index = 0; index < snapshot.tracks.length; index += 1) {
    const track = snapshot.tracks[index]!;
    if (track.trackId !== index + 1 || !Number.isSafeInteger(track.projectPcmRevision) || track.projectPcmRevision < 0) {
      throw new Error('The closed Browser project snapshot has an invalid track identity or revision.');
    }
    const bufferBytes = track.buffer ? validateBuffer(track.buffer, `Track ${track.trackId} current loop`) : 0;
    if (bufferBytes !== track.bufferBytes) throw new Error(`Track ${track.trackId} PCM byte count does not match its snapshot.`);
    currentBytes += bufferBytes;
    const historyBufferBytes = track.history.buffer
      ? validateBuffer(track.history.buffer, `Track ${track.trackId} undo/redo loop`) : 0;
    if (historyBufferBytes !== track.history.retainedBytes) {
      throw new Error(`Track ${track.trackId} history byte count does not match its snapshot.`);
    }
    historyBytes += historyBufferBytes;
  }
  if (!Number.isSafeInteger(currentBytes) || !Number.isSafeInteger(historyBytes)
    || historyBytes !== snapshot.pcmHistoryBudget.retainedBytes) {
    throw new Error('The five tracks do not match their shared PCM-history ledger.');
  }
  const estimatedPeakPcmBytes = 2 * (currentBytes + historyBytes);
  if (!Number.isSafeInteger(estimatedPeakPcmBytes) || estimatedPeakPcmBytes > MAX_RECOVERY_CANDIDATE_PEAK_PCM_BYTES) {
    throw new Error(`Recovery candidate requires an estimated ${estimatedPeakPcmBytes} PCM bytes, above the 4 GiB operation limit; the old context remains unchanged.`);
  }
  return { currentBytes, historyBytes };
}

/**
 * Build a PCM/configuration candidate from an explicitly supplied closed-context
 * snapshot. Call this only from a deliberate user gesture. It never resumes the
 * context, starts playback/rhythm, reconnects MIDI, or asks for microphone access.
 * The old engine and snapshot stay live/readable until a separate commit step.
 */
export async function buildBrowserRecoveryCandidate(
  sourceSnapshot: BrowserRecoverySnapshot,
  createContext: RecoveryAudioContextFactory = (options) => new AudioContext(options),
  buildOptions: BrowserRecoveryCandidateBuildOptions = {},
): Promise<BrowserRecoveryCandidate> {
  const { currentBytes, historyBytes } = validateSnapshot(sourceSnapshot);
  const estimatedPeakPcmBytes = 2 * (currentBytes + historyBytes);
  // Preflight the complete known PCM + reserved Signalsmith peak before a
  // candidate context, cloned buffer, or worklet can be allocated.
  const restoreFxGraph = buildOptions.restorePrivateTrackFxGraph === true || buildOptions.restoreAllPersistedFxGraph === true;
  const preflightFxGraph = restoreFxGraph || buildOptions.preflightPersistedFxGraph === true;
  const includeSharedFx = buildOptions.restoreAllPersistedFxGraph === true;
  const graphPlan = preflightFxGraph
    ? planBrowserRecoveryFxGraph(sourceSnapshot, currentBytes + historyBytes, { includeSharedBanks: includeSharedFx || buildOptions.preflightPersistedFxGraph === true })
    : null;
  const livePolyPitchProcessorCount = sourceSnapshot.tracks.filter((track) => track.pitch.mode === 'LIVE_POLY').length;
  const estimatedLivePolyWasmBytes = livePolyPitchProcessorCount * SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES;
  const graphWasmBytes = graphPlan?.estimatedSignalsmithWasmBytes ?? 0;
  const combinedSignalsmithBytes = graphPlan?.estimatedCombinedSignalsmithWasmBytes
    ?? (graphWasmBytes + estimatedLivePolyWasmBytes);
  if (!Number.isSafeInteger(combinedSignalsmithBytes) || combinedSignalsmithBytes > SIGNALSMITH_LIVE_WASM_BUDGET_BYTES) {
    throw new Error(`Recovery candidate requires ${combinedSignalsmithBytes} bytes of combined LIVE_FX/LIVE_POLY WASM reservations, above the 128 MiB per-context cap; the old graph remains available.`);
  }
  const estimatedPeakKnownPayloadBytes = graphPlan?.estimatedKnownPeakBytes
    ?? (estimatedPeakPcmBytes + estimatedLivePolyWasmBytes);
  const context = createContext({ latencyHint: 'interactive', sampleRate: sourceSnapshot.source.sampleRate });
  let silentSink: GainNode | null = null;
  let fxGraph: BrowserRecoveryFxGraph | null = null;
  let preparedRuntime: BrowserRecoveryPreparedRuntime | null = null;
  try {
    if (context.state === 'closed' || context.sampleRate !== sourceSnapshot.source.sampleRate) {
      throw new Error('The new Browser AudioContext did not preserve the saved sample rate; old PCM and history remain available.');
    }
    // A newly constructed browser context may start running after a prior user
    // gesture. Suspend it before allocating candidate PCM, and never call resume.
    if (context.state === 'running') await context.suspend();
    if (context.state !== 'suspended') throw new Error(`The candidate AudioContext is ${context.state}, not safely suspended.`);

    silentSink = context.createGain();
    silentSink.gain.value = 0;
    silentSink.connect(context.destination);

    const tracks = sourceSnapshot.tracks.map((track) => {
      const buffer = track.buffer ? cloneBuffer(track.buffer, context, `Track ${track.trackId} current loop`) : null;
      const historyBuffer = track.history.buffer
        ? cloneBuffer(track.history.buffer, context, `Track ${track.trackId} undo/redo loop`) : null;
      return Object.freeze({
        ...track,
        state: buffer ? TrackState.STOPPED : TrackState.EMPTY,
        wasPlaying: false,
        buffer,
        history: Object.freeze({ ...track.history, buffer: historyBuffer }),
      });
    });
    const candidateSnapshot: BrowserRecoverySnapshot = Object.freeze({
      ...sourceSnapshot,
      transport: Object.freeze({ ...sourceSnapshot.transport, state: TransportState.STOPPED }),
      // Rhythm errors describe the retired runtime, not authored settings.
      rhythm: Object.freeze({ ...sourceSnapshot.rhythm, wasRunning: false, error: '' }),
      tracks: Object.freeze(tracks),
      midi: Object.freeze({ ...sourceSnapshot.midi, sourceInputState: 'disconnected' }),
      monitoringWasEnabled: false,
      outputGainValue: 0,
    });
    if (restoreFxGraph) {
      fxGraph = await buildBrowserRecoveryFxGraph(
        context,
        silentSink,
        candidateSnapshot,
        graphPlan!,
        buildOptions.loadFxWorkletModule ?? ((target) => {
          if (!target.audioWorklet) return Promise.reject(new Error('Recovery AudioWorklet is unavailable.'));
          return addAudioWorkletModuleWithTimeout(target.audioWorklet, '/worklets/fx-processor.js');
        }),
        includeSharedFx,
      );
    }
    if (buildOptions.prepareRuntime !== false) {
      preparedRuntime = await prepareBrowserRecoveryRuntime(context, silentSink, candidateSnapshot);
    }
    const copiedHistoryBytes = candidateSnapshot.tracks.reduce((sum, track) => sum + track.history.retainedBytes, 0);
    if (copiedHistoryBytes !== historyBytes || context.state !== 'suspended' || silentSink.gain.value !== 0) {
      throw new Error('The recovery candidate failed its final PCM, muted-output, or stopped-context verification.');
    }
    const actualWasm = signalsmithLiveWasmSnapshot(context);
    const expectedMaterializedWasmBytes = restoreFxGraph || buildOptions.prepareRuntime !== false ? combinedSignalsmithBytes : 0;
    if (actualWasm.reservedBytes !== expectedMaterializedWasmBytes
      || actualWasm.reservedBytes > actualWasm.budgetBytes
      || actualWasm.pendingCount !== 0
      || actualWasm.releaseUnconfirmedCount !== 0) {
      throw new Error(`Recovery candidate Signalsmith reservations (${actualWasm.reservedBytes} bytes) do not match the ${expectedMaterializedWasmBytes}-byte materialized topology or include an unconfirmed processor.`);
    }

    let disposePromise: Promise<void> | null = null;
    let transferred = false;
    let disposed = false;
    const runtime: BrowserRecoveryCandidateRuntime = Object.freeze({
      context,
      silentSink,
      snapshot: candidateSnapshot,
      estimatedPeakPcmBytes,
      estimatedPeakKnownPayloadBytes,
      fxGraph,
      preparedRuntime,
      phase: 'runtime-prepared-not-installed' as const,
      async dispose() {
        if (!disposePromise) {
          disposed = true;
          disposePromise = (async () => {
            preparedRuntime?.rhythmEngine.dispose();
            fxGraph?.dispose();
            try { silentSink?.disconnect(); } catch { /* continue closing an unpublished silent candidate */ }
            if (context.state !== 'closed') await context.close();
          })();
        }
        await disposePromise;
      },
    });
    return Object.freeze({
      context,
      silentSink,
      snapshot: candidateSnapshot,
      estimatedPeakPcmBytes,
      estimatedPeakKnownPayloadBytes,
      fxGraph,
      preparedRuntime,
      phase: 'runtime-prepared-not-installed' as const,
      takeRuntime() {
        if (transferred || disposed) throw new Error('Recovery candidate runtime ownership may be transferred once before disposal.');
        transferred = true;
        return runtime;
      },
      async dispose() {
        if (transferred) return;
        await runtime.dispose();
      },
    });
  } catch (error) {
    preparedRuntime?.rhythmEngine.dispose();
    fxGraph?.dispose();
    try { silentSink?.disconnect(); } catch { /* best-effort cleanup of an unpublished candidate */ }
    try { if (context.state !== 'closed') await context.close(); } catch { /* preserve the preparation error */ }
    throw error;
  }
}
