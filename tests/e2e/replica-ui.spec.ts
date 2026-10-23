import fs from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { findLcdField, lcdScreen, openClassicFxEditor, selectLcdEnum, setLcdBoolean, setLcdRange, startBrowserAudio } from './uiHelpers';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;

async function actualTrackState(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    return AudioEngine.getInstance().tracks[0]!.state;
  });
}

test('replica keeps the physical control inventory and warns below readable viewport size', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/?audio=browser&ui=classic');
    const face = page.getByTestId('rc505-physical-face');
    await expect(face).toBeVisible();
    await expect(face.locator('button:visible')).toHaveCount(41);
    await expect(face.locator('.hardware-knob-wrapper:visible')).toHaveCount(7);
    await expect(face.locator('.hardware-fader')).toHaveCount(5);
    await expect(face.getByRole('button', { name: 'Toggle Undo/Redo control layer', exact: true })).toBeDisabled();
    await expect(face.getByRole('button', { name: 'Record or play track', exact: true }).first()).toBeDisabled();
    const disabledRecord = face.locator('.track-strip[data-track-id="1"] [data-panel-control="record-play"]');
    await expect(disabledRecord).toHaveCSS('opacity', '0.64');
    await expect(disabledRecord.locator('.button-label')).toHaveCSS('color', 'rgb(241, 242, 245)');
    await expect(face.locator('.track-strip[data-track-id="1"] .stop-disc')).toHaveCSS('opacity', '0.62');
    if (viewport.width === 1366) {
      const memoryCells = page.locator('.lcd-data-rows .lcd-data-row span');
      expect(await memoryCells.allTextContents()).toEqual(['MEMORY NO.', '—', 'MEMORY DATA', 'PARTIAL', 'NUMBER SOURCE', 'UNAVAILABLE']);
      expect(await memoryCells.evaluateAll((elements) => elements.every((element) => {
        return element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight;
      }))).toBe(true);
    }
    const zoom = Number(await page.getByRole('slider', { name: 'Faceplate zoom' }).inputValue());
    expect(zoom).toBeGreaterThanOrEqual(0.8);
    if (viewport.width === 390) await expect(page.locator('.viewport-warning')).toContainText('当前窗口过窄／过矮');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`replica-${viewport.width}.png`), fullPage: true });
    if (viewport.width !== 390) {
      await page.getByTestId('rc505-lcd-screen').screenshot({ path: testInfo.outputPath(`lcd-${viewport.width}.png`) });
    }
  }
  expect(errors).toEqual([]);
});

test('hardware MENU, LOOP and RHYTHM controls navigate in the physical LCD without floating editors', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  const face = page.getByTestId('rc505-physical-face');
  const screen = lcdScreen(page);
  const menu = face.getByRole('button', { name: 'Open menu', exact: true });
  await menu.focus();
  await menu.press('Enter');
  await expect(screen).toBeVisible();
  await expect(screen).toContainText(/SYSTEM|MENU|SETTINGS/i);
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
  await expect(face.locator('[data-panel-control="screen-encoder-3"]')).toBeFocused();
  await page.getByRole('button', { name: 'Exit current page', exact: true }).click();
  await expect(menu).toBeFocused();

  const rhythmEdit = face.getByTestId('rhythm-edit-button');
  await rhythmEdit.click();
  await expect(screen).toContainText(/RHYTHM/i);
  await expect(screen.locator('.lcd-name')).toHaveCount(0);
  const rhythmVolumeLabel = screen.locator('[data-field-key="volume"] .lcd-field-label');
  await expect(rhythmVolumeLabel).toHaveText('VOLUME');
  const labelWidths = await rhythmVolumeLabel.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(labelWidths.scroll).toBeLessThanOrEqual(labelWidths.client);
  await expect(screen.locator('[data-field-key="pattern"] .lcd-field-label')).toHaveCSS('font-size', '13px');
  await screen.screenshot({ path: testInfo.outputPath('lcd-editor-1920.png') });
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
  await expect(screen.locator(':focus')).toHaveCount(1);
  const patternField = await findLcdField(page, 'pattern');
  const pattern = patternField.getByTestId('lcd-field-pattern');
  await expect(pattern).toBeEnabled();
  await expect(JSON.parse((await pattern.getAttribute('data-option-labels')) ?? '[]')).toHaveLength(240);
  await selectLcdEnum(page, 'pattern', '240');
  await expect(patternField.locator('.lcd-enum-value')).toContainText('240 ·');
  await selectLcdEnum(page, 'variation', 'D');
  await page.getByRole('button', { name: 'Exit current page', exact: true }).click();
  await expect(rhythmEdit).toBeFocused();

  const loop = face.getByTestId('physical-loop-button');
  await loop.click();
  await expect(screen).toHaveAttribute('data-classic-screen', 'loop-root');
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
  await expect(face.locator('[data-panel-control="screen-encoder-1"]')).toBeFocused();
  await page.getByRole('button', { name: 'Exit current page', exact: true }).click();
  await expect(loop).toBeFocused();

  const trackOne = face.locator('.track-strip[data-track-id="1"]');
  const perTrackFx = trackOne.locator('[data-track-control="fx"]');
  await expect(perTrackFx).toBeDisabled();
  await expect(perTrackFx).toHaveAttribute('data-hardware-role', 'TRACK_FX_APPLY');
  await openClassicFxEditor(page, 'track');
  await expect(screen).toHaveAttribute('data-classic-screen', 'editor-track-fx');
  await expect(screen).toContainText(/TRACK FX/i);
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit current page', exact: true }).click();
  await trackOne.locator('[data-track-control="select"]').click();
  await expect(screen).toHaveAttribute('data-classic-screen', 'editor-track');
  await expect(screen).toContainText(/TRACK\s*1|TR\s*1/i);
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
});

test('LCD Input FX exposes slot, type, active and named parameters across PAGE subpages', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  const screen = await openClassicFxEditor(page, 'input');
  await expect(screen).toContainText(/INPUT FX/i);
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);

  await selectLcdEnum(page, 'slot', 'B');
  await selectLcdEnum(page, 'type', 'PREAMP');
  await setLcdBoolean(page, 'active', true);
  const activeField = await findLcdField(page, 'active');
  await expect(activeField.getByTestId('lcd-field-active')).toHaveAttribute('aria-pressed', 'true');

  const gainField = await findLcdField(page, 'input-gainPercent');
  await expect(screen.locator('.lcd-row.top')).toContainText('2/3');
  await setLcdRange(page, 'input-gainPercent', 73);
  await expect(gainField.getByTestId('lcd-field-input-gainPercent')).toHaveValue('73');

  await page.getByRole('button', { name: 'Next display page', exact: true }).click();
  await expect(screen.locator('.lcd-row.top')).toContainText('3/3');
  await expect(screen.locator('.lcd-field-grid [data-field-key^="input-"]')).toHaveCount(2);
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
});

test('Native simulation bridge readiness is visible on the shared Classic faceplate', async ({ page }, testInfo) => {
  test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the explicit no-hardware Native simulation target.');
  if (!simulationHost) return;
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  let host: ChildProcess | undefined;
  let hostStartError: Error | undefined;
  try {
    let preexistingHealth = false;
    try {
      preexistingHealth = (await fetch('http://127.0.0.1:18755/health')).ok;
    } catch {
      // The simulation must own the port before readiness is checked.
    }
    expect(preexistingHealth, 'Port 18755 must be free before starting the Native simulation host.').toBe(false);
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
        // The explicit simulation host may need a moment to bind its local port.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ready, 'Native simulation host did not start on 127.0.0.1:18755').toBe(true);
    await page.goto('/?audio=native&ui=classic');
    await expect(page.locator('.status-pill')).toContainText('NATIVE AUDIO READY', { timeout: 15_000 });
    const face = page.getByTestId('rc505-physical-face');
    await expect(face.locator('button:visible')).toHaveCount(41);
    await expect(face.locator('.hardware-knob-wrapper:visible')).toHaveCount(7);
    await expect(face.locator('.hardware-fader')).toHaveCount(5);
    await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
    const result = {
      mode: 'Native simulation',
      simulation: true,
      physicalDeviceValidated: false,
      bridgeStatus: (await page.locator('.status-pill').innerText()).trim(),
      capabilitySummary: (await page.locator('.mode-summary').innerText()).trim(),
      lcdStatus: (await page.locator('[data-testid="rc505-lcd-screen"] .lcd-status').innerText()).trim(),
      controlCounts: { buttons: 41, knobs: 7, faders: 5 },
      commandWritten: false,
    };
    await fs.writeFile(testInfo.outputPath('native-simulation-bridge.json'), JSON.stringify(result, null, 2));
    await page.screenshot({ path: testInfo.outputPath('native-simulation-bridge-1920.png'), fullPage: true });
    await page.getByTestId('rc505-lcd-screen').screenshot({ path: testInfo.outputPath('native-simulation-lcd-1920.png') });
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

test('real Browser UI starts on a gesture and records, plays, overdubs and stops virtual input', async ({ page }, testInfo) => {
  // Chromium's virtual capture device supplies deterministic input. The real
  // AudioContext, worklets and TrackAudio remain in use; this is not hardware RTL.
  await page.goto('/?audio=browser&ui=classic');
  await expect(page.getByTestId('start-audio')).toHaveText('START AUDIO');
  await page.getByTestId('start-audio').click();
  await expect(page.getByTestId('input-status')).toHaveText('INPUT READY · OUTPUT READY', { timeout: 25000 });
  const firstTrack = page.locator('.track-strip[data-track-id="1"]');
  const record = firstTrack.getByRole('button', { name: 'Record or play track', exact: true });
  const stop = firstTrack.getByRole('button', { name: 'Stop track (hold to clear)', exact: true });
  await record.click();
  await expect.poll(() => actualTrackState(page)).toBe('RECORDING');
  await expect(firstTrack.locator('.indicator-chip.active')).toHaveText('REC');
  await page.waitForTimeout(350);
  await page.screenshot({ path: testInfo.outputPath('browser-recording-glow.png'), fullPage: true });
  await stop.click();
  await expect.poll(() => actualTrackState(page)).toBe('STOPPED');
  await expect(firstTrack.locator('.indicator-chip.active')).toHaveCount(0);
  await record.click();
  await expect.poll(() => actualTrackState(page)).toBe('PLAYING');
  await expect(firstTrack.locator('.indicator-chip.active')).toHaveText('PLAY');
  await page.screenshot({ path: testInfo.outputPath('browser-playing-glow.png'), fullPage: true });
  await record.click();
  await expect.poll(() => actualTrackState(page)).toBe('OVERDUBBING');
  await expect(firstTrack.locator('.indicator-chip.active')).toHaveText('DUB');
  await page.screenshot({ path: testInfo.outputPath('browser-overdub-glow.png'), fullPage: true });
  await stop.click();
  await expect.poll(() => actualTrackState(page)).toBe('STOPPED');
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const engine = AudioEngine.getInstance();
    const track = engine.tracks[0] as any;
    const samples: Float32Array = track.audioBuffer?.getChannelData(0) ?? new Float32Array();
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    return { frames: samples.length, sampleRate: track.audioBuffer?.sampleRate ?? 0, channels: track.audioBuffer?.numberOfChannels ?? 0, peak, ready: engine.getUiStatus().ready };
  });
  expect(result.frames).toBeGreaterThan(0);
  // Chromium's virtual capture device exposes two input channels here, and the
  // Browser path must preserve that channel layout through record and overdub.
  expect(result.channels).toBe(2);
  expect(result.peak).toBeGreaterThan(0.0001);
  expect(result.ready).toBe(true);
  await fs.writeFile(testInfo.outputPath('browser-runtime.json'), JSON.stringify({
    input: 'Chromium virtual microphone', hardwareLatencyMeasured: false,
    operations: ['record', 'stop', 'play', 'overdub', 'stop'], ...result,
  }, null, 2));
  await page.screenshot({ path: testInfo.outputPath('browser-recorded.png'), fullPage: true });
  // Cancelling a key-held STOP must cancel its 2000 ms clear timer.
  await stop.focus();
  await page.keyboard.down('Space');
  await page.waitForTimeout(100);
  await record.focus();
  await page.keyboard.up('Space');
  await page.waitForTimeout(2100);
  await expect.poll(() => actualTrackState(page)).toBe('STOPPED');
  await stop.focus();
  await page.keyboard.down('Space');
  // Leave room for browser/driver IPC before asserting the pre-clear state.
  await page.waitForTimeout(1500);
  await expect.poll(() => actualTrackState(page)).toBe('STOPPED');
  await page.waitForTimeout(600);
  await page.keyboard.up('Space');
  await expect.poll(() => actualTrackState(page)).toBe('EMPTY');
  const output = page.getByRole('slider', { name: 'Master output level', exact: true });
  await output.focus();
  await output.press('Home');
  await expect(output).toHaveAttribute('aria-valuenow', '0');
  expect(await page.evaluate(async () => (await import('/src/audio/AudioEngine.ts')).AudioEngine.getInstance().getOutputLevel())).toBe(0);
});

test('microphone denial keeps real output ready and CONNECT INPUT retries successfully', async ({ page }) => {
  await page.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let denied = false;
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (!denied) {
        denied = true;
        return Promise.reject(new DOMException('Permission denied by startup test', 'NotAllowedError'));
      }
      return capture(constraints);
    };
  });
  await page.goto('/?audio=browser&ui=classic');
  const start = page.getByTestId('start-audio');
  await start.click();
  await expect(page.getByRole('alert')).toContainText('Permission denied by startup test');
  await expect(page.getByTestId('input-status')).toHaveText('INPUT NOT CONNECTED · OUTPUT READY');
  await expect(start).toHaveText('CONNECT INPUT');
  await start.click();
  await expect(page.getByTestId('input-status')).toHaveText('INPUT READY · OUTPUT READY');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('microphone timeout can retry and closes a late granted stream', async ({ page }) => {
  test.setTimeout(45_000);
  await page.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let first = true;
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (!first) return capture(constraints);
      first = false;
      return new Promise<MediaStream>((resolve) => {
        (window as any).__finishLateCapture = async () => {
          const stream = await capture(constraints);
          (window as any).__lateCapture = stream;
          resolve(stream);
        };
      });
    };
  });
  await page.goto('/?audio=browser&ui=classic');
  const start = page.getByTestId('start-audio');
  await start.click();
  await expect(page.getByRole('alert')).toContainText('timed out after 20000 ms', { timeout: 25_000 });
  await expect(page.getByTestId('input-status')).toHaveText('INPUT NOT CONNECTED · OUTPUT READY');
  await expect(start).toHaveText('CONNECT INPUT');
  await page.evaluate(async () => (window as any).__finishLateCapture());
  await expect.poll(() => page.evaluate(() => (window as any).__lateCapture.getTracks().map((track: MediaStreamTrack) => track.readyState))).toEqual(['ended']);
  await start.click();
  await expect(page.getByTestId('input-status')).toHaveText('INPUT READY · OUTPUT READY');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
