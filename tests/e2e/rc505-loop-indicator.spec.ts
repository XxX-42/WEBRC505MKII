import { expect, test, type Page } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

const lcd = (page: Page) => page.getByTestId('rc505-lcd-screen');

async function openSetup(page: Page): Promise<void> {
  await page.locator('[data-panel-control="menu"]').click();
  await page.locator('[data-panel-control="page-next"]').click();
  await page.locator('[data-panel-control="screen-encoder-4"]').press('Enter');
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'editor-setup');
}

test('MENU > SETUP selects Classic loop indicator modes and displays Browser meter data', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  await openSetup(page);
  await expect(lcd(page)).toContainText('APPROX · NOT HARDWARE-VERIFIED');

  const selector = page.getByTestId('lcd-field-loop-indicator-mode');
  await expect(selector).toHaveAttribute('aria-valuetext', 'STATUS');
  await selector.press('ArrowRight');
  await expect(page.locator('.loop-halo-container').first()).toHaveAttribute('data-indicator-mode', 'LOOP_POSITION');
  await expect(page.locator('.loop-halo-container').first()).toHaveAttribute('data-visual-mapping', 'engineering-approximation');
  await selector.press('ArrowRight');
  const rings = page.locator('.track-strip .loop-halo-container');
  await expect(rings).toHaveCount(5);
  for (let index = 0; index < 5; index += 1) {
    await expect(rings.nth(index)).toHaveAttribute('data-indicator-mode', 'LEVEL');
    await expect(rings.nth(index)).toHaveAttribute('data-visual-mapping', 'engineering-approximation');
    await expect(rings.nth(index)).toHaveAttribute('data-availability', 'available');
  }

  await page.keyboard.press('Escape');
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'menu-root');
});

test('LEVEL stays unavailable until the Browser runtime publishes its meter', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await openSetup(page);
  const selector = page.getByTestId('lcd-field-loop-indicator-mode');
  await selector.press('ArrowRight');
  await selector.press('ArrowRight');
  const rings = page.locator('.track-strip .loop-halo-container');
  await expect(rings).toHaveCount(5);
  for (let index = 0; index < 5; index += 1) {
    await expect(rings.nth(index)).toHaveAttribute('data-indicator-mode', 'LEVEL');
    await expect(rings.nth(index)).toHaveAttribute('data-availability', 'unavailable');
  }
});
