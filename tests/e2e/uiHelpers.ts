import { expect, type Locator, type Page } from '@playwright/test';

/** Starts Browser audio through the same trusted user gesture as the UI. */
export async function startBrowserAudio(page: Page): Promise<void> {
  const startButton = page.getByTestId('start-audio');
  await expect(startButton).toBeVisible();
  if ((await startButton.innerText()).trim() !== 'READY') {
    await expect(startButton).toBeEnabled();
    await startButton.click();
  }
  await expect(startButton).toHaveText('READY', { timeout: 25_000 });
  await expect(page.getByTestId('input-status')).toHaveText('INPUT READY · OUTPUT READY');
}

export async function openAppSettingsMenu(page: Page): Promise<void> {
  const menu = page.locator('details.app-menu');
  const isOpen = await menu.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!isOpen) await menu.locator(':scope > summary').click();
}

async function ensureUiStyle(page: Page, style: 'classic' | 'tech'): Promise<void> {
  const root = page.locator('.app-root');
  await expect(root).toBeVisible();
  if (await root.getAttribute('data-ui-style') === style) return;

  await openAppSettingsMenu(page);
  await page.getByTestId('ui-style-toggle').click();
  await expect(root).toHaveAttribute('data-ui-style', style);
  const menu = page.locator('details.app-menu');
  if (await menu.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await menu.locator(':scope > summary').click();
  }
}

/** Switches to the compatibility shell used by the detailed FX regressions. */
export async function ensureTechStyle(page: Page): Promise<void> {
  await ensureUiStyle(page, 'tech');
}

/** Physical LCD controls are available in the replica shell. */
export async function ensureClassicStyle(page: Page): Promise<void> {
  await ensureUiStyle(page, 'classic');
}

export function lcdScreen(page: Page): Locator {
  return page.getByTestId('rc505-lcd-screen');
}

export function lcdField(page: Page, key: string): Locator {
  return lcdScreen(page).getByTestId(`lcd-field-${key}`);
}

export function enhancedTools(page: Page): Locator {
  return page.getByTestId('enhanced-tools');
}

export async function selectEnhancedTrack(dialog: Locator, trackId: number): Promise<void> {
  const selector = dialog.getByLabel('Enhanced track', { exact: true });
  await expect(selector).toBeVisible();
  await selector.selectOption(String(trackId));
  await expect(selector).toHaveValue(String(trackId));
}

/** Opens a software-only tool page through the user's Enhanced tools surface. */
export async function openEnhancedTools(page: Page, pageLabel?: string): Promise<Locator> {
  const dialog = enhancedTools(page);
  if (!(await dialog.count())) {
    await openAppSettingsMenu(page);
    await page.getByRole('button', { name: 'ENHANCED TOOLS', exact: true }).click();
  }
  await expect(dialog).toBeVisible();
  if (pageLabel) {
    const pageButton = dialog.getByRole('button', { name: pageLabel, exact: true });
    await pageButton.click();
    await expect(pageButton).toHaveAttribute('aria-pressed', 'true');
  }
  return dialog;
}

/** Finds a labeled Enhanced field, advancing the tool's own pages when needed. */
export async function findEnhancedControl(page: Page, key: string): Promise<Locator> {
  const dialog = enhancedTools(page);
  await expect(dialog).toBeVisible();
  const field = dialog.getByTestId(`enhanced-field-${key}`);
  const pageIndicator = dialog.locator('footer span');
  const pageText = await pageIndicator.innerText();
  const match = pageText.match(/(\d+)\s*\/\s*(\d+)/);
  const pageCount = Math.max(1, match ? Number(match[2]) : 1);
  for (let index = 0; index < pageCount; index += 1) {
    if (await field.count() && await field.isVisible()) return field;
    // Pages cycle. Start from the current page, inspect every page once, and
    // return to the starting page if this field does not exist in the dialog.
    await dialog.getByRole('button', { name: 'NEXT', exact: true }).click();
  }
  throw new Error(`Enhanced field "${key}" was not present on any of its displayed pages.`);
}

export async function setEnhancedNumber(page: Page, key: string, value: number): Promise<Locator> {
  const control = await findEnhancedControl(page, key);
  await expect(control).toBeEnabled();
  await control.fill(String(value));
  await control.press('Tab');
  await expect(control).toHaveValue(String(value));
  return control;
}

export async function selectEnhancedEnum(page: Page, key: string, optionLabel: string): Promise<Locator> {
  const control = await findEnhancedControl(page, key);
  await expect(control).toBeEnabled();
  await control.selectOption({ label: optionLabel });
  await expect(control.locator('option:checked')).toHaveText(optionLabel);
  return control;
}

export async function activateEnhancedAction(page: Page, key: string): Promise<Locator> {
  const control = await findEnhancedControl(page, key);
  await expect(control).toBeEnabled();
  await control.click();
  return control;
}

/** Finds an LCD field on the active screen page, advancing through subpages if needed. */
export async function findLcdField(page: Page, keyOrLabel: string): Promise<Locator> {
  const screen = lcdScreen(page);
  await expect(screen).toBeVisible();
  const byKey = screen.locator(`[data-field-key=${JSON.stringify(keyOrLabel)}]`);
  const byLabel = screen.getByText(keyOrLabel, { exact: true }).locator('xpath=ancestor::*[@data-field-key][1]');
  const findVisible = async (): Promise<Locator | null> => {
    if (await byKey.count() && await byKey.isVisible()) return byKey;
    if (await byLabel.count() && await byLabel.first().isVisible()) return byLabel.first();
    return null;
  };

  const firstMatch = await findVisible();
  if (firstMatch) return firstMatch;

  const pageHeader = screen.locator('.lcd-row.top');
  const header = await pageHeader.innerText();
  // The header labels are adjacent in the LCD (for example, "RHYTHM1/3"),
  // so a word boundary before the page number is not reliable.
  const pageMatch = header.match(/(\d+)\s*\/\s*(\d+)/);
  const pageCount = pageMatch ? Number(pageMatch[2]) : 1;
  for (let index = 1; index < pageCount; index += 1) {
    await page.getByRole('button', { name: 'Next display page', exact: true }).click();
    const match = await findVisible();
    if (match) return match;
  }

  throw new Error(`LCD field "${keyOrLabel}" was not present on any of its ${pageCount} displayed page(s).`);
}

export async function setLcdRange(page: Page, keyOrLabel: string, value: number): Promise<Locator> {
  const field = await findLcdField(page, keyOrLabel);
  const control = field.locator('input[type="range"]');
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  await control.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    input.value = String(nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await expect(control).toHaveValue(String(value));
  return control;
}

export async function selectLcdEnum(page: Page, keyOrLabel: string, optionLabel: string): Promise<Locator> {
  const field = await findLcdField(page, keyOrLabel);
  const control = field.locator('input.lcd-enum-range');
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  const labels = JSON.parse((await control.getAttribute('data-option-labels')) ?? '[]') as string[];
  const optionIndex = labels.indexOf(optionLabel) >= 0
    ? labels.indexOf(optionLabel)
    : labels.findIndex((label) => label.startsWith(`${optionLabel} ·`));
  expect(optionIndex, `Option "${optionLabel}" should be present in ${keyOrLabel}`).toBeGreaterThanOrEqual(0);
  await control.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    input.value = String(nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, optionIndex);
  await expect(field.locator('.lcd-enum-value')).toHaveText(labels[optionIndex]!);
  return control;
}

export async function setLcdBoolean(page: Page, keyOrLabel: string, enabled: boolean): Promise<Locator> {
  const field = await findLcdField(page, keyOrLabel);
  const control = field.locator('button');
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  if ((await control.getAttribute('aria-pressed')) !== String(enabled)) await control.click();
  await expect(control).toHaveAttribute('aria-pressed', String(enabled));
  return control;
}

export async function activateLcdAction(page: Page, keyOrLabel: string): Promise<Locator> {
  const field = await findLcdField(page, keyOrLabel);
  const control = field.locator('button');
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  await control.click();
  return control;
}

/** Activates a physical faceplate control and confirms it stays in the LCD. */
export async function openLcdPage(page: Page, controlTestId: string): Promise<Locator> {
  await ensureClassicStyle(page);
  const screen = lcdScreen(page);
  await expect(screen).toBeVisible();
  await page.getByTestId(controlTestId).click();
  await expect(screen).toBeVisible();
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
  return screen;
}

/** Selects the bank slot, then invokes the dedicated physical FX EDIT control. */
export async function openClassicFxEditor(page: Page, location: 'input' | 'track'): Promise<Locator> {
  await ensureClassicStyle(page);
  await page.getByTestId(`${location}-fx-slot-a`).click();
  return openLcdPage(page, `${location}-fx-edit-button`);
}

/** Returns the existing detailed FX panel in Tech compatibility view. */
export async function openFxEditor(page: Page, bank: 'input' | 'track'): Promise<Locator> {
  await ensureTechStyle(page);
  const panel = page.locator(`.top-panel [data-panel="${bank}-fx"]`);
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Selects a track and opens its central LCD LOOP page.
 */
export async function openTrackLcd(page: Page, trackId: number): Promise<Locator> {
  await ensureClassicStyle(page);
  const screen = lcdScreen(page);
  await expect(screen).toBeVisible();
  const strip = page.locator(`[data-panel="track-bay"] .track-strip[data-track-id="${trackId}"]`);
  await expect(strip).toBeVisible();
  const alreadySelected = strip.getByRole('button', { name: `Track ${trackId} selected`, exact: true });
  if (!(await alreadySelected.count())) {
    await strip.getByRole('button', { name: `Select track ${trackId}`, exact: true }).click();
  }
  await strip.locator('[data-track-control="select"]').click();
  await expect(screen).toHaveAttribute('data-classic-screen', 'editor-track');
  await expect(screen).toContainText(new RegExp(`(?:TRACK|TR)\\s*${trackId}`, 'i'));
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
  return screen;
}

/** Kept for legacy callers; central LCD pages do not create drawers. */
export async function closeDeviceDrawer(page: Page): Promise<void> {
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
}
