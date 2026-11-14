import { expect, test, type Page } from '@playwright/test';
import { openClassicFxEditor, selectLcdEnum, startBrowserAudio } from './uiHelpers';

const screen = (page: Page) => page.getByTestId('rc505-lcd-screen');
const control = (page: Page, key: string) => page.locator(`[data-panel-control="${key}"]`);

test('TAP exposes tempo on encoder four, including decimals, and EXIT restores the Play page', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await control(page, 'page-next').click();
  await control(page, 'tap-tempo').click();
  await expect(page.getByTestId('tempo-screen')).toBeVisible();
  const knob = control(page, 'screen-encoder-4');
  await expect(knob).toHaveAttribute('aria-label', 'TEMPO screen control');
  const before = Number(await knob.getAttribute('aria-valuenow'));
  await knob.focus(); await page.keyboard.press('ArrowUp');
  await expect(knob).toHaveAttribute('aria-valuenow', String(before + 1));
  await page.keyboard.down('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Space');
  await expect(knob).toHaveAttribute('aria-valuenow', String(before + 0.9));
  await control(page, 'exit').click();
  await expect(screen(page)).toHaveAttribute('data-classic-screen', 'track-status');
  await expect(knob).toHaveAttribute('aria-disabled', 'true');
  await control(page, 'tap-tempo').click(); await control(page, 'menu').click();
  await expect(page.getByTestId('tempo-screen')).toHaveCount(0);
  await expect(screen(page).locator('[data-classic-root="menu"]')).toBeVisible();
});

test('NAME encoders edit character, case, cursor, delete and insert without replacing other fields', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await control(page, 'loop').click(); await control(page, 'page-next').click();
  await control(page, 'screen-encoder-4').focus(); await page.keyboard.press('Enter');
  await expect(screen(page)).toHaveAttribute('data-classic-screen', 'editor-name');
  const fields = screen(page).locator('[data-field-key]');
  await expect(fields).toHaveCount(4);
  expect(await fields.evaluateAll(elements => elements.map(e => e.getAttribute('data-field-key')))).toEqual(['memory-name-group', 'memory-name-case', 'memory-name-character', 'memory-name-cursor']);
  const character = control(page, 'screen-encoder-3');
  await character.focus(); await page.keyboard.press('ArrowUp');
  const changed = await character.getAttribute('aria-valuenow');
  await control(page, 'screen-encoder-2').focus(); await page.keyboard.press('ArrowUp');
  await expect(character).toHaveAttribute('aria-valuenow', changed!);
  const cursor = control(page, 'screen-encoder-4');
  await cursor.focus(); await page.keyboard.press('ArrowUp');
  await expect(cursor).toHaveAttribute('aria-valuenow', '2');
  await control(page, 'screen-encoder-2').focus(); await page.keyboard.press('Enter');
  await expect(cursor).toHaveAttribute('aria-valuenow', '2');
  await control(page, 'screen-encoder-1').focus(); await page.keyboard.press('Enter');
  await expect(cursor).toHaveAttribute('aria-valuenow', '2');
  await expect(fields).toHaveCount(4);
});

for (const width of [1920, 1366]) {
  test(`Classic dedicated Play layouts and readable details at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 768 });
    await page.goto('/?audio=browser&ui=classic');
    await expect(screen(page).locator('.play-memory-large')).toBeVisible();
    for (let i = 0; i < 5; i++) {
      const layout = screen(page).locator('.play-overview');
      const measurements = await layout.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll('.play-memory-large,.play-memory-name,.play-track,.play-loop-status,.play-meter')).map(child => {
          const box = child.getBoundingClientRect();
          return { left: box.left - rect.left, right: box.right - rect.right, top: box.top - rect.top, bottom: box.bottom - rect.bottom };
        });
      });
      for (const box of measurements) { expect(box.left).toBeGreaterThanOrEqual(-1); expect(box.right).toBeLessThanOrEqual(1); expect(box.top).toBeGreaterThanOrEqual(-1); expect(box.bottom).toBeLessThanOrEqual(1); }
      await screen(page).screenshot({ path: info.outputPath(`play-${i + 1}-${width}.png`) });
      await control(page, 'page-next').click();
    }
    await startBrowserAudio(page); await openClassicFxEditor(page, 'input');
    await selectLcdEnum(page, 'type', 'PREAMP');
    await screen(page).locator('.lcd-field-details').first().click();
    const details = page.getByTestId('lcd-details-view');
    await expect(details).toBeVisible();
    const contrast = await details.evaluate(element => {
      const rgb = getComputedStyle(element).color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const lum = (c: number[]) => c.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((s, n, i) => s + n * [0.2126, 0.7152, 0.0722][i]!, 0);
      return (lum(rgb) + .05) / (lum([52, 50, 130]) + .05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await screen(page).screenshot({ path: info.outputPath(`details-${width}.png`) });
  });
}
