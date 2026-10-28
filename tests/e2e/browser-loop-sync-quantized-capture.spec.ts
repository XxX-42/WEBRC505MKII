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
    const inputBuffer = context.createBuffer(1, pattern.length, context.sampleRate);
    inputBuffer.copyToChannel(pattern, 0);
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
      maxError = Math.max(maxError, Math.abs(left[index]! - pattern[patternIndex]!), Math.abs(right[index]! - pattern[patternIndex]!));
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
