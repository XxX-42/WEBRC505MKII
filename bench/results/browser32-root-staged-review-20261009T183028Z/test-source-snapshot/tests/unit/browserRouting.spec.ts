import { describe, expect, it, vi } from 'vitest';
import {
  BrowserRoutingGraph,
  createDefaultRoutingForSources,
  parseBrowserRoutingState,
  validateBrowserRoutingState,
  type BrowserRoutingSource,
} from '../../src/audio/browserRouting';
import { defaultFXRegistry, type FxNodeGraph } from '../../src/audio/fx/FXRegistry';
import type { FXSnapshot } from '../../src/audio/fx/FXBase';

class FakeParam {
  value = 0;
  setTargetAtTime(value: number): void { this.value = value; }
  cancelScheduledValues(): void { }
  setValueAtTime(value: number): void { this.value = value; }
}

class FakeAudioNode {
  readonly connections: FakeAudioNode[] = [];
  readonly disconnectTargets: Array<FakeAudioNode | null> = [];
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  type = 'lowpass';

  connect(destination: FakeAudioNode): FakeAudioNode {
    this.connections.push(destination);
    return destination;
  }

  disconnect(destination?: FakeAudioNode): void {
    this.disconnectTargets.push(destination ?? null);
    if (destination) {
      const index = this.connections.indexOf(destination);
      if (index >= 0) this.connections.splice(index, 1);
    } else {
      this.connections.length = 0;
    }
  }
}

class FakeAudioContext {
  sampleRate = 48_000;
  currentTime = 0;
  createGain(): FakeAudioNode { return new FakeAudioNode(); }
  createChannelMerger(): FakeAudioNode { return new FakeAudioNode(); }
  createChannelSplitter(): FakeAudioNode { return new FakeAudioNode(); }
  createBiquadFilter(): FakeAudioNode { return new FakeAudioNode(); }
  createMediaStreamDestination(): FakeAudioNode & { stream: object } {
    return Object.assign(new FakeAudioNode(), { stream: {} });
  }
}

class FakeAudioElement {
  static readonly instances: FakeAudioElement[] = [];
  autoplay = false;
  paused = true;
  muted = true;
  volume = 1;
  srcObject: MediaStream | null = null;
  sinkId = '';
  rejectPlay = false;
  readonly rejectedSinks = new Set<string>();

  constructor() { FakeAudioElement.instances.push(this); }
  async setSinkId(sinkId: string): Promise<void> {
    if (this.rejectedSinks.has(sinkId)) throw new Error(`output sink rejected: ${sinkId}`);
    this.sinkId = sinkId;
  }
  async play(): Promise<void> {
    if (this.rejectPlay) throw new Error('output playback was rejected');
    this.paused = false;
  }
  pause(): void { this.paused = true; }
}

const stereoSources: BrowserRoutingSource[] = [
  { id: 'capture', label: 'Synthetic stereo capture', kind: 'capture', channelCount: 2, routingDelayFrames: 0, available: true },
  { id: 'rhythm', label: 'Rhythm engine', kind: 'rhythm', channelCount: 2, routingDelayFrames: 128, available: true },
];

describe('channel-aware browser routing state', () => {
  it('defaults stereo sources to separate LR sends and mono sources to explicit dual-mono sends', () => {
    const stereo = createDefaultRoutingForSources(stereoSources);
    expect(stereo.routes.find((route) => route.sourceId === 'capture' && route.sourceChannel === 0)?.tracks[0]?.targetChannel).toBe('left');
    expect(stereo.routes.find((route) => route.sourceId === 'capture' && route.sourceChannel === 1)?.tracks[0]?.targetChannel).toBe('right');
    expect(stereo.sources.find((source) => source.id === 'rhythm')?.routingDelayFrames).toBe(128);

    const mono = createDefaultRoutingForSources([
      { id: 'capture', label: 'Synthetic mono capture', kind: 'capture', channelCount: 1, routingDelayFrames: 0, available: true },
    ]);
    expect(mono.routes[0]?.tracks[0]?.targetChannel).toBe('both');
  });

  it('validates every matrix row against the actual source channels and fixed five-track schema', () => {
    const defaults = createDefaultRoutingForSources(stereoSources);
    const altered = structuredClone(defaults);
    altered.routes[0]!.tracks[4]!.gain = 0.35;
    altered.routes[0]!.tracks[4]!.targetChannel = 'right';
    const restored = validateBrowserRoutingState(altered, stereoSources);
    expect(restored.routes[0]?.tracks[4]).toMatchObject({ trackId: 5, gain: 0.35, targetChannel: 'right' });

    const invalid = structuredClone(defaults);
    invalid.routes[0]!.sourceChannel = 2;
    expect(() => validateBrowserRoutingState(invalid, stereoSources)).toThrow(/unavailable source channel/);
  });

  it('round-trips the persisted routing schema including source delay and output selections', () => {
    const state = createDefaultRoutingForSources(stereoSources, [{ id: 'silent-test-sink', label: 'Silent test sink' }]);
    state.outputs.headphones.enabled = true;
    state.outputs.headphones.sinkId = 'silent-test-sink';
    const decoded = parseBrowserRoutingState(state);
    expect(decoded).toEqual(state);
  });

  it('updates an observed source quantum without rebuilding or reconnecting its route', async () => {
    vi.stubGlobal('Audio', FakeAudioElement);
    const sourceNode = new FakeAudioNode();
    try {
      const graph = new BrowserRoutingGraph(
        new FakeAudioContext() as unknown as AudioContext,
        new FakeAudioNode() as unknown as AudioWorkletNode,
        new FakeAudioNode() as unknown as AudioNode,
      );
      await graph.setSource({
        id: 'rhythm', node: sourceNode as unknown as AudioNode, label: 'Rhythm engine', kind: 'rhythm', channelCount: 2,
      }, 'rhythm');
      const before = graph.getNodeDiagnostics();
      graph.setSourceRoutingDelayFrames('rhythm', 96);
      expect(graph.getState().sources.find((source) => source.id === 'rhythm')?.routingDelayFrames).toBe(96);
      expect(graph.getNodeDiagnostics()).toEqual(before);
      expect(sourceNode.connections.length).toBeGreaterThan(0);
      expect(() => graph.setSourceRoutingDelayFrames('rhythm', 0.5)).toThrow(/integer between/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rolls back an earlier sink change when a later output sink rejects', async () => {
    FakeAudioElement.instances.length = 0;
    vi.stubGlobal('Audio', FakeAudioElement);
    try {
      const context = new FakeAudioContext();
      const graph = new BrowserRoutingGraph(
        context as unknown as AudioContext,
        new FakeAudioNode() as unknown as AudioWorkletNode,
        new FakeAudioNode() as unknown as AudioNode,
      );
      await graph.setAvailableSinks([
        { deviceId: 'sub-ok', label: 'Synthetic sub sink', kind: 'audiooutput' },
        { deviceId: 'headphones-fail', label: 'Synthetic failing headphones sink', kind: 'audiooutput' },
      ] as unknown as MediaDeviceInfo[]);
      const before = graph.getState();
      const candidate = structuredClone(before);
      candidate.outputs.sub.enabled = true;
      candidate.outputs.sub.sinkId = 'sub-ok';
      candidate.outputs.headphones.enabled = true;
      candidate.outputs.headphones.sinkId = 'headphones-fail';
      FakeAudioElement.instances[1]!.rejectedSinks.add('headphones-fail');

      await expect(graph.applyState(candidate)).rejects.toThrow(/headphones-fail/);
      expect(graph.getState()).toEqual(before);
      expect(FakeAudioElement.instances[0]?.sinkId).toBe('');
      expect(FakeAudioElement.instances[0]?.paused).toBe(true);
      expect(FakeAudioElement.instances[0]?.muted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('disposes staged input-FX nodes and restores the old source when output playback rejects', async () => {
    FakeAudioElement.instances.length = 0;
    vi.stubGlobal('Audio', FakeAudioElement);
    try {
      const context = new FakeAudioContext();
      const graph = new BrowserRoutingGraph(
        context as unknown as AudioContext,
        new FakeAudioNode() as unknown as AudioWorkletNode,
        new FakeAudioNode() as unknown as AudioNode,
      );
      await graph.setInputFxSnapshots([{
        type: 'FILTER', enabled: true, params: { frequency: 0.5, resonance: 0.05 },
      }]);
      const originalNode = new FakeAudioNode();
      await graph.setSource({
        id: 'capture', node: originalNode as unknown as AudioNode, label: 'Original source', kind: 'capture', channelCount: 2,
      }, 'capture');
      const enabledOutput = graph.getState();
      enabledOutput.outputs.sub.enabled = true;
      await graph.applyState(enabledOutput);

      const before = graph.getState();
      const diagnosticsBefore = graph.getNodeDiagnostics();
      const replacementNode = new FakeAudioNode();
      const outputElement = FakeAudioElement.instances[0]!;
      outputElement.paused = true;
      outputElement.rejectPlay = true;
      await expect(graph.setSource({
        id: 'capture', node: replacementNode as unknown as AudioNode, label: 'Replacement source', kind: 'capture', channelCount: 2,
      }, 'capture')).rejects.toThrow(/playback was rejected/);

      expect(graph.getState()).toEqual(before);
      expect(graph.getNodeDiagnostics()).toEqual(diagnosticsBefore);
      expect(replacementNode.disconnectTargets.length).toBeGreaterThan(0);
      expect(replacementNode.connections).toHaveLength(0);
      expect(FakeAudioElement.instances[0]?.paused).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('restores every existing source-pair clone when a later same-shape clone update throws', async () => {
    FakeAudioElement.instances.length = 0;
    vi.stubGlobal('Audio', FakeAudioElement);
    const snapshots: FXSnapshot[] = [{ type: 'FILTER', enabled: true, params: { frequency: 0.2, resonance: 0.1 } }];
    const clones: Array<{ snapshot: FXSnapshot; failAt: number | null }> = [];
    const createGraphSpy = vi.spyOn(defaultFXRegistry, 'createGraph').mockImplementation(async (_context, slots) => {
      const effects = slots.map((slot) => {
        const clone = {
          snapshot: structuredClone(slot!),
          failAt: null as number | null,
          getSnapshot: () => structuredClone(clone.snapshot),
          applySnapshot: (next: FXSnapshot) => {
            clone.snapshot = structuredClone(next);
            if (clone.failAt !== null && next.params.frequency === clone.failAt) {
              clone.failAt = null;
              throw new Error('late input-pair clone failure');
            }
          },
          dispose: () => undefined,
        };
        clones.push(clone);
        return clone;
      });
      return {
        input: new FakeAudioNode() as unknown as AudioNode,
        output: new FakeAudioNode() as unknown as AudioNode,
        effects,
        initialize: async () => undefined,
        dispose: () => undefined,
      } as unknown as FxNodeGraph;
    });
    try {
      const graph = new BrowserRoutingGraph(
        new FakeAudioContext() as unknown as AudioContext,
        new FakeAudioNode() as unknown as AudioWorkletNode,
        new FakeAudioNode() as unknown as AudioNode,
      );
      await graph.setInputFxSnapshots(snapshots);
      await graph.setSource({
        id: 'quad', node: new FakeAudioNode() as unknown as AudioNode,
        label: 'Synthetic four-channel source', kind: 'capture', channelCount: 4,
      }, 'quad');
      expect(clones).toHaveLength(2);
      clones[1]!.failAt = 0.8;

      await expect(graph.setInputFxSnapshots([{
        type: 'FILTER', enabled: true, params: { frequency: 0.8, resonance: 0.4 },
      }])).rejects.toThrow(/late input-pair clone failure/);

      expect(clones.map((clone) => clone.snapshot)).toEqual([snapshots[0], snapshots[0]]);
      expect(graph.getNodeDiagnostics().inputFxPairs).toBe(2);
      expect(graph.getState().sources).toHaveLength(1);
    } finally {
      createGraphSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
