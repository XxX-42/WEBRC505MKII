import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

const initScriptPath = path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js');

async function openInputNamedControls(panel: Locator): Promise<Locator> {
  const controls = panel.locator('[data-input-named-controls]');
  await expect(controls).toBeVisible();
  if (!(await controls.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await controls.locator('summary').click();
  }
  return controls;
}

test('routes Browser Input named controls to the selected worklet and restores them per slot and effect', async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const panel = page.locator('.top-panel [data-panel="input-fx"]');
  const selector = panel.locator('select.fx-select').first();
  await expect(selector.locator('option[value="RING.MOD"]')).toHaveCount(1);
  await expect(selector.locator('option[value="BEAT SHIFT"]')).toHaveCount(0);
  await expect(selector.locator('option[value="VINYL FLICK (EXPERIMENTAL)"]')).toHaveCount(0);

  await selector.selectOption('RING.MOD');
  const controls = await openInputNamedControls(panel);
  await controls.getByLabel('Input FX slot A ringModWaveform').selectOption('1');
  await page.waitForFunction(() => {
    const records = (window as unknown as {
      __rc505AudioWorkletMessages?: Array<{
        algorithm?: string;
        message?: { type?: string; parameters?: Record<string, number> };
      }>;
    }).__rc505AudioWorkletMessages ?? [];
    return records.some(({ algorithm, message }) => algorithm === 'ring-mod'
      && message?.type === 'configure' && message.parameters?.ringModWaveform === 1);
  });

  const savedRingMod = await page.evaluate(() => JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
    inputSlots?: Array<{ namedParametersByType?: Record<string, Record<string, number>> }>;
  });
  expect(savedRingMod.inputSlots?.[0]?.namedParametersByType?.['RING.MOD']).toEqual({ ringModWaveform: 1 });

  // A second slot can keep its own values for the same effect.
  const secondSlot = panel.locator('.fx-slot-shell').nth(1);
  await secondSlot.getByRole('button', { name: 'B', exact: true }).click();
  await expect(secondSlot).toHaveClass(/active/);
  await secondSlot.locator('select.fx-select').selectOption('RING.MOD');
  const secondSlotControls = await openInputNamedControls(panel);
  await secondSlotControls.getByLabel('Input FX slot B ringModWaveform').selectOption('0');
  await panel.locator('.fx-slot-shell').nth(0).getByRole('button', { name: 'A', exact: true }).click();
  await openInputNamedControls(panel);
  await expect(panel.getByLabel('Input FX slot A ringModWaveform')).toHaveValue('1');
  await expect(panel.getByLabel('Input FX slot B ringModWaveform')).toHaveCount(0);

  await selector.selectOption('DSP LPF');
  await openInputNamedControls(panel);
  await expect(panel.getByLabel('Input FX slot A cutoffHz')).toBeVisible();
  await expect(panel.getByLabel('Input FX slot A ringModWaveform')).toHaveCount(0);
  await panel.getByLabel('Input FX slot A cutoffHz').fill('820');
  await panel.getByLabel('Input FX slot A cutoffHz').dispatchEvent('change');
  await page.waitForFunction(() => {
    const records = (window as unknown as {
      __rc505AudioWorkletMessages?: Array<{
        algorithm?: string;
        message?: { type?: string; parameters?: Record<string, number> };
      }>;
    }).__rc505AudioWorkletMessages ?? [];
    return records.some(({ algorithm, message }) => algorithm === 'lpf'
      && message?.type === 'configure' && message.parameters?.cutoffHz === 820);
  });

  // The amount macro owns cutoffHz and therefore clears an explicit override;
  // non-macro named keys and other effects' settings remain per-type.
  await panel.locator('.fx-slot-shell').first().locator('input[type="range"]').evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '64';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
      inputSlots?: Array<{ namedParametersByType?: Record<string, Record<string, number>> }>;
    };
    return saved.inputSlots?.[0]?.namedParametersByType?.['DSP LPF']?.cutoffHz;
  })).toBeUndefined();
  await panel.getByLabel('Input FX slot A cutoffHz').fill('820');
  await panel.getByLabel('Input FX slot A cutoffHz').dispatchEvent('change');

  await selector.selectOption('RING.MOD');
  await expect(panel.getByLabel('Input FX slot A ringModWaveform')).toHaveValue('1');
  await selector.selectOption('DSP LPF');
  await expect(panel.getByLabel('Input FX slot A cutoffHz')).toHaveValue('820');

  await page.reload();
  await startBrowserAudio(page);
  const restoredPanel = page.locator('.top-panel [data-panel="input-fx"]');
  await openInputNamedControls(restoredPanel);
  await expect(restoredPanel.locator('select.fx-select').first()).toHaveValue('DSP LPF');
  await expect(restoredPanel.getByLabel('Input FX slot A cutoffHz')).toHaveValue('820');
  const restoredStorage = await page.evaluate(() => JSON.parse(localStorage.getItem('webrc505_top_panel') ?? '{}') as {
    inputSlots?: Array<{ namedParametersByType?: Record<string, Record<string, number>> }>;
  });
  expect(restoredStorage.inputSlots?.[0]?.namedParametersByType).toMatchObject({
    'RING.MOD': { ringModWaveform: 1 },
    'DSP LPF': { cutoffHz: 820 },
  });
  expect(restoredStorage.inputSlots?.[1]?.namedParametersByType?.['RING.MOD']).toEqual({ ringModWaveform: 0 });
});
