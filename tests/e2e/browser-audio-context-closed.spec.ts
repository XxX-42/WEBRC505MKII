import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { activateLcdAction, findLcdField, lcdScreen, startBrowserAudio } from './uiHelpers';

test('closed Browser AudioContext clears READY, preserves PCM/history and leaves project export available', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const [{ AudioEngine }, { TrackAudio }] = await Promise.all([
      loadModule('/src/audio/AudioEngine.ts'),
      loadModule('/src/audio/TrackAudio.ts'),
    ]);
    const engine = AudioEngine.getInstance();
    // Give the recovery path a non-default authored output level. Preparation
    // must remain muted, then restore this value only after explicit resume.
    engine.setOutputLevel(37);
    const tracks = engine.tracks as any[];
    const browserEngine = tracks[0]!.engine as any;
    const context = tracks[0]!.engine.context as AudioContext;
    browserEngine.selectedOutputDeviceId = 'recovery-output-device';
    if (context.state !== 'running' || tracks.length !== 5) {
      throw new Error(`Expected a running five-track Browser graph, got ${context.state}/${tracks.length}`);
    }

    const seedBuffers = tracks.map((_, trackIndex) => {
      const buffer = context.createBuffer(2, 1024 + trackIndex * 17, context.sampleRate);
      for (let channel = 0; channel < 2; channel += 1) buffer.getChannelData(channel).fill(0.03 * (trackIndex + 1) * (channel + 1));
      return buffer;
    });
    const seeded = TrackAudio.restoreProjectBuffersAtomically(tracks, seedBuffers);
    if (!seeded.ok) throw new Error(seeded.reason ?? 'Could not seed the pre-existing five-track PCM fixture');

    const replacements = tracks.map((_, trackIndex) => {
      const buffer = context.createBuffer(2, 1024 + trackIndex * 17, context.sampleRate);
      for (let channel = 0; channel < 2; channel += 1) {
        const samples = buffer.getChannelData(channel);
        for (let frame = 0; frame < samples.length; frame += 1) {
          samples[frame] = Math.fround(Math.sin((frame + 1) * (0.011 + trackIndex * 0.001 + channel * 0.004)) * (0.2 + channel * 0.1));
        }
      }
      return buffer;
    });
    const restored = TrackAudio.restoreProjectBuffersAtomically(tracks, replacements);
    if (!restored.ok) throw new Error(restored.reason ?? 'Could not prepare recoverable PCM fixture');

    // Persist two genuinely active Keep Pitch modes. Candidate recovery must
    // prepare the real stopped processors without loading PCM or starting play.
    await tracks[0]!.setLiveMonoPitchEnabled(true, {
      semitones: -3, minimumFrequencyHz: 65, maximumFrequencyHz: 1_050,
    });
    for (let index = 1; index < tracks.length; index += 1) {
      await tracks[index]!.setLivePolyPitchEnabled(true, {
        semitones: index - 2, playbackRate: 0.9 + index * 0.02, tonalityLimitHz: 7_500,
      });
    }

    // Save distinct, ready FX configurations on all five private A–D banks,
    // plus the shared input and track banks. Candidate recovery below must
    // rebuild the real shipped worklets without constructing a new engine.
    const privateFx = [
      ['DSP HPF', { cutoffHz: 380, q: 2, filterResonancePercent: 20, mix: 55 }],
      ['RING.MOD', { ringModWaveform: 1, ringModHz: 950, ringModDepth: 0.6, mix: 0.7 }],
      ['DELAY', { delayTimeMs: 211, delayFeedback: 0.37, delayToneHz: 5_100, mix: 0.45 }],
      ['CHORUS', { chorusDelayMs: 15, chorusRateHz: 0.73, chorusDepthMs: 4, chorusVoices: 3, chorusFeedback: 0.1, chorusToneHz: 7_000, mix: 0.3 }],
      ['PREAMP', { preampModel: 2, preampGainPercent: 60, preampBassDb: 1, preampMiddleDb: -2, preampTrebleDb: 3, preampLevelDb: -1 }],
    ] as const;
    for (let index = 0; index < privateFx.length; index += 1) {
      const [type, parameters] = privateFx[index]!;
      if (!browserEngine.setTrackFxType(index + 1, 0, type)
        || !browserEngine.setTrackFxNamedParameters(index + 1, 0, { ...parameters })
        || !browserEngine.setTrackFxActive(index + 1, 0, true)) {
        throw new Error(`Could not configure Track ${index + 1} ${type} fixture`);
      }
    }
    browserEngine.setFxType('input', 0, 'RING.MOD');
    browserEngine.setFxNamedParameters('input', 0, { ringModWaveform: 1, ringModHz: 777, ringModDepth: 0.4, mix: 0.6 });
    browserEngine.setFxActive('input', 0, true);
    browserEngine.setFxType('track', 0, 'MANUAL PAN');
    browserEngine.setFxNamedParameters('track', 0, { manualPanPosition: 0.25, mix: 1 });
    browserEngine.setFxActive('track', 0, true);
    browserEngine.setFxType('track', 1, 'REVERB');
    browserEngine.setFxNamedParameters('track', 1, { decay: 0.5, mix: 0.3 });
    browserEngine.setFxActive('track', 1, true);
    const outputConfigured = await browserEngine.setOutputDspFx('phaser', {
      phaserRateHz: 0.82, phaserDepth: 0.45, phaserFeedback: 0.18, phaserStages: 6, mix: 0.35,
    }, true);
    if (!outputConfigured) throw new Error('Could not configure the persisted output-DSP fixture');
    const loopTransportConfigured = browserEngine.setLoopTransport(1, {
      mode: 'vinylFlick', beatOffsetBeats: 0, bpm: 120, crossfadeMs: 4,
      vinylSpeedPercent: 12, motorReturnSeconds: 0.7, brakePercent: 25, vinylMixPercent: 40,
    });
    if (!loopTransportConfigured) throw new Error('Could not configure the source-reader metadata fixture');
    const fxReadyDeadline = Date.now() + 15_000;
    while (Date.now() < fxReadyDeadline) {
      const perTrackReady = browserEngine.getTrackFxStatus().every((status: any) => status.slots[0]?.state === 'ready' && status.slots[0].active);
      const sharedReady = browserEngine.inputFxInstances[0]?.processorReady === true
        && browserEngine.trackFxInstances[0]?.processorReady === true;
      if (perTrackReady && sharedReady) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!browserEngine.getTrackFxStatus().every((status: any) => status.slots[0]?.state === 'ready' && status.slots[0].active)
      || !browserEngine.inputFxInstances[0]?.processorReady || !browserEngine.trackFxInstances[0]?.processorReady) {
      throw new Error(`Source FX fixture did not reach ready state: ${JSON.stringify({
        private: browserEngine.getTrackFxStatus().map((status: any) => status.slots[0]),
        input: browserEngine.inputFxInstances[0] && { ready: browserEngine.inputFxInstances[0].processorReady, error: browserEngine.inputFxInstances[0].error },
        shared: browserEngine.trackFxInstances[0] && { ready: browserEngine.trackFxInstances[0].processorReady, error: browserEngine.trackFxInstances[0].error },
      })}`);
    }

    const digestTracks = async () => Promise.all(tracks.map(async (track) => {
      const buffer = track.audioBuffer as AudioBuffer | null;
      if (!buffer) throw new Error('A seeded Browser loop disappeared');
      const interleaved = new Float32Array(buffer.length * buffer.numberOfChannels);
      for (let frame = 0; frame < buffer.length; frame += 1) {
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          interleaved[frame * buffer.numberOfChannels + channel] = buffer.getChannelData(channel)[frame]!;
        }
      }
      const digest = await crypto.subtle.digest('SHA-256', interleaved);
      return {
        frameCount: buffer.length,
        channels: buffer.numberOfChannels,
        sha256: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(''),
      };
    }));
    const beforePcm = await digestTracks();
    const beforeHistory = tracks.map((track, index) => engine.getTrackHistoryStatus(index + 1));
    const beforeTransport = {
      bpm: (await loadModule('/src/core/Transport.ts')).Transport.getInstance().bpm,
      timeSignature: [...(await loadModule('/src/core/Transport.ts')).Transport.getInstance().timeSignature],
      state: (await loadModule('/src/core/Transport.ts')).Transport.getInstance().state,
      masterTrackId: (await loadModule('/src/core/Transport.ts')).Transport.getInstance().masterTrackId,
      masterLoopLengthSamples: (await loadModule('/src/core/Transport.ts')).Transport.getInstance().masterLoopLengthSamples,
      measureLength: (await loadModule('/src/core/Transport.ts')).Transport.getInstance().measureLength,
      projectMutationRevision: (await loadModule('/src/core/Transport.ts')).Transport.getInstance().projectMutationRevision,
    };
    const mediaStream = (tracks[0]!.engine as any).currentMediaStream as MediaStream | null;
    const inputTracksBefore = mediaStream?.getAudioTracks().map((track) => track.readyState) ?? [];
    if (!inputTracksBefore.length || inputTracksBefore.some((state) => state !== 'live')) {
      throw new Error(`Expected the accepted test input stream to be live: ${inputTracksBefore.join(',')}`);
    }

    await context.suspend();
    const suspendedStatus = engine.getUiStatus();
    if (suspendedStatus.ready || !suspendedStatus.message.includes('SUSPENDED')) {
      throw new Error(`Suspended AudioContext was reported ready: ${JSON.stringify(suspendedStatus)}`);
    }
    await engine.resumeFromUserActivation();
    if (!engine.getUiStatus().ready) throw new Error('AudioContext did not become ready after an explicit resume');

    const closedStatePublished = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('AudioContext close statechange was not delivered')), 2_000);
      const listener = () => {
        if (context.state !== 'closed') return;
        window.clearTimeout(timeout);
        context.removeEventListener('statechange', listener);
        resolve();
      };
      context.addEventListener('statechange', listener);
    });
    await context.close();
    await closedStatePublished;
    if (context.state !== 'closed') throw new Error(`AudioContext close did not finish: ${context.state}`);
    const recovery = (tracks[0]!.engine as any).getRecoverySnapshot();
    if (recovery.schemaVersion !== 2 || recovery.source.contextState !== 'closed'
      || recovery.tracks.length !== 5 || recovery.fx.privateTracks.length !== 5
      || recovery.pcmHistoryBudget.retainedBytes <= 0
      || recovery.recoveryPolicy.playback !== 'start-stopped'
      || recovery.recoveryPolicy.input !== 'explicit-user-reconnect'
      || recovery.recoveryPolicy.dynamicDspState !== 'not-captured') {
      throw new Error(`Closed-context recovery snapshot was incomplete or unsafe: ${JSON.stringify({
        schemaVersion: recovery.schemaVersion, source: recovery.source, trackCount: recovery.tracks.length,
        privateBankCount: recovery.fx.privateTracks.length, pcmHistoryBudget: recovery.pcmHistoryBudget,
        recoveryPolicy: recovery.recoveryPolicy,
      })}`);
    }
    for (let index = 0; index < tracks.length; index += 1) {
      if (recovery.tracks[index]!.buffer !== tracks[index]!.audioBuffer
        || recovery.tracks[index]!.history.buffer === null
        || recovery.tracks[index]!.history.buffer !== seedBuffers[index]) {
        throw new Error(`Track ${index + 1} recovery snapshot did not retain live and undo PCM identities`);
      }
    }
    // Keep the immutable closed-context snapshot reachable for the explicit
    // user-gesture candidate-build check below. The builder must not mutate or
    // consume the source snapshot while preparing a replacement context.
    (window as any).__rc505ClosedRecoverySnapshot = recovery;
    const status = engine.getUiStatus();
    const inputTracksAfter = mediaStream?.getAudioTracks().map((track) => track.readyState) ?? [];
    const afterPcm = await digestTracks();
    const afterHistory = tracks.map((track, index) => engine.getTrackHistoryStatus(index + 1));
    const transport = (await loadModule('/src/core/Transport.ts')).Transport.getInstance();
    const afterTransport = {
      bpm: transport.bpm,
      timeSignature: [...transport.timeSignature],
      state: transport.state,
      masterTrackId: transport.masterTrackId,
      masterLoopLengthSamples: transport.masterLoopLengthSamples,
      measureLength: transport.measureLength,
      projectMutationRevision: transport.projectMutationRevision,
    };
    const archiveBytes = await engine.exportProjectArchive('closed-context-rescue');
    const projectArchive = await loadModule('/src/audio/projectArchive.ts');
    const decoded = await projectArchive.decodeProjectArchive(archiveBytes);

    let resumeError = '';
    try { await engine.resumeFromUserActivation(); }
    catch (error) { resumeError = error instanceof Error ? error.message : String(error); }
    let initError = '';
    try { await engine.init(); }
    catch (error) { initError = error instanceof Error ? error.message : String(error); }

    return {
      status,
      suspendedStatus,
      readyAfterRetry: engine.getUiStatus().ready,
      messageAfterRetry: engine.getUiStatus().message,
      resumeError,
      initError,
      beforePcm,
      afterPcm,
      recovery: {
        schemaVersion: recovery.schemaVersion,
        source: recovery.source,
        trackCount: recovery.tracks.length,
        historyBufferBytes: recovery.pcmHistoryBudget.retainedBytes,
        historyLimitBytes: recovery.pcmHistoryBudget.limitBytes,
        trackMixGainValue: recovery.trackMixGainValue,
        privateBankCount: recovery.fx.privateTracks.length,
        recoveryPolicy: recovery.recoveryPolicy,
      },
      beforeHistory,
      afterHistory,
      beforeTransport,
      afterTransport,
      inputTracksAfter,
      archiveBytes: archiveBytes.byteLength,
      archiveTracks: decoded.tracks.map((track: { frameCount: number; channels: number } | null) => track
        ? { frameCount: track.frameCount, channels: track.channels } : null),
    };
  });

  expect(result.status).toMatchObject({ ready: false, engineRunning: false, inputReady: false });
  expect(result.status.message).toContain('AUDIO CONTEXT CLOSED');
  expect(result.status.lastError).toContain('export them from Memory before reloading');
  expect(result.suspendedStatus.ready).toBe(false);
  expect(result.suspendedStatus.message).toContain('SUSPENDED');
  expect(result.readyAfterRetry).toBe(false);
  expect(result.messageAfterRetry).toContain('AUDIO CONTEXT CLOSED');
  expect(result.resumeError).toContain('permanently closed');
  expect(result.initError).toContain('permanently closed');
  expect(result.beforePcm).toEqual(result.afterPcm);
  expect(result.recovery).toMatchObject({
    schemaVersion: 2,
    source: { contextState: 'closed' },
    trackCount: 5,
    privateBankCount: 5,
    recoveryPolicy: { playback: 'start-stopped', monitoring: 'start-muted', input: 'explicit-user-reconnect', dynamicDspState: 'not-captured', effectTails: 'discarded' },
  });
  expect(result.recovery.historyBufferBytes).toBeGreaterThan(0);
  expect(result.beforeHistory).toEqual(result.afterHistory);
  expect(result.beforeTransport).toEqual(result.afterTransport);
  expect(result.inputTracksAfter.length).toBeGreaterThan(0);
  expect(result.inputTracksAfter.every((state: string) => state === 'ended')).toBe(true);
  expect(result.archiveBytes).toBeGreaterThan(0);
  expect(result.archiveTracks.map((track: { frameCount: number; channels: number } | null) => track && ({ frameCount: track.frameCount, channels: track.channels })))
    .toEqual(result.beforePcm.map(({ frameCount, channels }: { frameCount: number; channels: number }) => ({ frameCount, channels })));

  // Candidate AudioContext creation is initiated by a real trusted UI click.
  // The candidate remains silent and uninstalled, while every track's current
  // and undo PCM is cloned and verified before the old engine can be replaced.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.testid = 'build-recovery-candidate';
    button.textContent = 'Build recovery candidate';
    document.body.append(button);
    (window as any).__rc505CandidateBuildDone = new Promise<void>((resolve, reject) => {
      (window as any).__rc505ResolveCandidate = resolve;
      (window as any).__rc505RejectCandidate = reject;
    });
    button.addEventListener('click', async () => {
      try {
        const loadModule = (specifier: string) =>
          (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
        const { buildBrowserRecoveryCandidate } = await loadModule('/src/audio/BrowserRecoveryCandidate.ts');
        let microphoneRequests = 0;
        const mediaDevices = navigator.mediaDevices;
        const originalGetUserMedia = mediaDevices.getUserMedia;
        mediaDevices.getUserMedia = ((...args: Parameters<MediaDevices['getUserMedia']>) => {
          microphoneRequests += 1;
          return Reflect.apply(originalGetUserMedia, mediaDevices, args);
        }) as MediaDevices['getUserMedia'];
        try {
          const candidate = await buildBrowserRecoveryCandidate(
            (window as any).__rc505ClosedRecoverySnapshot,
            undefined,
            { restoreAllPersistedFxGraph: true },
          );
          (window as any).__rc505Candidate = candidate;
          const digest = async (buffer: AudioBuffer | null) => {
            if (!buffer) return null;
            const interleaved = new Float32Array(buffer.length * buffer.numberOfChannels);
            for (let frame = 0; frame < buffer.length; frame += 1) {
              for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
                interleaved[frame * buffer.numberOfChannels + channel] = buffer.getChannelData(channel)[frame]!;
              }
            }
            const bytes = await crypto.subtle.digest('SHA-256', interleaved);
            return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
          };
          const original = (window as any).__rc505ClosedRecoverySnapshot;
          const transport = (await loadModule('/src/core/Transport.ts')).Transport.getInstance();
          const bpmListenersBefore = ((transport as any).listeners.get('bpm-change') ?? []).length;
          let legacySchemaFactoryCalls = 0;
          let legacySchemaError = '';
          try {
            await buildBrowserRecoveryCandidate({ ...original, schemaVersion: 1 }, () => {
              legacySchemaFactoryCalls += 1;
              return new AudioContext({ sampleRate: original.source.sampleRate });
            });
          } catch (error) { legacySchemaError = error instanceof Error ? error.message : String(error); }
          const summary = {
            phase: candidate.phase,
            state: candidate.context.state,
            sampleRate: candidate.context.sampleRate,
            silentGain: candidate.silentSink.gain.value,
            estimatedPeakPcmBytes: candidate.estimatedPeakPcmBytes,
            estimatedPeakKnownPayloadBytes: candidate.estimatedPeakKnownPayloadBytes,
            fxPlan: candidate.fxGraph?.plan ?? null,
            runtime: {
              phase: candidate.preparedRuntime.phase,
              tracks: candidate.preparedRuntime.tracks.map((track: any) => ({
                trackId: track.trackId,
                pitchMode: track.pitch.mode,
                pitch: track.pitch,
                hasLiveMonoNode: Boolean(track.liveMonoNode),
                hasLivePolyNode: Boolean(track.livePolyNode),
                pitchLatencySamples: track.pitchLatencySamples,
                sourceTransport: track.sourceTransport,
                livePolyHeapBytes: track.livePolyNode?.wasmHeapBytes ?? 0,
              })),
              rhythmRunning: candidate.preparedRuntime.rhythmEngine.isRunning,
              rhythmSnapshot: candidate.preparedRuntime.rhythmEngine.getRecoverySnapshot(),
              rhythmWorkletCreated: Boolean((candidate.preparedRuntime.rhythmEngine as any).workletNode),
              bpmListenersBefore,
              bpmListenersAfter: ((transport as any).listeners.get('bpm-change') ?? []).length,
            },
            legacySchemaFactoryCalls,
            legacySchemaError,
            rebuiltFx: candidate.fxGraph ? {
              privateTracks: candidate.fxGraph.privateTrackBanks.map((bank) => bank.getRecoverySnapshot()),
              statuses: candidate.fxGraph.getStatuses(),
              input: candidate.fxGraph.inputBank?.getRecoverySnapshot() ?? null,
              sharedTrack: candidate.fxGraph.sharedTrackBank?.getRecoverySnapshot() ?? null,
              sharedStatuses: candidate.fxGraph.getSharedStatuses(),
              outputDsp: candidate.fxGraph.outputDsp ? {
                algorithm: candidate.fxGraph.outputDsp.algorithm,
                parameters: candidate.fxGraph.outputDsp.parameters,
                enabled: candidate.fxGraph.outputDsp.enabled,
                state: candidate.fxGraph.outputDsp.state,
              } : null,
              metadataOnly: candidate.fxGraph.metadataOnly,
            } : null,
            microphoneRequests,
            tracks: await Promise.all(candidate.snapshot.tracks.map(async (track: any) => ({
              trackId: track.trackId,
              state: track.state,
              wasPlaying: track.wasPlaying,
              current: await digest(track.buffer),
              history: await digest(track.history.buffer),
              sourceCurrent: await digest(original.tracks[track.trackId - 1].buffer),
              sourceHistory: await digest(original.tracks[track.trackId - 1].history.buffer),
              sourceSettings: original.tracks[track.trackId - 1].settings,
              settings: track.settings,
              historyDirection: track.history.direction,
              sourceHistoryDirection: original.tracks[track.trackId - 1].history.direction,
              historyUnavailableReason: track.history.unavailableReason,
              sourceHistoryUnavailableReason: original.tracks[track.trackId - 1].history.unavailableReason,
              pitch: track.pitch,
              sourcePitch: original.tracks[track.trackId - 1].pitch,
            }))),
            transport: candidate.snapshot.transport,
            sourceTransport: original.transport,
            rhythm: candidate.snapshot.rhythm,
            sourceRhythm: original.rhythm,
            fx: JSON.stringify(candidate.snapshot.fx),
            sourceFx: JSON.stringify(original.fx),
            sourceOverrides: JSON.stringify(candidate.snapshot.fx.sourceOverrides),
            originalOverrides: JSON.stringify(original.fx.sourceOverrides),
            midi: candidate.snapshot.midi,
            sourceMidi: original.midi,
            monitoringWasEnabled: candidate.snapshot.monitoringWasEnabled,
            outputGainValue: candidate.snapshot.outputGainValue,
            trackMixGainValue: candidate.snapshot.trackMixGainValue,
            sourceTrackMixGainValue: original.trackMixGainValue,
            sourceInputPreference: candidate.snapshot.source.inputDevicePreference,
            sourceOutputPreference: candidate.snapshot.source.outputDevicePreference,
          };
          (window as any).__rc505CandidateSummary = summary;
          (window as any).__rc505ResolveCandidate();
        } finally {
          mediaDevices.getUserMedia = originalGetUserMedia;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        (window as any).__rc505RejectCandidate(`${detail}; saved FX=${JSON.stringify((window as any).__rc505ClosedRecoverySnapshot?.fx)}`);
      }
    });
  });
  await page.getByTestId('build-recovery-candidate').click();
  await page.evaluate(async () => await (window as any).__rc505CandidateBuildDone);
  const candidateResult = await page.evaluate(() => (window as any).__rc505CandidateSummary);
  expect(candidateResult).toMatchObject({
    phase: 'runtime-prepared-not-installed',
    state: 'suspended',
    sampleRate: result.recovery.source.sampleRate,
    silentGain: 0,
    microphoneRequests: 0,
    transport: { state: 'STOPPED', bpm: candidateResult.sourceTransport.bpm,
      timeSignature: candidateResult.sourceTransport.timeSignature,
      masterTrackId: candidateResult.sourceTransport.masterTrackId,
      masterLoopLengthSamples: candidateResult.sourceTransport.masterLoopLengthSamples,
      measureLength: candidateResult.sourceTransport.measureLength,
      projectMutationRevision: candidateResult.sourceTransport.projectMutationRevision },
    rhythm: { wasRunning: false, patternIndex: candidateResult.sourceRhythm.patternIndex,
      kitIndex: candidateResult.sourceRhythm.kitIndex, section: candidateResult.sourceRhythm.section,
      variation: candidateResult.sourceRhythm.variation, swingPercent: candidateResult.sourceRhythm.swingPercent,
      quantizeGrid: candidateResult.sourceRhythm.quantizeGrid, volumePercent: candidateResult.sourceRhythm.volumePercent,
      error: candidateResult.sourceRhythm.error },
    fx: candidateResult.sourceFx,
    midi: { sourceInputState: 'disconnected', target: candidateResult.sourceMidi.target },
    monitoringWasEnabled: false,
    outputGainValue: 0,
    trackMixGainValue: candidateResult.sourceTrackMixGainValue,
    sourceInputPreference: result.recovery.source.inputDevicePreference,
    sourceOutputPreference: result.recovery.source.outputDevicePreference,
  });
  expect(candidateResult.fxPlan).toMatchObject({
    estimatedCandidatePcmBytes: candidateResult.estimatedPeakPcmBytes / 2,
    estimatedKnownPeakBytes: candidateResult.estimatedPeakKnownPayloadBytes,
    hasUnboundedBrowserOverhead: true,
  });
  expect(candidateResult.runtime).toMatchObject({
    phase: 'prepared-not-installed',
    rhythmRunning: false,
    rhythmWorkletCreated: false,
    bpmListenersAfter: candidateResult.runtime.bpmListenersBefore,
  });
  expect(candidateResult.legacySchemaFactoryCalls).toBe(0);
  expect(candidateResult.legacySchemaError).toContain('version-2 snapshot');
  expect(candidateResult.runtime.tracks.map((track: any) => ({
    trackId: track.trackId,
    pitchMode: track.pitchMode,
    hasLiveMonoNode: track.hasLiveMonoNode,
    hasLivePolyNode: track.hasLivePolyNode,
  }))).toEqual([
    { trackId: 1, pitchMode: 'LIVE_MONO', hasLiveMonoNode: true, hasLivePolyNode: false },
    { trackId: 2, pitchMode: 'LIVE_POLY', hasLiveMonoNode: false, hasLivePolyNode: true },
    { trackId: 3, pitchMode: 'LIVE_POLY', hasLiveMonoNode: false, hasLivePolyNode: true },
    { trackId: 4, pitchMode: 'LIVE_POLY', hasLiveMonoNode: false, hasLivePolyNode: true },
    { trackId: 5, pitchMode: 'LIVE_POLY', hasLiveMonoNode: false, hasLivePolyNode: true },
  ]);
  expect(candidateResult.runtime.tracks[0].pitchLatencySamples).toBeGreaterThan(0);
  expect(candidateResult.runtime.tracks[0].pitch).toMatchObject({
    mode: 'LIVE_MONO', liveMono: { semitones: -3, minimumFrequencyHz: 65, maximumFrequencyHz: 1_050 },
  });
  expect(candidateResult.runtime.tracks.slice(1).every((track: any) => track.pitchLatencySamples > 0 && track.livePolyHeapBytes > 0)).toBe(true);
  expect(candidateResult.runtime.tracks.slice(1).map((track: any) => track.pitch.livePoly))
    .toEqual(candidateResult.tracks.slice(1).map((track: any) => track.sourcePitch.livePoly));
  expect(candidateResult.runtime.tracks.slice(1).map((track: any) => track.pitch.livePoly.semitones)).toEqual([-1, 0, 1, 2]);
  candidateResult.runtime.tracks.slice(1).forEach((track: any, index: number) => {
    expect(track.pitch.livePoly.playbackRate).toBeCloseTo(0.92 + index * 0.02, 12);
    expect(track.pitch.livePoly.tonalityLimitHz).toBe(7_500);
  });
  expect(candidateResult.fxPlan).toMatchObject({
    livePolyPitchProcessorCount: 4,
    estimatedLivePolyWasmBytes: 16 * 1024 * 1024,
  });
  const originalFxSnapshot = JSON.parse(candidateResult.sourceFx);
  expect(candidateResult.rebuiltFx.privateTracks).toEqual(originalFxSnapshot.privateTracks);
  expect(candidateResult.rebuiltFx.input).toEqual(originalFxSnapshot.input);
  expect(candidateResult.rebuiltFx.sharedTrack).toEqual(originalFxSnapshot.sharedTrack);
  expect(candidateResult.rebuiltFx.input[0]).toMatchObject({
    type: 'RING.MOD', active: true, state: 'ready',
    parameters: { ringModWaveform: 1, ringModHz: 777, ringModDepth: 0.4, mix: 0.6 },
  });
  expect(candidateResult.rebuiltFx.sharedTrack[0]).toMatchObject({
    type: 'MANUAL PAN', active: true, state: 'ready', parameters: { manualPanPosition: 0.25, mix: 1 },
  });
  expect(candidateResult.rebuiltFx.sharedTrack[1]).toMatchObject({
    type: 'REVERB', active: true, state: 'ready', parameters: { decay: 0.5, mix: 0.3 },
  });
  expect(candidateResult.rebuiltFx.sharedStatuses.input).toHaveLength(4);
  expect(candidateResult.rebuiltFx.sharedStatuses.input[0]).toMatchObject({
    slot: 'A', type: 'RING.MOD', active: true, state: 'ready', recoveryMode: 'worklet-chain',
  });
  expect(candidateResult.rebuiltFx.sharedStatuses.sharedTrack).toHaveLength(4);
  expect(candidateResult.rebuiltFx.sharedStatuses.sharedTrack[0]).toMatchObject({
    slot: 'A', type: 'MANUAL PAN', active: true, state: 'ready', recoveryMode: 'worklet-chain',
  });
  expect(candidateResult.rebuiltFx.sharedStatuses.sharedTrack[1]).toMatchObject({
    slot: 'B', type: 'REVERB', active: true, state: 'ready', recoveryMode: 'audio-node',
  });
  expect(candidateResult.rebuiltFx.outputDsp).toMatchObject({
    algorithm: 'phaser',
    parameters: { phaserRateHz: 0.82, phaserDepth: 0.45, phaserFeedback: 0.18, phaserStages: 6, mix: 0.35 },
    enabled: true,
    state: 'ready',
  });
  expect(candidateResult.rebuiltFx.metadataOnly).toMatchObject({
    rhythm: candidateResult.sourceRhythm,
    midiTarget: candidateResult.sourceMidi.target,
    midiInputState: 'disconnected',
  });
  expect(candidateResult.rebuiltFx.metadataOnly.sourceReaderOverrides).toEqual(originalFxSnapshot.sourceOverrides);
  expect(candidateResult.rebuiltFx.metadataOnly.sourceReaderOverrides).toEqual([
    { trackId: 1, config: {
      mode: 'vinylFlick', beatOffsetBeats: 0, bpm: 120, crossfadeMs: 4,
      vinylSpeedPercent: 12, motorReturnSeconds: 0.7, brakePercent: 25, vinylMixPercent: 40,
    } },
  ]);
  expect(candidateResult.rebuiltFx.statuses).toHaveLength(5);
  for (const status of candidateResult.rebuiltFx.statuses) {
    expect(status.slots[0]).toMatchObject({ state: 'ready', active: true, bypassed: false });
    expect(status.slots.slice(1).every((slot: { state: string }) => slot.state === 'empty')).toBe(true);
  }
  expect(candidateResult.estimatedPeakPcmBytes).toBeGreaterThan(0);
  expect(candidateResult.tracks).toHaveLength(5);
  for (const track of candidateResult.tracks) {
    expect(track.state).toBe('STOPPED');
    expect(track.wasPlaying).toBe(false);
    expect(track.current).toBe(track.sourceCurrent);
    expect(track.history).toBe(track.sourceHistory);
    expect(track.settings).toEqual(track.sourceSettings);
    expect(track.pitch).toEqual(track.sourcePitch);
    expect(track.historyDirection).toBe(track.sourceHistoryDirection);
    expect(track.historyUnavailableReason).toBe(track.sourceHistoryUnavailableReason);
  }
  expect(candidateResult.sourceOverrides).toBe(candidateResult.originalOverrides);
  expect(candidateResult.runtime.tracks[0].sourceTransport[0]).toMatchObject({
    type: 'VINYL FLICK', vinylFlickSpeed: 12, vinylFlickMix: 0.4,
    vinylFlickReturnTimeSeconds: 0.7, vinylFlickBrakePercent: 25,
  });
  const transferResult = await page.evaluate(async () => {
    const candidate = (window as any).__rc505Candidate;
    const runtime = candidate.takeRuntime();
    let duplicateTransferError = '';
    try { candidate.takeRuntime(); } catch (error) { duplicateTransferError = error instanceof Error ? error.message : String(error); }
    await candidate.dispose();
    const candidateDisposePreservedTransferredContext = runtime.context.state === 'suspended';
    await runtime.dispose();
    return { duplicateTransferError, candidateDisposePreservedTransferredContext, runtimeContextState: runtime.context.state };
  });
  expect(transferResult.duplicateTransferError).toContain('transferred once');
  expect(transferResult.candidateDisposePreservedTransferredContext).toBe(true);
  expect(transferResult.runtimeContextState).toBe('closed');
  await expect.poll(() => page.evaluate(() => (window as any).__rc505Candidate.context.state)).toBe('closed');

  // Inject a partial allocation failure. The unpublished candidate context is
  // closed, and the original closed engine remains exportable with exact PCM.
  const rollbackResult = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const [{ buildBrowserRecoveryCandidate }, { AudioEngine }] = await Promise.all([
      loadModule('/src/audio/BrowserRecoveryCandidate.ts'), loadModule('/src/audio/AudioEngine.ts'),
    ]);
    const engine = AudioEngine.getInstance();
    const sourceSnapshot = (window as any).__rc505ClosedRecoverySnapshot;
    let allocated = 0;
    let failedContext: AudioContext | null = null;
    let failure = '';
    try {
      await buildBrowserRecoveryCandidate(sourceSnapshot, (options: AudioContextOptions) => {
        const context = new AudioContext(options);
        failedContext = context;
        return new Proxy(context, {
          get(target, property) {
            if (property === 'createBuffer') return (channels: number, frames: number, sampleRate: number) => {
              allocated += 1;
              if (allocated === 3) throw new Error('injected candidate allocation failure');
              return target.createBuffer(channels, frames, sampleRate);
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as AudioContext;
      });
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    let failedWorkletContext: AudioContext | null = null;
    let workletFailure = '';
    try {
      await buildBrowserRecoveryCandidate(sourceSnapshot, (options: AudioContextOptions) => {
        const context = new AudioContext(options);
        failedWorkletContext = context;
        return context;
      }, {
        restorePrivateTrackFxGraph: true,
        loadFxWorkletModule: async () => { throw new Error('injected recovery FX worklet module failure'); },
      });
    } catch (error) { workletFailure = error instanceof Error ? error.message : String(error); }
    const archiveBytes = await engine.exportProjectArchive('candidate-rollback-check');
    const archive = await (await loadModule('/src/audio/projectArchive.ts')).decodeProjectArchive(archiveBytes);
    const browserEngine = (engine.tracks[0] as any).engine;
    const afterFailureSnapshot = browserEngine.getRecoverySnapshot();
    const transport = (await loadModule('/src/core/Transport.ts')).Transport.getInstance();
    const digestPcm = async (pcm: Float32Array | null) => {
      if (!pcm) return null;
      const bytes = await crypto.subtle.digest('SHA-256', pcm);
      return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
    };
    const actualCurrentHashes = await Promise.all(archive.tracks.map((track: any) => digestPcm(track?.pcm ?? null)));
    const actualHistoryHashes = await Promise.all(sourceSnapshot.tracks.map((track: any) => digestPcm(
      track.history.buffer ? (() => {
        const pcm = new Float32Array(track.history.buffer.length * track.history.buffer.numberOfChannels);
        for (let frame = 0; frame < track.history.buffer.length; frame += 1) {
          for (let channel = 0; channel < track.history.buffer.numberOfChannels; channel += 1) {
            pcm[frame * track.history.buffer.numberOfChannels + channel] = track.history.buffer.getChannelData(channel)[frame]!;
          }
        }
        return pcm;
      })() : null,
    )));
    return {
      failure,
      allocated,
      candidateContextState: failedContext?.state ?? 'missing',
      workletFailure,
      failedWorkletContextState: failedWorkletContext?.state ?? 'missing',
      sourceBuffersSame: sourceSnapshot.tracks.every((track: any, index: number) =>
        track.buffer === (engine.tracks[index] as any).audioBuffer),
      archiveBytes: archiveBytes.byteLength,
      archiveTracks: archive.tracks.map((track: any) => track ? { frameCount: track.frameCount, channels: track.channels } : null),
      actualCurrentHashes,
      actualHistoryHashes,
      historyStatuses: engine.tracks.map((_: unknown, index: number) => engine.getTrackHistoryStatus(index + 1)),
      retainedHistoryBytes: afterFailureSnapshot.pcmHistoryBudget.retainedBytes,
      fxUnchanged: JSON.stringify(afterFailureSnapshot.fx) === JSON.stringify(sourceSnapshot.fx),
      transportUnchanged: afterFailureSnapshot.transport.bpm === sourceSnapshot.transport.bpm
        && afterFailureSnapshot.transport.masterTrackId === sourceSnapshot.transport.masterTrackId
        && afterFailureSnapshot.transport.masterLoopLengthSamples === sourceSnapshot.transport.masterLoopLengthSamples
        && afterFailureSnapshot.transport.measureLength === sourceSnapshot.transport.measureLength
        && afterFailureSnapshot.transport.projectMutationRevision === sourceSnapshot.transport.projectMutationRevision
        && transport.bpm === sourceSnapshot.transport.bpm
        && transport.masterTrackId === sourceSnapshot.transport.masterTrackId,
    };
  });
  expect(rollbackResult.failure).toContain('injected candidate allocation failure');
  expect(rollbackResult.allocated).toBe(3);
  expect(rollbackResult.candidateContextState).toBe('closed');
  expect(rollbackResult.workletFailure).toContain('injected recovery FX worklet module failure');
  expect(rollbackResult.failedWorkletContextState).toBe('closed');
  expect(rollbackResult.sourceBuffersSame).toBe(true);
  expect(rollbackResult.archiveBytes).toBeGreaterThan(0);
  expect(rollbackResult.archiveTracks.map((track: { frameCount: number; channels: number } | null) => track && ({ frameCount: track.frameCount, channels: track.channels })))
    .toEqual(result.beforePcm.map(({ frameCount, channels }: { frameCount: number; channels: number }) => ({ frameCount, channels })));
  expect(rollbackResult.actualCurrentHashes).toEqual(result.beforePcm.map(({ sha256 }: { sha256: string }) => sha256));
  expect(rollbackResult.actualHistoryHashes).toEqual(candidateResult.tracks.map((track: any) => track.sourceHistory));
  expect(rollbackResult.historyStatuses).toEqual(result.beforeHistory);
  expect(rollbackResult.retainedHistoryBytes).toBe(result.recovery.historyBufferBytes);
  expect(rollbackResult.fxUnchanged).toBe(true);
  expect(rollbackResult.transportUnchanged).toBe(true);

  // A user can reach the Memory screen and export the surviving PCM even though
  // transport is unavailable. This avoids making reload the only recovery path.
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(lcdScreen(page)).toBeVisible();
  await activateLcdAction(page, 'memory-save');
  const exportAction = await findLcdField(page, 'memory-export-file');
  await expect(exportAction.locator('button')).toBeEnabled();
  const loadAction = await findLcdField(page, 'memory-load-slot');
  await expect(loadAction.locator('button')).toBeDisabled();
  const importAction = await findLcdField(page, 'memory-import-file');
  await expect(importAction.locator('button')).toBeDisabled();
  await page.evaluate(() => { window.prompt = () => 'closed-context-rescue'; });
  const downloadPromise = page.waitForEvent('download');
  await activateLcdAction(page, 'memory-export-file');
  const download = await downloadPromise;
  const path = await download.path();
  expect(download.suggestedFilename()).toBe('closed-context-rescue.rc505proj');
  expect(path).not.toBeNull();
  expect((await fs.stat(path!)).size).toBeGreaterThan(0);

  // Exercise the app's production recovery route. First inject failure while
  // the real replacement BrowserAudioEngine builds its persisted FX graph;
  // this must leave the old closed engine and all exportable PCM/history in
  // place. Then retry without the fault and verify the actual engine swap.
  const failureSetup = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const { AudioEngine } = await loadModule('/src/audio/AudioEngine.ts');
    const facade = AudioEngine.getInstance();
    const oldEngine = (facade.tracks[0] as any).engine;
    if (oldEngine.context.state !== 'closed') throw new Error('Expected the prior Browser context to remain closed before production recovery.');
    const originalNode = window.AudioWorkletNode;
    let candidateContext: AudioContext | null = null;
    let injected = false;
    let microphoneRequests = 0;
    const mediaDevices = navigator.mediaDevices;
    const originalGetUserMedia = mediaDevices.getUserMedia;
    mediaDevices.getUserMedia = ((...args: Parameters<MediaDevices['getUserMedia']>) => {
      microphoneRequests += 1;
      return Reflect.apply(originalGetUserMedia, mediaDevices, args);
    }) as MediaDevices['getUserMedia'];
    window.AudioWorkletNode = new Proxy(originalNode, {
      construct(target, args) {
        const context = args[0] as AudioContext;
        if (context !== oldEngine.context && !injected) {
          candidateContext = context;
          injected = true;
          throw new Error('injected production recovery worklet failure');
        }
        return Reflect.construct(target, args);
      },
    });
    (window as any).__rc505RecoveryFailureProbe = {
      facade, oldEngine, originalNode, originalGetUserMedia, mediaDevices,
      get candidateContext() { return candidateContext; },
      get microphoneRequests() { return microphoneRequests; },
      get injected() { return injected; },
    };
    return { oldContextState: oldEngine.context.state, injected };
  });
  expect(failureSetup).toEqual({ oldContextState: 'closed', injected: false });
  await page.getByTestId('start-audio').click();
  await expect(page.getByRole('alert')).toContainText('injected production recovery worklet failure');
  const failedProductionRecovery = await page.evaluate(async () => {
    const probe = (window as any).__rc505RecoveryFailureProbe;
    window.AudioWorkletNode = probe.originalNode;
    probe.mediaDevices.getUserMedia = probe.originalGetUserMedia;
    const facade = probe.facade;
    const tracks = facade.tracks as any[];
    const digest = async (buffer: AudioBuffer | null) => {
      if (!buffer) return null;
      const interleaved = new Float32Array(buffer.length * buffer.numberOfChannels);
      for (let frame = 0; frame < buffer.length; frame += 1) {
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          interleaved[frame * buffer.numberOfChannels + channel] = buffer.getChannelData(channel)[frame]!;
        }
      }
      const bytes = await crypto.subtle.digest('SHA-256', interleaved);
      return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
    };
    const oldTracks = probe.oldEngine.tracks as any[];
    return {
      stillOldEngine: tracks[0]?.engine === probe.oldEngine,
      oldContextState: probe.oldEngine.context.state,
      candidateContextState: probe.candidateContext?.state ?? 'not-created',
      injected: probe.injected,
      microphoneRequests: probe.microphoneRequests,
      outputLevel: facade.getOutputLevel(),
      pcm: await Promise.all(oldTracks.map((track) => digest(track.audioBuffer))),
      history: await Promise.all(oldTracks.map((track) => digest(track.pcmHistory?.snapshot?.buffer ?? null))),
      historyStatus: oldTracks.map((_: unknown, index: number) => facade.getTrackHistoryStatus(index + 1)),
      archiveBytes: (await facade.exportProjectArchive('failed-production-recovery')).byteLength,
    };
  });
  expect(failedProductionRecovery).toMatchObject({
    stillOldEngine: true,
    oldContextState: 'closed',
    candidateContextState: 'closed',
    injected: true,
    microphoneRequests: 0,
    outputLevel: 37,
  });
  expect(failedProductionRecovery.pcm).toEqual(result.beforePcm.map(({ sha256 }: { sha256: string }) => sha256));
  expect(failedProductionRecovery.history).toEqual(candidateResult.tracks.map((track: any) => track.sourceHistory));
  expect(failedProductionRecovery.historyStatus).toEqual(result.beforeHistory);
  expect(failedProductionRecovery.archiveBytes).toBeGreaterThan(0);

  await page.getByTestId('start-audio').click();
  await expect(page.getByTestId('recovery-awaiting-resume')).toBeVisible({ timeout: 20_000 });
  const adoptedRecovery = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const { AudioEngine } = await loadModule('/src/audio/AudioEngine.ts');
    const { Transport } = await loadModule('/src/core/Transport.ts');
    const facade = AudioEngine.getInstance();
    const tracks = facade.tracks as any[];
    const browser = tracks[0]!.engine as any;
    const sourceSnapshot = (window as any).__rc505ClosedRecoverySnapshot;
    if (browser.context.state !== 'suspended' || browser.masterGainNode.gain.value !== 0
      || browser.monitorGainNode.gain.value !== 0 || browser.currentInputStream || browser.currentMediaStream) {
      throw new Error(`Recovered Browser graph was not safely suspended, muted, and input-disconnected: ${JSON.stringify({
        state: browser.context.state, masterGain: browser.masterGainNode.gain.value,
        monitorGain: browser.monitorGainNode.gain.value, currentInputStream: Boolean(browser.currentInputStream),
        currentMediaStream: Boolean(browser.currentMediaStream),
      })}`);
    }
    const digest = async (buffer: AudioBuffer | null) => {
      if (!buffer) return null;
      const interleaved = new Float32Array(buffer.length * buffer.numberOfChannels);
      for (let frame = 0; frame < buffer.length; frame += 1) {
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          interleaved[frame * buffer.numberOfChannels + channel] = buffer.getChannelData(channel)[frame]!;
        }
      }
      const bytes = await crypto.subtle.digest('SHA-256', interleaved);
      return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
    };
    const history = await Promise.all(tracks.map((track) => digest(track.pcmHistory?.snapshot?.buffer ?? null)));
    const pcm = await Promise.all(tracks.map((track) => digest(track.audioBuffer)));
    return {
      isNewEngine: browser !== (window as any).__rc505RecoveryFailureProbe.oldEngine,
      contextState: browser.context.state,
      sourceContextState: sourceSnapshot.source.contextState,
      outputGain: browser.masterGainNode.gain.value,
      outputLevel: facade.getOutputLevel(),
      trackMixGain: browser.trackMixNode.gain.value,
      monitorGain: browser.monitorGainNode.gain.value,
      inputReady: facade.getUiStatus().inputReady,
      awaitingResume: facade.getUiStatus().recoveryAwaitingUserResume,
      midiState: facade.getMidiInputState(),
      trackStates: tracks.map((track) => track.state),
      pcm,
      history,
      historyStatus: tracks.map((_: unknown, index: number) => facade.getTrackHistoryStatus(index + 1)),
      privateFx: browser.getTrackFxStatus().map((bank: any) => bank.slots.map((slot: any) => ({
        type: slot.type, active: slot.active, state: slot.state,
      }))),
      inputFx: browser.getSharedFxRecoverySnapshot('input'),
      trackFx: browser.getSharedFxRecoverySnapshot('track'),
      outputDsp: {
        algorithm: browser.outputDspAlgorithmValue,
        parameters: browser.outputDspParametersValue,
        enabled: browser.outputDspEnabledValue,
      },
      rhythm: browser.rhythmEngine.getRecoverySnapshot(),
      sourceOverrides: Array.from(browser.trackLoopTransportOverrides.entries()),
      pitchModes: tracks.map((track) => track.getRecoverySnapshot().pitch.mode),
      historyBudget: {
        retainedBytes: tracks[0]!.historyTotalRetainedBytes,
        limitBytes: tracks[0]!.historyBudgetBytes,
      },
      transport: {
        bpm: Transport.getInstance().bpm,
        timeSignature: [...Transport.getInstance().timeSignature],
        state: Transport.getInstance().state,
        masterTrackId: Transport.getInstance().masterTrackId,
        masterLoopLengthSamples: Transport.getInstance().masterLoopLengthSamples,
        measureLength: Transport.getInstance().measureLength,
        projectMutationRevision: Transport.getInstance().projectMutationRevision,
      },
      oldTracksStillExportable: (window as any).__rc505RecoveryFailureProbe.oldEngine.tracks.length === 5
        && (await facade.exportProjectArchive('adopted-recovery')).byteLength > 0,
      selectedOutputDeviceId: browser.selectedOutputDeviceId,
    };
  });
  expect(adoptedRecovery).toMatchObject({
    isNewEngine: true,
    contextState: 'suspended',
    sourceContextState: 'closed',
    outputGain: 0,
    monitorGain: 0,
    inputReady: false,
    awaitingResume: true,
    midiState: 'disconnected',
    trackStates: ['STOPPED', 'STOPPED', 'STOPPED', 'STOPPED', 'STOPPED'],
    pitchModes: ['LIVE_MONO', 'LIVE_POLY', 'LIVE_POLY', 'LIVE_POLY', 'LIVE_POLY'],
  });
  expect(adoptedRecovery.outputLevel).toBeCloseTo(37, 4);
  expect(adoptedRecovery.trackMixGain).toBeCloseTo(result.recovery.trackMixGainValue, 6);
  expect(adoptedRecovery.pcm).toEqual(result.beforePcm.map(({ sha256 }: { sha256: string }) => sha256));
  expect(adoptedRecovery.history).toEqual(candidateResult.tracks.map((track: any) => track.sourceHistory));
  expect(adoptedRecovery.historyStatus).toEqual(result.beforeHistory);
  expect(adoptedRecovery.historyBudget).toEqual({
    retainedBytes: result.recovery.historyBufferBytes,
    limitBytes: result.recovery.historyLimitBytes,
  });
  expect(adoptedRecovery.transport).toEqual(result.beforeTransport);
  expect(adoptedRecovery.selectedOutputDeviceId).toBe('recovery-output-device');
  expect(adoptedRecovery.privateFx[0][0]).toMatchObject({ type: 'DSP HPF', active: true, state: 'ready' });
  expect(adoptedRecovery.privateFx[1][0]).toMatchObject({ type: 'RING.MOD', active: true, state: 'ready' });
  expect(adoptedRecovery.inputFx[0]).toMatchObject({
    type: 'RING.MOD', active: true, state: 'ready',
    parameters: { ringModWaveform: 1, ringModHz: 777, ringModDepth: 0.4, mix: 0.6 },
  });
  expect(adoptedRecovery.trackFx[0]).toMatchObject({
    type: 'MANUAL PAN', active: true, state: 'ready', parameters: { manualPanPosition: 0.25, mix: 1 },
  });
  expect(adoptedRecovery.outputDsp).toMatchObject({ algorithm: 'phaser', enabled: true });
  expect(adoptedRecovery.sourceOverrides).toEqual([[1, {
    mode: 'vinylFlick', beatOffsetBeats: 0, bpm: 120, crossfadeMs: 4,
    vinylSpeedPercent: 12, motorReturnSeconds: 0.7, brakePercent: 25, vinylMixPercent: 40,
  }]]);
  expect(adoptedRecovery.oldTracksStillExportable).toBe(true);

  // A second trusted click resumes the recovered output only. Input capture
  // remains disconnected until the separate input action is requested.
  await page.evaluate(() => {
    const probe = (window as any).__rc505RecoveryFailureProbe;
    const browser = (probe.facade.tracks[0] as any).engine;
    Object.defineProperty(browser.context, 'setSinkId', {
      configurable: true,
      value: async (deviceId: string) => { (window as any).__rc505RecoveredSinkId = deviceId; },
    });
    const originalLoad = browser.loadAudioWorkletModule;
    let injectOutputFailure = true;
    browser.loadAudioWorkletModule = async function (moduleUrl: string) {
      if (injectOutputFailure && moduleUrl === '/worklets/looper-processor.js') {
        injectOutputFailure = false;
        throw new Error('injected recovered output worklet setup failure');
      }
      return originalLoad.call(this, moduleUrl);
    };
    let midiConnectCalls = 0;
    const originalConnectMidi = browser.connectMidiInput.bind(browser);
    browser.connectMidiInput = (...args: unknown[]) => {
      midiConnectCalls += 1;
      return originalConnectMidi(...args);
    };
    probe.outputRetry = {
      get midiConnectCalls() { return midiConnectCalls; },
    };
  });
  await page.getByTestId('start-audio').click();
  await expect(page.getByRole('alert')).toContainText('injected recovered output worklet setup failure');
  await expect(page.getByTestId('recovery-awaiting-resume')).toBeVisible();
  await expect(page.getByTestId('start-audio')).toHaveText('RESUME RECOVERED AUDIO');
  const partialOutputRecovery = await page.evaluate(async () => {
    const probe = (window as any).__rc505RecoveryFailureProbe;
    const facade = probe.facade;
    const browser = (facade.tracks[0] as any).engine;
    const digest = async (buffer: AudioBuffer | null) => {
      if (!buffer) return null;
      const interleaved = new Float32Array(buffer.length * buffer.numberOfChannels);
      for (let frame = 0; frame < buffer.length; frame += 1) {
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          interleaved[frame * buffer.numberOfChannels + channel] = buffer.getChannelData(channel)[frame]!;
        }
      }
      const bytes = await crypto.subtle.digest('SHA-256', interleaved);
      return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
    };
    const tracks = facade.tracks as any[];
    return {
      contextState: browser.context.state,
      ready: facade.getUiStatus().ready,
      inputReady: facade.getUiStatus().inputReady,
      awaitingResume: facade.isBrowserRecoveryAwaitingUserResume(),
      microphoneRequests: probe.microphoneRequests,
      midiConnectCalls: probe.outputRetry.midiConnectCalls,
      midiState: facade.getMidiInputState(),
      masterGain: browser.masterGainNode.gain.value,
      monitorGain: browser.monitorGainNode.gain.value,
      pcm: await Promise.all(tracks.map((track) => digest(track.audioBuffer))),
      history: await Promise.all(tracks.map((track) => digest(track.pcmHistory?.snapshot?.buffer ?? null))),
      historyStatus: tracks.map((_: unknown, index: number) => facade.getTrackHistoryStatus(index + 1)),
      retainedHistoryBytes: tracks[0]!.historyTotalRetainedBytes,
      transportBpm: (window as any).__rc505ClosedRecoverySnapshot.transport.bpm,
    };
  });
  expect(partialOutputRecovery).toEqual({
    contextState: 'running', ready: false, inputReady: false, awaitingResume: true,
    microphoneRequests: 0, midiConnectCalls: 0, midiState: 'disconnected', masterGain: 0, monitorGain: 0,
    pcm: result.beforePcm.map(({ sha256 }: { sha256: string }) => sha256),
    history: candidateResult.tracks.map((track: any) => track.sourceHistory),
    historyStatus: result.beforeHistory,
    retainedHistoryBytes: result.recovery.historyBufferBytes,
    transportBpm: result.beforeTransport.bpm,
  });

  // Retrying a partially initialized running context must use the recovery
  // output-only path again, never BrowserAudioEngine.init()/microphone setup.
  await page.getByTestId('start-audio').click();
  await expect(page.getByTestId('input-status')).toContainText('NOT CONNECTED');
  const resumedRecovery = await page.evaluate(() => {
    const probe = (window as any).__rc505RecoveryFailureProbe;
    const facade = probe.facade;
    const browser = (facade.tracks[0] as any).engine;
    return {
      contextState: browser.context.state,
      ready: facade.getUiStatus().ready,
      inputReady: facade.getUiStatus().inputReady,
      outputGain: browser.masterGainNode.gain.value,
      outputLevel: facade.getOutputLevel(),
      monitorGain: browser.monitorGainNode.gain.value,
      microphoneRequests: probe.microphoneRequests,
      selectedSinkId: (window as any).__rc505RecoveredSinkId ?? null,
      midiState: facade.getMidiInputState(),
      midiConnectCalls: probe.outputRetry.midiConnectCalls,
      trackStates: (facade.tracks as any[]).map((track) => track.state),
      awaitingResume: facade.isBrowserRecoveryAwaitingUserResume(),
    };
  });
  expect(resumedRecovery).toMatchObject({
    contextState: 'running',
    ready: true,
    inputReady: false,
    monitorGain: 0,
    microphoneRequests: 0,
    midiConnectCalls: 0,
    selectedSinkId: 'recovery-output-device',
    midiState: 'disconnected',
    trackStates: ['STOPPED', 'STOPPED', 'STOPPED', 'STOPPED', 'STOPPED'],
    awaitingResume: false,
  });
  expect(resumedRecovery.outputGain).toBeCloseTo(0.37, 6);
  expect(resumedRecovery.outputLevel).toBeCloseTo(37, 4);
  await page.evaluate(() => {
    const probe = (window as any).__rc505RecoveryFailureProbe;
    window.AudioWorkletNode = probe.originalNode;
    probe.mediaDevices.getUserMedia = probe.originalGetUserMedia;
  });
});
