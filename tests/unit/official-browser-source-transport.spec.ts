import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserWorkletFX } from '../../src/audio/fx/BrowserWorkletFX';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { translateBrowserOfficialSourceParameters as translate } from '../../src/audio/fx/dsp/OfficialBrowserSourceParameters';
import { BROWSER_OFFICIAL_PARAMETER_KEYS } from '../../src/audio/fx/dsp/OfficialBrowserParameters';

class Node {
  connect = vi.fn(); disconnect = vi.fn();
  gain = { value: 1, setTargetAtTime: vi.fn() };
}
class Worklet {
  static instances: Worklet[] = [];
  port = { postMessage: vi.fn(), onmessage: null }; connect = vi.fn(); disconnect = vi.fn();
  constructor(_context: unknown, _name: string, readonly options: AudioWorkletNodeOptions) { Worklet.instances.push(this); }
}
function setup() {
  vi.stubGlobal('AudioWorkletNode', Worklet);
  const context = { sampleRate: 48000, currentTime: 0, audioWorklet: { addModule: vi.fn(async () => undefined) }, createGain: () => new Node() } as unknown as AudioContext;
  const tracks = Array.from({ length: 5 }, (_, i) => ({ track: { id: i + 1 }, configurations: [] as unknown[], configureLoopTransportFx: vi.fn(), loopTransportActive: false, loopTransportUnavailableReason: null }));
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  Object.assign(engine, { context, tracks, trackMixNode: new Node(), inputFxChain: { input: new Node(), output: new Node() }, outputFxChain: { input: new Node(), output: new Node() }, inputFxInstances: [null,null,null,null], trackFxInstances: [null,null,null,null], inputFxTypes: [null,null,null,null], trackFxTypes: [null,null,null,null], inputFxActive: [false,false,false,false], trackFxActive: [false,false,false,false], fxWorkletModuleReady: null, fxWorkletGeneration: 0, statusListeners: new Set(), lastError: '' });
  return { context, engine, tracks };
}
afterEach(() => { vi.unstubAllGlobals(); Worklet.instances = []; });
describe('Official source-only transport, never causal history approximations', () => {
  it('covers exactly the documented source controls', () => {
    expect(BROWSER_OFFICIAL_PARAMETER_KEYS['beat-shift']).toEqual(['official_type','official_shift']);
    expect(BROWSER_OFFICIAL_PARAMETER_KEYS['vinyl-flick']).toEqual(['official_flick']);
  });
  it('keeps legacy snapshots verbatim and translates FUTURE / PAST / THRU in beats', () => {
    const legacy = { beatShiftOffsetBeats: -0.5 }; expect(translate('beat-shift', legacy)).toBe(legacy);
    expect(translate('beat-shift', { official_type: 0 })).toMatchObject({ beatShiftOffsetBeats: 1 });
    expect(translate('beat-shift', { official_type: 1, official_shift: -4, quarterNotesPerMeasure: 3 })).toMatchObject({ beatShiftOffsetBeats: -4 });
    expect(translate('beat-shift', { official_type: 0, official_shift: -1000 })).toMatchObject({ beatShiftOffsetBeats: 0 });
  });
  it.each([0,50,100])('FLICK%s becomes real source rate target with full transported output', flick => {
    expect(translate('vinyl-flick', { official_flick: flick, mix: 0.2 })).toMatchObject({ vinylFlickSpeed: 2*flick-100, mix: 1, vinylFlickMixPercent: 100 });
  });
  it.each(['beat-shift','vinyl-flick'] as const)('%s refuses source-only keys in bare DSP', algorithm => {
    const values = algorithm === 'beat-shift' ? { official_shift: -1 } : { official_flick: 50 };
    expect(() => new BrowserFxDspCore(algorithm, 48000, values)).toThrow(/source-aware/);
    expect(() => new BrowserFxDspCore(algorithm).setParameters(values)).toThrow(/source-aware/);
  });
  it('bare adapters reject source knobs, source-bound adapters retain defaults but never send knobs to causal core', async () => {
    const { context } = setup();
    const bare = new BrowserWorkletFX(context, 'BEAT SHIFT', async () => undefined);
    await bare.ready; bare.setParam('official_shift', -1);
    expect(bare.error).toContain('source-aware'); expect(bare.getParameterSnapshot()).not.toHaveProperty('official_shift');
    const fx = new BrowserWorkletFX(context, 'BEAT SHIFT', async () => undefined, undefined, { official_type: 1 }, { sourceAwareLoopTransport: true });
    await fx.ready; fx.setParam('official_shift', -4); fx.setAmount(0.8); fx.setBypass(false);
    expect(fx.getParameterSnapshot()).toMatchObject({ official_type: 1, official_shift: -4 });
    const node = Worklet.instances.at(-1)!;
    expect(Object.keys(node.options.processorOptions!.parameters).some(k => k.startsWith('official_'))).toBe(false);
    for (const [message] of node.port.postMessage.mock.calls) {
      if (message.type === 'configure') expect(Object.keys(message.parameters).some(k => k.startsWith('official_'))).toBe(false);
      if (message.type === 'set-bypass') expect(message.value).toBe(true);
    }
  });
  it('routes shared Track A official phase and speed to all real loop configurations and preserves macro priority', async () => {
    const { engine, tracks } = setup();
    engine.setFxType('track', 0, 'BEAT SHIFT');
    engine.setFxNamedParameters('track', 0, { official_type: 1, official_shift: -4 });
    engine.setFxActive('track', 0, true);
    await vi.waitFor(() => expect(Worklet.instances).toHaveLength(1));
    for (const track of tracks) expect(track.configureLoopTransportFx.mock.calls.filter(call => call[0] === 0).at(-1)).toEqual([0, 'BEAT SHIFT', expect.objectContaining({ beatShiftOffsetBeats: -4 })]);
    engine.setFxType('track', 0, 'VINYL FLICK');
    engine.setFxNamedParameters('track', 0, { official_flick: 100 }); engine.setFxActive('track', 0, true);
    engine.setFxParam('track', 0, 0);
    for (const track of tracks) expect(track.configureLoopTransportFx.mock.calls.filter(call => call[0] === 0).at(-1)).toEqual([0, 'VINYL FLICK', expect.objectContaining({ vinylFlickSpeed: 100, mix: 1 })]);
  });
  it('rejects invented source values atomically', () => {
    expect(() => translate('beat-shift', { official_shift: -3.14159 })).toThrow();
    expect(() => translate('vinyl-flick', { official_flick: 101 })).toThrow();
    expect(() => translate('beat-shift', { official_type: 2 })).toThrow();
  });
});

// Real TrackAudio integration (AudioBufferSource scheduling is observed, not a
// causal DSP substitute). Existing Browser E2E additionally measures its PCM.
async function makeRealTrack() {
  const [{ createMockAudioContext }, { TrackAudio }, { Track }, { Transport }] = await Promise.all([
    import('../helpers/audioTestUtils'), import('../../src/audio/TrackAudio'), import('../../src/core/types'), import('../../src/core/Transport'),
  ]);
  const context = createMockAudioContext();
  const sources: Array<{ buffer: AudioBuffer | null; loop: boolean; start: ReturnType<typeof vi.fn>; playbackRate: { value: number; curves: Float32Array[]; cancelScheduledValues: ReturnType<typeof vi.fn>; setValueAtTime: ReturnType<typeof vi.fn>; setValueCurveAtTime(values: Float32Array): void } }> = [];
  context.createBufferSource = (() => {
    const source = { buffer: null, loop: false, onended: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), playbackRate: { value: 1, curves: [] as Float32Array[], cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), setValueCurveAtTime(values: Float32Array) { this.curves.push(values.slice()); } } };
    sources.push(source); return source;
  }) as unknown as typeof context.createBufferSource;
  const engine = { context, trackMixNode: context.createGain(), roundTripLatency: 0, selectedInputDeviceId: null, selectedOutputDeviceId: null, selectedBufferFrames:128, getInputStream: async () => context.createGain(), getProcessedInputNode: async () => context.createGain(), checkAndResetMaster: vi.fn(), tracks: [] as unknown[] };
  const track = new TrackAudio(engine as never, new Track(1), 0, null, null); engine.tracks=[track];
  const buffer = context.createBuffer(1,context.sampleRate*2,context.sampleRate);
  buffer.getChannelData(0)[context.sampleRate/2]=.9; buffer.getChannelData(0)[3*context.sampleRate/2]=-.7;
  Object.assign(track,{audioBuffer:buffer,startOffset:0}); Transport.getInstance().setBpm(120);
  return { track, buffer, sources, stop: () => { track.stop(); Transport.getInstance().stop(); Object.assign(context, { state: 'closed' }); track.dispose(); } };
}
describe('Official controls reach stored-loop source readheads', () => {
  it.each([[0,.5,.9],[1,1.5,-.7]])('TYPE%s starts from actual stored FUTURE/PAST source PCM', async (type,offset,sample) => {
    const { track, buffer, sources, stop }=await makeRealTrack();
    expect(track.configureLoopTransportFx(0,'BEAT SHIFT',translate('beat-shift',{official_type:type,official_shift:-1}))).toBe(true);
    await track.play();
    expect(sources[0]?.buffer).toBe(buffer); expect(sources[0]?.loop).toBe(true);
    expect(sources[0]?.start).toHaveBeenCalledWith(0,offset);
    expect(buffer.getChannelData(0)[Math.round(offset*buffer.sampleRate)]).toBeCloseTo(sample,6); stop();
  });
  it('FLICK100 schedules sustained2x on the actual loop source, not transient history catch-up', async () => {
    const { track, buffer, sources, stop }=await makeRealTrack();
    track.configureLoopTransportFx(0,'VINYL FLICK',translate('vinyl-flick',{official_flick:100,'return-time':.05,brake:0}));
    await track.play(); expect(sources[0]?.buffer).toBe(buffer); expect(sources[0]?.loop).toBe(true);
    const curve=sources[0]!.playbackRate.curves.at(-1)!; expect(curve[0]).toBe(1); expect(curve[curve.length-1]).toBe(2);
    expect(track.loopTransportActive).toBe(true); stop();
  });
});
