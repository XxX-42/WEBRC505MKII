import { expect, test, type Page } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

const lcd = (page: Page) => page.getByTestId('rc505-lcd-screen');
const button = (page: Page, key: string) => page.locator(`[data-panel-control="${key}"]`);
async function writeChord(page: Page) {
  await button(page, 'exit').dispatchEvent('pointerdown', { pointerId: 41, pointerType: 'touch', button: 0, isPrimary: true });
  await button(page, 'enter').dispatchEvent('pointerdown', { pointerId: 42, pointerType: 'touch', button: 0, isPrimary: false });
  await button(page, 'enter').dispatchEvent('pointerup', { pointerId: 42, pointerType: 'touch', button: 0, isPrimary: false });
  await button(page, 'exit').dispatchEvent('pointerup', { pointerId: 41, pointerType: 'touch', button: 0, isPrimary: true });
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'memory-choose');
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?audio=browser&ui=classic');
  // This journey accepts virtual input. The app still resumes its actual
  // AudioContext from START AUDIO and warms the production capture worklet.
  // Permission rejection/timeout behavior is covered by the startup suite.
  await page.evaluate(async () => {
    const { AudioEngine } = await (new Function('return import("/src/audio/AudioEngine.ts")'))();
    const engine = AudioEngine.getInstance().tracks[0].engine;
    const source = engine.context.createOscillator(), gain = engine.context.createGain();
    const destination = engine.context.createMediaStreamDestination();
    gain.gain.value = .05; source.frequency.value = 220;
    source.connect(gain); gain.connect(destination); source.start();
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => destination.stream });
  });
  await startBrowserAudio(page);
});

test('Classic WRITE chord, NAME and encoder recall preserve real stereo PCM and recovery', async ({ page }) => {
  await page.evaluate(async () => {
    const load = (path: string) => (new Function('path', 'return import(path)'))(path);
    const { AudioEngine } = await load('/src/audio/AudioEngine.ts');
    const { TrackAudio } = await load('/src/audio/TrackAudio.ts');
    const engine = AudioEngine.getInstance().tracks[0].engine;
    const buffer = engine.context.createBuffer(2, 4096, engine.context.sampleRate);
    buffer.getChannelData(0).fill(.25); buffer.getChannelData(1).fill(-.5);
    const result = TrackAudio.restoreProjectBuffersAtomically(engine.tracks, [buffer, null, null, null, null]);
    if (!result.ok) throw new Error(result.reason);
  });
  await button(page, 'loop').click(); await button(page, 'page-next').click(); await button(page, 'screen-encoder-3').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'editor-name');
  await page.getByTestId('lcd-field-memory-name-0').focus(); await page.keyboard.press('ArrowRight');
  await button(page, 'exit').click(); await button(page, 'exit').click();
  await expect(lcd(page)).toContainText('A');
  await writeChord(page); await button(page, 'screen-encoder-1').click(); await button(page, 'enter').click();
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'memory-number');
  await expect(lcd(page)).toContainText('SAVED');
  await page.evaluate(async () => {
    const { AudioEngine } = await (new Function('return import("/src/audio/AudioEngine.ts")'))();
    AudioEngine.getInstance().tracks[0].track.playLevel = 23;
  });
  await expect(lcd(page)).toContainText('EDITED');
  // Turning below 01 recalls 01; wait for confirmed content, never an old SAVED label.
  await button(page, 'screen-encoder-1').focus(); await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => page.evaluate(async () => {
    const { AudioEngine } = await (new Function('return import("/src/audio/AudioEngine.ts")'))();
    return AudioEngine.getInstance().tracks[0].track.playLevel;
  })).toBe(100);
  await expect(lcd(page)).toContainText('SAVED');
  const result = await page.evaluate(async () => {
    const load = (path: string) => (new Function('path', 'return import(path)'))(path);
    const { AudioEngine } = await load('/src/audio/AudioEngine.ts');
    const { Rc505MemoryStore } = await load('/src/audio/Rc505MemoryStore.ts');
    const { decodeRc505Memory } = await load('/src/audio/Rc505Memory.ts');
    const facade = AudioEngine.getInstance(), pcm = facade.tracks[0].getProjectPcmSnapshot();
    const recovery = await decodeRc505Memory(await new Rc505MemoryStore().readRecovery());
    return { left: pcm.channelData[0][0], right: pcm.channelData[1][0], level: facade.tracks[0].track.playLevel,
      recoveryLevel: recovery.extensions.WEBRC.browserMemory.tracks[0].settings.playLevel };
  });
  expect(result).toEqual({ left: .25, right: -.5, level: 100, recoveryLevel: 23 });
});

test('MOMENT pointer, keyboard, cancel, capture loss and blur all release the original FX', async ({ page }) => {
  await page.evaluate(async () => {
    const { useRc505FxSwitchSettings } = await (new Function('return import("/src/composables/useRc505FxSwitchSettings.ts")'))();
    const settings = useRc505FxSwitchSettings('browser', 'input', 'A');
    if (!settings.update({ mode: 'MULTI', switchModes: { A: 'MOMENT', B: 'TOGGLE', C: 'TOGGLE', D: 'TOGGLE' } })) throw new Error(settings.state.error);
  });
  const a = page.getByTestId('input-fx-slot-a');
  for (const release of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) {
    await a.dispatchEvent('pointerdown', { pointerId: 31, pointerType: 'touch', button: 0, isPrimary: true });
    await expect(a).toHaveAttribute('data-led-on', 'true');
    if (release === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else await a.dispatchEvent(release, { pointerId: 31, pointerType: 'touch', button: 0 });
    await expect(a).toHaveAttribute('data-led-on', 'false');
  }
  await a.focus(); await page.keyboard.down('Space'); await expect(a).toHaveAttribute('data-led-on', 'true');
  await page.keyboard.up('Space'); await expect(a).toHaveAttribute('data-led-on', 'false');
  await expect(lcd(page)).toHaveAttribute('data-classic-screen', 'memory-number');
});
