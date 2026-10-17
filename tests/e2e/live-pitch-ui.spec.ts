import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openTrackLcd, selectLcdEnum, setLcdRange, startBrowserAudio } from './uiHelpers';

declare global {
  interface Window {
    __rc505AudioResumeObservations?: {
      calls: Array<{ state: string; activated: boolean }>;
    };
  }
}

const initScriptPath = path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js');
const track = (page: import('@playwright/test').Page, trackId: number) => page.locator(
  `[data-panel="track-bay"] .track-strip[data-track-id="${trackId}"]`,
);

test('Classic LCD persists independent Browser LIVE_MONO settings through the mock worklet adapter', async ({ page }) => {
  // A query-gated worklet-port shim supplies synthetic ready/status responses.
  // This proves TrackStrip-to-adapter configuration and persistence only; it
  // makes no claim about real worklet execution or audio output.
  await page.addInitScript({ path: initScriptPath });
  await page.goto('/?audio=browser&ui=classic&pitchUiE2e=1');
  await startBrowserAudio(page);

  const track2 = track(page, 2);
  const track1Screen = await openTrackLcd(page, 1);
  const mode1 = track1Screen.getByTestId('lcd-field-keep-pitch');
  await expect(mode1).toBeEnabled();

  await setLcdRange(page, 'keep-pitch-semitones', 5);
  await selectLcdEnum(page, 'keep-pitch', 'LIVE MONO');
  await expect(track1Screen.locator('.lcd-status'))
    .toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');

  const track1AdapterAck = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const audio = AudioEngine.getInstance();
    const trackAudio = audio.tracks[0] as any;
    const node = trackAudio.liveMonoPitchNode;
    const status = await node.getStatus();
    return {
      enabled: trackAudio.liveMonoPitchEnabled,
      nodeName: node.constructor.name,
      status,
      observedNode: (window as unknown as {
        __rc505LivePitchNodeCreations: Array<{ processorName: string; processorOptions: { semitones?: number } }>;
      }).__rc505LivePitchNodeCreations.find((entry) => entry.processorName === 'rc505-live-mono-pitch'),
      routedMessages: (window as unknown as {
        __rc505AudioWorkletMessages: Array<{ processorName: string; message: { type?: string; requestId?: number } }>;
      }).__rc505AudioWorkletMessages
        .filter((entry) => entry.processorName === 'rc505-live-mono-pitch')
        .map((entry) => entry.message),
    };
  });
  expect(track1AdapterAck.enabled).toBe(true);
  expect(track1AdapterAck.nodeName).toBe('MockAudioWorkletNode');
  expect(track1AdapterAck.status.type).toBe('status');
  expect(track1AdapterAck.status.semitones).toBe(5);
  expect(track1AdapterAck.status.latencySamples).toBeGreaterThan(0);
  expect(track1AdapterAck.observedNode?.processorOptions.semitones).toBe(5);
  expect(track1AdapterAck.routedMessages).toContainEqual({ type: 'get-status', requestId: 1 });

  const track2Screen = await openTrackLcd(page, 2);
  await expect(track2).toHaveClass(/selected/);
  const mode2 = track2Screen.getByTestId('lcd-field-keep-pitch');
  await expect(mode2).toBeEnabled();
  await setLcdRange(page, 'keep-pitch-semitones', -7);
  await selectLcdEnum(page, 'keep-pitch', 'LIVE MONO');
  await expect(track2Screen.locator('.lcd-status'))
    .toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');
  const track1AfterSecondEdit = await openTrackLcd(page, 1);
  await expect(track1AfterSecondEdit.locator('.lcd-status'))
    .toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');

  const bothAdapterAcks = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const tracks = AudioEngine.getInstance().tracks as any[];
    const first = await tracks[0].liveMonoPitchNode.getStatus();
    const second = await tracks[1].liveMonoPitchNode.getStatus();
    return { first: first.semitones, second: second.semitones };
  });
  expect(bothAdapterAcks).toEqual({ first: 5, second: -7 });

  await page.reload();
  await startBrowserAudio(page);
  const restoredTrack1Screen = await openTrackLcd(page, 1);
  await expect(restoredTrack1Screen.getByTestId('lcd-field-keep-pitch')).toHaveValue('1');
  await expect(restoredTrack1Screen.getByTestId('lcd-field-keep-pitch-semitones')).toHaveValue('5');
  await expect(restoredTrack1Screen.locator('.lcd-status'))
    .toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');
  const restoredTrack2Screen = await openTrackLcd(page, 2);
  await expect(restoredTrack2Screen.getByTestId('lcd-field-keep-pitch')).toHaveValue('1');
  await expect(restoredTrack2Screen.getByTestId('lcd-field-keep-pitch-semitones')).toHaveValue('-7');
  await expect(restoredTrack2Screen.locator('.lcd-status'))
    .toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');
});

test('Classic LCD sends Native LIVE_POLY track selection to an explicitly labeled mock bridge acknowledgment', async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
  await page.goto('/?audio=native&ui=classic&pitchUiE2e=1');
  await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });

  const track2 = track(page, 2);
  const track2Screen = await openTrackLcd(page, 2);
  const mode2 = track2Screen.getByTestId('lcd-field-keep-pitch');
  await expect(mode2).toBeEnabled();
  await setLcdRange(page, 'keep-pitch-semitones', -4);
  await selectLcdEnum(page, 'keep-pitch', 'LIVE POLY');
  await expect(track2Screen.locator('.lcd-status')).toHaveText('LIVE_POLY ACTIVE');

  const firstMockRequests = await page.evaluate(() => (
    (window as unknown as { __rc505NativePitchRequests: Array<Record<string, unknown>> })
      .__rc505NativePitchRequests
  ));
  expect(firstMockRequests).toContainEqual({
    enabled: true,
    mode: 'livePolyPhaseVocoder',
    trackId: 2,
    semitones: -4,
    reversePlayback: false,
  });
  const firstMockAck = await page.evaluate(() => (
    (window as unknown as { __rc505NativePitchAcks: Array<{ latencySamples: number }> })
      .__rc505NativePitchAcks.at(-1)
  ));
  expect(firstMockAck.latencySamples).toBe(6720);

  const track3Screen = await openTrackLcd(page, 3);
  await setLcdRange(page, 'keep-pitch-semitones', 6);
  await selectLcdEnum(page, 'keep-pitch', 'LIVE MONO');
  await expect(track3Screen.locator('.lcd-status')).toHaveText('LIVE_MONO ACTIVE');
  // The bridge mock reports a single selected Native target. This checks UI
  // behavior under that mock contract, not a physical Native audio route.
  const allMockRequests = await page.evaluate(() => (
    (window as unknown as { __rc505NativePitchRequests: Array<Record<string, unknown>> })
      .__rc505NativePitchRequests
  ));
  expect(allMockRequests.at(-1)).toEqual({
    enabled: true,
    mode: 'liveMonoKeepPitch',
    trackId: 3,
    semitones: 6,
    reversePlayback: false,
  });
  const mockAck = await page.evaluate(() => (
    (window as unknown as { __rc505NativePitchAcks: Array<{ statusNote: string }> })
      .__rc505NativePitchAcks.at(-1)
  ));
  expect(mockAck.statusNote).toContain('TEST-ONLY MOCK BRIDGE ACK');
  const inactiveTrack2Screen = await openTrackLcd(page, 2);
  await expect(inactiveTrack2Screen.locator('.lcd-status')).toHaveText('LIVE_POLY INACTIVE');
});

test('Browser START AUDIO uses a trusted gesture and reaches real LIVE_MONO worklet readiness', async ({ page }) => {
  // Observe real AudioContext startup from the explicit trusted UI gesture.
  // AudioWorklet modules and processors remain real.
  await page.addInitScript(() => {
    if (new URLSearchParams(window.location.search).get('pitchResumeE2e') !== '1') return;
    window.__rc505AudioResumeObservations = { calls: [] };
    const nativeResume = window.AudioContext.prototype.resume;
    window.AudioContext.prototype.resume = function resumeWithAutoplayGate() {
      window.__rc505AudioResumeObservations?.calls.push({
        state: this.state,
        activated: navigator.userActivation?.isActive ?? false,
      });
      return nativeResume.call(this);
    };
  });

  await page.goto('/?audio=browser&ui=classic&pitchResumeE2e=1');
  await expect(page.locator('[data-panel="status"] .status-label')).toHaveText('BROWSER · CLICK START AUDIO');
  await expect.poll(async () => page.evaluate(() => window.__rc505AudioResumeObservations?.calls.length ?? 0)).toBe(0);

  await startBrowserAudio(page);
  await expect(page.locator('[data-panel="status"] .status-label')).toHaveText('BROWSER AUDIO READY', { timeout: 15_000 });

  const audioRuntime = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const engine = AudioEngine.getInstance() as any;
    const browser = engine.browser;
    return {
      contextState: browser.context.state,
      engineReady: browser.getUiStatus().ready,
      masterWorkletNode: browser.workletNode?.constructor.name,
      resumeCalls: window.__rc505AudioResumeObservations?.calls ?? [],
    };
  });
  expect(audioRuntime.contextState).toBe('running');
  expect(audioRuntime.engineReady).toBe(true);
  expect(audioRuntime.masterWorkletNode).toBe('AudioWorkletNode');
  expect(audioRuntime.resumeCalls.length).toBeGreaterThan(0);
  expect(audioRuntime.resumeCalls.every((call: { activated: boolean }) => call.activated)).toBe(true);

  const trackScreen = await openTrackLcd(page, 1);
  await setLcdRange(page, 'keep-pitch-semitones', 5);
  await selectLcdEnum(page, 'keep-pitch', 'LIVE MONO');
  await expect(trackScreen.locator('.lcd-status'))
    .toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK', { timeout: 15_000 });
  const pitchWorklet = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const audio = AudioEngine.getInstance();
    const trackAudio = audio.tracks[0] as any;
    const node = trackAudio.liveMonoPitchNode;
    const ready = await node.ready;
    const status = await node.getStatus();
    return {
      realAudioWorkletNode: node instanceof AudioWorkletNode,
      ready,
      status,
    };
  });
  expect(pitchWorklet.realAudioWorkletNode).toBe(true);
  expect(pitchWorklet.ready.type).toBe('ready');
  expect(pitchWorklet.ready.semitones).toBe(5);
  expect(pitchWorklet.status.type).toBe('status');
  expect(pitchWorklet.status.semitones).toBe(5);
});
