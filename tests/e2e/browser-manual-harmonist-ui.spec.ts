import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';

const initScriptPath = path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
});

test('exposes and persists the two HRM MANUAL voices in Browser Input and Track panels', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');

  const setRange = async (targetEditor: Locator, label: string, value: number) => {
    await targetEditor.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };

  const inputPanel = page.locator('.top-panel [data-panel="input-fx"]');
  const inputSelector = inputPanel.locator('select.fx-select').first();
  await expect(inputSelector.locator('option[value="HRM MANUAL"]')).toHaveCount(1);
  await inputSelector.selectOption('HRM MANUAL');
  const inputEditor = inputPanel.locator('[data-hrm-manual-editor]');
  await expect(inputEditor).toBeVisible();
  await expect(inputEditor.getByLabel('Harmony voice 1 interval in semitones')).toHaveValue('7');
  await expect(inputEditor.getByLabel('Harmony voice 2 interval in semitones')).toHaveValue('12');
  await expect(inputEditor).toContainText('Formant preservation is unsupported');
  await setRange(inputEditor, 'Harmony voice 1 interval in semitones', -7);
  await setRange(inputEditor, 'Harmony voice 2 interval in semitones', 5);
  await setRange(inputEditor, 'Harmony pan percent', -30);
  await setRange(inputEditor, 'Harmony mix percent', 65);

  const trackPanel = page.locator('.top-panel [data-panel="track-fx"]');
  const trackSelector = trackPanel.locator('select.fx-select').first();
  await expect(trackSelector.locator('option[value="HRM MANUAL"]')).toHaveCount(1);
  await trackSelector.selectOption('HRM MANUAL');
  const trackEditor = trackPanel.locator('[data-hrm-manual-editor]');
  await expect(trackEditor).toBeVisible();
  await setRange(trackEditor, 'Harmony voice 1 interval in semitones', 12);
  await setRange(trackEditor, 'Harmony voice 2 interval in semitones', -12);
  await setRange(trackEditor, 'Harmony pan percent', 45);
  await setRange(trackEditor, 'Harmony mix percent', 50);

  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ type?: string; manualHarmonistParameters?: { voice1Interval?: number; voice2Interval?: number; panPercent?: number; mixPercent?: number } }>;
      trackSlots?: Array<{ type?: string; manualHarmonistParameters?: { voice1Interval?: number; voice2Interval?: number; panPercent?: number; mixPercent?: number } }>;
    };
    return saved.inputSlots?.[0]?.type === 'HRM MANUAL'
      && saved.inputSlots[0].manualHarmonistParameters?.voice1Interval === -7
      && saved.inputSlots[0].manualHarmonistParameters?.voice2Interval === 5
      && saved.inputSlots[0].manualHarmonistParameters?.panPercent === -30
      && saved.trackSlots?.[0]?.type === 'HRM MANUAL'
      && saved.trackSlots[0].manualHarmonistParameters?.voice1Interval === 12
      && saved.trackSlots[0].manualHarmonistParameters?.voice2Interval === -12;
  });

  await page.reload();
  const restoredInput = page.locator('[data-panel="input-fx"] [data-hrm-manual-editor]');
  const restoredTrack = page.locator('[data-panel="track-fx"] [data-hrm-manual-editor]');
  await expect(restoredInput).toBeVisible();
  await expect(restoredInput.getByLabel('Harmony voice 1 interval in semitones')).toHaveValue('-7');
  await expect(restoredInput.getByLabel('Harmony voice 2 interval in semitones')).toHaveValue('5');
  await expect(restoredInput.getByLabel('Harmony pan percent')).toHaveValue('-30');
  await expect(restoredInput.getByLabel('Harmony mix percent')).toHaveValue('65');
  await expect(restoredTrack).toBeVisible();
  await expect(restoredTrack.getByLabel('Harmony voice 1 interval in semitones')).toHaveValue('12');
  await expect(restoredTrack.getByLabel('Harmony voice 2 interval in semitones')).toHaveValue('-12');
  await expect(restoredTrack.getByLabel('Harmony pan percent')).toHaveValue('45');
  await expect(restoredTrack.getByLabel('Harmony mix percent')).toHaveValue('50');
});
