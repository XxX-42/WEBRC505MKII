import { expect, test } from '@playwright/test';
import path from 'node:path';

const initScriptPath = path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js');

test('IndexedDB 99Memory preserves the project document and native-rate stereo WAV across reload', async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
  await page.goto('/?audio=browser', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.mode-summary')).toHaveText('BROWSER: FULL TRACK CONTROLS');

  const beforeReload = await page.evaluate(async () => {
    const { IndexedDbProjectMemoryStore } = await import('/src/project/IndexedDbProjectMemoryStore.ts');
    const { createDefaultProjectDocument } = await import('/src/project/projectValidation.ts');
    const document = createDefaultProjectDocument('IDB reload persistence');
    document.global.bpm = 93;
    document.tracks[0]!.audioAssetId = 'track-1';

    // Tiny 48 kHz stereo float WAVE with deliberately different L/R values.
    const bytes = new ArrayBuffer(52);
    const view = new DataView(bytes);
    const ascii = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, 44, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
    view.setUint16(22, 2, true); view.setUint32(24, 48_000, true); view.setUint32(28, 384_000, true);
    view.setUint16(32, 8, true); view.setUint16(34, 32, true); ascii(36, 'data'); view.setUint32(40, 8, true);
    view.setFloat32(44, 0.375, true); view.setFloat32(48, -0.625, true);

    const store = new IndexedDbProjectMemoryStore();
    const info = await store.put({
      slot: 42,
      name: 'native stereo memory',
      updatedAt: document.updatedAt,
      document,
      audioAssets: { 'track-1': new Blob([bytes], { type: 'audio/wav' }) },
    });
    store.close();
    return info;
  });
  expect(beforeReload).toMatchObject({ slot: 42, name: 'native stereo memory', assetCount: 1 });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.mode-summary')).toHaveText('BROWSER: FULL TRACK CONTROLS');
  const afterReload = await page.evaluate(async () => {
    const { IndexedDbProjectMemoryStore } = await import('/src/project/IndexedDbProjectMemoryStore.ts');
    const store = new IndexedDbProjectMemoryStore();
    const record = await store.get(42);
    store.close();
    if (!record) return null;
    const asset = record.audioAssets['track-1'];
    if (!(asset instanceof Blob)) return { name: record.name, bpm: record.document.global.bpm, blob: false };
    const data = new DataView(await asset.slice(44, 52).arrayBuffer());
    return {
      name: record.name,
      bpm: record.document.global.bpm,
      sampleRate: new DataView(await asset.slice(0, 44).arrayBuffer()).getUint32(24, true),
      left: data.getFloat32(0, true),
      right: data.getFloat32(4, true),
      blob: true,
    };
  });
  expect(afterReload).toEqual({ name: 'native stereo memory', bpm: 93, sampleRate: 48_000, left: 0.375, right: -0.625, blob: true });
});
