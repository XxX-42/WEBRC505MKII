import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';

// Exercise the production request/ACK state machine with real message objects;
// the two audio renderers themselves have separate PCM worklet tests.
function engineHarness() {
  const engine = Object.create(BrowserAudioEngine.prototype) as any;
  Object.assign(engine, {
    context: { state: 'running' }, selectedBufferFrames: 128,
    trackFxApplyWaiters: new Map(), trackFxApplyQueues: new Map(),
    trackFxApplyRequested: Array(5).fill(true), trackFxApplyApplied: Array(5).fill(true),
    trackFxApplyInputValue: Array(5).fill(true), trackFxApplyTrackValue: Array(5).fill(true),
    trackFxApplyRequestedRevision: Array(5).fill(0), trackFxApplyInputRevision: Array(5).fill(0),
    trackFxApplyTrackRevision: Array(5).fill(0), trackFxApplySemanticRevision: Array(5).fill(0),
    trackFxApplyFaulted: Array(5).fill(false), trackFxApplyErrors: Array(5).fill(''),
    tracks: Array.from({ length: 5 }, () => ({ getPostFaderPreSharedTrackFxMeter: () => ({ peak: 0, rms: 0 }) })),
    inputCaptureNode: { port: { postMessage: vi.fn() } },
    trackFxRouterNode: { port: { postMessage: vi.fn() } },
    inputCaptureReady: true, inputCaptureReadyGeneration: 1, inputCaptureGeneration: 1,
    hasLiveInputStream: () => true, getInputCaptureRequestFrame: () => 1000, emitStatus: vi.fn(),
  });
  const ack = (route: string, overrides = {}) => engine.handleTrackFxApplyAcknowledgement({
    type: 'TRACK_FX_APPLY_ACK', route, trackIndex: 0, revision: 1, enabled: false,
    requestedFrame: 1512, appliedFrame: 1512, ok: true, ...overrides,
  });
  return { engine, ack };
}

afterEach(() => vi.useRealTimers());

describe('Browser dual-route Track FX render acknowledgement', () => {
  it('keeps the old applied value until both exact-frame ACKs and returns OFF as false', async () => {
    const { engine, ack } = engineHarness();
    const pending = engine.setTrackFxApply(1, false);
    await Promise.resolve();
    ack('input');
    expect(engine.getTrackFxApply(1)[0]).toMatchObject({ applied: true, pending: true, inputAppliedRevision: 1, trackAppliedRevision: 0 });
    ack('track');
    await expect(pending).resolves.toMatchObject({ applied: false, pending: false, inputAppliedRevision: 1, trackAppliedRevision: 1 });
    expect(engine.inputCaptureNode.port.postMessage).toHaveBeenCalledOnce();
    expect(engine.trackFxRouterNode.port.postMessage).toHaveBeenCalledOnce();
  });

  it('rejects a missed frame without reporting the requested gate as applied', async () => {
    const { engine, ack } = engineHarness();
    const pending = engine.setTrackFxApply(1, false);
    await Promise.resolve();
    ack('input');
    ack('track', { ok: false, appliedFrame: 1640, reason: 'track-fx-apply-frame-missed' });
    await expect(pending).rejects.toThrow(/frame-missed/);
    expect(engine.getTrackFxApply(1)[0]).toMatchObject({ applied: true, controlFaulted: true });
  });

  it('times out one missing ACK and never resends either command', async () => {
    vi.useFakeTimers();
    const { engine, ack } = engineHarness();
    const pending = engine.setTrackFxApply(1, false);
    const rejection = expect(pending).rejects.toThrow(/outcome is unknown/);
    await Promise.resolve();
    ack('input');
    await vi.advanceTimersByTimeAsync(1500);
    await rejection;
    expect(engine.inputCaptureNode.port.postMessage).toHaveBeenCalledOnce();
    expect(engine.trackFxRouterNode.port.postMessage).toHaveBeenCalledOnce();
  });
});
