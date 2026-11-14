import { expect, test, type Page } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

const lcd = (page: Page) => page.getByTestId('rc505-lcd-screen');
const control = (page: Page, name: string) => page.locator(`[data-panel-control="${name}"]`);

for (const bank of ['input', 'track'] as const) {
  test(`${bank} FX EDIT and slot chord supports two real touch points without toggling the slot`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, hasTouch: true, permissions: ['microphone'] });
    const page = await context.newPage();
    try {
      await page.goto('http://127.0.0.1:4174/?audio=browser&ui=classic');
      await startBrowserAudio(page);
      const edit = page.getByTestId(`${bank}-fx-edit-button`);
      const slot = page.getByTestId(`${bank}-fx-slot-b`);
      const initial = await slot.getAttribute('data-fx-enabled');
      const editRect = await edit.boundingBox(); const slotRect = await slot.boundingBox();
      expect(editRect).not.toBeNull(); expect(slotRect).not.toBeNull();
      const point = (box: NonNullable<typeof editRect>, id: number) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2, id });
      const p1 = point(editRect!, 1); const p2 = point(slotRect!, 2);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p1] });
      await expect(edit).toHaveAttribute('data-pressed', 'true');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p1, p2] });
      await expect(lcd(page)).toHaveAttribute('data-classic-screen', `editor-${bank}-fx`);
      await expect(slot).toHaveAttribute('data-fx-selected', 'true');
      await expect(slot).toHaveAttribute('data-fx-enabled', initial!);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [p1] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(edit).toHaveAttribute('data-pressed', 'false');
      await expect(slot).toHaveAttribute('data-pressed', 'false');
      await expect(slot).toHaveAttribute('data-fx-enabled', initial!);
      await control(page, 'exit').click();
      const returnedScreen = await lcd(page).getAttribute('data-classic-screen');
      const layerBeforeCancel = await edit.getAttribute('data-fx-layer');
      // Cancel a separate two-finger gesture before the second finger is placed;
      // EDIT must not remain held and affect the next independent click.
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p1] });
      await expect(edit).toHaveAttribute('data-pressed', 'true');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await expect(edit).toHaveAttribute('data-pressed', 'false');
      await expect(edit).toHaveAttribute('data-fx-layer', layerBeforeCancel!);
      await expect(slot).toHaveAttribute('data-fx-enabled', initial!);
      await slot.click();
      await expect(slot).toHaveAttribute('data-fx-enabled', initial === 'true' ? 'false' : 'true');
      await expect(lcd(page)).toHaveAttribute('data-classic-screen', returnedScreen!);
    } finally { await context.close(); }
  });
}

test('all seven PLAY pages keep the same four physical encoder roles and five-track displays', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  const pages = ['memory-number', 'track-status', 'loop-tracks', 'loop-status', 'loop-level', 'input-fx', 'track-fx'];
  for (const id of pages) {
    await expect(lcd(page)).toHaveAttribute('data-classic-screen', id);
    await expect(control(page, 'screen-encoder-1')).toHaveAttribute('aria-label', 'MEMORY screen control');
    for (const i of [2, 3, 4]) await expect(control(page, `screen-encoder-${i}`)).toHaveAttribute('aria-disabled', 'true');
    await expect(control(page, 'screen-encoder-4')).toHaveAttribute('aria-label', 'MFX REVERB screen control');
    await expect(control(page, 'screen-encoder-4')).toHaveAttribute('aria-description', /not available/i);
    if (['track-status', 'loop-tracks', 'loop-status', 'loop-level'].includes(id)) {
      if (id === 'loop-status') await expect(lcd(page).locator('.play-loop-status')).toContainText('TRK');
      else await expect(lcd(page).locator(id === 'loop-level' ? '.play-meter' : '.play-track')).toHaveCount(5);
    }
    await control(page, 'page-next').click();
  }
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'memory-number');
});


test('TAP tempo returns to play and navigation leaves tempo context', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await control(page, 'tap-tempo').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'tempo');
  await expect(control(page, 'screen-encoder-4')).toHaveAttribute('aria-label', 'TEMPO screen control');
  await control(page, 'exit').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'memory-number');
  await control(page, 'tap-tempo').click();
  await control(page, 'menu').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'menu-root');
  await control(page, 'tap-tempo').click();
  await control(page, 'loop').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'loop-root');
});
