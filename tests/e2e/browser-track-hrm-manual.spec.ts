import { expect, test, type Locator } from '@playwright/test';
import { openFxEditor } from './uiHelpers';

test('runs two private HRM MANUAL voices on one track without changing its neighbor', async ({ page }) => {
  await page.goto('/?audio=browser');
  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserTrackFxChain } = await import('/src/audio/BrowserTrackFxChain.ts');
    const ensureModule = () => context.audioWorklet.addModule('/worklets/fx-processor.js');
    const harmony = new BrowserTrackFxChain(context, ensureModule);
    const neighbor = new BrowserTrackFxChain(context, ensureModule);
    if (!harmony.setType(1, 'HRM MANUAL')) throw new Error('private HRM MANUAL adapter was rejected');

    const readinessDeadline = performance.now() + 10_000;
    while (harmony.getStatus(1).slots[1]?.pendingApply && performance.now() < readinessDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ready = harmony.getStatus(1).slots[1];
    if (ready?.state !== 'ready' || ready.type !== 'HRM MANUAL') {
      throw new Error(`private HRM MANUAL did not become ready: ${ready?.error ?? ready?.state}`);
    }
    if (!harmony.setNamedParameters(1, {
      voice_1_interval: 7,
      voice_2_interval: 12,
      pan_percent: 100,
      mix_percent: 100,
    })) throw new Error('private HRM MANUAL parameters were rejected');
    if (!harmony.setActive(1, true)) throw new Error('private HRM MANUAL could not be activated');

    const splitter = context.createChannelSplitter(2);
    const left = context.createAnalyser();
    const right = context.createAnalyser();
    const neighborAnalyser = context.createAnalyser();
    const inputAnalyser = context.createAnalyser();
    for (const analyser of [left, right, neighborAnalyser, inputAnalyser]) {
      analyser.fftSize = 32_768;
      analyser.smoothingTimeConstant = 0;
    }
    const mute = context.createGain();
    mute.gain.value = 0;
    harmony.output.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    neighbor.output.connect(neighborAnalyser);
    harmony.input.connect(inputAnalyser);
    for (const analyser of [left, right, neighborAnalyser, inputAnalyser]) analyser.connect(mute);
    mute.connect(context.destination);

    const source = context.createOscillator();
    source.frequency.value = 220;
    source.connect(harmony.input);
    source.start();
    const neighborSource = context.createOscillator();
    neighborSource.frequency.value = 330;
    neighborSource.connect(neighbor.input);
    neighborSource.start();

    const peakNear = (analyser: AnalyserNode, frequency: number): { hz: number; db: number } => {
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(spectrum);
      const binHz = sampleRate / analyser.fftSize;
      const center = Math.round(frequency / binHz);
      const radius = Math.max(2, Math.ceil(frequency * 0.04 / binHz));
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
      const audioDeadline = context.currentTime + seconds;
      const wallDeadline = performance.now() + 5_000;
      while (context.currentTime < audioDeadline && performance.now() < wallDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return context.currentTime;
    };

    const started = context.currentTime;
    const after = await waitAudio(1.35);
    const initial = {
      input220: peakNear(inputAnalyser, 220),
      leftDry220: peakNear(left, 220),
      rightDry220: peakNear(right, 220),
      leftThird330: peakNear(left, 330),
      rightThird330: peakNear(right, 330),
      leftOctave440: peakNear(left, 440),
      rightOctave440: peakNear(right, 440),
      neighbor330: peakNear(neighborAnalyser, 330),
    };
    if (!harmony.setNamedParameters(1, { voice_1_interval: 5 })) throw new Error('live private HRM MANUAL retune was rejected');
    const retuneStarted = context.currentTime;
    const afterRetune = await waitAudio(1.1);
    const status = harmony.getStatus(1).slots[1];
    const measurement = {
      contextState: context.state,
      sampleRate: context.sampleRate,
      ready: status?.state,
      active: status?.active,
      resourceNote: status?.resourceNote,
      audioElapsed: after - started,
      retuneAudioElapsed: afterRetune - retuneStarted,
      rightRetuned293: peakNear(right, 220 * 2 ** (5 / 12)),
      ...initial,
    };
    source.stop();
    neighborSource.stop();
    harmony.dispose();
    neighbor.dispose();
    await context.close();
    return measurement;
  });

  expect(result.contextState).toBe('running');
  expect(result.sampleRate).toBe(48_000);
  expect(result.ready).toBe('ready');
  expect(result.active).toBe(true);
  expect(result.resourceNote).toContain('Live Signalsmith WASM reserved');
  expect(result.audioElapsed).toBeGreaterThanOrEqual(1.35);
  expect(result.retuneAudioElapsed).toBeGreaterThanOrEqual(1.1);
  expect(result.input220.db).toBeGreaterThan(-70);
  expect(result.leftDry220.db).toBeGreaterThan(-40);
  expect(result.rightDry220.db).toBeGreaterThan(-40);
  expect(result.rightThird330.hz).toBeGreaterThan(310);
  expect(result.rightThird330.hz).toBeLessThan(350);
  expect(result.rightOctave440.hz).toBeGreaterThan(420);
  expect(result.rightOctave440.hz).toBeLessThan(460);
  expect(result.rightThird330.db).toBeGreaterThan(-50);
  expect(result.rightOctave440.db).toBeGreaterThan(-50);
  expect(result.rightRetuned293.hz).toBeGreaterThan(275);
  expect(result.rightRetuned293.hz).toBeLessThan(315);
  expect(result.rightRetuned293.db).toBeGreaterThan(-50);
  expect(result.rightThird330.db).toBeGreaterThan(result.leftThird330.db + 6);
  expect(result.rightOctave440.db).toBeGreaterThan(result.leftOctave440.db + 6);
  expect(result.neighbor330.db).toBeGreaterThan(-40);
});

test('per-track LCD persists HRM MANUAL voice, pan and mix controls', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  const startButton = page.getByTestId('start-audio');
  if ((await startButton.innerText()).trim() !== 'READY') await startButton.click();
  await expect(startButton).toHaveText('READY', { timeout: 25_000 });
  await expect(page.getByTestId('input-status')).toContainText('OUTPUT READY');
  const panel = await openFxEditor(page, 'track');
  await panel.getByLabel('Track FX target', { exact: true }).selectOption('2');
  await panel.getByLabel('Per-track FX type', { exact: true }).selectOption('HRM MANUAL');
  await expect(panel.locator('[data-track-fx-runtime-status]')).toContainText('READY', { timeout: 10_000 });
  await expect(panel.locator('[data-track-fx-resource-warning]')).toContainText('Live Signalsmith WASM reserved');
  await panel.locator('summary').click();

  const setNumber = async (locator: Locator, value: number) => {
    await locator.fill(String(value));
    await locator.dispatchEvent('change');
  };
  await setNumber(panel.getByLabel('Track 2 slot A voice_1_interval', { exact: true }), 5);
  await setNumber(panel.getByLabel('Track 2 slot A voice_2_interval', { exact: true }), -12);
  await setNumber(panel.getByLabel('Track 2 slot A pan_percent', { exact: true }), 35);
  await setNumber(panel.getByLabel('Track 2 slot A mix_percent', { exact: true }), 80);
  await panel.getByLabel('Toggle per-track FX slot', { exact: true }).click();

  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('webrc505_browser_per_track_fx_v1') ?? '{}') as {
      target?: number;
      tracks?: Array<{ slots?: Array<{ type?: string; active?: boolean; namedParameters?: Record<string, number> }> }>;
    };
    const slot = saved.tracks?.[1]?.slots?.[0];
    return saved.target === 2 && slot?.type === 'HRM MANUAL' && slot.active === true
      && slot.namedParameters?.voice_1_interval === 5
      && slot.namedParameters?.voice_2_interval === -12
      && slot.namedParameters?.pan_percent === 35
      && slot.namedParameters?.mix_percent === 80;
  });
});
