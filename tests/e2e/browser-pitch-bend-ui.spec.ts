import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';

const initScriptPath = path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
});

test('exposes and persists PITCH BEND controls in the Browser Input FX panel', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');

  const panel = page.locator('.top-panel [data-panel="input-fx"]');
  const selector = panel.locator('select.fx-select').first();
  await expect(selector.locator('option[value="PITCH BEND"]')).toHaveCount(1);
  await selector.selectOption('PITCH BEND');

  const editor = panel.locator('[data-pitch-bend-editor]');
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Pitch bend range in semitones')).toHaveValue('12');
  await expect(editor.getByLabel('Pitch bend direction')).toHaveValue('0');
  await expect(editor.getByLabel('Pitch bend mix percent')).toHaveValue('100');

  const setRange = async (targetEditor: Locator, label: string, value: number) => {
    await targetEditor.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };
  await setRange(editor, 'Pitch bend range in semitones', 18);
  await setRange(editor, 'Pitch bend time in milliseconds', 75);
  await editor.getByLabel('Pitch bend direction').selectOption('1');
  await setRange(editor, 'Pitch bend mix percent', 73);

  await expect(editor.getByLabel('Pitch bend range in semitones')).toHaveValue('18');
  await expect(editor.getByLabel('Pitch bend direction')).toHaveValue('1');
  await expect(editor.getByLabel('Pitch bend mix percent')).toHaveValue('73');
  await expect(editor.locator('.bend-control').nth(1)).toContainText('TIME 1064 MS');

  const trackPanel = page.locator('.top-panel [data-panel="track-fx"]');
  const trackSelector = trackPanel.locator('select.fx-select').first();
  await expect(trackSelector.locator('option[value="PITCH BEND"]')).toHaveCount(1);
  await trackSelector.selectOption('PITCH BEND');
  const trackEditor = trackPanel.locator('[data-pitch-bend-editor]');
  await expect(trackEditor).toBeVisible();
  await setRange(trackEditor, 'Pitch bend range in semitones', 6);
  await trackEditor.getByLabel('Pitch bend direction').selectOption('0');
  await setRange(trackEditor, 'Pitch bend mix percent', 45);
  await expect(trackEditor.getByLabel('Pitch bend range in semitones')).toHaveValue('6');
  await expect(trackEditor.getByLabel('Pitch bend mix percent')).toHaveValue('45');

  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ type?: string; pitchBendParameters?: { rangeSemitones?: number } }>;
      trackSlots?: Array<{ type?: string; pitchBendParameters?: { rangeSemitones?: number } }>;
    };
    return saved.inputSlots?.[0]?.type === 'PITCH BEND'
      && saved.inputSlots[0].pitchBendParameters?.rangeSemitones === 18
      && saved.trackSlots?.[0]?.type === 'PITCH BEND'
      && saved.trackSlots[0].pitchBendParameters?.rangeSemitones === 6;
  });

  await page.reload();
  const restored = page.locator('[data-panel="input-fx"] [data-pitch-bend-editor]');
  await expect(restored).toBeVisible();
  await expect(restored.getByLabel('Pitch bend range in semitones')).toHaveValue('18');
  await expect(restored.getByLabel('Pitch bend direction')).toHaveValue('1');
  await expect(restored.getByLabel('Pitch bend mix percent')).toHaveValue('73');
  await expect(restored.locator('.bend-control').nth(1)).toContainText('TIME 1064 MS');
  const restoredTrack = page.locator('[data-panel="track-fx"] [data-pitch-bend-editor]');
  await expect(restoredTrack).toBeVisible();
  await expect(restoredTrack.getByLabel('Pitch bend range in semitones')).toHaveValue('6');
  await expect(restoredTrack.getByLabel('Pitch bend direction')).toHaveValue('0');
  await expect(restoredTrack.getByLabel('Pitch bend mix percent')).toHaveValue('45');
});
