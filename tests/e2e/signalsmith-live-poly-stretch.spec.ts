import { expect, test } from '@playwright/test';

async function renderSignalsmithLivePoly(
  page: import('@playwright/test').Page,
  pitchOnLoop: boolean,
  retuneAgain = false,
) {
  await page.goto('/?audio=browser');

  return page.evaluate(async ({ scheduleSevenOnLoop, retuneAgain: shouldRetuneAgain }) => {
    const sampleRate = 48_000;
    const loopSeconds = 1;
    const renderSeconds = 4;
    const frameCount = Math.round(sampleRate * renderSeconds);
    const loopFrameCount = Math.round(sampleRate * loopSeconds);
    const context = new OfflineAudioContext(1, frameCount, sampleRate);

    const { createLivePolyPitchNode } = await import('/src/audio/pitch/signalsmith.ts');
    const pitchNode = await createLivePolyPitchNode(context, {
      mode: 'LIVE_POLY',
      channels: 1,
      semitones: 0,
    });
    pitchNode.connect(context.destination);

    const loop = new Float32Array(loopFrameCount);
    for (let frame = 0; frame < loop.length; frame += 1) {
      loop[frame] = 0.25 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
    }

    // Start a level sine loop and wait for both setup RPCs. The live-retune
    // test will change pitch after OfflineAudioContext has advanced and
    // suspended, exercising the same command timing as an active loop.
    const loadAck = pitchNode.loadBuffer([loop]);
    const scheduleAck = pitchNode.scheduleLoop({
      inputOffsetSeconds: 0,
      loopStartSeconds: 0,
      loopEndSeconds: loopSeconds,
      outputTime: pitchNode.latencySeconds,
      semitones: scheduleSevenOnLoop ? 7 : 0,
      playbackRate: 0.8,
      tonalityLimitHz: 6000,
    });
    const loadedEndSeconds = await loadAck;
    const scheduled = await scheduleAck;
    let pitched = null;
    let pitchedLate = null;
    let pitchOutputTime = pitchNode.latencySeconds;
    let latePitchOutputTime: number | null = null;
    let rendered: AudioBuffer;
    if (scheduleSevenOnLoop) {
      rendered = await context.startRendering();
    } else {
      const suspensionAtHalfSecond = context.suspend(0.5);
      const suspensionAfterLoopWrap = shouldRetuneAgain ? context.suspend(2) : null;
      const rendering = context.startRendering();
      await suspensionAtHalfSecond;
      pitchOutputTime = context.currentTime + pitchNode.latencySeconds;
      pitched = await pitchNode.setPitch(7, pitchOutputTime);
      await context.resume();
      if (suspensionAfterLoopWrap) {
        await suspensionAfterLoopWrap;
        latePitchOutputTime = context.currentTime + pitchNode.latencySeconds;
        pitchedLate = await pitchNode.setPitch(12, latePitchOutputTime);
        await context.resume();
      }
      rendered = await rendering;
    }
    const samples = rendered.getChannelData(0);

    let finiteSamples = 0;
    let nonSilentSamples = 0;
    let peak = 0;
    let totalSquare = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i] ?? 0;
      if (Number.isFinite(sample)) finiteSamples += 1;
      if (Math.abs(sample) > 1e-6) nonSilentSamples += 1;
      peak = Math.max(peak, Math.abs(sample));
      totalSquare += sample * sample;
    }

    function goertzelPower(segment: Float32Array, hz: number) {
      const coefficient = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
      let previous = 0;
      let beforePrevious = 0;
      let mean = 0;
      for (const sample of segment) mean += sample;
      mean /= segment.length;
      for (const sample of segment) {
        const current = coefficient * previous - beforePrevious + sample - mean;
        beforePrevious = previous;
        previous = current;
      }
      return previous * previous + beforePrevious * beforePrevious
        - coefficient * previous * beforePrevious;
    }

    function estimateFrequency(segment: Float32Array) {
      // Scan a broad 300–1000 Hz tonal range. Autocorrelation's octave/subharmonic
      // peaks are ambiguous for 880 Hz, so choose the spectral power peak and
      // refine it with a parabolic fit.
      const minHz = 300;
      const maxHz = 1000;
      const magnitudes = new Float64Array(maxHz - minHz + 1);
      let bestIndex = 0;
      for (let hz = minHz; hz <= maxHz; hz += 1) {
        const power = goertzelPower(segment, hz);
        const index = hz - minHz;
        magnitudes[index] = power;
        if (power > magnitudes[bestIndex]!) bestIndex = index;
      }
      const left = magnitudes[bestIndex - 1] ?? magnitudes[bestIndex]!;
      const center = magnitudes[bestIndex]!;
      const right = magnitudes[bestIndex + 1] ?? magnitudes[bestIndex]!;
      const curvature = left - 2 * center + right;
      const fractionalOffset = curvature === 0
        ? 0
        : Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / curvature));
      return minHz + bestIndex + fractionalOffset;
    }

    function estimateWindow(startSeconds: number, endSeconds: number) {
      return estimateFrequency(samples.subarray(
        Math.floor(sampleRate * startSeconds),
        Math.floor(sampleRate * endSeconds),
      ));
    }

    function windowTonePowers(startSeconds: number, endSeconds: number) {
      const segment = samples.subarray(
        Math.floor(sampleRate * startSeconds),
        Math.floor(sampleRate * endSeconds),
      );
      return [440, 660, 880].map((hz) => [hz, goertzelPower(segment, hz)]);
    }

    const analyzerCalibrationHz = [440, 660, 880].map((hz) => {
      const calibration = new Float32Array(Math.round(sampleRate * 0.4));
      for (let frame = 0; frame < calibration.length; frame += 1) {
        calibration[frame] = 0.2 * Math.sin((2 * Math.PI * hz * frame) / sampleRate);
      }
      return estimateFrequency(calibration);
    });

    const firstPitchStart = pitchOutputTime;
    const beforeFirstPitchHz = scheduleSevenOnLoop
      ? null
      : estimateWindow(0.35, 0.48);
    const afterFirstPitchHz = estimateWindow(
      firstPitchStart + 0.2,
      shouldRetuneAgain && latePitchOutputTime !== null
        ? latePitchOutputTime - 0.1
        : firstPitchStart + 0.9,
    );
    const afterLatePitchHz = shouldRetuneAgain && latePitchOutputTime !== null
      ? estimateWindow(latePitchOutputTime + 0.2, latePitchOutputTime + 0.9)
      : null;

    function scheduleSummary(schedule: typeof scheduled) {
      return schedule && {
        input: schedule.input,
        output: schedule.output,
        outputTime: schedule.outputTime,
        semitones: schedule.semitones,
        tonalityHz: schedule.tonalityHz,
        loopStart: schedule.loopStart,
        loopEnd: schedule.loopEnd,
        rate: schedule.rate,
        active: schedule.active,
      };
    }

    return {
      sampleRate: rendered.sampleRate,
      frameCount: rendered.length,
      latencySamples: pitchNode.latencySamples,
      latencySeconds: pitchNode.latencySeconds,
      loadedEndSeconds,
      schedule: scheduleSummary(scheduled),
      firstPitch: scheduleSummary(pitched),
      latePitch: scheduleSummary(pitchedLate),
      pitchOutputTime,
      latePitchOutputTime,
      finiteSamples,
      nonSilentSamples,
      peak,
      rms: Math.sqrt(totalSquare / samples.length),
      beforeFirstPitchHz,
      afterFirstPitchHz,
      afterLatePitchHz,
      analyzerCalibrationHz,
      beforeTonePowers: windowTonePowers(0.35, 0.48),
      afterFirstTonePowers: windowTonePowers(firstPitchStart + 0.2, latePitchOutputTime !== null ? latePitchOutputTime - 0.1 : firstPitchStart + 0.9),
      afterLateTonePowers: latePitchOutputTime !== null ? windowTonePowers(latePitchOutputTime + 0.2, latePitchOutputTime + 0.9) : null,
    };
  }, { scheduleSevenOnLoop: pitchOnLoop, retuneAgain });
}

function assertPitchResult(result: Awaited<ReturnType<typeof renderSignalsmithLivePoly>>) {
  expect(result.sampleRate).toBe(48_000);
  expect(result.frameCount).toBe(192_000);
  expect(result.latencySamples).toBeGreaterThan(0);
  expect(Number.isFinite(result.latencySeconds)).toBe(true);
  expect(result.latencySeconds).toBeGreaterThan(0);
  expect(Math.abs(result.latencySeconds * result.sampleRate - result.latencySamples)).toBeLessThanOrEqual(1);
  expect(result.loadedEndSeconds).toBeCloseTo(1, 6);
  expect(result.finiteSamples).toBe(result.frameCount);
  expect(result.nonSilentSamples).toBeGreaterThan(50_000);
  expect(result.peak).toBeGreaterThan(0.01);
  expect(result.rms).toBeGreaterThan(0.005);
}

test('retunes a running Signalsmith LIVE_POLY loop by +7 semitones in Chromium', async ({ page }) => {
  const result = await renderSignalsmithLivePoly(page, false, true);
  console.log('Signalsmith LIVE_POLY sequential live-retune diagnostics', JSON.stringify(result));
  assertPitchResult(result);
  expect(result.schedule).toMatchObject({
    input: 0,
    output: result.latencySeconds,
    semitones: 0,
    tonalityHz: 6000,
    loopStart: 0,
    loopEnd: 1,
    rate: 0.8,
    active: true,
  });
  expect(result.firstPitch).toMatchObject({
    semitones: 7,
    tonalityHz: 6000,
    loopStart: 0,
    loopEnd: 1,
    rate: 0.8,
    active: true,
  });
  expect(result.firstPitch?.output).toBeCloseTo(result.pitchOutputTime, 6);
  const expectedInputAtRetune = result.schedule.input
    + ((result.pitchOutputTime - result.schedule.output) * result.schedule.rate);
  expect(result.firstPitch?.input).toBeCloseTo(expectedInputAtRetune, 5);
  expect(result.firstPitch?.rate).toBeCloseTo(0.8, 6);
  expect(result.firstPitch?.tonalityHz).toBe(6000);
  expect(result.latePitch).toMatchObject({
    semitones: 12,
    tonalityHz: 6000,
    loopStart: 0,
    loopEnd: 1,
    rate: 0.8,
    active: true,
  });
  expect(result.latePitch?.output).toBeCloseTo(result.latePitchOutputTime!, 6);
  expect(result.latePitchOutputTime).toBeGreaterThan(2);
  const expectedLateInputAtRetune = (result.schedule.input
    + ((result.latePitchOutputTime! - result.schedule.output) * result.schedule.rate)) % 1;
  expect(result.latePitch?.input).toBeCloseTo(expectedLateInputAtRetune, 5);
  expect(result.latePitch?.rate).toBeCloseTo(0.8, 6);
  expect(result.latePitch?.tonalityHz).toBe(6000);
  expect(result.analyzerCalibrationHz).toHaveLength(3);
  result.analyzerCalibrationHz.forEach((frequency, index) => {
    expect(frequency).toBeCloseTo([440, 660, 880][index]!, 0);
  });
  const expectedInputHz = 440;
  const expectedFirstPitchHz = 440 * 2 ** (7 / 12);
  expect(result.beforeFirstPitchHz).not.toBeNull();
  expect(result.beforeFirstPitchHz!).toBeGreaterThan(expectedInputHz * 0.97);
  expect(result.beforeFirstPitchHz!).toBeLessThan(expectedInputHz * 1.03);
  const beforePowers = Object.fromEntries(result.beforeTonePowers) as Record<number, number>;
  expect(beforePowers[440]).toBeGreaterThan(beforePowers[660]! * 10);
  expect(beforePowers[440]).toBeGreaterThan(beforePowers[880]! * 10);
  expect(result.afterFirstPitchHz).toBeGreaterThan(expectedFirstPitchHz * 0.97);
  expect(result.afterFirstPitchHz).toBeLessThan(expectedFirstPitchHz * 1.03);
  const firstPowers = Object.fromEntries(result.afterFirstTonePowers) as Record<number, number>;
  expect(firstPowers[660]).toBeGreaterThan(firstPowers[440]! * 10);
  expect(firstPowers[660]).toBeGreaterThan(firstPowers[880]! * 10);
  const expectedLatePitchHz = 440 * 2 ** (12 / 12);
  expect(result.afterLatePitchHz).not.toBeNull();
  expect(result.afterLatePitchHz!).toBeGreaterThan(expectedLatePitchHz * 0.97);
  expect(result.afterLatePitchHz!).toBeLessThan(expectedLatePitchHz * 1.03);
  const latePowers = Object.fromEntries(result.afterLateTonePowers!) as Record<number, number>;
  expect(latePowers[880]).toBeGreaterThan(latePowers[440]! * 10);
  expect(latePowers[880]).toBeGreaterThan(latePowers[660]! * 10);
});

test('renders a +7 semitone Signalsmith LIVE_POLY loop from its initial schedule', async ({ page }) => {
  const result = await renderSignalsmithLivePoly(page, true);
  console.log('Signalsmith LIVE_POLY loop-pitch control', JSON.stringify(result));
  assertPitchResult(result);
  expect(result.schedule).toMatchObject({
    input: 0,
    output: result.latencySeconds,
    semitones: 7,
    loopStart: 0,
    loopEnd: 1,
    rate: 0.8,
    tonalityHz: 6000,
    active: true,
  });
  const expectedFrequencyHz = 440 * 2 ** (7 / 12);
  expect(result.afterFirstPitchHz).toBeGreaterThan(expectedFrequencyHz * 0.97);
  expect(result.afterFirstPitchHz).toBeLessThan(expectedFrequencyHz * 1.03);
});

test('measures sequential LIVE_POLY retunes in a running AudioContext after loop wraps', async ({ page }) => {
  await page.goto('/?audio=browser');
  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const loopSeconds = 1;
    const { createLivePolyPitchNode } = await import('/src/audio/pitch/signalsmith.ts');
    const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    await context.resume();
    if (context.state !== 'running') throw new Error(`AudioContext is not running: ${context.state}`);

    const pitchNode = await createLivePolyPitchNode(context, {
      mode: 'LIVE_POLY',
      channels: 1,
      semitones: 0,
      playbackRate: 0.8,
      tonalityLimitHz: 6000,
    });
    const loop = new Float32Array(sampleRate * loopSeconds);
    for (let frame = 0; frame < loop.length; frame += 1) {
      loop[frame] = 0.25 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
    }
    const loadedEndSeconds = await pitchNode.loadBuffer([loop]);
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    pitchNode.connect(analyser);
    analyser.connect(context.destination);

    const initial = await pitchNode.scheduleLoop({
      inputOffsetSeconds: 0,
      loopStartSeconds: 0,
      loopEndSeconds: loopSeconds,
      outputTime: context.currentTime + pitchNode.latencySeconds,
      semitones: 0,
      playbackRate: 0.8,
      tonalityLimitHz: 6000,
    });

    const waitUntil = async (timeSeconds: number) => {
      const deadline = performance.now() + 8_000;
      while (context.currentTime < timeSeconds) {
        if (performance.now() > deadline) {
          throw new Error(`AudioContext clock did not reach ${timeSeconds.toFixed(3)} seconds`);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
    };

    const scanFrequency = () => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      let total = 0;
      for (const sample of samples) total += sample;
      const mean = total / samples.length;
      let bestFrequency = 0;
      let bestPower = -Infinity;
      const powers = new Map<number, number>();
      for (let frequency = 300; frequency <= 1000; frequency += 1) {
        const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
        let previous = 0;
        let beforePrevious = 0;
        for (const sample of samples) {
          const current = coefficient * previous - beforePrevious + sample - mean;
          beforePrevious = previous;
          previous = current;
        }
        const power = previous * previous + beforePrevious * beforePrevious
          - coefficient * previous * beforePrevious;
        powers.set(frequency, power);
        if (power > bestPower) {
          bestPower = power;
          bestFrequency = frequency;
        }
      }
      return {
        frequencyHz: bestFrequency,
        peakPower: bestPower,
        powersAtExpectedTones: [440, 659, 660, 880].map((frequency) => [frequency, powers.get(frequency) ?? 0]),
        rms: Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length),
      };
    };

    // Capture the original tone before the first live command, then issue both
    // retunes after separate output-loop wraps while callbacks are advancing.
    await waitUntil(initial.outputTime + 0.28);
    const before = scanFrequency();
    await waitUntil(initial.outputTime + loopSeconds + 0.12);
    const firstPitch = await pitchNode.setPitch(7);
    await waitUntil(firstPitch.outputTime + 0.28);
    const afterFirst = scanFrequency();
    await waitUntil(firstPitch.outputTime + loopSeconds + 0.12);
    const latePitch = await pitchNode.setPitch(12);
    await waitUntil(latePitch.outputTime + 0.28);
    const afterLate = scanFrequency();

    const output = {
      sampleRate: context.sampleRate,
      contextState: context.state,
      loadedEndSeconds,
      latencySamples: pitchNode.latencySamples,
      latencySeconds: pitchNode.latencySeconds,
      elapsedAudioSeconds: context.currentTime,
      initial: {
        outputTime: initial.outputTime,
        semitones: initial.semitones,
        rate: initial.rate,
        tonalityHz: initial.tonalityHz,
        loopStart: initial.loopStart,
        loopEnd: initial.loopEnd,
      },
      firstPitch: {
        outputTime: firstPitch.outputTime,
        semitones: firstPitch.semitones,
        rate: firstPitch.rate,
        tonalityHz: firstPitch.tonalityHz,
        loopStart: firstPitch.loopStart,
        loopEnd: firstPitch.loopEnd,
      },
      latePitch: {
        outputTime: latePitch.outputTime,
        semitones: latePitch.semitones,
        rate: latePitch.rate,
        tonalityHz: latePitch.tonalityHz,
        loopStart: latePitch.loopStart,
        loopEnd: latePitch.loopEnd,
      },
      before,
      afterFirst,
      afterLate,
    };
    await pitchNode.stopProcessing();
    pitchNode.disconnect();
    await context.close();
    return output;
  });

  console.log('Signalsmith LIVE_POLY running AudioContext retune diagnostics', JSON.stringify(result));
  expect(result.sampleRate).toBe(48_000);
  expect(result.contextState).toBe('running');
  expect(result.loadedEndSeconds).toBeCloseTo(1, 6);
  expect(result.latencySamples).toBeGreaterThan(0);
  expect(result.latencySeconds).toBeCloseTo(result.latencySamples / result.sampleRate, 6);
  expect(result.initial).toMatchObject({ semitones: 0, rate: 0.8, tonalityHz: 6000, loopStart: 0, loopEnd: 1 });
  expect(result.firstPitch).toMatchObject({ semitones: 7, rate: 0.8, tonalityHz: 6000, loopStart: 0, loopEnd: 1 });
  expect(result.latePitch).toMatchObject({ semitones: 12, rate: 0.8, tonalityHz: 6000, loopStart: 0, loopEnd: 1 });
  expect(result.before.frequencyHz).toBeGreaterThan(426);
  expect(result.before.frequencyHz).toBeLessThan(454);
  expect(result.before.rms).toBeGreaterThan(0.01);
  expect(result.afterFirst.frequencyHz).toBeGreaterThan(639);
  expect(result.afterFirst.frequencyHz).toBeLessThan(679);
  expect(result.afterFirst.rms).toBeGreaterThan(0.01);
  expect(result.afterLate.frequencyHz).toBeGreaterThan(853);
  expect(result.afterLate.frequencyHz).toBeLessThan(907);
  expect(result.afterLate.rms).toBeGreaterThan(0.01);
});
