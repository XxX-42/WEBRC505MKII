import { expect, test } from '@playwright/test';

test('produces the three octave targets from a competing harmonic input and scales the harmony layer', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserOctaveFX } = await import('/src/audio/fx/BrowserOctaveFX.ts');
    const fx = new BrowserOctaveFX(context);
    await fx.ready;

    fx.setParam('minus_24_level', 100);
    fx.setParam('minus_12_level', 100);
    fx.setParam('plus_12_level', 100);
    fx.setParam('mix_percent', 100);

    const inputComponents: OscillatorNode[] = [];
    for (const [frequency, amplitude] of [[220, 0.23], [330, 0.15], [660, 0.09]] as const) {
      const oscillator = context.createOscillator();
      const level = context.createGain();
      oscillator.frequency.value = frequency;
      level.gain.value = amplitude;
      oscillator.connect(level);
      level.connect(fx.input);
      oscillator.start();
      inputComponents.push(oscillator);
    }

    const analyser = context.createAnalyser();
    analyser.fftSize = 32_768;
    analyser.smoothingTimeConstant = 0;
    const silentSink = context.createGain();
    silentSink.gain.value = 0;
    fx.output.connect(analyser);
    analyser.connect(silentSink);
    silentSink.connect(context.destination);

    const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const peakNear = (frequency: number) => {
      const values = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(values);
      const binHz = context.sampleRate / analyser.fftSize;
      const centerBin = Math.round(frequency / binHz);
      const radiusBins = Math.max(3, Math.ceil(frequency * 0.04 / binHz));
      let bestBin = centerBin;
      let bestDb = Number.NEGATIVE_INFINITY;
      for (let bin = Math.max(1, centerBin - radiusBins); bin <= Math.min(values.length - 1, centerBin + radiusBins); bin += 1) {
        const db = values[bin] ?? Number.NEGATIVE_INFINITY;
        if (db > bestDb) {
          bestDb = db;
          bestBin = bin;
        }
      }
      return { hz: bestBin * binHz, db: bestDb };
    };
    const read = () => ({
      at: context.currentTime,
      minus24: peakNear(55),
      minus12: peakNear(110),
      source: peakNear(220),
      competingFundamental: peakNear(330),
      plus12: peakNear(440),
      competingHarmonic: peakNear(660),
      finiteOutput: (() => {
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return samples.every(Number.isFinite);
      })(),
    });

    fx.setBypass(false);
    await wait(1_050);
    const allVoices = read();

    fx.setParam('minus_24_level', 0);
    fx.setParam('minus_12_level', 0);
    fx.setParam('plus_12_level', 0);
    await wait(300);
    const dryOnly = read();

    fx.setParam('minus_24_level', 100);
    fx.setParam('mix_percent', 100);
    await wait(450);
    const fullLevel = read();
    fx.setParam('minus_24_level', 25);
    await wait(350);
    const quarterLevel = read();
    fx.setParam('mix_percent', 50);
    await wait(300);
    const halfMix = read();
    fx.setParam('mix_percent', 0);
    await wait(300);
    const zeroMix = read();
    fx.setBypass(true);
    await wait(300);
    const bypass = read();

    const latencyMs = fx.latencySeconds * 1000;
    const sampleRate = context.sampleRate;
    inputComponents.forEach((oscillator) => oscillator.stop());
    fx.dispose();
    await context.close();
    return { sampleRate, latencyMs, allVoices, dryOnly, fullLevel, quarterLevel, halfMix, zeroMix, bypass };
  });

  expect(result.sampleRate).toBe(48_000);
  expect(result.latencyMs).toBeGreaterThan(0);
  expect(result.latencyMs).toBeLessThanOrEqual(25);
  expect(result.allVoices.minus24.hz).toBeGreaterThan(50);
  expect(result.allVoices.minus24.hz).toBeLessThan(62);
  expect(result.allVoices.minus12.hz).toBeGreaterThan(104);
  expect(result.allVoices.minus12.hz).toBeLessThan(116);
  expect(result.allVoices.plus12.hz).toBeGreaterThan(420);
  expect(result.allVoices.plus12.hz).toBeLessThan(460);
  expect(result.allVoices.minus24.db).toBeGreaterThan(-50);
  expect(result.allVoices.minus12.db).toBeGreaterThan(-50);
  expect(result.allVoices.plus12.db).toBeGreaterThan(-50);
  expect(result.allVoices.competingFundamental.db).toBeGreaterThan(-45);
  expect(result.allVoices.competingHarmonic.db).toBeGreaterThan(-45);
  expect(Math.abs(result.allVoices.source.db - result.dryOnly.source.db)).toBeLessThan(4);
  expect(result.fullLevel.minus24.db - result.zeroMix.minus24.db).toBeGreaterThan(15);
  expect(result.quarterLevel.minus24.db - result.zeroMix.minus24.db).toBeGreaterThan(12);
  expect(result.quarterLevel.minus24.db - result.halfMix.minus24.db).toBeGreaterThan(3);
  expect(result.quarterLevel.minus24.db - result.halfMix.minus24.db).toBeLessThan(15);
  expect(result.zeroMix.minus24.db).toBeLessThan(result.fullLevel.minus24.db - 15);
  expect(result.zeroMix.source.db).toBeGreaterThan(-45);
  expect(Math.abs(result.bypass.source.db - result.zeroMix.source.db)).toBeLessThan(3);
  expect(result.allVoices.finiteOutput).toBe(true);
  expect(result.bypass.finiteOutput).toBe(true);
});

test('aligns active dry to voice latency and keeps bypass on a direct zero-latency path', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserOctaveFX } = await import('/src/audio/fx/BrowserOctaveFX.ts');
    const fx = new BrowserOctaveFX(context);
    await fx.ready;
    fx.setParam('minus_24_level', 0);
    fx.setParam('minus_12_level', 0);
    fx.setParam('plus_12_level', 0);

    const source = context.createOscillator();
    source.frequency.value = 29;
    source.connect(fx.input);
    const merger = context.createChannelMerger(2);
    source.connect(merger, 0, 0);
    fx.output.connect(merger, 0, 1);
    const recorder = context.createScriptProcessor(4096, 2, 2);
    const frames: Array<[Float32Array, Float32Array]> = [];
    recorder.onaudioprocess = (event) => {
      frames.push([
        new Float32Array(event.inputBuffer.getChannelData(0)),
        new Float32Array(event.inputBuffer.getChannelData(1)),
      ]);
      if (frames.length > 60) frames.shift();
    };
    merger.connect(recorder);
    const silentSink = context.createGain();
    silentSink.gain.value = 0;
    recorder.connect(silentSink);
    silentSink.connect(context.destination);
    source.start();

    const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const estimateLagSamples = (maxLag: number) => {
      const totalSamples = frames.reduce((sum, frame) => sum + frame[0].length, 0);
      const input = new Float32Array(totalSamples);
      const output = new Float32Array(totalSamples);
      let write = 0;
      for (const [inputFrame, outputFrame] of frames) {
        input.set(inputFrame, write);
        output.set(outputFrame, write);
        write += inputFrame.length;
      }
      const analysisLength = Math.min(16_384, totalSamples);
      const inputWindow = input.subarray(totalSamples - analysisLength);
      const outputWindow = output.subarray(totalSamples - analysisLength);
      let bestLag = 0;
      let bestCorrelation = Number.NEGATIVE_INFINITY;
      const start = maxLag + 16;
      const end = analysisLength - maxLag - 16;
      for (let lag = 0; lag <= maxLag; lag += 1) {
        let dot = 0;
        let inputEnergy = 0;
        let outputEnergy = 0;
        for (let index = start; index < end; index += 1) {
          const a = inputWindow[index - lag] ?? 0;
          const b = outputWindow[index] ?? 0;
          dot += a * b;
          inputEnergy += a * a;
          outputEnergy += b * b;
        }
        const correlation = dot / Math.sqrt(inputEnergy * outputEnergy);
        if (correlation > bestCorrelation) {
          bestCorrelation = correlation;
          bestLag = lag;
        }
      }
      return { samples: bestLag, correlation: bestCorrelation, sampleCount: analysisLength };
    };

    fx.setBypass(false);
    await wait(850);
    const active = estimateLagSamples(Math.round(context.sampleRate * 0.033));
    const latencySamples = fx.latencySamples;
    frames.length = 0;
    fx.setBypass(true);
    await wait(500);
    const bypass = estimateLagSamples(100);
    const latencyMs = fx.latencySeconds * 1000;
    source.stop();
    fx.dispose();
    await context.close();
    return { latencySamples, latencyMs, active, bypass };
  });

  expect(result.latencyMs).toBeGreaterThan(0);
  expect(result.active.sampleCount).toBeGreaterThan(8_000);
  expect(result.active.correlation).toBeGreaterThan(0.95);
  expect(Math.abs(result.active.samples - result.latencySamples)).toBeLessThanOrEqual(80);
  expect(result.active.samples).toBeGreaterThan(result.bypass.samples + 100);
  expect(result.bypass.correlation).toBeGreaterThan(0.95);
  expect(result.bypass.samples).toBeLessThanOrEqual(8);
});
