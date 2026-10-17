import { expect, test } from '@playwright/test';

test('sweeps up and down on a running AudioContext, then bypasses and retriggers from zero', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserPitchBendFX } = await import('/src/audio/fx/BrowserPitchBendFX.ts');
    const fx = new BrowserPitchBendFX(context);
    fx.setParam('range', 12);
    fx.setParam('time_ms', 1000);
    fx.setParam('direction', 0);
    fx.setParam('mix_percent', 100);
    await fx.ready;

    const liveNode = (fx as unknown as { pitchNode: AudioWorkletNode }).pitchNode;
    const acknowledgedPoints: Array<{ semitones: number; outputTime: number }> = [];
    liveNode.port.addEventListener('message', (event: MessageEvent) => {
      const message = event.data as [string | number, unknown];
      const value = message[1] as { semitones?: number; output?: number } | undefined;
      if (
        typeof message[0] === 'number' &&
        typeof value?.semitones === 'number' &&
        typeof value.output === 'number'
      ) {
        acknowledgedPoints.push({ semitones: value.semitones, outputTime: value.output });
      }
    });
    liveNode.port.start();

    const oscillator = context.createOscillator();
    oscillator.frequency.value = 220;
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    const silentDestination = context.createGain();
    silentDestination.gain.value = 0;
    oscillator.connect(fx.input);
    fx.output.connect(analyser);
    analyser.connect(silentDestination);
    silentDestination.connect(context.destination);
    oscillator.start();

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const peak = (lowHz: number, highHz: number): { hz: number; peakDb: number; rms: number; at: number } => {
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(spectrum);
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      let squareSum = 0;
      for (const sample of samples) squareSum += sample * sample;
      const rms = Math.sqrt(squareSum / samples.length);
      const binHz = context.sampleRate / analyser.fftSize;
      const first = Math.max(0, Math.ceil(lowHz / binHz));
      const last = Math.min(spectrum.length - 1, Math.floor(highHz / binHz));
      let bestBin = first;
      let bestDb = Number.NEGATIVE_INFINITY;
      for (let bin = first; bin <= last; bin += 1) {
        if ((spectrum[bin] ?? Number.NEGATIVE_INFINITY) > bestDb) {
          bestDb = spectrum[bin] ?? Number.NEGATIVE_INFINITY;
          bestBin = bin;
        }
      }
      return { hz: bestBin * binHz, peakDb: bestDb, rms, at: context.currentTime };
    };

    const upStartTime = context.currentTime;
    fx.setBypass(false);
    const upTimeline: Array<ReturnType<typeof peak> & { waitedMs: number; expectedHz: number }> = [];
    for (let step = 0; step < 12; step += 1) {
      await wait(100);
      const sample = peak(200, 500);
      const sweepProgress = Math.min(1, Math.max(0, sample.at - upStartTime - fx.latencySeconds));
      const expectedHz = 220 * 2 ** (12 * sweepProgress / 12);
      upTimeline.push({ waitedMs: (step + 1) * 100, ...sample, expectedHz });
    }
    const upEarlyHz = upTimeline[2]!;
    const upMidHz = upTimeline[6]!;
    const upEndHz = upTimeline[10]!;

    fx.setParam('direction', 1);
    await wait(350);
    const downEarlyHz = peak(160, 240);
    await wait(400);
    const downMidHz = peak(120, 210);
    await wait(650);
    const downEndHz = peak(90, 130);

    fx.setBypass(true);
    await wait(80);
    const bypassHz = peak(200, 240);
    fx.setBypass(false);
    await wait(180);
    const retriggerEarlyHz = peak(160, 240);
    await wait(1050);
    const retriggerEndHz = peak(90, 130);
    await wait(100);

    const { createLiveInputTransposeNode } = await import('/src/audio/pitch/signalsmith.ts');
    const scheduleProbe = await createLiveInputTransposeNode(context, {
      mode: 'LIVE_FX', channels: 1, semitones: 0,
    });
    const scheduleStart = context.currentTime + scheduleProbe.latencySeconds + 0.1;
    await scheduleProbe.setPitch(0, scheduleStart, true);
    await scheduleProbe.setPitch(2, scheduleStart + 0.02, false);
    const equalTimeRejected = await (async () => {
      try { await scheduleProbe.setPitch(4, scheduleStart + 0.02, false); return false; }
      catch { return true; }
    })();
    const reversedTimeRejected = await (async () => {
      try { await scheduleProbe.setPitch(1, scheduleStart + 0.01, false); return false; }
      catch { return true; }
    })();
    const equalTimeReplacement = await scheduleProbe.setPitch(3, scheduleStart + 0.02, true) as {
      output?: number; semitones?: number;
    };
    scheduleProbe.disconnect();

    const capacityProbe = await createLiveInputTransposeNode(context, {
      mode: 'LIVE_FX', channels: 1, semitones: 0,
    });
    const capacitySink = context.createGain();
    capacitySink.gain.value = 0;
    capacityProbe.connect(capacitySink);
    capacitySink.connect(context.destination);
    await wait(50);
    const capacityStart = context.currentTime + capacityProbe.latencySeconds + 0.1;
    const queuedPoints: Promise<unknown>[] = [];
    for (let index = 0; index < 511; index += 1) {
      queuedPoints.push(capacityProbe.setPitch((index % 49) - 24, capacityStart + index * 0.01, index === 0));
    }
    const capacityAcks = await Promise.all(queuedPoints) as Array<{
      input?: number; output?: number; semitones?: number;
    }>;
    let capacityError = '';
    try { await capacityProbe.setPitch(12, capacityStart + 5.11, false); }
    catch (cause) { capacityError = cause instanceof Error ? cause.message : String(cause); }
    const preservedCheckpoint = await capacityProbe.setPitch(7, capacityStart + 4, true) as {
      input?: number; output?: number;
    };
    const resumedQueue = await capacityProbe.setPitch(8, capacityStart + 4.01, false) as {
      input?: number; output?: number;
    };
    capacityProbe.disconnect();
    capacitySink.disconnect();

    const result = {
      state: context.state,
      sampleRate: context.sampleRate,
      latencyMs: fx.latencySeconds * 1000,
      upEarly: upEarlyHz,
      upMid: upMidHz,
      upEnd: upEndHz,
      upTimeline,
      downEarly: downEarlyHz,
      downMid: downMidHz,
      downEnd: downEndHz,
      bypass: bypassHz,
      retriggerEarly: retriggerEarlyHz,
      retriggerEnd: retriggerEndHz,
      acknowledgedCount: acknowledgedPoints.length,
      equalTimeRejected,
      reversedTimeRejected,
      equalTimeReplacement,
      scheduleStart,
      capacityError,
      capacityCount: capacityAcks.length,
      preservedCheckpoint,
      expectedCheckpointOutput: capacityAcks[400]?.output,
      expectedCheckpointInput: capacityAcks[400]?.input,
      resumedQueue,
      expectedResumeOutput: capacityAcks[401]?.output,
      expectedResumeInput: capacityAcks[401]?.input,
      acknowledgementsInTimeOrder: acknowledgedPoints.every((point, index, points) =>
        index === 0 || point.outputTime >= points[index - 1]!.outputTime),
      firstAcknowledgement: acknowledgedPoints[0],
      lastAcknowledgement: acknowledgedPoints.at(-1),
      error: fx.error,
    };
    oscillator.stop();
    fx.dispose();
    await context.close();
    return result;
  });

  expect(result.state).toBe('running');
  expect(result.sampleRate).toBe(48_000);
  expect(result.latencyMs).toBeGreaterThan(0);
  expect(result.latencyMs).toBeLessThanOrEqual(25);
  expect(result.error).toBe('');
  expect(result.upEarly.rms).toBeGreaterThan(0.02);
  expect(result.upMid.rms).toBeGreaterThan(0.02);
  expect(result.upEnd.rms).toBeGreaterThan(0.02);
  expect(result.upEarly.peakDb).toBeGreaterThan(-70);
  expect(result.upMid.peakDb).toBeGreaterThan(-70);
  expect(result.upEnd.peakDb).toBeGreaterThan(-70);
  expect(result.upEarly.hz).toBeGreaterThan(230);
  expect(result.upMid.hz).toBeGreaterThan(result.upEarly.hz);
  expect(result.upEnd.hz).toBeGreaterThan(410);
  expect(result.upEnd.hz).toBeLessThan(470);
  expect(result.downEarly.hz).toBeGreaterThan(result.downMid.hz);
  expect(result.downEnd.hz).toBeLessThan(result.downMid.hz);
  expect(result.downEnd.hz).toBeGreaterThan(90);
  expect(result.downEnd.hz).toBeLessThan(130);
  expect(result.bypass.hz).toBeGreaterThan(210);
  expect(result.bypass.hz).toBeLessThan(230);
  expect(result.retriggerEarly.hz).toBeGreaterThan(170);
  expect(result.retriggerEarly.hz).toBeLessThan(240);
  expect(result.retriggerEnd.hz).toBeGreaterThan(90);
  expect(result.retriggerEnd.hz).toBeLessThan(130);
  expect(result.acknowledgedCount).toBe(154);
  expect(result.acknowledgementsInTimeOrder).toBe(true);
  expect(result.firstAcknowledgement?.semitones).toBe(0);
  expect(result.firstAcknowledgement?.outputTime).toBeLessThan(result.lastAcknowledgement?.outputTime ?? 0);
  expect(result.equalTimeRejected).toBe(true);
  expect(result.reversedTimeRejected).toBe(true);
  expect(result.equalTimeReplacement.output).toBeCloseTo(result.scheduleStart + 0.02, 5);
  expect(result.equalTimeReplacement.semitones).toBe(3);
  expect(result.capacityCount).toBe(511);
  expect(result.capacityError).toContain('current 512; cap 512; queue unchanged');
  expect(result.preservedCheckpoint.output).toBeCloseTo(result.expectedCheckpointOutput ?? 0, 6);
  expect(result.preservedCheckpoint.input).toBeCloseTo(result.expectedCheckpointInput ?? 0, 6);
  expect(result.resumedQueue.output).toBeCloseTo(result.expectedResumeOutput ?? 0, 6);
  expect(result.resumedQueue.input).toBeCloseTo(result.expectedResumeInput ?? 0, 6);
  for (const index of [0, 2, 4, 6, 8, 10]) {
    const checkpoint = result.upTimeline[index]!;
    expect(checkpoint.peakDb).toBeGreaterThan(-40);
    expect(Math.abs(checkpoint.hz - checkpoint.expectedHz)).toBeLessThan(checkpoint.expectedHz * 0.1);
  }
});
