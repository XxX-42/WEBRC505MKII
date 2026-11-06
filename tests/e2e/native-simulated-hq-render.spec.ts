import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { activateEnhancedAction, findEnhancedControl, openEnhancedTools, openTrackLcd, selectEnhancedEnum, setEnhancedNumber } from './uiHelpers';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;

test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the explicit no-hardware bridge simulation target.');

for (const rendererName of ['R2', 'R3'] as const) {
test(`Native browser bridge exports a stereo tone through ${rendererName} HQ_RENDER`, async ({ page }, testInfo) => {
  if (!simulationHost) return;

  let host: ChildProcess | undefined;
  let hostStartError: Error | undefined;
  try {
    host = spawn(simulationHost, [], { env: { ...process.env, WEBRC_NATIVE_BRIDGE_PORT: '18755' }, stdio: 'ignore' });
    host.once('error', (error) => { hostStartError = error; });

    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (hostStartError) throw hostStartError;
      if (host.exitCode !== null) throw new Error(`Native simulation host exited early with code ${host.exitCode}`);
      try {
        const response = await fetch('http://127.0.0.1:18755/health');
        ready = response.ok && (await response.json()).ok === true;
        if (ready) break;
      } catch {
        // The local simulation process may need a moment to bind its loopback port.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ready, 'Native simulation host did not start on 127.0.0.1:18755').toBe(true);

    await page.goto('/');
    const strip = page.locator('[data-track-id="1"]');
    await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });
    await expect(page.locator('.top-status-strip')).toContainText('TRACK A–D AVAILABLE');

    // The explicit simulation host feeds a synthetic 440 Hz tone. This checks
    // the real browser-to-loopback HTTP and WAV export path, not device input,
    // hardware timing, XRUN behavior, or subjective render quality.
    const recordButton = strip.getByLabel('Record or play track');
    await recordButton.click();
    await expect(strip.locator('.track-state')).toHaveText('RECORD', { timeout: 10_000 });
    await page.waitForTimeout(350);
    await recordButton.click();
    await expect(strip.locator('.track-state')).toHaveText('PLAY');
    await strip.getByRole('button', { name: 'Stop track (hold to clear)' }).click();
    await expect(strip.locator('.track-state')).toHaveText('STOP', { timeout: 10_000 });

    const historyLayerButton = page.locator('[data-panel-control="undo-redo"]');
    await expect(historyLayerButton).toBeEnabled();
    await historyLayerButton.click();
    const recordPlayButton = page.locator('[data-track-id="1"] [data-panel-control="record-play"]');
    await expect(recordPlayButton).toHaveAttribute('data-hardware-role', 'UNDO');
    await recordPlayButton.click();
    await expect(recordPlayButton).toHaveAttribute('data-hardware-role', 'REDO');
    await expect.poll(async () => {
      const response = await fetch('http://127.0.0.1:18755/v1/status');
      const status = await response.json() as { nativeTracks?: Array<{ trackId: number; state: string }> };
      return status.nativeTracks?.find((track) => track.trackId === 1)?.state;
    }).toBe('Empty');
    await recordPlayButton.click();
    await expect(recordPlayButton).toHaveAttribute('data-hardware-role', 'UNDO');
    await historyLayerButton.click();
    await expect.poll(async () => {
      const response = await fetch('http://127.0.0.1:18755/v1/status');
      const status = await response.json() as { nativeTracks?: Array<{ trackId: number; state: string }> };
      return status.nativeTracks?.find((track) => track.trackId === 1)?.state;
    }).toBe('Stopped');

    // The simulation input duplicates mono into both channels. Import a
    // separately authored stereo 440 Hz fixture through the real project path
    // so the export can prove channel separation as well as pitch conversion.
    await page.evaluate(async () => {
      const load = (specifier: string) =>
        (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
      const [{ AudioEngine }, { ProjectMemory }, { encodeProjectArchive }] = await Promise.all([
        load('/src/audio/AudioEngine.ts'), load('/src/audio/projectMemory.ts'), load('/src/audio/projectArchive.ts'),
      ]);
      const rate = 48_000;
      const left = new Float32Array(rate);
      const right = new Float32Array(rate);
      for (let frame = 0; frame < rate; frame += 1) {
        const phase = 2 * Math.PI * 440 * frame / rate;
        left[frame] = 0.35 * Math.sin(phase);
        right[frame] = 0.18 * Math.sin(phase + 0.7);
      }
      const bytes = await encodeProjectArchive({
        name: 'HQ stereo tone', bpm: 120,
        transport: { masterTrackId: null, measureLengthSeconds: 0, masterLoopLengthSamples: 0,
          timeSignatureNumerator: 4, timeSignatureDenominator: 4 },
        tracks: [{ sampleRate: rate, frameCount: rate, channels: 2, channelData: [left, right] }, null, null, null, null],
      });
      await new ProjectMemory(AudioEngine.getInstance()).importFile(
        new File([bytes], 'hq-stereo-tone.rc505proj', { type: 'application/x-rc505-project' }));
    });

    const metadata = await page.evaluate(async () => {
      const response = await fetch('http://127.0.0.1:18755/v1/export/track-metadata?trackId=1');
      if (!response.ok) throw new Error(`Native metadata endpoint returned HTTP ${response.status}`);
      return await response.json() as { trackId: number; sampleRate: number; frameCount: number; channels: number };
    });
    expect(metadata.trackId).toBe(1);
    expect(metadata.sampleRate).toBe(48_000);
    expect(metadata.frameCount).toBeGreaterThan(0);
    expect(metadata.channels).toBe(2);

    const trackScreen = await openTrackLcd(page, 1);
    await openEnhancedTools(page, 'PITCH / HQ WAV');
    const renderer = await findEnhancedControl(page, 'wav-engine');
    await expect(renderer.locator('option')).toHaveCount(2);
    const selectedOption = renderer.locator('option').filter({ hasText: rendererName });
    await expect(selectedOption, `Native ${rendererName} must be available`).toHaveCount(1);
    await expect(selectedOption).toBeEnabled();
    await renderer.selectOption(await selectedOption.getAttribute('value') ?? '');
    await expect(renderer.locator('option:checked')).toContainText(rendererName);
    await setEnhancedNumber(page, 'wav-pitch', 7);
    await setEnhancedNumber(page, 'wav-rate', 1);
    await selectEnhancedEnum(page, 'wav-format', 'PCM 16-BIT');
    const exportAction = await findEnhancedControl(page, 'wav-export');
    await expect(exportAction).toBeEnabled();

    const downloadPromise = page.waitForEvent('download');
    const responsePromise = page.waitForResponse((response) =>
      response.url().includes('/v1/export/hq-render?trackId=1') && response.request().method() === 'POST');
    await activateEnhancedAction(page, 'wav-export');
    const response = await responsePromise;
    const submitted = JSON.parse(response.request().postData() ?? '{}') as { engine?: string; semitones?: number; playbackRate?: number };
    expect(submitted).toMatchObject({ engine: rendererName, semitones: 7, playbackRate: 1 });
    expect(response.status()).toBe(200);
    expect(await response.headerValue('x-native-hq-engine')).toBe(rendererName);
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('webrc505-track-01-hq-render.wav');
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('Playwright did not expose the downloaded WAV file');
    const wav = await fs.readFile(downloadPath);

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(metadata.channels);
    expect(wav.readUInt32LE(24)).toBe(metadata.sampleRate);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(metadata.frameCount * metadata.channels * 2);
    expect(wav.length).toBe(44 + metadata.frameCount * metadata.channels * 2);

    // Ignore the first and last fifth to exclude render boundaries. Hann-window
    // Use interpolated positive zero crossings for mean frequency: a two-cycle
    // counting bound is 2 * sampleRate / windowFrames. The Hann spectrum is
    // retained separately because R2 can produce modulation sidebands.
    const start = Math.floor(metadata.frameCount / 5);
    const windowFrames = metadata.frameCount - 2 * start;
    const binHz = metadata.sampleRate / windowFrames;
    const targetHz = 440 * 2 ** (7 / 12);
    const samples = [new Float64Array(windowFrames), new Float64Array(windowFrames)];
    let differenceEnergy = 0;
    for (let frame = 0; frame < windowFrames; frame += 1) {
      for (let channel = 0; channel < 2; channel += 1) {
        samples[channel]![frame] = wav.readInt16LE(44 + ((frame + start) * 2 + channel) * 2) / 32768;
      }
      differenceEnergy += (samples[0]![frame]! - samples[1]![frame]!) ** 2;
    }
    const magnitudes = (signal: Float64Array, frequency: number) => {
      let real = 0; let imaginary = 0;
      for (let frame = 0; frame < signal.length; frame += 1) {
        const value = signal[frame]! * (0.5 - 0.5 * Math.cos(2 * Math.PI * frame / (signal.length - 1)));
        const angle = 2 * Math.PI * frequency * frame / metadata.sampleRate;
        real += value * Math.cos(angle); imaginary -= value * Math.sin(angle);
      }
      return Math.hypot(real, imaginary);
    };
    const metrics = samples.map((signal) => {
      const rms = Math.sqrt(signal.reduce((sum, value) => sum + value * value, 0) / signal.length);
      let peakBin = Math.ceil(300 / binHz); let peakMagnitude = -1;
      for (let bin = peakBin; bin <= Math.floor(900 / binHz); bin += 1) {
        const magnitude = magnitudes(signal, bin * binHz);
        if (magnitude > peakMagnitude) { peakBin = bin; peakMagnitude = magnitude; }
      }
      const crossings: number[] = [];
      for (let frame = 1; frame < signal.length; frame += 1) {
        const previous = signal[frame - 1]!; const current = signal[frame]!;
        if (previous <= 0 && current > 0) crossings.push(frame - 1 - previous / (current - previous));
      }
      const frequencyHz = crossings.length >= 2
        ? (crossings.length - 1) * metadata.sampleRate / (crossings[crossings.length - 1]! - crossings[0]!) : 0;
      return { rms, frequencyHz, crossingCount: crossings.length, spectralPeakHz: peakBin * binHz,
        peakMagnitude, targetMagnitude: magnitudes(signal, targetHz), sourceMagnitude: magnitudes(signal, 440) };
    });
    await testInfo.attach(`${rendererName}-tone-analysis.json`, {
      body: JSON.stringify({ rendererName, request: submitted, responseEngine: await response.headerValue('x-native-hq-engine'),
        sampleRate: metadata.sampleRate, windowFrames, binHz, targetHz, metrics,
        channelDifferenceRms: Math.sqrt(differenceEnergy / windowFrames) }, null, 2), contentType: 'application/json',
    });
    await testInfo.attach(`${rendererName}-render.wav`, { body: wav, contentType: 'audio/wav' });
    expect(windowFrames).toBeGreaterThan(10_000);
    expect(Math.sqrt(differenceEnergy / windowFrames)).toBeGreaterThan(0.005);
    for (const channel of metrics) {
      expect(channel.rms).toBeGreaterThan(0.005);
      expect(channel.crossingCount).toBeGreaterThan(100);
      expect(Math.abs(channel.frequencyHz - targetHz)).toBeLessThanOrEqual(2 * binHz);
      expect(channel.targetMagnitude).toBeGreaterThan(channel.sourceMagnitude * 2);
    }
    await expect(trackScreen).toBeVisible();
  } finally {
    if (host && host.exitCode === null) {
      host.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        host?.once('exit', () => resolve());
        setTimeout(() => resolve(), 2_000);
      });
    }
  }
});
}
