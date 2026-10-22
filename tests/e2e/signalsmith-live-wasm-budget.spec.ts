import { expect, test } from '@playwright/test';

test('reserves and reports actual 192 kHz LIVE_FX and LIVE_POLY WASM heaps, then releases on ACK', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 192_000;
    const context = new OfflineAudioContext(2, 256, sampleRate);
    const {
      createLiveInputTransposeNode,
      createLivePolyPitchNode,
    } = await import('/src/audio/pitch/signalsmith.ts');
    const { signalsmithLiveWasmSnapshot } = await import('/src/audio/pitch/signalsmithWasmBudget.ts');

    const liveFx = await createLiveInputTransposeNode(context, {
      mode: 'LIVE_FX', channels: 2, semitones: 24, tonalityLimitHz: sampleRate / 2,
    });
    const fxBytes = await liveFx.getWasmHeapBytes();
    const afterFx = signalsmithLiveWasmSnapshot(context);

    const livePoly = await createLivePolyPitchNode(context, {
      mode: 'LIVE_POLY', channels: 2, semitones: -24, playbackRate: 2, tonalityLimitHz: sampleRate / 2,
    });
    const loop = new Float32Array(2048);
    for (let frame = 0; frame < loop.length; frame += 1) loop[frame] = 0.2 * Math.sin(2 * Math.PI * 440 * frame / sampleRate);
    await livePoly.loadBuffer([loop, loop]);
    await livePoly.scheduleLoop({
      inputOffsetSeconds: 0,
      loopStartSeconds: 0,
      loopEndSeconds: loop.length / sampleRate,
      semitones: -24,
      playbackRate: 2,
      tonalityLimitHz: sampleRate / 2,
    });
    const polyBytes = await livePoly.getWasmHeapBytes();
    const withBoth = signalsmithLiveWasmSnapshot(context);

    await liveFx.releaseWasmMemory();
    const afterFxRelease = signalsmithLiveWasmSnapshot(context);
    await livePoly.releaseWasmMemory();
    const afterBothReleased = signalsmithLiveWasmSnapshot(context);
    return {
      actualSampleRate: context.sampleRate,
      fxBytes,
      polyBytes,
      afterFx,
      withBoth,
      afterFxRelease,
      afterBothReleased,
    };
  });

  expect(result.actualSampleRate).toBe(192_000);
  expect(result.fxBytes).toBeGreaterThan(1024 * 1024);
  expect(result.fxBytes).toBeLessThanOrEqual(20 * 64 * 1024);
  expect(result.polyBytes).toBeGreaterThan(3 * 1024 * 1024);
  expect(result.polyBytes).toBeLessThanOrEqual(64 * 64 * 1024);
  expect(result.afterFx).toMatchObject({
    processorCount: 1,
    liveFxProcessorCount: 1,
    livePolyProcessorCount: 0,
    reservedBytes: 20 * 64 * 1024,
    measuredBytes: result.fxBytes,
    pendingCount: 0,
  });
  expect(result.withBoth).toMatchObject({
    processorCount: 2,
    liveFxProcessorCount: 1,
    livePolyProcessorCount: 1,
    reservedBytes: (20 + 64) * 64 * 1024,
    measuredBytes: result.fxBytes + result.polyBytes,
    pendingCount: 0,
  });
  expect(result.afterFxRelease).toMatchObject({
    processorCount: 1,
    reservedBytes: 64 * 64 * 1024,
    measuredBytes: result.polyBytes,
    releaseUnconfirmedCount: 0,
  });
  expect(result.afterBothReleased).toMatchObject({
    processorCount: 0,
    reservedBytes: 0,
    measuredBytes: 0,
    releaseUnconfirmedCount: 0,
  });
});

test('refuses an over-budget pitch replacement while preserving the incumbent processor and audio', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    await context.resume();
    const [{ BrowserTrackFxChain }, { signalsmithLiveWasmLedger }] = await Promise.all([
      import('/src/audio/BrowserTrackFxChain.ts'),
      import('/src/audio/pitch/signalsmithWasmBudget.ts'),
    ]);
    const chain = new BrowserTrackFxChain(context, () => Promise.resolve(), () => {});
    if (!chain.setType(0, 'TRANSPOSE')) throw new Error('incumbent TRANSPOSE was rejected');
    const waitReady = async () => {
      const deadline = performance.now() + 10_000;
      while (chain.getStatus(1).slots[0]?.pendingApply && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const status = chain.getStatus(1).slots[0];
      if (status?.state !== 'ready' || status.type !== 'TRANSPOSE') throw new Error(`incumbent not ready: ${status?.error ?? status?.state}`);
    };
    await waitReady();
    chain.setParameter(0, 75); // +12 semitones, so incumbent audio has a clear frequency identity.
    chain.setActive(0, true);

    const oscillator = context.createOscillator();
    oscillator.frequency.value = 220;
    const analyser = context.createAnalyser();
    analyser.fftSize = 16_384;
    analyser.smoothingTimeConstant = 0;
    const mute = context.createGain();
    mute.gain.value = 0;
    oscillator.connect(chain.input);
    chain.output.connect(analyser);
    analyser.connect(mute);
    mute.connect(context.destination);
    oscillator.start();

    const waitAudio = async (seconds: number) => {
      const deadline = context.currentTime + seconds;
      const wallDeadline = performance.now() + 5_000;
      while (context.currentTime < deadline && performance.now() < wallDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return context.currentTime;
    };
    const scanPeak = () => {
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(spectrum);
      let peakBin = 0;
      for (let bin = 1; bin < spectrum.length; bin += 1) {
        if ((spectrum[bin] ?? Number.NEGATIVE_INFINITY) > (spectrum[peakBin] ?? Number.NEGATIVE_INFINITY)) peakBin = bin;
      }
      return peakBin * context.sampleRate / analyser.fftSize;
    };
    await waitAudio(0.6);
    const beforeHz = scanPeak();

    const ledger = signalsmithLiveWasmLedger(context);
    const syntheticLeases = [
      ...Array.from({ length: 30 }, () => ledger.reserve('LIVE_POLY')),
      ...Array.from({ length: 5 }, () => ledger.reserve('LIVE_FX')),
    ];
    const saturatedBeforeCandidate = ledger.snapshot();
    const candidateAccepted = chain.setType(0, 'OCTAVE'); // Requires three more LIVE_FX reservations.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = chain.getStatus(1).slots[0];
    const afterRejectedCandidate = ledger.snapshot();
    await waitAudio(0.6);
    const afterHz = scanPeak();

    syntheticLeases.forEach((lease) => lease.release());
    oscillator.stop();
    chain.dispose();
    await context.close();
    return {
      beforeHz,
      afterHz,
      candidateAccepted,
      status: {
        type: status?.type,
        state: status?.state,
        active: status?.active,
        warning: status?.warning,
      },
      saturatedBeforeCandidate,
      afterRejectedCandidate,
    };
  });

  expect(result.candidateAccepted).toBe(true);
  expect(result.saturatedBeforeCandidate.reservedBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
  expect(result.saturatedBeforeCandidate.reservedBytes).toBe(127.5 * 1024 * 1024);
  expect(result.afterRejectedCandidate.reservedBytes).toBe(result.saturatedBeforeCandidate.reservedBytes);
  expect(result.status.type).toBe('TRANSPOSE');
  expect(result.status.state).toBe('ready');
  expect(result.status.active).toBe(true);
  expect(result.status.warning).toContain('kept existing TRANSPOSE');
  expect(result.status.warning).toContain('would exceed the 128.00 MiB');
  expect(result.beforeHz).toBeGreaterThan(410);
  expect(result.beforeHz).toBeLessThan(470);
  expect(result.afterHz).toBeGreaterThan(410);
  expect(result.afterHz).toBeLessThan(470);
});

test('keeps an unconfirmed release charged until the AudioContext closes', async ({ page }) => {
  await page.goto('/?audio=browser');
  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    await context.resume();
    const { createLiveInputTransposeNode } = await import('/src/audio/pitch/signalsmith.ts');
    const { signalsmithLiveWasmSnapshot } = await import('/src/audio/pitch/signalsmithWasmBudget.ts');
    const node = await createLiveInputTransposeNode(context, { mode: 'LIVE_FX', channels: 2 });
    (node as unknown as { disposeWasmMemory: () => Promise<unknown> }).disposeWasmMemory =
      () => Promise.reject(new Error('injected missing disposal ACK'));
    await node.releaseWasmMemory();
    const afterUnconfirmedRelease = signalsmithLiveWasmSnapshot(context);
    const contextClosed = new Promise<void>((resolve) => {
      if (context.state === 'closed') {
        resolve();
        return;
      }
      context.addEventListener('statechange', () => {
        if (context.state === 'closed') resolve();
      }, { once: false });
    });
    await context.close();
    await contextClosed;
    const closed = context.state === 'closed';
    const afterContextClose = signalsmithLiveWasmSnapshot(context);
    return { closed, afterUnconfirmedRelease, afterContextClose };
  });

  expect(result.closed).toBe(true);
  expect(result.afterUnconfirmedRelease).toMatchObject({
    processorCount: 1,
    reservedBytes: 20 * 64 * 1024,
    releaseUnconfirmedCount: 1,
  });
  expect(result.afterContextClose).toMatchObject({
    processorCount: 0,
    reservedBytes: 0,
    releaseUnconfirmedCount: 0,
  });
});
