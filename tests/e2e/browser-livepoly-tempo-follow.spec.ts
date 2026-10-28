import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('retunes a running LIVE_POLY loop smoothly with independent pitch and untouched source samples', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const loopSeconds = 1;
    const renderSeconds = 4;
    const frameCount = sampleRate * renderSeconds;
    const loopFrames = sampleRate * loopSeconds;
    const context = new OfflineAudioContext(1, frameCount, sampleRate);
    const { createLivePolyPitchNode } = await import('/src/audio/pitch/signalsmith.ts');
    const node = await createLivePolyPitchNode(context, { mode: 'LIVE_POLY', channels: 1, semitones: 0 });
    node.connect(context.destination);

    const source = new Float32Array(loopFrames);
    for (let frame = 0; frame < loopFrames; frame += 1) {
      const time = frame / sampleRate;
      source[frame] = 0.3 * (0.5 + 0.3 * Math.sin(2 * Math.PI * 2 * time))
        * Math.sin(2 * Math.PI * 440 * time);
    }
    const checksum = (samples: Float32Array): number => {
      let hash = 2166136261;
      for (const sample of samples) {
        const bits = new Uint32Array(new Float32Array([sample]).buffer)[0] ?? 0;
        hash = Math.imul(hash ^ bits, 16777619);
      }
      return hash >>> 0;
    };
    const originalChecksum = checksum(source);
    await node.loadBuffer([source]);
    await node.scheduleLoop({
      inputOffsetSeconds: 0,
      loopStartSeconds: 0,
      loopEndSeconds: loopSeconds,
      outputTime: node.latencySeconds,
      semitones: 0,
      playbackRate: 1,
      tonalityLimitHz: 6_000,
    });

    const beforeRamp = context.suspend(0.5);
    const afterRamp = context.suspend(2.2);
    const rendering = context.startRendering();
    await beforeRamp;
    const ramp = await node.setPlaybackRate(1.25, { durationSeconds: 0.4 });
    await context.resume();
    await afterRamp;
    await context.resume();
    const rendered = await rendering;
    const output = rendered.getChannelData(0);

    const goertzel = (samples: Float32Array, start: number, count: number, hz: number): number => {
      const coefficient = 2 * Math.cos(2 * Math.PI * hz / sampleRate);
      let previous = 0;
      let beforePrevious = 0;
      let mean = 0;
      for (let frame = start; frame < start + count; frame += 1) mean += samples[frame] ?? 0;
      mean /= count;
      for (let frame = start; frame < start + count; frame += 1) {
        const current = coefficient * previous - beforePrevious + (samples[frame] ?? 0) - mean;
        beforePrevious = previous;
        previous = current;
      }
      return previous * previous + beforePrevious * beforePrevious
        - coefficient * previous * beforePrevious;
    };
    const envelopePower = (hz: number): number => {
      const windowFrames = 240;
      const envelope = new Float32Array(Math.floor((1.6 * sampleRate) / windowFrames));
      for (let index = 0; index < envelope.length; index += 1) {
        const start = Math.floor(2.2 * sampleRate) + index * windowFrames;
        let square = 0;
        for (let frame = start; frame < start + windowFrames; frame += 1) {
          const sample = output[frame] ?? 0;
          square += sample * sample;
        }
        envelope[index] = Math.sqrt(square / windowFrames);
      }
      const envelopeRate = sampleRate / windowFrames;
      const coefficient = 2 * Math.cos(2 * Math.PI * hz / envelopeRate);
      let previous = 0;
      let beforePrevious = 0;
      for (const sample of envelope) {
        const current = coefficient * previous - beforePrevious + sample;
        beforePrevious = previous;
        previous = current;
      }
      return previous * previous + beforePrevious * beforePrevious
        - coefficient * previous * beforePrevious;
    };
    const carrierPower = (hz: number): number => goertzel(
      output,
      Math.floor(2.4 * sampleRate),
      Math.floor(0.5 * sampleRate),
      hz,
    );
    const adjacentSteps: number[] = [];
    for (let frame = Math.floor(1.0 * sampleRate) + 1; frame < Math.floor(2.2 * sampleRate); frame += 1) {
      adjacentSteps.push(Math.abs((output[frame] ?? 0) - (output[frame - 1] ?? 0)));
    }
    const maxAdjacentStep = Math.max(...adjacentSteps);
    return {
      sampleRate: rendered.sampleRate,
      sourceChecksumBefore: originalChecksum,
      sourceChecksumAfter: checksum(source),
      rateRamp: ramp,
      carrierAt440: carrierPower(440),
      carrierAt550: carrierPower(550),
      envelopeAt2Hz: envelopePower(2),
      envelopeAt2_5Hz: envelopePower(2.5),
      maxAdjacentStep,
      allFinite: Array.from(output).every(Number.isFinite),
    };
  });

  expect(result.sampleRate).toBe(48_000);
  expect(result.rateRamp.toRate).toBe(1.25);
  expect(result.sourceChecksumAfter).toBe(result.sourceChecksumBefore);
  expect(result.allFinite).toBe(true);
  expect(result.maxAdjacentStep).toBeLessThan(0.15);
  expect(result.carrierAt440).toBeGreaterThan(result.carrierAt550 * 8);
  expect(result.envelopeAt2_5Hz).toBeGreaterThan(result.envelopeAt2Hz * 4);
});

test('TrackAudio tempo API requires explicit source BPM and leaves loop PCM/history unchanged', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const [{ AudioEngine }, { TrackState }] = await Promise.all([
      import('/src/audio/AudioEngine.ts'),
      import('/src/core/types.ts'),
    ]);
    const appRoot = (document.querySelector('.app-root') as any)?.__vueParentComponent;
    const engine = appRoot?.setupState?.engine ?? AudioEngine.getInstance();
    const browserEngine = (engine as any).browserEngine;
    if (!browserEngine?.context || engine.getMode() !== 'browser') throw new Error('Browser audio engine is not ready');
    const track = engine.tracks[0] as any;
    const context = browserEngine.context as AudioContext;
    const loop = context.createBuffer(1, 48_000, 48_000);
    const pcm = loop.getChannelData(0);
    for (let frame = 0; frame < pcm.length; frame += 1) {
      pcm[frame] = 0.3 * Math.sin(2 * Math.PI * 440 * frame / context.sampleRate);
    }
    const source = track.audioBuffer;
    const sourceRevision = track.projectRevision;
    const sourceHistoryBytes = track.historyTotalRetainedBytes;
    const pcmView = loop.getChannelData(0);
    const pcmBefore = pcmView.slice();
    track.audioBuffer = loop;
    track.state = TrackState.STOPPED;
    await track.setLivePolyPitchEnabled(true, { semitones: 0, playbackRate: 1 });
    await track.play();
    if (!track.livePolyPitchActive) throw new Error(`LIVE_POLY did not become active: ${track.livePolyPitchFallbackReason}`);

    const invalidRatio = await track.followLivePolyTempo(100, 250).then(
      () => false,
      (error: unknown) => error instanceof RangeError && /ratio/.test(error.message),
    );
    const follow = await track.followLivePolyTempo(100, 125);
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    track.triggerRecord();
    const recordBlocked = track.state === TrackState.PLAYING
      && /Wait for or stop LIVE_POLY tempo follow/.test(track.recordingDiagnostic ?? '');
    const unchanged = pcmView.every((sample: number, index: number) => sample === pcmBefore[index]);
    const projectRevisionAfter = track.projectRevision;
    const historyBytesAfter = track.historyTotalRetainedBytes;
    const retainedSameLoop = track.audioBuffer === loop;
    const liveNode = track.livePolyPitchNode;
    const offsetBeforeStop = track.getCurrentPlaybackPosition();
    await track.stop();
    const stopOffsetPreserved = Math.abs(track.startOffset - offsetBeforeStop) < 0.03;
    const stoppedChangeRejected = await track.followLivePolyTempo(100, 125).then(
      () => false,
      (error: unknown) => error instanceof Error && /only while this track is playing/.test(error.message),
    );
    await track.play();
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    const resumedOffset = track.getCurrentPlaybackPosition();
    const expectedOffset = (offsetBeforeStop + 0.2 * 1.25) % 1;
    const resumedRatePreserved = track.livePolyPitchActive
      && Math.abs(((resumedOffset - expectedOffset + 0.5) % 1 + 1) % 1 - 0.5) < 0.1;
    await track.stop();
    if (liveNode) await liveNode.releaseWasmMemory();
    track.audioBuffer = source;
    track.state = source ? TrackState.STOPPED : TrackState.EMPTY;
    return {
      mode: engine.getMode(),
      livePolyActive: true,
      invalidRatio,
      recordBlocked,
      stoppedChangeRejected,
      stopOffsetPreserved,
      resumedRatePreserved,
      follow,
      unchanged,
      retainedSameLoop,
      projectRevisionBefore: sourceRevision,
      projectRevisionAfter,
      historyBytesBefore: sourceHistoryBytes,
      historyBytesAfter,
    };
  });

  expect(result.mode).toBe('browser');
  expect(result.livePolyActive).toBe(true);
  expect(result.invalidRatio).toBe(true);
  expect(result.recordBlocked).toBe(true);
  expect(result.stoppedChangeRejected).toBe(true);
  expect(result.stopOffsetPreserved).toBe(true);
  expect(result.resumedRatePreserved).toBe(true);
  expect(result.follow).toMatchObject({
    sourceRecordingBpm: 100,
    targetBpm: 125,
    rateRatio: 1.25,
    phaseAligned: false,
  });
  expect(result.unchanged).toBe(true);
  expect(result.retainedSameLoop).toBe(true);
  expect(result.projectRevisionAfter).toBe(result.projectRevisionBefore);
  expect(result.historyBytesAfter).toBe(result.historyBytesBefore);
});
