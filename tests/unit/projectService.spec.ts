import { describe, expect, it } from 'vitest';
import { ProjectService } from '../../src/project/ProjectService';
import { VolatileProjectMemoryStore } from '../../src/project/IndexedDbProjectMemoryStore';
import { createDefaultProjectDocument } from '../../src/project/projectValidation';
import type { ProjectDocument, ProjectEngineAdapter } from '../../src/project/projectTypes';
import { encodeProjectArchive } from '../../src/project/projectArchive';
import { readBlobArrayBuffer } from '../../src/project/blobUtils';
import { inspectWavHeader } from '../../src/project/wavCodec';

function makeBuffer(sampleRate: number, left: number[], right = left) {
  const channels = [Float32Array.from(left), Float32Array.from(right)];
  return {
    sampleRate,
    length: left.length,
    numberOfChannels: right === left ? 1 : 2,
    getChannelData: (channel: number) => channels[channel]!,
  } as AudioBuffer;
}

function makeStereoFloatWav(frames: number, sampleRate = 48_000): Blob {
  const bytes = new ArrayBuffer(44 + frames * 2 * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes);
  const ascii = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2 * Float32Array.BYTES_PER_ELEMENT, true);
  view.setUint16(32, 2 * Float32Array.BYTES_PER_ELEMENT, true); view.setUint16(34, 32, true);
  ascii(36, 'data'); view.setUint32(40, frames * 2 * Float32Array.BYTES_PER_ELEMENT, true);
  for (let frame = 0; frame < frames; frame += 1) {
    view.setFloat32(44 + frame * 8, 0.125, true);
    view.setFloat32(48 + frame * 8, -0.25, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

function makeAdapter() {
  let document = createDefaultProjectDocument('initial');
  const audio = new Map<number, AudioBuffer>();
  audio.set(1, makeBuffer(48_000, [0.125, -0.25, 0.5], [-0.125, 0.25, -0.5]));
  let failNextApply = false;
  const adapter: ProjectEngineAdapter = {
    withProjectLock: async (action) => action(),
    captureProject: async () => ({
      document: structuredClone(document),
      audio: Array.from({ length: 5 }, (_, index) => ({ trackId: index + 1, buffer: audio.get(index + 1) ?? null })),
    }),
    applyProject: async (next, assets) => {
      document = structuredClone(next);
      audio.clear();
      for (const track of next.tracks) {
        const assetId = track.audioAssetId;
        const buffer = assetId ? assets.get(assetId) : null;
        if (buffer) audio.set(track.id, buffer);
      }
      if (failNextApply) {
        failNextApply = false;
        throw new Error('simulated engine apply error');
      }
    },
    exportTrack: async (trackId) => audio.get(trackId) ?? null,
    importTrack: async (trackId, buffer) => { audio.set(trackId, buffer); },
    createAudioBuffer: (sampleRate, left, right) => makeBuffer(sampleRate, [...left], [...right]),
    getAudioContext: () => ({ sampleRate: 48_000 } as AudioContext),
  };
  return {
    adapter,
    setDocument: (next: ProjectDocument) => { document = structuredClone(next); },
    getDocument: () => structuredClone(document),
    getAudio: (trackId: number) => audio.get(trackId) ?? null,
    failApply: () => { failNextApply = true; },
  };
}

describe('ProjectService and 99Memory', () => {
  it('round-trips project settings, assignments, native stereo PCM and the selected memory slot', async () => {
    const fixture = makeAdapter();
    const store = new VolatileProjectMemoryStore();
    const controlState = {
      version: 1 as const,
      assignments: Array.from({ length: 16 }, () => null as null | { source: 'cc'; channel: number; number: number; trigger: 'value'; command: 'set-tempo'; trackId: number }),
    };
    controlState.assignments[0] = { source: 'cc', channel: 2, number: 7, trigger: 'value', command: 'set-tempo', trackId: 1 };
    const service = new ProjectService(fixture.adapter, { store, controls: { read: () => controlState, apply: (state) => { Object.assign(controlState, structuredClone(state)); } } });
    const stateEvents: boolean[] = [];
    const unsubscribe = service.subscribe((state) => stateEvents.push(state.busy));
    const document = fixture.getDocument();
    document.name = 'Memory one';
    document.global.bpm = 87;
    document.global.loopSyncMode = 'LOOP LENGTH';
    document.routing.inputInst1R = 'OFF';
    document.mixer.masterLevel = 0.75;
    document.tracks[0]!.settings.runtime.speed = 1.5;
    document.tracks[0]!.settings.runtime.keepPitch = true;
    document.tracks[0]!.settings.loopFrames = 3;
    document.tracks[0]!.settings.fxChain.filter.enabled = true;
    document.tracks[0]!.settings.fxChain.filter.params.frequency = 0.27;
    fixture.setDocument(document);

    const saved = await service.saveMemory(1, 'Memory one');
    expect(saved).toMatchObject({ slot: 1, name: 'Memory one', trackCount: 5, assetCount: 1 });

    const changed = fixture.getDocument();
    changed.global.bpm = 155;
    changed.tracks[0]!.settings.runtime.speed = 0.75;
    changed.tracks[0]!.settings.fxChain.filter.params.frequency = 0.9;
    fixture.setDocument(changed);
    controlState.assignments[0] = null;
    await fixture.adapter.importTrack(1, makeBuffer(48_000, [0, 0, 0], [0, 0, 0]));

    const loaded = await service.loadMemory(1);
    expect(loaded.global.bpm).toBe(87);
    expect(loaded.routing.inputInst1R).toBe('OFF');
    expect(loaded.mixer.masterLevel).toBe(0.75);
    expect(loaded.tracks[0]!.settings.runtime).toMatchObject({ speed: 1.5, keepPitch: true });
    expect(loaded.tracks[0]!.settings.fxChain.filter.params.frequency).toBe(0.27);
    expect(controlState.assignments[0]).toMatchObject({ number: 7, command: 'set-tempo' });
    const audio = fixture.getAudio(1)!;
    expect(audio.sampleRate).toBe(48_000);
    expect([...audio.getChannelData(0)]).toEqual([0.125, -0.25, 0.5]);
    expect([...audio.getChannelData(1)]).toEqual([-0.125, 0.25, -0.5]);
    expect(stateEvents).toContain(true);
    expect(service.getState()).toMatchObject({ busy: false, operation: 'idle', error: null });
    unsubscribe();
  });

  it('keeps a prior slot after quota failure and rolls back failed project application', async () => {
    const fixture = makeAdapter();
    const store = new VolatileProjectMemoryStore();
    const service = new ProjectService(fixture.adapter, { store });
    await service.saveMemory(1, 'saved-before-quota');
    store.setNextWriteFailure(new DOMException('quota exceeded', 'QuotaExceededError'));
    await expect(service.saveMemory(1, 'must-not-replace')).rejects.toThrow(/quota exceeded/i);
    expect((await store.get(1))?.name).toBe('saved-before-quota');

    const current = fixture.getDocument();
    current.global.bpm = 132;
    fixture.setDocument(current);
    const imported = createDefaultProjectDocument('different project');
    imported.global.bpm = 93;
    const archive = await encodeProjectArchive(imported, new Map());
    fixture.failApply();
    await expect(service.importProject(archive)).rejects.toThrow(/simulated engine apply error/);
    expect(fixture.getDocument().global.bpm).toBe(132);
  });

  it('exports and imports a single 44.1 kHz WAV track', async () => {
    const fixture = makeAdapter();
    const service = new ProjectService(fixture.adapter, { store: new VolatileProjectMemoryStore() });
    const wav = await service.exportTrackWav(1);
    expect(await inspectWavHeader(wav)).toMatchObject({ sampleRate: 44_100, channels: 2, format: 3 });
    await service.importTrackWav(2, wav);
    expect(fixture.getAudio(2)?.sampleRate).toBe(48_000);
    expect([...fixture.getAudio(2)!.getChannelData(0)].length).toBe(3);
  });

  it('validates every archive asset before mutating engine state', async () => {
    const fixture = makeAdapter();
    const service = new ProjectService(fixture.adapter, { store: new VolatileProjectMemoryStore() });
    const source = fixture.getDocument();
    source.tracks[0]!.audioAssetId = 'track-1';
    const audio = new Map<string, Blob>();
    const wav = await service.exportTrackWav(1);
    audio.set('track-1', wav);
    const archive = await encodeProjectArchive(source, audio);
    const bytes = new Uint8Array(await readBlobArrayBuffer(archive));
    const manifestSize = new DataView(bytes.buffer).getUint32(8, true);
    bytes[16 + manifestSize] = 0;
    await expect(service.importProject(new Blob([bytes]))).rejects.toThrow(/RIFF\/WAVE/);
    expect(fixture.getDocument().global.bpm).toBe(120);
  });

  it('preflights unsupported enabled legacy track FX before decoding audio or applying the project', async () => {
    const fixture = makeAdapter();
    let audioBufferCreations = 0;
    let applications = 0;
    const createAudioBuffer = fixture.adapter.createAudioBuffer;
    const applyProject = fixture.adapter.applyProject;
    fixture.adapter.createAudioBuffer = (...args) => {
      audioBufferCreations += 1;
      return createAudioBuffer(...args);
    };
    fixture.adapter.applyProject = async (...args) => {
      applications += 1;
      await applyProject(...args);
    };
    fixture.adapter.preflightProjectApply = (document) => {
      if (document.tracks.some((track) => track.settings.fxSlots.some((slot) => slot?.enabled))) {
        throw new Error('enabled legacy FX slots are unsupported');
      }
    };
    const project = createDefaultProjectDocument('legacy effect archive');
    project.tracks[0]!.audioAssetId = 'asset-1';
    project.tracks[0]!.settings.fxSlots[0] = {
      type: 'FILTER', enabled: true, params: { frequency: 0.4, resonance: 0.1 },
    };
    const archive = await encodeProjectArchive(project, new Map([['asset-1', makeStereoFloatWav(8)]]));
    const service = new ProjectService(fixture.adapter, { store: new VolatileProjectMemoryStore() });

    await expect(service.importProject(archive)).rejects.toThrow(/enabled legacy FX slots/);

    expect(audioBufferCreations).toBe(0);
    expect(applications).toBe(0);
    expect(fixture.getDocument().name).toBe('initial');
  });

  it('rejects aggregate decoded PCM and SAB growth over budget before decoding or applying, preserving old Memory PCM', async () => {
    const fixture = makeAdapter();
    const store = new VolatileProjectMemoryStore();
    let audioBufferCreations = 0;
    let projectApplications = 0;
    const originalCreateAudioBuffer = fixture.adapter.createAudioBuffer;
    const originalApplyProject = fixture.adapter.applyProject;
    fixture.adapter.createAudioBuffer = (...args) => {
      audioBufferCreations += 1;
      return originalCreateAudioBuffer(...args);
    };
    fixture.adapter.applyProject = async (...args) => {
      projectApplications += 1;
      await originalApplyProject(...args);
    };
    const service = new ProjectService(fixture.adapter, {
      store,
      resourcePolicy: { maxAssetBytes: 1_024, maxArchiveBytes: 1_000_000, maxDecodedPcmBytes: 255 },
    });
    await service.saveMemory(1, 'preserved-before-budget-rejection');
    const savedBefore = await store.get(1);
    const savedLeftPcm = new DataView(await readBlobArrayBuffer(savedBefore!.audioAssets['track-1']!)).getFloat32(44, true);

    const document = createDefaultProjectDocument('aggregate-budget-overflow');
    document.tracks[0]!.audioAssetId = 'asset-a';
    document.tracks[1]!.audioAssetId = 'asset-b';
    const archive = await encodeProjectArchive(document, new Map([
      ['asset-a', makeStereoFloatWav(16)],
      ['asset-b', makeStereoFloatWav(16)],
    ]));
    await expect(service.importProject(archive)).rejects.toThrow(/aggregate limit/i);
    expect(audioBufferCreations).toBe(0);
    expect(projectApplications).toBe(0);
    expect(fixture.getDocument().global.bpm).toBe(120);
    const savedAfter = await store.get(1);
    expect(savedAfter?.name).toBe('preserved-before-budget-rejection');
    expect(new DataView(await readBlobArrayBuffer(savedAfter!.audioAssets['track-1']!)).getFloat32(44, true)).toBe(savedLeftPcm);

    // Under the decoded-PCM budget, a runtime-specific capacity/mask preflight
    // still has to reject before AudioBuffer allocation and engine mutation.
    fixture.adapter.preflightProjectAudioLoad = () => { throw new RangeError('SAB mask storage capacity exceeded'); };
    const runtimeBudgetService = new ProjectService(fixture.adapter, {
      store,
      resourcePolicy: { maxAssetBytes: 1_024, maxArchiveBytes: 1_000_000, maxDecodedPcmBytes: 1_000 },
    });
    const smallDocument = createDefaultProjectDocument('runtime-storage-overflow');
    smallDocument.tracks[0]!.audioAssetId = 'asset-small';
    const smallArchive = await encodeProjectArchive(smallDocument, new Map([['asset-small', makeStereoFloatWav(16)]]));
    await expect(runtimeBudgetService.importProject(smallArchive)).rejects.toThrow(/SAB mask storage capacity/i);
    expect(audioBufferCreations).toBe(0);
    expect(projectApplications).toBe(0);
  });
});
