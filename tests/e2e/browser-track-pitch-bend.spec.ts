import { expect, test, type Locator } from '@playwright/test';
import { openFxEditor } from './uiHelpers';

test('routes private Browser PITCH BEND to one track, leaves its neighbor untouched, and retriggers', async ({ page }) => {
  await page.goto('/?audio=browser');
  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserTrackFxChain } = await import('/src/audio/BrowserTrackFxChain.ts');
    const bent = new BrowserTrackFxChain(context, async () => undefined);
    const clean = new BrowserTrackFxChain(context, async () => undefined);

    if (!bent.setType(0, 'PITCH BEND')) throw new Error('per-track PITCH BEND was rejected');
    bent.setNamedParameters(0, { range: 12, time_ms: 500, direction: 0, mix_percent: 100 });
    const deadline = performance.now() + 10_000;
    while (bent.getStatus(1).slots[0]?.pendingApply && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ready = bent.getStatus(1).slots[0];
    if (ready?.state !== 'ready' || ready.type !== 'PITCH BEND') {
      throw new Error(`private PITCH BEND was not ready: ${ready?.error ?? ready?.state}`);
    }

    const oscillatorA = context.createOscillator();
    oscillatorA.frequency.value = 220;
    oscillatorA.connect(bent.input);
    const oscillatorB = context.createOscillator();
    oscillatorB.frequency.value = 330;
    oscillatorB.connect(clean.input);
    const analyzerA = context.createAnalyser();
    const analyzerB = context.createAnalyser();
    analyzerA.fftSize = 8192;
    analyzerB.fftSize = 8192;
    analyzerA.smoothingTimeConstant = 0;
    analyzerB.smoothingTimeConstant = 0;
    const silentA = context.createGain();
    const silentB = context.createGain();
    silentA.gain.value = 0;
    silentB.gain.value = 0;
    bent.output.connect(analyzerA);
    clean.output.connect(analyzerB);
    analyzerA.connect(silentA);
    analyzerB.connect(silentB);
    silentA.connect(context.destination);
    silentB.connect(context.destination);
    oscillatorA.start();
    oscillatorB.start();

    const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const peakHz = (analyzer: AnalyserNode, lowHz: number, highHz: number) => {
      const spectrum = new Float32Array(analyzer.frequencyBinCount);
      analyzer.getFloatFrequencyData(spectrum);
      const binHz = context.sampleRate / analyzer.fftSize;
      const first = Math.max(0, Math.ceil(lowHz / binHz));
      const last = Math.min(spectrum.length - 1, Math.floor(highHz / binHz));
      let best = first;
      let bestDb = Number.NEGATIVE_INFINITY;
      for (let bin = first; bin <= last; bin += 1) {
        if ((spectrum[bin] ?? Number.NEGATIVE_INFINITY) > bestDb) {
          best = bin;
          bestDb = spectrum[bin] ?? Number.NEGATIVE_INFINITY;
        }
      }
      return { hz: best * binHz, db: bestDb };
    };

    await wait(100);
    bent.setActive(0, true);
    await wait(1100);
    const firstBend = peakHz(analyzerA, 300, 500);
    const untouched = peakHz(analyzerB, 280, 380);
    bent.setActive(0, false);
    await wait(100);
    const bypass = peakHz(analyzerA, 190, 250);
    bent.setActive(0, true);
    await wait(1100);
    const retrigger = peakHz(analyzerA, 300, 500);
    const measurement = {
      state: context.state,
      ready: ready.state,
      active: bent.getStatus(1).slots[0]?.active,
      firstBend,
      untouched,
      bypass,
      retrigger,
      resourceNote: bent.getStatus(1).slots[0]?.resourceNote,
    };
    oscillatorA.stop();
    oscillatorB.stop();
    bent.dispose();
    clean.dispose();
    await context.close();
    return measurement;
  });

  expect(result.state).toBe('running');
  expect(result.ready).toBe('ready');
  expect(result.active).toBe(true);
  expect(result.firstBend.db).toBeGreaterThan(-60);
  expect(result.firstBend.hz).toBeGreaterThan(420);
  expect(result.firstBend.hz).toBeLessThan(460);
  expect(result.untouched.db).toBeGreaterThan(-60);
  expect(result.untouched.hz).toBeGreaterThan(318);
  expect(result.untouched.hz).toBeLessThan(342);
  expect(result.bypass.hz).toBeGreaterThan(205);
  expect(result.bypass.hz).toBeLessThan(235);
  expect(result.retrigger.hz).toBeGreaterThan(420);
  expect(result.retrigger.hz).toBeLessThan(460);
  expect(result.resourceNote).toContain('Live Signalsmith WASM reserved');
});

test('per-track LCD exposes and persists private PITCH BEND controls', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  const startButton = page.getByTestId('start-audio');
  if ((await startButton.innerText()).trim() !== 'READY') await startButton.click();
  await expect(startButton).toHaveText('READY', { timeout: 25_000 });
  await expect(page.getByTestId('input-status')).toContainText('OUTPUT READY');
  const panel = await openFxEditor(page, 'track');
  await panel.getByLabel('Track FX target', { exact: true }).selectOption('3');
  await panel.getByLabel('Per-track FX type', { exact: true }).selectOption('PITCH BEND');
  await expect(panel.locator('[data-track-fx-runtime-status]')).toContainText('READY', { timeout: 10_000 });
  await expect(panel.locator('[data-track-fx-resource-warning]')).toContainText('Live Signalsmith WASM reserved');
  await panel.locator('summary').click();

  const setNumber = async (locator: Locator, value: number) => {
    await locator.fill(String(value));
    await locator.dispatchEvent('change');
  };
  await setNumber(panel.getByLabel('Track 3 slot A range', { exact: true }), 18);
  await setNumber(panel.getByLabel('Track 3 slot A time_ms', { exact: true }), 125);
  await panel.getByLabel('Track 3 slot A direction', { exact: true }).selectOption('1');
  await setNumber(panel.getByLabel('Track 3 slot A mix_percent', { exact: true }), 73);
  await panel.getByLabel('Toggle per-track FX slot', { exact: true }).click();

  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('webrc505_browser_per_track_fx_v1') ?? '{}') as {
      target?: number;
      tracks?: Array<{ slots?: Array<{ type?: string; active?: boolean; namedParameters?: Record<string, number> }> }>;
    };
    const slot = saved.tracks?.[2]?.slots?.[0];
    return saved.target === 3 && slot?.type === 'PITCH BEND' && slot.active === true
      && slot.namedParameters?.range === 18 && slot.namedParameters?.time_ms === 125
      && slot.namedParameters?.direction === 1 && slot.namedParameters?.mix_percent === 73;
  });
});
