import { expect, test } from '@playwright/test';

test('routes stable voiced ROBOT through PSOLA-lite and keeps formant control on Signalsmith', async ({ page }) => {
  await page.goto('/?audio=browser');
  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const render = async (fundamentalHz: number, pitchShift: number, formantShift: number) => {
      const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      await context.resume();
      const { BrowserRobotFX } = await import('/src/audio/fx/BrowserRobotFX.ts');
      const fx = new BrowserRobotFX(context, () => context.audioWorklet.addModule('/worklets/fx-processor.js'));
      fx.setParam('robot.pitch', pitchShift);
      fx.setParam('robot.formant', formantShift);
      fx.setParam('robot.mix', 100);
      await fx.ready;
      fx.setBypass(false);

      const analyser = context.createAnalyser();
      analyser.fftSize = 32_768;
      analyser.smoothingTimeConstant = 0;
      const mute = context.createGain();
      mute.gain.value = 0;
      fx.output.connect(analyser);
      analyser.connect(mute);
      mute.connect(context.destination);

      // A harmonic source with a broad spectral envelope around 1 kHz.
      const oscillators: OscillatorNode[] = [];
      for (let harmonic = 1; harmonic <= 20; harmonic += 1) {
        const frequency = fundamentalHz * harmonic;
        const envelope = Math.exp(-0.5 * (Math.log(frequency / 1_000) / 0.42) ** 2);
        const partialGain = context.createGain();
        partialGain.gain.value = 0.03 * envelope / Math.sqrt(harmonic);
        const oscillator = context.createOscillator();
        oscillator.frequency.value = frequency;
        oscillator.connect(partialGain);
        partialGain.connect(fx.input);
        oscillator.start();
        oscillators.push(oscillator);
      }

      await new Promise((resolve) => setTimeout(resolve, 1_300));
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(spectrum);
      const binHz = sampleRate / analyser.fftSize;
      const bandPower = (lowHz: number, highHz: number): number => {
        const first = Math.max(0, Math.floor(lowHz / binHz));
        const last = Math.min(spectrum.length - 1, Math.ceil(highHz / binHz));
        let power = 0;
        for (let bin = first; bin <= last; bin += 1) {
          const db = spectrum[bin] ?? Number.NEGATIVE_INFINITY;
          if (Number.isFinite(db)) power += 10 ** (db / 10);
        }
        return power;
      };
      const peakNear = (frequencyHz: number): number => {
        const center = Math.round(frequencyHz / binHz);
        let maximum = Number.NEGATIVE_INFINITY;
        for (let bin = Math.max(0, center - 3); bin <= Math.min(spectrum.length - 1, center + 3); bin += 1) {
          maximum = Math.max(maximum, spectrum[bin] ?? Number.NEGATIVE_INFINITY);
        }
        return maximum;
      };
      const result = {
        state: context.state,
        alignedLatencyMs: fx.latencySeconds * 1000,
        psolaLatencyMs: (fx.psolaLatencySamples / sampleRate) * 1000,
        signalsmithLatencyMs: (fx.signalsmithLatencySamples / sampleRate) * 1000,
        trackerAcquisitionMs: (fx.trackerAcquisitionLatencyFrames / sampleRate) * 1000,
        mode: fx.processingMode,
        reason: fx.processingModeReason,
        targetDb: peakNear(fundamentalHz * 2 ** (pitchShift / 12)),
        inputDb: peakNear(fundamentalHz),
        lowFormantPower: bandPower(700, 1_350),
        highFormantPower: bandPower(1_600, 2_500),
        error: fx.error,
      };
      oscillators.forEach((oscillator) => oscillator.stop());
      fx.dispose();
      await context.close();
      return result;
    };
    return {
      psola: await render(220, 7, 0),
      formantPreserved: await render(220, 7, 0),
      formantShifted: await render(220, 7, 12),
    };
  });

  expect(result.psola.state).toBe('running');
  expect(result.psola.error).toBe('');
  expect(result.psola.mode).toBe('psola');
  expect(result.psola.reason).toBe('stable-voiced');
  expect(result.psola.psolaLatencyMs).toBeLessThan(30);
  expect(result.psola.alignedLatencyMs).toBeCloseTo(result.psola.psolaLatencyMs, 2);
  expect(result.psola.targetDb).toBeGreaterThan(result.psola.inputDb + 1.5);

  expect(result.formantPreserved.mode).toBe('psola');
  expect(result.formantPreserved.reason).toBe('stable-voiced');
  expect(result.formantShifted.reason).toBe('formant-control-active');
  expect(result.formantShifted.mode).toBe('signalsmith');
  expect(result.formantShifted.state).toBe('running');
  expect(result.formantShifted.error).toBe('');
  expect(result.formantShifted.signalsmithLatencyMs).toBeGreaterThan(0);
  expect(result.formantShifted.trackerAcquisitionMs).toBeGreaterThan(0);
  expect(result.formantShifted.alignedLatencyMs).toBeLessThanOrEqual(30);
  expect(result.formantShifted.targetDb, JSON.stringify(result.formantShifted))
    .toBeGreaterThan(result.formantShifted.inputDb + 1.5);
  expect(result.formantPreserved.highFormantPower / result.formantPreserved.lowFormantPower)
    .toBeLessThan(result.formantShifted.highFormantPower / result.formantShifted.lowFormantPower);
});
