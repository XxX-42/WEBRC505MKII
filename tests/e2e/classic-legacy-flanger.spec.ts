import { expect, test } from '@playwright/test';
import { openClassicFxEditor, selectLcdEnum, startBrowserAudio } from './uiHelpers';

test('legacy FLANGER knob works without installing official defaults; Memory lock keeps material stable', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  await openClassicFxEditor(page, 'input');
  await selectLcdEnum(page, 'type', 'FLANGER');
  const knob = page.getByRole('slider', { name: 'INPUT FX selected effect value', exact: true });
  await expect(knob).toHaveAttribute('aria-disabled', 'false');
  const before = Number(await knob.getAttribute('aria-valuenow'));
  await knob.focus(); await page.keyboard.press('ArrowUp');
  await expect(knob).toHaveAttribute('aria-valuenow', String(before + 1));
  const named = await page.evaluate(async () => {
    const { useFxPanelState } = await import('/src/composables/useFxPanelState.ts');
    return useFxPanelState('input').slots.value[0]?.namedParametersByType?.FLANGER ?? {};
  });
  expect(Object.keys(named).filter(key => key.startsWith('official_'))).toEqual([]);
  // Observe a real Memory load in this isolated Browser context only.
  await page.locator('[data-panel-control="exit"]').click();
  const changes = await page.evaluate(async () => {
    const { useRc505Memory } = await import('/src/composables/useRc505Memory.ts');
    const face = document.querySelector('.rc505-face')!;
    const samples: string[] = [];
    const sample = () => {
      const button = face.querySelector('.hardware-button.appearance-classic.is-disabled');
      if (button) samples.push(getComputedStyle(button).opacity + ':' + getComputedStyle(button).filter);
    };
    const observer = new MutationObserver(sample);
    observer.observe(face, { subtree: true, attributes: true, attributeFilter: ['class', 'disabled'] });
    sample();
    try { await useRc505Memory().load(1); } catch { /* empty slot still exercises lock cleanup */ }
    await new Promise(resolve => setTimeout(resolve, 50)); observer.disconnect();
    return samples;
  });
  expect(changes.length).toBeGreaterThan(0);
  expect(changes.every(value => value === '1:none')).toBe(true);
});
