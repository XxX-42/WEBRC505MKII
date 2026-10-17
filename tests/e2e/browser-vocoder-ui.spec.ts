import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

const initScriptPath = path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
});

test('exposes and persists VOCODER filterbank, carrier and mix on Browser Input and Track panels', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const setRange = async (editor: Locator, label: string, value: number) => {
    await editor.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };

  const inputPanel = page.locator('.top-panel [data-panel="input-fx"]');
  const inputSelector = inputPanel.locator('select.fx-select').first();
  await expect(inputSelector.locator('option[value="VOCODER"]')).toHaveCount(1);
  await inputSelector.selectOption('VOCODER');
  const inputEditor = inputPanel.locator('[data-vocoder-editor]');
  await expect(inputEditor).toBeVisible();
  await expect(inputEditor).toContainText('Formant shifting is unsupported and rejected');
  await setRange(inputEditor, 'VOCODER filterbank bands', 12);
  await inputEditor.getByLabel('VOCODER carrier').selectOption('2');
  await setRange(inputEditor, 'VOCODER effect mix percent', 55);

  const trackPanel = page.locator('.top-panel [data-panel="track-fx"]');
  const trackSelector = trackPanel.locator('select.fx-select').first();
  await expect(trackSelector.locator('option[value="VOCODER"]')).toHaveCount(1);
  await trackSelector.selectOption('VOCODER');
  const trackEditor = trackPanel.locator('[data-vocoder-editor]');
  await expect(trackEditor).toBeVisible();
  await setRange(trackEditor, 'VOCODER filterbank bands', 20);
  await trackEditor.getByLabel('VOCODER carrier').selectOption('0');
  await setRange(trackEditor, 'VOCODER effect mix percent', 65);

  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ type?: string; vocoderParameters?: { bands?: number; carrier?: number; mixPercent?: number } }>;
      trackSlots?: Array<{ type?: string; vocoderParameters?: { bands?: number; carrier?: number; mixPercent?: number } }>;
    };
    return saved.inputSlots?.[0]?.type === 'VOCODER'
      && saved.inputSlots[0].vocoderParameters?.bands === 12
      && saved.inputSlots[0].vocoderParameters?.carrier === 2
      && saved.inputSlots[0].vocoderParameters?.mixPercent === 55
      && saved.trackSlots?.[0]?.type === 'VOCODER'
      && saved.trackSlots[0].vocoderParameters?.bands === 20
      && saved.trackSlots[0].vocoderParameters?.carrier === 0
      && saved.trackSlots[0].vocoderParameters?.mixPercent === 65;
  });

  await page.reload();
  await startBrowserAudio(page);
  const restoredInput = page.locator('[data-panel="input-fx"] [data-vocoder-editor]');
  const restoredTrack = page.locator('[data-panel="track-fx"] [data-vocoder-editor]');
  await expect(restoredInput).toBeVisible();
  await expect(restoredInput.getByLabel('VOCODER filterbank bands')).toHaveValue('12');
  await expect(restoredInput.getByLabel('VOCODER carrier')).toHaveValue('2');
  await expect(restoredInput.getByLabel('VOCODER effect mix percent')).toHaveValue('55');
  await expect(restoredTrack).toBeVisible();
  await expect(restoredTrack.getByLabel('VOCODER filterbank bands')).toHaveValue('20');
  await expect(restoredTrack.getByLabel('VOCODER carrier')).toHaveValue('0');
  await expect(restoredTrack.getByLabel('VOCODER effect mix percent')).toHaveValue('65');
});

test('exposes and persists OSC VOC (M) MIDI carrier controls on Browser Input and Track banks', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const setRange = async (editor: Locator, label: string, value: number) => {
    await editor.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };

  const inputPanel = page.locator('.top-panel [data-panel="input-fx"]');
  const inputSelector = inputPanel.locator('select.fx-select').first();
  await expect(inputSelector.locator('option[value="OSC VOC (M)"]')).toHaveCount(1);
  await inputSelector.selectOption('OSC VOC (M)');
  const inputEditor = inputPanel.locator('[data-osc-voc-editor]');
  await expect(inputEditor).toBeVisible();
  await expect(inputEditor.locator('[data-midi-status]')).toContainText('MIDI input disconnected');
  await inputEditor.getByLabel('OSC VOC carrier waveform').selectOption('2');
  await inputEditor.getByLabel('OSC VOC MIDI channel').selectOption('7');
  await setRange(inputEditor, 'OSC VOC octave transpose', 12);
  await setRange(inputEditor, 'OSC VOC effect mix', 56);

  const trackPanel = page.locator('.top-panel [data-panel="track-fx"]');
  const trackSelector = trackPanel.locator('select.fx-select').first();
  await expect(trackSelector.locator('option[value="OSC VOC (M)"]')).toHaveCount(1);
  await trackSelector.selectOption('OSC VOC (M)');
  const trackEditor = trackPanel.locator('[data-osc-voc-editor]');
  await expect(trackEditor).toBeVisible();
  await trackEditor.getByLabel('OSC VOC carrier waveform').selectOption('1');
  await trackEditor.getByLabel('OSC VOC MIDI channel').selectOption('12');
  await setRange(trackEditor, 'OSC VOC octave transpose', -12);
  await setRange(trackEditor, 'OSC VOC effect mix', 63);

  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ type?: string; oscVocParameters?: { waveform?: number; midiChannel?: number; octaveSemitones?: number; mixPercent?: number } }>;
      trackSlots?: Array<{ type?: string; oscVocParameters?: { waveform?: number; midiChannel?: number; octaveSemitones?: number; mixPercent?: number } }>;
    };
    return saved.inputSlots?.[0]?.type === 'OSC VOC (M)'
      && saved.inputSlots[0].oscVocParameters?.waveform === 2
      && saved.inputSlots[0].oscVocParameters?.midiChannel === 7
      && saved.inputSlots[0].oscVocParameters?.octaveSemitones === 12
      && saved.inputSlots[0].oscVocParameters?.mixPercent === 56
      && saved.trackSlots?.[0]?.type === 'OSC VOC (M)'
      && saved.trackSlots[0].oscVocParameters?.waveform === 1
      && saved.trackSlots[0].oscVocParameters?.midiChannel === 12
      && saved.trackSlots[0].oscVocParameters?.octaveSemitones === -12
      && saved.trackSlots[0].oscVocParameters?.mixPercent === 63;
  });

  await page.reload();
  await startBrowserAudio(page);
  const restoredInput = page.locator('[data-panel="input-fx"] [data-osc-voc-editor]');
  const restoredTrack = page.locator('[data-panel="track-fx"] [data-osc-voc-editor]');
  await expect(restoredInput).toBeVisible();
  await expect(restoredInput.getByLabel('OSC VOC carrier waveform')).toHaveValue('2');
  await expect(restoredInput.getByLabel('OSC VOC MIDI channel')).toHaveValue('7');
  await expect(restoredInput.getByLabel('OSC VOC octave transpose')).toHaveValue('12');
  await expect(restoredInput.getByLabel('OSC VOC effect mix')).toHaveValue('56');
  await expect(restoredTrack).toBeVisible();
  await expect(restoredTrack.getByLabel('OSC VOC carrier waveform')).toHaveValue('1');
  await expect(restoredTrack.getByLabel('OSC VOC MIDI channel')).toHaveValue('12');
  await expect(restoredTrack.getByLabel('OSC VOC octave transpose')).toHaveValue('-12');
  await expect(restoredTrack.getByLabel('OSC VOC effect mix')).toHaveValue('63');
});
