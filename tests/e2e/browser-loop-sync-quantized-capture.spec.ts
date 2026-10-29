import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('real Chromium quantized capture follows master frames exactly and cancellation keeps prior PCM', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const { Transport } = await import('/src/core/Transport.ts');
    const engine = AudioEngine.getInstance();
    const browser = (engine as any).browser;
    const context = browser.context as AudioContext;
    const transport = Transport.getInstance();
    const [master, slave] = engine.tracks as any[];
    const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 12_000) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${label}; transport=${transport.state}; track=${slave.state}; diagnostic=${slave.recordingDiagnostic ?? 'none'}`);
    };

    if (context.state !== 'running' || !browser.inputCaptureNode || !browser.inputCaptureReady) {
      throw new Error(`Expected live Chromium shared input worklet; state=${context.state}, ready=${browser.inputCaptureReady}`);
    }
    await engine.setRecordPlaySettings({ recAction: 'REC->PLAY', quantize: 'MEASURE' });
    transport.resetMasterTrack();
    master.track.loopSyncSw = 'ON'; master.updateSettings();
    slave.track.loopSyncSw = 'ON'; slave.updateSettings();
    const measureFrames = context.sampleRate * 2;
    transport.setMasterTrack(master.track.id, 2, context.sampleRate, measureFrames);
    const masterBuffer = context.createBuffer(2, measureFrames, context.sampleRate);
    masterBuffer.getChannelData(0).fill(0.2);
    masterBuffer.getChannelData(1).fill(-0.2);
    master.audioBuffer = masterBuffer;
    master.state = 'STOPPED';
    await master.play();
    const phaseOrigin = (transport as any).masterPhaseOriginFrameValue as number | null;
    if (!Number.isSafeInteger(phaseOrigin)) throw new Error('Master playback did not establish its AudioContext frame phase');

    const captureNode = browser.inputCaptureNode as AudioWorkletNode;
    const rawSource = browser.inputCaptureRawSource as AudioNode;
    rawSource.disconnect(captureNode);
    browser.inputFxChain.output.disconnect(captureNode);
    const pattern = Float32Array.from({ length: 4096 }, (_, i) => Math.fround((((i * 37) % 997) - 498) / 2048));
    const rightPattern = Float32Array.from({ length: 4096 }, (_, i) => Math.fround((((i * 71) % 991) - 495) / 2048));
    const inputBuffer = context.createBuffer(2, pattern.length, context.sampleRate);
    inputBuffer.copyToChannel(pattern, 0);
    inputBuffer.copyToChannel(rightPattern, 1);
    const signalStartFrame = Math.ceil((context.currentTime + 0.01) * context.sampleRate);
    const signal = context.createBufferSource();
    signal.buffer = inputBuffer; signal.loop = true;
    signal.connect(captureNode, 0, 0);
    signal.connect(captureNode, 0, 1);
    signal.start(signalStartFrame / context.sampleRate);

    const configured: any[] = [];
    const stopRequests: any[] = [];
    const originalOnMessage = captureNode.port.onmessage;
    captureNode.port.onmessage = (event: MessageEvent) => {
      const message = event.data as any;
      if (message?.type === 'RECORD_CONFIGURED') configured.push({ ...message });
      originalOnMessage?.call(captureNode.port, event);
    };
    const port = captureNode.port as any;
    const originalPostMessage = captureNode.port.postMessage.bind(captureNode.port);
    port.postMessage = (message: any, transfer?: Transferable[]) => {
      if (message?.type === 'STOP_CAPTURE') stopRequests.push({ ...message });
      if (transfer === undefined) originalPostMessage(message);
      else originalPostMessage(message, transfer);
    };

    // Confirm the worklet's current readiness epoch immediately before the
    // user action. A later epoch change is still reported as a real capture
    // failure; the test never retries at a different frame.
    await browser.waitForInputCaptureReady();
    let triggerRequestFrame: number | null = null;
    const getInputCaptureRequestFrame = browser.getInputCaptureRequestFrame.bind(browser);
    browser.getInputCaptureRequestFrame = () => {
      const frame = getInputCaptureRequestFrame();
      if (triggerRequestFrame === null) triggerRequestFrame = frame;
      return frame;
    };
    slave.triggerRecord();
    browser.getInputCaptureRequestFrame = getInputCaptureRequestFrame;
    const requestFrame = triggerRequestFrame;
    if (!Number.isSafeInteger(requestFrame)) throw new Error(`REC did not sample a valid shared-capture request frame: ${requestFrame}`);
    const expectedStartFrame = transport.getNextMeasureStartFrame(requestFrame!);
    // An action exactly on a measure boundary may validly use that frame.
    if (!Number.isSafeInteger(expectedStartFrame) || expectedStartFrame! < requestFrame!) throw new Error(`Invalid quantized start ${expectedStartFrame} from request ${requestFrame}`);
    await waitFor(() => slave.state === 'RECORDING', 'quantized first-frame ACK');
    const firstSession = slave.recordingCaptureSession;
    if (!firstSession || firstSession.startFrame !== expectedStartFrame) {
      throw new Error(`Reserved start ${firstSession?.startFrame} did not match master grid ${expectedStartFrame}`);
    }
    await waitFor(() => configured.some((message) => message.sessionId === firstSession.sessionId), 'worklet start-frame ACK');
    const configuredStart = configured.find((message) => message.sessionId === firstSession.sessionId);
    if (configuredStart.requestedStartFrame !== expectedStartFrame || configuredStart.captureStartFrame !== expectedStartFrame) {
      throw new Error(`Worklet ACK was not exact: ${JSON.stringify(configuredStart)}`);
    }

    const stopReferenceFrame = Math.max(browser.getInputCaptureRequestFrame(), firstSession.startFrame);
    const expectedStopFrame = transport.getNextMeasureStartFrame(stopReferenceFrame + 1);
    slave.triggerRecord();
    await waitFor(() => stopRequests.some((message) => message.sessionId === firstSession.sessionId), 'quantized stop request');
    const stopRequest = stopRequests.find((message) => message.sessionId === firstSession.sessionId);
    if (stopRequest.stopFrame !== expectedStopFrame) throw new Error(`Stop ${stopRequest.stopFrame} did not match master grid ${expectedStopFrame}`);
    await waitFor(() => !slave.historyBusy && !!slave.audioBuffer, 'quantized PCM commit');

    const recorded = slave.audioBuffer as AudioBuffer;
    const expectedLength = expectedStopFrame - expectedStartFrame;
    if (recorded.length !== expectedLength) throw new Error(`Recorded ${recorded.length} frames; grid interval is ${expectedLength}`);
    const left = recorded.getChannelData(0);
    const right = recorded.getChannelData(1);
    let maxError = 0;
    for (let index = 0; index < expectedLength; index += 1) {
      const patternIndex = ((expectedStartFrame - signalStartFrame + index) % pattern.length + pattern.length) % pattern.length;
      maxError = Math.max(maxError, Math.abs(left[index]! - pattern[patternIndex]!), Math.abs(right[index]! - rightPattern[patternIndex]!));
    }
    if (maxError > 1e-7) throw new Error(`Quantized stereo PCM differs from known input pattern; max error=${maxError}; got=${left[0]},${left[1]},${left[2]} / ${right[0]},${right[1]},${right[2]}; expected=${pattern[((expectedStartFrame - signalStartFrame) % pattern.length + pattern.length) % pattern.length]}`);

    // Keep the committed loop as an incumbent, then reserve another future
    // measure start and cancel before the worklet ACK. Its PCM must survive.
    const incumbent = slave.audioBuffer;
    const incumbentLeft = incumbent.getChannelData(0).slice();
    const incumbentRight = incumbent.getChannelData(1).slice();
    slave.stop(); slave.state = 'EMPTY';
    slave.triggerRecord();
    await waitFor(() => slave.state === 'REC_STANDBY' && !!slave.recordingCaptureSession, 'second reserved quantized start');
    const cancelledSession = slave.recordingCaptureSession;
    slave.triggerStop();
    if (slave.audioBuffer !== incumbent
      || incumbentLeft.some((sample, index) => incumbent.getChannelData(0)[index] !== sample)
      || incumbentRight.some((sample, index) => incumbent.getChannelData(1)[index] !== sample)) {
      throw new Error('Cancel replaced or modified the incumbent stereo PCM');
    }

    signal.stop();
    port.postMessage = originalPostMessage;
    captureNode.port.onmessage = originalOnMessage;
    return {
      sampleRate: context.sampleRate, phaseOrigin, requestFrame,
      startFrame: expectedStartFrame, stopFrame: expectedStopFrame, frames: recorded.length,
      workletStartAck: configuredStart.captureStartFrame, maxPcmError: maxError,
      cancelledSessionId: cancelledSession?.sessionId ?? null,
      cancelled: slave.recordingDiagnostic?.includes('cancelled before the worklet start acknowledgement') === true,
      incumbentPreserved: slave.audioBuffer === incumbent,
    };
  });

  expect(result.startFrame).toBeGreaterThanOrEqual(result.requestFrame);
  expect(result.stopFrame - result.startFrame).toBe(result.frames);
  expect(result.workletStartAck).toBe(result.startFrame);
  expect(result.maxPcmError).toBeLessThanOrEqual(1e-7);
  expect(result.cancelledSessionId).not.toBeNull();
  expect(result.cancelled).toBe(true);
  expect(result.incumbentPreserved).toBe(true);
});

test('real Chromium Rhythm AudioWorklet phase schedules LOOP SYNC capture and keeps PCM on cancellation', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const engine = AudioEngine.getInstance();
    const browser = (engine as any).browser;
    const context = browser.context as AudioContext;
    const [track] = engine.tracks as any[];
    const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 12_000) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
      const phaseInvalidation = browser.getBrowserRhythmPhaseInvalidation?.();
      throw new Error(`Timed out waiting for ${label}; context=${context.state}; rhythm=${browser.rhythmEngine?.isRunning}/${browser.rhythmEngine?.error || 'no-error'}/node=${!!browser.rhythmEngine?.workletNode}/time=${context.currentTime}; phase=${browser.rhythmEngine?.measurePhaseSnapshot?.epoch ?? 'none'}; atomic=${Atomics.load(browser.rhythmPhaseEpochView, 0)}; invalidation=${phaseInvalidation?.reasonCode ?? 'unknown'}@${phaseInvalidation?.frame ?? 'unknown'}; track=${track.state}; diagnostic=${track.recordingDiagnostic ?? 'none'}`);
    };
    const nextBoundary = (phase: any, frame: number) => {
      const bar = phase.stepsPerBar * phase.sampleRate * 15 / phase.bpm;
      let measures = Math.max(0, Math.ceil((frame - phase.originFrame) / bar));
      let target = phase.originFrame + Math.round(measures * bar);
      while (target < frame) target = phase.originFrame + Math.round(++measures * bar);
      while (measures > 0 && phase.originFrame + Math.round((measures - 1) * bar) >= frame) {
        measures -= 1; target = phase.originFrame + Math.round(measures * bar);
      }
      return target;
    };

    if (context.state !== 'running' || !browser.inputCaptureNode || !browser.inputCaptureReady) {
      throw new Error(`Expected live Chromium shared input worklet; state=${context.state}, ready=${browser.inputCaptureReady}`);
    }
    await engine.setRecordPlaySettings({ recAction: 'REC->PLAY', quantize: 'MEASURE' });
    const transport = (await import('/src/core/Transport.ts')).Transport.getInstance();
    transport.resetMasterTrack();
    track.track.loopSyncSw = 'ON'; track.updateSettings();

    const captureNode = browser.inputCaptureNode as AudioWorkletNode;
    browser.inputCaptureRawSource.disconnect(captureNode);
    browser.inputFxChain.output.disconnect(captureNode);
    const signal = context.createConstantSource();
    const signalGain = context.createGain(); signalGain.gain.value = 0.125;
    signal.connect(signalGain); signalGain.connect(captureNode, 0, 0); signalGain.connect(captureNode, 0, 1);
    signal.start();

    browser.rhythmEngine.start();
    await waitFor(() => !!browser.rhythmEngine.measurePhaseSnapshot, 'real Rhythm phase acknowledgement');
    const phase = browser.rhythmEngine.measurePhaseSnapshot;
    if (!phase || phase.sampleRate !== context.sampleRate || phase.bpm !== transport.bpm) throw new Error('Rhythm phase snapshot did not match the active audio clock and tempo');
    const sharedEpochAtPhaseAck = Atomics.load(browser.rhythmPhaseEpochView, 0);
    if (sharedEpochAtPhaseAck !== phase.epoch) throw new Error(`Rhythm phase ACK epoch ${phase.epoch} was not published to the shared audio-thread barrier (${sharedEpochAtPhaseAck})`);
    await browser.waitForInputCaptureReady();
    const requestFrame = browser.getInputCaptureRequestFrame();
    const expectedStartFrame = nextBoundary(phase, requestFrame);

    track.triggerRecord();
    await waitFor(() => track.state === 'RECORDING', 'Rhythm-quantized start acknowledgement');
    const session = track.recordingCaptureSession;
    if (!session || session.startFrame !== expectedStartFrame) throw new Error(`Start frame ${session?.startFrame} did not match Rhythm grid ${expectedStartFrame}`);
    const incumbent = track.audioBuffer;
    const expectedStopFrame = nextBoundary(phase, Math.max(browser.getInputCaptureRequestFrame(), session.startFrame) + 1);
    track.triggerRecord();
    await waitFor(() => track.state === 'PLAYING' && !track.historyBusy && !!track.audioBuffer && track.audioBuffer !== incumbent, 'Rhythm-quantized stop and PCM commit');
    const recorded = track.audioBuffer as AudioBuffer;
    if (recorded.length !== expectedStopFrame - expectedStartFrame) {
      throw new Error(`Recorded ${recorded.length} frames; Rhythm grid interval is ${expectedStopFrame - expectedStartFrame}`);
    }
    const committed = track.audioBuffer;
    track.stop(); track.state = 'EMPTY';
    browser.rhythmEngine.setSwingPercent(51);
    await waitFor(() => !!browser.rhythmEngine.measurePhaseSnapshot, 'fresh Rhythm phase after reconfiguration');
    const offPhase = browser.rhythmEngine.measurePhaseSnapshot;
    if (!offPhase) throw new Error('Reconfigured Rhythm did not publish a phase snapshot');
    if (Atomics.load(browser.rhythmPhaseEpochView, 0) !== offPhase.epoch) throw new Error('Reconfigured Rhythm phase was not published to the shared audio-thread barrier');
    await browser.waitForInputCaptureReady();
    track.triggerRecord();
    await waitFor(() => track.state === 'REC_STANDBY' && !!track.recordingCaptureSession, 'second reserved Rhythm start');
    const pending = track.recordingCaptureSession;
    track.triggerStop();
    if (track.audioBuffer !== committed) throw new Error('Cancelling a pending Rhythm start replaced the committed PCM');
    const cancellationPreservedPcm = track.audioBuffer === committed;

    await engine.setRecordPlaySettings({ recAction: 'REC->PLAY', quantize: 'OFF' });
    track.state = 'EMPTY';
    await browser.waitForInputCaptureReady();
    track.triggerRecord();
    await waitFor(() => track.state === 'RECORDING', 'QUANTIZE OFF immediate start');
    const offSession = track.recordingCaptureSession;
    if (!offSession) throw new Error('QUANTIZE OFF did not reserve the immediate shared-capture frame');
    const immediateStartFrame = offSession.startFrame;
    if (immediateStartFrame === nextBoundary(offPhase, immediateStartFrame)) {
      throw new Error('QUANTIZE OFF unexpectedly waited for a Rhythm measure boundary');
    }
    const offStopReferenceFrame = Math.max(browser.getInputCaptureRequestFrame(), immediateStartFrame);
    const offStopRequests: any[] = [];
    const capturePort = captureNode.port as any;
    const originalCapturePostMessage = captureNode.port.postMessage.bind(captureNode.port);
    capturePort.postMessage = (message: any, transfer?: Transferable[]) => {
      if (message?.type === 'STOP_CAPTURE') offStopRequests.push({ ...message });
      if (transfer === undefined) originalCapturePostMessage(message);
      else originalCapturePostMessage(message, transfer);
    };
    const beforeOffCommit = track.audioBuffer;
    track.triggerRecord();
    await waitFor(() => offStopRequests.length > 0, 'QUANTIZE OFF Rhythm stop reservation');
    const offStopFrame = offStopRequests[0]!.stopFrame as number;
    if (offStopFrame <= offStopReferenceFrame || nextBoundary(offPhase, offStopFrame) !== offStopFrame) {
      throw new Error(`QUANTIZE OFF stop frame ${offStopFrame} was not a future Rhythm measure boundary`);
    }
    await waitFor(() => track.state === 'PLAYING' && !track.historyBusy && !!track.audioBuffer && track.audioBuffer !== beforeOffCommit, 'QUANTIZE OFF aligned stop and PCM commit');
    const offRecordedFrames = (track.audioBuffer as AudioBuffer).length;
    const offCapturedFrames = offStopFrame - immediateStartFrame;
    const measureFrames = Math.round(offPhase.stepsPerBar * offPhase.sampleRate * 15 / offPhase.bpm);
    const expectedLoopFrames = Math.max(measureFrames, Math.round(offCapturedFrames / measureFrames) * measureFrames);
    if (offRecordedFrames !== expectedLoopFrames) {
      throw new Error(`QUANTIZE OFF loop has ${offRecordedFrames} frames; measure-adjusted capture length should be ${expectedLoopFrames} (capture ${offCapturedFrames})`);
    }
    capturePort.postMessage = originalCapturePostMessage;
    signal.stop();
    browser.rhythmEngine.stop();
    return {
      sampleRate: context.sampleRate,
      epoch: phase.epoch,
      requestFrame,
      startFrame: expectedStartFrame,
      stopFrame: expectedStopFrame,
      frames: recorded.length,
      workletAckStartFrame: session.startFrame,
      cancelledSessionId: pending?.sessionId ?? null,
      incumbentPreserved: cancellationPreservedPcm,
      previousBufferWasPresent: incumbent !== null,
      immediateStartFrame,
      offStopFrame,
      offRecordedFrames,
      offCapturedFrames,
    };
  });

  expect(result.epoch).toBeGreaterThan(0);
  expect(result.startFrame).toBeGreaterThanOrEqual(result.requestFrame);
  expect(result.stopFrame - result.startFrame).toBe(result.frames);
  expect(result.workletAckStartFrame).toBe(result.startFrame);
  expect(result.cancelledSessionId).not.toBeNull();
  expect(result.incumbentPreserved).toBe(true);
  expect(result.offStopFrame - result.immediateStartFrame).toBe(result.offCapturedFrames);
  expect(result.offRecordedFrames).toBeGreaterThanOrEqual(result.offCapturedFrames);
});
