import { expect, test } from '@playwright/test';

test('connects Browser AUTO RIFF onset events to the real Signalsmith LIVE_FX shifter', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserAutoRiffFX } = await import('/src/audio/fx/BrowserAutoRiffFX.ts');
    const fx = new BrowserAutoRiffFX(context, async () => {
      await context.audioWorklet.addModule('/worklets/fx-processor.js');
    });
    fx.setParam('bpm', 300);
    fx.setParam('scale', 1);
    fx.setParam('rate_beats', 0.25);
    fx.setParam('sensitivity_percent', 75);
    fx.setParam('mix_percent', 100);
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
    await new Promise((resolve) => setTimeout(resolve, 1_200));

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
    const response = {
      state: context.state,
      sampleRate: context.sampleRate,
      latencyMs: fx.latencySeconds * 1000,
      error: fx.error,
      sourceDb: maximumNear(220),
      riffTargetDb: maximumNear(185),
    };
    oscillator.stop();
    fx.dispose();
    await context.close();
    return response;
  });

  expect(result.state).toBe('running');
  expect(result.sampleRate).toBe(48_000);
  expect(result.latencyMs).toBeGreaterThan(0);
  expect(result.latencyMs).toBeLessThanOrEqual(50);
  expect(result.error).toBe('');
  expect(result.riffTargetDb).toBeGreaterThan(result.sourceDb + 6);
});

test('routes AUTO RIFF through the BrowserAudioEngine Track A catalog slot', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const { BrowserAudioEngine } = await import('/src/audio/BrowserAudioEngine.ts');
    const engine = new BrowserAudioEngine();
    const context = engine.context;
    await context.resume();
    engine.setFxType('track', 0, 'AUTO RIFF (EXPERIMENTAL)');
    engine.setFxNamedParameters('track', 0, {
      bpm: 300,
      scale: 1,
      rate_beats: 0.25,
      sensitivity_percent: 75,
      mix_percent: 100,
    });
    engine.setFxActive('track', 0, true);

    const oscillator = context.createOscillator();
    oscillator.frequency.value = 220;
    const analyser = context.createAnalyser();
    analyser.fftSize = 32_768;
    analyser.smoothingTimeConstant = 0;
    const mute = context.createGain();
    mute.gain.value = 0;
    oscillator.connect(engine.trackMixNode);
    engine.outputFxChain.output.connect(analyser);
    analyser.connect(mute);
    mute.connect(context.destination);
    oscillator.start();

    const spectrum = new Float32Array(analyser.frequencyBinCount);
    const binHz = context.sampleRate / analyser.fftSize;
    const maximumNear = (frequency: number): number => {
      const center = Math.round(frequency / binHz);
      let maximum = Number.NEGATIVE_INFINITY;
      for (let bin = Math.max(0, center - 3); bin <= Math.min(spectrum.length - 1, center + 3); bin += 1) {
        maximum = Math.max(maximum, spectrum[bin] ?? Number.NEGATIVE_INFINITY);
      }
      return maximum;
    };
    let sourceDb = Number.NEGATIVE_INFINITY;
    let riffTargetDb = Number.NEGATIVE_INFINITY;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      analyser.getFloatFrequencyData(spectrum);
      sourceDb = maximumNear(220);
      riffTargetDb = maximumNear(185);
      if (Number.isFinite(sourceDb) && riffTargetDb > sourceDb + 6) break;
    }
    const response = {
      state: context.state,
      sampleRate: context.sampleRate,
      error: engine.getUiStatus().lastError,
      sourceDb,
      riffTargetDb,
    };
    oscillator.stop();
    await context.close();
    return response;
  });

  expect(result.state).toBe('running');
  expect(result.sampleRate).toBeGreaterThan(8_000);
  expect(result.error).toBe('');
  expect(result.riffTargetDb).toBeGreaterThan(result.sourceDb + 6);
});
