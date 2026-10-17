import path from 'node:path';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js') });
});

test('Native rhythm controls read host settings, send every shared setting, and survive a shell switch', async ({ page }) => {
  await page.goto('/?audio=native&ui=tech&rhythmUiE2e=1');
  const pattern = page.getByTestId('rhythm-pattern-select');
  await expect(pattern).toBeEnabled();
  await expect(pattern).toHaveValue('198');
  await expect(pattern.locator('option')).toHaveCount(240);
  await expect(page.getByRole('slider', { name: 'Rhythm volume', exact: true })).toHaveValue('73');
  expect(await page.evaluate(() => (window as unknown as { __rc505NativeRhythmRequests: unknown[] }).__rc505NativeRhythmRequests.length)).toBe(0);
  await page.locator('summary[aria-label="More rhythm settings"]').click();
  await expect(page.getByTestId('rhythm-kit-select')).toHaveValue('13');
  await expect(page.getByTestId('rhythm-variation-select')).toHaveValue('C');
  await expect(page.getByTestId('rhythm-section-select')).toHaveValue('intro');
  await expect(page.getByTestId('rhythm-swing')).toHaveValue('67');
  await expect(page.getByTestId('rhythm-quantize-select')).toHaveValue('1/8');
  await pattern.selectOption('240');
  await page.getByTestId('rhythm-kit-select').selectOption('16');
  await page.getByTestId('rhythm-variation-select').selectOption('D');
  await page.getByTestId('rhythm-section-select').selectOption('fill');
  await page.getByTestId('rhythm-quantize-select').selectOption('1/4');
  await page.getByTestId('rhythm-swing').evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '75';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.getByRole('slider', { name: 'Rhythm volume', exact: true }).evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '84';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Increase BPM', exact: true }).click();
  await page.getByRole('button', { name: 'Start rhythm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop rhythm', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => {
    const requests = (window as unknown as { __rc505NativeRhythmRequests: unknown[] }).__rc505NativeRhythmRequests;
    return requests.at(-1);
  })).toEqual({ enabled: true, bpm: 94, kitIndex: 16, patternIndex: 240, variation: 'D', section: 'fill', swingPercent: 75, quantizeGrid: '1/4', volume: 84 });
  await page.getByTestId('ui-style-toggle').click();
  await expect(page.getByTestId('center-rhythm-pattern-select')).toHaveValue('240');
  await expect(page.getByRole('slider', { name: 'Rhythm volume', exact: true })).toHaveValue('84');
  await expect(page.getByRole('button', { name: 'Toggle rhythm', exact: true })).toHaveClass(/\bactive\b/);
  await page.getByRole('button', { name: 'Toggle rhythm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Toggle rhythm', exact: true })).not.toHaveClass(/\bactive\b/);
});

test('Native rhythm follows current availability and fails closed for incomplete old bridge status', async ({ page }) => {
  await page.goto('/?audio=native&ui=tech&rhythmUiE2e=1');
  const pattern = page.getByTestId('rhythm-pattern-select');
  await expect(pattern).toBeEnabled();
  await page.evaluate(() => {
    const state = (window as unknown as { __rc505NativeRhythmState: Record<string, unknown> }).__rc505NativeRhythmState;
    delete state.swingPercent;
  });
  await expect(pattern).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start rhythm', exact: true })).toBeDisabled();
  await expect(page.getByTestId('rhythm-status')).toContainText('does not report the supported rhythm settings');
  await page.evaluate(() => {
    const state = (window as unknown as { __rc505NativeRhythmState: Record<string, unknown> }).__rc505NativeRhythmState;
    Object.assign(state, { swingPercent: 67, available: false, statusNote: 'Native rhythm DSP unavailable in this host' });
  });
  await expect(page.getByTestId('rhythm-status')).toHaveText('Native rhythm DSP unavailable in this host');
  await page.evaluate(() => {
    (window as unknown as { __rc505NativeRhythmState: Record<string, unknown> }).__rc505NativeRhythmState.available = true;
  });
  await expect(pattern).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start rhythm', exact: true })).toBeEnabled();
});

test('Native rhythm exposes request failures and only lights playback after a successful retry', async ({ page }) => {
  await page.goto('/?audio=native&ui=tech&rhythmUiE2e=1');
  const start = page.getByRole('button', { name: 'Start rhythm', exact: true });
  await expect(start).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { __rc505RejectNativeRhythmConfig: boolean }).__rc505RejectNativeRhythmConfig = true; });
  await start.click();
  await expect(page.getByTestId('rhythm-status')).toHaveText('Native rhythm configuration rejected by test bridge');
  await expect(start).toBeEnabled();
  await expect(start).not.toHaveClass(/\bactive\b/);
  await page.evaluate(() => { (window as unknown as { __rc505RejectNativeRhythmConfig: boolean }).__rc505RejectNativeRhythmConfig = false; });
  await start.click();
  await expect(page.getByRole('button', { name: 'Stop rhythm', exact: true })).toBeEnabled();
  await expect(page.getByTestId('rhythm-status')).toHaveCount(0);
});
