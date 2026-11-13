import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

const screen = (page: Page) => page.getByTestId('rc505-lcd-screen');
const button = (page: Page, name: string) => page.locator(`[data-panel-control="${name}"]`);
async function goToPlayFx(page: Page, target: 'input' | 'track') {
  await expect(screen(page)).toHaveAttribute('data-classic-screen', 'memory-number');
  for (let i = 0; i < (target === 'input' ? 5 : 6); i += 1) await button(page, 'page-next').click();
  await expect(screen(page)).toHaveAttribute('data-classic-screen', `${target}-fx`);
  const display = page.locator(`[data-classic-fx-display="${target}"]`);
  await expect(display).toBeVisible();
  return display;
}
async function assertFourColumnGeometry(page: Page, target: 'input' | 'track') {
  const columns = page.locator(`[data-classic-fx-display="${target}"] [data-fx-slot]`);
  await expect(columns).toHaveCount(4);
  const rects = await columns.evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
  expect(rects.every(rect => rect.width > 0 && rect.height > 0)).toBe(true);
  expect(rects.every((rect, index) => index === 0 || rect.x > rects[index - 1]!.x)).toBe(true);
  expect(Math.max(...rects.map(rect => rect.y)) - Math.min(...rects.map(rect => rect.y))).toBeLessThan(2);
}
async function assertConfirmedColumns(page: Page, target: 'input' | 'track') {
  const display = page.locator(`[data-classic-fx-display="${target}"]`);
  const snapshot = await page.evaluate(async target => {
    const load = new Function('s', 'return import(s)') as (specifier: string) => Promise<any>;
    const { AudioEngine } = await load('/src/audio/AudioEngine.ts');
    return AudioEngine.getInstance().getBrowserSharedFxSnapshot(target);
  }, target);
  for (const [index, slot] of ['A', 'B', 'C', 'D'].entries()) {
    const column = display.locator(`[data-fx-slot="${slot}"]`);
    await expect(column).toHaveCount(1);
    const expectedOn = snapshot[index].state === 'ready' && snapshot[index].active;
    await expect(column).toHaveAttribute('data-active', expectedOn ? 'ON' : 'OFF');
    await expect(column).toHaveAttribute('data-confirmed', 'true');
    if (expectedOn) await expect(column).toHaveClass(/\bis-on\b/);
    else await expect(column).not.toHaveClass(/\bis-on\b/);
  }
  await expect(display).not.toContainText(/\b(?:READY|ACK|OFF)\b/);
}

test('four confirmed FX columns persist across pages and resizing; ENTER opens MIXER', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  await page.evaluate(async () => {
    const load = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
    const { useRc505FxSwitchSettings } = await load('/src/composables/useRc505FxSwitchSettings.ts');
    for (const target of ['input', 'track']) {
      const settings = useRc505FxSwitchSettings('browser', target, 'A');
      if (!settings.update({ mode: 'MULTI', switchModes: { A: 'TOGGLE', B: 'TOGGLE', C: 'TOGGLE', D: 'TOGGLE' } })) throw new Error(settings.state.error);
    }
  });
  for (const target of ['input', 'track'] as const) {
    for (const slot of ['a', 'b']) await page.getByTestId(`${target}-fx-slot-${slot}`).click();
  }
  const input = await goToPlayFx(page, 'input');
  await assertFourColumnGeometry(page, 'input');
  await expect.poll(async () => page.evaluate(async () => {
    const load = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
    const { AudioEngine } = await load('/src/audio/AudioEngine.ts');
    return AudioEngine.getInstance().getBrowserSharedFxSnapshot('input').slice(0, 2).every((item: any) => item.state === 'ready' && item.active);
  })).toBe(true);
  await assertConfirmedColumns(page, 'input');
  await expect(input.locator('[data-fx-knob-label="1"]')).toHaveText('MEMORY');
  for (let i = 2; i <= 4; i += 1) {
    await expect(input.locator(`[data-fx-knob-label="${i}"]`)).toHaveText('');
    await expect(button(page, `screen-encoder-${i}`)).toHaveAttribute('aria-disabled', 'true');
  }
  await page.screenshot({ path: path.join(tmpdir(), 'rc505-fx-play-1920.png'), fullPage: true });
  await button(page, 'page-next').click();
  await expect(screen(page)).toHaveAttribute('data-classic-screen', 'track-fx');
  await assertFourColumnGeometry(page, 'track');
  for (let i = 2; i <= 4; i += 1) await expect(button(page, `screen-encoder-${i}`)).toHaveAttribute('aria-disabled', 'true');
  await expect.poll(async () => page.evaluate(async () => {
    const load = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
    const { AudioEngine } = await load('/src/audio/AudioEngine.ts');
    return AudioEngine.getInstance().getBrowserSharedFxSnapshot('track').slice(0, 2).every((item: any) => item.state === 'ready' && item.active);
  })).toBe(true);
  await assertConfirmedColumns(page, 'track');
  await page.setViewportSize({ width: 1366, height: 768 });
  await assertConfirmedColumns(page, 'track');
  await assertFourColumnGeometry(page, 'track');
  await page.screenshot({ path: path.join(tmpdir(), 'rc505-fx-play-1366.png'), fullPage: true });
  await button(page, 'page-prev').click();
  await assertConfirmedColumns(page, 'input');
  await button(page, 'enter').click();
  await expect(screen(page)).toHaveAttribute('data-classic-screen', 'mixer-inputs');
});

test('unconfirmed FX columns stay unhighlighted before Browser audio starts', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  const display = await goToPlayFx(page, 'input');
  const unknown = display.locator('[data-active="UNKNOWN"]');
  await expect(unknown.first()).toBeVisible();
  await expect(unknown.first()).not.toHaveClass(/\bis-on\b/);
  await expect(unknown.first().locator('.fx-play-type')).toHaveText('--');
});
