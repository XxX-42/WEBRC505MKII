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
    let rejectComplete!: (error: Error) => void;
    const ready = new Promise<any>((resolve) => { resolveReady = resolve; });
    const complete = new Promise<any>((resolve, reject) => { resolveComplete = resolve; rejectComplete = reject; });
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
          type: 'RECYCLE_CHUNK', trackIndex: 0, sessionId: 1, chunkIndex: message.chunkIndex,
          channels: returnedChannels,
        }, returnedChannels.map((channel) => channel.buffer));
      } else if (message.type === 'INPUT_CAPTURE_READY') {
        resolveReady(message);
      } else if (message.type === 'RECORD_COMPLETE') {
        resolveComplete(message);
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
      startFrame, maxRecordingBytes: 1024 * 1024,
    });
    node.port.postMessage({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 1, stopFrame });
    const completed = await Promise.race([
      complete,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`recording completion timed out: ${JSON.stringify(messages)}`)), 5_000)),
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
      completed, chunks: messages,
    };
  });

  expect(capture.completed).toMatchObject({
    requestedStartFrame: capture.startFrame,
    stopFrame: capture.stopFrame,
    framesCaptured: capture.stopFrame - capture.startFrame,
    channelCount: 2,
    status: 'complete',
  });
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
    await new Promise((resolve) => setTimeout(resolve, 200));
    gain.gain.setValueAtTime(0.6, context.currentTime);
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && track.state !== 'RECORDING') await new Promise((resolve) => setTimeout(resolve, 10));
    if (track.state !== 'RECORDING' || track.autoRecArmed) throw new Error('Input trigger did not acknowledge recording');
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
      const sampleRate = browser.context.sampleRate;
      browser.handleInputCaptureMessage({
        type: 'INPUT_CAPTURE_NOT_READY', inputGeneration: generation, sampleRate,
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
      const sampleRate = browser.context.sampleRate;
      const latestAvailableFrame = 8_192;
      browser.handleInputCaptureMessage({
        type: 'INPUT_CAPTURE_READY', inputGeneration: generation, sampleRate,
        oldestAvailableFrame: 0, latestAvailableFrame,
        preRollValidFrames: 8_192, preRollCapacityFrames: 8_192,
        requiredPreRollFrames: 8_192,
      });
    });
    await expect(page.getByTestId('input-status')).toHaveText('INPUT READY · OUTPUT READY');
    await expect(recordButton).toBeEnabled();
  }
});
