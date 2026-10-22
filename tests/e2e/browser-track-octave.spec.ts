import { expect, test, type Locator } from '@playwright/test';
import { openFxEditor } from './uiHelpers';

test('routes three fixed Signalsmith OCTAVE voices through one private track chain', async ({ page }) => {
  await page.goto('/?audio=browser');
  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserTrackFxChain } = await import('/src/audio/BrowserTrackFxChain.ts');
    const ensureModule = () => context.audioWorklet.addModule('/worklets/fx-processor.js');
    const effected = new BrowserTrackFxChain(context, ensureModule);
    const neighbor = new BrowserTrackFxChain(context, ensureModule);
    if (!effected.setType(0, 'OCTAVE')) throw new Error('private OCTAVE adapter was rejected');

    const readinessDeadline = performance.now() + 10_000;
    while (effected.getStatus(1).slots[0]?.pendingApply && performance.now() < readinessDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ready = effected.getStatus(1).slots[0];
    if (ready?.state !== 'ready' || ready.type !== 'OCTAVE') {
      throw new Error(`private OCTAVE did not become ready: ${ready?.error ?? ready?.state}`);
    }
    if (!effected.setNamedParameters(0, {
      minus_24_level: 100,
      minus_12_level: 100,
      plus_12_level: 100,
      mix_percent: 100,
    })) throw new Error('private OCTAVE parameters were rejected');
    if (!effected.setActive(0, true)) throw new Error('private OCTAVE could not be activated');

    const output = context.createAnalyser();
    const neighborOutput = context.createAnalyser();
    const inputOutput = context.createAnalyser();
    for (const analyser of [output, neighborOutput, inputOutput]) {
      analyser.fftSize = 32_768;
      analyser.smoothingTimeConstant = 0;
    }
    const mute = context.createGain();
    mute.gain.value = 0;
    effected.output.connect(output);
    neighbor.output.connect(neighborOutput);
    effected.input.connect(inputOutput);
    for (const analyser of [output, neighborOutput, inputOutput]) analyser.connect(mute);
    mute.connect(context.destination);

    const sources: OscillatorNode[] = [];
    for (const [frequency, amplitude] of [[220, 0.23], [330, 0.15], [660, 0.09]] as const) {
      const oscillator = context.createOscillator();
      const level = context.createGain();
      oscillator.frequency.value = frequency;
      level.gain.value = amplitude;
      oscillator.connect(level);
      level.connect(effected.input);
      oscillator.start();
      sources.push(oscillator);
    }
    const neighborSource = context.createOscillator();
    neighborSource.frequency.value = 330;
    neighborSource.connect(neighbor.input);
    neighborSource.start();

    const peakNear = (analyser: AnalyserNode, frequency: number) => {
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(spectrum);
      const binHz = sampleRate / analyser.fftSize;
      const center = Math.round(frequency / binHz);
      const radius = Math.max(3, Math.ceil(frequency * 0.04 / binHz));
      let peakBin = center;
      let peakDb = Number.NEGATIVE_INFINITY;
      for (let bin = Math.max(1, center - radius); bin <= Math.min(spectrum.length - 1, center + radius); bin += 1) {
        if ((spectrum[bin] ?? Number.NEGATIVE_INFINITY) > peakDb) {
          peakBin = bin;
          peakDb = spectrum[bin] ?? Number.NEGATIVE_INFINITY;
        }
      }
      return { hz: peakBin * binHz, db: peakDb };
    };
    const waitAudio = async (seconds: number) => {
      const deadline = context.currentTime + seconds;
      const wallDeadline = performance.now() + 5_000;
      while (context.currentTime < deadline && performance.now() < wallDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return context.currentTime;
    };
    const started = context.currentTime;
    const after = await waitAudio(1.3);
    const status = effected.getStatus(1).slots[0];
    const measurement = {
      contextState: context.state,
      sampleRate: context.sampleRate,
      state: status?.state,
      active: status?.active,
      resourceNote: status?.resourceNote,
      audioElapsed: after - started,
      source220: peakNear(inputOutput, 220),
      minus24_55: peakNear(output, 55),
      minus12_110: peakNear(output, 110),
      dry220: peakNear(output, 220),
      neighbor330: peakNear(neighborOutput, 330),
      plus12_440: peakNear(output, 440),
    };
    sources.forEach((oscillator) => oscillator.stop());
    neighborSource.stop();
    effected.dispose();
    neighbor.dispose();
    await context.close();
    return measurement;
  });

  expect(result.contextState).toBe('running');
  expect(result.sampleRate).toBe(48_000);
  expect(result.state).toBe('ready');
  expect(result.active).toBe(true);
  expect(result.resourceNote).toContain('Live Signalsmith WASM reserved');
  expect(result.audioElapsed).toBeGreaterThanOrEqual(1.3);
  expect(result.source220.db).toBeGreaterThan(-60);
  expect(result.minus24_55.hz).toBeGreaterThan(50);
  expect(result.minus24_55.hz).toBeLessThan(62);
  expect(result.minus12_110.hz).toBeGreaterThan(104);
  expect(result.minus12_110.hz).toBeLessThan(116);
  expect(result.dry220.db).toBeGreaterThan(-45);
  expect(result.neighbor330.db).toBeGreaterThan(-40);
  expect(result.plus12_440.hz).toBeGreaterThan(420);
  expect(result.plus12_440.hz).toBeLessThan(460);
  expect(result.minus24_55.db).toBeGreaterThan(-50);
  expect(result.minus12_110.db).toBeGreaterThan(-50);
  expect(result.plus12_440.db).toBeGreaterThan(-50);
});

test('per-track LCD persists the OCTAVE voice levels and mix', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  const startButton = page.getByTestId('start-audio');
  if ((await startButton.innerText()).trim() !== 'READY') await startButton.click();
  await expect(startButton).toHaveText('READY', { timeout: 25_000 });
  await expect(page.getByTestId('input-status')).toContainText('OUTPUT READY');
  const panel = await openFxEditor(page, 'track');
  await panel.getByLabel('Track FX target', { exact: true }).selectOption('2');
  await panel.getByLabel('Per-track FX type', { exact: true }).selectOption('OCTAVE');
  await expect(panel.locator('[data-track-fx-runtime-status]')).toContainText('READY', { timeout: 10_000 });
  await expect(panel.locator('[data-track-fx-resource-warning]')).toContainText('Live Signalsmith WASM reserved');
  await panel.locator('summary').click();

  const setNumber = async (locator: Locator, value: number) => {
    await locator.fill(String(value));
    await locator.dispatchEvent('change');
  };
  await setNumber(panel.getByLabel('Track 2 slot A minus_24_level', { exact: true }), 60);
  await setNumber(panel.getByLabel('Track 2 slot A minus_12_level', { exact: true }), 35);
  await setNumber(panel.getByLabel('Track 2 slot A plus_12_level', { exact: true }), 80);
  await setNumber(panel.getByLabel('Track 2 slot A mix_percent', { exact: true }), 75);
  await panel.getByLabel('Toggle per-track FX slot', { exact: true }).click();

  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('webrc505_browser_per_track_fx_v1') ?? '{}') as {
      target?: number;
      tracks?: Array<{ slots?: Array<{ type?: string; active?: boolean; namedParameters?: Record<string, number> }> }>;
    };
    const slot = saved.tracks?.[1]?.slots?.[0];
    return saved.target === 2 && slot?.type === 'OCTAVE' && slot.active === true
      && slot.namedParameters?.minus_24_level === 60
      && slot.namedParameters?.minus_12_level === 35
      && slot.namedParameters?.plus_12_level === 80
      && slot.namedParameters?.mix_percent === 75;
  });
});
