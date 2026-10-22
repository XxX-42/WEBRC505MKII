import { expect, test, type Locator } from '@playwright/test';
import { openFxEditor } from './uiHelpers';

test('routes experimental AUTO RIFF through one private A–D chain with transport tempo and track isolation', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserTrackFxChain } = await import('/src/audio/BrowserTrackFxChain.ts');
    const ensureModule = () => context.audioWorklet.addModule('/worklets/fx-processor.js');
    const effected = new BrowserTrackFxChain(context, ensureModule, () => {}, () => 300);
    const neighbor = new BrowserTrackFxChain(context, ensureModule);
    if (!effected.setType(0, 'AUTO RIFF (EXPERIMENTAL)')) throw new Error('private AUTO RIFF adapter was rejected');

    const readinessDeadline = performance.now() + 10_000;
    while (effected.getStatus(1).slots[0]?.pendingApply && performance.now() < readinessDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ready = effected.getStatus(1).slots[0];
    if (ready?.state !== 'ready' || ready.type !== 'AUTO RIFF (EXPERIMENTAL)') {
      throw new Error(`private AUTO RIFF did not become ready: ${ready?.error ?? ready?.state}`);
    }
    if (!effected.setNamedParameters(0, {
      scale: 1,
      rate_beats: 0.25,
      sensitivity_percent: 75,
      mix_percent: 100,
    })) throw new Error('private AUTO RIFF parameters were rejected');
    if (!effected.setActive(0, true)) throw new Error('private AUTO RIFF could not be activated');

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

    const source = context.createOscillator();
    source.frequency.value = 220;
    source.connect(effected.input);
    source.start();
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
      let peak = Number.NEGATIVE_INFINITY;
      let peakBin = center;
      for (let bin = Math.max(1, center - radius); bin <= Math.min(spectrum.length - 1, center + radius); bin += 1) {
        if ((spectrum[bin] ?? Number.NEGATIVE_INFINITY) > peak) {
          peak = spectrum[bin] ?? Number.NEGATIVE_INFINITY;
          peakBin = bin;
        }
      }
      return { hz: peakBin * binHz, db: peak };
    };
    const started = context.currentTime;
    const audioDeadline = started + 1.5;
    const wallDeadline = performance.now() + 6_000;
    while (context.currentTime < audioDeadline && performance.now() < wallDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = effected.getStatus(1).slots[0];
    const result = {
      state: context.state,
      sampleRate: context.sampleRate,
      elapsed: context.currentTime - started,
      status: status?.state,
      active: status?.active,
      resourceNote: status?.resourceNote,
      source220: peakNear(inputOutput, 220),
      processed220: peakNear(output, 220),
      riff185: peakNear(output, 185),
      neighbor330: peakNear(neighborOutput, 330),
    };
    source.stop();
    neighborSource.stop();
    effected.dispose();
    neighbor.dispose();
    await context.close();
    return result;
  });

  expect(result.state).toBe('running');
  expect(result.sampleRate).toBe(48_000);
  expect(result.elapsed).toBeGreaterThanOrEqual(1.5);
  expect(result.status).toBe('ready');
  expect(result.active).toBe(true);
  expect(result.resourceNote).toContain('Live Signalsmith WASM reserved');
  expect(result.source220.db).toBeGreaterThan(-60);
  expect(result.riff185.hz).toBeGreaterThan(178);
  expect(result.riff185.hz).toBeLessThan(192);
  expect(result.riff185.db).toBeGreaterThan(result.processed220.db + 6);
  expect(result.neighbor330.hz).toBeGreaterThan(320);
  expect(result.neighbor330.hz).toBeLessThan(340);
  expect(result.neighbor330.db).toBeGreaterThan(-45);
});

test('per-track LCD exposes AUTO RIFF experiment controls on the selected track and persists them', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  const startButton = page.getByTestId('start-audio');
  if ((await startButton.innerText()).trim() !== 'READY') await startButton.click();
  await expect(startButton).toHaveText('READY', { timeout: 25_000 });
  await expect(page.getByTestId('input-status')).toContainText('OUTPUT READY');

  const panel = await openFxEditor(page, 'track');
  await panel.getByLabel('Track FX target', { exact: true }).selectOption('3');
  await panel.getByLabel('Per-track FX type', { exact: true }).selectOption('AUTO RIFF (EXPERIMENTAL)');
  await expect(panel.locator('[data-track-fx-runtime-status]')).toContainText('READY', { timeout: 10_000 });
  await expect(panel.locator('[data-track-fx-resource-warning]')).toContainText('Live Signalsmith WASM reserved');

  const privateEditor = panel.locator('[data-browser-track-fx]');
  await privateEditor.locator('details.named-controls summary').click();
  await privateEditor.getByLabel('Track 3 slot A scale').selectOption('2');
  await privateEditor.getByLabel('Track 3 slot A rate_beats').selectOption('1');
  const setNumber = async (locator: Locator, value: number) => {
    await locator.fill(String(value));
    await locator.dispatchEvent('change');
  };
  await setNumber(privateEditor.getByLabel('Track 3 slot A sensitivity_percent'), 72);
  await setNumber(privateEditor.getByLabel('Track 3 slot A mix_percent'), 88);
  await panel.getByLabel('Toggle per-track FX slot', { exact: true }).click();

  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('webrc505_browser_per_track_fx_v1') ?? '{}') as {
      target?: number;
      tracks?: Array<{ slots?: Array<{ type?: string; active?: boolean; namedParameters?: Record<string, number> }> }>;
    };
    const slot = saved.tracks?.[2]?.slots?.[0];
    return saved.target === 3 && slot?.type === 'AUTO RIFF (EXPERIMENTAL)' && slot.active === true
      && slot.namedParameters?.scale === 2
      && slot.namedParameters?.rate_beats === 1
      && slot.namedParameters?.sensitivity_percent === 72
      && slot.namedParameters?.mix_percent === 88;
  });
});
