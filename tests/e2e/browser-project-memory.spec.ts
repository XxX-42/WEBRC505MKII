import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('Browser project archives preserve stereo PCM and slot loads restore all five tracks atomically', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const merger = context.createChannelMerger(2);
      const destination = context.createMediaStreamDestination();
      const left = context.createOscillator();
      const right = context.createOscillator();
      const leftGain = context.createGain();
      const rightGain = context.createGain();
      left.type = right.type = 'sine';
      left.frequency.value = 377;
      right.frequency.value = 911;
      leftGain.gain.value = 0.25;
      rightGain.gain.value = 0.18;
      left.connect(leftGain).connect(merger, 0, 0);
      right.connect(rightGain).connect(merger, 0, 1);
      merger.connect(destination);
      left.start();
      right.start();
      await context.resume();
      return destination.stream;
    };
  });

  await page.goto('/?audio=browser');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const [{ AudioEngine }, { TrackAudio }, { ProjectMemory }, archiveModule, memoryStoreModule] = await Promise.all([
      loadModule('/src/audio/AudioEngine.ts'),
      loadModule('/src/audio/TrackAudio.ts'),
      loadModule('/src/audio/projectMemory.ts'),
      loadModule('/src/audio/projectArchive.ts'),
      loadModule('/src/audio/projectMemoryStore.ts'),
    ]);
    const root = document.querySelector('.app-root') as (HTMLElement & { __vueParentComponent?: any }) | null;
    const engine = root?.__vueParentComponent?.setupState?.engine ?? AudioEngine.getInstance();
    const tracks = engine.tracks as any[];
    if (engine.getMode() !== 'browser' || tracks.length !== 5) {
      throw new Error(`Expected five Browser tracks; got mode=${engine.getMode()} tracks=${tracks.length}`);
    }

    const context = (tracks[0] as any).engine.context as AudioContext;
    const memory = new ProjectMemory(engine);
    const slot = 98;
    const unicodeSlot = 97;
    const legacySlot = 99;
    const makeBuffers = (seed: number): AudioBuffer[] => tracks.map((_, trackIndex) => {
      const frameCount = 2_049 + trackIndex * 131;
      const buffer = context.createBuffer(2, frameCount, context.sampleRate);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let frame = 0; frame < frameCount; frame += 1) {
        left[frame] = Math.fround(Math.sin((frame + 1) * (0.013 + trackIndex * 0.0007)) * 0.4 + seed * 0.00003);
        right[frame] = Math.fround(Math.cos((frame + 1) * (0.021 + trackIndex * 0.0009)) * 0.3 - seed * 0.00002);
      }
      return buffer;
    });
    const seedTracks = (seed: number): void => {
      const restored = TrackAudio.restoreProjectBuffersAtomically(tracks, makeBuffers(seed));
      if (!restored.ok) throw new Error(restored.reason ?? 'Could not seed five Browser tracks');
    };
    const hashTracks = async () => Promise.all(tracks.map(async (track, index) => {
      const buffer = track.audioBuffer as AudioBuffer | null;
      if (!buffer || buffer.numberOfChannels !== 2) throw new Error(`Track ${index + 1} is not stereo`);
      const interleaved = new Float32Array(buffer.length * 2);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let frame = 0; frame < buffer.length; frame += 1) {
        interleaved[frame * 2] = left[frame]!;
        interleaved[frame * 2 + 1] = right[frame]!;
      }
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(interleaved.buffer));
      return {
        channels: buffer.numberOfChannels,
        frameCount: buffer.length,
        sha256: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(''),
      };
    }));
    const asProjectFile = (bytes: Uint8Array, name: string): File => {
      const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return new File([exact], name, { type: 'application/x-rc505-project' });
    };

    try {
      await memory.delete(slot);
      await memory.delete(unicodeSlot);
      await memory.delete(legacySlot);
      seedTracks(1);
      const exportedHashes = await hashTracks();
      const exportedFile = await memory.exportFile('stereo-roundtrip');

      // Corrupt a PCM payload byte. Import must reject it before changing any live loop.
      seedTracks(101);
      const beforeCorruptImport = await hashTracks();
      const corrupted = new Uint8Array(exportedFile);
      corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0x01;
      let corruptError = '';
      try {
        await memory.importFile(asProjectFile(corrupted, 'corrupt.rc505proj'));
      } catch (error) {
        corruptError = error instanceof Error ? error.message : String(error);
      }
      if (!corruptError) throw new Error('A corrupted project archive was accepted');
      const afterCorruptImport = await hashTracks();

      // Simulate a browser AudioBuffer allocation failure partway through staging.
      // The transaction must leave PCM, history, FX assignments, and tempo untouched.
      const sourceForFailedStage = await memory.exportFile('staging-failure');
      seedTracks(151);
      if (!engine.setTrackFxType(1, 0, 'DSP LPF')) throw new Error('Could not configure the FX rollback fixture');
      const fxReadyDeadline = Date.now() + 5_000;
      while (Date.now() < fxReadyDeadline && engine.getTrackFxStatus(1)[0]?.slots[0]?.state !== 'ready') {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
      if (!engine.setTrackFxActive(1, 0, true)) throw new Error('Could not activate the FX rollback fixture');
      const transportModule = await loadModule('/src/core/Transport.ts');
      const transport = transportModule.Transport.getInstance();
      transport.setBpm(137);
      const beforeFailedStage = {
        hashes: await hashTracks(),
        history: tracks.map((_, index) => engine.getTrackHistoryStatus(index + 1)),
        fx: engine.getTrackFxStatus(),
        bpm: transport.bpm,
        masterTrackId: transport.masterTrackId,
        measureLength: transport.measureLength,
        masterLoopLengthSamples: transport.masterLoopLengthSamples,
      };
      const originalCreateBuffer = context.createBuffer.bind(context);
      let createCalls = 0;
      (context as any).createBuffer = (...args: [number, number, number]) => {
        createCalls += 1;
        if (createCalls === 3) throw new Error('injected candidate-buffer allocation failure');
        return originalCreateBuffer(...args);
      };
      let allocationFailure = '';
      try {
        await memory.importFile(asProjectFile(sourceForFailedStage, 'staging-failure.rc505proj'));
      } catch (error) {
        allocationFailure = error instanceof Error ? error.message : String(error);
      } finally {
        (context as any).createBuffer = originalCreateBuffer;
      }
      if (!allocationFailure.includes('injected candidate-buffer')) {
        throw new Error(`Expected injected staged-buffer failure, got: ${allocationFailure || 'no failure'}`);
      }
      const afterFailedStage = {
        hashes: await hashTracks(),
        history: tracks.map((_, index) => engine.getTrackHistoryStatus(index + 1)),
        fx: engine.getTrackFxStatus(),
        bpm: transport.bpm,
        masterTrackId: transport.masterTrackId,
        measureLength: transport.measureLength,
        masterLoopLengthSamples: transport.masterLoopLengthSamples,
      };

      const imported = await memory.importFile(asProjectFile(exportedFile, 'roundtrip.rc505proj'));
      const importedHashes = await hashTracks();

      // Exercise the actual IndexedDB-backed slot save/load path through ProjectMemory.
      seedTracks(201);
      const slotHashes = await hashTracks();
      const saved = await memory.save(slot, '  slot-roundtrip  ');
      const listed = await memory.list();
      seedTracks(301);
      const beforeSlotLoad = await hashTracks();
      // A new service instance must read the same committed IndexedDB snapshot.
      const restartedMemory = new ProjectMemory(engine);
      const loaded = await restartedMemory.load(slot);
      const loadedHashes = await hashTracks();

      // Invalid names must fail before replacing an occupied slot.
      const emptyNameFailures: string[] = [];
      for (const invalidName of ['', '   \t\n  ']) {
        try {
          await memory.save(slot, invalidName);
          emptyNameFailures.push('accepted');
        } catch (error) {
          emptyNameFailures.push(error instanceof Error ? error.message : String(error));
        }
      }
      const afterInvalidNameSave = await hashTracks();
      const afterInvalidNameLoad = await restartedMemory.load(slot);
      const afterInvalidNameSlotHashes = await hashTracks();

      // Canonical Unicode names round-trip through metadata and a restarted service.
      seedTracks(401);
      const unicodeHashes = await hashTracks();
      const unicodeSaved = await memory.save(unicodeSlot, '  音楽 loops 🎛️  ');
      seedTracks(501);
      const unicodeRestartedMemory = new ProjectMemory(engine);
      const unicodeLoaded = await unicodeRestartedMemory.load(unicodeSlot);
      const unicodeLoadedHashes = await hashTracks();

      // Compatibility fixture for pre-fix archives: manifest retained padding,
      // while the old IndexedDB metadata stored the trimmed name.
      const decodedSlotArchive = await archiveModule.decodeProjectArchive(await memory.exportFile('legacy-source'));
      const legacyArchive = await archiveModule.encodeProjectArchive({
        name: '  legacy whitespace  ',
        bpm: decodedSlotArchive.bpm,
        transport: decodedSlotArchive.transport,
        tracks: decodedSlotArchive.tracks.map((track: any) => track ? ({
          sampleRate: track.sampleRate, frameCount: track.frameCount, channels: track.channels,
          originalTempoBpm: null, pcm: track.pcm,
        }) : null),
      });
      const legacyStored = await new memoryStoreModule.ProjectMemoryStore().save(
        legacySlot,
        'legacy whitespace',
        decodedSlotArchive.bpm,
        legacyArchive,
      );
      seedTracks(601);
      const legacyRestartedMemory = new ProjectMemory(engine);
      const legacyLoaded = await legacyRestartedMemory.load(legacySlot);
      const legacyLoadedHashes = await hashTracks();

      return {
        corruptError,
        beforeCorruptImport,
        afterCorruptImport,
        allocationFailure,
        beforeFailedStage,
        afterFailedStage,
        exportedHashes,
        importedHashes,
        imported,
        saved,
        listedSlot: listed.find((metadata: any) => metadata.slot === slot) ?? null,
        beforeSlotLoad,
        slotHashes,
        loadedHashes,
        loaded,
        emptyNameFailures,
        afterInvalidNameSave,
        afterInvalidNameSlotHashes,
        afterInvalidNameLoad,
        unicodeSaved,
        unicodeHashes,
        unicodeLoaded,
        unicodeLoadedHashes,
        legacyStored,
        legacyLoaded,
        legacyLoadedHashes,
      };
    } finally {
      await memory.delete(slot);
      await memory.delete(unicodeSlot);
      await memory.delete(legacySlot);
      engine.stopAllTracks();
    }
  });

  expect(result.corruptError).toContain('hash');
  expect(result.afterCorruptImport).toEqual(result.beforeCorruptImport);
  expect(result.allocationFailure).toContain('injected candidate-buffer');
  expect(result.afterFailedStage).toEqual(result.beforeFailedStage);
  expect(result.imported).toEqual({ name: 'stereo-roundtrip', bpm: expect.any(Number), tracksWithAudio: 5, archiveVersion: 1 });
  expect(result.importedHashes).toEqual(result.exportedHashes);
  expect(result.saved).toMatchObject({ slot: 98, name: 'slot-roundtrip', bpm: expect.any(Number) });
  expect(result.listedSlot).toMatchObject({ slot: 98, name: 'slot-roundtrip' });
  expect(result.beforeSlotLoad).not.toEqual(result.slotHashes);
  expect(result.loaded).toEqual({ name: 'slot-roundtrip', bpm: result.saved.bpm, tracksWithAudio: 5, archiveVersion: 1 });
  expect(result.loadedHashes).toEqual(result.slotHashes);
  expect(result.emptyNameFailures).toHaveLength(2);
  expect(result.emptyNameFailures.every((failure: string) => failure !== 'accepted')).toBe(true);
  expect(result.afterInvalidNameSave).toEqual(result.loadedHashes);
  expect(result.afterInvalidNameSlotHashes).toEqual(result.slotHashes);
  expect(result.afterInvalidNameLoad).toEqual({ name: 'slot-roundtrip', bpm: result.saved.bpm, tracksWithAudio: 5, archiveVersion: 1 });
  expect(result.unicodeSaved).toMatchObject({ slot: 97, name: '音楽 loops 🎛️' });
  expect(result.unicodeLoaded).toEqual({ name: '音楽 loops 🎛️', bpm: result.unicodeSaved.bpm, tracksWithAudio: 5, archiveVersion: 1 });
  expect(result.unicodeLoadedHashes).toEqual(result.unicodeHashes);
  expect(result.legacyStored).toMatchObject({ slot: 99, name: 'legacy whitespace' });
  expect(result.legacyLoaded).toEqual({ name: 'legacy whitespace', bpm: result.legacyStored.bpm, tracksWithAudio: 5, archiveVersion: 1 });
  expect(result.legacyLoadedHashes).toEqual(result.unicodeLoadedHashes);
  expect(result.loadedHashes).toHaveLength(5);
  for (const track of result.loadedHashes) {
    expect(track.channels).toBe(2);
    expect(track.frameCount).toBeGreaterThan(2_000);
    expect(track.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
});

test('Browser v2 archive round-trips verified track tempo while v1 imports stay unknown', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.connect(destination);
      oscillator.start();
      await context.resume();
      return destination.stream;
    };
  });

  await page.goto('/?audio=browser');
  await startBrowserAudio(page);
  const result = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const [{ AudioEngine }, { TrackAudio }, { ProjectMemory }, { decodeProjectArchive, encodeProjectArchive }] = await Promise.all([
      loadModule('/src/audio/AudioEngine.ts'),
      loadModule('/src/audio/TrackAudio.ts'),
      loadModule('/src/audio/projectMemory.ts'),
      loadModule('/src/audio/projectArchive.ts'),
    ]);
    const engine = AudioEngine.getInstance();
    const tracks = engine.tracks as any[];
    if (engine.getMode() !== 'browser' || tracks.length !== 5) throw new Error('Expected five Browser tracks.');
    const context = tracks[0].engine.context as AudioContext;
    const memory = new ProjectMemory(engine);
    const slot = 96;
    const seed = (baseBpm: number): void => {
      const replacements = tracks.map((_, index) => {
        const buffer = context.createBuffer(1, 64 + index, context.sampleRate);
        const channel = buffer.getChannelData(0);
        for (let frame = 0; frame < channel.length; frame += 1) channel[frame] = Math.fround(Math.sin((frame + 1) * (index + 1) * 0.03));
        return buffer;
      });
      const revisions = tracks.map((track) => track.projectRevision);
      const bpm = tracks.map((_, index) => baseBpm + index);
      const restored = TrackAudio.restoreProjectBuffersAtomically(tracks, replacements, revisions, 'retain-undo', bpm);
      if (!restored.ok) throw new Error(restored.reason ?? 'Could not seed Browser provenance fixture.');
    };
    const file = (bytes: Uint8Array, name: string): File => {
      const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return new File([exact], name, { type: 'application/x-rc505-project' });
    };
    try {
      await memory.delete(slot);
      seed(110);
      const exported = await engine.exportProjectArchive('verified-tempo-v2');
      const decoded = await decodeProjectArchive(exported);
      if (decoded.version !== 2 || decoded.tracks.some((track: any, index: number) => track?.originalTempoBpm !== 110 + index)) {
        throw new Error('Browser export did not persist per-track provenance in archive v2.');
      }

      seed(120);
      await memory.importFile(file(exported, 'verified-tempo-v2.rc505proj'));
      const afterV2Import = tracks.map((track) => track.originalRecordingBpm);
      for (const track of tracks) if (!track.undo()) throw new Error('v2 import did not retain the incumbent undo snapshot.');
      const afterV2Undo = tracks.map((track) => track.originalRecordingBpm);
      for (const track of tracks) if (!track.redo()) throw new Error('v2 import redo was unavailable.');
      const afterV2Redo = tracks.map((track) => track.originalRecordingBpm);

      const saved = await memory.save(slot, 'browser-v2-slot');
      seed(130);
      const loaded = await new ProjectMemory(engine).load(slot);
      const afterSlotLoad = tracks.map((track) => track.originalRecordingBpm);

      const v1Input = {
        name: decoded.name,
        bpm: decoded.bpm,
        transport: decoded.transport,
        tracks: decoded.tracks.map((track: any) => track ? ({
          sampleRate: track.sampleRate, frameCount: track.frameCount, channels: track.channels,
          originalTempoBpm: null, pcm: track.pcm,
        }) : null),
      };
      const v1Bytes = await encodeProjectArchive(v1Input);
      const decodedV1 = await decodeProjectArchive(v1Bytes);
      if (decodedV1.version !== 1 || decodedV1.tracks.some((track: any) => track?.originalTempoBpm !== null)) {
        throw new Error('Legacy v1 decode did not normalize the source tempo to unknown.');
      }
      await memory.importFile(file(v1Bytes, 'legacy-v1.rc505proj'));
      const afterV1Import = tracks.map((track) => track.originalRecordingBpm);
      for (const track of tracks) if (!track.undo()) throw new Error('v1 import did not retain the incumbent provenance snapshot.');
      const afterV1Undo = tracks.map((track) => track.originalRecordingBpm);
      for (const track of tracks) if (!track.redo()) throw new Error('v1 import redo was unavailable.');
      const afterV1Redo = tracks.map((track) => track.originalRecordingBpm);

      return { version: decoded.version, savedVersion: saved.archiveVersion, loadedVersion: loaded.archiveVersion,
        afterV2Import, afterV2Undo, afterV2Redo, afterSlotLoad, afterV1Import, afterV1Undo, afterV1Redo };
    } finally {
      await memory.delete(slot);
    }
  });

  expect(result.version).toBe(2);
  expect(result.savedVersion).toBe(2);
  expect(result.loadedVersion).toBe(2);
  expect(result.afterV2Import).toEqual([110, 111, 112, 113, 114]);
  expect(result.afterV2Undo).toEqual([120, 121, 122, 123, 124]);
  expect(result.afterV2Redo).toEqual([110, 111, 112, 113, 114]);
  expect(result.afterSlotLoad).toEqual([110, 111, 112, 113, 114]);
  expect(result.afterV1Import).toEqual([null, null, null, null, null]);
  expect(result.afterV1Undo).toEqual([110, 111, 112, 113, 114]);
  expect(result.afterV1Redo).toEqual([null, null, null, null, null]);
});

test('Browser project loads reject PCM, history, or transport edits completed during asynchronous reads', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      oscillator.start();
      await context.resume();
      return destination.stream;
    };
  });

  await page.goto('/?audio=browser');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const [{ AudioEngine }, { TrackAudio }, { ProjectMemory }, { ProjectMemoryStore }, { Transport }] = await Promise.all([
      loadModule('/src/audio/AudioEngine.ts'),
      loadModule('/src/audio/TrackAudio.ts'),
      loadModule('/src/audio/projectMemory.ts'),
      loadModule('/src/audio/projectMemoryStore.ts'),
      loadModule('/src/core/Transport.ts'),
    ]);
    const engine = AudioEngine.getInstance();
    const tracks = engine.tracks as any[];
    const context = (tracks[0] as any).engine.context as AudioContext;
    const memory = new ProjectMemory(engine);
    const transport = Transport.getInstance();
    const slot = 96;

    const seedTracks = (seed: number, emptyFirstTrack = false): void => {
      const buffers = tracks.map((_, trackIndex) => {
        if (emptyFirstTrack && trackIndex === 0) return null;
        const buffer = context.createBuffer(2, 2_049 + trackIndex * 17, context.sampleRate);
        for (let frame = 0; frame < buffer.length; frame += 1) {
          buffer.getChannelData(0)[frame] = Math.fround(Math.sin((frame + seed) * 0.017) * 0.3);
          buffer.getChannelData(1)[frame] = Math.fround(Math.cos((frame + seed) * 0.023) * 0.2);
        }
        return buffer;
      });
      const restored = TrackAudio.restoreProjectBuffersAtomically(tracks, buffers);
      if (!restored.ok) throw new Error(restored.reason ?? 'Could not seed concurrent-edit fixture');
    };
    const snapshot = async () => ({
      hashes: await Promise.all(tracks.map(async (track) => {
        const buffer = track.audioBuffer as AudioBuffer | null;
        if (!buffer) return null;
        const samples = new Float32Array(buffer.length * buffer.numberOfChannels);
        for (let frame = 0; frame < buffer.length; frame += 1) {
          for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            samples[frame * buffer.numberOfChannels + channel] = buffer.getChannelData(channel)[frame]!;
          }
        }
        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(samples.buffer));
        return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
      })),
      history: tracks.map((_, index) => engine.getTrackHistoryStatus(index + 1)),
      bpm: transport.bpm,
      masterTrackId: transport.masterTrackId,
      measureLength: transport.measureLength,
      masterLoopLengthSamples: transport.masterLoopLengthSamples,
      timeSignature: [...transport.timeSignature],
    });
    const makeDeferred = () => {
      let release!: () => void;
      let started!: () => void;
      const began = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      return { began, release, wait: async () => { started(); await gate; } };
    };

    try {
      await memory.delete(slot);
      seedTracks(11);
      const sourceArchive = await memory.exportFile('delayed-load-source');
      const sourceProject = await (await loadModule('/src/audio/projectArchive.ts')).decodeProjectArchive(sourceArchive);
      const backingStore = new ProjectMemoryStore();
      await backingStore.save(slot, sourceProject.name, sourceProject.bpm, sourceArchive);

      // The IndexedDB read is deliberately paused after load() starts. A user edit
      // that completes during this gap must survive rather than become the load's
      // newly captured baseline.
      const slotRead = makeDeferred();
      const delayedStore = {
        readSlot: async (requestedSlot: number) => {
          await slotRead.wait();
          return backingStore.readSlot(requestedSlot);
        },
      };
      const delayedSlotMemory = new ProjectMemory(engine, delayedStore as any);
      const slotLoad = delayedSlotMemory.load(slot);
      await slotRead.began;
      seedTracks(23);
      transport.setBpm(149);
      const beforeSlotConflict = await snapshot();
      slotRead.release();
      let slotError = '';
      try { await slotLoad; } catch (error) { slotError = error instanceof Error ? error.message : String(error); }
      const afterSlotConflict = await snapshot();

      // The file picker has the same asynchronous gap; exercise it independently
      // so no alternate ProjectMemory entry point can bypass the operation token.
      engine.stopAllTracks();
      transport.resetMasterTrack();
      transport.setBpm(120);
      seedTracks(37, true);
      const exported = await memory.exportFile('delayed-file-source');
      const fileRead = makeDeferred();
      const delayedFile = {
        size: exported.byteLength,
        arrayBuffer: async () => {
          await fileRead.wait();
          return exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength);
        },
      } as File;
      const fileImport = memory.importFile(delayedFile);
      await fileRead.began;
      const recordingTrack = tracks[0] as any;
      recordingTrack.triggerRecord();
      const recordingDeadline = Date.now() + 5_000;
      while (Date.now() < recordingDeadline && recordingTrack.state !== 'RECORDING') {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
      if (recordingTrack.state !== 'RECORDING') throw new Error('Concurrent Browser recording did not become active');
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      await recordingTrack.stopRecording();
      const finalizationDeadline = Date.now() + 5_000;
      while (Date.now() < finalizationDeadline && recordingTrack.historyBusy) {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
      if (recordingTrack.historyBusy) throw new Error(`Concurrent Browser recording did not finalize: ${recordingTrack.recordingDiagnostic ?? 'no diagnostic'}`);
      const recordedBuffer = recordingTrack.audioBuffer as AudioBuffer | null;
      if (!recordedBuffer || recordedBuffer.length === 0) throw new Error('Concurrent Browser recording produced no PCM');
      let recordedPower = 0;
      let recordedSamples = 0;
      for (let channel = 0; channel < recordedBuffer.numberOfChannels; channel += 1) {
        const data = recordedBuffer.getChannelData(channel);
        for (let frame = 0; frame < data.length; frame += 1) {
          recordedPower += data[frame]! * data[frame]!;
          recordedSamples += 1;
        }
      }
      const recordedRms = Math.sqrt(recordedPower / Math.max(1, recordedSamples));
      if (!Number.isFinite(recordedRms) || recordedRms < 1e-5) throw new Error(`Concurrent Browser recording was silent: RMS=${recordedRms}`);
      const beforeFileConflict = await snapshot();
      fileRead.release();
      let fileError = '';
      try { await fileImport; } catch (error) { fileError = error instanceof Error ? error.message : String(error); }
      const afterFileConflict = await snapshot();

      return { slotError, beforeSlotConflict, afterSlotConflict, fileError, beforeFileConflict, afterFileConflict, recordedRms };
    } finally {
      await memory.delete(slot);
      engine.stopAllTracks();
    }
  });

  expect(result.slotError).toContain('changed while the archive was being read');
  expect(result.afterSlotConflict).toEqual(result.beforeSlotConflict);
  expect(result.fileError).toContain('changed while the archive was being read');
  expect(result.afterFileConflict).toEqual(result.beforeFileConflict);
  expect(result.recordedRms).toBeGreaterThan(1e-5);
});
