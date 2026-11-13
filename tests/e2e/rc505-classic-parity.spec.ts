import { expect, test, type Page } from '@playwright/test';
import { startBrowserAudio, openAppSettingsMenu } from './uiHelpers';

const screens = ['memory-number', 'track-status', 'loop-tracks', 'loop-status', 'loop-level', 'input-fx', 'track-fx'];
const lcd = (page: Page) => page.getByTestId('rc505-lcd-screen');
const button = (page: Page, name: string) => page.locator(`[data-panel-control="${name}"]`);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?audio=browser&ui=classic');
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'memory-number');
});

test('seven Play screens wrap in both directions and retain the returning page', async ({ page }) => {
  for (const screen of screens) {
    await expect(lcd(page)).toHaveAttribute('data-classic-screen', screen);
    await button(page, 'page-next').click();
  }
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', screens[0]!);
  for (const screen of [...screens].reverse()) {
    await button(page, 'page-prev').click();
    await expect(lcd(page)).toHaveAttribute('data-classic-screen', screen);
  }
  await button(page, 'page-next').click();
  await button(page, 'enter').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'mixer-inputs');
  await button(page, 'enter').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'mixer-inputs');
  await button(page, 'page-next').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'mixer-tracks');
  await button(page, 'page-next').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'mixer-outputs');
  await button(page, 'page-next').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'mixer-master');
  await button(page, 'exit').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'track-status');
});

test('LOOP and MENU expose hardware roots; encoder push and EXIT retain context', async ({ page }) => {
  await button(page, 'loop').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'loop-root');
  await expect(lcd(page)).toContainText('TRACK');
  await expect(lcd(page)).toContainText('REC');
  await button(page, 'screen-encoder-1').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'editor-track');
  await expect(lcd(page)).toContainText('TRACK LEVEL');
  await button(page, 'exit').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'loop-root');
  await button(page, 'exit').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'memory-number');
  await button(page, 'menu').click();
  await expect(lcd(page)).toContainText('INPUT');
  await expect(lcd(page)).toContainText('OUTPUT');
  await expect(button(page, 'screen-encoder-1')).toHaveAttribute('aria-disabled', 'true');
  await button(page, 'screen-encoder-3').press('Enter');
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'mixer-inputs');
  await button(page, 'exit').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'menu-root');
});

test('Classic editor LCD fits all field cards and status row without clipping', async ({ page }) => {
  for (const width of [1920, 1366]) {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 768 });
    await button(page, 'loop').click();
    await button(page, 'screen-encoder-1').click();
    const screen = lcd(page);
    await expect(screen).toHaveAttribute('data-classic-screen', 'editor-track');
    const layout = await screen.evaluate((element) => {
      const rows = getComputedStyle(element).gridTemplateRows.split(' ').length;
      const status = element.querySelector('.lcd-status')!.getBoundingClientRect();
      const grid = element.querySelector('.lcd-field-grid')!;
      const gridRect = grid.getBoundingClientRect();
      const cards = Array.from(grid.querySelectorAll<HTMLElement>('.lcd-field-card'));
      const cardLayouts = cards.map((card) => {
        const rect = card.getBoundingClientRect();
        const children = Array.from(card.querySelectorAll<HTMLElement>('.lcd-field-label, input, output, button'));
        return { empty: card.classList.contains('is-empty'), height: rect.height, childCount: children.length, childrenInside: children.every((child) => {
          const childRect = child.getBoundingClientRect();
          return childRect.height > 0 && childRect.top >= rect.top - 1 && childRect.bottom <= rect.bottom + 1;
        }) };
      });
      return { rows, statusTop: status.top, statusBottom: status.bottom, gridBottom: gridRect.bottom, cardLayouts };
    });
    expect(layout.rows, `${width}px grid rows`).toBe(3);
    expect(layout.gridBottom, `${width}px grid/footer spacing`).toBeLessThanOrEqual(layout.statusTop + 1);
    expect(layout.statusBottom).toBeGreaterThan(layout.statusTop);
    expect(layout.cardLayouts).toHaveLength(4);
    for (const card of layout.cardLayouts) {
      expect(card.height, `${width}px card height`).toBeGreaterThan(0);
      if (!card.empty) {
        expect(card.childCount, `${width}px card content`).toBeGreaterThan(0);
        expect(card.childrenInside, `${width}px card content visibility`).toBe(true);
      }
    }
    await button(page, 'exit').click();
  }
});

test('narrow viewport warning keeps its own flex space', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 480 });
  const warning = page.locator('.viewport-warning');
  await expect(warning).toBeVisible();
  expect(await warning.evaluate((el) => getComputedStyle(el).flex)).toBe('0 0 auto');
  expect(await warning.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(100);
  expect(await page.locator('.viewport-toolbar').evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(180);
});

test('STOP pointer activation sends one stop and detail-zero activation remains accessible', async ({ page }) => {
  await startBrowserAudio(page);
  const strip = page.locator('.track-strip[data-track-id="1"]');
  const rec = strip.locator('[data-panel-control="record-play"]');
  const stop = strip.locator('.stop-disc');
  await rec.click();
  await expect(strip.locator('.track-state')).toHaveText('RECORD');
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const track = AudioEngine.getInstance().tracks[0] as any;
    const original = track.triggerStop.bind(track);
    (window as any).__stopCalls = 0;
    track.triggerStop = (...args: unknown[]) => { (window as any).__stopCalls++; return original(...args); };
  });
  await stop.click();
  await expect(strip.locator('.track-state')).toHaveText('STOP');
  expect(await page.evaluate(() => (window as any).__stopCalls)).toBe(1);
  await rec.click();
  await expect(strip.locator('.track-state')).toHaveText('PLAY');
  await stop.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
  await expect(strip.locator('.track-state')).toHaveText('STOP');
  expect(await page.evaluate(() => (window as any).__stopCalls)).toBe(2);
});

test('Classic LCD excludes software tools while Enhanced keeps the tools reachable', async ({ page }) => {
  const forbidden = /HQ WAV|NATIVE RENDERER|TECH COMPATIBILITY|MEMORY MIB|BROWSER BACKEND|PERFORMANCE|DIAGNOSTIC/;
  for (const target of ['menu', 'loop']) {
    await button(page, target).click();
    for (let index = 0; index < 3; index++) {
      await expect(lcd(page)).not.toContainText(forbidden);
      await button(page, 'page-next').click();
    }
    await button(page, 'exit').click();
  }
  const previous = await lcd(page).getAttribute('data-classic-screen');
  await openAppSettingsMenu(page);
  await page.getByRole('button', { name: 'MONITOR / DIAGNOSTICS', exact: true }).click();
  await page.getByRole('button', { name: 'ENHANCED', exact: true }).click();
  const enhanced = page.getByTestId('enhanced-tools');
  await expect(enhanced).toBeVisible();
  await enhanced.getByRole('button', { name: 'PITCH / HQ WAV', exact: true }).click();
  await enhanced.getByRole('button', { name: 'NEXT', exact: true }).click();
  await expect(enhanced).toContainText('WAV PITCH');
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', previous!);
  await expect(lcd(page)).not.toContainText(forbidden);
  await enhanced.getByRole('button', { name: 'CLOSE', exact: true }).click();
});

test('FX ordinary, EDIT chord, hold and Bank layers preserve actual switch state', async ({ page }, info) => {
  await startBrowserAudio(page);
  const a = page.getByTestId('input-fx-slot-a');
  const b = page.getByTestId('input-fx-slot-b');
  const edit = page.getByTestId('input-fx-edit-button');
  await a.click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'memory-number');
  await expect(a).toHaveAttribute('data-led-color', 'pink');
  await expect(a).toHaveAttribute('data-led-on', 'true');
  await b.click();
  await expect(a).toHaveAttribute('data-led-color', 'red');
  await expect(b).toHaveAttribute('data-led-color', 'pink');
  await page.screenshot({ path: info.outputPath('fx-red-pink.png'), fullPage: true });
  await edit.click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'editor-input-fx');
  await expect(b).toHaveAttribute('aria-pressed', 'true');
  await button(page, 'page-next').click();
  const editorCounter = await lcd(page).locator('.lcd-row.top').innerText();
  await button(page, 'menu').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'menu-root');
  await button(page, 'exit').click();
  await expect(lcd(page).locator('.lcd-row.top')).toHaveText(editorCounter);
  await button(page, 'exit').click();
  await edit.focus();
  await page.keyboard.down('Space');
  await page.keyboard.press('c');
  await page.keyboard.up('Space');
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'editor-input-fx');
  await expect(page.getByTestId('input-fx-slot-c')).toHaveAttribute('aria-pressed', 'false');
  await button(page, 'exit').click();
  await edit.focus();
  await page.keyboard.down('Space');
  await page.waitForTimeout(1600);
  await page.keyboard.up('Space');
  await expect(edit).toHaveAttribute('data-fx-layer', 'BANK_SELECT');
  await b.click();
  await expect(b).toHaveAttribute('data-led-color', 'blue', { timeout: 8000 });
  await expect(b).toHaveAttribute('data-led-on', 'true');
  await expect(b).toHaveAttribute('aria-pressed', 'true');
  await expect(b).toHaveAttribute('aria-label', 'INPUT FX Bank B');
  await expect(a).toHaveAttribute('aria-pressed', 'false');
  await expect(b).toHaveAttribute('data-fx-selected', 'true');
  await expect(a).toHaveAttribute('data-fx-selected', 'false');
  await page.screenshot({ path: info.outputPath('fx-bank-blue.png'), fullPage: true });
  await edit.click();
  await expect(edit).toHaveAttribute('data-fx-layer', 'NORMAL');
  await expect(b).toHaveAttribute('data-led-on', 'false');
});

test('virtual input records, plays, overdubs, stops and uses the Undo secondary layer', async ({ page }, info) => {
  test.setTimeout(60_000);
  await startBrowserAudio(page);
  const strip = page.locator('.track-strip[data-track-id="1"]');
  const rec = strip.locator('[data-panel-control="record-play"]');
  const track = strip.locator('[data-track-control="select"]');
  const stop = strip.locator('.stop-disc');
  await track.click();
  await expect(track).toHaveAttribute('data-selected', 'true');
  await expect(track).toHaveAttribute('data-led-on', 'false');
  await button(page, 'exit').click();
  await rec.click();
  await expect(rec).toHaveAttribute('data-led-color', 'red');
  await page.screenshot({ path: info.outputPath('record-red.png'), fullPage: true });
  await page.waitForTimeout(600);
  await stop.click();
  await expect(strip.locator('.track-state')).toHaveText('STOP', { timeout: 15_000 });
  await expect(track).toHaveAttribute('data-led-on', 'true');
  await rec.click();
  await expect(rec).toHaveAttribute('data-led-color', 'green');
  await page.screenshot({ path: info.outputPath('play-green.png'), fullPage: true });
  await rec.click();
  await expect(rec).toHaveAttribute('data-led-color', 'yellow', { timeout: 10_000 });
  await page.screenshot({ path: info.outputPath('overdub-yellow.png'), fullPage: true });
  await page.waitForTimeout(200);
  await stop.click();
  await expect(strip.locator('.track-state')).toHaveText('STOP', { timeout: 15_000 });
  await button(page, 'undo-redo').click();
  await expect(stop).toBeDisabled();
  await expect(stop).toHaveAttribute('data-hardware-role', 'MARK_BACK');
  await expect(track).toHaveAttribute('data-hardware-role', 'MARK_SET');
  await expect(rec).toHaveAttribute('data-hardware-role', 'UNDO');
  await expect(rec).toBeEnabled();
  await rec.click();
  await expect(rec).toHaveAttribute('data-hardware-role', 'REDO');
  await expect(rec).toHaveAttribute('data-led-color', 'red');
  await page.screenshot({ path: info.outputPath('undo-layer-redo.png'), fullPage: true });
  await rec.click();
  await expect(rec).toHaveAttribute('data-hardware-role', 'UNDO');
  await button(page, 'undo-redo').click();
  await expect(stop).toBeEnabled();
  await stop.focus();
  await page.keyboard.down('Space');
  await page.waitForTimeout(2100);
  await page.keyboard.up('Space');
  await expect(strip.locator('.track-state')).toHaveText('EMPTY');
  await expect(track).toHaveAttribute('data-led-on', 'false');
});

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
  test(`fixed Classic layout and LCD at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'FIT', exact: true }).click();
    expect(Number(await page.getByRole('slider', { name: 'Faceplate zoom', exact: true }).inputValue())).toBeGreaterThanOrEqual(0.8);
    await page.screenshot({ path: info.outputPath(`classic-${viewport.width}.png`), fullPage: true });
    await lcd(page).screenshot({ path: info.outputPath(`lcd-${viewport.width}.png`) });
    await page.locator('.classic-viewport').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(page.locator('.track-strip[data-track-id="5"] [data-panel-control="record-play"]')).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`classic-scrolled-${viewport.width}.png`), fullPage: true });
    await button(page, 'page-next').click();
    await page.setViewportSize({ width: 700, height: 500 });
    await expect(page.locator('.viewport-warning')).toBeVisible();
    await page.setViewportSize(viewport);
    await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'track-status');
  });
}
