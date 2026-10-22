import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('a suspended AudioContext cannot leave a shared recording stuck busy or corrupt a resumed take', async ({ page }) => {
  await page.goto('/?audio=browser');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const { AudioEngine } = await loadModule('/src/audio/AudioEngine.ts');
    const engine = AudioEngine.getInstance();
    const browser = (engine as any).browser;
    const context = browser.context as AudioContext;
    const track = engine.tracks[0] as any;
    const source = context.createOscillator();
    const sourceGain = context.createGain();
    source.frequency.value = 440;
    sourceGain.gain.value = 0.2;
    source.connect(sourceGain).connect(browser.inputFxChain.input);
    source.start();
    if (context.state !== 'running' || !browser.inputCaptureNode) {
      throw new Error(`Expected the production shared Browser AudioWorklet, state=${context.state}`);
    }

    const digest = async (buffer: AudioBuffer | null) => {
      if (!buffer) return null;
      const interleaved = new Float32Array(buffer.length * buffer.numberOfChannels);
      for (let frame = 0; frame < buffer.length; frame += 1) {
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          interleaved[frame * buffer.numberOfChannels + channel] = buffer.getChannelData(channel)[frame]!;
        }
      }
      const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(interleaved.buffer));
      return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
    };
    const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 8_000) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${label}; state=${context.state}; busy=${track.historyBusy}; diagnostic=${track.recordingDiagnostic ?? 'none'}`);
    };

    // Seed a real incumbent loop and an undo entry so timeout preservation is
    // observable by exact PCM hash and the history state, not just UI flags.
    track.resumeAfterRecording = false;
    const seed = (offset: number) => [
      Float32Array.from({ length: 4_096 }, (_, frame) => Math.fround(Math.sin(frame * 0.017) * 0.3 + offset)),
      Float32Array.from({ length: 4_096 }, (_, frame) => Math.fround(Math.cos(frame * 0.023) * 0.2 - offset)),
    ];
    track.processRecordedBuffers(seed(0.01));
    track.processRecordedBuffers(seed(-0.02));
    track.stop();
    const incumbentHash = await digest(track.audioBuffer as AudioBuffer);
    const historyBefore = { canUndo: track.canUndo, canRedo: track.canRedo, retainedBytes: track.historyTotalRetainedBytes };
    if (!historyBefore.canUndo) throw new Error('Fixture failed to create an undoable incumbent loop');

    const captureNode = browser.inputCaptureNode as AudioWorkletNode;
    const oldMessages: Array<{ type: string; sessionId: number }> = [];
    const originalHandler = captureNode.port.onmessage;
    captureNode.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; sessionId?: number };
      if (typeof message.type === 'string' && Number.isSafeInteger(message.sessionId)) {
        oldMessages.push({ type: message.type, sessionId: message.sessionId! });
      }
      originalHandler?.call(captureNode.port, event);
    };

    await track.startRecording();
    const abandonedSession = track.recordingCaptureSession;
    if (!abandonedSession) throw new Error('Recording did not use the shared capture worklet');
    await waitFor(() => oldMessages.some((message) => message.sessionId === abandonedSession.sessionId
      && message.type === 'RECORD_CHUNK'), 'an actual captured input chunk', 5_000);
    await context.suspend();
    if (context.state !== 'suspended') throw new Error(`AudioContext did not suspend: ${context.state}`);

    // Suspending the context alone does not guarantee a missing STOP ACK:
    // the worklet may finish exactly from its retained input pre-roll. Drop
    // just this test's STOP control message to exercise the bounded watchdog
    // cleanup path, while leaving the later ABORT and real PCM capture alone.
    const port = captureNode.port as any;
    const originalPostMessage = captureNode.port.postMessage.bind(captureNode.port);
    let stopMessageDropped = false;
    port.postMessage = (message: any, transfer?: Transferable[]) => {
      if (message?.type === 'STOP_CAPTURE' && message.sessionId === abandonedSession.sessionId) {
        stopMessageDropped = true;
        return;
      }
      if (transfer === undefined) originalPostMessage(message);
      else originalPostMessage(message, transfer);
    };
    await track.stopRecording();
    port.postMessage = originalPostMessage;
    if (!stopMessageDropped) throw new Error('Fault fixture did not drop the requested STOP_CAPTURE message');
    if (!track.historyBusy) throw new Error('Expected pending stop ACK while the context is suspended');

    // The product watchdog is 5s; keep a little test margin for browser timer scheduling.
    await waitFor(() => !track.historyBusy, 'bounded stop-ACK failure', 8_000);
    const timeoutHash = await digest(track.audioBuffer as AudioBuffer);
    const timeoutHistory = { canUndo: track.canUndo, canRedo: track.canRedo, retainedBytes: track.historyTotalRetainedBytes };
    if (timeoutHash !== incumbentHash || JSON.stringify(timeoutHistory) !== JSON.stringify(historyBefore)) {
      throw new Error(`Stop timeout changed incumbent PCM or undo history: ${JSON.stringify({ incumbentHash, timeoutHash, historyBefore, timeoutHistory, diagnostic: track.recordingDiagnostic })}`);
    }
    if (track.recordingCaptureSession !== null || !String(track.recordingDiagnostic).includes('incomplete take was discarded')) {
      throw new Error(`Timeout did not clearly release/discard the pending take: ${track.recordingDiagnostic}`);
    }

    await context.resume();
    await waitFor(() => context.state === 'running', 'AudioContext resume');
    await waitFor(() => oldMessages.some((message) => message.sessionId === abandonedSession.sessionId
      && (message.type === 'RECORD_COMPLETE' || message.type === 'RECORD_ABORTED' || message.type === 'CAPTURE_ERROR')),
    'late terminal message from the abandoned capture', 5_000);
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const afterLateAckHash = await digest(track.audioBuffer as AudioBuffer);
    const afterLateAckHistory = { canUndo: track.canUndo, canRedo: track.canRedo, retainedBytes: track.historyTotalRetainedBytes };
    if (afterLateAckHash !== incumbentHash || JSON.stringify(afterLateAckHistory) !== JSON.stringify(historyBefore)
      || track.historyBusy || track.recordingCaptureSession !== null) {
      throw new Error('Late stop ACK from the abandoned capture mutated PCM/history or re-locked the track');
    }

    const resumedAttemptIds: number[] = [];
    const resumedInputGapDiagnostics: string[] = [];
    let retrySessionId: number | null = null;
    let retryHash: string | null = null;
    let finalFrames = 0;
    // A missed AudioWorklet quantum is a real capture failure, not a test-only
    // success. The worklet must reject it and preserve the incumbent; only then
    // may this recovery test wait for a fresh pre-roll and try again. This does
    // not claim uninterrupted capture across a forward frame gap.
    for (let attempt = 0; attempt < 4 && retryHash === null; attempt += 1) {
      await waitFor(() => browser.getUiStatus().inputCaptureReady === true,
        'the shared capture pre-roll to warm before retry', 8_000);
      await track.startRecording();
      const retrySession = track.recordingCaptureSession;
      if (!retrySession || retrySession.sessionId === abandonedSession.sessionId
        || resumedAttemptIds.includes(retrySession.sessionId)) {
        throw new Error('A unique shared capture session was not admitted after resumed cleanup');
      }
      resumedAttemptIds.push(retrySession.sessionId);

      const captureWindowEnd = performance.now() + 300;
      while (performance.now() < captureWindowEnd
        && track.recordingCaptureSession?.sessionId === retrySession.sessionId
        && !String(track.recordingDiagnostic ?? '').startsWith('Shared input capture failed:')) {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      if (track.recordingCaptureSession?.sessionId === retrySession.sessionId) {
        await track.stopRecording();
      }
      await waitFor(() => !track.historyBusy && track.recordingCaptureSession === null,
        'retry capture completion or explicit rejection', 5_000);

      const retryDiagnostic = String(track.recordingDiagnostic ?? '');
      if (retryDiagnostic.startsWith('Shared input capture failed:')) {
        if (!retryDiagnostic.includes('input-frame-discontinuity')) {
          throw new Error(`Resumed capture failed for an unexpected reason: ${retryDiagnostic}`);
        }
        const rejectedPcmHash = await digest(track.audioBuffer as AudioBuffer);
        const rejectedHistory = { canUndo: track.canUndo, canRedo: track.canRedo,
          retainedBytes: track.historyTotalRetainedBytes };
        if (rejectedPcmHash !== incumbentHash || JSON.stringify(rejectedHistory) !== JSON.stringify(historyBefore)) {
          throw new Error(`A discontinuous resumed capture changed incumbent PCM/history: ${JSON.stringify({
            incumbentHash, rejectedPcmHash, historyBefore, rejectedHistory, retryDiagnostic,
          })}`);
        }
        resumedInputGapDiagnostics.push(retryDiagnostic);
        if (attempt === 3) {
          throw new Error(`Four resumed captures were explicitly rejected for frame discontinuity: ${JSON.stringify(resumedInputGapDiagnostics)}`);
        }
        continue;
      }

      retryHash = await digest(track.audioBuffer as AudioBuffer);
      retrySessionId = retrySession.sessionId;
      finalFrames = track.audioBuffer?.length ?? 0;
      if (!retryHash || retryHash === incumbentHash || track.canUndo !== true) {
        throw new Error('The resumed retry did not install a new undoable recording');
      }
    }
    if (!retryHash || retrySessionId === null) throw new Error('No resumed recording completed successfully');

    captureNode.port.onmessage = originalHandler;
    track.stop();
    source.stop();
    return {
      incumbentHash, timeoutHash, afterLateAckHash, retryHash,
      historyBefore, timeoutHistory, afterLateAckHistory,
      abandonedSessionId: abandonedSession.sessionId, retrySessionId, resumedAttemptIds, resumedInputGapDiagnostics,
      lateTerminal: oldMessages.find((message) => message.sessionId === abandonedSession.sessionId
        && (message.type === 'RECORD_COMPLETE' || message.type === 'RECORD_ABORTED' || message.type === 'CAPTURE_ERROR')),
      finalFrames,
    };
  });

  console.info('Post-suspend capture retries', JSON.stringify({
    attempts: result.resumedAttemptIds.length,
    rejectedForwardGaps: result.resumedInputGapDiagnostics.length,
    diagnostics: result.resumedInputGapDiagnostics,
  }));
  expect(result.timeoutHash).toBe(result.incumbentHash);
  expect(result.afterLateAckHash).toBe(result.incumbentHash);
  expect(result.timeoutHistory).toEqual(result.historyBefore);
  expect(result.afterLateAckHistory).toEqual(result.historyBefore);
  expect(result.retrySessionId).not.toBe(result.abandonedSessionId);
  expect(result.resumedAttemptIds).toContain(result.retrySessionId);
  expect(result.resumedInputGapDiagnostics.every((diagnostic: string) => diagnostic.includes('input-frame-discontinuity'))).toBe(true);
  expect(result.lateTerminal?.sessionId).toBe(result.abandonedSessionId);
  expect(result.retryHash).not.toBe(result.incumbentHash);
  expect(result.finalFrames).toBeGreaterThan(2_000);
});

test('a shared capture receives its exact stop ACK while running and keeps the committed take after suspension', async ({ page }) => {
  await page.goto('/?audio=browser');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const { AudioEngine } = await loadModule('/src/audio/AudioEngine.ts');
    const engine = AudioEngine.getInstance();
    const browser = (engine as any).browser;
    const context = browser.context as AudioContext;
    const track = engine.tracks[0] as any;
    const node = browser.inputCaptureNode as AudioWorkletNode;
    const source = context.createOscillator();
    const sourceGain = context.createGain();
    source.frequency.value = 440;
    sourceGain.gain.value = 0.2;
    source.connect(sourceGain).connect(browser.inputFxChain.input);
    source.start();
    const terminals: Array<{ type: string; requestedStartFrame: number; stopFrame: number; framesCaptured: number; droppedFrames: number }> = [];
    const originalHandler = node.port.onmessage;
    node.port.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === 'RECORD_COMPLETE') terminals.push({
        type: message.type,
        requestedStartFrame: message.requestedStartFrame,
        stopFrame: message.stopFrame,
        framesCaptured: message.framesCaptured,
        droppedFrames: message.droppedFrames,
      });
      originalHandler?.call(node.port, event);
    };
    const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 5_000) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${label}; state=${context.state}; diagnostic=${track.recordingDiagnostic ?? 'none'}`);
    };

    await track.startRecording();
    const session = track.recordingCaptureSession;
    if (!session) throw new Error('The real shared input-capture session was not created');
    await waitFor(() => track.recordingStoredFrames >= 16_384, 'a captured input chunk');
    await track.stopRecording();
    await waitFor(() => track.recordingCaptureSession === null && !track.historyBusy, 'normal stop completion while the worklet is running');
    const terminal = terminals.find((message) => message.type === 'RECORD_COMPLETE');
    const audioFrames = track.audioBuffer?.length ?? 0;
    const diagnosticBeforeSuspend = track.recordingDiagnostic;
    const committedFramesBeforeSuspend = track.audioBuffer?.length ?? 0;
    await context.suspend();
    if (context.state !== 'suspended') throw new Error(`AudioContext did not suspend: ${context.state}`);
    const committedFramesAfterSuspend = track.audioBuffer?.length ?? 0;
    const diagnosticAfterSuspend = track.recordingDiagnostic;
    node.port.onmessage = originalHandler;
    source.stop();
    return { terminal, audioFrames, diagnosticBeforeSuspend, diagnosticAfterSuspend,
      committedFramesBeforeSuspend, committedFramesAfterSuspend, state: context.state };
  });

  expect(result.state).toBe('suspended');
  expect(result.terminal).toBeDefined();
  expect(result.terminal!.framesCaptured).toBe(result.terminal!.stopFrame - result.terminal!.requestedStartFrame);
  expect(result.terminal!.droppedFrames).toBe(0);
  expect(result.audioFrames).toBeGreaterThan(2_000);
  expect(result.diagnosticBeforeSuspend).toBeNull();
  expect(result.diagnosticAfterSuspend).toBeNull();
  expect(result.committedFramesAfterSuspend).toBe(result.committedFramesBeforeSuspend);
  expect(result.committedFramesAfterSuspend).toBe(result.audioFrames);
});
