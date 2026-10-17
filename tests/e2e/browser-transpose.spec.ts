import { expect, test } from '@playwright/test';

test('runs connected live-input TRANSPOSE at the full ±24-semitone range in Chromium', async ({ page }) => {
  await page.goto('/?audio=browser');

  const results = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = sampleRate;
    const scenarios = [-24, -12, 12, 24];
    const results: Array<{
      semitones: number;
      expectedHz: number;
      measuredHz: number;
      expectedPower: number;
      inputPower: number;
      outputRms: number;
      latencyMs: number;
    }> = [];

    const powerAt = (channel: Float32Array, start: number, end: number, frequency: number): number => {
      const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
      let previous = 0;
      let beforePrevious = 0;
      let mean = 0;
      for (let index = start; index < end; index += 1) mean += channel[index] ?? 0;
      mean /= end - start;
      for (let index = start; index < end; index += 1) {
        const current = coefficient * previous - beforePrevious + (channel[index] ?? 0) - mean;
        beforePrevious = previous;
        previous = current;
      }
      return previous * previous + beforePrevious * beforePrevious
        - coefficient * previous * beforePrevious;
    };

    for (const semitones of scenarios) {
      const context = new OfflineAudioContext(2, frameCount, sampleRate);
      const { BrowserTransposeFX } = await import('/src/audio/fx/BrowserTransposeFX.ts');
      const fx = new BrowserTransposeFX(context as unknown as AudioContext);
      fx.setParam('shift', semitones);
      await fx.ready;
      fx.setBypass(false);

      const buffer = context.createBuffer(2, frameCount, sampleRate);
      for (let frame = 0; frame < frameCount; frame += 1) {
        const sample = 0.25 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate);
        buffer.getChannelData(0)[frame] = sample;
        buffer.getChannelData(1)[frame] = sample * 0.7;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(fx.input);
      fx.output.connect(context.destination);
      source.start(0);

      const rendered = await context.startRendering();
      const samples = rendered.getChannelData(0);
      const start = Math.round(sampleRate * 0.28);
      const end = Math.round(sampleRate * 0.9);
      const expectedHz = 220 * 2 ** (semitones / 12);
      const stepHz = Math.max(0.2, expectedHz / 120);
      let measuredHz = expectedHz;
      let expectedPower = 0;
      for (let frequency = expectedHz * 0.92; frequency <= expectedHz * 1.08; frequency += stepHz) {
        const power = powerAt(samples, start, end, frequency);
        if (power > expectedPower) {
          expectedPower = power;
          measuredHz = frequency;
        }
      }
      const inputPower = powerAt(samples, start, end, 220);
      let square = 0;
      for (let frame = start; frame < end; frame += 1) square += (samples[frame] ?? 0) ** 2;
      const outputRms = Math.sqrt(square / (end - start));
      results.push({ semitones, expectedHz, measuredHz, expectedPower, inputPower, outputRms, latencyMs: fx.latencySeconds * 1000 });
      fx.dispose();
    }
    return results;
  });

  for (const result of results) {
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.latencyMs).toBeLessThanOrEqual(25);
    // Tolerance: ±4% peak-bin frequency, at least 8x target-vs-original-tone
    // spectral power, and output RMS between 0.65x and 1.3x the input sine RMS.
    expect(result.measuredHz).toBeGreaterThan(result.expectedHz * 0.96);
    expect(result.measuredHz).toBeLessThan(result.expectedHz * 1.04);
    expect(result.expectedPower).toBeGreaterThan(result.inputPower * 8);
    expect(result.outputRms).toBeGreaterThan((0.25 / Math.sqrt(2)) * 0.65);
    expect(result.outputRms).toBeLessThan((0.25 / Math.sqrt(2)) * 1.3);
  }
});

test('keeps the connected live TRANSPOSE dry path aligned and bypasses to the direct path', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = sampleRate / 2;
    const render = async (mix: number, bypassed: boolean) => {
      const context = new OfflineAudioContext(1, frameCount, sampleRate);
      const { BrowserTransposeFX } = await import('/src/audio/fx/BrowserTransposeFX.ts');
      const fx = new BrowserTransposeFX(context as unknown as AudioContext);
      fx.setParam('mix', mix);
      fx.setBypass(bypassed);
      await fx.ready;
      fx.setBypass(bypassed);
      const buffer = context.createBuffer(1, frameCount, sampleRate);
      const input = buffer.getChannelData(0);
      for (let frame = 0; frame < frameCount; frame += 1) {
        input[frame] = 0.25 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(fx.input);
      fx.output.connect(context.destination);
      source.start(0);
      const output = (await context.startRendering()).getChannelData(0);
      const start = Math.round(sampleRate * 0.18);
      const end = Math.round(sampleRate * 0.42);
      let square = 0;
      for (let frame = start; frame < end; frame += 1) square += (output[frame] ?? 0) ** 2;
      const rms = Math.sqrt(square / (end - start));
      const directError = bypassed
        ? Math.max(...Array.from({ length: 256 }, (_, frame) => Math.abs((output[frame] ?? 0) - (input[frame] ?? 0))))
        : null;
      const latencyMs = fx.latencySeconds * 1000;
      fx.dispose();
      return { rms, directError, latencyMs };
    };
    return {
      dry: await render(0, false),
      halfMix: await render(50, false),
      bypass: await render(100, true),
    };
  });

  expect(result.dry.latencyMs).toBeGreaterThan(0);
  expect(result.dry.latencyMs).toBeLessThanOrEqual(25);
  expect(result.dry.rms).toBeGreaterThan(0.1);
  expect(result.halfMix.rms / result.dry.rms).toBeGreaterThan(0.9);
  expect(result.halfMix.rms / result.dry.rms).toBeLessThan(1.1);
  expect(result.bypass.directError).toBeLessThan(1e-6);
});

test('changes pitch on a running AudioContext after the Signalsmith delay', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserTransposeFX } = await import('/src/audio/fx/BrowserTransposeFX.ts');
    const fx = new BrowserTransposeFX(context);
    fx.setParam('shift', 12);
    await fx.ready;
    fx.setBypass(false);

    const oscillator = context.createOscillator();
    oscillator.frequency.value = 220;
    const analyser = context.createAnalyser();
    analyser.fftSize = 32_768;
    analyser.smoothingTimeConstant = 0;
    const silentDestination = context.createGain();
    silentDestination.gain.value = 0;
    oscillator.connect(fx.input);
    fx.output.connect(analyser);
    analyser.connect(silentDestination);
    silentDestination.connect(context.destination);
    oscillator.start();
    await new Promise((resolve) => setTimeout(resolve, 900));

    const spectrum = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(spectrum);
    const binHz = context.sampleRate / analyser.fftSize;
    const maximumNear = (frequency: number): number => {
      const center = Math.round(frequency / binHz);
      let maximum = Number.NEGATIVE_INFINITY;
      for (let bin = Math.max(0, center - 3); bin <= Math.min(spectrum.length - 1, center + 3); bin += 1) {
        maximum = Math.max(maximum, spectrum[bin] ?? Number.NEGATIVE_INFINITY);
      }
      return maximum;
    };
    const result = {
      state: context.state,
      sampleRate: context.sampleRate,
      latencyMs: fx.latencySeconds * 1000,
      targetDb: maximumNear(440),
      sourceDb: maximumNear(220),
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
  expect(result.targetDb).toBeGreaterThan(result.sourceDb + 10);
});
