import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserTrackFxChain, BROWSER_PER_TRACK_FX_TYPES, BROWSER_PER_TRACK_FX_UNSUPPORTED } from '../../src/audio/BrowserTrackFxChain';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';
import { BROWSER_WORKLET_FX_TYPES } from '../../src/audio/fx/BrowserWorkletFX';
import { BROWSER_TRACK_FX_COVERAGE } from '../../src/audio/browserTrackFxCoverage';
import { createMockAudioContext } from '../helpers/audioTestUtils';

type Stereo = [Float32Array, Float32Array];
class GraphNode {
  readonly sources = new Set<GraphNode>();
  readonly destinations = new Set<GraphNode>();
  gain = { value: 1, setTargetAtTime: vi.fn() };
  connect(target: GraphNode) { this.destinations.add(target); target.sources?.add(this); return target; }
  disconnect(target?: GraphNode) {
    for (const destination of [...this.destinations]) {
      if (target && target !== destination) continue;
      destination.sources?.delete(this); this.destinations.delete(destination);
    }
  }
  render(frames: number, seeds: Map<GraphNode, Stereo>, cache = new Map<GraphNode, Stereo>()): Stereo {
    const existing = cache.get(this); if (existing) return existing;
    const seed = seeds.get(this);
    const input: Stereo = seed ? [seed[0].slice(), seed[1].slice()] : [new Float32Array(frames), new Float32Array(frames)];
    for (const source of this.sources) {
      const data = source.render(frames, seeds, cache);
      for (let channel = 0; channel < 2; channel++) for (let frame = 0; frame < frames; frame++) input[channel]![frame] = input[channel]![frame]! + data[channel]![frame]!;
    }
    const output = this.transform(input, frames); cache.set(this, output); return output;
  }
  protected transform(input: Stereo, _frames: number): Stereo { return input; }
}
class DspWorkletNode extends GraphNode {
  static instances: DspWorkletNode[] = [];
  readonly processor: FxProcessor;
  onprocessorerror: (() => void) | null = null;
  readonly port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (message: unknown) => this.processor.port.onmessage?.({ data: message }) };
  constructor(_context: AudioContext, readonly name: string, readonly options: AudioWorkletNodeOptions) {
    super();
    this.processor = new FxProcessor(options);
    this.processor.port.postMessage = (message: unknown) => this.port.onmessage?.({ data: message } as MessageEvent);
    DspWorkletNode.instances.push(this);
  }
  protected override transform(input: Stereo, frames: number): Stereo {
    const output: Stereo = [new Float32Array(frames), new Float32Array(frames)];
    this.processor.process([input], [output]); return output;
  }
}
function signal(frames: number, offset = 0): Stereo {
  const left = Float32Array.from({ length: frames }, (_, index) => 0.4 * Math.sin((index + offset) * 0.63) + 0.2 * Math.sin((index + offset) * 0.017));
  return [left, left.slice()];
}
function graphContext() {
  const context = createMockAudioContext();
  context.createGain = () => new GraphNode() as unknown as GainNode;
  return context;
}
function bank(context = graphContext()) { return new BrowserTrackFxChain(context, async () => undefined); }
async function settled() { await Promise.resolve(); await Promise.resolve(); }
function render(chain: BrowserTrackFxChain, data: Stereo): Stereo {
  return (chain.output as unknown as GraphNode).render(data[0].length, new Map([[chain.input as unknown as GraphNode, data]]));
}

describe('Browser five independent pre-mix A–D chains', () => {
  afterEach(() => { vi.unstubAllGlobals(); DspWorkletNode.instances = []; });

  it('provides an executable/rejected coverage decision for every one of the 53 catalog types', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    expect(BROWSER_TRACK_FX_COVERAGE).toHaveLength(53);
    expect(BROWSER_TRACK_FX_COVERAGE.filter((entry) => entry.supported)).toHaveLength(43);
    const chain = bank();
    for (const entry of BROWSER_TRACK_FX_COVERAGE) {
      expect(chain.setType(0, entry.type)).toBe(entry.supported);
      await settled();
      const status = chain.getStatus(1).slots[0]!;
      expect(status.state).toBe(entry.supported ? 'ready' : 'error');
      if (entry.supported) expect(entry.numericParameters.length).toBeGreaterThan(0);
      else expect(entry.reason).toBeTruthy();
    }
  });

  it('routes actual DSP on Track 1 without changing Track 2, across variable render quanta', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const tracks = Array.from({ length: 5 }, () => bank());
    const effected = tracks[0]!;
    expect(effected.setType(0, 'MANUAL PAN')).toBe(true);
    expect(effected.setNamedParameters(0, { manualPanPosition: -1, mix: 1 })).toBe(true);
    expect(effected.setActive(0, true)).toBe(true);
    await settled();
    let offset = 0;
    for (const frames of [31, 128, 257, 64, 511, 7]) {
      const input = signal(frames, offset); offset += frames;
      const first = render(effected, input);
      for (const clean of tracks.slice(1)) expect(render(clean, input)).toEqual(input);
      expect([...first[0], ...first[1]].every(Number.isFinite)).toBe(true);
    }
    const input = signal(257, offset);
    const output = render(effected, input);
    expect(output[1].every((sample) => Math.abs(sample) < 1e-6)).toBe(true);
    expect(output[1]).not.toEqual(input[1]);
    expect(tracks[1]!.getStatus(2).slots.every((slot) => slot.state === 'empty')).toBe(true);
  });

  it('executes slots in A→B→C→D order, including noncommuting DSP and clear/replacement', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const forward = bank(); const reverse = bank();
    for (const [chain, order] of [[forward, ['DSP LPF', 'DIST']], [reverse, ['DIST', 'DSP LPF']]] as const) {
      for (let slot = 0; slot < 2; slot++) {
        const type = order[slot]!; chain.setType(slot, type);
        chain.setNamedParameters(slot, type === 'DIST' ? { driveDb: 30, mix: 1 } : { cutoffHz: 400, q: 0.7, mix: 1 });
        chain.setActive(slot, true);
      }
    }
    await settled();
    const firstNode = [...(forward.input as unknown as GraphNode).destinations][0]!;
    const firstDsp = [...firstNode.destinations][0] as DspWorkletNode;
    expect(firstDsp.options.processorOptions.algorithm).toBe('lpf');
    const outputA = render(forward, signal(4096)); const outputB = render(reverse, signal(4096));
    expect(outputA[0]).not.toEqual(outputB[0]);
    expect(outputA[0].some((sample, index) => Math.abs(sample - outputB[0][index]!) > 0.001)).toBe(true);
    forward.setType(0, 'NONE'); forward.setType(1, 'NONE');
    expect(render(forward, signal(257))).toEqual(signal(257));
    expect(forward.getStatus(1).slots.every((slot) => slot.bypassed)).toBe(true);
  });

  it('hosts twenty private processors, while replacing and enabling only the addressed track/slot', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const tracks = Array.from({ length: 5 }, () => bank());
    for (let track = 0; track < 5; track++) for (let slot = 0; slot < 4; slot++) {
      expect(tracks[track]!.setType(slot, 'MANUAL PAN')).toBe(true);
      expect(tracks[track]!.setNamedParameters(slot, { manualPanPosition: (track - 2) / 2, mix: 1 })).toBe(true);
      expect(tracks[track]!.setActive(slot, true)).toBe(true);
    }
    await settled();
    expect(DspWorkletNode.instances).toHaveLength(20);
    expect(new Set(DspWorkletNode.instances.map((node) => node.processor.core)).size).toBe(20);
    const before = tracks.slice(1).map((chain, index) => chain.getStatus(index + 2));
    tracks[0]!.setType(3, 'DELAY'); tracks[0]!.setActive(0, false);
    expect(tracks.slice(1).map((chain, index) => chain.getStatus(index + 2))).toEqual(before);
    for (const [index, chain] of tracks.entries()) expect(chain.getStatus(index + 1)).toMatchObject({ trackId: index + 1, available: true, routeMode: 'per-track-pre-mix', perTrackFxChainAvailable: true, legacySharedPostmix: true });
  });

  it.each(BROWSER_PER_TRACK_FX_TYPES)('installs the advertised executable adapter %s without unsupported defaults', async (type) => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const chain = bank(); expect(chain.setType(0, type)).toBe(true);
    chain.setParameter(0, 60); chain.setActive(0, true); chain.setBpm(143);
    await settled();
    expect(chain.getStatus(5).slots[0]).toMatchObject({ slotIndex: 0, slot: 'A', type, active: true, bypassed: false, state: 'ready', error: null });
    const data = render(chain, signal(257)); expect([...data[0], ...data[1]].every(Number.isFinite)).toBe(true);
  });

  it('explicitly rejects source-reader/MIDI/unknown effects and invalid targets without a fallback', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const chain = bank(); chain.setType(0, 'DELAY'); chain.setActive(0, true); await settled();
    for (const type of [...Object.keys(BROWSER_PER_TRACK_FX_UNSUPPORTED), 'TRANSPOSE', 'MAGIC FX']) {
      expect(chain.setType(0, type)).toBe(false);
      expect(chain.getStatus(1).slots[0]).toMatchObject({ type, active: false, bypassed: true, state: 'error' });
      expect(chain.getStatus(1).slots[0]!.error).toBeTruthy();
      expect(render(chain, signal(31))).toEqual(signal(31));
    }
    expect(chain.setType(-1, 'DELAY')).toBe(false); expect(chain.setType(4, 'DELAY')).toBe(false);
    expect(chain.setType(NaN, 'DELAY')).toBe(false);
    expect(BROWSER_PER_TRACK_FX_TYPES.every((type) => type === 'REVERSE REVERB (EXPERIMENTAL)' || type in BROWSER_WORKLET_FX_TYPES)).toBe(true);
  });

  it('surfaces worklet loading/unavailability/failure, remains dry, and can be cleared/retried', async () => {
    const unavailable = bank(); expect(unavailable.setType(0, 'DELAY')).toBe(false);
    expect(unavailable.getStatus(1).slots[0]).toMatchObject({ state: 'error', bypassed: true, active: false });
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    let fail!: (error: Error) => void;
    const chain = new BrowserTrackFxChain(graphContext(), () => new Promise<void>((_resolve, reject) => { fail = reject; }));
    expect(chain.setType(0, 'DELAY')).toBe(true); chain.setActive(0, true);
    expect(chain.getStatus(1).slots[0]).toMatchObject({ state: 'loading', bypassed: true });
    fail(new Error('module fetch failed')); await settled();
    expect(chain.getStatus(1).slots[0]).toMatchObject({ state: 'error', active: false, bypassed: true, error: 'module fetch failed' });
    expect(render(chain, signal(31))).toEqual(signal(31));
    expect(chain.setType(0, 'NONE')).toBe(true); expect(chain.getStatus(1).slots[0]!.state).toBe('empty');
  });

  it('rejects wrong named controls/spectral modes and restores dry audio if the processor dies', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const chain = bank(); chain.setType(0, 'DELAY'); chain.setActive(0, true); await settled();
    const worklet = DspWorkletNode.instances[0]!;
    worklet.onprocessorerror?.();
    expect(chain.getStatus(1).slots[0]).toMatchObject({ state: 'error', active: false, bypassed: true });
    expect(render(chain, signal(31))).toEqual(signal(31));
    expect(chain.setType(0, 'DELAY')).toBe(true); await settled();
    expect(chain.setNamedParameters(0, { inventedControl: 1 })).toBe(false);
    expect(chain.getStatus(1).slots[0]!.error).toContain('inventedControl');
    expect(chain.setType(0, 'FREEZE')).toBe(true);
    expect(chain.setNamedParameters(0, { freezeMode: 1 })).toBe(false);
    expect(chain.getStatus(1).slots[0]!.error).toContain('Spectral');
  });

  it('preserves stateful serial audio across arbitrary worklet block partitions and bypass changes', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const whole = bank(); const partitioned = bank();
    for (const chain of [whole, partitioned]) {
      chain.setType(0, 'DELAY'); chain.setNamedParameters(0, { delayTimeMs: 4, delayFeedback: 0.5, mix: 0.7 }); chain.setActive(0, true);
      chain.setType(3, 'DSP LPF'); chain.setNamedParameters(3, { cutoffHz: 2000, mix: 1 }); chain.setActive(3, true);
    }
    await settled();
    const input = signal(4096); const expected = render(whole, input);
    const actual: Stereo = [new Float32Array(4096), new Float32Array(4096)];
    const sizes = [7, 31, 128, 257, 64, 511]; let offset = 0; let block = 0;
    while (offset < 4096) {
      const frames = Math.min(sizes[block++ % sizes.length]!, 4096 - offset);
      const output = render(partitioned, [input[0].slice(offset, offset + frames), input[1].slice(offset, offset + frames)]);
      actual[0].set(output[0], offset); actual[1].set(output[1], offset); offset += frames;
    }
    expect(actual).toEqual(expected);
    partitioned.setActive(0, false); partitioned.setActive(3, false);
    render(partitioned, signal(257));
    expect(render(partitioned, signal(257))).toEqual(signal(257));
  });

  it('wires every actual TrackAudio private bank before level/pan/TrackMix and preserves the shared bank', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const context = createMockAudioContext();
    context.createGain = () => Object.assign(new GraphNode(), { connect: vi.fn(GraphNode.prototype.connect), disconnect: vi.fn(GraphNode.prototype.disconnect) }) as unknown as GainNode;
    const previousAudioContext = globalThis.AudioContext;
    globalThis.AudioContext = function () { return context; } as unknown as typeof AudioContext;
    let engine: BrowserAudioEngine;
    try { engine = new BrowserAudioEngine(); } finally { globalThis.AudioContext = previousAudioContext; }
    expect(engine.tracks).toHaveLength(5); expect(engine.getTrackFxStatus()).toHaveLength(5);
    expect(engine.getTrackTransportStatus().every((status) => status.perTrackFxChainAvailable)).toBe(true);
    for (const track of engine.tracks) {
      const output = track.fxChain.output as unknown as GraphNode;
      expect(output.destinations.size).toBe(1);
      const inserted = [...output.destinations][0]!;
      expect(inserted).not.toBe(engine.trackMixNode);
    }
    expect(engine.setTrackFxType(5, 3, 'MANUAL PAN')).toBe(true);
    expect(engine.setTrackFxNamedParameters(5, 3, { manualPanPosition: -1, mix: 1 })).toBe(true);
    expect(engine.setTrackFxActive(5, 3, true)).toBe(true);
    expect(engine.setTrackFxType(0, 0, 'DELAY')).toBe(false); expect(engine.setTrackFxType(6, 0, 'DELAY')).toBe(false);
    expect(engine.getTrackFxStatus(1)[0]!.slots[3]!.state).toBe('empty');
    engine.setFxType('track', 0, 'DELAY'); engine.setFxActive('track', 0, true);
    await settled();
    expect(engine.getTrackFxStatus(5)[0]!.slots[3]).toMatchObject({ type: 'MANUAL PAN', active: true });
    expect(engine.getTrackFxStatus(1)[0]!.slots[0]!.state).toBe('empty');
    // These conflicts belong to the separate experimental source stage. The
    // private insert banks remain independent and available downstream.
    engine.setFxType('track', 0, 'BEAT SHIFT'); engine.setFxActive('track', 0, true);
    engine.tracks[0]!.isReverse = true;
    Object.assign(engine.tracks[1]!, { liveMonoPitchEnabledInternal: true });
    Object.assign(engine.tracks[2]!, { livePolyPitchEnabledInternal: true });
    const transport = engine.getTrackTransportStatus();
    expect(transport[0]!.unavailableReason).toContain('forward');
    expect(transport[1]!.unavailableReason).toContain('LIVE_MONO');
    expect(transport[2]!.unavailableReason).toContain('LIVE_POLY');
    await vi.waitFor(() => expect(engine.getTrackFxStatus(5)[0]!.slots[3]).toMatchObject({ state: 'ready', active: true }));
    expect(engine.getTrackFxStatus(5)[0]!.slots[3]).toMatchObject({ state: 'ready', active: true });
    expect(engine.setTrackFxType(1, 0, 'BEAT SHIFT')).toBe(false);
    expect(engine.getTrackFxStatus(1)[0]!.slots[0]).toMatchObject({ state: 'error', active: false, bypassed: true });
  });
});
