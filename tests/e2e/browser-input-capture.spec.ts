import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('real Chromium AudioWorklet captures the requested stereo PCM frame range', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  const capture = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 44_100, latencyHint: 'interactive' });
    await context.audioWorklet.addModule('/worklets/browser-input-capture.js');
    const node = new AudioWorkletNode(context, 'rc505-input-capture', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: {
        trackCount: 1,
        chunkSize: 1024,
        chunkPoolSize: 3,
        preRollFrames: 16_384,
        maxRecordingBytes: 1024 * 1024,
        sampleRate: context.sampleRate,
      },
    });
    const signalFrames = 88_200;
    const leftSignal = new Float32Array(signalFrames);
    const rightSignal = new Float32Array(signalFrames);
    for (let index = 0; index < signalFrames; index += 1) {
      leftSignal[index] = ((index % 97) - 48) / 64;
      rightSignal[index] = (((index * 7) % 113) - 56) / 70;
    }
    const leftBuffer = context.createBuffer(1, signalFrames, context.sampleRate);
    const rightBuffer = context.createBuffer(1, signalFrames, context.sampleRate);
    leftBuffer.copyToChannel(leftSignal, 0);
    rightBuffer.copyToChannel(rightSignal, 0);
    const left = context.createBufferSource();
    const right = context.createBufferSource();
    left.buffer = leftBuffer;
    right.buffer = rightBuffer;
    const merger = context.createChannelMerger(2);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    // This end-to-end capture exercises the dual-lane worklet with identical
    // source audio on raw and processed inputs, preserving the legacy default.
    merger.connect(node, 0, 0);
    merger.connect(node, 0, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(context.destination);

    const messages: any[] = [];
    let resolveReady!: (message: any) => void;
    let resolveComplete!: (message: any) => void;
    let resolveReleased!: (message: any) => void;
    let rejectComplete!: (error: Error) => void;
    const ready = new Promise<any>((resolve) => { resolveReady = resolve; });
    const complete = new Promise<any>((resolve, reject) => { resolveComplete = resolve; rejectComplete = reject; });
    const released = new Promise<any>((resolve) => { resolveReleased = resolve; });
    const handleMessage = (message: any) => {
      messages.push({ type: message.type, reason: message.reason, sessionId: message.sessionId,
        startFrame: message.startFrame, stopFrame: message.stopFrame,
        framesCaptured: message.framesCaptured, droppedFrames: message.droppedFrames,
        oldestAvailableFrame: message.oldestAvailableFrame, latestAvailableFrame: message.latestAvailableFrame,
        preRollValidFrames: message.preRollValidFrames, requiredPreRollFrames: message.requiredPreRollFrames });
      if (message.type === 'RECORD_CHUNK') {
        messages[messages.length - 1] = {
          ...message,
          left: Array.from(message.channels[0].subarray(0, message.validFrames)),
          right: Array.from(message.channels[1].subarray(0, message.validFrames)),
        };
        const returnedChannels = [new Float32Array(1024), new Float32Array(1024)];
        node.port.postMessage({
          type: 'RECYCLE_CHUNK', trackIndex: 0, sessionId: message.sessionId,
          inputGeneration: message.inputGeneration, chunkIndex: message.chunkIndex,
          channels: returnedChannels,
        }, returnedChannels.map((channel) => channel.buffer));
      } else if (message.type === 'INPUT_CAPTURE_READY') {
        resolveReady(message);
      } else if (message.type === 'RECORD_COMPLETE') {
        resolveComplete(message);
      } else if (message.type === 'CAPTURE_POOL_RELEASED') {
        resolveReleased(message);
      } else if (message.type === 'CAPTURE_ERROR' || message.type === 'RECORD_ABORTED') {
        rejectComplete(new Error(`capture aborted: ${JSON.stringify(messages)}`));
      }
    };
    let delayedReady = false;
    let readyDeliveryPending = false;
    const readinessHandlingDelayMs = 50;
    const queuedMessages: any[] = [];
    node.port.onmessage = (event) => {
      const message = event.data;
      if (readyDeliveryPending) {
        queuedMessages.push(message);
        return;
      }
      if (!delayedReady && message.type === 'INPUT_CAPTURE_READY') {
        delayedReady = true;
        readyDeliveryPending = true;
        // Model a READY message queued behind 50 ms of main-thread work. The
        // audio thread keeps filling its ring while this handler is delayed.
        setTimeout(() => {
          readyDeliveryPending = false;
          handleMessage(message);
          for (const queued of queuedMessages.splice(0)) handleMessage(queued);
        }, readinessHandlingDelayMs);
        return;
      }
      handleMessage(message);
    };

    await context.resume();
    const beforeStart = Math.floor(context.currentTime * context.sampleRate);
    const sourceStartFrame = Math.ceil(beforeStart / 128) * 128 + 1_024;
    left.start(sourceStartFrame / context.sampleRate);
    right.start(sourceStartFrame / context.sampleRate);
    node.port.postMessage({ type: 'INPUT_READY', ready: true, generation: 1, sampleRate: context.sampleRate });
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('input capture worklet readiness timed out')), 5_000)),
    ]);
    // R is chosen only after the delayed READY is handled, from the same
    // AudioContext clock as the worklet's currentFrame. We do not calibrate or
    // rewind R from message arrival time.
    const startFrame = Math.ceil(context.currentTime * context.sampleRate);
    const stopFrame = startFrame + 512;
    node.port.postMessage({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 1, inputGeneration: 1,
      captureReadyEpoch: 0, startFrame, maxRecordingBytes: 1024 * 1024,
    });
    node.port.postMessage({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 1, stopFrame });
    const completed = await Promise.race([
      complete,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`recording completion timed out: ${JSON.stringify(messages)}`)), 5_000)),
    ]);
    const poolRelease = await Promise.race([
      released,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('capture pool release timed out')), 5_000)),
    ]);
    await context.close();
    const expectedOffset = startFrame - sourceStartFrame;
    const expectedStopOffset = stopFrame - sourceStartFrame;
    return {
      startFrame, stopFrame, sourceStartFrame, readinessHandlingDelayMs,
      sourceOffsetFrames: expectedOffset,
      ready: messages.find((message) => message.type === 'INPUT_CAPTURE_READY'),
      expectedLeft: Array.from(leftSignal.subarray(expectedOffset, expectedStopOffset)),
      expectedRight: Array.from(rightSignal.subarray(expectedOffset, expectedStopOffset)),
      completed, poolRelease, chunks: messages,
    };
  });

  expect(capture.completed).toMatchObject({
    requestedStartFrame: capture.startFrame,
    stopFrame: capture.stopFrame,
    framesCaptured: capture.stopFrame - capture.startFrame,
    channelCount: 2,
    status: 'complete',
  });
  expect(capture.poolRelease).toMatchObject({ trackIndex: 0, sessionId: 1, inputGeneration: 1 });
  const chunks = capture.chunks.filter((message) => message.type === 'RECORD_CHUNK');
  expect(capture.readinessHandlingDelayMs).toBe(50);
  expect(capture.ready).toMatchObject({
    preRollValidFrames: 16_384, requiredPreRollFrames: 16_384,
  });
  expect(capture.startFrame).toBeGreaterThanOrEqual(capture.ready.oldestAvailableFrame);
  expect(capture.startFrame).toBeLessThan(capture.sourceStartFrame + 88_200);
  const expectedFrames = capture.stopFrame - capture.startFrame;
  expect(chunks.reduce((total, chunk) => total + chunk.validFrames, 0)).toBe(expectedFrames);
  const left = chunks.flatMap((chunk) => chunk.left);
  const right = chunks.flatMap((chunk) => chunk.right);
  expect(left).toHaveLength(expectedFrames);
  expect(right).toHaveLength(expectedFrames);
  expect(capture.sourceOffsetFrames).toBe(capture.startFrame - capture.sourceStartFrame);
  expect(left.every((sample, index) => Math.abs(sample - capture.expectedLeft[index]) < 1e-6)).toBe(true);
  expect(right.every((sample, index) => Math.abs(sample - capture.expectedRight[index]) < 1e-6)).toBe(true);
});

test('Browser engine records connected stereo input through its shared tap', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);

  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const audio = AudioEngine.getInstance();
    const browser = (audio as any).browser;
    const context = browser.context as AudioContext;
    const left = new OscillatorNode(context, { frequency: 440 });
    const right = new OscillatorNode(context, { frequency: 880 });
    const leftGain = context.createGain();
    const rightGain = context.createGain();
    leftGain.gain.value = 0.25;
    rightGain.gain.value = 0.5;
    const merger = context.createChannelMerger(2);
    const destination = context.createMediaStreamDestination();
    left.connect(leftGain);
    leftGain.connect(merger, 0, 0);
    right.connect(rightGain);
    rightGain.connect(merger, 0, 1);
    merger.connect(destination);
    left.start();
    right.start();
    await browser.replaceInputStream(destination.stream);
    const track = audio.tracks[0] as any;
    await track.startRecording();
    if (!track.recordingCaptureSession) throw new Error('Track did not use the shared Browser capture session');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await track.stopRecording();
    left.stop();
    right.stop();
  });

  await page.waitForFunction(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const audio = AudioEngine.getInstance();
    const track = audio?.tracks?.[0] as any;
    return !!track && !track.isFinalizingRecording && !!track.audioBuffer;
  }, undefined, { timeout: 8_000 });

  const recorded = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const track = AudioEngine.getInstance().tracks[0] as any;
    const buffer = track.audioBuffer as AudioBuffer;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
      const samples = buffer.getChannelData(channel);
      let squareSum = 0;
      for (let index = 0; index < samples.length; index += 1) squareSum += samples[index]! * samples[index]!;
      return { length: samples.length, rms: Math.sqrt(squareSum / Math.max(1, samples.length)) };
    });
    return {
      channels,
      sharedSessionReleased: track.recordingCaptureSession === null,
      diagnostic: track.recordingDiagnostic,
      framesCaptured: track.recordingFramesCaptured,
    };
  });
  expect(recorded.sharedSessionReleased).toBe(true);
  expect(recorded.channels).toHaveLength(2);
  expect(recorded.channels.every((channel) => channel.length > 0 && Number.isFinite(channel.rms))).toBe(true);
  expect(recorded.channels[0]!.rms).toBeGreaterThan(0.1);
  expect(recorded.channels[1]!.rms).toBeGreaterThan(0.2);
  expect(recorded.diagnostic).toBeNull();
});

test('Clear followed by immediate REC waits for the old shared capture pool release', async ({ page }) => {
  await page.goto('/?audio=browser');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const audio = AudioEngine.getInstance();
    const browser = (audio as any).browser;
    const context = browser.context as AudioContext;
    const track = audio.tracks[0] as any;
    const source = new OscillatorNode(context, { frequency: 440 });
    const gain = context.createGain(); gain.gain.value = 0.2;
    source.connect(gain).connect(browser.inputFxChain.input);
    source.start();

    const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 8_000) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${label}; state=${track.state}; diagnostic=${track.recordingDiagnostic ?? 'none'}`);
    };

    await track.startRecording();
    const oldSession = track.recordingCaptureSession;
    if (!oldSession) throw new Error('The old take did not reserve the production shared capture worklet');
    const port = oldSession.node.port as any;
    const originalHandler = port.onmessage;
    const heldChunks: MessageEvent[] = [];
    port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'RECORD_CHUNK' && event.data.sessionId === oldSession.sessionId) {
        heldChunks.push(event);
        return;
      }
      originalHandler?.call(port, event);
    };
    await waitFor(() => heldChunks.length > 0, 'a real shared-capture chunk in flight to the main thread');

    track.clear();
    const immediateStart = track.startRecording();
    await waitFor(() => track.recordingStarting === true, 'the immediate REC request to enter its pool-release wait');
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (track.recordingCaptureSession !== null || heldChunks.length === 0) {
      port.onmessage = originalHandler;
      throw new Error(`REC bypassed the pool-release barrier: held=${heldChunks.length}, session=${track.recordingCaptureSession?.sessionId ?? 'none'}`);
    }

    // Return the exact old session buffers. The worklet acknowledges pool
    // availability only after this transfer, then the new REC may reserve.
    for (const held of heldChunks) originalHandler?.call(port, held);
    await immediateStart;
    port.onmessage = originalHandler;
    const newSession = track.recordingCaptureSession;
    if (!newSession || newSession.sessionId === oldSession.sessionId) {
      throw new Error('The immediate REC did not receive a fresh shared session after old-pool reclamation');
    }
    await waitFor(() => track.recordingCaptureStartAcknowledged === true, 'the new worklet start acknowledgement');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await track.stopRecording();
    await waitFor(() => track.recordingCaptureSession === null && !track.isFinalizingRecording && !!track.audioBuffer,
      'new shared take finalization');
    const frames = track.audioBuffer?.length ?? 0;

    // A later user Stop while waiting on another retired pool must invalidate
    // that pending REC. Delivering the old chunk may release the pool, but it
    // must not revive the canceled start.
    track.clear();
    await track.startRecording();
    const canceledSession = track.recordingCaptureSession;
    if (!canceledSession) throw new Error('The cancellation fixture did not reserve a shared session');
    const cancelPort = canceledSession.node.port as any;
    const cancelHandler = cancelPort.onmessage;
    const cancelChunks: MessageEvent[] = [];
    cancelPort.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'RECORD_CHUNK' && event.data.sessionId === canceledSession.sessionId) {
        cancelChunks.push(event);
        return;
      }
      cancelHandler?.call(cancelPort, event);
    };
    await waitFor(() => cancelChunks.length > 0, 'a second shared chunk held across user cancellation');
    track.clear();
    const canceledStart = track.startRecording();
    await waitFor(() => track.recordingStarting === true, 'the second REC pool-release wait');
    track.triggerStop();
    for (const held of cancelChunks) cancelHandler?.call(cancelPort, held);
    await canceledStart;
    cancelPort.onmessage = cancelHandler;
    await waitFor(() => track.recordingCaptureSession === null && !track.recordingStarting,
      'canceled REC to remain canceled after pool reclamation');
    const canceledState = { recording: track.isRecording, state: track.state, hasBuffer: !!track.audioBuffer };
    source.stop();
    return { oldSessionId: oldSession.sessionId, newSessionId: newSession.sessionId,
      heldChunkCount: heldChunks.length, frames, canceledState };
  });

  expect(result.newSessionId).not.toBe(result.oldSessionId);
  expect(result.heldChunkCount).toBeGreaterThan(0);
  expect(result.frames).toBeGreaterThan(2_000);
  expect(result.canceledState).toEqual({ recording: false, state: 'EMPTY', hasBuffer: false });
});

test('Browser Bounce records a selected source track into the destination loop', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const audio = AudioEngine.getInstance();
    const browser = (audio as any).browser;
    const context = browser.context as AudioContext;
    const silentInput = context.createMediaStreamDestination();
    const mute = context.createGain(); mute.gain.value = 0;
    const silence = new OscillatorNode(context, { frequency: 80 });
    silence.connect(mute).connect(silentInput); silence.start();
    await browser.replaceInputStream(silentInput.stream);

    const sourceTrack = audio.tracks[1] as any;
    const destinationTrack = audio.tracks[0] as any;
    const source = new OscillatorNode(context, { frequency: 440 });
    const sourceGain = context.createGain(); sourceGain.gain.value = 0.2;
    source.connect(sourceGain).connect(sourceTrack.playbackSourceOutput);
    source.start();
    audio.setBrowserBounceSettings({ bounceSw: true,
      bounceIn: [true, false, false, false, false], bounceTrack: [false, true, false, false, false] });
    await destinationTrack.startRecording();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await destinationTrack.stopRecording();
    source.stop(); silence.stop();
  });

  await page.waitForFunction(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const track = AudioEngine.getInstance().tracks[0] as any;
    return !!track && !track.isFinalizingRecording && !!track.audioBuffer;
  }, undefined, { timeout: 8_000 });
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const track = AudioEngine.getInstance().tracks[0] as any;
    const buffer = track.audioBuffer as AudioBuffer;
    return Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
      const samples = buffer.getChannelData(channel);
      let squareSum = 0;
      for (let index = 0; index < samples.length; index += 1) squareSum += samples[index]! * samples[index]!;
      return { length: samples.length, rms: Math.sqrt(squareSum / Math.max(1, samples.length)) };
    });
  });
  expect(result).toHaveLength(2);
  expect(result.every((channel) => channel.length > 0 && channel.rms > 0.05)).toBe(true);
});

test('Classic LCD Bounce controls route another playing track into the destination', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const { TrackAudio } = await import('/src/audio/TrackAudio.ts');
    const audio = AudioEngine.getInstance();
    const browser = (audio as any).browser;
    const context = browser.context as AudioContext;
    const silentInput = context.createMediaStreamDestination();
    const mute = context.createGain(); mute.gain.value = 0;
    const silence = new OscillatorNode(context, { frequency: 80 });
    silence.connect(mute).connect(silentInput); silence.start();
    await browser.replaceInputStream(silentInput.stream);
    await audio.setRecordPlaySettings({ recAction: 'REC->PLAY', quantize: 'OFF' });
    const buffer = context.createBuffer(2, 4096, context.sampleRate);
    buffer.getChannelData(0).fill(0.2); buffer.getChannelData(1).fill(-0.3);
    const result = TrackAudio.restoreProjectBuffersAtomically(browser.tracks, [null, buffer, null, null, null]);
    if (!result.ok) throw new Error(result.reason);
  });
  await page.waitForFunction(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    return AudioEngine.getInstance().getUiStatus().inputCaptureReady;
  });
  const button = (key: string) => page.locator(`[data-panel-control="${key}"]`);
  const lcd = page.getByTestId('rc505-lcd-screen');
  await button('loop').click(); await button('screen-encoder-1').click();
  await expect(lcd).toHaveAttribute('data-classic-screen', 'editor-track');
  await button('page-next').click();
  await page.getByTestId('lcd-field-track-bounce-in').click();
  await expect(page.getByTestId('lcd-field-track-bounce-in')).toHaveAttribute('aria-pressed', 'true');
  await button('exit').click(); await button('screen-encoder-2').click();
  await button('page-next').click();
  await page.getByTestId('lcd-field-bounce-sw').click();
  await page.getByTestId('lcd-field-bounce-track-2').click();
  await expect(page.getByTestId('lcd-field-bounce-track-2')).toHaveAttribute('aria-pressed', 'true');
  await button('exit').click(); await button('exit').click();
  const track = (id: number) => page.locator(`.track-strip[data-track-id="${id}"] [data-panel-control="record-play"]`);
  await track(2).click();
  await expect.poll(() => page.evaluate(async () => (await import('/src/audio/AudioEngine.ts')).AudioEngine.getInstance().tracks[1]!.state)).toBe('PLAYING');
  await track(1).click();
  await expect.poll(() => page.evaluate(async () => (await import('/src/audio/AudioEngine.ts')).AudioEngine.getInstance().tracks[0]!.state)).toBe('RECORDING');
  await button('loop').click(); await button('screen-encoder-2').click(); await button('page-next').click();
  await expect(page.getByTestId('lcd-field-bounce-sw')).toBeDisabled();
  await button('exit').click(); await button('exit').click();
  await page.waitForTimeout(300);
  await track(1).click();
  await page.waitForFunction(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const target = AudioEngine.getInstance().tracks[0] as any;
    return target.state === 'PLAYING' && !!target.audioBuffer && !target.historyBusy;
  });
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const audio = AudioEngine.getInstance();
    const pcm = audio.tracks[0]!.getProjectPcmSnapshot()!;
    return { settings: audio.getBrowserBounceSettings(), channels: pcm.channelData.map((channel) => {
      let sum = 0; for (const sample of channel) sum += sample * sample; return Math.sqrt(sum / channel.length);
    }) };
  });
  expect(result.settings?.bounceIn[0]).toBe(true);
  expect(result.settings?.bounceTrack[1]).toBe(true);
  expect(result.channels).toHaveLength(2);
  expect(result.channels[0]).toBeGreaterThan(0.05);
  expect(result.channels[1]).toBeGreaterThan(0.05);
});

test('Browser Auto Rec arms the shared worklet and records only after the input trigger', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);

  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const audio = AudioEngine.getInstance();
    const browser = (audio as any).browser;
    const context = browser.context as AudioContext;
    const oscillator = new OscillatorNode(context, { frequency: 440 });
    const gain = context.createGain();
    gain.gain.value = 0;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    await browser.replaceInputStream(destination.stream);
    audio.setBrowserAutoRecSettings({ enabled: true, sensitivity: 1 });
    const track = audio.tracks[0] as any;
    await track.startRecording();
    if (track.state !== 'REC_STANDBY' || !track.autoRecArmed) throw new Error('Auto Rec did not enter recording standby');
    const recButton = document.querySelector<HTMLElement>('.track-strip[data-track-id="1"] [data-panel-control="record-play"]');
    const waitForButton = async (predicate: (button: HTMLElement) => boolean, label: string) => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && recButton && !predicate(recButton)) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!recButton || !predicate(recButton)) throw new Error(`Classic REC/PLAY LED did not reach ${label}`);
    };
    await waitForButton(button => button.classList.contains('led-blinking'), 'AUTO REC armed blink');
    if (recButton?.getAttribute('data-led-color') !== 'red'
      || recButton?.getAttribute('data-led-blink-period-ms') !== '500'
      || recButton?.style.getPropertyValue('--led-blink-period') !== '500ms') {
      throw new Error('AUTO REC blink did not use the documented red/500ms engineering approximation');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    gain.gain.setValueAtTime(0.6, context.currentTime);
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && track.state !== 'RECORDING') await new Promise((resolve) => setTimeout(resolve, 10));
    if (track.state !== 'RECORDING' || track.autoRecArmed) throw new Error('Input trigger did not acknowledge recording');
    await waitForButton(button => !button.classList.contains('led-blinking') && button.getAttribute('data-led-color') === 'red', 'steady recording light');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await track.stopRecording();
    oscillator.stop();
  });

  await page.waitForFunction(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const track = AudioEngine.getInstance().tracks[0] as any;
    return !!track && !track.isFinalizingRecording && !!track.audioBuffer;
  }, undefined, { timeout: 8_000 });
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const engine = AudioEngine.getInstance();
    const track = engine.tracks[0] as any;
    return {
      settings: engine.getBrowserAutoRecSettings(),
      state: track.state,
      armed: track.autoRecArmed,
      frames: track.recordingFramesCaptured,
      channels: track.audioBuffer?.numberOfChannels ?? 0,
    };
  });
  expect(result.settings).toEqual({ enabled: true, sensitivity: 1 });
  expect(result.state).toBe('PLAYING'); // Default REC ACTION is REC→PLAY.
  expect(result.armed).toBe(false);
  expect(result.frames).toBeGreaterThan(0);
  expect(result.channels).toBe(2);
});

test('Browser UI blocks new recording and overdub while the shared tap rewarms', async ({ page }) => {
  for (const ui of ['classic', 'tech'] as const) {
    await page.goto(`/?audio=browser&ui=${ui}`);
    await startBrowserAudio(page);
    const recordButton = page.getByRole('button', { name: 'Record or play track' }).first();
    await expect(recordButton).toBeEnabled();

    await page.evaluate(async () => {
      const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
      const browser = (AudioEngine.getInstance() as any).browser;
      const generation = browser.inputCaptureGeneration;
      const captureReadyEpoch = browser.inputCaptureReadyEpoch;
      const sampleRate = browser.context.sampleRate;
      browser.handleInputCaptureMessage({
        type: 'INPUT_CAPTURE_NOT_READY', inputGeneration: generation, captureReadyEpoch, sampleRate,
        reason: 'input-frame-discontinuity', frameStart: 12_000,
        oldestAvailableFrame: 4_000, latestAvailableFrame: 12_000,
        preRollValidFrames: 8_000, preRollCapacityFrames: 8_192, requiredPreRollFrames: 8_192,
      });
    });

    await expect(page.getByTestId('input-capture-warming')).toContainText('record and overdub are disabled');
    await expect(recordButton).toBeDisabled();
    await expect(recordButton).toHaveAttribute('title', /pre-roll is warming/);

    await page.evaluate(async () => {
      const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
      const browser = (AudioEngine.getInstance() as any).browser;
      const generation = browser.inputCaptureGeneration;
      const captureReadyEpoch = browser.inputCaptureReadyEpoch;
      const sampleRate = browser.context.sampleRate;
      const latestAvailableFrame = 8_192;
      browser.handleInputCaptureMessage({
        type: 'INPUT_CAPTURE_READY', inputGeneration: generation, captureReadyEpoch, sampleRate,
        oldestAvailableFrame: 0, latestAvailableFrame,
        preRollValidFrames: 8_192, preRollCapacityFrames: 8_192,
        requiredPreRollFrames: 8_192,
      });
    });
    await expect(page.getByTestId('input-status')).toHaveText('INPUT READY · OUTPUT READY');
    await expect(recordButton).toBeEnabled();
  }
});

test('shared capture failure exposes diagnostics through the audio facade and keeps prior PCM', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const { TrackAudio } = await import('/src/audio/TrackAudio.ts');
    const audio = AudioEngine.getInstance();
    const browser = (audio as any).browser;
    const context = browser.context as AudioContext;
    const previous = context.createBuffer(2, 2048, context.sampleRate);
    previous.getChannelData(0).fill(0.2);
    previous.getChannelData(1).fill(-0.3);
    const restored = TrackAudio.restoreProjectBuffersAtomically(browser.tracks, [previous, null, null, null, null]);
    if (!restored.ok) throw new Error(restored.reason);
    const track = browser.tracks[0];
    await track.startRecording();
    const record = browser.inputCaptureSessions.get(0);
    if (!record) throw new Error('capture session was not reserved');
    const session = record.session;
    browser.handleInputCaptureMessage({
      type: 'CAPTURE_ERROR', trackIndex: 0, sessionId: session.sessionId,
      inputGeneration: session.inputGeneration, reason: 'input-frame-discontinuity',
      callbackFrameStart: 20_128, callbackFrameCount: 128, previousCallbackEndFrame: 20_000,
      requestedStartFrame: session.startFrame, sampleRate: context.sampleRate,
    });
    const diagnostic = audio.getUiStatus().lastInputCaptureError;
    const pcm = track.getProjectPcmSnapshot();
    return { diagnostic, left: pcm?.channelData[0]?.[0], right: pcm?.channelData[1]?.[0] };
  });
  expect(result.diagnostic?.reason).toBe('input-frame-discontinuity');
  expect(result.diagnostic?.worklet.callbackGapFrames).toBe(128);
  expect(result.diagnostic?.worklet.callbackFrameCount).toBe(128);
  expect(result.diagnostic?.audioContext.state).toBe('running');
  expect(result.left).toBeCloseTo(0.2);
  expect(result.right).toBeCloseTo(-0.3);
});
