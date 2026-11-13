import { expect, test, type Locator, type Page } from '@playwright/test';
import { RC505_LOOP_ROOT_ITEMS, RC505_MENU_ROOT_ITEMS, RC505_MIXER_PAGES } from '../../src/ui/rc505/rc505DisplayTypes';
import { getRc505RootPage } from '../../src/ui/rc505/Rc505DisplayStateMachine';
import { findLcdField, lcdScreen, openClassicFxEditor, selectLcdEnum, startBrowserAudio } from './uiHelpers';

const encoder = (page: Page, index: number): Locator => page.locator(`[data-panel-control="screen-encoder-${index}"]`);
const nextPage = (page: Page): Locator => page.getByRole('button', { name: 'Next display page', exact: true });
const exit = (page: Page): Locator => page.getByRole('button', { name: 'Exit current page', exact: true });

async function openPreampParameters(page: Page): Promise<Locator> {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  const screen = await openClassicFxEditor(page, 'input');
  await selectLcdEnum(page, 'type', 'PREAMP');
  await findLcdField(page, 'input-gainPercent');
  await expect(screen).toHaveAttribute('data-classic-screen', 'editor-input-fx');
  return screen;
}

async function dialSnapshot(screen: Locator): Promise<Array<{ key: string; value: string; angle: string | null }>> {
  return screen.locator('[data-classic-parameter-dials] [data-field-key]').evaluateAll((cards) => cards.map((card) => ({
    key: card.getAttribute('data-field-key') ?? '',
    value: (card.querySelector('input') as HTMLInputElement | null)?.value ?? '',
    angle: card.querySelector('svg.lcd-parameter-dial')?.getAttribute('data-angle') ?? null,
  })));
}

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
  test(`Classic PREAMP parameter dials form four columns at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const screen = await openPreampParameters(page);
    const grid = screen.locator('[data-classic-parameter-dials]');
    await expect(grid).toBeVisible();
    const cards = grid.locator('.lcd-field-card');
    await expect(cards).toHaveCount(4);
    const inputs = cards.locator('input[type="range"]');
    await expect(inputs).toHaveCount(4);
    const dials = cards.locator('svg.lcd-parameter-dial');
    await expect(dials).toHaveCount(4);
    const boxes = await cards.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
    expect(boxes.every((box) => box.width > 0 && box.height > 0)).toBe(true);
    expect(Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y))).toBeLessThan(3);
    for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x);
    for (const dial of await dials.all()) {
      const value = Number(await dial.getAttribute('data-normalized'));
      const angle = Number(await dial.getAttribute('data-angle'));
      expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1);
      expect(Number.isFinite(angle)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`classic-fx-parameter-dials-${viewport.width}.png`), fullPage: true });
  });
}

test('each physical encoder changes only its corresponding PREAMP parameter and dial, including enum', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const screen = await openPreampParameters(page);
  const cards = screen.locator('[data-classic-parameter-dials] [data-field-key]');
  await expect(cards).toHaveCount(4);
  await expect(cards.first().locator('input[type="range"][data-option-labels]')).toHaveCount(1);
  for (let index = 0; index < 4; index += 1) {
    const before = await dialSnapshot(screen);
    const control = encoder(page, index + 1);
    await expect(control).toHaveAttribute('aria-disabled', 'false');
    const now = Number(await control.getAttribute('aria-valuenow'));
    const max = Number(await control.getAttribute('aria-valuemax'));
    await control.focus();
    await page.keyboard.press(now < max ? 'ArrowUp' : 'ArrowDown');
    await expect.poll(async () => (await dialSnapshot(screen))[index]?.value).not.toBe(before[index]!.value);
    const after = await dialSnapshot(screen);
    expect(after[index]!.angle).not.toBe(before[index]!.angle);
    for (let other = 0; other < 4; other += 1) if (other !== index) expect(after[other]).toEqual(before[other]);
    await expect(control).toHaveAttribute('aria-valuenow', after[index]!.value);
  }
  // A cancelled push without a completed gesture must not edit a parameter.
  const beforeCancel = await dialSnapshot(screen);
  const cancelControl = encoder(page, 2);
  const cancelBox = await cancelControl.boundingBox();
  expect(cancelBox).not.toBeNull();
  await page.mouse.move(cancelBox!.x + cancelBox!.width / 2, cancelBox!.y + cancelBox!.height / 2);
  await page.mouse.down();
  await cancelControl.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
  await page.mouse.up();
  expect(await dialSnapshot(screen)).toEqual(beforeCancel);

  const beforeDrag = await dialSnapshot(screen);
  const box = await encoder(page, 2).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down(); await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 - 16, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => (await dialSnapshot(screen))[1]?.value).not.toBe(beforeDrag[1]!.value);
  const afterDrag = await dialSnapshot(screen);
  for (const other of [0, 2, 3]) expect(afterDrag[other]).toEqual(beforeDrag[other]);

  const priorKeys = afterDrag.map((item) => item.key);
  await nextPage(page).click();
  await expect.poll(async () => (await dialSnapshot(screen)).map((item) => item.key)).not.toEqual(priorKeys);
  const next = await dialSnapshot(screen);
  const disabled = encoder(page, 4);
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await disabled.dispatchEvent('keydown', { key: 'ArrowUp', bubbles: true });
  expect(await dialSnapshot(screen)).toEqual(next);
  const first = encoder(page, 1);
  if (await first.getAttribute('aria-disabled') === 'false' && next[0]?.angle !== null) {
    const current = Number(await first.getAttribute('aria-valuenow'));
    const max = Number(await first.getAttribute('aria-valuemax'));
    await first.focus(); await page.keyboard.press(current < max ? 'ArrowUp' : 'ArrowDown');
    await expect.poll(async () => (await dialSnapshot(screen))[0]?.value).not.toBe(next[0]!.value);
    const changed = await dialSnapshot(screen);
    for (let other = 1; other < changed.length; other += 1) expect(changed[other]).toEqual(next[other]);
  }
});

test('PLAY FX and MIXER remain their existing layouts', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  const screen = lcdScreen(page);
  for (let index = 0; index < 5; index += 1) await nextPage(page).click();
  await expect(screen).toHaveAttribute('data-classic-screen', 'input-fx');
  await expect(screen.locator('[data-classic-parameter-dials]')).toHaveCount(0);
  await nextPage(page).click();
  await expect(screen).toHaveAttribute('data-classic-screen', 'track-fx');
  await expect(screen.locator('[data-classic-parameter-dials]')).toHaveCount(0);
  await nextPage(page).click(); await nextPage(page).click();
  await page.locator('[data-panel-control="enter"]').click();
  for (let index = 0; index < RC505_MIXER_PAGES.length; index += 1) {
    const mixer = RC505_MIXER_PAGES[index]!;
    await expect(screen).toHaveAttribute('data-classic-screen', `mixer-${mixer.id}`);
    await expect(screen.locator('[data-classic-parameter-dials]')).toHaveCount(0);
    const channels = screen.locator(`[data-classic-mixer="${mixer.id}"] [data-mixer-channel]`);
    await expect(channels).toHaveCount(mixer.channels.length);
    const positions = await channels.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width };
    }));
    expect(Math.max(...positions.map((box) => box.y)) - Math.min(...positions.map((box) => box.y))).toBeLessThan(3);
    for (let column = 0; column < mixer.channels.length; column += 1) {
      const channel = channels.nth(column);
      await expect(channel).toHaveAttribute('data-mixer-channel', mixer.channels[column]!);
      await expect(channel).toHaveAttribute('data-mixer-encoder', String(column + 1));
      await expect(channel.locator('.lcd-mixer-fader')).toHaveCount(1);
      const meter = channel.locator('.lcd-mixer-meter');
      await expect(meter).toHaveCount(1);
      if (await meter.getAttribute('data-meter-available') === 'false') await expect(meter).toContainText('--');
      expect(positions[column]!.width).toBeGreaterThan(0);
      if (column) expect(positions[column]!.x).toBeGreaterThan(positions[column - 1]!.x);
    }
    if (index + 1 < RC505_MIXER_PAGES.length) await nextPage(page).click();
  }
  expect(RC505_MIXER_PAGES.map((item) => item.id)).toEqual(['inputs', 'tracks', 'outputs', 'master']);
  expect(RC505_MIXER_PAGES[1]!.channels).toEqual(['TRACK1', 'TRACK2', 'TRACK3', 'TRACK4']);
  await exit(page).click();
});

for (const root of ['menu', 'loop'] as const) {
  test(`Classic ${root.toUpperCase()} root pages map each of at most four columns to its encoder`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/?audio=browser&ui=classic');
    const screen = lcdScreen(page);
    await page.locator(`[data-panel-control="${root}"]`).click();
    await expect(screen).toHaveAttribute('data-classic-screen', `${root}-root`);
    const items = root === 'menu' ? RC505_MENU_ROOT_ITEMS : RC505_LOOP_ROOT_ITEMS;
    const expectedIds = root === 'loop' ? [['track', 'rec', 'play'], ['input-fx', 'track-fx', 'rhythm', 'name']] : [['input', 'output', 'mixer'], ['ctl-func', 'assign', 'usb', 'midi'], ['setup', 'factory-reset']];
    const pages = expectedIds.length;
    expect(items.length).toBe(expectedIds.flat().length);
    for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
      const expected = getRc505RootPage(root, pageIndex);
      expect(expected.map((item) => item.id)).toEqual(expectedIds[pageIndex]);
      const rootGrid = screen.locator(`[data-classic-root="${root}"]`);
      await expect(rootGrid).toBeVisible();
      const rows = rootGrid.locator('.lcd-data-row');
      await expect(rows).toHaveCount(expected.length);
      const rects = await rows.evaluateAll((elements) => elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }));
      expect(rects.every((box) => box.width > 0 && box.height > 0)).toBe(true);
      expect(Math.max(...rects.map((box) => box.y)) - Math.min(...rects.map((box) => box.y))).toBeLessThan(3);
      for (let i = 1; i < rects.length; i += 1) expect(rects[i]!.x).toBeGreaterThan(rects[i - 1]!.x);
      for (let i = 0; i < expected.length; i += 1) {
        const item = expected[i]!;
        const control = encoder(page, i + 1);
        await expect(rows.nth(i)).toContainText(item.label);
        await expect(rows.nth(i)).toHaveAttribute('data-root-item', item.id);
        await expect(rows.nth(i)).toHaveAttribute('data-root-encoder', String(i + 1));
        await expect(control).toHaveAttribute('aria-label', `${item.label} screen control`);
        if (item.reason) {
          await expect(control).toHaveAttribute('aria-disabled', 'true');
          await expect(control).toHaveAttribute('aria-description', item.reason);
          await control.dispatchEvent('keydown', { key: 'Enter' });
          await control.dispatchEvent('keyup', { key: 'Enter' });
          await expect(screen).toHaveAttribute('data-classic-screen', `${root}-root`);
        } else {
          await expect(control).toHaveAttribute('aria-disabled', 'false');
          await control.press('Enter');
          await expect(screen).toHaveAttribute('data-classic-screen', item.target === 'mixer' ? 'mixer-inputs' : `editor-${item.id}`);
          await exit(page).click();
          await expect(screen).toHaveAttribute('data-classic-screen', `${root}-root`);
        }
      }
      if (pageIndex + 1 < pages) await nextPage(page).click();
    }
  });
}

test('long enum values keep their full accessible detail inside the compact LCD', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  await page.getByTestId('rhythm-edit-button').click();
  await selectLcdEnum(page, 'pattern', '240');
  const field = await findLcdField(page, 'pattern');
  const input = field.getByTestId('lcd-field-pattern');
  const full = await input.getAttribute('aria-valuetext');
  expect(full).toMatch(/^240\s*·/);
  const output = field.locator('.lcd-dial-value');
  await expect(output).toHaveAttribute('title', new RegExp(full!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const geometry = await output.evaluate((node) => {
    const rect = node.getBoundingClientRect(); const parent = node.parentElement!.getBoundingClientRect();
    const css = getComputedStyle(node);
    return { left: rect.left, right: rect.right, parentLeft: parent.left, parentRight: parent.right, overflow: css.overflowX };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.parentLeft - 1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.parentRight + 1);
  expect(geometry.overflow).toBe('hidden');
  const details = field.getByTestId('lcd-details-pattern');
  await expect(details).toBeVisible();
  await details.click();
  const detailView = lcdScreen(page).getByTestId('lcd-details-view');
  await expect(detailView).toBeVisible();
  await expect(detailView).toContainText(full!);
  await exit(page).click();
  await expect(detailView).toHaveCount(0);
  await expect(field.getByTestId('lcd-details-pattern')).toBeFocused();
});
