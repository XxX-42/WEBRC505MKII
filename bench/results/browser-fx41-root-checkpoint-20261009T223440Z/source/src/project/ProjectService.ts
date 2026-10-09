import { IndexedDbProjectMemoryStore } from './IndexedDbProjectMemoryStore';
import { decodeProjectArchive, encodeProjectArchive } from './projectArchive';
import { ProjectMixRenderer, getProjectMixDefaultDurationFrames } from './projectMixRenderer';
import { DEFAULT_PROJECT_RESOURCE_POLICY } from './projectTypes';
import { isBlobLike } from './blobUtils';
import {
  assertMemorySlot,
  assertProjectDocument,
  assertProjectMemoryRecord,
  cloneProjectDocument,
} from './projectValidation';
import {
  decodeWavBlobToProjectPcm,
  encodeAudioBufferToProjectWavBlobAsync,
  encodeAudioBufferToNativeWavBlobAsync,
  inspectWavHeader,
} from './wavCodec';
import type {
  ProjectBounceOptions,
  ProjectDocument,
  ProjectEngineAdapter,
  ProjectEngineCapture,
  ProjectAudioAssetPlan,
  ProjectMemoryInfo,
  ProjectMemoryRecord,
  ProjectMemoryStore,
  ProjectOperation,
  ProjectServiceOptions,
  ProjectServiceState,
  ProjectResourcePolicy,
} from './projectTypes';

const EMPTY_STATE: ProjectServiceState = { busy: false, operation: 'idle', progress: null, error: null };

function cloneState(state: ProjectServiceState): ProjectServiceState {
  return { ...state };
}

function normalizedIds(ids: number[]): number[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5) throw new TypeError('Select between one and five source tracks.');
  const result = [...new Set(ids)];
  if (result.length !== ids.length || result.some((id) => !Number.isInteger(id) || id < 1 || id > 5)) {
    throw new RangeError('Source tracks must be unique track numbers from 1 to 5.');
  }
  return result;
}

/**
 * Coordinates project snapshots, WAV assets and 99 durable memory slots.
 * The adapter is the only engine-facing boundary; this module owns no DSP or
 * engine internals and validates all incoming audio before calling apply.
 */
export class ProjectService {
  private readonly adapter: ProjectEngineAdapter;
  private readonly store: ProjectMemoryStore;
  private readonly listeners = new Set<(state: ProjectServiceState) => void>();
  private readonly resourcePolicy: ProjectResourcePolicy;
  private readonly mixRenderer = new ProjectMixRenderer();
  private controls: ProjectServiceOptions['controls'];
  private state: ProjectServiceState = cloneState(EMPTY_STATE);
  private queue: Promise<void> = Promise.resolve();

  constructor(adapter: ProjectEngineAdapter, options: ProjectServiceOptions = {}) {
    this.adapter = adapter;
    this.store = options.store ?? new IndexedDbProjectMemoryStore();
    this.controls = options.controls;
    this.resourcePolicy = options.resourcePolicy ?? DEFAULT_PROJECT_RESOURCE_POLICY;
  }

  getState(): ProjectServiceState { return cloneState(this.state); }

  subscribe(listener: (state: ProjectServiceState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  setControlStateAdapter(controls: ProjectServiceOptions['controls']): void {
    this.controls = controls;
  }

  async listMemories(): Promise<ProjectMemoryInfo[]> { return this.store.list(); }

  async saveMemory(slot: number, name?: string): Promise<ProjectMemoryInfo> {
    assertMemorySlot(slot);
    return this.run('save', async () => {
      const captured = await this.captureForPersistence(name);
      const audioAssets: Record<string, Blob> = {};
      let completed = 0;
      for (const track of captured.audio) {
        if (track.buffer) {
          const assetId = `track-${track.trackId}`;
          captured.document.tracks[track.trackId - 1]!.audioAssetId = assetId;
          audioAssets[assetId] = await encodeAudioBufferToNativeWavBlobAsync(
            track.buffer,
            this.resourcePolicy.maxAssetBytes,
            (fraction) => this.setProgress((completed + fraction) / captured.audio.length),
          );
        } else {
          captured.document.tracks[track.trackId - 1]!.audioAssetId = null;
        }
        completed += 1;
        this.setProgress(completed / captured.audio.length);
      }
      const record: ProjectMemoryRecord = {
        slot,
        name: name?.trim() || captured.document.name || `Memory ${slot}`,
        updatedAt: captured.document.updatedAt,
        document: captured.document,
        audioAssets,
      };
      record.document.name = record.name;
      assertProjectMemoryRecord(record);
      // A single atomic IDB put replaces the old memory only after all assets
      // have been encoded and validated; quota errors preserve the old slot.
      return this.store.put(record);
    });
  }

  async loadMemory(slot: number): Promise<ProjectDocument> {
    assertMemorySlot(slot);
    return this.run('load', async () => {
      const record = await this.store.get(slot);
      if (!record) throw new Error(`Memory ${slot} is empty.`);
      assertProjectMemoryRecord(record);
      this.adapter.preflightProjectApply?.(record.document);
      const audio = await this.decodeAssets(record.document, record.audioAssets);
      await this.applyTransactional(record.document, audio);
      return cloneProjectDocument(record.document);
    });
  }

  async deleteMemory(slot: number): Promise<void> {
    assertMemorySlot(slot);
    return this.run('delete', () => this.store.delete(slot));
  }

  async exportProject(): Promise<Blob> {
    return this.run('export', async () => {
      const captured = await this.captureForPersistence();
      const assets = new Map<string, Blob>();
      for (const track of captured.audio) {
        if (!track.buffer) {
          captured.document.tracks[track.trackId - 1]!.audioAssetId = null;
          continue;
        }
        const id = `track-${track.trackId}`;
        captured.document.tracks[track.trackId - 1]!.audioAssetId = id;
        assets.set(id, await encodeAudioBufferToNativeWavBlobAsync(
          track.buffer,
          this.resourcePolicy.maxAssetBytes,
          (fraction) => this.setProgress((track.trackId - 1 + fraction) / captured.audio.length),
        ));
      }
      return encodeProjectArchive(captured.document, assets, this.resourcePolicy);
    });
  }

  async importProject(file: Blob | ArrayBuffer): Promise<ProjectDocument> {
    return this.run('import', async () => {
      const archive = await decodeProjectArchive(file, this.resourcePolicy);
      this.adapter.preflightProjectApply?.(archive.document);
      const audio = await this.decodeAssets(archive.document, Object.fromEntries(archive.assets));
      await this.applyTransactional(archive.document, audio);
      return cloneProjectDocument(archive.document);
    });
  }

  async exportTrackWav(trackId: number): Promise<Blob> {
    this.assertTrackId(trackId);
    return this.run('track-export', async () => {
      const buffer = await this.adapter.exportTrack(trackId);
      if (!buffer) throw new Error(`Track ${trackId} has no recorded audio.`);
      return encodeAudioBufferToProjectWavBlobAsync(buffer, this.resourcePolicy.maxAssetBytes);
    });
  }

  async importTrackWav(trackId: number, file: Blob | ArrayBuffer): Promise<void> {
    this.assertTrackId(trackId);
    return this.run('track-import', async () => {
      const blob = isBlobLike(file) ? file : new Blob([file], { type: 'audio/wav' });
      const metadata = await inspectWavHeader(blob, this.resourcePolicy.maxAssetBytes);
      if (metadata.frames <= 0) throw new Error('WAV contains no audio frames.');
      const engineSampleRate = this.adapter.getAudioContext().sampleRate;
      const pcm = await decodeWavBlobToProjectPcm(blob, undefined, engineSampleRate, this.resourcePolicy.maxAssetBytes);
      const buffer = this.adapter.createAudioBuffer(engineSampleRate, pcm.left, pcm.right);
      await this.adapter.importTrack(trackId, buffer);
    });
  }

  async exportMixWav(options: ProjectBounceOptions): Promise<Blob> {
    const sourceIds = normalizedIds(options.selectedTrackIds);
    return this.run('export', async () => {
      const buffer = await this.renderSelected(sourceIds, options);
      return encodeAudioBufferToProjectWavBlobAsync(buffer, this.resourcePolicy.maxAssetBytes);
    });
  }

  /** Render a selected source mix without importing it into a track. */
  async renderBounce(options: ProjectBounceOptions): Promise<AudioBuffer> {
    const sourceIds = normalizedIds(options.selectedTrackIds);
    return this.run('bounce', () => this.renderSelected(sourceIds, options));
  }

  /** Render selected source tracks, then load the finished stereo result into target. */
  async bounceTrack(targetTrackId: number, options: ProjectBounceOptions): Promise<AudioBuffer> {
    this.assertTrackId(targetTrackId);
    const sourceIds = normalizedIds(options.selectedTrackIds);
    if (sourceIds.includes(targetTrackId)) throw new Error('Bounce target must not also be one of its source tracks.');
    return this.run('bounce', async () => {
      const result = await this.renderSelected(sourceIds, options);
      await this.adapter.importTrack(targetTrackId, result);
      return result;
    });
  }

  private async captureForPersistence(name?: string): Promise<ProjectEngineCapture> {
    const capture = await this.adapter.captureProject();
    assertProjectDocument(capture.document);
    if (capture.audio.length !== 5) throw new Error('Project adapter must capture audio state for all five tracks.');
    const document = cloneProjectDocument(capture.document);
    const controls = this.controls?.read() ?? this.adapter.readControls?.();
    if (controls) document.controlState = structuredClone(controls);
    if (name?.trim()) document.name = name.trim().slice(0, 256);
    document.updatedAt = new Date().toISOString();
    return { document, audio: capture.audio.map((track) => ({ ...track })) };
  }

  private async decodeAssets(document: ProjectDocument, assets: Record<string, Blob>): Promise<Map<string, AudioBuffer>> {
    assertProjectDocument(document);
    const referenced = document.tracks.map((track) => track.audioAssetId).filter((id): id is string => id !== null);
    const assetIds = Object.keys(assets);
    if (referenced.length !== assetIds.length || referenced.some((id) => !isBlobLike(assets[id]))) {
      throw new TypeError('Project audio assets do not match the project document.');
    }

    // Preflight every asset's post-resample stereo allocation before creating
    // any AudioBuffers. The engine adapter also checks its bounded shared-memory
    // storage against this complete per-track frame plan.
    const contextRate = this.adapter.getAudioContext().sampleRate;
    let totalDecodedPcmBytes = 0;
    const plans: ProjectAudioAssetPlan[] = [];
    const headers = new Map<string, Awaited<ReturnType<typeof inspectWavHeader>>>();
    for (const track of document.tracks) {
      const id = track.audioAssetId;
      if (!id) continue;
      const metadata = await inspectWavHeader(assets[id]!, this.resourcePolicy.maxAssetBytes);
      const outputFrames = Math.ceil(metadata.frames * contextRate / metadata.sampleRate);
      const decodedPcmBytes = outputFrames * 2 * Float32Array.BYTES_PER_ELEMENT;
      if (!Number.isSafeInteger(outputFrames) || !Number.isSafeInteger(decodedPcmBytes)) {
        throw new RangeError(`Audio asset ${id} exceeds the safe decoded PCM size.`);
      }
      totalDecodedPcmBytes += decodedPcmBytes;
      if (!Number.isSafeInteger(totalDecodedPcmBytes)) throw new RangeError('Aggregate project PCM exceeds safe size bounds.');
      plans.push({
        trackId: track.id,
        sourceFrames: metadata.frames,
        sourceSampleRate: metadata.sampleRate,
        outputFrames,
        outputSampleRate: contextRate,
        decodedPcmBytes,
      });
      headers.set(id, metadata);
    }
    const decodedLimit = this.resourcePolicy.maxDecodedPcmBytes ?? this.resourcePolicy.maxAssetBytes;
    if (totalDecodedPcmBytes > decodedLimit) {
      throw new RangeError(`Project needs ${totalDecodedPcmBytes} decoded PCM bytes, above the configured ${decodedLimit}-byte aggregate limit.`);
    }
    this.adapter.preflightProjectAudioLoad?.(plans);

    const audio = new Map<string, AudioBuffer>();
    for (const id of referenced) {
      const metadata = headers.get(id);
      if (!metadata) throw new Error(`Project asset ${id} has no validated WAV header.`);
      const pcm = await decodeWavBlobToProjectPcm(assets[id]!, undefined, contextRate, this.resourcePolicy.maxAssetBytes);
      audio.set(id, this.adapter.createAudioBuffer(pcm.sampleRate, pcm.left, pcm.right));
    }
    return audio;
  }

  private async applyTransactional(document: ProjectDocument, audio: ReadonlyMap<string, AudioBuffer>): Promise<void> {
    this.adapter.preflightProjectApply?.(document);
    const prior = await this.captureForPersistence();
    const priorBuffers = new Map<string, AudioBuffer>();
    for (const item of prior.audio) {
      if (item.buffer) {
        const key = `track-${item.trackId}`;
        prior.document.tracks[item.trackId - 1]!.audioAssetId = key;
        priorBuffers.set(key, item.buffer);
      }
    }
    try {
      await this.adapter.applyProject(document, audio);
      const applyControls = this.controls?.apply ?? this.adapter.applyControls;
      await applyControls?.(document.controlState);
    } catch (error) {
      try {
        await this.adapter.applyProject(prior.document, priorBuffers);
        const applyControls = this.controls?.apply ?? this.adapter.applyControls;
        if (prior.document.controlState) await applyControls?.(prior.document.controlState);
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        const combined = new Error(`Applying project failed and rollback also failed: ${message}`) as Error & { causes?: unknown[] };
        combined.causes = [error, rollbackError];
        throw combined;
      }
      throw error;
    }
  }

  private async renderSelected(sourceIds: number[], options: ProjectBounceOptions): Promise<AudioBuffer> {
    const capture = await this.adapter.captureProject();
    assertProjectDocument(capture.document);
    if (options.durationFrames !== undefined && options.durationSeconds !== undefined) {
      throw new TypeError('Set durationFrames or durationSeconds, not both.');
    }
    const document = cloneProjectDocument(capture.document);
    const audioByTrackId = new Map<number, AudioBuffer>();
    for (const item of capture.audio) if (item.buffer) audioByTrackId.set(item.trackId, item.buffer);
    for (const trackId of sourceIds) {
      if (!audioByTrackId.has(trackId)) throw new Error(`Track ${trackId} has no recorded audio.`);
    }

    const context = this.adapter.getAudioContext();
    const durationFrames = options.durationFrames
      ?? (options.durationSeconds === undefined
        ? getProjectMixDefaultDurationFrames(document, audioByTrackId, sourceIds)
        : Math.ceil(options.durationSeconds * context.sampleRate));
    if (!Number.isSafeInteger(durationFrames) || durationFrames <= 0 || durationFrames > 259_200_000) {
      throw new RangeError('Bounce frame count is outside the supported range.');
    }

    const renderOptions = {
      context,
      document,
      audioByTrackId,
      selectedTrackIds: [...sourceIds],
      durationFrames,
      maxMemoryBytes: this.resourcePolicy.maxBounceMemoryBytes,
      createTrackFxGraph: (graphContext: BaseAudioContext, trackId: number, project: ProjectDocument) =>
        this.adapter.createTrackFxGraph?.(graphContext, trackId, project) ?? Promise.resolve(null),
      createSelectedTrackFxGraph: (graphContext: BaseAudioContext, project: ProjectDocument) =>
        this.adapter.createSelectedTrackFxGraph?.(graphContext, project) ?? Promise.resolve(null),
      createMasterFxGraph: (graphContext: BaseAudioContext, project: ProjectDocument) =>
        this.adapter.createMasterFxGraph?.(graphContext, project) ?? Promise.resolve(null),
    };
    return options.realtime
      ? await this.mixRenderer.renderRealtime(renderOptions)
      : await this.mixRenderer.renderOffline(renderOptions);
  }
  private assertTrackId(trackId: number): void {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) throw new RangeError('Track id must be an integer from 1 to 5.');
  }

  private run<T>(operation: ProjectOperation, action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      this.setState({ busy: true, operation, progress: 0, error: null });
      try {
        const task = () => action();
        return operation === 'delete' || !this.adapter.withProjectLock
          ? await task()
          : await this.adapter.withProjectLock(task);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setState({ busy: true, operation, progress: null, error: message });
        throw error;
      } finally {
        this.setState({ busy: false, operation: 'idle', progress: null, error: this.state.error });
      }
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private setProgress(progress: number): void {
    this.setState({ ...this.state, progress: Math.max(0, Math.min(1, progress)) });
  }

  private setState(state: ProjectServiceState): void {
    this.state = cloneState(state);
    this.listeners.forEach((listener) => listener(this.getState()));
  }
}
