import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  activateLcdAction,
  findLcdField,
  lcdField,
  lcdScreen,
  openLcdPage,
  selectLcdEnum,
  setLcdRange,
} from './uiHelpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js') });
});

test('Native rhythm reads host settings, sends every LCD setting, and survives a shell switch', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?audio=native&ui=tech&rhythmUiE2e=1');
  const screen = await openLcdPage(page, 'rhythm-edit-button');
  const pattern = lcdField(page, 'pattern');
  const volume = lcdField(page, 'volume');
  const kit = lcdField(page, 'kit');

  await expect(pattern).toBeEnabled();
  await expect(pattern).toHaveValue('197');
  await expect(pattern).toHaveAttribute('aria-valuetext', /198 ·/);
  await expect(JSON.parse((await pattern.getAttribute('data-option-labels')) ?? '[]')).toHaveLength(240);
  await expect(volume).toHaveValue('73');
  await expect(kit).toHaveValue('12');
  await expect(kit).toHaveAttribute('aria-valuetext', /13 ·/);
  const variation = await findLcdField(page, 'variation');
  await expect(lcdScreen(page).locator('.lcd-row.top')).toContainText('2/3');
  await expect(variation.getByTestId('lcd-field-variation')).toHaveValue('2');
  await expect(variation.locator('.lcd-enum-value')).toHaveText('C');
  await expect(lcdField(page, 'section')).toHaveValue('1');
  await expect((await findLcdField(page, 'section')).locator('.lcd-enum-value')).toHaveText('INTRO');
  await expect(lcdField(page, 'swing')).toHaveValue('67');
  await expect(lcdField(page, 'quantize')).toHaveValue('1');
  await expect((await findLcdField(page, 'quantize')).locator('.lcd-enum-value')).toHaveText('1/8');
  expect(await page.evaluate(() => (window as unknown as { __rc505NativeRhythmRequests: unknown[] }).__rc505NativeRhythmRequests.length)).toBe(0);

  await page.getByRole('button', { name: 'Previous display page', exact: true }).click();
  await expect(lcdScreen(page).locator('.lcd-row.top')).toContainText('1/3');
  await selectLcdEnum(page, 'pattern', '240');
  await selectLcdEnum(page, 'kit', '16');
  await setLcdRange(page, 'volume', 84);
  await setLcdRange(page, 'bpm', 94);
  await page.getByRole('button', { name: 'Next display page', exact: true }).click();
  await expect(lcdScreen(page).locator('.lcd-row.top')).toContainText('2/3');
  await selectLcdEnum(page, 'variation', 'D');
  await selectLcdEnum(page, 'section', 'FILL');
  await setLcdRange(page, 'swing', 75);
  await selectLcdEnum(page, 'quantize', '1/4');
  const playStop = await findLcdField(page, 'play-stop');
  await expect(lcdScreen(page).locator('.lcd-row.top')).toContainText('3/3');
  await expect(playStop).toContainText('START RHYTHM');

  await activateLcdAction(page, 'play-stop');
  await expect.poll(() => page.evaluate(() => {
    const requests = (window as unknown as { __rc505NativeRhythmRequests: unknown[] }).__rc505NativeRhythmRequests;
    return requests.at(-1);
  })).toEqual({ enabled: true, bpm: 94, kitIndex: 16, patternIndex: 240, variation: 'D', section: 'fill', swingPercent: 75, quantizeGrid: '1/4', volume: 84 });
  await expect(playStop).toContainText('STOP RHYTHM');
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);

  await activateLcdAction(page, 'play-stop');
  await expect.poll(() => page.evaluate(() => {
    const requests = (window as unknown as { __rc505NativeRhythmRequests: unknown[] }).__rc505NativeRhythmRequests;
    return requests.at(-1);
  })).toMatchObject({ enabled: false });
  await expect(playStop).toContainText('START RHYTHM');
});

test('Native rhythm LCD fields fail closed for incomplete or unavailable bridge status', async ({ page }) => {
  await page.goto('/?audio=native&ui=classic&rhythmUiE2e=1');
  const screen = await openLcdPage(page, 'rhythm-edit-button');
  const pattern = lcdField(page, 'pattern');
  await expect(pattern).toBeEnabled();

  await page.evaluate(() => {
    const state = (window as unknown as { __rc505NativeRhythmState: Record<string, unknown> }).__rc505NativeRhythmState;
    delete state.swingPercent;
  });
  await expect(pattern).toBeDisabled();
  await expect(screen.locator('.lcd-status')).toContainText('does not report the supported rhythm settings');
  const playStop = await findLcdField(page, 'play-stop');
  await expect(playStop.getByTestId('lcd-field-play-stop')).toBeDisabled();

  await page.evaluate(() => {
    const state = (window as unknown as { __rc505NativeRhythmState: Record<string, unknown> }).__rc505NativeRhythmState;
    Object.assign(state, { swingPercent: 67, available: false, statusNote: 'Native rhythm DSP unavailable in this host' });
  });
  await expect(screen.locator('.lcd-status')).toHaveText('Native rhythm DSP unavailable in this host');
  await page.evaluate(() => {
    (window as unknown as { __rc505NativeRhythmState: Record<string, unknown> }).__rc505NativeRhythmState.available = true;
  });
  await page.getByRole('button', { name: 'Previous display page', exact: true }).click();
  await page.getByRole('button', { name: 'Previous display page', exact: true }).click();
  await expect(pattern).toBeEnabled();
  const readyAction = await findLcdField(page, 'play-stop');
  await expect(readyAction.getByTestId('lcd-field-play-stop')).toBeEnabled();
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
});

test('Native rhythm LCD action shows request failures and lights playback only after a successful retry', async ({ page }) => {
  await page.goto('/?audio=native&ui=classic&rhythmUiE2e=1');
  const screen = await openLcdPage(page, 'rhythm-edit-button');
  await page.evaluate(() => { (window as unknown as { __rc505RejectNativeRhythmConfig: boolean }).__rc505RejectNativeRhythmConfig = true; });

  const playStop = await activateLcdAction(page, 'play-stop');
  await expect(screen.locator('.lcd-status')).toHaveText('Native rhythm configuration rejected by test bridge');
  await expect(playStop).toBeEnabled();
  await expect(playStop).toContainText('START RHYTHM');

  await page.evaluate(() => { (window as unknown as { __rc505RejectNativeRhythmConfig: boolean }).__rc505RejectNativeRhythmConfig = false; });
  await activateLcdAction(page, 'play-stop');
  await expect.poll(() => page.evaluate(() => {
    const requests = (window as unknown as { __rc505NativeRhythmRequests: Array<{ enabled?: boolean }> }).__rc505NativeRhythmRequests;
    return requests.at(-1)?.enabled;
  })).toBe(true);
  await expect(playStop).toContainText('STOP RHYTHM');
  await expect(screen.locator('.lcd-status')).not.toContainText('Native rhythm configuration rejected by test bridge');
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
});
