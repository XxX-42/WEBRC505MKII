import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('applies BEAT SHIFT to one selected stored loop and audibly starts at its source offset', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const panel = page.locator('.top-panel [data-panel="track-fx"]');
  await panel.getByLabel('Track FX target').selectOption('2');
  const editor = panel.locator('[data-loop-transport-editor]');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('not an ordered A–D insert');
  await editor.getByLabel('Track 2 source transport').selectOption('beatShift');
  await editor.getByLabel('Track 2 source beat offset').evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '1';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(editor.getByTestId('loop-transport-status')).toContainText('APPLIED');

  const audio = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const { Transport } = await import('/src/core/Transport.ts');
    const engine = AudioEngine.getInstance();
    if (engine.getMode() !== 'browser' || engine.tracks.length !== 5) throw new Error('Browser track engine is not ready');
    const browserEngine = (engine as any).browser;
    const context = browserEngine.context as AudioContext;
    if (typeof context.createAnalyser !== 'function') {
      throw new Error(`Unexpected audio context: engineMode=${engine.getMode()} browserType=${browserEngine?.constructor?.name} contextType=${context?.constructor?.name} browserKeys=${Object.keys(browserEngine ?? {}).join(',')}`);
    }
    await context.resume();
    Transport.getInstance().setBpm(120);
    const track = engine.tracks[1] as any;
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const pcm = buffer.getChannelData(0);
    pcm[0] = 0.75;
    pcm[Math.floor(context.sampleRate * 0.5)] = -0.8;
    track.audioBuffer = buffer;
    track.startOffset = 0;

    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    const mutedSink = context.createGain();
    mutedSink.gain.value = 0;
    browserEngine.trackMixNode.connect(analyser);
    analyser.connect(mutedSink);
    mutedSink.connect(context.destination);

    await track.play();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    const minimum = Math.min(...samples);
    const maximum = Math.max(...samples);
    const routeStatus = browserEngine.getTrackTransportStatus()[1];
    const siblingRouteStatus = browserEngine.getTrackTransportStatus()[0];
    track.stop();
    Transport.getInstance().stop();
    return {
      contextState: context.state,
      sampleRate: context.sampleRate,
      minimum,
      maximum,
      sourcePosition: track.getCurrentPlaybackPosition(),
      configured: routeStatus?.configuredEffects,
      active: routeStatus?.active,
      siblingConfigured: siblingRouteStatus?.configuredEffects,
      siblingActive: siblingRouteStatus?.active,
    };
  });

  expect(audio.contextState).toBe('running');
  expect(audio.sampleRate).toBeGreaterThanOrEqual(8_000);
  expect(audio.minimum).toBeLessThan(-0.5);
  expect(audio.maximum).toBeLessThan(0.1);
  expect(audio.configured).toContainEqual({ slot: 'A', type: 'BEAT SHIFT' });
  expect(audio.active).toBe(true);
  expect(audio.siblingConfigured).toEqual([]);
  expect(audio.siblingActive).toBe(false);
});

test('VINYL FLICK speed is independent of dry/wet mix on one real Browser loop source', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const panel = page.locator('.top-panel [data-panel="track-fx"]');
  await panel.getByLabel('Track FX target').selectOption('2');
  const editor = panel.locator('[data-loop-transport-editor]');
  await editor.getByLabel('Track 2 source transport').selectOption('vinylFlick');
  await editor.getByLabel('Track 2 Vinyl speed target').evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '50';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await editor.getByLabel('Track 2 Vinyl motor return').evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '0.05';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(editor.getByTestId('loop-transport-status')).toContainText('APPLIED');

  const spectra = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const engine = AudioEngine.getInstance();
    if (engine.getMode() !== 'browser' || engine.tracks.length !== 5) throw new Error('Browser track engine is not ready');
    const browserEngine = (engine as any).browser;
    const context = browserEngine.context as AudioContext;
    await context.resume();

    const track = engine.tracks[1] as any;
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const pcm = buffer.getChannelData(0);
    for (let frame = 0; frame < pcm.length; frame += 1) {
      pcm[frame] = 0.5 * Math.sin((2 * Math.PI * 220 * frame) / context.sampleRate);
    }
    track.audioBuffer = buffer;
    track.startOffset = 0;

    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -120;
    const mutedSink = context.createGain();
    mutedSink.gain.value = 0;
    browserEngine.trackMixNode.connect(analyser);
    analyser.connect(mutedSink);
    mutedSink.connect(context.destination);

    const measure = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      const peakNear = (frequency: number) => {
        const center = Math.round(frequency * analyser.fftSize / context.sampleRate);
        let peak = -120;
        for (let bin = Math.max(0, center - 2); bin <= Math.min(bins.length - 1, center + 2); bin += 1) {
          peak = Math.max(peak, bins[bin]!);
        }
        return peak;
      };
      return { dry220Hz: peakNear(220), transported330Hz: peakNear(330) };
    };

    await track.play();
    const wetOnly = await measure();
    if (!browserEngine.setLoopTransport(2, {
      mode: 'vinylFlick', beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 50, motorReturnSeconds: 0.05, brakePercent: 0, vinylMixPercent: 0,
    })) throw new Error('Browser rejected Vinyl mix=0 while the selected loop was playing');
    const dryOnly = await measure();
    if (!browserEngine.setLoopTransport(2, {
      mode: 'vinylFlick', beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 50, motorReturnSeconds: 0.05, brakePercent: 0, vinylMixPercent: 50,
    })) throw new Error('Browser rejected Vinyl mix=50 while the selected loop was playing');
    const mixed = await measure();
    const active = browserEngine.getTrackTransportStatus()[1]?.active;
    const siblingConfigured = browserEngine.getTrackTransportStatus()[0]?.configuredEffects;
    track.stop();
    return { sampleRate: context.sampleRate, wetOnly, dryOnly, mixed, active, siblingConfigured };
  });

  console.info('VINYL FLICK source transport spectral diagnostics', JSON.stringify(spectra));
  expect(spectra.sampleRate).toBeGreaterThanOrEqual(8_000);
  expect(spectra.wetOnly.transported330Hz).toBeGreaterThan(-35);
  expect(spectra.wetOnly.transported330Hz).toBeGreaterThan(spectra.wetOnly.dry220Hz + 15);
  expect(spectra.dryOnly.dry220Hz).toBeGreaterThan(-35);
  expect(spectra.dryOnly.dry220Hz).toBeGreaterThan(spectra.dryOnly.transported330Hz + 15);
  expect(spectra.mixed.dry220Hz).toBeGreaterThan(-35);
  expect(spectra.mixed.transported330Hz).toBeGreaterThan(-35);
  expect(Math.abs(spectra.mixed.dry220Hz - spectra.mixed.transported330Hz)).toBeLessThan(12);
  expect(spectra.active).toBe(true);
  expect(spectra.siblingConfigured).toEqual([]);
});
