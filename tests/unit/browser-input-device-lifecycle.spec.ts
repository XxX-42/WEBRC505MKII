import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { TrackAudio } from '../../src/audio/TrackAudio';
import { Track, TrackState } from '../../src/core/types';

class FakeTrack {
  readyState: MediaStreamTrackState = 'live';
  readonly kind = 'audio';
  muted = false;
  enabled = true;
  readonly stop = vi.fn(() => { this.readyState = 'ended'; });
  private readonly listeners = new Set<EventListener>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type !== 'ended' || !listener) return;
    this.listeners.add(typeof listener === 'function' ? listener : (event) => listener.handleEvent(event));
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type !== 'ended' || !listener) return;
    for (const registered of this.listeners) {
      if (registered === listener) this.listeners.delete(registered);
    }
  }

  queueEndedCallback(): () => void {
    const queued = [...this.listeners];
    return () => {
      this.readyState = 'ended';
      for (const listener of queued) listener(new Event('ended'));
    };
  }

  end(): void {
    this.readyState = 'ended';
    for (const listener of [...this.listeners]) listener(new Event('ended'));
  }

  get listenerCount(): number { return this.listeners.size; }
  asMediaTrack(): MediaStreamTrack { return this as unknown as MediaStreamTrack; }
}

function makeStream() {
  const audioTrack = new FakeTrack();
  const stream = {
    getTracks: () => [audioTrack.asMediaTrack()],
    getAudioTracks: () => [audioTrack.asMediaTrack()],
  } as unknown as MediaStream;
  return { audioTrack, stream };
}

class FakeWorkletPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<Record<string, unknown>> = [];
  static autoAcknowledgeReady = true;
  private captureReadyEpoch = 0;
  private captureReady = false;

  postMessage(message: Record<string, unknown>): void {
    this.messages.push({ ...message });
    if (message.type === 'INPUT_READY') {
      this.captureReadyEpoch = 0;
      this.captureReady = false;
    }
    if (message.type === 'INPUT_READY' && message.ready === true && FakeWorkletPort.autoAcknowledgeReady) {
      this.acknowledgeReady(message.generation);
    }
    if (message.type === 'CHECK_CAPTURE_READINESS') {
      this.notify({
        type: 'CAPTURE_READINESS_STATE', inputGeneration: message.inputGeneration,
        captureReadyEpoch: this.captureReadyEpoch, ready: this.captureReady,
        oldestAvailableFrame: 0, latestAvailableFrame: this.captureReady ? 8_192 : 256,
        preRollValidFrames: this.captureReady ? 8_192 : 256, requiredPreRollFrames: 8_192,
      });
    }
  }

  acknowledgeReady(generation: unknown, captureReadyEpoch = this.captureReadyEpoch): void {
    if (typeof generation !== 'number') return;
    this.captureReadyEpoch = captureReadyEpoch;
    this.captureReady = true;
    queueMicrotask(() => this.onmessage?.({
        data: {
          type: 'INPUT_CAPTURE_READY',
          inputGeneration: generation,
          captureReadyEpoch,
          sampleRate: 44_100,
          oldestAvailableFrame: 0,
          latestAvailableFrame: 8_192,
          preRollValidFrames: 8_192,
          preRollCapacityFrames: 8_192,
          requiredPreRollFrames: 8_192,
        },
      } as MessageEvent));
  }

  notify(message: Record<string, unknown>): void {
    if (message.type === 'INPUT_CAPTURE_NOT_READY') {
      if (typeof message.captureReadyEpoch === 'number') this.captureReadyEpoch = message.captureReadyEpoch;
      this.captureReady = false;
    }
    queueMicrotask(() => this.onmessage?.({ data: message } as MessageEvent));
  }

  close(): void {}
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port = new FakeWorkletPort();
  onprocessorerror: (() => void) | null = null;
  disconnected = false;

  constructor(_context: AudioContext, _name: string, _options?: AudioWorkletNodeOptions) {
    FakeAudioWorkletNode.instances.push(this);
  }
  connect(_target?: unknown): void {}
  disconnect(): void { this.disconnected = true; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Browser input device lifecycle', () => {
  afterEach(() => {
    localStorage.clear();
    FakeWorkletPort.autoAcknowledgeReady = true;
    FakeAudioWorkletNode.instances = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the newest successful device when getUserMedia requests resolve out of order', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const olderPermission = deferred<MediaStream>();
    const newerPermission = deferred<MediaStream>();
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockImplementationOnce(() => olderPermission.promise)
      .mockImplementationOnce(() => newerPermission.promise);
    const engine = new BrowserAudioEngine();

    const olderRequest = engine.setInputDevice('mic-older');
    const newerRequest = engine.setInputDevice('mic-newer');
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    const newer = makeStream();
    newerPermission.resolve(newer.stream);
    await expect(newerRequest).resolves.toBeUndefined();

    const older = makeStream();
    olderPermission.resolve(older.stream);
    await expect(olderRequest).resolves.toBeUndefined();

    expect((engine as unknown as { currentMediaStream: MediaStream }).currentMediaStream).toBe(newer.stream);
    expect(engine.selectedInputDeviceId).toBe('mic-newer');
    expect(engine.getUiStatus()).toMatchObject({ inputReady: true, inputState: 'ready', inputError: '' });
    expect(older.audioTrack.stop).toHaveBeenCalledOnce();
    expect(newer.audioTrack.stop).not.toHaveBeenCalled();
  });

  it('withdraws exact-frame capture readiness while the shared ring rewarms after a timeline reset', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const input = makeStream();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(input.stream);
    const engine = new BrowserAudioEngine();
    await engine.setInputDevice('mic-warmup');

    expect(engine.getUiStatus()).toMatchObject({ inputReady: true, inputCaptureReady: true, inputCaptureWarming: false });
    expect(engine.getInputCaptureRequestFrame()).not.toBeNull();

    const node = FakeAudioWorkletNode.instances[0]!;
    const ready = node.port.messages.find((message) => message.type === 'INPUT_READY' && message.ready === true)!;
    node.port.notify({
      type: 'INPUT_CAPTURE_NOT_READY', inputGeneration: ready.generation, captureReadyEpoch: 1, sampleRate: 44_100,
      reason: 'input-frame-discontinuity', frameStart: 12_000,
      oldestAvailableFrame: 4_000, latestAvailableFrame: 12_000,
      preRollValidFrames: 8_000, preRollCapacityFrames: 8_192, requiredPreRollFrames: 8_192,
    });
    await Promise.resolve();

    expect(engine.getUiStatus()).toMatchObject({
      inputReady: true, inputCaptureReady: false, inputCaptureWarming: true,
      inputCaptureWarmupReason: expect.stringContaining('input-frame-discontinuity'),
    });
    expect(engine.getInputCaptureRequestFrame()).toBeNull();

    const rewarm = engine.waitForInputCaptureReady();
    await Promise.resolve();
    expect(engine.getUiStatus()).toMatchObject({ inputCaptureReady: false, inputCaptureWarming: true });
    node.port.acknowledgeReady(ready.generation, 1);
    await rewarm;
    expect(engine.getUiStatus()).toMatchObject({ inputCaptureReady: true, inputCaptureWarming: false });
    expect(engine.getInputCaptureRequestFrame()).not.toBeNull();
  });

  it('saves main-thread state and callback metadata for a shared capture error', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const input = makeStream();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(input.stream);
    const engine = new BrowserAudioEngine();
    await engine.setInputDevice('mic-diagnostics');

    const node = FakeAudioWorkletNode.instances[0]!;
    const ready = node.port.messages.find((message) => message.type === 'INPUT_READY' && message.ready === true)!;
    const listener = vi.fn();
    const session = engine.beginInputCaptureSession(2, 18_560, listener);
    expect(session).not.toBeNull();
    node.port.notify({
      type: 'CAPTURE_ERROR', trackIndex: 2, sessionId: session!.sessionId,
      inputGeneration: session!.inputGeneration, reason: 'input-frame-discontinuity',
      requestedStartFrame: 18_560, stopFrame: 0, startReceivedFrame: 18_560,
      oldestAvailableFrame: 10_368, latestAvailableFrame: 18_560,
      callbackFrameStart: 18_688, callbackFrameCount: 128, previousCallbackEndFrame: 18_560,
      preRollEndAtCallbackStart: 18_560, preRollCapacityFrames: 8_192, preRollValidFrames: 8_192,
      inputReady: true, currentInputGeneration: ready.generation, captureReadyEpoch: 0, sampleRate: 44_100,
    });

    await vi.waitFor(() => expect(engine.getUiStatus().lastInputCaptureError).not.toBeNull());
    const diagnostic = engine.getUiStatus().lastInputCaptureError!;
    expect(diagnostic).toMatchObject({
      reason: 'input-frame-discontinuity', trackIndex: 2, sessionId: session!.sessionId,
      inputGeneration: session!.inputGeneration,
      worklet: {
        requestedStartFrame: 18_560, callbackFrameStart: 18_688, callbackFrameCount: 128,
        previousCallbackEndFrame: 18_560, callbackGapFrames: 128,
        preRollEndAtCallbackStart: 18_560, preRollValidFrames: 8_192,
      },
      audioContext: { state: engine.context.state, sampleRate: engine.context.sampleRate },
      input: {
        state: 'ready', deviceSelected: true, captureReady: true,
        tracks: [{ kind: 'audio', readyState: 'live', muted: false, enabled: true }],
      },
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('does not let an older late stream or error overwrite the newest failed request', async () => {
    const olderPermission = deferred<MediaStream>();
    const newerPermission = deferred<MediaStream>();
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockImplementationOnce(() => olderPermission.promise)
      .mockImplementationOnce(() => newerPermission.promise);
    const engine = new BrowserAudioEngine();

    const olderRequest = engine.setInputDevice('mic-older');
    const newerRequest = engine.setInputDevice('mic-newer');
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    newerPermission.reject(new DOMException('Permission denied', 'NotAllowedError'));
    await expect(newerRequest).rejects.toThrow('Permission denied');

    const older = makeStream();
    olderPermission.resolve(older.stream);
    await expect(olderRequest).resolves.toBeUndefined();

    expect((engine as unknown as { currentMediaStream: MediaStream | null }).currentMediaStream).toBeNull();
    expect(engine.selectedInputDeviceId).toBeNull();
    expect(engine.getUiStatus()).toMatchObject({ inputReady: false, inputState: 'error' });
    expect(engine.getUiStatus().inputError).toContain('Permission denied');
    expect(older.audioTrack.stop).toHaveBeenCalledOnce();
  });

  it('does not start a default-device fallback for an obsolete request failure', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const olderPermission = deferred<MediaStream>();
    const newerPermission = deferred<MediaStream>();
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockImplementationOnce(() => olderPermission.promise)
      .mockImplementationOnce(() => newerPermission.promise);
    const engine = new BrowserAudioEngine();

    const olderRequest = engine.setInputDevice('mic-older');
    const newerRequest = engine.setInputDevice('mic-newer');
    olderPermission.reject(new DOMException('Device is unavailable', 'NotFoundError'));
    await expect(olderRequest).resolves.toBeUndefined();
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    const newer = makeStream();
    newerPermission.resolve(newer.stream);
    await expect(newerRequest).resolves.toBeUndefined();
    expect(engine.selectedInputDeviceId).toBe('mic-newer');
    expect(engine.getUiStatus()).toMatchObject({ inputReady: true, inputState: 'ready' });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('keeps a previously committed live input when a newer permission request fails during its warm-up', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    FakeWorkletPort.autoAcknowledgeReady = false;
    const olderPermission = deferred<MediaStream>();
    const newerPermission = deferred<MediaStream>();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockImplementationOnce(() => olderPermission.promise)
      .mockImplementationOnce(() => newerPermission.promise);
    const engine = new BrowserAudioEngine();
    const older = makeStream();

    const olderRequest = engine.setInputDevice('mic-older');
    olderPermission.resolve(older.stream);
    for (let attempt = 0; attempt < 50 && FakeAudioWorkletNode.instances.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    const captureNode = FakeAudioWorkletNode.instances[0];
    expect(captureNode).toBeDefined();
    const ready = captureNode!.port.messages.find((message) => message.type === 'INPUT_READY' && message.ready === true);
    expect(ready).toBeDefined();

    const newerRequest = engine.setInputDevice('mic-newer');
    newerPermission.reject(new DOMException('Permission denied', 'NotAllowedError'));
    await expect(newerRequest).rejects.toThrow('Permission denied');
    captureNode!.port.acknowledgeReady(ready!.generation);
    await expect(olderRequest).resolves.toBeUndefined();

    expect((engine as unknown as { currentMediaStream: MediaStream }).currentMediaStream).toBe(older.stream);
    expect(engine.selectedInputDeviceId).toBe('mic-older');
    expect(engine.getUiStatus()).toMatchObject({ inputReady: true, inputState: 'ready' });
    expect(engine.getUiStatus().inputError).toContain('Permission denied');
    expect(older.audioTrack.stop).not.toHaveBeenCalled();
  });

  it('ignores a queued ended callback from a retired stream and removes its listener before stopping it', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const old = makeStream();
    const next = makeStream();
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockResolvedValueOnce(old.stream)
      .mockResolvedValueOnce(next.stream);
    const engine = new BrowserAudioEngine();
    await engine.setInputDevice('mic-old');
    const queuedEnded = old.audioTrack.queueEndedCallback();

    await engine.setInputDevice('mic-new');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(old.audioTrack.listenerCount).toBe(0);
    expect(old.audioTrack.stop).toHaveBeenCalledOnce();

    queuedEnded();
    expect((engine as unknown as { currentMediaStream: MediaStream }).currentMediaStream).toBe(next.stream);
    expect(next.audioTrack.stop).not.toHaveBeenCalled();
    expect(engine.selectedInputDeviceId).toBe('mic-new');
    expect(engine.getUiStatus()).toMatchObject({ inputReady: true, inputState: 'ready', inputError: '' });
  });

  it('aborts a live recording on active-track end and preserves the prior PCM', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const input = makeStream();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(input.stream);
    const engine = new BrowserAudioEngine();
    await engine.setInputDevice('mic-live');

    const track = engine.tracks[0]!;
    const previous = engine.context.createBuffer(1, 8, engine.context.sampleRate);
    previous.getChannelData(0).fill(0.25);
    (track as unknown as { audioBuffer: AudioBuffer }).audioBuffer = previous;
    track.state = TrackState.STOPPED;
    await track.startRecording();
    expect(track.state).toBe(TrackState.RECORDING);

    input.audioTrack.end();

    expect(track.state).toBe(TrackState.STOPPED);
    expect((track as unknown as { audioBuffer: AudioBuffer }).audioBuffer).toBe(previous);
    expect(previous.getChannelData(0)).toEqual(new Float32Array(8).fill(0.25));
    expect(track.recordingDiagnostic).toContain('input-device-ended');
    expect(engine.getUiStatus()).toMatchObject({ inputReady: false, inputState: 'error' });
    expect(engine.getUiStatus().inputError).toContain('ended or disconnected');
  });

  it('aborts the legacy recorder on active-track end when shared capture is unavailable', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const input = makeStream();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(input.stream);
    const engine = new BrowserAudioEngine();
    await engine.setInputDevice('mic-live');
    (engine as unknown as { inputCaptureReady: boolean }).inputCaptureReady = false;

    const track = engine.tracks[0]!;
    const previous = engine.context.createBuffer(1, 8, engine.context.sampleRate);
    previous.getChannelData(0).fill(0.125);
    (track as unknown as { audioBuffer: AudioBuffer }).audioBuffer = previous;
    track.state = TrackState.STOPPED;
    await track.startRecording();
    expect(track.state).toBe(TrackState.RECORDING);

    input.audioTrack.end();

    expect(track.state).toBe(TrackState.STOPPED);
    expect((track as unknown as { audioBuffer: AudioBuffer }).audioBuffer).toBe(previous);
    expect(previous.getChannelData(0)).toEqual(new Float32Array(8).fill(0.125));
    expect(track.recordingDiagnostic).toContain('previous loop was kept');
  });

  it('rolls an active overdub back to its pre-overdub PCM when input disappears', () => {
    const engine = new BrowserAudioEngine();
    const track = engine.tracks[0]!;
    const current = engine.context.createBuffer(1, 8, engine.context.sampleRate);
    current.getChannelData(0).fill(0.9);
    (track as unknown as { audioBuffer: AudioBuffer }).audioBuffer = current;
    (track as unknown as { prepareOverdubStopRollback: (buffer: AudioBuffer) => void }).prepareOverdubStopRollback(current);
    const historyBuffer = engine.context.createBuffer(1, 8, engine.context.sampleRate);
    const previousHistory = {
      snapshot: { buffer: historyBuffer, isReverse: false, master: null },
      direction: 'undo' as const,
    };
    (track as unknown as { pcmHistory: typeof previousHistory }).pcmHistory = previousHistory;
    const worklet = new FakeAudioWorkletNode(engine.context, 'rc505-overdub-processor');
    (track as unknown as { overdubProcessor: AudioWorkletNode }).overdubProcessor = worklet as unknown as AudioWorkletNode;
    (track as unknown as { overdubSessionAudioBuffer: AudioBuffer }).overdubSessionAudioBuffer = current;
    (track as unknown as { overdubHasEdited: boolean }).overdubHasEdited = true;
    current.getChannelData(0)[0] = 0.1;
    track.state = TrackState.OVERDUBBING;
    (track as unknown as { watchOverdubDrain: (node: AudioWorkletNode) => void }).watchOverdubDrain = vi.fn();

    track.handleInputUnavailable('The selected input device ended or disconnected.');

    expect(current.getChannelData(0)).toEqual(new Float32Array(8).fill(0.9));
    expect(track.state).toBe(TrackState.PLAYING);
    expect((track as unknown as { pcmHistory: typeof previousHistory }).pcmHistory).toBe(previousHistory);
    expect(worklet.port.messages.some((message) => message.type === 'OVERDUB_STOP')).toBe(true);
    expect(track.overdubDiagnostic).toContain('complete PCM edit was rolled back');
  });

  it('reports an input that ends while its first shared-capture warm-up is still pending', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    FakeWorkletPort.autoAcknowledgeReady = false;
    const input = makeStream();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(input.stream);
    const engine = new BrowserAudioEngine();
    const inputRequest = engine.setInputDevice('mic-short-lived');
    for (let attempt = 0; attempt < 50 && FakeAudioWorkletNode.instances.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(FakeAudioWorkletNode.instances).toHaveLength(1);

    input.audioTrack.end();
    await expect(inputRequest).resolves.toBeUndefined();

    expect(engine.getUiStatus()).toMatchObject({ inputReady: false, inputState: 'error' });
    expect(engine.getUiStatus().inputError).toContain('ended or disconnected');
    expect((engine as unknown as { currentMediaStream: MediaStream | null }).currentMediaStream).toBeNull();
  });
});
