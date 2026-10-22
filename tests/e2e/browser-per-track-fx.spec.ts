import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import {
  findLcdField,
  openFxEditor,
  openLcdPage,
  selectLcdEnum,
  setLcdBoolean,
  startBrowserAudio,
} from './uiHelpers';

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

test('Tech compatibility FX editor: selects target track/slot and restores state independently from the shared bank', async ({ page }) => {
  await page.addInitScript({ path: path.join(process.cwd(), 'tests/e2e/initMocks.js') });
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);
  const panel = await openFxEditor(page, 'track');
  await expect(page.locator('.app-root')).toHaveAttribute('data-ui-style', 'tech');
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
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
  await startBrowserAudio(page);
  const restoredPanel = await openFxEditor(page, 'track');
  await expect(restoredPanel.getByLabel('Track FX target', { exact: true })).toHaveValue('5');
  await expect(restoredPanel.locator('[data-track-fx-context]')).toHaveText('TRACK 5 · SLOT D');
  await expect(restoredPanel.getByLabel('Per-track FX type', { exact: true })).toHaveValue('MANUAL PAN');
  await restoredPanel.getByLabel('Track FX target', { exact: true }).selectOption('1');
  await expect(restoredPanel.getByLabel('Per-track FX type', { exact: true })).toHaveValue('DELAY');
  await expect(restoredPanel.getByLabel('Toggle per-track FX slot', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  await restoredPanel.locator('summary').click();
  await expect(restoredPanel.getByLabel('Track 1 slot A delayTimeMs', { exact: true })).toHaveValue('211');
  await restoredPanel.getByLabel('Track FX target', { exact: true }).selectOption('shared');
  await expect(restoredPanel.locator('select.fx-select').first()).toHaveValue('FILTER');
});

test('LCD per-track OSC VOC editor sends MIDI connect for its exact track and slot', async ({ page }) => {
  await page.addInitScript({ path: path.join(process.cwd(), 'tests/e2e/initMocks.js') });
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);
  const panel = await openFxEditor(page, 'track');
  await panel.getByLabel('Track FX target', { exact: true }).selectOption('4');
  await panel.getByLabel('Select Track 4 FX slot C', { exact: true }).click();
  await panel.getByLabel('Per-track FX type', { exact: true }).selectOption('OSC VOC (M)');
  await expect(panel.locator('[data-osc-voc-editor]')).toHaveCount(1);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const engine = AudioEngine.getInstance();
    const global = window as unknown as { __capturedBrowserMidiTarget?: Record<string, unknown> };
    engine.connectMidiInput = (target) => {
      global.__capturedBrowserMidiTarget = target ? { ...target } : {};
      return Promise.resolve('connected');
    };
  });
  await panel.locator('[data-osc-voc-editor] button').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __capturedBrowserMidiTarget?: Record<string, unknown> }).__capturedBrowserMidiTarget ?? null))
    .toEqual({ path: 'track', trackId: 4, slot: 'C', effectId: 'osc_voc_m' });
  await expect(panel.locator('[data-midi-status]')).toContainText('MIDI input connected');
});

test('Classic LCD FX fields and four screen knobs preserve the selected target in Browser DSP and Native mock bridge', async ({ page }) => {
  await page.addInitScript({ path: path.join(process.cwd(), 'tests/e2e/initMocks.js') });

  const setKnob = async (knob: Locator, value: number) => {
    await knob.focus();
    await knob.press('Home');
    for (let step = 0; step < value / 10; step += 1) await knob.press('PageUp');
    await expect(knob).toHaveAttribute('aria-valuenow', String(value));
  };
  const setScreenKnobIndex = async (knob: Locator, value: number) => {
    await knob.focus();
    await knob.press('Home');
    for (let step = 0; step < value; step += 1) await knob.press('ArrowRight');
    await expect(knob).toHaveAttribute('aria-valuenow', String(value));
  };

  const runMode = async (mode: 'browser' | 'native') => {
    const native = mode === 'native';
    const url = native
      ? '/?audio=native&ui=classic&nativeTrackFxUiE2e=1'
      : '/?audio=browser&ui=classic';
    if (native) {
      // Seed a running, already-installed per-track slot so Native accepts live
      // amount changes and the test can assert the exact bridge target.
      await page.addInitScript(() => {
        const tracks = Array.from({ length: 5 }, (_, index) => ({
          trackId: index + 1,
          activeSlot: 'A',
          slots: ['A', 'B', 'C', 'D'].map((id) => ({
            id,
            type: index === 1 && id === 'B' ? 'PHASER' : 'NONE',
            value: 0,
            active: false,
            namedParameters: {},
          })),
        }));
        localStorage.setItem('webrc505_native_per_track_fx_v1', JSON.stringify({ version: 1, target: 'shared', tracks }));
      });
    }
    await page.goto(url);
    if (!native) await startBrowserAudio(page);

    const screen = await openLcdPage(page, 'track-fx-edit-button');
    await expect(screen).toContainText(/TRACK FX/i);
    await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);

    const targetField = await findLcdField(page, 'target');
    const targetSelect = targetField.getByTestId('lcd-field-target');
    await expect(targetSelect).toHaveValue('0');

    const physicalKnob = page.getByRole('slider', { name: 'TRACK FX selected effect value', exact: true });
    await expect(physicalKnob).toHaveAttribute('aria-disabled', 'false');
    await setKnob(physicalKnob, 90);
    let amountField = await findLcdField(page, 'amount');
    await expect(amountField.getByTestId('lcd-field-amount')).toHaveValue('90');

    const targetKnob = page.getByRole('slider', { name: 'FX TARGET screen control', exact: true });
    await setScreenKnobIndex(targetKnob, 2);
    await expect(targetSelect).toHaveValue('2');

    const slotKnob = page.getByRole('slider', { name: 'SLOT screen control', exact: true });
    await setScreenKnobIndex(slotKnob, 1);
    const slotField = await findLcdField(page, 'slot');
    await expect(slotField.getByTestId('lcd-field-slot').locator('option:checked')).toHaveText('B');

    const effectType = native ? 'PHASER' : 'DELAY';
    const typeField = await findLcdField(page, 'type');
    const typeSelect = typeField.getByTestId('lcd-field-type');
    const typeOptions = await typeSelect.locator('option').allTextContents();
    const typeIndex = typeOptions.findIndex((label) => label.trim() === effectType);
    expect(typeIndex, `${effectType} must be offered by the ${mode} Track FX editor`).toBeGreaterThanOrEqual(0);
    const typeKnob = page.getByRole('slider', { name: 'EFFECT TYPE screen control', exact: true });
    await setScreenKnobIndex(typeKnob, typeIndex);
    await expect(typeSelect.locator('option:checked')).toHaveText(effectType);
    await expect(physicalKnob).toHaveAttribute('aria-disabled', 'false');

    const amountKnob = page.getByRole('slider', { name: 'AMOUNT screen control', exact: true });
    await setKnob(amountKnob, 60);
    amountField = await findLcdField(page, 'amount');
    await expect(amountField.getByTestId('lcd-field-amount')).toHaveValue('60');
    await setLcdBoolean(page, 'active', true);

    if (native) {
      await expect.poll(() => page.evaluate(() => {
        const requests = (window as unknown as { __rc505NativeCatalogSlotRequests: Array<Record<string, unknown>> }).__rc505NativeCatalogSlotRequests;
        return requests.some((request) => request.trackId === 2 && request.slot === 'B' && request.effectId === 'phaser'
          && (request.parameters as Record<string, number> | undefined)?.depth === 0.6);
      })).toBe(true);
    }

    await selectLcdEnum(page, 'target', 'SHARED BANK');
    amountField = await findLcdField(page, 'amount');
    await expect(amountField.getByTestId('lcd-field-amount')).toHaveValue('90');
    await selectLcdEnum(page, 'target', 'TRACK 2');
    amountField = await findLcdField(page, 'amount');
    await expect(amountField.getByTestId('lcd-field-amount')).toHaveValue('60');

    const activeField = await findLcdField(page, 'active');
    await expect(activeField.getByTestId('lcd-field-active')).toHaveAttribute('aria-pressed', 'true');
    amountField = await findLcdField(page, 'amount');
    const screenAmountKnob = page.getByRole('slider', { name: 'AMOUNT screen control', exact: true });
    await setKnob(screenAmountKnob, 0);
    await expect(amountField.getByTestId('lcd-field-amount')).toHaveValue('0');
    await selectLcdEnum(page, 'target', 'SHARED BANK');
    amountField = await findLcdField(page, 'amount');
    await expect(amountField.getByTestId('lcd-field-amount')).toHaveValue('90');
    await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);

    if (native) {
      await expect.poll(() => page.evaluate(() => {
        const requests = (window as unknown as { __rc505NativeCatalogSlotRequests: Array<Record<string, unknown>> }).__rc505NativeCatalogSlotRequests;
        return requests.some((request) => request.trackId === 2 && request.slot === 'B' && request.effectId === 'phaser'
          && (request.parameters as Record<string, number> | undefined)?.depth === 0);
      })).toBe(true);
    }
  };

  await runMode('browser');
  await runMode('native');
});
