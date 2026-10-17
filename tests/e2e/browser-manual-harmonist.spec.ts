import { expect, test } from '@playwright/test';

test('adds two independently shifted voices on a running AudioContext with centered dry, shared pan, mix and direct bypass', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserManualHarmonistFX } = await import('/src/audio/fx/BrowserManualHarmonistFX.ts');
    const fx = new BrowserManualHarmonistFX(context);
    fx.setParam('voice_1_interval', 7);
    fx.setParam('voice_2_interval', 12);
    fx.setParam('mix_percent', 100);
    fx.setParam('pan_percent', 100);
    await fx.ready;

    const oscillator = context.createOscillator();
    oscillator.frequency.value = 220;
    const splitter = context.createChannelSplitter(2);
    const leftAnalyser = context.createAnalyser();
    const rightAnalyser = context.createAnalyser();
    leftAnalyser.fftSize = 16_384;
    rightAnalyser.fftSize = 16_384;
    leftAnalyser.smoothingTimeConstant = 0;
    rightAnalyser.smoothingTimeConstant = 0;
    const silentDestination = context.createGain();
    silentDestination.gain.value = 0;
    oscillator.connect(fx.input);
    fx.output.connect(splitter);
    splitter.connect(leftAnalyser, 0);
    splitter.connect(rightAnalyser, 1);
    leftAnalyser.connect(silentDestination);
    rightAnalyser.connect(silentDestination);
    silentDestination.connect(context.destination);
    oscillator.start();
    fx.setBypass(false);

    const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const peakNear = (analyser: AnalyserNode, frequency: number): { hz: number; db: number } => {
      const values = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(values);
      const binHz = context.sampleRate / analyser.fftSize;
      const centerBin = Math.round(frequency / binHz);
      const radiusBins = Math.max(2, Math.ceil(frequency * 0.04 / binHz));
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
      leftDry: peakNear(leftAnalyser, 220),
      rightDry: peakNear(rightAnalyser, 220),
      leftThird: peakNear(leftAnalyser, 220 * 2 ** (7 / 12)),
      rightThird: peakNear(rightAnalyser, 220 * 2 ** (7 / 12)),
      leftOctave: peakNear(leftAnalyser, 440),
      rightOctave: peakNear(rightAnalyser, 440),
      at: context.currentTime,
    });

    await wait(1100);
    const active = read();
    fx.setParam('mix_percent', 0);
    await wait(450);
    const dryOnly = read();
    fx.setParam('mix_percent', 100);
    await wait(100);
    fx.setBypass(true);
    await wait(450);
    const bypass = read();
    const state = context.state;
    const sampleRate = context.sampleRate;
    const latencyMs = fx.latencySeconds * 1000;
    oscillator.stop();
    fx.dispose();
    await context.close();
    return { state, sampleRate, latencyMs, active, dryOnly, bypass };
  });

  expect(result.state).toBe('running');
  expect(result.sampleRate).toBe(48_000);
  expect(result.latencyMs).toBeGreaterThan(0);
  expect(result.latencyMs).toBeLessThanOrEqual(25);
  expect(result.active.rightThird.hz).toBeGreaterThan(310);
  expect(result.active.rightThird.hz).toBeLessThan(350);
  expect(result.active.rightOctave.hz).toBeGreaterThan(420);
  expect(result.active.rightOctave.hz).toBeLessThan(460);
  expect(result.active.rightThird.db).toBeGreaterThan(-50);
  expect(result.active.rightOctave.db).toBeGreaterThan(-50);
  expect(result.active.rightThird.db).toBeGreaterThan(result.active.leftThird.db + 6);
  expect(result.active.rightOctave.db).toBeGreaterThan(result.active.leftOctave.db + 6);
  expect(result.active.leftDry.db).toBeGreaterThan(-40);
  expect(result.active.rightDry.db).toBeGreaterThan(-40);
  expect(Math.abs(result.active.leftDry.db - result.dryOnly.leftDry.db)).toBeLessThan(4);
  expect(Math.abs(result.active.rightDry.db - result.dryOnly.rightDry.db)).toBeLessThan(4);
  expect(result.dryOnly.rightThird.db).toBeLessThan(result.active.rightThird.db - 10);
  expect(result.dryOnly.rightOctave.db).toBeLessThan(result.active.rightOctave.db - 10);
  expect(result.bypass.leftDry.db).toBeGreaterThan(-40);
  expect(result.bypass.rightDry.db).toBeGreaterThan(-40);
  expect(result.bypass.rightThird.db).toBeLessThan(result.active.rightThird.db - 10);
  expect(result.bypass.rightOctave.db).toBeLessThan(result.active.rightOctave.db - 10);
});
