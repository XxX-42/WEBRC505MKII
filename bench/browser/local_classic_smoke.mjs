// Explicit local deployment check; fresh context never touches the user's session.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const origin = process.env.WEBRC_LOCAL_SMOKE_ORIGIN ?? 'http://127.0.0.1:5173';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Use an explicit loopback deployment origin.');
const output = path.resolve(process.env.WEBRC_LOCAL_SMOKE_OUTPUT ?? 'docs/ui-parity/visual/local-smoke');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const consoleMessages = [];
page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text() }));
const startedUtc = new Date().toISOString();
const state = () => page.evaluate(async () => {
  const facade = window.__webrcLocalSmokeFacade;
  return facade.tracks[0].state;
});
const button = key => page.locator(`[data-panel-control="${key}"]`);
try {
  await page.goto(`${origin}/?audio=browser&ui=classic`);
  await page.evaluate(async () => {
    const source = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/audio/AudioEngine.ts');
    if (!source) throw new Error('The running UI AudioEngine module was not observed.');
    // Reuse the UI module URL, including its Vite HMR timestamp. Bare import
    // would create a second singleton on a long-running development server.
    const { AudioEngine } = await import(source.name);
    const facade = window.__webrcLocalSmokeFacade = AudioEngine.getInstance();
    const engine = facade.tracks[0].engine;
    const destination = engine.context.createMediaStreamDestination(), merger = engine.context.createChannelMerger(2);
    for (const [channel, frequency, amplitude] of [[0, 220, .05], [1, 331, .035]]) {
      const oscillator = engine.context.createOscillator(), gain = engine.context.createGain();
      oscillator.frequency.value = frequency; gain.gain.value = amplitude;
      oscillator.connect(gain).connect(merger, 0, channel); oscillator.start();
    }
    merger.connect(destination);
    // Permission/device enumeration owns and closes its stream independently
    // of the live capture request, as separate real getUserMedia calls do.
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => destination.stream.clone() });
    facade.setRecordPlaySettings({ recAction: 'REC->PLAY', quantize: 'OFF' });
  });
  await page.getByTestId('start-audio').click();
  await expect(page.getByTestId('start-audio')).toHaveText('READY', { timeout: 25_000 });
  const playScreens = ['memory-number', 'track-status', 'loop-tracks', 'loop-status', 'loop-level', 'input-fx', 'track-fx'];
  for (const id of playScreens) {
    await expect(page.getByTestId('rc505-lcd-screen')).toHaveAttribute('data-classic-screen', id);
    await button('page-next').click();
  }
  await expect(page.getByTestId('rc505-lcd-screen')).toHaveAttribute('data-classic-screen', 'memory-number');
  const track = page.locator('.track-strip[data-track-id="1"]');
  const rec = track.locator('[data-panel-control="record-play"]');
  await rec.click(); await expect.poll(state).toBe('RECORDING');
  await page.waitForTimeout(350);
  await rec.click(); await expect.poll(state).toBe('PLAYING');
  await expect(rec).toHaveAttribute('data-led-color', 'green');
  await page.screenshot({ path: path.join(output, 'browser-playing.png') });
  await rec.click(); await expect.poll(state).toBe('OVERDUBBING');
  await page.waitForTimeout(350);
  await rec.click(); await expect.poll(state).toBe('PLAYING');
  await track.locator('.stop-disc').click(); await expect.poll(state).toBe('STOPPED');
  await button('undo-redo').click();
  await track.locator('[data-track-control="select"]').click();
  await expect.poll(() => page.evaluate(async () => {
    const facade = window.__webrcLocalSmokeFacade;
    return facade.getMarkState(1).exists;
  })).toBe(true);
  await track.locator('[data-track-control="fx"]').click();
  await button('undo-redo').click();
  await track.locator('[data-track-control="fx"]').click();
  const result = await page.evaluate(async () => {
    const facade = window.__webrcLocalSmokeFacade;
    const pcm = facade.tracks[0].getProjectPcmSnapshot();
    const energy = pcm.channelData.map(channel => channel.reduce((sum, value) => sum + value * value, 0));
    return { state: facade.tracks[0].state, channels: pcm.channelData.length, frames: pcm.frameCount,
      energy, differentStereo: pcm.channelData[0].some((value, index) => Math.abs(value - pcm.channelData[1][index]) > 1e-5),
      mark: facade.getMarkState(1), gate: facade.getTrackFxApply(1)[0] };
  });
  expect(result.channels).toBe(2); expect(result.frames).toBeGreaterThan(2048);
  expect(result.energy.every(value => value > 0)).toBe(true); expect(result.differentStereo).toBe(true);
  expect(result.mark.exists).toBe(false);
  await expect.poll(() => page.evaluate(async () => {
    const facade = window.__webrcLocalSmokeFacade;
    const gate = facade.getTrackFxApply(1)[0]; return !gate.pending && !gate.applied;
  })).toBe(true);
  await page.screenshot({ path: path.join(output, 'browser-stopped.png') });
  expect(errors).toEqual([]);
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ status: 'PASS_LOCAL_BROWSER_VIRTUAL_INPUT', origin,
    startedUtc, completedUtc: new Date().toISOString(), playScreens, result, pageErrors: errors,
    scope: 'Actual 5173 deployment, real AudioContext/capture worklet, distinct virtual stereo input, physical UI record/play/overdub/stop and Mark SET/CLEAR; fresh browser context.',
    limitations: ['Chromium process output muted; no physical audio audibility or latency claim.', 'Memory and FX Bank are covered separately by the full UI regression.'] }, null, 2));
} catch (error) {
  const diagnostic = await page.evaluate(async () => {
    const facade = window.__webrcLocalSmokeFacade;
    const track = facade.tracks[0];
    return { status: facade.getUiStatus(), state: track.state, recordingDiagnostic: track.recordingDiagnostic,
      recordingStarting: track.recordingStarting, isRecording: track.isRecording,
      contextState: track.engine.context.state, time: track.engine.context.currentTime,
      trackText: document.querySelector('.track-strip[data-track-id="1"]')?.textContent,
      button: document.querySelector('.track-strip[data-track-id="1"] [data-panel-control="record-play"]')?.outerHTML };
  }).catch(e => ({ diagnosticFailure: String(e) }));
  await page.screenshot({ path: path.join(output, 'failure.png') });
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), diagnostic, errors, consoleMessages }, null, 2));
  throw error;
} finally { await context.close(); await browser.close(); }
