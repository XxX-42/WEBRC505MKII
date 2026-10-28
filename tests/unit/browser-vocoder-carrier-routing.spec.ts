import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { buildBrowserRecoveryFxGraph, planBrowserRecoveryFxGraph } from '../../src/audio/BrowserRecoveryFxGraph';
import { BrowserTrackFxChain } from '../../src/audio/BrowserTrackFxChain';
import { TrackAudio } from '../../src/audio/TrackAudio';
import { BrowserWorkletFX } from '../../src/audio/fx/BrowserWorkletFX';
import { BrowserVocoderFX } from '../../src/audio/fx/BrowserVocoderFX';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { getBrowserOfficialDefaults } from '../../src/audio/fx/dsp/OfficialBrowserParameters';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';
import { Track, TrackState } from '../../src/core/types';
import { Transport } from '../../src/core/Transport';
import { createMockAudioContext } from '../helpers/audioTestUtils';

class Node {
  readonly edges: Array<{ target: Node; input: number }> = [];
  readonly gain = { value: 1, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setValueCurveAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
  readonly connect = vi.fn((target: Node, _output = 0, input = 0) => { this.edges.push({ target, input }); return target; });
  readonly disconnect = vi.fn((target?: Node, _output = 0, input?: number) => {
    for (let i = this.edges.length - 1; i >= 0; i--) if ((!target || this.edges[i]!.target === target) && (input === undefined || input === this.edges[i]!.input)) this.edges.splice(i, 1);
  });
}
class Worklet extends Node {
  static instances: Worklet[] = [];
  readonly processor: FxProcessor | null;
  onprocessorerror: (() => void) | null = null;
  readonly port = { onmessage: null as ((event: MessageEvent) => void) | null, close: vi.fn(), postMessage: vi.fn((data: unknown) => this.processor?.port.onmessage?.({ data })) };
  constructor(_context: AudioContext, readonly name: string, readonly options: AudioWorkletNodeOptions) {
    super();
    this.processor = name === 'rc505-fx-processor' ? new FxProcessor(options) : null;
    if (this.processor) this.processor.port.postMessage = data => this.port.onmessage?.({ data } as MessageEvent);
    Worklet.instances.push(this);
  }
}
function context() {
  const ctx = createMockAudioContext();
  ctx.createGain = () => new Node() as unknown as GainNode;
  return ctx;
}
function input(frames = 6000, sr = 12000, frequency = 193) {
  return Float32Array.from({ length: frames }, (_, i) => (i % 1000 < 650 ? .6 : .06) * (Math.sin(2 * Math.PI * frequency * i / sr) + .35 * Math.sin(2 * Math.PI * 977 * i / sr)));
}
function render(core: BrowserFxDspCore, carrier: Float32Array | null, chunks = [6000], right = carrier) {
  const modulator = input(), output = new Float32Array(modulator.length);
  let offset = 0, block = 0;
  core.setBypass(false, 0);
  while (offset < output.length) {
    const length = Math.min(chunks[block++ % chunks.length]!, output.length - offset);
    core.processBlock(modulator.subarray(offset, offset + length), modulator.subarray(offset, offset + length), output.subarray(offset, offset + length), null, length, false, carrier?.subarray(offset, offset + length) ?? null, right?.subarray(offset, offset + length) ?? null);
    offset += length;
  }
  return output;
}
const energy = (samples: Float32Array) => samples.reduce((sum, x) => sum + x * x, 0);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Worklet.instances = []; Transport.getInstance().stop(); });

describe('official VOCODER receives only a real selected playback carrier', () => {
  it('uses documented TRACK1 by default only after official opt-in, with no synthetic fallback', () => {
    expect(getBrowserOfficialDefaults('vocoder').official_carrier).toBe(6);
    expect(energy(render(new BrowserFxDspCore('vocoder', 12000, { mix: 1 }), null))).toBeGreaterThan(.01);
    expect(energy(render(new BrowserFxDspCore('vocoder', 12000, { official_balance: 100 }), null))).toBeLessThan(1e-20);
    expect(energy(render(new BrowserFxDspCore('vocoder', 12000, { official_balance: 100 }), input(6000, 12000, 367)))).toBeGreaterThan(.01);
  });
  it('uses both stereo source channels and remains sample-clocked across variable callback sizes', () => {
    const options = { official_carrier: 10, official_balance: 100 };
    const carrier = input(6000, 12000, 439), silence = new Float32Array(6000);
    const stereo = render(new BrowserFxDspCore('vocoder', 12000, options), silence, [6000], carrier);
    expect(energy(stereo)).toBeGreaterThan(.01);
    expect(render(new BrowserFxDspCore('vocoder', 12000, options), silence, [1, 17, 128, 7, 255], carrier)).toEqual(stereo);
    expect(render(new BrowserFxDspCore('vocoder', 12000, options), carrier, [6000], silence)).toEqual(stereo);
  });
  it('switching to an empty track clears prior carrier filter tails; reset retains the selected real-source mode', () => {
    const core = new BrowserFxDspCore('vocoder', 12000, { official_carrier: 6, official_balance: 100 });
    expect(energy(render(core, input()))).toBeGreaterThan(0);
    core.setParameters({ official_carrier: 7 });
    expect(energy(render(core, null))).toBeLessThan(1e-20);
    core.reset();
    expect(energy(render(core, null))).toBeLessThan(1e-20);
  });
  it.each([0, 1, 2, 3, 4, 5, 6.5, -1, 11, NaN, Infinity])('explicitly rejects unavailable/invalid carrier %s without mutating the accepted route', selection => {
    const core = new BrowserFxDspCore('vocoder', 12000, { official_carrier: 6, official_balance: 100 });
    expect(() => core.setParameters({ official_carrier: selection })).toThrow(/TRACK1–5 only/);
    expect(() => core.setParameters({ official_carrier_thru: 1 })).toThrow(/Unsupported official/);
    expect(energy(render(core, null))).toBeLessThan(1e-20);
  });
  it('keeps the stereo carrier right channel when the modulator is mono', () => {
    const processor = new FxProcessor({ processorOptions: { algorithm: 'vocoder', sampleRate: 12000, bypassed: false, parameters: { official_carrier: 6, official_balance: 100 } } });
    const modulator = input(), silence = new Float32Array(6000);
    const carrierRight = Float32Array.from({ length: 6000 }, (_, frame) => .5 * Math.sin(2 * Math.PI * 880 * frame / 12000));
    const left = new Float32Array(6000), right = new Float32Array(6000);
    processor.process([[modulator], [silence, carrierRight]], [[left, right]]);
    expect(energy(right)).toBeGreaterThan(.01);
    expect(left).toEqual(right); // Existing mono vocoder wet bank, not a dropped carrier channel.
    processor.core.reset();
    processor.process([[modulator], [silence, silence]], [[left, right]]);
    expect(energy(right)).toBeLessThan(1e-20);
  });
  it('the actual worklet takes carrier samples from input port 1, never the modulator port', () => {
    const processor = new FxProcessor({ processorOptions: { algorithm: 'vocoder', sampleRate: 12000, bypassed: false, parameters: { official_balance: 100 } } });
    const modulator = input(), carrier = input(6000, 12000, 439), left = new Float32Array(6000), right = new Float32Array(6000);
    processor.process([[modulator], [carrier]], [[left, right]]);
    expect(energy(left)).toBeGreaterThan(0); expect(right).toEqual(left);
    processor.core.reset(); processor.process([[modulator]], [[left, right]]);
    expect(energy(left)).toBeLessThan(1e-20);
  });
});

describe('Browser host carrier source ownership and legacy compatibility', () => {
  it('selects all five exact playback buses, disconnects only its own edge, snapshots defaults and rejects physical sources', async () => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const sources = Array.from({ length: 5 }, () => new Node());
    const fx = new BrowserWorkletFX(context(), 'VOCODER', async () => undefined, undefined, {}, { getVocoderCarrierSource: id => sources[id - 1] as unknown as AudioNode });
    await fx.ready;
    expect(sources.every(source => source.connect.mock.calls.length === 0)).toBe(true);
    fx.setParam('official_tone', 20);
    expect(fx.getParameterSnapshot()).toMatchObject({ official_carrier: 6, official_tone: 20, official_attack: 50, official_mod_sens: 0, official_balance: 50 });
    const node = Worklet.instances[0]!;
    expect(node.options.numberOfInputs).toBe(2);
    for (let selection = 6; selection <= 10; selection++) {
      fx.setParam('official_carrier', selection);
      expect(sources[selection - 6]!.connect).toHaveBeenCalledWith(node, 0, 1);
      if (selection > 6) expect(sources[selection - 7]!.disconnect).toHaveBeenCalledWith(node, 0, 1);
    }
    const snapshot = fx.getParameterSnapshot();
    fx.setParam('official_carrier', 0);
    expect(fx.error).toMatch(/not mapped/); expect(fx.getParameterSnapshot()).toEqual(snapshot);
    fx.dispose(); expect(sources[4]!.disconnect).toHaveBeenCalledWith(node, 0, 1);
  });
  it('restores an explicit official snapshot before asynchronous install and refuses a host without playback buses', async () => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const source = new Node();
    const fx = new BrowserWorkletFX(context(), 'VOCODER', async () => undefined, undefined, { official_carrier: 9, official_attack: 17 }, { getVocoderCarrierSource: id => id === 4 ? source as unknown as AudioNode : null });
    await fx.ready;
    expect(fx.error).toBe(''); expect(source.connect).toHaveBeenCalledWith(Worklet.instances[0], 0, 1);
    expect(fx.getParameterSnapshot()).toMatchObject({ official_carrier: 9, official_attack: 17 });
    const missing = new BrowserWorkletFX(context(), 'VOCODER', async () => undefined, undefined, { official_balance: 100 });
    await missing.ready; expect(missing.error).toMatch(/playback-only carrier bus is unavailable/); expect(missing.processorReady).toBe(false);
    fx.dispose(); missing.dispose();
  });
  it.each([0, 1, 2].flatMap(carrier => [0, .5, 1, 55, 100].map(mix => ({ carrier, mix }))))('matches old shared adapter PCM for legacy $carrier at $mix percent, preserving authored controls', async ({ carrier, mix }) => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const ctx = context();
    const old = new BrowserVocoderFX(ctx, async () => undefined);
    const next = new BrowserWorkletFX(ctx, 'VOCODER', async () => undefined, undefined, { vocoderBands: 16, vocoderCarrier: 1, mix: .7 }, { legacyVocoderMixPercent: true });
    await Promise.all([old.ready, next.ready]);
    expect(next.getParameterSnapshot()).toEqual(old.getParameterSnapshot());
    expect(next.getParameterSnapshot().mix).toBe(70);
    for (const fx of [old, next]) { fx.setParam('bands', 12); fx.setParam('carrier', carrier); fx.setParam('mix', mix); fx.setBypass(false); }
    const a = render(Worklet.instances[0]!.processor!.core, null), b = render(Worklet.instances[1]!.processor!.core, input());
    expect(b).toEqual(a); expect(next.getParameterSnapshot()).toEqual(old.getParameterSnapshot());
    next.setAmount(.2); expect(next.getParameterSnapshot()).toMatchObject({ vocoderBands: 12, vocoderCarrier: carrier, mix: 20 });
    old.dispose(); next.dispose();
  });
  it('keeps shared engine macro percentages separate from normalized private amounts and official carrier routing', async () => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const ctx = context();
    const engine = new BrowserAudioEngine({ context: ctx, deferTransportBpmChangeSubscription: true, loadDevicePreferences: false });
    engine.setFxType('input', 0, 'VOCODER'); engine.setFxType('track', 0, 'VOCODER'); engine.setTrackFxType(1, 0, 'VOCODER');
    await vi.waitFor(() => expect(engine.getTrackFxStatus()[0]!.slots[0]!.state).toBe('ready'));
    Object.assign(ctx, { state: 'closed' }); // Enables immutable host snapshots; fake processor remains callable.
    for (const percentage of [0, 1, 50, 100]) {
      engine.setFxParam('input', 0, percentage); engine.setFxParam('track', 0, percentage); engine.setTrackFxParameter(1, 0, percentage);
      const snapshot = engine.getRecoverySnapshot();
      expect(snapshot.fx.input[0]!.parameters.mix).toBe(percentage); expect(snapshot.fx.sharedTrack[0]!.parameters.mix).toBe(percentage);
      expect(snapshot.fx.privateTracks[0]![0]!.parameters.mix).toBe(percentage / 100);
      for (const node of Worklet.instances) {
        const messages = node.port.postMessage.mock.calls.map(([data]) => data as { type: string; parameters?: { mix?: number } });
        expect(messages.filter(message => message.type === 'configure').at(-1)?.parameters?.mix).toBe(percentage / 100);
      }
    }
    engine.setFxNamedParameters('input', 0, { bands: 12, carrier: 2, official_carrier: 9, official_balance: 100 });
    engine.setFxParam('input', 0, 50);
    expect(engine.getRecoverySnapshot().fx.input[0]!.parameters).toMatchObject({ vocoderBands: 12, vocoderCarrier: 2, mix: 50, official_carrier: 9, official_balance: 100 });
    const bus = engine.tracks[3]!.playbackSourceOutput as unknown as Node;
    expect(bus.edges.some(edge => edge.input === 1 && edge.target === Worklet.instances[0])).toBe(true);
    Object.assign(ctx, { state: 'closed' }); engine.retireAfterRecoveryAdoption();
  });
  it('routes and executes all official controls through Input, shared Track, and private Track adapters', async () => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const ctx = context(), sources = Array.from({ length: 5 }, () => new Node());
    const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
    Object.assign(engine, { context: ctx, tracks: sources.map((playbackSourceOutput, index) => ({ playbackSourceOutput, track: { id: index + 1 }, configureLoopTransportFx: vi.fn() })), trackMixNode: new Node(), inputFxChain: { input: new Node(), output: new Node() }, outputFxChain: { input: new Node(), output: new Node() }, inputFxInstances: [null,null,null,null], trackFxInstances: [null,null,null,null], inputFxTypes: [null,null,null,null], trackFxTypes: [null,null,null,null], inputFxActive: [false,false,false,false], trackFxActive: [false,false,false,false], fxWorkletModuleReady: null, fxWorkletGeneration: 0, statusListeners: new Set(), lastError: '' });
    const bank = new BrowserTrackFxChain(ctx, async () => undefined, undefined, undefined, undefined, id => sources[id - 1] as unknown as AudioNode);
    engine.setFxType('input', 0, 'VOCODER'); engine.setFxType('track', 0, 'VOCODER'); bank.setType(0, 'VOCODER');
    await vi.waitFor(() => expect(bank.getStatus(1).slots[0]!.state).toBe('ready'));
    const controls = { official_carrier: 8, official_tone: 21, official_attack: 0, official_mod_sens: 25, official_balance: 100 };
    engine.setFxNamedParameters('input', 0, controls); engine.setFxNamedParameters('track', 0, controls); expect(bank.setNamedParameters(0, controls)).toBe(true);
    expect(Worklet.instances).toHaveLength(3);
    for (const node of Worklet.instances) {
      expect(sources[2]!.connect).toHaveBeenCalledWith(node, 0, 1);
      const messages = node.port.postMessage.mock.calls.map(([message]) => message as { type: string; parameters?: object });
      expect(messages.some(message => message.type === 'configure' && Object.entries(controls).every(([key,value]) => (message.parameters as Record<string,number>)?.[key] === value))).toBe(true);
      expect(energy(render(node.processor!.core, input()))).toBeGreaterThan(0);
      node.processor!.core.reset();
      // Existing host BALANCE smoothing must settle before asserting silence.
      for (let i = 0; i < 4; i++) render(node.processor!.core, null);
      expect(energy(render(node.processor!.core, null))).toBeLessThan(1e-20);
    }
    bank.dispose(); engine.setFxType('input', 0, 'NONE'); engine.setFxType('track', 0, 'NONE');
  });
});

function pathExists(from: Node, to: Node, seen = new Set<Node>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false; seen.add(from);
  return from.edges?.some(edge => pathExists(edge.target, to, seen)) ?? false;
}
async function realTrack() {
  vi.useFakeTimers();
  vi.stubGlobal('AudioWorkletNode', Worklet);
  const ctx = context(), sources: Array<Node & { buffer: AudioBuffer | null; playbackRate: Node['gain']; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  ctx.createBufferSource = (() => {
    const source = Object.assign(new Node(), { buffer: null, loop: false, playbackRate: new Node().gain, start: vi.fn(), stop: vi.fn(), onended: null }); sources.push(source); return source;
  }) as unknown as typeof ctx.createBufferSource;
  const processed = new Node(), capture = new Worklet(ctx, 'input-capture', {});
  const engine = { context: ctx, trackMixNode: new Node(), roundTripLatency: 0, selectedBufferFrames: 128, tracks: [] as TrackAudio[], getProcessedInputNode: async () => processed, getInputCaptureRequestFrame: () => 0, beginInputCaptureSession: () => ({ node: capture }), abortInputCaptureSession: vi.fn(), releaseInputCaptureSession: vi.fn(), checkAndResetMaster: vi.fn() };
  const track = new TrackAudio(engine as never, new Track(1), 0, null, null); engine.tracks.push(track);
  const stop = () => { track.clear(); Object.assign(ctx, { state: 'closed' }); track.dispose(); };
  return { track, ctx, sources, processed, engine, stop };
}
describe('TrackAudio carrier bus is strictly playback-only and before all inserts', () => {
  it('never sends live recording monitor through the carrier bus or forms an Input-FX cycle on an empty track', async () => {
    const { track, ctx, processed, stop } = await realTrack();
    const carrier = track.playbackSourceOutput as unknown as Node;
    const fx = new BrowserWorkletFX(ctx, 'VOCODER', async () => undefined, undefined, { official_balance: 100 }, { getVocoderCarrierSource: () => track.playbackSourceOutput });
    await fx.ready;
    (fx.output as unknown as Node).connect(processed);
    await track.startRecording();
    expect(track.state).toBe(TrackState.RECORDING);
    expect(processed.connect).toHaveBeenCalledWith(track.fxChain.input);
    expect(pathExists(processed, carrier)).toBe(false);
    expect(pathExists(carrier, track.fxChain.input as unknown as Node)).toBe(true);
    expect(pathExists(track.fxChain.output as unknown as Node, carrier)).toBe(false);
    expect(energy(render(Worklet.instances.find(node => node.name === 'rc505-fx-processor')!.processor!.core, null))).toBeLessThan(1e-20);
    fx.dispose(); stop();
  });
  it.each([false, true])('normal/source-transport playback reaches the unity bus and stop/clear disconnect every reader (transport=%s)', async transport => {
    const { track, ctx, sources, processed, stop } = await realTrack();
    const buffer = ctx.createBuffer(2, ctx.sampleRate * 2, ctx.sampleRate);
    Object.assign(track, { audioBuffer: buffer, startOffset: 0 });
    if (transport) track.configureLoopTransportFx(0, 'BEAT SHIFT', { beatShiftOffsetBeats: .5, bpm: 120 });
    await track.play();
    const carrier = track.playbackSourceOutput as unknown as Node;
    expect(track.playbackSourceOutput.gain.value).toBe(1);
    expect(pathExists(sources[0]!, carrier)).toBe(true);
    expect(pathExists(processed, carrier)).toBe(false);
    expect(pathExists(track.fxChain.input as unknown as Node, carrier)).toBe(false);
    track.stop(); expect(pathExists(sources[0]!, carrier)).toBe(false);
    await track.play(); const last = sources.at(-1)!; expect(pathExists(last, carrier)).toBe(true);
    expect(track.clear()).toBe(true); expect(pathExists(last, carrier)).toBe(false); stop();
  });
  it('overdub capture stays on its muted sink, with the carrier receiving only the existing loop reader', async () => {
    const { track, ctx, sources, processed, engine, stop } = await realTrack();
    Object.assign(engine, { getInputCaptureRequestFrame: undefined, beginInputCaptureSession: undefined });
    Object.assign(track, { audioBuffer: ctx.createBuffer(2, ctx.sampleRate, ctx.sampleRate), startOffset: 0 });
    await track.play(); track.state = TrackState.OVERDUBBING;
    await (track as unknown as { startOverdub(): Promise<void> }).startOverdub();
    const overdub = Worklet.instances.find(node => node.name === 'rc505-overdub-processor')!;
    expect(overdub).toBeDefined();
    expect(processed.connect).toHaveBeenCalledWith(overdub, 0, 0);
    expect(pathExists(processed, track.playbackSourceOutput as unknown as Node)).toBe(false);
    expect(pathExists(sources[0]!, track.playbackSourceOutput as unknown as Node)).toBe(true);
    expect(pathExists(sources[0]!, (track as any).loopReaderGateGain as Node)).toBe(true);
    expect(((track as any).loopReaderGateGain as Node).edges).toContainEqual({ target: track.playbackSourceOutput as unknown as Node, input: 0 });
    expect(overdub.edges[0]!.target.gain.value).toBe(0);
    overdub.onprocessorerror?.(); stop();
  });
  it('REPLACE2 gates only the loop reader before Track FX and Bounce source taps', async () => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const { track, ctx, sources, processed, stop } = await realTrack();
    Object.assign((track as any).engine, { getInputCaptureRequestFrame: undefined, beginInputCaptureSession: undefined });
    Object.assign(track, { audioBuffer: ctx.createBuffer(2, ctx.sampleRate, ctx.sampleRate), startOffset: 0 });
    track.track.dubMode = 'REPLACE2';
    await track.play();
    track.state = TrackState.OVERDUBBING;
    await (track as unknown as { startOverdub(): Promise<void> }).startOverdub();

    const gate = (track as any).loopReaderGateGain as Node;
    const overdub = Worklet.instances.find(node => node.name === 'rc505-overdub-processor')!;
    expect(gate.gain.value).toBe(0);
    expect(track.playbackSourceOutput.gain.value).toBe(1);
    expect(pathExists(sources[0]!, gate)).toBe(true);
    expect(pathExists(gate, track.playbackSourceOutput as unknown as Node)).toBe(true);
    expect(processed.connect).toHaveBeenCalledWith(overdub, 0, 0);
    expect(pathExists(processed, gate)).toBe(false);
    expect(overdub.edges[0]!.target.gain.value).toBe(0);

    track.triggerStop();
    overdub.port.onmessage?.({ data: { type: 'OVERDUB_STOPPED', overflowFrames: 0, overflowEvents: 0, patchesSent: 0,
      requestedStopFrame: 0, appliedExclusiveEnd: 0, processorStopFrame: 0 } } as MessageEvent);
    expect(gate.gain.value).toBe(1);
    stop();
  });
  it.each(['mono', 'poly'] as const)('live %s pitch playback uses the same pre-strip bus and disconnects on stop', async mode => {
    const { track, ctx, stop } = await realTrack();
    const node = Object.assign(new Node(), { latencySeconds: .02, latencySamples: 882, loadBuffer: vi.fn(async () => undefined), scheduleLoop: vi.fn(async () => undefined), stopProcessing: vi.fn(async () => undefined), clearBuffers: vi.fn(async () => undefined), releaseWasmMemory: vi.fn(async () => undefined), setPitch: vi.fn(), port: { close: vi.fn() } });
    Object.assign(track, { audioBuffer: ctx.createBuffer(2, ctx.sampleRate, ctx.sampleRate), startOffset: 0, [mode === 'poly' ? 'livePolyPitchNode' : 'liveMonoPitchNode']: node, [mode === 'poly' ? 'livePolyPitchEnabledInternal' : 'liveMonoPitchEnabledInternal']: true });
    await track.play();
    expect(node.connect).toHaveBeenCalledWith((track as any).loopReaderGateGain);
    expect(node.connect).not.toHaveBeenCalledWith(track.fxChain.input);
    track.stop(); expect(pathExists(node, track.playbackSourceOutput as unknown as Node)).toBe(false); stop();
  });

});


describe('carrier and host clock recovery is audio-bound, not metadata-only', () => {
  it.each([.5, 1])('round-trips three-route snapshots at 107 BPM/7/8 and legacy mix %s, then rebinds recovered PCM to the new buses', async legacyMix => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const transport = Transport.getInstance(); transport.timeSignature = [7, 8]; transport.setBpm(107);
    const oldContext = context();
    const old = new BrowserAudioEngine({ context: oldContext, deferTransportBpmChangeSubscription: true, loadDevicePreferences: false });
    const pcm = oldContext.createBuffer(2, 6000, oldContext.sampleRate);
    pcm.getChannelData(0).set(input(6000, oldContext.sampleRate, 367));
    pcm.getChannelData(1).set(input(6000, oldContext.sampleRate, 439));
    Object.assign(old.tracks[2]!, { audioBuffer: pcm, startOffset: 0 });
    old.tracks[2]!.state = TrackState.STOPPED;
    const controls = { official_carrier: 8, official_balance: 100 };
    for (const route of ['input', 'track'] as const) {
      old.setFxType(route, 0, 'VOCODER'); old.setFxNamedParameters(route, 0, controls); old.setFxActive(route, 0, true);
      old.setFxType(route, 1, 'DSP LPF'); old.setFxNamedParameters(route, 1, { official_cutoff: 30 }); old.setFxActive(route, 1, true);
      old.setFxType(route, 2, 'VOCODER'); old.setFxNamedParameters(route, 2, { mix: legacyMix }); old.setFxActive(route, 2, true);
    }
    old.setTrackFxType(1, 0, 'VOCODER'); old.setTrackFxNamedParameters(1, 0, controls); old.setTrackFxActive(1, 0, true);
    old.setTrackFxType(1, 1, 'DSP LPF'); old.setTrackFxNamedParameters(1, 1, { official_cutoff: 30 }); old.setTrackFxActive(1, 1, true);
    old.setTrackFxType(1, 2, 'VOCODER'); old.setTrackFxNamedParameters(1, 2, { mix: legacyMix }); old.setTrackFxActive(1, 2, true);
    await vi.waitFor(() => expect(old.getTrackFxStatus()[0]!.slots.slice(0, 3).every(slot => slot.state === 'ready')).toBe(true));
    const oldLegacy = Worklet.instances.filter(node => node.options.processorOptions?.algorithm === 'vocoder' && node.options.processorOptions?.parameters?.official_carrier === undefined);
    Object.assign(oldContext, { state: 'closed' });
    const snapshot = old.getRecoverySnapshot();
    for (const bank of [snapshot.fx.input, snapshot.fx.sharedTrack, snapshot.fx.privateTracks[0]!]) {
      expect(bank[0]!.parameters).toMatchObject({ bpm: 107, quarterNotesPerMeasure: 3.5, official_carrier: 8 });
      expect(bank[1]!.parameters).toMatchObject({ bpm: 107, quarterNotesPerMeasure: 3.5, official_cutoff: 30 });
      expect(bank[2]!.parameters.mix).toBe(legacyMix); expect(bank[2]!.parameters.official_carrier).toBeUndefined();
    }
    const inspectionContext = context(); Object.assign(inspectionContext, { state: 'suspended' });
    const sink = inspectionContext.createGain(); sink.gain.value = 0;
    const plan = planBrowserRecoveryFxGraph(snapshot, 0, { includeSharedBanks: true });
    const inspection = await buildBrowserRecoveryFxGraph(inspectionContext, sink, snapshot, plan, async () => undefined, true);
    expect(inspection.inputBank!.getRecoverySnapshot()).toEqual(snapshot.fx.input);
    expect(inspection.sharedTrackBank!.getRecoverySnapshot()).toEqual(snapshot.fx.sharedTrack);
    expect(inspection.privateTrackBanks[0]!.getRecoverySnapshot()).toEqual(snapshot.fx.privateTracks[0]);
    const inspectionVocoderNodes = Worklet.instances.filter(node => node.options.processorOptions?.algorithm === 'vocoder' && node.options.processorOptions?.parameters?.official_carrier === 8).slice(-3);
    inspection.dispose();

    const nextContext = context(); Object.assign(nextContext, { state: 'suspended' });
    const readers: Array<Node & { buffer: AudioBuffer | null }> = [];
    nextContext.createBufferSource = (() => {
      const reader = Object.assign(new Node(), { buffer: null, loop: false, playbackRate: new Node().gain, start: vi.fn(), stop: vi.fn(), onended: null }); readers.push(reader); return reader;
    }) as unknown as typeof nextContext.createBufferSource;
    const next = new BrowserAudioEngine({ context: nextContext, deferTransportBpmChangeSubscription: true, loadDevicePreferences: false, historyBudgetBytes: snapshot.pcmHistoryBudget.limitBytes });
    await next.restoreRecoverySnapshot(snapshot);
    const restoredNodes = Worklet.instances.filter(node => node.options.processorOptions?.algorithm === 'vocoder' && node.options.processorOptions?.parameters?.official_carrier === 8).slice(-3);
    const restoredLegacy = Worklet.instances.filter(node => node.options.processorOptions?.algorithm === 'vocoder' && node.options.processorOptions?.parameters?.official_carrier === undefined).slice(-3);
    for (const [index, node] of restoredLegacy.entries()) {
      expect(node.options.processorOptions?.parameters?.mix).toBe(index < 2 ? legacyMix / 100 : legacyMix);
      expect(render(node.processor!.core, null)).toEqual(render(oldLegacy[index]!.processor!.core, null));
    }
    const playbackBus = next.tracks[2]!.playbackSourceOutput as unknown as Node;
    for (const node of restoredNodes) {
      expect(inspectionVocoderNodes).not.toContain(node);
      expect(playbackBus.edges).toContainEqual({ target: node, input: 1 });
      expect((old.tracks[2]!.playbackSourceOutput as unknown as Node).edges.some(edge => edge.target === node)).toBe(false);
    }
    await next.tracks[2]!.play();
    const reader = readers.at(-1)!;
    expect(reader.buffer).toBe(pcm); expect(pathExists(reader, playbackBus)).toBe(true);
    for (const node of restoredNodes) {
      const modulator = input(), left = new Float32Array(modulator.length), right = new Float32Array(modulator.length);
      expect(pathExists(reader, node)).toBe(true);
      node.processor!.process([[modulator, modulator], [reader.buffer!.getChannelData(0), reader.buffer!.getChannelData(1)]], [[left, right]]);
      expect(energy(left)).toBeGreaterThan(.01);
    }
    next.tracks[2]!.stop(); expect(pathExists(reader, playbackBus)).toBe(false);
    for (const node of restoredNodes) {
      for (let i = 0; i < 4; i++) render(node.processor!.core, null);
      expect(energy(render(node.processor!.core, null))).toBeLessThan(1e-20);
    }
    Object.assign(nextContext, { state: 'closed' }); old.retireAfterRecoveryAdoption(); next.retireAfterRecoveryAdoption();
    transport.timeSignature = [4, 4]; transport.setBpm(120);
  });
});
