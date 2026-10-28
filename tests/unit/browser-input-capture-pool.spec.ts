import { describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import type { InputCaptureSession } from '../../src/audio/AudioEngineInterface';

function makeEngine(sessionId = 9, inputGeneration = 4) {
  const session = {
    node: { port: { postMessage: vi.fn() } } as unknown as AudioWorkletNode,
    trackIndex: 0,
    sessionId,
    inputGeneration,
    startFrame: 0,
  } satisfies InputCaptureSession;
  const engine = Object.create(BrowserAudioEngine.prototype) as any;
  engine.inputCaptureGeneration = inputGeneration;
  engine.inputCaptureSessions = new Map([[0, { session, listener: vi.fn(), retiring: true }]]);
  engine.inputCaptureSlotWaiters = new Map();
  engine.inputCaptureReadyWaiters = new Map();
  engine.inputCaptureRewarmWaiters = new Set();
  engine.inputCaptureNode = { port: { postMessage: vi.fn() } };
  engine.inputCaptureReady = false;
  engine.inputCaptureReadyGeneration = 0;
  engine.inputCaptureReadyEpoch = null;
  engine.inputCaptureWarmupReason = '';
  engine.inputCaptureUnavailableReason = '';
  engine.context = { sampleRate: 48_000 };
  engine.emitStatus = vi.fn();
  engine.recordInputCaptureError = vi.fn();
  return { engine, session };
}

describe('Browser shared capture pool lifecycle', () => {
  it('waits for the exact retiring session and generation ACK', async () => {
    const { engine, session } = makeEngine();
    const waiting = engine.waitForInputCaptureSlot(0);
    engine.handleInputCaptureMessage({
      type: 'CAPTURE_POOL_RELEASED', trackIndex: 0, sessionId: session.sessionId + 1,
      inputGeneration: session.inputGeneration,
    });
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    engine.handleInputCaptureMessage({
      type: 'CAPTURE_POOL_RELEASED', trackIndex: 0, sessionId: session.sessionId,
      inputGeneration: session.inputGeneration,
    });
    await expect(waiting).resolves.toBeUndefined();
    expect(engine.inputCaptureSessions.has(0)).toBe(false);
  });

  it('cancels an in-flight slot wait when the input generation changes', async () => {
    const { engine, session } = makeEngine();
    const waiting = engine.waitForInputCaptureSlot(0);
    engine.postInputCaptureReady(false);
    await expect(waiting).rejects.toThrow(/input generation changed/i);

    // A late ACK for the old pool cleans up only its matching old lease. A
    // new waiter from the new generation must reject that stale generation.
    const newWait = engine.waitForInputCaptureSlot(0);
    engine.handleInputCaptureMessage({
      type: 'CAPTURE_POOL_RELEASED', trackIndex: 0, sessionId: session.sessionId,
      inputGeneration: session.inputGeneration,
    });
    await expect(newWait).rejects.toThrow(/input device changed/i);
    expect(engine.inputCaptureSessions.has(0)).toBe(false);
  });

  it('dispatches an early rejected START error once without retiring an unowned pool', () => {
    const { engine, session } = makeEngine();
    const record = engine.inputCaptureSessions.get(0);
    record.retiring = false;
    record.listener.mockImplementation(() => engine.releaseInputCaptureSession(session));
    engine.handleInputCaptureMessage({
      type: 'CAPTURE_ERROR', trackIndex: 0, sessionId: session.sessionId,
      inputGeneration: session.inputGeneration, reason: 'request-frame-outside-preroll',
      startRejected: true,
    });

    expect(engine.recordInputCaptureError).toHaveBeenCalledOnce();
    expect(record.listener).toHaveBeenCalledOnce();
    expect(record.retiring).toBe(false);
    expect(engine.inputCaptureSessions.has(0)).toBe(false);
  });
});
