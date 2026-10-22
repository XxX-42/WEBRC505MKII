import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('repeated closed-context recovery preserves authored gain before explicit output resume', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);
  const original = await page.evaluate(async () => {
    const load = new Function('path', 'return import(path)') as (path: string) => Promise<any>;
    const { AudioEngine } = await load('/src/audio/AudioEngine.ts');
    const { TrackAudio } = await load('/src/audio/TrackAudio.ts');
    const facade = AudioEngine.getInstance();
    const context = facade.tracks[0].engine.context as AudioContext;
    // Seed distinct current and history PCM on all five tracks.
    for (const value of [0.125, 0.25]) {
      const buffers = facade.tracks.map((_: unknown, index: number) => {
        const buffer = context.createBuffer(1, 128 + index, context.sampleRate);
        buffer.getChannelData(0).fill(value + index / 32);
        return buffer;
      });
      const result = TrackAudio.restoreProjectBuffersAtomically(facade.tracks, buffers);
      if (!result.ok) throw new Error(result.reason);
    }
    facade.setOutputLevel(37);
    await new Promise((resolve) => setTimeout(resolve, 100));
    (window as any).__repeatedRecoveryFacade = facade;
    (window as any).__repeatedRecoveryState = () => {
      const browser = facade.tracks[0].engine;
      return {
        level: facade.getOutputLevel(), gain: browser.masterGainNode.gain.value,
        context: browser.context.state, monitorGain: browser.monitorGainNode.gain.value,
        input: Boolean(browser.currentInputStream || browser.currentMediaStream),
        midi: facade.getMidiInputState(),
        tracks: facade.tracks.map((track: any) => ({
          state: track.state,
          pcm: Array.from(track.audioBuffer.getChannelData(0)),
          history: Array.from(track.pcmHistory.snapshot.buffer.getChannelData(0)),
        })),
      };
    };
    await context.close();
    return (window as any).__repeatedRecoveryState();
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.getByTestId('start-audio').click();
    await expect(page.getByTestId('recovery-awaiting-resume')).toBeVisible({ timeout: 20_000 });
    const recovered = await page.evaluate(() => (window as any).__repeatedRecoveryState());
    expect(recovered).toMatchObject({ gain: 0, context: 'suspended', monitorGain: 0, input: false, midi: 'disconnected' });
    expect(recovered.level).toBeCloseTo(37, 5);
    expect(recovered.tracks).toEqual(original.tracks);
    if (attempt === 0) {
      await page.evaluate(async () => { await (window as any).__repeatedRecoveryFacade.tracks[0].engine.context.close(); });
      await expect(page.getByTestId('recovery-awaiting-resume')).not.toBeVisible();
    }
  }
  await page.getByTestId('start-audio').click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).__repeatedRecoveryState())).gain).toBeCloseTo(0.37, 8);
  const resumed = await page.evaluate(() => (window as any).__repeatedRecoveryState());
  expect(resumed).toMatchObject({ context: 'running', monitorGain: 0, input: false, midi: 'disconnected' });
  expect(resumed.level).toBeCloseTo(37, 5);
  expect(resumed.tracks).toEqual(original.tracks);
});
