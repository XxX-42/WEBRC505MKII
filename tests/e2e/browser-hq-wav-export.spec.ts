import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const initScriptPath = path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
});

function goertzelPower(samples: Buffer, firstFrame: number, frameCount: number, sampleRate: number, frequency: number): number {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let previous = 0;
  let previous2 = 0;
  for (let frame = firstFrame; frame < firstFrame + frameCount; frame += 1) {
    const sample = samples.readIntLE(44 + frame * 3, 3);
    const normalized = sample >= 0x800000 ? sample - 0x1000000 : sample;
    const current = normalized / 0x800000 + coefficient * previous - previous2;
    previous2 = previous;
    previous = current;
  }
  return previous * previous + previous2 * previous2 - coefficient * previous * previous2;
}

test('exports a latency-aligned Signalsmith HQ_RENDER PCM24 WAV from the Track Strip', async ({ page }) => {
  await page.goto('/?audio=browser');
  await page.locator('[data-track-id="1"] .hq-export-panel').waitFor();

  const setup = await page.evaluate(async () => {
    const [{ AudioEngine }, { TrackState }, { TrackAudio }] = await Promise.all([
      import('/src/audio/AudioEngine.ts'),
      import('/src/core/types.ts'),
      import('/src/audio/TrackAudio.ts'),
    ]);
    const engine = AudioEngine.getInstance();
    const appRoot = (document.querySelector('.app-root') as any)?.__vueParentComponent;
    const appEngine = appRoot?.setupState?.engine;
    const actualEngine = appEngine ?? engine;
    // Seed the actual Browser TrackAudio instance used by the mounted Strip.
    // Recording itself needs a real input device and is deliberately outside
    // this deterministic offline-render/export test.
    const track = actualEngine.tracks[0] as TrackAudio & { audioBuffer: AudioBuffer | null };
    if (!track) throw new Error('Browser Track 1 adapter is not available');

    const sampleRate = 48_000;
    const frameCount = sampleRate / 2;
    const context = new OfflineAudioContext(1, frameCount, sampleRate);
    const loop = context.createBuffer(1, frameCount, sampleRate);
    const samples = loop.getChannelData(0);
    for (let frame = 0; frame < frameCount; frame += 1) {
      samples[frame] = 0.45 * Math.sin(2 * Math.PI * 440 * frame / sampleRate);
    }

    // Seed a synthetic completed loop into the production TrackAudio export path.
    // Recording/microphone capture is deliberately not part of this offline export check.
    track.audioBuffer = loop;
    track.state = TrackState.STOPPED;
    // Exercise the TrackStrip state watcher using the same state transitions that
    // occur during recording completion, without requiring an input device.
    track.state = TrackState.RECORDING;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    track.state = TrackState.STOPPED;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    return {
      sampleRate,
      frameCount,
      mode: actualEngine.getMode(),
      appEngineMatchesImportedSingleton: !appEngine || appEngine === engine,
      trackIsActualEngineTrack: track === actualEngine.tracks[0],
      exportMethod: typeof track.exportHqWav,
      canExport: track.canExportHqWav,
      state: track.state,
      hasBuffer: track.audioBuffer instanceof AudioBuffer,
      channels: track.audioBuffer?.numberOfChannels ?? 0,
    };
  });
  const strip = page.locator('[data-track-id="1"]');
  expect(setup.mode).toBe('browser');
  expect(setup.trackIsActualEngineTrack).toBe(true);
  expect(setup.canExport).toBe(true);
  expect(setup.state).toBe('STOPPED');
  await expect(strip.locator('button', { hasText: 'EXPORT HQ WAV' })).toBeEnabled();
  await strip.locator('.hq-export-panel summary').click();
  await strip.locator('.hq-export-panel input[type="number"]').nth(0).fill('7');
  await strip.locator('.hq-export-panel input[type="number"]').nth(1).fill('0.8');
  await strip.locator('.hq-export-panel select').selectOption('pcm24');

  const downloadPromise = page.waitForEvent('download');
  await strip.getByRole('button', { name: 'EXPORT HQ WAV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('webrc505-track-01-hq-render.wav');
  const filePath = await download.path();
  if (!filePath) throw new Error('Playwright did not provide the downloaded WAV path');
  const wav = await fs.readFile(filePath);

  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
  expect(wav.readUInt16LE(20)).toBe(1);
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(setup.sampleRate);
  expect(wav.readUInt16LE(34)).toBe(24);
  expect(wav.toString('ascii', 36, 40)).toBe('data');
  const outputFrames = Math.ceil(setup.frameCount / 0.8);
  expect(wav.readUInt32LE(40)).toBe(outputFrames * 3);
  const targetPitchPower = goertzelPower(wav, 6_000, 18_000, setup.sampleRate, 440 * 2 ** (7 / 12));
  const originalPitchPower = goertzelPower(wav, 6_000, 18_000, setup.sampleRate, 440);
  expect(targetPitchPower).toBeGreaterThan(originalPitchPower * 4);
});
