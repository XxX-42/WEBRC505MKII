import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  activateEnhancedAction,
  findEnhancedControl,
  openEnhancedTools,
  openTrackLcd,
  selectEnhancedEnum,
  setEnhancedNumber,
  startBrowserAudio,
} from './uiHelpers';

function readPcm24(buffer: Buffer, offset: number): number {
  let sample = buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
  if (sample & 0x800000) sample -= 0x1000000;
  return sample / 0x800000;
}

test('records, plays and overdubs distinct stereo through all five Browser tracks', async ({ page }) => {
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices;
    const original = mediaDevices.getUserMedia.bind(mediaDevices);
    (window as any).__originalGetUserMedia = original;
    mediaDevices.getUserMedia = async () => {
      let synthetic = (window as any).__stereoTestInput;
      if (!synthetic) {
        const context = new AudioContext();
        const merger = context.createChannelMerger(2);
        const destination = context.createMediaStreamDestination();
        const left = context.createOscillator();
        const right = context.createOscillator();
        const leftGain = context.createGain();
        const rightGain = context.createGain();
        left.type = right.type = 'sine';
        left.frequency.value = 370;
        right.frequency.value = 930;
        leftGain.gain.value = 0.3;
        rightGain.gain.value = 0.2;
        left.connect(leftGain).connect(merger, 0, 0);
        right.connect(rightGain).connect(merger, 0, 1);
        merger.connect(destination);
        left.start();
        right.start();
        await context.resume();
        synthetic = (window as any).__stereoTestInput = { context, left, right, stream: destination.stream };
      }
      await synthetic.context.resume();
      return synthetic.stream as MediaStream;
    };
  });
  await page.goto('/?audio=browser');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const [{ AudioEngine }, { TrackState }] = await Promise.all([
      loadModule('/src/audio/AudioEngine.ts'),
      loadModule('/src/core/types.ts'),
    ]);
    const appRoot = document.querySelector('.app-root') as (HTMLElement & { __vueParentComponent?: any }) | null;
    const engine = appRoot?.__vueParentComponent?.setupState?.engine ?? AudioEngine.getInstance();
    const tracks = engine.tracks as Array<any>;
    if (engine.getMode() !== 'browser' || tracks.length !== 5) {
      throw new Error(`Expected five Browser TrackAudio instances; got mode=${engine.getMode()} tracks=${tracks.length}`);
    }
    const browser = tracks[0].engine;
    const context = browser.context as AudioContext;
    const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const synthetic = (window as any).__stereoTestInput;
    if (!synthetic) throw new Error('Synthetic stereo MediaStream was not installed before Browser audio startup');
    const setInputFrequencies = (leftHz: number, rightHz: number) => {
      synthetic.left.frequency.setTargetAtTime(leftHz, synthetic.context.currentTime, 0.01);
      synthetic.right.frequency.setTargetAtTime(rightHz, synthetic.context.currentTime, 0.01);
    };
    const analyze = (left: Float32Array, right: Float32Array) => {
      const length = Math.min(left.length, right.length, 6000);
      let leftEnergy = 0;
      let rightEnergy = 0;
      let cross = 0;
      for (let frame = 0; frame < length; frame += 1) {
        const l = left[frame] ?? 0;
        const r = right[frame] ?? 0;
        leftEnergy += l * l;
        rightEnergy += r * r;
        cross += l * r;
      }
      const leftRms = Math.sqrt(leftEnergy / Math.max(1, length));
      const rightRms = Math.sqrt(rightEnergy / Math.max(1, length));
      return { leftRms, rightRms, correlation: cross / Math.sqrt(Math.max(1e-20, leftEnergy * rightEnergy)) };
    };
    const waitFor = async (predicate: () => boolean, label: string) => {
      const until = Date.now() + 6000;
      while (Date.now() < until) {
        if (predicate()) return;
        await sleep(20);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const waitForRecordingComplete = async (track: any, trackNumber: number) => {
      await waitFor(
        () => (track.audioBuffer instanceof AudioBuffer && track.state === TrackState.PLAYING)
          || (Boolean(track.recordingDiagnostic) && !track.isRecording && !track.isFinalizingRecording),
        `Track ${trackNumber} recording finalization or an explicit capture error`,
      );
      if (track.recordingDiagnostic) {
        throw new Error(`Track ${trackNumber} recording was rejected instead of finalizing: ${track.recordingDiagnostic}; `
          + `state=${track.state}; recording=${Boolean(track.isRecording)}; finalizing=${Boolean(track.isFinalizingRecording)}; `
          + `captureSession=${track.recordingCaptureSession?.sessionId ?? 'released'}; `
          + `frames=${track.recordingFramesCaptured}; dropped=${track.recordingDroppedFrames}`);
      }
    };
    const originalPortPostMessage = MessagePort.prototype.postMessage;
    let restoreTrackIoModuleLoader: (() => void) | null = null;
    try {
      const recordResults: Array<{ track: number; channels: number; length: number; leftRms: number; rightRms: number; correlation: number }> = [];
      for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index];
        setInputFrequencies(370 + index * 47, 930 + index * 71);

        if (index === 0) {
          // Deterministically model a delayed main-thread START_CAPTURE send.
          // The tap keeps running during the delay, so the original request
          // expires from the bounded pre-roll. The worklet must reject it with
          // frame/cap diagnostics, release the session, and allow a fresh take.
          const originalPostMessage = MessagePort.prototype.postMessage;
          let delayed = false;
          MessagePort.prototype.postMessage = function delayFirstCaptureStart(message: any, transfer?: Transferable[] | StructuredSerializeOptions) {
            if (!delayed && message?.type === 'START_CAPTURE' && message.trackIndex === index) {
              delayed = true;
              window.setTimeout(() => originalPostMessage.call(this, message, transfer as Transferable[] | undefined), 250);
              return;
            }
            return originalPostMessage.call(this, message, transfer as Transferable[] | undefined);
          };
          try {
            await track.startRecording();
          } finally {
            MessagePort.prototype.postMessage = originalPostMessage;
          }
          const expiredSession = track.recordingCaptureSession;
          if (!delayed || !expiredSession) throw new Error('The delayed shared-capture request was not reserved');
          const capturePort = browser.inputCaptureNode.port as MessagePort;
          const originalCaptureHandler = capturePort.onmessage;
          const captureErrors: any[] = [];
          capturePort.onmessage = (event: MessageEvent) => {
            if (event.data?.type === 'CAPTURE_ERROR' && event.data?.sessionId === expiredSession.sessionId) {
              captureErrors.push(event.data);
            }
            originalCaptureHandler?.call(capturePort, event);
          };
          try {
            await waitFor(() => captureErrors.length === 1
              && track.recordingCaptureSession !== null
              && track.recordingCaptureSession.sessionId !== expiredSession.sessionId
              && track.isRecording,
            'expired request rejection, session release, and fresh-frame retry');
          } finally {
            capturePort.onmessage = originalCaptureHandler;
          }
          const error = captureErrors[0];
          if (error.reason !== 'request-frame-outside-preroll'
            || error.preRollCapacityFrames !== 8_192
            || !Number.isSafeInteger(error.requestedStartFrame)
            || !Number.isSafeInteger(error.startReceivedFrame)
            || error.startReceivedFrame - error.requestedStartFrame <= error.preRollCapacityFrames
            || track.recordingCaptureSession.startFrame <= expiredSession.startFrame) {
            throw new Error(`Expired capture did not fail with frame-age/capacity evidence followed by a fresh-frame retry: ${JSON.stringify({ error, oldStart: expiredSession.startFrame, newStart: track.recordingCaptureSession.startFrame })}`);
          }
        }

        if (!track.isRecording) await track.startRecording();
        await sleep(220);
        await track.stopRecording();
        await waitForRecordingComplete(track, index + 1);

        const buffer = track.audioBuffer as AudioBuffer;
        const stereo = analyze(buffer.getChannelData(0), buffer.getChannelData(1));
        recordResults.push({ track: index + 1, channels: buffer.numberOfChannels, length: buffer.length, ...stereo });
        if (buffer.numberOfChannels !== 2) throw new Error(`Track ${index + 1} recorded ${buffer.numberOfChannels} channel(s)`);
        if (stereo.leftRms < 0.03 || stereo.rightRms < 0.02 || Math.abs(stereo.correlation) > 0.25) {
          throw new Error(`Track ${index + 1} recording lost stereo distinction: ${JSON.stringify(stereo)}`);
        }
      }

      // Exercise each actual TrackAudio playback route, and verify it feeds a
      // two-channel AudioBuffer to the real AudioBufferSourceNode.
      const playbackChannels: number[] = [];
      for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index];
        track.stop();
        await track.play();
        await waitFor(() => track.state === TrackState.PLAYING && track.sourceNode?.buffer, `Track ${index + 1} playback start`);
        const sourceBuffer = track.sourceNode.buffer as AudioBuffer;
        if (sourceBuffer.numberOfChannels !== 2) throw new Error(`Track ${index + 1} playback source is not stereo`);
        const splitter = context.createChannelSplitter(2);
        const leftAnalyser = context.createAnalyser();
        const rightAnalyser = context.createAnalyser();
        leftAnalyser.fftSize = rightAnalyser.fftSize = 2048;
        const silentSink = context.createGain();
        silentSink.gain.value = 0;
        track.panNode.connect(splitter);
        splitter.connect(leftAnalyser, 0);
        splitter.connect(rightAnalyser, 1);
        leftAnalyser.connect(silentSink);
        rightAnalyser.connect(silentSink);
        silentSink.connect(context.destination);
        await sleep(100);
        const leftRendered = new Float32Array(leftAnalyser.fftSize);
        const rightRendered = new Float32Array(rightAnalyser.fftSize);
        leftAnalyser.getFloatTimeDomainData(leftRendered);
        rightAnalyser.getFloatTimeDomainData(rightRendered);
        const stereo = analyze(leftRendered, rightRendered);
        splitter.disconnect(); leftAnalyser.disconnect(); rightAnalyser.disconnect(); silentSink.disconnect();
        if (stereo.leftRms < 0.03 || stereo.rightRms < 0.02 || Math.abs(stereo.correlation) > 0.25) {
          throw new Error(`Track ${index + 1} rendered playback lost stereo distinction: ${JSON.stringify(stereo)}`);
        }
        playbackChannels.push(sourceBuffer.numberOfChannels);
      }

      const overdubResults: Array<{ track: number; leftChanged: number; rightChanged: number; leftDeltaRms: number; rightDeltaRms: number; deltaCorrelation: number; otherTracksUnchanged: boolean }> = [];
      const exactBackfillChecks: Array<{ track: number; frames: number; exact: boolean }> = [];
      let activeOverdubTrace: {
        init?: { startFrame: number; startOffsetSamples: number; latencySamples: number; recordingOffsetSamples: number; reverse: boolean };
        backfill?: { requestFrame: number; firstInputFrame: number; validFrames: number; channels: number[][] };
        patch?: { validFrames: number; indices: number[]; values: number[]; rightValues: number[] | null };
      } | null = null;
      MessagePort.prototype.postMessage = function patchedPostMessage(message: any, transfer?: Transferable[] | StructuredSerializeOptions) {
        if (activeOverdubTrace && message?.type === 'OVERDUB_INIT') {
          activeOverdubTrace.init = {
            startFrame: message.startFrame,
            startOffsetSamples: message.startOffsetSamples,
            latencySamples: message.latencySamples,
            recordingOffsetSamples: message.recordingOffsetSamples,
            reverse: message.reverse === true,
          };
        } else if (activeOverdubTrace && message?.type === 'OVERDUB_BACKFILL') {
          activeOverdubTrace.backfill = {
            requestFrame: message.requestFrame,
            firstInputFrame: message.firstInputFrame,
            validFrames: message.validFrames,
            channels: message.channels.map((channel: Float32Array) => Array.from(channel.subarray(0, message.validFrames))),
          };
        }
        return originalPortPostMessage.call(this, message, transfer as Transferable[] | undefined);
      };

      for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index];
        const trace: NonNullable<typeof activeOverdubTrace> = {};
        activeOverdubTrace = trace;
        const originalHandleOverdubMessage = track.handleOverdubMessage.bind(track);
        if (index === 0) {
          track.handleOverdubMessage = (node: AudioWorkletNode, buffer: AudioBuffer, message: any) => {
            if (activeOverdubTrace === trace && message?.type === 'OVERDUB_PATCH' && !trace.patch) {
              trace.patch = {
                validFrames: message.validFrames,
                indices: Array.from(message.indices.subarray(0, message.validFrames)),
                values: Array.from(message.values.subarray(0, message.validFrames)),
                rightValues: message.rightValues instanceof Float32Array
                  ? Array.from(message.rightValues.subarray(0, message.validFrames)) : null,
              };
            }
            return originalHandleOverdubMessage(node, buffer, message);
          };
        }
        const beforeSnapshots = tracks.map((otherTrack) => [
          new Float32Array(otherTrack.audioBuffer.getChannelData(0)),
          new Float32Array(otherTrack.audioBuffer.getChannelData(1)),
        ]);
        if (index === 0) {
          const browserEngine = track.engine;
          const originalEnsure = browserEngine.ensureTrackIoWorkletModule.bind(browserEngine);
          browserEngine.ensureTrackIoWorkletModule = async () => {
            await sleep(40); // Force a known nonzero startup gap while the shared tap remains active.
            await originalEnsure();
          };
          restoreTrackIoModuleLoader = () => { browserEngine.ensureTrackIoWorkletModule = originalEnsure; };
        }
        setInputFrequencies(1430 + index * 61, 2130 + index * 83);
        track.triggerRecord();
        await waitFor(() => track.state === TrackState.OVERDUBBING, `Track ${index + 1} overdub start`);
        try {
          await waitFor(() => !!track.overdubProcessor || track.state !== TrackState.OVERDUBBING, `Track ${index + 1} overdub worklet startup`);
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; state=${track.state}; `
            + `diagnostic=${track.overdubDiagnostic ?? 'none'}; processor=${Boolean(track.overdubProcessor)}; `
            + `starting=${Boolean((track as any).overdubStarting)}; stopping=${Boolean((track as any).overdubStopping)}; `
            + `capture=${Boolean((track as any).overdubCaptureSession)}; `
            + `captureFirst=${String((track as any).overdubCaptureFirstInputFrame)}; `
            + `captureFrames=${String((track as any).overdubCaptureFrames)}; `
            + `captureChannelCount=${String((track as any).overdubCaptureChannelCount)}`);
        }
        if (track.state !== TrackState.OVERDUBBING || !track.overdubProcessor) {
          throw new Error(`Track ${index + 1} overdub startup failed: state=${track.state}; `
            + `diagnostic=${track.overdubDiagnostic ?? 'none'}; processor=${Boolean(track.overdubProcessor)}; `
            + `starting=${Boolean((track as any).overdubStarting)}; `
            + `capture=${Boolean((track as any).overdubCaptureSession)}; `
            + `captureFirst=${String((track as any).overdubCaptureFirstInputFrame)}; `
            + `captureFrames=${String((track as any).overdubCaptureFrames)}`);
        }
        if (index === 0 && restoreTrackIoModuleLoader) {
          restoreTrackIoModuleLoader();
          restoreTrackIoModuleLoader = null;
        }
        await sleep(230);
        track.triggerRecord();
        try {
          await waitFor(() => track.state === TrackState.PLAYING, `Track ${index + 1} overdub stop`);
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; state=${track.state}; `
            + `diagnostic=${track.overdubDiagnostic ?? 'none'}; processor=${Boolean(track.overdubProcessor)}; `
            + `starting=${Boolean((track as any).overdubStarting)}; stopping=${Boolean((track as any).overdubStopping)}; `
            + `capture=${Boolean((track as any).overdubCaptureSession)}`);
        }
        await waitFor(() => track.overdubProcessor === null, `Track ${index + 1} overdub patch drain`);
        await sleep(80);

        const before = beforeSnapshots[index] as [Float32Array, Float32Array];
        const afterLeft = track.audioBuffer.getChannelData(0);
        const afterRight = track.audioBuffer.getChannelData(1);
        const length = Math.min(before[0].length, before[1].length, afterLeft.length, afterRight.length);
        let leftEnergy = 0;
        let rightEnergy = 0;
        let cross = 0;
        let leftChanged = 0;
        let rightChanged = 0;
        for (let frame = 0; frame < length; frame += 1) {
          const dl = (afterLeft[frame] ?? 0) - (before[0][frame] ?? 0);
          const dr = (afterRight[frame] ?? 0) - (before[1][frame] ?? 0);
          leftEnergy += dl * dl;
          rightEnergy += dr * dr;
          cross += dl * dr;
          if (Math.abs(dl) > 1e-5) leftChanged += 1;
          if (Math.abs(dr) > 1e-5) rightChanged += 1;
        }
        const leftDeltaRms = Math.sqrt(leftEnergy / Math.max(1, length));
        const rightDeltaRms = Math.sqrt(rightEnergy / Math.max(1, length));
        const deltaCorrelation = cross / Math.sqrt(Math.max(1e-20, leftEnergy * rightEnergy));
        let otherTracksUnchanged = true;
        const changedOthers: Array<{ track: number; channel: number; frames: number }> = [];
        for (let other = 0; other < tracks.length; other += 1) {
          if (other === index) continue;
          const snapshot = beforeSnapshots[other] as [Float32Array, Float32Array];
          const left = tracks[other].audioBuffer.getChannelData(0);
          const right = tracks[other].audioBuffer.getChannelData(1);
          let changedLeft = 0;
          let changedRight = 0;
          for (let frame = 0; frame < Math.min(snapshot[0].length, snapshot[1].length); frame += 1) {
            if (left[frame] !== snapshot[0][frame]) changedLeft += 1;
            if (right[frame] !== snapshot[1][frame]) changedRight += 1;
          }
          if (changedLeft || changedRight) changedOthers.push({ track: other + 1, channel: changedLeft ? 0 : 1, frames: changedLeft || changedRight });
        }
        otherTracksUnchanged = changedOthers.length === 0;
        overdubResults.push({ track: index + 1, leftChanged, rightChanged, leftDeltaRms, rightDeltaRms, deltaCorrelation, otherTracksUnchanged });
        if (leftChanged < 500 || rightChanged < 500 || leftDeltaRms < 0.005 || rightDeltaRms < 0.004) {
          throw new Error(`Track ${index + 1} overdub did not change both stereo channels: ${JSON.stringify(overdubResults.at(-1))}`);
        }
        if (!otherTracksUnchanged) throw new Error(`Track ${index + 1} overdub changed a different track: ${JSON.stringify(changedOthers)}`);

        if (index === 0) {
          const backfill = trace.backfill;
          const init = trace.init;
          const patch = trace.patch;
          if (!backfill || !init || !patch || backfill.validFrames < 1 || patch.validFrames < backfill.validFrames) {
            throw new Error(`Exact Browser overdub backfill was not observable: ${JSON.stringify({ init, backfill: backfill && { ...backfill, channels: backfill.channels.map((channel) => channel.length) }, patch: patch && { validFrames: patch.validFrames } })}`);
          }
          const before = beforeSnapshots[index] as [Float32Array, Float32Array];
          const loopLength = before[0].length;
          const expected = [new Float32Array(before[0]), new Float32Array(before[1])];
          let exact = true;
          for (let frame = 0; frame < backfill.validFrames; frame += 1) {
            const absoluteFrame = backfill.requestFrame + frame;
            const elapsedFrame = absoluteFrame - init.startFrame;
            let playIndex = (init.reverse ? init.startOffsetSamples - elapsedFrame : init.startOffsetSamples + elapsedFrame) % loopLength;
            if (playIndex < 0) playIndex += loopLength;
            const writeBase = init.reverse ? playIndex + init.latencySamples : playIndex - init.latencySamples;
            let writeIndex = (writeBase - init.recordingOffsetSamples) % loopLength;
            if (writeIndex < 0) writeIndex += loopLength;
            const patchOffset = frame;
            if (patch.indices[patchOffset] !== writeIndex) exact = false;
            const leftInput = backfill.channels[0]?.[frame] ?? 0;
            const rightInput = backfill.channels[1]?.[frame] ?? leftInput;
            expected[0][writeIndex] = Math.fround(expected[0][writeIndex]! + leftInput);
            expected[1][writeIndex] = Math.fround(expected[1][writeIndex]! + rightInput);
            if (patch.values[patchOffset] !== expected[0][writeIndex]
              || patch.rightValues?.[patchOffset] !== expected[1][writeIndex]) exact = false;
          }
          if (!exact) throw new Error('Browser overdub backfill PCM did not exactly match the shared-tap samples and loop write indices.');
          exactBackfillChecks.push({ track: index + 1, frames: backfill.validFrames, exact });
          track.handleOverdubMessage = originalHandleOverdubMessage;
        }
        activeOverdubTrace = null;
      }
      return { sampleRate: context.sampleRate, trackCount: tracks.length, recordResults, playbackChannels, overdubResults, exactBackfillChecks };
    } finally {
      restoreTrackIoModuleLoader?.();
      MessagePort.prototype.postMessage = originalPortPostMessage;
      for (const track of tracks) track.stop();
    }
  });

  expect(result.sampleRate).toBeGreaterThan(0);
  expect(result.trackCount).toBe(5);
  expect(result.recordResults).toHaveLength(5);
  expect(result.recordResults.every((entry) => entry.channels === 2 && entry.leftRms > 0.03 && entry.rightRms > 0.02 && Math.abs(entry.correlation) < 0.25)).toBe(true);
  expect(result.playbackChannels).toEqual([2, 2, 2, 2, 2]);
  expect(result.overdubResults).toHaveLength(5);
  expect(result.overdubResults.every((entry) => entry.leftChanged >= 500 && entry.rightChanged >= 500 && entry.otherTracksUnchanged)).toBe(true);
  expect(result.exactBackfillChecks).toEqual([{ track: 1, frames: expect.any(Number), exact: true }]);

  // Carry the real recorded-and-overdubbed stereo loop through the production
  // Enhanced tools -> TrackAudio -> Signalsmith worker -> PCM24 WAV download path.
  const trackScreen = await openTrackLcd(page, 1);
  await openEnhancedTools(page, 'PITCH / HQ WAV');
  await setEnhancedNumber(page, 'wav-pitch', 0);
  await setEnhancedNumber(page, 'wav-rate', 1);
  await selectEnhancedEnum(page, 'wav-format', 'PCM 24-BIT');
  const exportAction = await findEnhancedControl(page, 'wav-export');
  await expect(exportAction).toBeEnabled();

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await activateEnhancedAction(page, 'wav-export');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('webrc505-track-01-hq-render.wav');
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('Playwright did not expose the stereo HQ WAV download');
  const wav = await fs.readFile(downloadPath);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
  expect(wav.readUInt16LE(20)).toBe(1);
  expect(wav.readUInt16LE(22)).toBe(2);
  expect(wav.readUInt16LE(34)).toBe(24);
  expect(wav.toString('ascii', 36, 40)).toBe('data');
  const frameCount = wav.readUInt32LE(40) / (2 * 3);
  expect(Number.isInteger(frameCount)).toBe(true);
  expect(frameCount).toBeGreaterThan(0);

  let leftEnergy = 0;
  let rightEnergy = 0;
  let cross = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const left = readPcm24(wav, 44 + frame * 6);
    const right = readPcm24(wav, 44 + frame * 6 + 3);
    leftEnergy += left * left;
    rightEnergy += right * right;
    cross += left * right;
  }
  const leftRms = Math.sqrt(leftEnergy / frameCount);
  const rightRms = Math.sqrt(rightEnergy / frameCount);
  const correlation = cross / Math.sqrt(Math.max(1e-20, leftEnergy * rightEnergy));
  expect(leftRms).toBeGreaterThan(0.03);
  expect(rightRms).toBeGreaterThan(0.02);
  expect(Math.abs(correlation)).toBeLessThan(0.3);
  await expect(trackScreen).toBeVisible();
});
