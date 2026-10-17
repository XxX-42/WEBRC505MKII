import path from 'node:path';
import { expect, test } from '@playwright/test';

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

test('Browser TrackStrip persists independent LIVE_MONO settings through the mock worklet adapter', async ({ page }) => {
  // A query-gated worklet-port shim supplies synthetic ready/status responses.
  // This proves TrackStrip-to-adapter configuration and persistence only; it
  // makes no claim about real worklet execution or audio output.
  await page.addInitScript({ path: initScriptPath });
  await page.goto('/?audio=browser&pitchUiE2e=1');

  const track1 = track(page, 1);
  const track2 = track(page, 2);
  const mode1 = track1.getByTestId('keep-pitch-mode');
  const mode2 = track2.getByTestId('keep-pitch-mode');
  await expect(mode1).toBeEnabled();
  await expect(mode2).toBeEnabled();

  await track1.getByTestId('keep-pitch-semitones').fill('5');
  await mode1.selectOption('LIVE_MONO');
  await expect(track1.getByTestId('keep-pitch-status'))
    .toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');
  await expect(track1.getByTestId('keep-pitch-latency')).toContainText('algorithmic latency:');

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

  await track2.getByRole('button', { name: 'Select track 2' }).click();
  await expect(track2).toHaveClass(/selected/);
  await track2.getByTestId('keep-pitch-semitones').fill('-7');
  await mode2.selectOption('LIVE_MONO');
  await expect(track2.getByTestId('keep-pitch-status'))
    .toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');
  await expect(track1.getByTestId('keep-pitch-status'))
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
  const restoredTrack1 = track(page, 1);
  const restoredTrack2 = track(page, 2);
  await expect(restoredTrack1.getByTestId('keep-pitch-mode')).toHaveValue('LIVE_MONO');
  await expect(restoredTrack2.getByTestId('keep-pitch-mode')).toHaveValue('LIVE_MONO');
  await expect(restoredTrack1.getByTestId('keep-pitch-semitones')).toHaveValue('5');
  await expect(restoredTrack2.getByTestId('keep-pitch-semitones')).toHaveValue('-7');
  await expect(restoredTrack1.getByTestId('keep-pitch-status'))
    .toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');
  await expect(restoredTrack2.getByTestId('keep-pitch-status'))
    .toHaveText('LIVE_MONO ENABLED; WAITING FOR LOOP PLAYBACK');
});

test('Native TrackStrip sends LIVE_POLY track selection to an explicitly labeled mock bridge acknowledgment', async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
  await page.goto('/?audio=native&pitchUiE2e=1');

  const track2 = track(page, 2);
  const mode2 = track2.getByTestId('keep-pitch-mode');
  await expect(mode2).toBeEnabled();
  await expect(track2.getByTestId('keep-pitch-native-limit'))
    .toHaveText('Native KeepPitch supports one selected track target at a time');
  await track2.getByRole('button', { name: 'Select track 2' }).click();
  await track2.getByTestId('keep-pitch-semitones').fill('-4');
  await mode2.selectOption('LIVE_POLY');
  await expect(track2.getByTestId('keep-pitch-status')).toHaveText('LIVE_POLY ACTIVE');
  await expect(track2.getByTestId('keep-pitch-latency')).toContainText('6720 samples');

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

  const track3 = track(page, 3);
  await track3.getByRole('button', { name: 'Select track 3' }).click();
  await track3.getByTestId('keep-pitch-semitones').fill('6');
  await track3.getByTestId('keep-pitch-mode').selectOption('LIVE_MONO');
  await expect(track3.getByTestId('keep-pitch-status')).toHaveText('LIVE_MONO ACTIVE');
  // The bridge mock reports a single selected Native target. This checks UI
  // behavior under that mock contract, not a physical Native audio route.
  await expect(track2.getByTestId('keep-pitch-status')).toHaveText('LIVE_POLY INACTIVE');

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
});

test('Browser retry resumes the real AudioContext and reaches real LIVE_MONO worklet readiness', async ({ page }) => {
  // Observe real autoplay behavior: init's mount-time resume remains pending,
  // while the next call uses CfT's real AudioContext.resume from the trusted
  // Playwright click. AudioWorklet modules/processors remain real.
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
  await expect(page.locator('[data-panel="status"] .status-label')).toHaveText('CONNECTING BROWSER');
  await expect.poll(async () => page.evaluate(() => window.__rc505AudioResumeObservations?.calls.length ?? 0)).toBe(1);
  await expect(page.getByRole('button', { name: 'RETRY' })).toBeEnabled();

  await page.getByRole('button', { name: 'RETRY' }).click();
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
  expect(audioRuntime.resumeCalls).toHaveLength(2);
  expect(audioRuntime.resumeCalls[1].activated).toBe(true);

  const strip = track(page, 1);
  await strip.getByTestId('keep-pitch-semitones').fill('5');
  await strip.getByTestId('keep-pitch-mode').selectOption('LIVE_MONO');
  await expect(strip.getByTestId('keep-pitch-status'))
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
