import { expect, test } from '@playwright/test';
import { ensureClassicStyle, startBrowserAudio } from './uiHelpers';

test('physical Undo/Redo control layer restores exact recorded stereo PCM through track REC/PLAY', async ({ page }) => {
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices;
    mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const merger = context.createChannelMerger(2);
      const destination = context.createMediaStreamDestination();
      const left = context.createOscillator();
      const right = context.createOscillator();
      const leftGain = context.createGain();
      const rightGain = context.createGain();
      left.type = right.type = 'sine';
      left.frequency.value = 377;
      right.frequency.value = 911;
      leftGain.gain.value = 0.25;
      rightGain.gain.value = 0.18;
      left.connect(leftGain).connect(merger, 0, 0);
      right.connect(rightGain).connect(merger, 0, 1);
      merger.connect(destination);
      left.start();
      right.start();
      await context.resume();
      (window as any).__pcmHistorySyntheticInput = { context, left, right };
      return destination.stream;
    };
  });

  await page.goto('/?audio=browser');
  await ensureClassicStyle(page);
  await startBrowserAudio(page);

  const recorded = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const { AudioEngine } = await loadModule('/src/audio/AudioEngine.ts');
    const root = document.querySelector('.app-root') as (HTMLElement & { __vueParentComponent?: any }) | null;
    const engine = root?.__vueParentComponent?.setupState?.engine ?? AudioEngine.getInstance();
    const track = engine.tracks[0];
    const waitFor = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    await track.startRecording();
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    await track.stopRecording();
    await waitFor(() => track.audioBuffer instanceof AudioBuffer && !track.isFinalizingRecording, 'stereo record finalization');
    track.stop();
    const buffer = track.audioBuffer as AudioBuffer;
    if (buffer.numberOfChannels !== 2 || buffer.length < 2_000) {
      throw new Error(`Expected a useful stereo history snapshot, got ${buffer.numberOfChannels}ch × ${buffer.length} frames`);
    }
    const interleaved = new Float32Array(buffer.length * 2);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let frame = 0; frame < buffer.length; frame += 1) {
      interleaved[frame * 2] = left[frame]!;
      interleaved[(frame * 2) + 1] = right[frame]!;
    }
    const bytes = new Uint8Array(interleaved.buffer);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return {
      frameCount: buffer.length,
      channels: buffer.numberOfChannels,
      digest: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(''),
      leftEnergy: left.reduce((sum: number, value: number) => sum + value * value, 0),
      rightEnergy: right.reduce((sum: number, value: number) => sum + value * value, 0),
    };
  });

  const historyLayerButton = page.locator('[data-panel-control="undo-redo"]');
  await expect(historyLayerButton).toBeEnabled();
  await expect(historyLayerButton).toHaveAttribute('aria-label', 'Toggle Undo/Redo control layer');
  await historyLayerButton.click();
  const recordPlayButton = page.locator('[data-track-id="1"] [data-panel-control="record-play"]');
  await expect(recordPlayButton).toHaveAttribute('data-hardware-role', 'UNDO');
  await recordPlayButton.click();
  await expect(recordPlayButton).toHaveAttribute('data-hardware-role', 'REDO');
  await page.waitForFunction(() => {
    const root = document.querySelector('.app-root') as (HTMLElement & { __vueParentComponent?: any }) | null;
    const engine = root?.__vueParentComponent?.setupState?.engine;
    return engine?.tracks?.[0]?.audioBuffer === null;
  });

  await recordPlayButton.click();
  await expect(recordPlayButton).toHaveAttribute('data-hardware-role', 'UNDO');
  await historyLayerButton.click();
  const restored = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const { AudioEngine } = await loadModule('/src/audio/AudioEngine.ts');
    const root = document.querySelector('.app-root') as (HTMLElement & { __vueParentComponent?: any }) | null;
    const engine = root?.__vueParentComponent?.setupState?.engine ?? AudioEngine.getInstance();
    const buffer = engine.tracks[0].audioBuffer as AudioBuffer | null;
    if (!buffer || buffer.numberOfChannels !== 2) throw new Error('Redo did not restore a stereo loop');
    const interleaved = new Float32Array(buffer.length * 2);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let frame = 0; frame < buffer.length; frame += 1) {
      interleaved[frame * 2] = left[frame]!;
      interleaved[(frame * 2) + 1] = right[frame]!;
    }
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(interleaved.buffer));
    return {
      frameCount: buffer.length,
      channels: buffer.numberOfChannels,
      digest: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(''),
      leftEnergy: left.reduce((sum: number, value: number) => sum + value * value, 0),
      rightEnergy: right.reduce((sum: number, value: number) => sum + value * value, 0),
    };
  });

  expect(recorded.channels).toBe(2);
  expect(restored).toEqual(recorded);
  await page.evaluate(() => {
    const root = document.querySelector('.app-root') as (HTMLElement & { __vueParentComponent?: any }) | null;
    root?.__vueParentComponent?.setupState?.engine?.tracks?.[0]?.stop();
  });
});
