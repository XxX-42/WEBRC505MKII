import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

const initScriptPath = path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
});

test('exposes and persists OCTAVE voice levels and mix in Browser Input and Track panels', async ({ page }) => {
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
  await expect(inputSelector.locator('option[value="OCTAVE"]')).toHaveCount(1);
  await inputSelector.selectOption('OCTAVE');
  const inputEditor = inputPanel.locator('[data-octave-editor]');
  await expect(inputEditor).toBeVisible();
  await expect(inputEditor).toContainText('Pitch tracking sensitivity and formant preservation are unsupported');
  await setRange(inputEditor, 'OCTAVE minus 24 level', 30);
  await setRange(inputEditor, 'OCTAVE minus 12 level', 50);
  await setRange(inputEditor, 'OCTAVE plus 12 level', 20);
  await setRange(inputEditor, 'OCTAVE harmony mix percent', 65);

  const trackPanel = page.locator('.top-panel [data-panel="track-fx"]');
  const trackSelector = trackPanel.locator('select.fx-select').first();
  await expect(trackSelector.locator('option[value="OCTAVE"]')).toHaveCount(1);
  await trackSelector.selectOption('OCTAVE');
  const trackEditor = trackPanel.locator('[data-octave-editor]');
  await expect(trackEditor).toBeVisible();
  await setRange(trackEditor, 'OCTAVE minus 24 level', 10);
  await setRange(trackEditor, 'OCTAVE minus 12 level', 70);
  await setRange(trackEditor, 'OCTAVE plus 12 level', 45);
  await setRange(trackEditor, 'OCTAVE harmony mix percent', 50);

  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ type?: string; octaveParameters?: { minus24Level?: number; minus12Level?: number; plus12Level?: number; mixPercent?: number } }>;
      trackSlots?: Array<{ type?: string; octaveParameters?: { minus24Level?: number; minus12Level?: number; plus12Level?: number; mixPercent?: number } }>;
    };
    return saved.inputSlots?.[0]?.type === 'OCTAVE'
      && saved.inputSlots[0].octaveParameters?.minus24Level === 30
      && saved.inputSlots[0].octaveParameters?.minus12Level === 50
      && saved.inputSlots[0].octaveParameters?.plus12Level === 20
      && saved.inputSlots[0].octaveParameters?.mixPercent === 65
      && saved.trackSlots?.[0]?.type === 'OCTAVE'
      && saved.trackSlots[0].octaveParameters?.minus24Level === 10
      && saved.trackSlots[0].octaveParameters?.minus12Level === 70
      && saved.trackSlots[0].octaveParameters?.plus12Level === 45
      && saved.trackSlots[0].octaveParameters?.mixPercent === 50;
  });

  await page.reload();
  await startBrowserAudio(page);
  const restoredInput = page.locator('[data-panel="input-fx"] [data-octave-editor]');
  const restoredTrack = page.locator('[data-panel="track-fx"] [data-octave-editor]');
  await expect(restoredInput).toBeVisible();
  await expect(restoredInput.getByLabel('OCTAVE minus 24 level')).toHaveValue('30');
  await expect(restoredInput.getByLabel('OCTAVE minus 12 level')).toHaveValue('50');
  await expect(restoredInput.getByLabel('OCTAVE plus 12 level')).toHaveValue('20');
  await expect(restoredInput.getByLabel('OCTAVE harmony mix percent')).toHaveValue('65');
  await expect(restoredTrack).toBeVisible();
  await expect(restoredTrack.getByLabel('OCTAVE minus 24 level')).toHaveValue('10');
  await expect(restoredTrack.getByLabel('OCTAVE minus 12 level')).toHaveValue('70');
  await expect(restoredTrack.getByLabel('OCTAVE plus 12 level')).toHaveValue('45');
  await expect(restoredTrack.getByLabel('OCTAVE harmony mix percent')).toHaveValue('50');
});
