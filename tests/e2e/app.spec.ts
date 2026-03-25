import path from 'node:path';
import { expect, test } from '@playwright/test';

const initScriptPath = path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
});

test('shows browser capability summary and active track controls', async ({ page }) => {
  await page.goto('/?audio=browser');

  await expect(page.locator('.mode-summary')).toHaveText('BROWSER: FULL TRACK CONTROLS');

  const firstTrack = page.locator('.track-unit').first();
  const filterButton = firstTrack.locator('button[aria-label="Toggle track filter"]');
  await expect(filterButton).toBeVisible();
  await filterButton.click();
  await expect(filterButton).toHaveClass(/active/);

  const fader = firstTrack.locator('.right-fader input[type="range"]').first();
  await fader.evaluate((element) => {
    const input = element;
    input.value = '72';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(firstTrack.locator('.fader-value').first()).toContainText('72');
});

test('shows native capability reasons for limited modules', async ({ page }) => {
  await page.goto('/?audio=native');

  await expect(page.locator('.mode-summary')).toHaveText('NATIVE V1: TRACK 1 ONLY');
  await expect(page.getByText('NO FX IN NATIVE V1').first()).toBeVisible();
  await expect(page.getByText('NO RHYTHM IN NATIVE V1')).toBeVisible();
  await expect(page.getByText('NO BEAT IN NATIVE V1')).toBeVisible();

  const secondTrack = page.locator('.track-unit').nth(1);
  await expect(secondTrack.getByText('NATIVE V1 ONLY TRACK 1')).toBeVisible();
  await expect(secondTrack.getByRole('button', { name: 'TRACK 2 UNAVAILABLE IN NATIVE V1' }).first()).toBeVisible();
});

test('flashes the beat indicator when transport emits beat events', async ({ page }) => {
  await page.goto('/?audio=browser');

  await page.evaluate(async () => {
    const module = await import('/src/core/Transport.ts');
    module.Transport.getInstance().start();
  });

  await expect(page.locator('.beat-led.active')).toBeVisible({ timeout: 2000 });

  await page.evaluate(async () => {
    const module = await import('/src/core/Transport.ts');
    module.Transport.getInstance().stop();
  });

  await expect(page.locator('.beat-led')).not.toHaveClass(/active/);
});
