import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('the production Browser rhythm worklet renders audible hits on a live AudioContext', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeAudioWorkletNode = window.AudioWorkletNode;
    const observation = { processorNames: [] as string[], analyser: null as AnalyserNode | null };
    (window as unknown as { __rc505RhythmProbe: typeof observation }).__rc505RhythmProbe = observation;

    window.AudioWorkletNode = class extends nativeAudioWorkletNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name !== 'rc505-rhythm-processor') return;
        observation.processorNames.push(name);
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        observation.analyser = analyser;
        const connect = this.connect.bind(this);
        let tapped = false;
        this.connect = ((destination: AudioNode, output?: number, input?: number) => {
          const result = connect(destination, output, input);
          if (!tapped) {
            connect(analyser);
            tapped = true;
          }
          return result;
        }) as typeof this.connect;
      }
    };
  });

  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);
  await page.getByRole('button', { name: 'Start rhythm' }).click();
  await expect(page.getByRole('button', { name: 'Stop rhythm' })).toBeVisible();

  await page.waitForFunction(() => {
    const analyser = (window as unknown as { __rc505RhythmProbe?: { analyser: AnalyserNode | null } })
      .__rc505RhythmProbe?.analyser;
    if (!analyser) return false;
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    for (const sample of samples) sumSquares += sample * sample;
    return Math.sqrt(sumSquares / samples.length) > 1e-4;
  }, undefined, { timeout: 5_000 });

  const probe = await page.evaluate(() => {
    const state = (window as unknown as { __rc505RhythmProbe: { processorNames: string[]; analyser: AnalyserNode } })
      .__rc505RhythmProbe;
    const samples = new Float32Array(state.analyser.fftSize);
    state.analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    let peak = 0;
    for (const sample of samples) {
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    return {
      processorNames: state.processorNames,
      rms: Math.sqrt(sumSquares / samples.length),
      peak,
      contextState: state.analyser.context.state,
      rhythmStatus: document.querySelector('[data-testid="rhythm-status"]')?.textContent ?? '',
    };
  });
  expect(probe.processorNames).toEqual(['rc505-rhythm-processor']);
  expect(probe.contextState).toBe('running');
  expect(probe.rms).toBeGreaterThan(1e-4);
  expect(probe.peak).toBeGreaterThan(5e-4);
  expect(probe.rhythmStatus).toBe('');

  await page.getByRole('button', { name: 'Stop rhythm' }).click();
  await expect(page.getByRole('button', { name: 'Start rhythm' })).toBeVisible();
});
