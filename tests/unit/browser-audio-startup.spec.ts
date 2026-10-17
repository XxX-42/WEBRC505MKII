import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import {
  BROWSER_AUDIO_INPUT_TIMEOUT_MS,
  BROWSER_AUDIO_RESUME_TIMEOUT_MS,
  BROWSER_AUDIO_WORKLET_TIMEOUT_MS,
  getUserMediaWithTimeout,
  resumeAudioContextWithTimeout,
} from '../../src/audio/browserAudioStartup';

class FakeAudioWorkletNode {
  readonly port: { onmessage: ((event: MessageEvent) => void) | null; postMessage: (_message: unknown) => void } = {
    onmessage: null,
    postMessage: () => undefined,
  };

  constructor(_context: AudioContext, _name: string, _options?: AudioWorkletNodeOptions) {}
  connect(_target?: unknown) {}
  disconnect() {}
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Browser audio startup deadlines', () => {
  it('bounds a suspended AudioContext resume at 15 seconds', async () => {
    vi.useFakeTimers();
    const resume = vi.fn(() => new Promise<void>(() => undefined));
    const pending = resumeAudioContextWithTimeout({ resume }, BROWSER_AUDIO_RESUME_TIMEOUT_MS);
    const rejection = expect(pending).rejects.toThrow('AudioContext.resume() timed out after 15000 ms.');

    await vi.advanceTimersByTimeAsync(BROWSER_AUDIO_RESUME_TIMEOUT_MS);

    await rejection;
    expect(resume).toHaveBeenCalledOnce();
  });

  it('stops every microphone track when a permission grant arrives after the 20-second deadline', async () => {
    vi.useFakeTimers();
    let resolvePermission!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { resolvePermission = resolve; }));
    const pending = getUserMediaWithTimeout({ getUserMedia }, { audio: true }, BROWSER_AUDIO_INPUT_TIMEOUT_MS);
    const rejection = expect(pending).rejects.toThrow('Microphone permission request timed out after 20000 ms.');

    await vi.advanceTimersByTimeAsync(BROWSER_AUDIO_INPUT_TIMEOUT_MS);
    await rejection;

    const stop = vi.fn();
    resolvePermission({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await Promise.resolve();

    expect(stop).toHaveBeenCalledOnce();
  });

  it('clears a timed-out worklet load so a later explicit retry can complete', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const engine = new BrowserAudioEngine();
    let resolveFirst!: () => void;
    const addModule = vi.spyOn(engine.context.audioWorklet!, 'addModule');
    addModule
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(undefined);

    const firstAttempt = engine.ensureTrackIoWorkletModule();
    const rejection = expect(firstAttempt).rejects.toThrow('browser-track-io.js timed out after 15000 ms.');
    await vi.advanceTimersByTimeAsync(BROWSER_AUDIO_WORKLET_TIMEOUT_MS);
    await rejection;

    const retry = engine.ensureTrackIoWorkletModule();
    resolveFirst();
    await expect(retry).resolves.toBeUndefined();
    expect(addModule).toHaveBeenCalledOnce();
  });

  it('starts a fresh worklet load after the underlying module load rejects', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const engine = new BrowserAudioEngine();
    const addModule = vi.spyOn(engine.context.audioWorklet!, 'addModule');
    addModule
      .mockRejectedValueOnce(new Error('module load failed'))
      .mockResolvedValue(undefined);

    await expect(engine.ensureTrackIoWorkletModule()).rejects.toThrow('module load failed');
    await expect(engine.ensureTrackIoWorkletModule()).resolves.toBeUndefined();
    expect(addModule).toHaveBeenCalledTimes(2);
  });

  it('keeps Browser output ready when microphone permission is denied', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    localStorage.setItem('audioInputDeviceId', '');
    localStorage.setItem('audioOutputDeviceId', '');
    const engine = new BrowserAudioEngine();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));

    await engine.init();
    expect(engine.getUiStatus()).toMatchObject({ ready: true, inputReady: false, inputState: 'not-requested' });

    await expect(engine.getInputStream()).rejects.toThrow('Permission denied');
    expect(engine.getUiStatus()).toMatchObject({
      ready: true,
      inputReady: false,
      inputState: 'error',
      lastError: '',
    });
    expect(engine.getUiStatus().inputError).toContain('Permission denied');
  });
});
