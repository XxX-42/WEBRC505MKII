import path from 'node:path';
import { expect, test } from '@playwright/test';

test('renders five private Browser A–D banks with real AudioWorklets and isolated track signals', async ({ page }) => {
  await page.goto('/?audio=browser');
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/audio/BrowserTrackFxChain.ts';
    const { BrowserTrackFxChain } = await import(moduleUrl);
    const rate = 48_000; const frames = 4096;
    const context = new OfflineAudioContext({ numberOfChannels: 10, length: frames, sampleRate: rate });
    const loaded = context.audioWorklet.addModule('/worklets/fx-processor.js');
    const banks = Array.from({ length: 5 }, () => new BrowserTrackFxChain(context as unknown as AudioContext, () => loaded));
    const merger = context.createChannelMerger(10); merger.connect(context.destination);
    const input = context.createBuffer(2, frames, rate);
    for (let channel = 0; channel < 2; channel++) for (let frame = 0; frame < frames; frame++) input.getChannelData(channel)[frame] = 0.2 * Math.sin(2 * Math.PI * (channel ? 660 : 440) * frame / rate);
    banks[0].setType(0, 'MANUAL PAN'); banks[0].setNamedParameters(0, { manualPanPosition: -1, mix: 1 }); banks[0].setActive(0, true);
    for (let track = 0; track < 5; track++) {
      const source = context.createBufferSource(); source.buffer = input; source.connect(banks[track].input);
      const splitter = context.createChannelSplitter(2); banks[track].output.connect(splitter);
      splitter.connect(merger, 0, track * 2); splitter.connect(merger, 1, track * 2 + 1); source.start(0);
    }
    await loaded;
    for (let retry = 0; retry < 100 && banks[0].getStatus(1).slots[0].state === 'loading'; retry++) await new Promise((resolve) => setTimeout(resolve, 1));
    const status = banks.map((bank, index) => bank.getStatus(index + 1));
    const rendered = await context.startRendering();
    let unaffectedDifference = 0; let firstRightPeak = 0; let firstLeftEnergy = 0;
    for (let frame = 0; frame < frames; frame++) {
      firstRightPeak = Math.max(firstRightPeak, Math.abs(rendered.getChannelData(1)[frame]!));
      firstLeftEnergy += rendered.getChannelData(0)[frame]! ** 2;
      for (let track = 1; track < 5; track++) for (let channel = 0; channel < 2; channel++) unaffectedDifference = Math.max(unaffectedDifference, Math.abs(rendered.getChannelData(track * 2 + channel)[frame]! - input.getChannelData(channel)[frame]!));
    }
    return { status, unaffectedDifference, firstRightPeak, firstLeftEnergy };
  });
  expect(result.status).toHaveLength(5);
  expect(result.status[0].slots[0]).toMatchObject({ state: 'ready', active: true, bypassed: false });
  expect(result.unaffectedDifference).toBe(0);
  expect(result.firstRightPeak).toBeLessThan(1e-6);
  expect(result.firstLeftEnergy).toBeGreaterThan(1);
});

test('keeps real per-track serial processing order through the shipped worklet bundle', async ({ page }) => {
  await page.goto('/?audio=browser');
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/audio/BrowserTrackFxChain.ts';
    const { BrowserTrackFxChain } = await import(moduleUrl);
    const frames = 8192; const sampleRate = 48_000;
    const context = new OfflineAudioContext({ numberOfChannels: 4, length: frames, sampleRate });
    const loaded = context.audioWorklet.addModule('/worklets/fx-processor.js');
    const banks = [new BrowserTrackFxChain(context as unknown as AudioContext, () => loaded), new BrowserTrackFxChain(context as unknown as AudioContext, () => loaded)];
    const merger = context.createChannelMerger(4); merger.connect(context.destination);
    const input = context.createBuffer(2, frames, sampleRate);
    for (let channel = 0; channel < 2; channel++) for (let frame = 0; frame < frames; frame++) input.getChannelData(channel)[frame] = 0.4 * Math.sin(frame * 0.63) + 0.2 * Math.sin(frame * 0.017);
    for (let track = 0; track < 2; track++) {
      const types = track === 0 ? ['DSP LPF', 'DIST'] : ['DIST', 'DSP LPF'];
      for (let slot = 0; slot < 2; slot++) {
        banks[track].setType(slot, types[slot]);
        banks[track].setNamedParameters(slot, types[slot] === 'DIST' ? { driveDb: 30, mix: 1 } : { cutoffHz: 400, q: 0.7, mix: 1 });
        banks[track].setActive(slot, true);
      }
      const source = context.createBufferSource(); source.buffer = input; source.connect(banks[track].input);
      const splitter = context.createChannelSplitter(2); banks[track].output.connect(splitter);
      splitter.connect(merger, 0, track * 2); splitter.connect(merger, 1, track * 2 + 1); source.start(0);
    }
    await loaded;
    for (let retry = 0; retry < 100 && banks.some((bank) => bank.getStatus(1).slots.slice(0, 2).some((slot: { state: string }) => slot.state === 'loading')); retry++) await new Promise((resolve) => setTimeout(resolve, 1));
    const rendered = await context.startRendering(); let difference = 0; let nonFinite = 0;
    for (let frame = 0; frame < frames; frame++) {
      difference = Math.max(difference, Math.abs(rendered.getChannelData(0)[frame]! - rendered.getChannelData(2)[frame]!));
      for (let channel = 0; channel < 4; channel++) if (!Number.isFinite(rendered.getChannelData(channel)[frame])) nonFinite++;
    }
    return { difference, nonFinite };
  });
  expect(result.nonFinite).toBe(0); expect(result.difference).toBeGreaterThan(0.001);
});

test('selects target track/slot explicitly and restores independent settings without changing the shared bank', async ({ page }) => {
  await page.addInitScript({ path: path.join(process.cwd(), 'tests/e2e/initMocks.js') });
  await page.goto('/?audio=browser&ui=classic');
  const panel = page.locator('[data-panel="track-fx"]');
  await panel.getByLabel('Track FX target', { exact: true }).selectOption('1');
  await expect(panel.locator('[data-track-fx-context]')).toHaveText('TRACK 1 · SLOT A');
  await panel.getByLabel('Per-track FX type', { exact: true }).selectOption('DELAY');
  await panel.getByLabel('Toggle per-track FX slot', { exact: true }).click();
  await panel.locator('summary').click();
  await panel.getByLabel('Track 1 slot A delayTimeMs', { exact: true }).fill('211');
  await panel.getByLabel('Track 1 slot A delayTimeMs', { exact: true }).dispatchEvent('change');
  await panel.getByLabel('Track FX target', { exact: true }).selectOption('2');
  await expect(panel.getByLabel('Per-track FX type', { exact: true })).toHaveValue('NONE');
  await panel.getByLabel('Track FX target', { exact: true }).selectOption('5');
  await panel.getByLabel('Select Track 5 FX slot D', { exact: true }).click();
  await panel.getByLabel('Per-track FX type', { exact: true }).selectOption('MANUAL PAN');
  await page.reload();
  await expect(panel.getByLabel('Track FX target', { exact: true })).toHaveValue('5');
  await expect(panel.locator('[data-track-fx-context]')).toHaveText('TRACK 5 · SLOT D');
  await expect(panel.getByLabel('Per-track FX type', { exact: true })).toHaveValue('MANUAL PAN');
  await panel.getByLabel('Track FX target', { exact: true }).selectOption('1');
  await expect(panel.getByLabel('Per-track FX type', { exact: true })).toHaveValue('DELAY');
  await expect(panel.getByLabel('Toggle per-track FX slot', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  await panel.locator('summary').click();
  await expect(panel.getByLabel('Track 1 slot A delayTimeMs', { exact: true })).toHaveValue('211');
  await panel.getByLabel('Track FX target', { exact: true }).selectOption('shared');
  await expect(panel.locator('select.fx-select')).toHaveValue('FILTER');
});
