import { expect, test, type Locator } from '@playwright/test';
import { openFxEditor } from './uiHelpers';

test('routes experimental ROBOT through one private track chain and preserves neighboring audio', async ({ page }) => {
  await page.goto('/?audio=browser');
  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserTrackFxChain } = await import('/src/audio/BrowserTrackFxChain.ts');
    const ensureModule = () => context.audioWorklet.addModule('/worklets/fx-processor.js');
    const robot = new BrowserTrackFxChain(context, ensureModule);
    const neighbor = new BrowserTrackFxChain(context, ensureModule);
    if (!robot.setType(0, 'ROBOT')) throw new Error('private ROBOT adapter was rejected');

    const readinessDeadline = performance.now() + 10_000;
    while (robot.getStatus(1).slots[0]?.pendingApply && performance.now() < readinessDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ready = robot.getStatus(1).slots[0];
    if (ready?.state !== 'ready' || ready.type !== 'ROBOT') {
      throw new Error(`private ROBOT did not become ready: ${ready?.error ?? ready?.state}`);
    }
    if (!robot.setNamedParameters(0, { pitch: 7, formant: 0, mix: 100 })) {
      throw new Error('private ROBOT parameters were rejected');
    }
    if (!robot.setActive(0, true)) throw new Error('private ROBOT could not be activated');

    const robotOutput = context.createAnalyser();
    const neighborOutput = context.createAnalyser();
    const robotInput = context.createAnalyser();
    for (const analyser of [robotOutput, neighborOutput, robotInput]) {
      analyser.fftSize = 32_768;
      analyser.smoothingTimeConstant = 0;
    }
    const mute = context.createGain();
    mute.gain.value = 0;
    robot.output.connect(robotOutput);
    neighbor.output.connect(neighborOutput);
    robot.input.connect(robotInput);
    robotOutput.connect(mute);
    neighborOutput.connect(mute);
    robotInput.connect(mute);
    mute.connect(context.destination);

    // Give the mono-F0 detector a stable harmonic input envelope.
    const oscillators: OscillatorNode[] = [];
    for (let harmonic = 1; harmonic <= 20; harmonic += 1) {
      const frequency = 220 * harmonic;
      const envelope = Math.exp(-0.5 * (Math.log(frequency / 1_000) / 0.42) ** 2);
      const gain = context.createGain();
      gain.gain.value = 0.03 * envelope / Math.sqrt(harmonic);
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      gain.connect(robot.input);
      oscillator.start();
      oscillators.push(oscillator);
    }
    const neighborOscillator = context.createOscillator();
    neighborOscillator.frequency.value = 330;
    neighborOscillator.connect(neighbor.input);
    neighborOscillator.start();

    const peakNear = (analyser: AnalyserNode, frequency: number): number => {
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(spectrum);
      const binHz = sampleRate / analyser.fftSize;
      const center = Math.round(frequency / binHz);
      let peak = Number.NEGATIVE_INFINITY;
      for (let bin = Math.max(0, center - 3); bin <= Math.min(spectrum.length - 1, center + 3); bin += 1) {
        peak = Math.max(peak, spectrum[bin] ?? Number.NEGATIVE_INFINITY);
      }
      return peak;
    };
    const waitAudio = async (seconds: number) => {
      const deadline = context.currentTime + seconds;
      const wallDeadline = performance.now() + 5_000;
      while (context.currentTime < deadline && performance.now() < wallDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return context.currentTime;
    };

    const firstStart = context.currentTime;
    const afterFirst = await waitAudio(1.3);
    const pitchSeven = peakNear(robotOutput, 330);
    const source220AfterSeven = peakNear(robotOutput, 220);
    const neighbor330 = peakNear(neighborOutput, 330);
    const input1100 = peakNear(robotInput, 1_100);
    if (!robot.setNamedParameters(0, { pitch: 12 })) throw new Error('private ROBOT live pitch update was rejected');
    const secondStart = context.currentTime;
    const afterSecond = await waitAudio(1.3);
    const pitchTwelve = peakNear(robotOutput, 440);
    const source220AfterTwelve = peakNear(robotOutput, 220);
    const status = robot.getStatus(1).slots[0];
    const measurement = {
      contextState: context.state,
      ready: status?.state,
      active: status?.active,
      resourceNote: status?.resourceNote,
      firstAudioElapsed: afterFirst - firstStart,
      secondAudioElapsed: afterSecond - secondStart,
      pitchSevenDb: pitchSeven,
      pitchTwelveDb: pitchTwelve,
      source220AfterSevenDb: source220AfterSeven,
      source220AfterTwelveDb: source220AfterTwelve,
      neighbor330Db: neighbor330,
      source1100Db: input1100,
    };
    oscillators.forEach((oscillator) => oscillator.stop());
    neighborOscillator.stop();
    robot.dispose();
    neighbor.dispose();
    await context.close();
    return measurement;
  });

  expect(result.contextState).toBe('running');
  expect(result.ready).toBe('ready');
  expect(result.active).toBe(true);
  expect(result.resourceNote).toContain('Live Signalsmith WASM reserved');
  expect(result.firstAudioElapsed).toBeGreaterThanOrEqual(1.3);
  expect(result.secondAudioElapsed).toBeGreaterThanOrEqual(1.3);
  expect(result.source1100Db).toBeGreaterThan(-70);
  expect(result.pitchSevenDb, JSON.stringify(result)).toBeGreaterThan(result.source220AfterSevenDb + 1.5);
  expect(result.pitchTwelveDb, JSON.stringify(result)).toBeGreaterThan(result.source220AfterTwelveDb + 1.5);
  expect(result.neighbor330Db).toBeGreaterThan(-40);
});

test('per-track LCD exposes and persists private ROBOT controls', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  const startButton = page.getByTestId('start-audio');
  if ((await startButton.innerText()).trim() !== 'READY') await startButton.click();
  await expect(startButton).toHaveText('READY', { timeout: 25_000 });
  await expect(page.getByTestId('input-status')).toContainText('OUTPUT READY');
  const panel = await openFxEditor(page, 'track');
  await panel.getByLabel('Track FX target', { exact: true }).selectOption('2');
  await panel.getByLabel('Per-track FX type', { exact: true }).selectOption('ROBOT (EXPERIMENTAL)');
  await expect(panel.locator('[data-track-fx-runtime-status]')).toContainText('READY', { timeout: 10_000 });
  await expect(panel.locator('[data-track-fx-resource-warning]')).toContainText('Live Signalsmith WASM reserved');
  await panel.locator('summary').click();

  const setNumber = async (locator: Locator, value: number) => {
    await locator.fill(String(value));
    await locator.dispatchEvent('change');
  };
  await setNumber(panel.getByLabel('Track 2 slot A pitch', { exact: true }), 9);
  await setNumber(panel.getByLabel('Track 2 slot A formant', { exact: true }), 3);
  await setNumber(panel.getByLabel('Track 2 slot A mix', { exact: true }), 82);
  await panel.getByLabel('Toggle per-track FX slot', { exact: true }).click();

  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('webrc505_browser_per_track_fx_v1') ?? '{}') as {
      target?: number;
      tracks?: Array<{ slots?: Array<{ type?: string; active?: boolean; namedParameters?: Record<string, number> }> }>;
    };
    const slot = saved.tracks?.[1]?.slots?.[0];
    return saved.target === 2 && slot?.type === 'ROBOT (EXPERIMENTAL)' && slot.active === true
      && slot.namedParameters?.pitch === 9 && slot.namedParameters?.formant === 3 && slot.namedParameters?.mix === 82;
  });
});
