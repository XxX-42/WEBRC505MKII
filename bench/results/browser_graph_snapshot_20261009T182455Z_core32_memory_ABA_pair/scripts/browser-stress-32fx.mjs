import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runBrowserStress32Fx({ page, minutes, outputDirectory }) {
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
    throw new RangeError('WEBRC_STRESS_MINUTES must be between 1 and 120.');
  }
  const memoryScheduleRaw = process.env.WEBRC_STRESS_MEMORY_ABA_OFFSETS_MS ?? '';
  const memoryScheduleOffsetsMs = memoryScheduleRaw.trim()
    ? memoryScheduleRaw.split(',').map((entry) => Number(entry.trim()))
    : [];
  if (memoryScheduleOffsetsMs.some((value, index) => !Number.isSafeInteger(value) || value < 1_000 ||
      (index > 0 && value <= memoryScheduleOffsetsMs[index - 1]))) {
    throw new TypeError('WEBRC_STRESS_MEMORY_ABA_OFFSETS_MS must be a strictly increasing comma-separated list of safe integer offsets >= 1000 ms.');
  }
  const targetWallMs = minutes * 60_000;
  const root = outputDirectory || join(process.cwd(), 'bench', 'results', `browser_graph_stress32_${new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z')}`);
  if (existsSync(root)) throw new Error(`Refusing to overwrite immutable stress evidence directory: ${root}`);
  mkdirSync(root, { recursive: false });
  const traceDirectory = join(root, 'traces');
  mkdirSync(traceDirectory, { recursive: true });
  const progressFile = join(root, 'progress.ndjson');
  const timelineFile = join(root, 'timeline-events.ndjson');
  writeFileSync(progressFile, '', 'utf8');
  writeFileSync(timelineFile, '', 'utf8');

  const setup = await page.evaluate(async (memoryScheduleOffsetsMs) => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const { ControlWord } = await import('/src/audio/browserRealtimeProtocol.ts');
    const { controlCommandDispatcher } = await import('/src/composables/useControlDispatcher.ts');
    const engine = AudioEngine.getInstance();
    const audio = engine.browser;
    const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const waitForRealtimeIdle = async (label, timeoutMs = 10_000) => {
      const runtime = audio.realtimeRuntime;
      const deadline = Date.now() + timeoutMs;
      let consecutiveIdleChecks = 0;
      let lastObservation = null;
      while (Date.now() < deadline) {
        await runtime.getSharedDspFailureDiagnostics(Math.min(5_000, timeoutMs));
        const commandRead = Atomics.load(runtime.control, ControlWord.COMMAND_READ);
        const commandWrite = Atomics.load(runtime.control, ControlWord.COMMAND_WRITE);
        lastObservation = {
          pendingWriteOperations: runtime.pendingWriteOperations,
          pendingAcks: runtime.ackWaiters.size,
          pendingTrackPreparation: runtime.trackPreparationPromises.filter(Boolean).length,
          commandRead,
          commandWrite,
        };
        const idle = lastObservation.pendingWriteOperations === 0 && lastObservation.pendingAcks === 0 &&
          lastObservation.pendingTrackPreparation === 0 && commandRead === commandWrite;
        consecutiveIdleChecks = idle ? consecutiveIdleChecks + 1 : 0;
        if (consecutiveIdleChecks >= 2) return;
        await pause(25);
      }
      throw new Error(`Realtime commands did not drain before ${label}: ${JSON.stringify(lastObservation)}`);
    };
    if (!audio?.isReady || audio.context.sampleRate !== 48_000 || audio.tracks.length !== 5) {
      throw new Error('32-FX graph pilot requires a ready five-track 48 kHz Browser engine.');
    }
    if (!audio.sharedDspGraph || !audio.getMasterFxOutputNode()) {
      throw new Error('The Browser input/track/master shared-DSP Worklets are unavailable.');
    }
    engine.setControlStateAdapter({
      read: () => controlCommandDispatcher.getState(),
      apply: (state) => controlCommandDispatcher.setState(state),
    });

    await audio.setInputDevice('smoke-stereo-input');
    for (const track of audio.tracks) {
      if (track.state === 'PLAYING' || track.state === 'RECORDING' || track.state === 'OVERDUBBING') await track.stop();
    }
    const sampleRate = audio.context.sampleRate;
    const frameCount = sampleRate * 4;
    const frequencies = [137, 173, 211, 257, 307];
    const pcmSignatures = [];
    for (let trackIndex = 0; trackIndex < audio.tracks.length; trackIndex += 1) {
      const buffer = audio.context.createBuffer(2, frameCount, sampleRate);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      const leftHz = frequencies[trackIndex];
      const rightHz = leftHz + 71;
      for (let frame = 0; frame < frameCount; frame += 1) {
        left[frame] = 0.055 * Math.sin(2 * Math.PI * leftHz * frame / sampleRate + trackIndex * 0.13);
        right[frame] = 0.05 * Math.sin(2 * Math.PI * rightHz * frame / sampleRate + 0.31 + trackIndex * 0.09);
      }
      await audio.tracks[trackIndex].importAudioBuffer(buffer);
      await audio.tracks[trackIndex].updateRuntimeSettings({ speed: 1, keepPitch: false });
      pcmSignatures.push({ track: trackIndex + 1, frames: frameCount, channels: 2, leftHz, rightHz });
    }

    const fxBefore = audio.getFxState();
    const emptyBank = fxBefore.banks.find((bank) => bank.id !== fxBefore.activeBankId &&
      ['input', 'track', 'output'].every((location) => bank[location].every((slot) => slot === null)));
    const bankId = emptyBank?.id ?? fxBefore.activeBankId;
    if (bankId !== fxBefore.activeBankId) await audio.selectFxBank(bankId);
    for (const location of ['input', 'track', 'output']) {
      for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) {
        const current = audio.getFxBanks().find((bank) => bank.id === bankId)?.[location][slotIndex];
        if (current) await audio.updateFxBankSlot(location, slotIndex, null);
      }
    }
    const catalog = audio.getSharedDspFxCatalog();
    const sharedUnit = (ordinal, overrides = {}) => {
      const descriptor = catalog.find((entry) => entry.ordinal === ordinal);
      if (!descriptor) throw new Error(`The loaded 32-processor FX registry does not expose ordinal ${ordinal}.`);
      const params = Object.fromEntries(descriptor.parameters.map((parameter) => [String(parameter.id), parameter.defaultValue]));
      Object.assign(params, overrides);
      return { type: `SHARED_DSP_FX_${ordinal}`, enabled: true, params };
    };
    const inputDynamics = sharedUnit(25, { '9': -24, '10': 3.5, '11': 7, '12': 8, '13': 110, '14': 0.55, '15': 1.5 });
    const inputFilter = sharedUnit(3, { '1': 52, '2': 0.70710678, '3': 1, '4': 12 });
    const trackEq = sharedUnit(26, { '36': 1.5, '39': -1.0, '33': 0.8 });
    const trackPan = sharedUnit(29, { '48': 1, '5': 0.21, '6': 0.28, '56': 0, '21': 1 });
    const trackDelay = sharedUnit(36, { '8': 126, '7': 0.22, '3': 0.14, '4': 15 });
    const trackVinyl = sharedUnit(53, { '48': 1, '21': 0.32, '55': 0 });
    const masterReverb = sharedUnit(47, { '16': 0.85, '17': 4_800, '18': 0.18, '19': 0.2, '20': 0.82, '21': 0.18, '4': 25 });
    await audio.updateFxBankSlot('input', 0, inputDynamics);
    await audio.updateFxBankSlot('input', 1, inputFilter);
    await audio.updateFxBankSlot('track', 0, trackEq);
    await audio.updateFxBankSlot('track', 1, trackPan);
    await audio.updateFxBankSlot('track', 2, trackDelay);
    await audio.updateFxBankSlot('track', 3, trackVinyl);
    await audio.updateFxBankSlot('output', 0, masterReverb);
    const trackSends = await Promise.all(audio.tracks.map((_, index) => audio.setTrackFxSend(index + 1, true)));
    const mixer = audio.getMixerState();
    mixer.masterLevel = 0.72;
    mixer.tracks.forEach((track, index) => {
      track.level = 0.78;
      track.pan = [-0.55, -0.28, 0, 0.28, 0.55][index];
      track.muted = false;
      track.solo = false;
    });
    await audio.applyMixerState(mixer);
    await audio.selectCleanRoomRhythm(17, 7);
    audio.rhythmEngine.setVolume(20);
    await audio.setMonitoring(true);
    await audio.context.resume();
    await Promise.all(audio.tracks.map((track) => track.play()));
    audio.rhythmEngine.start();

    const service = engine.getProjectService();
    await waitForRealtimeIdle('saving Memory A');
    await service.saveMemory(90, 'Software stress A: five stereo loops and shared FX');
    const mixerB = audio.getMixerState();
    mixerB.masterLevel = 0.66;
    mixerB.tracks[1].pan = -0.42;
    mixerB.tracks[3].level = 0.62;
    await audio.applyMixerState(mixerB);
    await audio.selectCleanRoomRhythm(131, 12);
    await audio.updateFxBankSlot('track', 0, { ...trackEq,
      params: { ...trackEq.params, '36': -2.25, '39': 1.75, '33': -1.25 } });
    await waitForRealtimeIdle('saving Memory B');
    await service.saveMemory(91, 'Software stress B: distinct mix, rhythm and EQ');
    await waitForRealtimeIdle('loading Memory A');
    await service.loadMemory(90);
    await audio.context.resume();
    for (const track of audio.tracks) if (track.state !== 'PLAYING') await track.play();
    audio.rhythmEngine.start();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const initialDiagnostics = await audio.realtimeRuntime.getSharedDspFailureDiagnostics(5_000);
    const runtimeIdentity = audio.getSharedDspRuntimeIdentity();
    controlCommandDispatcher.setAssignment(0, {
      source: 'cc', channel: 1, number: 21, trigger: 'value', command: 'set-track-pan', trackId: 3,
    });
    const taskState = {
      steps: 0, midiEvents: 0, uiUpdates: 0, rhythmPresetChanges: 0,
      transportStopStarts: 0, fileLoads: 0, memoryABACycles: 0, memoryABAScheduleIndex: 0,
      memoryABAScheduleOffsetsMs: [...memoryScheduleOffsetsMs], memoryOperations: [],
      fxReplacementTransitions: 0, errors: [], actionSegments: [], stop: false,
      startedAt: new Date().toISOString(), startedAtMs: Date.now(),
    };
    const runSegment = async (name, action, metadata = {}) => {
      const started = Date.now();
      try {
        await action();
        taskState.actionSegments.push({ name, ...metadata, status: 'complete', startedAtMs: started, startedOffsetMs: started - taskState.startedAtMs, durationMs: Date.now() - started });
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        taskState.errors.push({ name, message, at: new Date().toISOString() });
        taskState.actionSegments.push({ name, ...metadata, status: 'failed', startedAtMs: started, startedOffsetMs: started - taskState.startedAtMs, durationMs: Date.now() - started, error: message });
      }
    };
    taskState.task = (async () => {
      let lastFileLoad = Date.now();
      while (!taskState.stop) {
        const step = taskState.steps++;
        try {
          const phase = Math.sin(step * 0.23);
          controlCommandDispatcher.handleControlInput({ source: 'cc', id: 'stress32-midi-cc21',
            channel: 1, number: 21, value: Math.max(0, Math.min(127, Math.round((phase + 1) * 63.5))) });
          taskState.midiEvents += 1;
          const liveMixer = audio.getMixerState();
          liveMixer.masterLevel = 0.68 + 0.08 * (0.5 + 0.5 * Math.sin(step * 0.11));
          liveMixer.tracks[1].level = 0.72 + 0.12 * (0.5 + 0.5 * Math.cos(step * 0.17));
          liveMixer.tracks[3].pan = Math.sin(step * 0.07) * 0.35;
          await audio.applyMixerState(liveMixer);
          audio.rhythmEngine.setVolume(16 + (step % 4) * 3);
          taskState.uiUpdates += 1;
          if (step > 0 && step % 60 === 0) {
            await runSegment('clean-room-pattern-kit-change', async () => {
              const change = taskState.rhythmPresetChanges++;
              await audio.selectCleanRoomRhythm((17 + change * 13) % 240, (7 + change) % 16);
            });
          }
          if (step > 0 && step % 150 === 0) {
            await runSegment('five-track-stop-start', async () => {
              for (const track of audio.tracks) if (track.state === 'PLAYING') await track.stop();
              for (const track of audio.tracks) if (track.state !== 'PLAYING') await track.play();
              taskState.transportStopStarts += 1;
            });
          }
          const cycleIndex = taskState.memoryABACycles;
          const scheduledOffsetMs = taskState.memoryABAScheduleOffsetsMs[taskState.memoryABAScheduleIndex] ?? null;
          const scheduleDue = scheduledOffsetMs !== null &&
            Date.now() - taskState.startedAtMs >= scheduledOffsetMs;
          const defaultCadenceDue = taskState.memoryABAScheduleOffsetsMs.length === 0 &&
            step > 0 && step % 300 === 0;
          if (scheduleDue || defaultCadenceDue) {
            await runSegment('project-memory-A-B-A-cycle-' + (cycleIndex + 1), async () => {
              const service = engine.getProjectService();
              const cycle = cycleIndex + 1;
              const operations = [
                { label: 'loading Memory A in stress', name: 'load-A-before', slot: 90 },
                { label: 'loading Memory B in stress', name: 'load-B', slot: 91 },
                { label: 'reloading Memory A in stress', name: 'load-A-after', slot: 90 },
              ];
              for (const operation of operations) {
                await waitForRealtimeIdle(operation.label);
                const operationStartedOffsetMs = Date.now() - taskState.startedAtMs;
                try {
                  await service.loadMemory(operation.slot);
                  taskState.memoryOperations.push({
                    cycle, operation: operation.name, slot: operation.slot,
                    scheduledOffsetMs, startedOffsetMs: operationStartedOffsetMs,
                    completedOffsetMs: Date.now() - taskState.startedAtMs, status: 'complete',
                  });
                } catch (error) {
                  taskState.memoryOperations.push({
                    cycle, operation: operation.name, slot: operation.slot,
                    scheduledOffsetMs, startedOffsetMs: operationStartedOffsetMs,
                    completedOffsetMs: Date.now() - taskState.startedAtMs, status: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                  });
                  throw error;
                }
              }
              for (const track of audio.tracks) if (track.state !== 'PLAYING') await track.play();
              audio.rhythmEngine.start();
              taskState.memoryABACycles += 1;
            }, { cycle: cycleIndex + 1, scheduledOffsetMs, scheduledStep: step });
            if (scheduledOffsetMs !== null) taskState.memoryABAScheduleIndex += 1;
          }
          if (step > 0 && step % 300 === 150) {
            await runSegment('shared-track-bank-replacement-crossfade', async () => {
              const activeBank = audio.getFxBanks().find((bank) => bank.id === audio.getActiveFxBankId());
              const current = activeBank?.track[1];
              if (!current || current.type !== 'SHARED_DSP_FX_29') throw new Error('Active shared Auto Pan slot 2 is missing.');
              const rate = taskState.fxReplacementTransitions % 2 === 0 ? 0.34 : 0.18;
              await audio.updateFxBankSlot('track', 1, { ...current,
                params: { ...current.params, '5': rate } });
              taskState.fxReplacementTransitions += 1;
            });
          }
          if (Date.now() - lastFileLoad >= 120_000) {
            await runSegment('track-five-stereo-audio-import', async () => {
              const track = audio.tracks[4];
              if (track.state === 'PLAYING') await track.stop();
              const frames = Math.round(sampleRate * 1.25);
              const replacement = audio.context.createBuffer(2, frames, sampleRate);
              const left = replacement.getChannelData(0);
              const right = replacement.getChannelData(1);
              const leftHz = 307 + (taskState.fileLoads % 5) * 17;
              const rightHz = leftHz + 83;
              for (let frame = 0; frame < frames; frame += 1) {
                left[frame] = 0.045 * Math.sin(2 * Math.PI * leftHz * frame / sampleRate);
                right[frame] = 0.04 * Math.sin(2 * Math.PI * rightHz * frame / sampleRate + 0.31);
              }
              await track.importAudioBuffer(replacement);
              await track.play();
              taskState.fileLoads += 1;
              lastFileLoad = Date.now();
            });
          }
        } catch (error) {
          taskState.errors.push({ name: 'stress-loop', message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
        }
        const nextMemoryOffsetMs = taskState.memoryABAScheduleOffsetsMs[taskState.memoryABAScheduleIndex];
        const untilMemoryOffsetMs = Number.isSafeInteger(nextMemoryOffsetMs)
          ? nextMemoryOffsetMs - (Date.now() - taskState.startedAtMs)
          : 2_000;
        await pause(Math.max(1, Math.min(2_000, untilMemoryOffsetMs)));
      }
    })();
    window.__webrcStress32Fx = taskState;
    return {
      sampleRate,
      quantumFrames: audio.getRealtimeMetrics().quantumFrames,
      bankId: audio.getActiveFxBankId(),
      processorOrdinals: {
        input: [25, 3], track: [26, 29, 36, 53], master: [47],
      },
      fiveTrackStereoFixtures: pcmSignatures,
      trackFxSends: trackSends.map((_, index) => ({ track: index + 1, enabled: audio.tracks[index].track.fxSw === 'ON' })),
      syntheticInputId: audio.selectedInputDeviceId,
      monitoringEnabled: audio.monitoringEnabled,
      cleanRoomRhythm: audio.getRhythmSnapshot().cleanRoomPreset,
      contextState: audio.context.state,
      contextCurrentTimeSeconds: audio.context.currentTime,
      renderedFrameAtSetup: audio.getRealtimeMetrics().renderedFrame,
      initialDiagnostics,
      runtimeIdentity,
      projectMemorySlots: [90, 91],
      taskState: { ...taskState, task: undefined },
    };
  }, memoryScheduleOffsetsMs);

  const stressStartedAt = new Date().toISOString();
  const stressWallStartMs = Date.now();
  const targetUniqueOutputFrames = setup.sampleRate * minutes * 60;
  const initialUniqueOutputFrames = setup.initialDiagnostics.timelineUniqueOutputFrames;
  const progressRows = [];
  const timelineEvents = [];
  let currentProcessorId = setup.runtimeIdentity.looperProcessorInstanceId;
  let lastRawUniqueFrames = initialUniqueOutputFrames;
  let cumulativeUniqueOutputFrames = 0;
  let lastTimelineEventCount = setup.initialDiagnostics.timelineEventCount;
  let lastTimelineEventProcessorId = currentProcessorId;
  let uniqueOutputCounterResetObserved = false;
  let timelineEventCaptureComplete = true;
  let lastProgressTime = 0;
  const traceClient = await page.context().newCDPSession(page);
  const traceWindows = [];
  const traceConfig = {
    includedCategories: [
      'audio', 'webaudio', 'disabled-by-default-audio',
      'disabled-by-default-audio-worklet', 'disabled-by-default-v8.gc',
    ],
    excludedCategories: ['*'],
  };
  const sleepHost = (ms) => sleep(ms);
  const diagnosticsAt = () => page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const audio = AudioEngine.getInstance().browser;
    const diagnostics = await audio.realtimeRuntime.getSharedDspFailureDiagnostics(5_000);
    return {
      diagnostics,
      runtimeIdentity: audio.getSharedDspRuntimeIdentity(),
      hostObservation: {
        contextCurrentTimeSeconds: audio.context.currentTime,
        contextState: audio.context.state,
        sampleRate: audio.context.sampleRate,
        realtimeMetrics: audio.getRealtimeMetrics(),
      },
    };
  });
  const failureDeltas = (before, after) => Object.fromEntries(Object.keys(after.counts).map((name) =>
    [name, after.counts[name] - before.counts[name]]));
  const percentile = (values, fraction) => {
    if (!values.length) return null;
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)];
  };
  const appendJsonLine = (file, value) => writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'a', encoding: 'utf8' });

  const baselineFlatEvents = setup.initialDiagnostics.timelineEvents;
  const baselineEventSlots = Math.floor(baselineFlatEvents.length / 4);
  const baselineEventStartOrdinal = Math.max(1, setup.initialDiagnostics.timelineEventCount - baselineEventSlots + 1);
  for (let index = 0; index < baselineEventSlots; index += 1) {
    const event = {
      processorId: setup.runtimeIdentity.looperProcessorInstanceId,
      ordinal: baselineEventStartOrdinal + index,
      phase: 'pre-pilot-baseline',
      type: baselineFlatEvents[index * 4], expectedFrame: baselineFlatEvents[index * 4 + 1],
      actualFrame: baselineFlatEvents[index * 4 + 2], frames: baselineFlatEvents[index * 4 + 3],
      capturedAt: stressStartedAt,
    };
    timelineEvents.push(event);
    appendJsonLine(timelineFile, event);
  }
  const baselineTimelineEventsCaptured = baselineEventSlots;
  const pilotTimelineEventsCapturedStart = timelineEvents.length;
  if (setup.initialDiagnostics.timelineEventCount > baselineEventSlots) timelineEventCaptureComplete = false;

  const captureTraceWindow = async (windowIndex, durationMs = 10_000) => {
    const before = await diagnosticsAt();
    const traceEvents = [];
    let completion = null;
    let resolveComplete;
    const completePromise = new Promise((resolve) => { resolveComplete = resolve; });
    const onCollected = (event) => {
      for (const traceEvent of event.value || []) traceEvents.push(traceEvent);
    };
    const onComplete = (event) => { completion = event; resolveComplete(event); };
    traceClient.on('Tracing.dataCollected', onCollected);
    traceClient.on('Tracing.tracingComplete', onComplete);
    const traceStartedAt = Date.now();
    await traceClient.send('Tracing.start', { traceConfig, transferMode: 'ReportEvents' });
    await sleepHost(durationMs);
    await traceClient.send('Tracing.end');
    await Promise.race([completePromise, sleepHost(60_000).then(() => { throw new Error('CDP trace completion timed out.'); })]);
    const traceCompletedAt = Date.now();
    traceClient.off('Tracing.dataCollected', onCollected);
    traceClient.off('Tracing.tracingComplete', onComplete);
    const after = await diagnosticsAt();
    const processEvents = traceEvents.filter((event) => event.name === 'AudioWorkletProcessor::Process' &&
      event.ph === 'X' && typeof event.dur === 'number' && String(event.cat || '').includes('audio-worklet'));
    const processThreads = [...new Set(processEvents.map((event) => event.tid))];
    const durationsUs = processEvents.map((event) => event.dur);
    const audioThreadGcEvents = traceEvents.filter((event) => processThreads.includes(event.tid) &&
      String(event.cat || '').toLowerCase().includes('v8.gc'));
    const traceJson = Buffer.from(JSON.stringify({ schemaVersion: 1, windowIndex,
      traceStartedAt: new Date(traceStartedAt).toISOString(), traceCompletedAt: new Date(traceCompletedAt).toISOString(),
      traceConfig, traceCompletion: completion ? {
        dataLossOccurred: Object.hasOwn(completion, 'dataLossOccurred') ? completion.dataLossOccurred : null,
        streamFormat: completion.streamFormat ?? null,
      } : null, events: traceEvents }));
    const compressedTrace = gzipSync(traceJson, { level: 9 });
    const filename = `window-${String(windowIndex + 1).padStart(2, '0')}.trace.json.gz`;
    const path = join(traceDirectory, filename);
    writeFileSync(path, compressedTrace);
    const eventCoverage = completion?.dataLossOccurred === false && processEvents.length > 0 && processThreads.length === 1;
    const traceReport = {
      windowIndex,
      path: filename,
      uncompressedSha256: sha256(traceJson),
      compressedSha256: sha256(compressedTrace),
      bytesUncompressed: traceJson.byteLength,
      bytesCompressed: compressedTrace.byteLength,
      traceCollectionWallMs: traceCompletedAt - traceStartedAt,
      traceConfig,
      traceDataLossOccurred: completion && Object.hasOwn(completion, 'dataLossOccurred') ? completion.dataLossOccurred : null,
      processEventCount: processEvents.length,
      processThreadIds: processThreads,
      processDurationUs: durationsUs.length ? {
        p50: percentile(durationsUs, 0.5), p99: percentile(durationsUs, 0.99),
        p999: percentile(durationsUs, 0.999), maximum: Math.max(...durationsUs), unit: 'microseconds',
        scope: 'all AudioWorkletProcessor::Process script callbacks on the listed audio TID(s); Chrome trace has no per-node identity; not whole AudioRenderTask',
      } : null,
      audioThreadGcEventCount: audioThreadGcEvents.length,
      audioThreadGcDurationsUs: audioThreadGcEvents.filter((event) => typeof event.dur === 'number').map((event) => event.dur),
      processTraceCoverage: eventCoverage ? 'trace-complete-single-audio-tid' : 'partial-or-unknown',
      looperCallbackDelta: after.diagnostics.processCallbackCount - before.diagnostics.processCallbackCount,
      uniqueOutputFrameDelta: after.diagnostics.timelineUniqueOutputFrames - before.diagnostics.timelineUniqueOutputFrames,
      uniqueOutputEndFrame: after.diagnostics.timelineOutputEndFrame,
      xrunDelta: after.diagnostics.timelineXrunCount - before.diagnostics.timelineXrunCount,
      gapFrameDelta: after.diagnostics.timelineForwardGapFrames - before.diagnostics.timelineForwardGapFrames,
      dropOutputFrameDelta: after.diagnostics.timelineDroppedOutputFrames - before.diagnostics.timelineDroppedOutputFrames,
      sharedDspFailureDeltas: failureDeltas(before.diagnostics, after.diagnostics),
      workletInstanceIds: after.runtimeIdentity,
      wholeAudioRenderTask: { status: 'not-measured', reason: 'AudioWorklet script callback trace does not include a verified whole graph render-task aggregate.' },
    };
    traceWindows.push(traceReport);
    appendJsonLine(progressFile, { type: 'trace-window', at: new Date().toISOString(), ...traceReport });
    return { before, after, traceReport };
  };

  const traceIntervalMs = 5 * 60_000;
  const traceDurationMs = 10_000;
  let nextTraceAtMs = 0;
  let snapshotSequence = 0;
  let diagnosticFailure = null;
  let latest = null;
  while (Date.now() - stressWallStartMs < targetWallMs || cumulativeUniqueOutputFrames < targetUniqueOutputFrames) {
    const elapsedMs = Date.now() - stressWallStartMs;
    if (elapsedMs >= nextTraceAtMs) {
      try {
        await captureTraceWindow(traceWindows.length, traceDurationMs);
      } catch (error) {
        diagnosticFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        appendJsonLine(progressFile, { type: 'trace-error', at: new Date().toISOString(), error: diagnosticFailure });
      }
      nextTraceAtMs = elapsedMs + traceIntervalMs;
    }
    if (Date.now() - lastProgressTime >= 30_000 || !latest) {
      const priorLatest = latest;
      latest = await diagnosticsAt();
      const diagnostics = latest.diagnostics;
      const processorId = latest.runtimeIdentity.looperProcessorInstanceId;
      if (processorId !== currentProcessorId) {
        uniqueOutputCounterResetObserved = true;
        appendJsonLine(progressFile, { type: 'processor-epoch-change', at: new Date().toISOString(),
          previousProcessorId: currentProcessorId, processorId,
          previousOutputEndFrame: priorLatest?.diagnostics.timelineOutputEndFrame ?? null,
          currentOutputEndFrame: diagnostics.timelineOutputEndFrame,
          reason: 'Unique-frame deltas are not joined across processor instances.' });
        currentProcessorId = processorId;
        lastRawUniqueFrames = diagnostics.timelineUniqueOutputFrames;
      } else if (diagnostics.timelineUniqueOutputFrames >= lastRawUniqueFrames) {
        cumulativeUniqueOutputFrames += diagnostics.timelineUniqueOutputFrames - lastRawUniqueFrames;
        lastRawUniqueFrames = diagnostics.timelineUniqueOutputFrames;
      } else {
        uniqueOutputCounterResetObserved = true;
        appendJsonLine(progressFile, { type: 'counter-reset', at: new Date().toISOString(),
          processorId, priorRawUniqueOutputFrames: lastRawUniqueFrames,
          currentRawUniqueOutputFrames: diagnostics.timelineUniqueOutputFrames,
          previousOutputEndFrame: priorLatest?.diagnostics.timelineOutputEndFrame ?? null,
          currentOutputEndFrame: diagnostics.timelineOutputEndFrame });
        currentProcessorId = processorId;
        lastRawUniqueFrames = diagnostics.timelineUniqueOutputFrames;
      }
      const currentEventCount = diagnostics.timelineEventCount;
      if (processorId !== lastTimelineEventProcessorId) {
        lastTimelineEventProcessorId = processorId;
        lastTimelineEventCount = 0;
      }
      if (currentEventCount >= lastTimelineEventCount) {
        const eventDelta = currentEventCount - lastTimelineEventCount;
        const flat = diagnostics.timelineEvents;
        const availableEvents = Math.floor(flat.length / 4);
        if (eventDelta > availableEvents) timelineEventCaptureComplete = false;
        const captured = Math.min(eventDelta, availableEvents);
        for (let index = availableEvents - captured; index < availableEvents; index += 1) {
          const localIndex = index - (availableEvents - captured);
          const event = {
            processorId,
            ordinal: currentEventCount - captured + localIndex + 1,
            type: flat[index * 4], expectedFrame: flat[index * 4 + 1], actualFrame: flat[index * 4 + 2],
            frames: flat[index * 4 + 3], capturedAt: new Date().toISOString(),
          };
          timelineEvents.push(event);
          appendJsonLine(timelineFile, event);
        }
        lastTimelineEventCount = currentEventCount;
      } else {
        timelineEventCaptureComplete = false;
        lastTimelineEventCount = currentEventCount;
      }
      const elapsed = Date.now() - stressWallStartMs;
      const row = {
        sequence: snapshotSequence++, capturedAtUtc: new Date().toISOString(), wallElapsedMs: elapsed,
        actualUniqueOutputFrames: cumulativeUniqueOutputFrames,
        targetUniqueOutputFrames,
        wallTargetMs: targetWallMs,
        timeAxisSeconds: {
          wall: elapsed / 1000,
          uniqueOutputAt48k: cumulativeUniqueOutputFrames / setup.sampleRate,
          workletOutputEndFrame: diagnostics.timelineOutputEndFrame,
        },
        workletSample: diagnostics,
        processorIdentity: latest.runtimeIdentity,
        hostObservation: latest.hostObservation,
      };
      progressRows.push(row);
      appendJsonLine(progressFile, { type: 'progress', ...row });
      console.log(JSON.stringify({ pilot: '32fx', wallSeconds: Math.round(elapsed / 1000),
        uniqueOutputSeconds: Math.round(cumulativeUniqueOutputFrames / setup.sampleRate),
        targetSeconds: minutes * 60, callbacks: diagnostics.processCallbackCount,
        duplicates: diagnostics.timelineDuplicateCallbacks, gaps: diagnostics.timelineForwardGapCount,
        gapFrames: diagnostics.timelineForwardGapFrames, xruns: diagnostics.timelineXrunCount,
        dspFailures: diagnostics.aggregateCount, context: latest.hostObservation.contextState }));
      lastProgressTime = Date.now();
    }
    if (Date.now() - stressWallStartMs >= targetWallMs && cumulativeUniqueOutputFrames >= targetUniqueOutputFrames) break;
    const untilProgress = Math.max(250, 30_000 - (Date.now() - lastProgressTime));
    const untilTrace = Math.max(250, nextTraceAtMs - (Date.now() - stressWallStartMs));
    await sleep(Math.min(untilProgress, untilTrace, 30_000));
  }

  const finalState = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const audio = AudioEngine.getInstance().browser;
    audio.rhythmEngine.stop();
    const stress = window.__webrcStress32Fx;
    if (stress) {
      stress.stop = true;
      await stress.task;
    }
    const finalDiagnostics = await audio.realtimeRuntime.getSharedDspFailureDiagnostics(5_000);
    return {
      diagnostics: finalDiagnostics,
      runtimeIdentity: audio.getSharedDspRuntimeIdentity(),
      metrics: audio.getRealtimeMetrics(),
      contextState: audio.context.state,
      contextSampleRate: audio.context.sampleRate,
      taskState: stress ? {
        steps: stress.steps, midiEvents: stress.midiEvents, uiUpdates: stress.uiUpdates,
        rhythmPresetChanges: stress.rhythmPresetChanges, transportStopStarts: stress.transportStopStarts,
        fileLoads: stress.fileLoads, memoryABACycles: stress.memoryABACycles,
        fxReplacementTransitions: stress.fxReplacementTransitions, errors: stress.errors,
        actionSegments: stress.actionSegments, startedAt: stress.startedAt,
      } : null,
    };
  });
  await traceClient.detach();
  const elapsedMs = Date.now() - stressWallStartMs;
  const initialDiagnostics = setup.initialDiagnostics;
  const finalDiagnostics = finalState.diagnostics;
  const counterDelta = (key) => finalDiagnostics[key] - initialDiagnostics[key];
  const sharedDspFailureDeltas = Object.fromEntries(Object.keys(finalDiagnostics.counts).map((name) =>
    [name, finalDiagnostics.counts[name] - initialDiagnostics.counts[name]]));
  const sourceSnapshotManifestPath = join(process.cwd(), 'snapshot-manifest.json');
  const sourceSnapshotManifestBytes = readFileSync(sourceSnapshotManifestPath);
  const sourceSnapshotManifest = JSON.parse(sourceSnapshotManifestBytes.toString('utf8'));
  const wasmBuildManifestBytes = readFileSync(join(process.cwd(), 'public', 'dsp', 'webrc-dsp.build.json'));
  const wasmBuildManifest = JSON.parse(wasmBuildManifestBytes.toString('utf8'));
  const stressReport = {
    schemaVersion: 1,
    status: 'DIAGNOSTIC-PARTIAL-REGISTRY',
    startedAt: stressStartedAt,
    completedAt: new Date().toISOString(),
    wallElapsedMs: elapsedMs,
    wallTargetMs: targetWallMs,
    uniqueOutputFrames: cumulativeUniqueOutputFrames,
    uniqueOutputSecondsAt48k: cumulativeUniqueOutputFrames / setup.sampleRate,
    uniqueOutputTargetFrames: targetUniqueOutputFrames,
    uniqueOutputTargetSeconds: minutes * 60,
    bothTargetsReached: !uniqueOutputCounterResetObserved && elapsedMs >= targetWallMs &&
      cumulativeUniqueOutputFrames >= targetUniqueOutputFrames,
    uniqueOutputMeasurement: 'Worklet timelineUniqueOutputFrames deltas; excludes duplicate callbacks, bounded gap catch-up without output, and dropped-output callbacks. Accumulated only within processor instance epochs; any counter reset is recorded as an uncertainty.',
    sourceIdentity: {
      snapshotManifestSha256: sha256(sourceSnapshotManifestBytes),
      sourceAssetSetSha256: sourceSnapshotManifest.sourceAssetSetSha256,
      wasmBuildManifestSha256: sha256(wasmBuildManifestBytes),
      wasmSourceSetSha256: wasmBuildManifest.sourceSetSha256,
      wasmArtifactSha256: wasmBuildManifest.artifact?.sha256 ?? null,
      pilotRunnerSha256: sha256(readFileSync(join(process.cwd(), 'scripts', 'browser-stress-32fx.mjs'))),
    },
    sampleRate: setup.sampleRate,
    observedQuantumFrames: setup.quantumFrames,
    contextStart: {
      contextCurrentTimeSeconds: setup.contextCurrentTimeSeconds,
      renderedFrameAtSetup: setup.renderedFrameAtSetup,
      runtimeIdentity: setup.runtimeIdentity,
    },
    softwareOnly: true,
    hardwareCertified: false,
    audioSink: 'none',
    input: 'synthetic stereo oscillator through the project AudioContext only',
    module: setup.runtimeIdentity.moduleSha256,
    workletProcessorIdentities: setup.runtimeIdentity,
    setup,
    workload: {
      activeFx: { input: [25, 3], fiveTrackSharedStereo: [26, 29, 36, 53], postMixMaster: [47], rhythm: { pattern: 17, kit: 7 } },
      experimentalPlacement: 'Browser generic track rack routing is exercised; ordinal 53 is not asserted to match official RC-505 MKII placement. Official BEAT SCATTER/REPEAT/SHIFT/VINYL availability is TRACK FX MODE=MULTI, FX A only.',
      fiveIndependentStereoTrackPcmSignatures: setup.fiveTrackStereoFixtures,
      uiMixerChangesAndSyntheticMidiCc: true,
      cleanRoomPatternAndKitChanges: true,
      sharedFxFullBankReplacementTransitions: true,
      periodicTransportStopStart: true,
      periodicTrack4SyntheticAudioBufferLoads: true,
      projectMemoryAtoBtoA: true,
      singleAudioContext: true,
    },
    unsupportedOrAbsent: [
      'Registry has 32 available processors, not all 53 catalog entries.',
      'Three separately qualified LIVE_MONO, LIVE_POLY and HQ_RENDER routes are absent from this workload.',
      'No whole AudioRenderTask duration is identified by the available Chrome trace events.',
      'No physical input/output or hardware latency certification.',
    ],
    initialDiagnostics: setup.initialDiagnostics,
    finalDiagnostics: finalState.diagnostics,
    diagnosticDeltasFromPilotStart: {
      processCallbackCount: counterDelta('processCallbackCount'),
      processFrameCount: counterDelta('processFrameCount'),
      duplicateCallbacks: counterDelta('timelineDuplicateCallbacks'),
      forwardGapCount: counterDelta('timelineForwardGapCount'),
      forwardGapFrames: counterDelta('timelineForwardGapFrames'),
      xrunCount: counterDelta('timelineXrunCount'),
      droppedOutputCallbacks: counterDelta('timelineDroppedOutputCallbacks'),
      droppedOutputFrames: counterDelta('timelineDroppedOutputFrames'),
      droppedInputCallbacks: counterDelta('timelineDroppedInputCallbacks'),
      droppedInputFrames: counterDelta('timelineDroppedInputFrames'),
      timelineEventCount: counterDelta('timelineEventCount'),
      unprovokedSharedDspFailureDelta: finalDiagnostics.aggregateCount - initialDiagnostics.aggregateCount,
      sharedDspFailures: sharedDspFailureDeltas,
    },
    uniqueOutputCounterResetObserved,
    timelineEventsCaptured: timelineEvents.length,
    baselineTimelineEventsCaptured,
    pilotTimelineEventsCaptured: timelineEvents.length - pilotTimelineEventsCapturedStart,
    timelineEventCaptureComplete,
    timelineEventsFile: 'timeline-events.ndjson',
    progressFile: 'progress.ndjson',
    progressRows: progressRows.length,
    traceWindows,
    traceDiagnosticFailure: diagnosticFailure,
    wholeAudioRenderTask: { status: 'not-measured', reason: 'AudioWorklet script callbacks are only a sub-scope of the full graph render task.' },
    finalContextState: finalState.contextState,
    finalMetrics: finalState.metrics,
    finalRuntimeIdentity: finalState.runtimeIdentity,
    actionSummary: finalState.taskState,
  };
  writeFileSync(join(root, 'summary.json'), `${JSON.stringify(stressReport, null, 2)}\n`, 'utf8');
  writeFileSync(join(root, 'pilot-index.json'), `${JSON.stringify({
    schemaVersion: 1,
    report: 'summary.json',
    progress: 'progress.ndjson',
    timelineEvents: 'timeline-events.ndjson',
    traceDirectory: 'traces',
    summarySha256: sha256(Buffer.from(JSON.stringify(stressReport, null, 2) + '\n')),
    progressSha256: sha256(Buffer.from(readFileSync(progressFile))),
    timelineSha256: sha256(Buffer.from(readFileSync(timelineFile))),
    capturedAtUtc: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  return { ...stressReport, outputDirectory: root };
}
