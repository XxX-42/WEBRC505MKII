import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;

test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the explicit no-hardware bridge simulation target.');

test('Native browser bridge captures and exports a synthetic loop through HQ_RENDER', async ({ page }) => {
  if (!simulationHost) return;

  let host: ChildProcess | undefined;
  let hostStartError: Error | undefined;
  try {
    host = spawn(simulationHost, [], { stdio: 'ignore' });
    host.once('error', (error) => { hostStartError = error; });

    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (hostStartError) throw hostStartError;
      if (host.exitCode !== null) throw new Error(`Native simulation host exited early with code ${host.exitCode}`);
      try {
        const response = await fetch('http://127.0.0.1:17755/health');
        ready = response.ok && (await response.json()).ok === true;
        if (ready) break;
      } catch {
        // The local simulation process may need a moment to bind its loopback port.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ready, 'Native simulation host did not start on 127.0.0.1:17755').toBe(true);

    await page.goto('/');
    const strip = page.locator('[data-track-id="1"]');
    await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });
    await expect(page.locator('.top-status-strip')).toContainText('TRACK A–D AVAILABLE');
    await expect(strip.locator('[data-testid="native-hq-engine"] option')).toHaveCount(2);

    // The explicit simulation host feeds a synthetic 440 Hz tone. This checks
    // the real browser-to-loopback HTTP and WAV export path, not device input,
    // hardware timing, XRUN behavior, or subjective render quality.
    const recordButton = strip.getByLabel('Record or play track');
    await recordButton.evaluate((button: HTMLElement) => button.click());
    await expect(strip.locator('.track-state')).toHaveText('RECORD', { timeout: 10_000 });
    await page.waitForTimeout(350);
    await recordButton.evaluate((button: HTMLElement) => button.click());
    await expect(strip.locator('.track-state')).toHaveText('STOP', { timeout: 10_000 });

    const metadata = await page.evaluate(async () => {
      const response = await fetch('http://127.0.0.1:17755/v1/export/track-metadata?trackId=1');
      if (!response.ok) throw new Error(`Native metadata endpoint returned HTTP ${response.status}`);
      return await response.json() as { trackId: number; sampleRate: number; frameCount: number; channels: number };
    });
    expect(metadata.trackId).toBe(1);
    expect(metadata.sampleRate).toBe(48_000);
    expect(metadata.frameCount).toBeGreaterThan(0);
    expect(metadata.channels).toBe(2);

    await strip.locator('.hq-export-panel summary').click();
    await strip.locator('[data-testid="native-hq-engine"]').selectOption('R2');
    const numericInputs = strip.locator('.hq-export-controls input[type="number"]');
    await numericInputs.nth(0).fill('7');
    await numericInputs.nth(1).fill('1');
    await strip.locator('.hq-export-controls select').last().selectOption('pcm16');

    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await strip.getByRole('button', { name: 'EXPORT HQ WAV' }).click();
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
