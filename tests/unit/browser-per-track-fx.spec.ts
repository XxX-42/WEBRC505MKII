import { afterEach, describe, expect, it, vi } from 'vitest';
const pitchHarness = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/audio/pitch/signalsmith', () => ({ createLiveInputTransposeNode: pitchHarness.create }));
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserTrackFxChain, BROWSER_PER_TRACK_FX_TYPES, BROWSER_PER_TRACK_FX_UNSUPPORTED } from '../../src/audio/BrowserTrackFxChain';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';
import { BROWSER_WORKLET_FX_TYPES } from '../../src/audio/fx/BrowserWorkletFX';
import { BROWSER_TRACK_FX_COVERAGE } from '../../src/audio/browserTrackFxCoverage';
import { FX_CATALOG } from '../../src/audio/fx/catalog';
import { createMockAudioContext } from '../helpers/audioTestUtils';

type Stereo = [Float32Array, Float32Array];
class GraphNode {
  readonly sources = new Set<GraphNode>();
  readonly destinations = new Set<GraphNode>();
  gain = { value: 1, setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() };
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
  readonly postedMessages: unknown[] = [];
  onprocessorerror: (() => void) | null = null;
  readonly port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (message: unknown) => {
    this.postedMessages.push(message);
    this.processor.port.onmessage?.({ data: message });
  } };
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
function mockPitchNode() {
  const node = new GraphNode();
  const disconnect = vi.fn((target?: GraphNode) => GraphNode.prototype.disconnect.call(node, target));
  return Object.assign(node, {
    latencySeconds: 0.02,
    latencySamples: 960,
    setPitch: vi.fn(async () => undefined),
    disconnect,
  });
}
function bank(context = graphContext()) { return new BrowserTrackFxChain(context, async () => undefined); }
async function settled() { await Promise.resolve(); await Promise.resolve(); }
function render(chain: BrowserTrackFxChain, data: Stereo): Stereo {
  return (chain.output as unknown as GraphNode).render(data[0].length, new Map([[chain.input as unknown as GraphNode, data]]));
}

describe('Browser five independent pre-mix A–D chains', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); DspWorkletNode.instances = []; pitchHarness.create.mockReset(); });

  it('provides an executable/rejected coverage decision for every one of the 53 catalog types', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    expect(BROWSER_TRACK_FX_COVERAGE).toHaveLength(53);
    const canonicalIds = FX_CATALOG.map(({ id }) => id);
    const supportedIds = BROWSER_TRACK_FX_COVERAGE.filter((entry) => entry.supported).map((entry) => entry.catalogId);
    const rejectedIds = BROWSER_TRACK_FX_COVERAGE.filter((entry) => !entry.supported).map((entry) => entry.catalogId);
    expect(supportedIds).toHaveLength(51);
    expect(rejectedIds).toHaveLength(2);
    expect(new Set(canonicalIds).size).toBe(53);
    expect(new Set(supportedIds).size).toBe(supportedIds.length);
    expect(new Set(rejectedIds).size).toBe(rejectedIds.length);
    expect(supportedIds.some((id) => rejectedIds.includes(id))).toBe(false);
    expect([...supportedIds, ...rejectedIds].sort()).toEqual([...canonicalIds].sort());
    const chain = bank();
    for (const entry of BROWSER_TRACK_FX_COVERAGE) {
      chain.setType(0, 'NONE');
      if (entry.type === 'TRANSPOSE') {
        // The Signalsmith host adapter is validated by real AudioWorklet E2E;
        // this FxProcessor fixture only simulates the BrowserWorkletFX route.
        expect(BROWSER_PER_TRACK_FX_TYPES).toContain(entry.type);
        expect(entry.numericParameters.filter(key => !key.startsWith('official_'))).toEqual(['shift', 'mix']);
        continue;
      }
      if (entry.type === 'PITCH BEND') {
        pitchHarness.create.mockResolvedValueOnce(mockPitchNode());
        expect(chain.setType(0, entry.type)).toBe(true);
        await settled();
        expect(chain.getStatus(1).slots[0]).toMatchObject({ state: 'ready', type: 'PITCH BEND', pendingApply: false });
        expect(entry.numericParameters.filter(key => !key.startsWith('official_'))).toEqual(['range', 'time_ms', 'direction', 'mix_percent']);
        continue;
      }
      if (entry.type === 'ROBOT') {
        pitchHarness.create.mockResolvedValueOnce(mockPitchNode());
        expect(chain.setType(0, entry.type)).toBe(true);
        await settled();
        expect(chain.getStatus(1).slots[0]).toMatchObject({ state: 'ready', type: 'ROBOT', pendingApply: false });
        expect(entry.numericParameters.filter(key => !key.startsWith('official_'))).toEqual(['pitch', 'formant', 'mix']);
        continue;
      }
      if (entry.type === 'HRM MANUAL') {
        pitchHarness.create.mockClear();
        pitchHarness.create.mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode());
        expect(chain.setType(0, entry.type)).toBe(true);
        await settled();
        expect(chain.getStatus(1).slots[0]).toMatchObject({ state: 'ready', type: 'HRM MANUAL', pendingApply: false });
        expect(entry.numericParameters.filter(key => !key.startsWith('official_'))).toEqual(['voice_1_interval', 'voice_2_interval', 'pan_percent', 'mix_percent']);
        expect(pitchHarness.create).toHaveBeenCalledTimes(2);
        expect(pitchHarness.create).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ semitones: 7 }));
        expect(pitchHarness.create).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ semitones: 12 }));
        expect(chain.setNamedParameters(0, { voice_1_interval: -5, voice_2_interval: 9, pan_percent: 40, mix_percent: 80 })).toBe(true);
        expect(chain.setParameter(0, 25)).toBe(true);
        expect(chain.setActive(0, true)).toBe(true);
        continue;
      }
      if (entry.type === 'OCTAVE') {
        pitchHarness.create.mockClear();
        pitchHarness.create.mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode());
        expect(chain.setType(0, entry.type)).toBe(true);
        await settled();
        expect(chain.getStatus(1).slots[0]).toMatchObject({ state: 'ready', type: 'OCTAVE', pendingApply: false });
        expect(entry.numericParameters.filter(key => !key.startsWith('official_'))).toEqual(['minus_24_level', 'minus_12_level', 'plus_12_level', 'mix_percent']);
        expect(pitchHarness.create).toHaveBeenCalledTimes(3);
        expect(chain.setNamedParameters(0, { minus_24_level: 25, minus_12_level: 55, plus_12_level: 80, mix_percent: 90 })).toBe(true);
        expect(chain.setParameter(0, 45)).toBe(true);
        expect(chain.setActive(0, true)).toBe(true);
        continue;
      }
      if (entry.type === 'AUTO RIFF') {
        pitchHarness.create.mockResolvedValueOnce(mockPitchNode());
        expect(chain.setType(0, entry.type)).toBe(true);
        await settled();
        expect(chain.getStatus(1).slots[0]).toMatchObject({ state: 'ready', type: 'AUTO RIFF', pendingApply: false });
        expect(entry.numericParameters.filter(key => !key.startsWith('official_'))).toEqual(['scale', 'rate_beats', 'sensitivity_percent', 'mix_percent']);
        expect(chain.setNamedParameters(0, { scale: 1, rate_beats: 0.25, sensitivity_percent: 75, mix_percent: 90 })).toBe(true);
        chain.setBpm(180);
        expect(chain.setParameter(0, 65)).toBe(true);
        expect(chain.setActive(0, true)).toBe(true);
        expect(chain.getStatus(1).slots[0]?.resourceNote).toContain('Live Signalsmith WASM reserved');
        continue;
      }
      if (entry.type === 'HRM AUTO (M)') {
        pitchHarness.create.mockClear();
        pitchHarness.create.mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode());
        expect(chain.setType(0, entry.type)).toBe(true);
        await vi.waitFor(() => expect(chain.getStatus(1).slots[0]).toMatchObject({ state: 'ready', type: 'HRM AUTO (M)', pendingApply: false }));
        expect(entry.numericParameters.filter(key => !key.startsWith('official_'))).toEqual(['key', 'scale', 'midi-channel', 'mix']);
        expect(chain.setNamedParameters(0, { key: 7, scale: 2, 'midi-channel': 6, mix: 0.6 })).toBe(true);
        expect(chain.setParameter(0, 45)).toBe(true);
        expect(chain.setActive(0, true)).toBe(true);
        expect(chain.canReceiveMidiNotes(0, 'hrm_auto_m')).toBe(true);
        expect(chain.getStatus(1).slots[0]?.resourceNote).toContain('Per-node ceilings: 1.25 MiB LIVE_FX, 4 MiB LIVE_POLY');
        expect(chain.sendMidiNote(0, { channel: 6, note: 64, velocity: 95, noteOn: true, frame: 1234 })).toBe(true);
        const analyzer = DspWorkletNode.instances.at(-1)!;
        expect(analyzer.postedMessages).toContainEqual(expect.objectContaining({
          type: 'midi-note-on', channel: 6, note: 64, velocity: 95, frame: 1234,
        }));
        expect(chain.clearMidiNotes(0, 1300)).toBe(true);
        expect(analyzer.postedMessages).toContainEqual({ type: 'reset' });
        continue;
      }
      if (entry.type === 'OSC VOC (M)') {
        expect(chain.setType(0, entry.type)).toBe(true);
        await settled();
        expect(chain.getStatus(1).slots[0]).toMatchObject({ state: 'ready', type: 'OSC VOC (M)', pendingApply: false });
        expect(entry.numericParameters.filter(key => !key.startsWith('official_'))).toEqual(['waveform', 'midi-channel', 'octave', 'mix']);
        expect(chain.setNamedParameters(0, { waveform: 2, 'midi-channel': 7, octave: -12, mix: 0.6 })).toBe(true);
        expect(chain.sendMidiNote(0, { channel: 7, note: 69, velocity: 100, noteOn: true, frame: 1234 })).toBe(true);
        expect(DspWorkletNode.instances.at(-1)?.postedMessages).toContainEqual(expect.objectContaining({
          type: 'midi-note-on', channel: 7, note: 69, frame: 1234,
        }));
        expect(chain.clearMidiNotes(0, 1300)).toBe(true);
        expect(DspWorkletNode.instances.at(-1)?.postedMessages).toContainEqual({ type: 'midi-all-notes-off', frame: 1300 });
        continue;
      }
      expect(chain.setType(0, entry.type)).toBe(entry.supported);
      await settled();
      const status = chain.getStatus(1).slots[0]!;
      expect(status.state).toBe(entry.supported ? 'ready' : 'error');
      if (entry.supported) expect(entry.numericParameters.length).toBeGreaterThan(0);
      else expect(entry.reason).toBeTruthy();
    }
  });

  it('sends OSC VOC MIDI only to the selected private track/slot and frame-clears the old route on retarget', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const context = graphContext();
    const banks = Array.from({ length: 5 }, () => bank(context));
    banks[1]!.setType(1, 'OSC VOC (M)');
    banks[3]!.setType(1, 'OSC VOC (M)');
    await vi.waitFor(() => {
      expect(banks[1]!.getStatus(2).slots[1]?.state).toBe('ready');
      expect(banks[3]!.getStatus(4).slots[1]?.state).toBe('ready');
    });
    const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
    const midiInput = { connect: vi.fn(async () => 'connected'), disconnect: vi.fn(), releaseHeldNotes: vi.fn() };
    Object.assign(engine, {
      context, perTrackFxChains: banks, midiInput,
      inputFxInstances: [null, null, null, null], trackFxInstances: [null, null, null, null],
      selectedHrmAutoMidiTarget: null, selectedTrackMidiTarget: null,
      midiRoutingMode: 'legacy-broadcast', lastError: '', statusListeners: new Set(),
    });
    const handle = (engine as unknown as { handleMidiNote: (event: { channel: number; note: number; velocity: number; noteOn: boolean; timeStampMs: number }) => void }).handleMidiNote.bind(engine);
    const first = DspWorkletNode.instances.at(-2)!;
    const second = DspWorkletNode.instances.at(-1)!;
    await engine.connectMidiInput({ path: 'track', trackId: 2, slot: 'B', effectId: 'osc_voc_m' });
    handle({ channel: 1, note: 64, velocity: 0.8, noteOn: true, timeStampMs: 0 });
    expect(first.postedMessages).toContainEqual(expect.objectContaining({ type: 'midi-note-on', channel: 1, note: 64 }));
    expect(second.postedMessages.filter((message) => (message as { type?: string }).type === 'midi-note-on')).toHaveLength(0);

    await engine.connectMidiInput({ path: 'track', trackId: 4, slot: 'B', effectId: 'osc_voc_m' });
    expect(midiInput.releaseHeldNotes).toHaveBeenCalledTimes(2);
    expect(first.postedMessages).toContainEqual(expect.objectContaining({ type: 'midi-all-notes-off' }));
    handle({ channel: 1, note: 67, velocity: 0.8, noteOn: true, timeStampMs: 0 });
    expect(second.postedMessages).toContainEqual(expect.objectContaining({ type: 'midi-note-on', channel: 1, note: 67 }));
    expect(first.postedMessages.filter((message) => (message as { type?: string }).type === 'midi-note-on')).toHaveLength(1);

    expect(engine.setTrackFxType(4, 1, 'DELAY')).toBe(true);
    expect(second.postedMessages).toContainEqual(expect.objectContaining({ type: 'midi-all-notes-off' }));
    const secondNoteCount = second.postedMessages.filter((message) => (message as { type?: string }).type === 'midi-note-on').length;
    handle({ channel: 1, note: 70, velocity: 0.8, noteOn: true, timeStampMs: 0 });
    expect(second.postedMessages.filter((message) => (message as { type?: string }).type === 'midi-note-on')).toHaveLength(secondNoteCount);
    engine.disconnectMidiInput();
    expect(midiInput.disconnect).toHaveBeenCalledTimes(2);
    banks.forEach((candidate) => candidate.dispose());
  });

  it('routes HRM AUTO MIDI only to one exact private track slot and clears it on retarget or replacement', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const context = graphContext();
    const banks = Array.from({ length: 5 }, () => bank(context));
    for (const trackIndex of [1, 3]) {
      pitchHarness.create.mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode());
      expect(banks[trackIndex]!.setType(1, 'HRM AUTO (M)')).toBe(true);
    }
    await vi.waitFor(() => {
      expect(banks[1]!.getStatus(2).slots[1]?.state).toBe('ready');
      expect(banks[3]!.getStatus(4).slots[1]?.state).toBe('ready');
    });

    const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
    const midiInput = { connect: vi.fn(async () => 'connected'), disconnect: vi.fn(), releaseHeldNotes: vi.fn() };
    Object.assign(engine, {
      context, perTrackFxChains: banks, midiInput,
      inputFxInstances: [null, null, null, null], trackFxInstances: [null, null, null, null],
      selectedHrmAutoMidiTarget: null, selectedTrackMidiTarget: null,
      midiRoutingMode: 'legacy-broadcast', lastError: '', statusListeners: new Set(),
    });
    const handle = (engine as unknown as { handleMidiNote: (event: { channel: number; note: number; velocity: number; noteOn: boolean; timeStampMs: number }) => void }).handleMidiNote.bind(engine);
    const firstAnalyzer = DspWorkletNode.instances.at(-2)!;
    const secondAnalyzer = DspWorkletNode.instances.at(-1)!;
    const noteOn = (messages: unknown[]) => messages.filter((message) => (message as { type?: string }).type === 'midi-note-on');

    await engine.connectMidiInput({ path: 'track', trackId: 2, slot: 'B', effectId: 'hrm_auto_m' });
    handle({ channel: 2, note: 67, velocity: 0.75, noteOn: true, timeStampMs: 0 });
    expect(noteOn(firstAnalyzer.postedMessages)).toHaveLength(1);
    expect(noteOn(secondAnalyzer.postedMessages)).toHaveLength(0);
    expect(firstAnalyzer.postedMessages).toContainEqual(expect.objectContaining({ type: 'midi-note-on', channel: 2, note: 67, velocity: 95 }));

    await engine.connectMidiInput({ path: 'track', trackId: 4, slot: 'B', effectId: 'hrm_auto_m' });
    expect(firstAnalyzer.postedMessages).toContainEqual({ type: 'reset' });
    handle({ channel: 2, note: 70, velocity: 0.5, noteOn: true, timeStampMs: 0 });
    expect(noteOn(firstAnalyzer.postedMessages)).toHaveLength(1);
    expect(noteOn(secondAnalyzer.postedMessages)).toHaveLength(1);

    expect(engine.setTrackFxType(4, 1, 'DELAY')).toBe(true);
    expect(secondAnalyzer.postedMessages).toContainEqual({ type: 'reset' });
    const countBeforeStaleEvent = noteOn(secondAnalyzer.postedMessages).length;
    handle({ channel: 2, note: 72, velocity: 0.9, noteOn: true, timeStampMs: 0 });
    expect(noteOn(secondAnalyzer.postedMessages)).toHaveLength(countBeforeStaleEvent);
    expect(midiInput.disconnect).toHaveBeenCalledTimes(1);
    engine.disconnectMidiInput();
    banks.forEach((candidate) => candidate.dispose());
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

  it.each(BROWSER_PER_TRACK_FX_TYPES.filter((type) => type !== 'TRANSPOSE'))('installs the advertised executable adapter %s without unsupported defaults', async (type) => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    if (type === 'PITCH BEND' || type === 'ROBOT' || type === 'AUTO RIFF') pitchHarness.create.mockResolvedValue(mockPitchNode());
    if (type === 'HRM MANUAL') pitchHarness.create.mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode());
    if (type === 'OCTAVE') pitchHarness.create.mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode());
    if (type === 'HRM AUTO (M)') pitchHarness.create.mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode());
    const chain = bank(); expect(chain.setType(0, type)).toBe(true);
    chain.setParameter(0, 60); chain.setActive(0, true); chain.setBpm(143);
    await settled();
    if (type === 'HRM AUTO (M)') {
      await vi.waitFor(() => expect(chain.getStatus(5).slots[0]?.state).toBe('ready'));
    }
    expect(chain.getStatus(5).slots[0]).toMatchObject({ slotIndex: 0, slot: 'A', type, active: true, bypassed: false, state: 'ready', error: null });
    const data = render(chain, signal(257)); expect([...data[0], ...data[1]].every(Number.isFinite)).toBe(true);
  });

  it('explicitly rejects source-reader/MIDI/unknown effects and invalid targets without a fallback', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const chain = bank(); chain.setType(0, 'MANUAL PAN');
    chain.setNamedParameters(0, { manualPanPosition: -0.5, mix: 1 }); chain.setActive(0, true); await settled();
    for (const type of [...Object.keys(BROWSER_PER_TRACK_FX_UNSUPPORTED), 'MAGIC FX']) {
      const before = render(chain, signal(31));
      expect(chain.setType(0, type)).toBe(false);
      expect(chain.getStatus(1).slots[0]).toMatchObject({ type: 'MANUAL PAN', active: true, bypassed: false, state: 'ready' });
      expect(chain.getStatus(1).slots[0]!.warning).toBeTruthy();
      expect(render(chain, signal(31))).toEqual(before);
    }
    expect(chain.setType(-1, 'DELAY')).toBe(false); expect(chain.setType(4, 'DELAY')).toBe(false);
    expect(chain.setType(NaN, 'DELAY')).toBe(false);
    expect(BROWSER_PER_TRACK_FX_TYPES.every((type) => type === 'REVERSE REVERB (EXPERIMENTAL)' || type === 'TRANSPOSE' || type === 'PITCH BEND' || type === 'ROBOT' || type === 'HRM MANUAL' || type === 'OCTAVE' || type === 'AUTO RIFF' || type === 'HRM AUTO (M)' || type in BROWSER_WORKLET_FX_TYPES)).toBe(true);
  });

  it('treats AUTO RIFF catalog and experimental spellings as the same live adapter', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    pitchHarness.create.mockResolvedValue(mockPitchNode());
    const chain = bank();
    expect(chain.setType(0, 'AUTO RIFF')).toBe(true);
    await vi.waitFor(() => expect(chain.getStatus(1).slots[0]).toMatchObject({ type: 'AUTO RIFF', state: 'ready' }));
    expect(chain.setType(0, 'AUTO RIFF (EXPERIMENTAL)')).toBe(true);
    expect(chain.getStatus(1).slots[0]).toMatchObject({ type: 'AUTO RIFF (EXPERIMENTAL)', state: 'ready' });
    expect(pitchHarness.create).toHaveBeenCalledTimes(1);
    chain.dispose();
  });

  it.each([
    ['ROBOT (EXPERIMENTAL)', 'robot'],
    ['HRM AUTO (M) (EXPERIMENTAL)', 'hrm-auto'],
  ] as const)('dispatches the %s option by canonical catalog identity', async (label, algorithm) => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    pitchHarness.create.mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode());
    const chain = bank();
    expect(chain.setType(0, label)).toBe(true);
    chain.setParameter(0, 55);
    chain.setActive(0, true);
    await vi.waitFor(() => expect(chain.getStatus(1).slots[0]).toMatchObject({
      type: label, state: 'ready', active: true, bypassed: false, error: null,
    }));
    expect(DspWorkletNode.instances[0]!.options.processorOptions).toMatchObject({ algorithm });
    expect(chain.setNamedParameters(0, algorithm === 'robot'
      ? { pitch: 5, formant: 1, mix: 0.4 }
      : { key: 4, scale: 2, 'midi-channel': 7, mix: 45 })).toBe(true);
    chain.dispose();
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

  it('keeps the incumbent DSP connected when candidate preparation fails', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    let rejectModule = false;
    const ensure = () => rejectModule ? Promise.reject(new Error('candidate module rejected')) : Promise.resolve();
    // Give the graph fixture a deterministic GainNode graph while the candidate
    // Worklet's module loader fails before it can replace the active incumbent.
    const context = graphContext();
    const tracked = new BrowserTrackFxChain(context, ensure);
    expect(tracked.setType(0, 'MANUAL PAN')).toBe(true);
    expect(tracked.setNamedParameters(0, { manualPanPosition: -1, mix: 1 })).toBe(true);
    expect(tracked.setActive(0, true)).toBe(true);
    await settled();
    const before = render(tracked, signal(257));

    rejectModule = true;
    expect(tracked.setType(0, 'DSP LPF')).toBe(true);
    expect(tracked.getStatus(1).slots[0]).toMatchObject({ type: 'MANUAL PAN', pendingApply: true, state: 'loading' });
    expect(render(tracked, signal(257))).toEqual(before);
    await settled();

    expect(tracked.getStatus(1).slots[0]).toMatchObject({
      type: 'MANUAL PAN', active: true, state: 'ready', pendingApply: false,
    });
    expect(tracked.getStatus(1).slots[0]!.warning).toContain('FX replacement failed; kept existing MANUAL PAN');
    expect(render(tracked, signal(257))).toEqual(before);
  });

  it('keeps the incumbent DSP connected when a Signalsmith candidate fails before ready', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const tracked = new BrowserTrackFxChain(graphContext(), async () => undefined);
    expect(tracked.setType(0, 'MANUAL PAN')).toBe(true);
    expect(tracked.setNamedParameters(0, { manualPanPosition: -0.5, mix: 1 })).toBe(true);
    expect(tracked.setActive(0, true)).toBe(true);
    await settled();
    const input = signal(257);
    const before = render(tracked, input);

    pitchHarness.create.mockRejectedValueOnce(new Error('Signalsmith candidate startup failed'));
    expect(tracked.setType(0, 'PITCH BEND')).toBe(true);
    expect(tracked.getStatus(1).slots[0]).toMatchObject({ type: 'MANUAL PAN', pendingApply: true, state: 'loading' });
    await vi.waitFor(() => expect(tracked.getStatus(1).slots[0]?.pendingApply).toBe(false));

    const status = tracked.getStatus(1).slots[0]!;
    expect(status).toMatchObject({ type: 'MANUAL PAN', active: true, state: 'ready', pendingApply: false });
    expect(status.warning).toContain('FX replacement failed; kept existing MANUAL PAN');
    expect(render(tracked, input)).toEqual(before);
    tracked.dispose();
  });

  it('keeps the incumbent and releases a partial two-voice HRM MANUAL candidate on failure', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const tracked = new BrowserTrackFxChain(graphContext(), async () => undefined);
    expect(tracked.setType(0, 'MANUAL PAN')).toBe(true);
    expect(tracked.setNamedParameters(0, { manualPanPosition: -0.5, mix: 1 })).toBe(true);
    expect(tracked.setActive(0, true)).toBe(true);
    await settled();
    const input = signal(257);
    const before = render(tracked, input);

    const partialVoice = mockPitchNode();
    pitchHarness.create.mockResolvedValueOnce(partialVoice).mockRejectedValueOnce(new Error('second harmony voice failed'));
    expect(tracked.setType(0, 'HRM MANUAL')).toBe(true);
    await vi.waitFor(() => expect(tracked.getStatus(1).slots[0]?.pendingApply).toBe(false));
    expect(partialVoice.disconnect).toHaveBeenCalledOnce();
    expect(tracked.getStatus(1).slots[0]).toMatchObject({ type: 'MANUAL PAN', active: true, state: 'ready', pendingApply: false });
    expect(tracked.getStatus(1).slots[0]?.warning).toContain('FX replacement failed; kept existing MANUAL PAN');
    expect(render(tracked, input)).toEqual(before);
    tracked.dispose();
  });

  it('requires clearing a failed resident HRM MANUAL processor before retrying', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    pitchHarness.create.mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode());
    const tracked = bank();
    expect(tracked.setType(0, 'HRM MANUAL')).toBe(true);
    await vi.waitFor(() => expect(tracked.getStatus(1).slots[0]).toMatchObject({ type: 'HRM MANUAL', state: 'ready' }));
    expect(pitchHarness.create).toHaveBeenCalledTimes(2);
    expect(tracked.setType(0, 'HRM MANUAL')).toBe(true);
    expect(pitchHarness.create).toHaveBeenCalledTimes(2);
    expect(tracked.setNamedParameters(0, { formant: 1 })).toBe(false);
    expect(tracked.getStatus(1).slots[0]).toMatchObject({ type: 'HRM MANUAL', state: 'error', active: false });
    expect(tracked.setType(0, 'HRM MANUAL')).toBe(false);
    expect(tracked.getStatus(1).slots[0]?.warning).toContain('clear it before retrying');
    expect(pitchHarness.create).toHaveBeenCalledTimes(2);
    expect(tracked.setType(0, 'NONE')).toBe(true);
    pitchHarness.create.mockResolvedValueOnce(mockPitchNode()).mockResolvedValueOnce(mockPitchNode());
    expect(tracked.setType(0, 'HRM MANUAL')).toBe(true);
    await vi.waitFor(() => expect(tracked.getStatus(1).slots[0]).toMatchObject({ type: 'HRM MANUAL', state: 'ready' }));
    expect(pitchHarness.create).toHaveBeenCalledTimes(4);
    tracked.dispose();
  });

  it('releases a timed-out Signalsmith candidate after its late node resolves and preserves incumbent audio', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    const tracked = new BrowserTrackFxChain(graphContext(), async () => undefined);
    expect(tracked.setType(0, 'MANUAL PAN')).toBe(true);
    expect(tracked.setNamedParameters(0, { manualPanPosition: -0.5, mix: 1 })).toBe(true);
    expect(tracked.setActive(0, true)).toBe(true);
    await settled();
    const input = signal(257);
    const before = render(tracked, input);

    let resolvePitch!: (node: ReturnType<typeof mockPitchNode>) => void;
    pitchHarness.create.mockReturnValueOnce(new Promise((resolve) => { resolvePitch = resolve; }));
    expect(tracked.setType(0, 'PITCH BEND')).toBe(true);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tracked.getStatus(1).slots[0]).toMatchObject({ type: 'MANUAL PAN', active: true, pendingApply: false, state: 'ready' });
    expect(render(tracked, input)).toEqual(before);

    const lateNode = mockPitchNode();
    resolvePitch(lateNode);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateNode.disconnect).toHaveBeenCalledOnce();
    expect(tracked.getStatus(1).slots[0]?.type).toBe('MANUAL PAN');
    expect(render(tracked, input)).toEqual(before);
    tracked.dispose();
  });

  it('rolls back a candidate processor error without replacing the incumbent route', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    let resolveModule!: () => void;
    let blockModule = false;
    const ensure = () => blockModule ? new Promise<void>((resolve) => { resolveModule = resolve; }) : Promise.resolve();
    const tracked = new BrowserTrackFxChain(graphContext(), ensure);
    expect(tracked.setType(0, 'MANUAL PAN')).toBe(true);
    await settled();
    tracked.setNamedParameters(0, { manualPanPosition: -1, mix: 1 });
    tracked.setActive(0, true);
    for (let warm = 0; warm < 3; warm += 1) render(tracked, signal(2048));
    const input = signal(257);
    const before = render(tracked, input);

    blockModule = true;
    expect(tracked.setType(0, 'DELAY')).toBe(true);
    await Promise.resolve();
    resolveModule();
    await Promise.resolve();
    const candidate = DspWorkletNode.instances.at(-1)!;
    expect(candidate.onprocessorerror).toBeTypeOf('function');
    candidate.onprocessorerror?.();
    await settled();

    expect(tracked.getStatus(1).slots[0]).toMatchObject({ type: 'MANUAL PAN', active: true, state: 'ready', pendingApply: false });
    expect(tracked.getStatus(1).slots[0]!.warning).toContain('FX replacement failed; kept existing MANUAL PAN');
    expect(render(tracked, input)).toEqual(before);
  });

  it('cancels stale A→B candidates so only the newest request can commit', async () => {
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    let hold = false;
    const deferred: Array<() => void> = [];
    const ensure = () => hold ? new Promise<void>((resolve) => deferred.push(resolve)) : Promise.resolve();
    // The chain's loader is set at construction; use a separately configured
    // instance so the first effect can settle before candidate requests begin.
    const context = graphContext();
    const tracked = new BrowserTrackFxChain(context, ensure);
    expect(tracked.setType(0, 'MANUAL PAN')).toBe(true);
    await settled();
    expect(tracked.getStatus(1).slots[0]?.state).toBe('ready');

    hold = true;
    expect(tracked.setType(0, 'DELAY')).toBe(true);
    expect(tracked.setType(0, 'DSP LPF')).toBe(true);
    expect(deferred).toHaveLength(2);
    deferred[0]!();
    await settled();
    expect(DspWorkletNode.instances).toHaveLength(1);
    expect(tracked.getStatus(1).slots[0]).toMatchObject({ type: 'MANUAL PAN', requestedEffectId: 'DSP LPF', pendingApply: true });

    deferred[1]!();
    await settled();
    expect(tracked.getStatus(1).slots[0]).toMatchObject({ type: 'DSP LPF', pendingApply: false, state: 'ready' });
    expect(DspWorkletNode.instances).toHaveLength(2);
  });

  it('times out a pending candidate, releases it, and keeps incumbent audio connected', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioWorkletNode', DspWorkletNode);
    let hold = false;
    let release!: () => void;
    const ensure = () => hold ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
    const tracked = new BrowserTrackFxChain(graphContext(), ensure);
    expect(tracked.setType(0, 'MANUAL PAN')).toBe(true);
    await settled();
    tracked.setNamedParameters(0, { manualPanPosition: -1, mix: 1 });
    tracked.setActive(0, true);
    for (let warm = 0; warm < 3; warm += 1) render(tracked, signal(2048));
    const input = signal(128);
    const before = render(tracked, input);
    expect(before).not.toEqual(input);

    hold = true;
    expect(tracked.setType(0, 'DSP LPF')).toBe(true);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tracked.getStatus(1).slots[0]).toMatchObject({ type: 'MANUAL PAN', active: true, pendingApply: false, state: 'ready' });
    expect(tracked.getStatus(1).slots[0]!.warning).toContain('readiness timed out');
    const after = render(tracked, input);
    expect(after).toEqual(before);

    release();
    await settled();
    expect(tracked.getStatus(1).slots[0]!.type).toBe('MANUAL PAN');
    expect(DspWorkletNode.instances).toHaveLength(1);
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
    await vi.waitFor(() => expect(engine.getTrackFxStatus(5)[0]!.slots[3]).toMatchObject({ type: 'MANUAL PAN', active: true, state: 'ready' }));
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
