import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { TrackState } from '../../src/core/types';
import { Transport } from '../../src/core/Transport';
import { createMockAudioContext } from '../helpers/audioTestUtils';

beforeEach(() => { Transport.getInstance().stop(); Transport.getInstance().resetMasterTrack(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function harness() {
  const context = createMockAudioContext();
  const engine = new BrowserAudioEngine({ context, loadDevicePreferences: false, deferTransportBpmChangeSubscription: true });
  engine.setBrowserAutoRecSettings({ enabled: true, sensitivity: 50 });
  vi.spyOn(engine, 'getInputCaptureRequestFrame').mockReturnValue(128);
  // AutoRec starts only after the shared capture worklet confirms that its
  // current input generation is ready. Keep this unit harness on that ready
  // path; individual unavailable-input cases override the request frame below.
  vi.spyOn(engine, 'waitForInputCaptureReady').mockResolvedValue();
  vi.spyOn(engine, 'getProcessedInputNode').mockResolvedValue(context.createGain());
  let listener: (message: unknown) => void = () => {};
  const node = { port: { postMessage: vi.fn() } } as unknown as AudioWorkletNode;
  vi.spyOn(engine, 'beginInputCaptureSession').mockImplementation((trackIndex, startFrame, callback) => {
    listener = callback; return { node, trackIndex, startFrame, sessionId: 1, inputGeneration: 1 };
  });
  const abort = vi.spyOn(engine, 'abortInputCaptureSession').mockImplementation(() => {});
  const release = vi.spyOn(engine, 'releaseInputCaptureSession').mockImplementation(() => {});
  return { engine, track: engine.tracks[0]!, abort, release, send: (message: object) => listener({ sessionId: 1, inputGeneration: 1, ...message }) };
}
describe('Browser AutoRec track lifecycle', () => {
  it('arms without recording and changes state only on renderer trigger acknowledgement', async () => {
    const h = harness(); await h.track.startRecording();
    expect(h.track.autoRecArmed).toBe(true); expect(h.track.state).toBe(TrackState.REC_STANDBY);
    expect(h.track.historyBusy).toBe(true);
    expect(h.engine.beginInputCaptureSession).toHaveBeenCalledWith(0, 128, expect.any(Function), undefined, expect.any(Number), undefined);
    h.send({ type: 'RECORD_CONFIGURED', channelCount: 2, maxRecordingFrames: 100, maxRecordingBytes: 800 });
    expect(h.track.autoRecArmed).toBe(false); expect(h.track.state).toBe(TrackState.RECORDING);
    h.track.triggerStop();
  });
  it.each(['stop', 'clear', 'cancel', 'disconnect'] as const)('cancels an arm on %s and ignores late trigger messages', async action => {
    const h = harness(); await h.track.startRecording();
    if (action === 'stop') h.track.triggerStop();
    if (action === 'clear') h.track.clear();
    if (action === 'cancel') h.track.triggerRecord();
    if (action === 'disconnect') h.track.handleInputUnavailable('disconnected');
    expect(h.abort).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
    expect(h.track.autoRecArmed).toBe(false); expect(h.track.historyBusy).toBe(false);
    h.send({ type: 'RECORD_CONFIGURED', channelCount: 2, maxRecordingFrames: 100, maxRecordingBytes: 800 });
    expect(h.track.state).not.toBe(TrackState.RECORDING);
  });
  it('fails closed when capture is unavailable instead of falling back to immediate recording', async () => {
    const h = harness(); vi.mocked(h.engine.getInputCaptureRequestFrame).mockReturnValue(null);
    await h.track.startRecording();
    expect(h.engine.beginInputCaptureSession).not.toHaveBeenCalled(); expect(h.track.state).toBe(TrackState.EMPTY);
    expect(h.track.recordingDiagnostic).toMatch(/ready shared input/);
  });
});


describe('Browser AutoRec fail-closed boundaries', () => {
  it.each(['stop', 'cancel', 'disconnect'] as const)('retains incumbent stereo PCM identity on %s while armed', async action => {
    const h = harness(); h.engine.setRecordPlaySettings({ quantize: 'OFF' });
    const pcm = h.engine.context.createBuffer(2, 4, h.engine.context.sampleRate);
    pcm.getChannelData(0).fill(0.25); pcm.getChannelData(1).fill(-0.5);
    (h.track as any).audioBuffer = pcm; h.track.state = TrackState.STOPPED;
    await h.track.startRecording();
    if (action === 'stop') h.track.triggerStop();
    if (action === 'cancel') h.track.triggerRecord();
    if (action === 'disconnect') h.track.handleInputUnavailable('disconnected');
    expect(h.track.getRecoverySnapshot().buffer).toBe(pcm);
    expect(Array.from(pcm.getChannelData(1))).toEqual([-0.5, -0.5, -0.5, -0.5]);
  });
  it('rejects measure-quantized AutoRec before creating a capture session and leaves existing loops alone', async () => {
    const h = harness(); const transport = Transport.getInstance();
    h.track.track.loopSyncSw = 'ON';
    transport.masterTrackId = 2; transport.masterLoopLengthSamples = 176400;
    h.engine.tracks[1]!.track.loopSyncSw = 'ON';
    h.track.triggerRecord(); await Promise.resolve();
    expect(h.engine.beginInputCaptureSession).not.toHaveBeenCalled();
    expect(h.track.state).toBe(TrackState.EMPTY); expect(h.track.recordingDiagnostic).toMatch(/QUANTIZE OFF/);
  });
  it('allows AutoRec when LOOP SYNC is off even if a master track exists', async () => {
    const h = harness(); const transport = Transport.getInstance();
    transport.masterTrackId = 2; transport.masterLoopLengthSamples = 176400;
    await h.track.startRecording();
    expect(h.track.autoRecArmed).toBe(true);
    expect(h.track.state).toBe(TrackState.REC_STANDBY);
    h.track.triggerStop();
  });
  it('blocks semantic Memory replacement while armed and allows it after cancellation', async () => {
    const h = harness(); await h.track.startRecording();
    const runtime = h.engine.createRc505MemoryRuntime();
    expect(runtime.canSwitch().allowed).toBe(false);
    await expect(runtime.capture()).rejects.toThrow();
    h.track.triggerStop(); expect(runtime.canSwitch().allowed).toBe(true);
  });
});
