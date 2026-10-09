import { describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine, type FxBankLocation } from '../../src/audio/BrowserAudioEngine';
import type { FXSnapshot } from '../../src/audio/fx/FXBase';
import type { FxNodeGraph } from '../../src/audio/fx/FXRegistry';
import type { ProjectFxBank, ProjectFxUnit } from '../../src/project/projectTypes';

class GraphNode {
  readonly connections = new Set<GraphNode>();
  connect(destination: GraphNode): GraphNode { this.connections.add(destination); return destination; }
  disconnect(destination?: GraphNode): void {
    if (destination) this.connections.delete(destination);
    else this.connections.clear();
  }
}

class MutableEffect {
  readonly name: string;
  readonly input = new GraphNode() as unknown as AudioNode;
  readonly output = new GraphNode() as unknown as AudioNode;
  snapshot: FXSnapshot;

  constructor(snapshot: FXSnapshot) {
    this.name = snapshot.type;
    this.snapshot = structuredClone(snapshot);
  }

  setParam(): void { }
  setBypass(): void { }
  getSnapshot(): FXSnapshot { return structuredClone(this.snapshot); }
  applySnapshot(snapshot: FXSnapshot): void { this.snapshot = structuredClone(snapshot); }
  dispose(): void { }
}

function createGraph(slots: Array<ProjectFxUnit | null>): FxNodeGraph & { disposed: boolean } {
  const graph = {
    input: new GraphNode() as unknown as AudioNode,
    output: new GraphNode() as unknown as AudioNode,
    effects: slots.filter((slot): slot is ProjectFxUnit => slot !== null).map((slot) => new MutableEffect(slot)),
    disposed: false,
    initialize: async () => undefined,
    dispose() { this.disposed = true; },
  };
  return graph;
}

function makeBank(id: string, input: Array<ProjectFxUnit | null>): ProjectFxBank {
  return { id, name: id, input, track: [null, null, null, null], output: [null, null, null, null] };
}

function makeEngine(initialUnit: ProjectFxUnit) {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const previousGraph = createGraph([initialUnit]);
  const source = new GraphNode();
  const destination = new GraphNode();
  source.connect(previousGraph.input as unknown as GraphNode);
  (previousGraph.output as unknown as GraphNode).connect(destination);
  const calls: FXSnapshot[][] = [];
  let failFirstRouteUpdate = true;
  const values: Record<string, unknown> = {
    fxMutationQueue: Promise.resolve(),
    realtimeRuntime: { acquireMutationLease: () => () => undefined },
    activeFxBankId: 'bank-1',
    fxBanks: [makeBank('bank-1', [initialUnit, null, null, null]), ...[2, 3, 4].map((n) => makeBank(`bank-${n}`, [null, null, null, null]))],
    fxGraphs: { input: previousGraph, track: null, output: null },
    inputFxChain: { getSnapshot: () => ({}) },
    inputBankSourceNode: source,
    inputBankReturnNode: destination,
    trackBankSourceNode: new GraphNode(),
    trackBankReturnNode: new GraphNode(),
    outputBankSourceNode: new GraphNode(),
    outputBankReturnNode: new GraphNode(),
    fxStateListeners: new Set(),
    routingGraph: {
      setInputFxSnapshots: async (snapshots: FXSnapshot[]) => {
        calls.push(structuredClone(snapshots));
        if (failFirstRouteUpdate) {
          failFirstRouteUpdate = false;
          throw new Error('injected source clone application failure');
        }
      },
    },
    createBankGraph: async (slots: Array<ProjectFxUnit | null>) => createGraph(slots),
    publishFxState: () => undefined,
  };
  Object.assign(engine, values);
  return {
    engine,
    previousGraph,
    calls,
    getBanks: () => (engine as unknown as { fxBanks: ProjectFxBank[] }).fxBanks,
    getInputGraph: () => (engine as unknown as { fxGraphs: Record<FxBankLocation, FxNodeGraph | null> }).fxGraphs.input,
    routeSource: source,
    routeDestination: destination,
  };
}

describe('BrowserAudioEngine FX slot rollback', () => {
  it('rejects A(shared), B(Browser), C(shared) without reordering or publishing the mixed bank', async () => {
    const shared: ProjectFxUnit = { type: 'SHARED_DSP_FX_1', enabled: true, params: { '1': 1200 } };
    const legacy: ProjectFxUnit = { type: 'FILTER', enabled: true, params: { frequency: 0.4, resonance: 0.1 } };
    const initial = makeBank('bank-1', [null, null, null, null]);
    const engine = Object.assign(Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine, {
      initialized: true,
      realtimeRuntime: { acquireMutationLease: () => () => undefined },
      fxMutationQueue: Promise.resolve(),
      activeFxBankId: 'bank-1',
      fxBanks: [initial, ...[2, 3, 4].map((n) => makeBank(`bank-${n}`, [null, null, null, null]))],
      sharedDspFxCatalog: [{
        ordinal: 1, id: 'rc505mkii.fx.lpf', displayName: 'LPF', family: 'filter',
        officialParametersValidated: false,
        parameters: [{ id: 1, name: 'Frequency', unit: 'Hz', minimum: 20, maximum: 20000, defaultValue: 1200, origin: 0 }],
      }],
    });
    const before = engine.getFxState();
    const mixed = [shared, legacy, shared, null];
    const target = makeBank('bank-1', mixed);

    await expect(engine.applyFxBankStateForProject(
      [target, ...[2, 3, 4].map((n) => makeBank(`bank-${n}`, [null, null, null, null]))],
      'bank-1', Symbol('project-restore'),
    )).rejects.toThrow(/cannot mix shared DSP units with Browser FX units/);

    expect(engine.getFxState()).toEqual(before);
    expect(engine.getFxBanks()[0]?.input).toEqual([null, null, null, null]);
  });

  it('restores in-place parameters and project bank state if source FX cloning fails', async () => {
    const before: ProjectFxUnit = { type: 'FILTER', enabled: true, params: { frequency: 0.2, resonance: 0.1 } };
    const after: ProjectFxUnit = { ...before, params: { frequency: 0.8, resonance: 0.35 } };
    const fixture = makeEngine(before);
    await expect(fixture.engine.updateFxBankSlot('input', 0, after)).rejects.toThrow(/injected source clone/);

    expect(fixture.getBanks()[0]?.input[0]).toEqual(before);
    expect(fixture.previousGraph.effects[0]?.getSnapshot()).toEqual(before);
    expect(fixture.calls.map((call) => call[0])).toEqual([after, before]);
    expect(fixture.getInputGraph()).toBe(fixture.previousGraph);
    expect(fixture.routeSource.connections.has(fixture.previousGraph.input as unknown as GraphNode)).toBe(true);
    expect((fixture.previousGraph.output as unknown as GraphNode).connections.has(fixture.routeDestination)).toBe(true);
  });

  it('restores the previous live graph on a failed type replacement and disposes only the staged graph', async () => {
    const before: ProjectFxUnit = { type: 'FILTER', enabled: true, params: { frequency: 0.2, resonance: 0.1 } };
    const after: ProjectFxUnit = { type: 'COMPRESSOR', enabled: true, params: { amount: 0.7 } };
    const fixture = makeEngine(before);
    let stagedGraph: ReturnType<typeof createGraph> | null = null;
    (fixture.engine as unknown as { createBankGraph: (slots: Array<ProjectFxUnit | null>) => Promise<FxNodeGraph> }).createBankGraph = async (slots) => {
      stagedGraph = createGraph(slots);
      return stagedGraph;
    };

    await expect(fixture.engine.updateFxBankSlot('input', 0, after)).rejects.toThrow(/injected source clone/);

    expect(fixture.getBanks()[0]?.input[0]).toEqual(before);
    expect(fixture.getInputGraph()).toBe(fixture.previousGraph);
    expect(fixture.previousGraph.disposed).toBe(false);
    expect(stagedGraph?.disposed).toBe(true);
    expect(fixture.routeSource.connections.has(fixture.previousGraph.input as unknown as GraphNode)).toBe(true);
    expect((fixture.previousGraph.output as unknown as GraphNode).connections.has(fixture.routeDestination)).toBe(true);
    expect(stagedGraph && fixture.routeSource.connections.has(stagedGraph.input as unknown as GraphNode)).toBe(false);
  });

  it('serializes rapid input-slot edits without publishing a rejected partial snapshot', async () => {
    const first: ProjectFxUnit = { type: 'FILTER', enabled: true, params: { frequency: 0.2, resonance: 0.1 } };
    const second: ProjectFxUnit = { type: 'DELAY', enabled: true, params: { time: 0.25, feedback: 0.3, mix: 0.4 } };
    const fixture = makeEngine(first);
    const setter = vi.fn(async () => undefined);
    (fixture.engine as unknown as { routingGraph: { setInputFxSnapshots: typeof setter } }).routingGraph = { setInputFxSnapshots: setter };
    await Promise.all([
      fixture.engine.updateFxBankSlot('input', 0, second),
      fixture.engine.updateFxBankSlot('input', 1, first),
    ]);
    const bank = fixture.getBanks()[0]!;
    expect(bank.input[0]).toEqual(second);
    expect(bank.input[1]).toEqual(first);
    expect(setter).toHaveBeenCalledTimes(2);
  });
});
