import path from 'node:path';
import { expect, test } from '@playwright/test';

const initScriptPath = path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
});

test('defaults to classic shell and persists UI style toggling', async ({ page }) => {
  await page.goto('/?audio=browser');

  await expect(page.locator('#app > [data-ui-style="classic"]')).toBeVisible();
  await expect(page.locator('[data-panel="input-fx"]')).toBeVisible();
  await expect(page.locator('[data-panel="center-main"]')).toBeVisible();
  await expect(page.locator('[data-panel="track-fx"]')).toBeVisible();
  await expect(page.locator('[data-panel="track-bay"]')).toBeVisible();

  await page.getByTestId('ui-style-toggle').click();
  await expect(page.locator('#app > [data-ui-style="tech"]')).toBeVisible();

  await page.reload();
  await expect(page.locator('#app > [data-ui-style="tech"]')).toBeVisible();
});

test('keeps original tech-shell interactions available after switching UI style', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');

  await expect(page.locator('.mode-summary')).toHaveText('BROWSER: FULL TRACK CONTROLS');

  const firstTrack = page.locator('.track-unit').first();
  const filterButton = firstTrack.locator('button[aria-label="Toggle track filter"]');
  await expect(filterButton).toBeVisible();
  await filterButton.click();
  await expect(filterButton).toHaveClass(/active/);

  const fader = firstTrack.locator('.right-fader input[type="range"]').first();
  await fader.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '72';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(firstTrack.locator('.fader-value').first()).toContainText('72');
});

test('shows native capability reasons inside the classic shell structure', async ({ page }) => {
  await page.goto('/?audio=native');

  await expect(page.locator('.mode-summary')).toHaveText('NATIVE V1: TRACK 1 ONLY');
  await expect(page.getByText('NO FX IN NATIVE V1').first()).toBeVisible();
  await expect(page.getByText('NO RHYTHM IN NATIVE V1').first()).toBeVisible();

  const secondTrack = page.locator('[data-track-id="2"]').first();
  await expect(secondTrack.getByText('TRACK 2 UNAVAILABLE IN NATIVE V1')).toBeVisible();
});
