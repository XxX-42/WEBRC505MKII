import path from 'node:path';
import { expect, test } from '@playwright/test';
import { findEnhancedControl, openEnhancedTools, selectEnhancedEnum, selectEnhancedTrack, setEnhancedNumber, startBrowserAudio } from './uiHelpers';

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

test('Enhanced Tools persists independent Browser LIVE_MONO settings through the mock worklet adapter', async ({ page }) => {
  // A query-gated worklet-port shim supplies synthetic ready/status responses.
  // This proves TrackStrip-to-adapter configuration and persistence only; it
  // makes no claim about real worklet execution or audio output.
  await page.addInitScript({ path: initScriptPath });
  await page.goto('/?audio=browser&ui=classic&pitchUiE2e=1');
  await startBrowserAudio(page);

  const track2 = track(page, 2);
  const tools = await openEnhancedTools(page, 'PITCH / HQ WAV');
  await selectEnhancedTrack(tools, 1);
  const mode1 = await findEnhancedControl(page, 'keep-pitch');
  await expect(mode1).toBeEnabled();

  await setEnhancedNumber(page, 'keep-pitch-semitones', 5);
  await selectEnhancedEnum(page, 'keep-pitch', 'LIVE MONO');
  await expect(tools.getByRole('status')).toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');

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

  await selectEnhancedTrack(tools, 2);
  await expect(track2).toHaveClass(/selected/);
  const mode2 = await findEnhancedControl(page, 'keep-pitch');
  await expect(mode2).toBeEnabled();
  await setEnhancedNumber(page, 'keep-pitch-semitones', -7);
  await selectEnhancedEnum(page, 'keep-pitch', 'LIVE MONO');
  await expect(tools.getByRole('status')).toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');
  await selectEnhancedTrack(tools, 1);
  await expect(tools.getByRole('status')).toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');

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
  const restoredTools = await openEnhancedTools(page, 'PITCH / HQ WAV');
  await selectEnhancedTrack(restoredTools, 1);
  await expect(await findEnhancedControl(page, 'keep-pitch')).toHaveValue('1');
  await expect(await findEnhancedControl(page, 'keep-pitch-semitones')).toHaveValue('5');
  await expect(restoredTools.getByRole('status')).toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');
  await selectEnhancedTrack(restoredTools, 2);
  await expect(await findEnhancedControl(page, 'keep-pitch')).toHaveValue('1');
  await expect(await findEnhancedControl(page, 'keep-pitch-semitones')).toHaveValue('-7');
  await expect(restoredTools.getByRole('status')).toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');
});

test('Enhanced Tools sends Native LIVE_POLY track selection to an explicitly labeled mock bridge acknowledgment', async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
  await page.goto('/?audio=native&ui=classic&pitchUiE2e=1');
  await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });

  const tools = await openEnhancedTools(page, 'PITCH / HQ WAV');
  await selectEnhancedTrack(tools, 2);
  const track2 = track(page, 2);
  const mode2 = await findEnhancedControl(page, 'keep-pitch');
  await expect(mode2).toBeEnabled();
  await setEnhancedNumber(page, 'keep-pitch-semitones', -4);
  await selectEnhancedEnum(page, 'keep-pitch', 'LIVE POLY');
  await expect(tools.getByRole('status')).toHaveText('LIVE_POLY ACTIVE');

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

  await selectEnhancedTrack(tools, 3);
  await setEnhancedNumber(page, 'keep-pitch-semitones', 6);
  await selectEnhancedEnum(page, 'keep-pitch', 'LIVE MONO');
  await expect(tools.getByRole('status')).toHaveText('LIVE_MONO ACTIVE');
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
  await selectEnhancedTrack(tools, 2);
  await expect(tools.getByRole('status')).toHaveText('LIVE_POLY INACTIVE');
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

  const tools = await openEnhancedTools(page, 'PITCH / HQ WAV');
  await selectEnhancedTrack(tools, 1);
  await setEnhancedNumber(page, 'keep-pitch-semitones', 5);
  await selectEnhancedEnum(page, 'keep-pitch', 'LIVE MONO');
  await expect(tools.getByRole('status'))
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
