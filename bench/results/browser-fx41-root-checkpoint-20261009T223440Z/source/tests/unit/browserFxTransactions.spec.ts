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

describe('BrowserAudioEngine serial shared-DSP replacement', () => {
  it('finishes the input/track route fade before committing and warming the post-mix master route', async () => {
    const events: string[] = [];
    const bank = makeBank('bank-1', [null, null, null, null]);
    const context = {
      state: 'running',
      sampleRate: 48_000,
      async suspend() { events.push('suspend'); this.state = 'suspended'; },
      async resume() { events.push('resume'); this.state = 'running'; },
    };
    const transitionTimeouts: number[] = [];
    const sharedDspGraph = {
      async stageFxBankPlan() { events.push('stage-input'); return { stageId: 101, warmupFrames: 96_000 }; },
      async commitFxBankPlan() { events.push('commit-input'); return { type: 'SHARED_DSP_FX_BANK_COMMITTED', ok: true }; },
      async rollbackFxBankPlan() { events.push('rollback-input'); return { ok: true }; },
      async abortFxBankPlan() { events.push('abort-input'); return { ok: true }; },
      async finalizeFxBankPlan(_stageId: number, allowUnrenderedFinalize: boolean) {
        events.push(`finalize-input:${allowUnrenderedFinalize}:${context.state}`);
        return { ok: true };
      },
    };
    const masterDspBus = {
      async stageFxBankPlan() { events.push('stage-master'); return { stageId: 202, warmupFrames: 192_000 }; },
      async commitFxBankPlan() { events.push(`commit-master:${context.state}`); return { type: 'MASTER_DSP_FX_BANK_COMMITTED', ok: true }; },
      async rollbackFxBankPlan() { events.push('rollback-master'); return { ok: true }; },
      async abortFxBankPlan() { events.push('abort-master'); return { ok: true }; },
      async finalizeFxBankPlan(_stageId: number, allowUnrenderedFinalize: boolean) {
        events.push(`finalize-master:${allowUnrenderedFinalize}:${context.state}`);
        return { ok: true };
      },
    };
    const engine = Object.assign(Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine, {
      context,
      realtimeRuntime: {},
      routingGraph: { async setInputFxSnapshots() { events.push('set-input-snapshots'); } },
      sharedDspGraph,
      masterDspBus,
      fxMutationQueue: Promise.resolve(),
      fxBanks: [bank],
      activeFxBankId: 'bank-1',
      fxGraphs: { input: null, track: null, output: null },
      getInputFxSnapshots: () => [],
      createBankGraphs: async () => ({ input: null, track: null, output: null }),
      replaceBankGraphs: () => { events.push('replace-legacy-graphs'); },
      disposeGraphs: () => { events.push('dispose-legacy-graphs'); },
      publishFxState: () => { events.push('publish-state'); },
      waitForSharedFxTransition: async (indices: readonly number[], timeoutMs: number) => {
        events.push(`wait-${indices.join(',')}`);
        transitionTimeouts.push(timeoutMs);
      },
    });

    await (engine as unknown as { installFxBankState(banks: ProjectFxBank[], id: string): Promise<void> })
      .installFxBankState([bank], 'bank-1');

    expect(events.indexOf('wait-0')).toBeLessThan(events.indexOf('commit-master:running'));
    expect(events.indexOf('commit-master:running')).toBeLessThan(events.indexOf('wait-1'));
    expect(events.slice(events.indexOf('wait-0') + 1, events.indexOf('commit-master:running'))).not.toContain('suspend');
    expect(events.indexOf('wait-1')).toBeLessThan(events.indexOf('finalize-input:false:suspended'));
    expect(events.indexOf('wait-1')).toBeLessThan(events.indexOf('finalize-master:false:suspended'));
    expect(events.indexOf('finalize-master:false:suspended')).toBeLessThan(events.indexOf('resume', events.indexOf('wait-1')));
    expect(events.at(-1)).toBe('resume');
    expect(context.state).toBe('running');
    expect(transitionTimeouts).toEqual([5_020, 9_020]);
  });

  it('keeps the new bank committed and retries idempotent finalization after one Worklet rejects', async () => {
    const events: string[] = [];
    const context = {
      state: 'running',
      sampleRate: 48_000,
      async suspend() { events.push('suspend'); this.state = 'suspended'; },
      async resume() { events.push('resume'); this.state = 'running'; },
    };
    const oldGraph = { disposed: false, dispose() { this.disposed = true; events.push('dispose-old'); } };
    let inputFinalizeCalls = 0;
    let masterFinalizeCalls = 0;
    const sharedDspGraph = {
      async stageFxBankPlan() { return { stageId: 301, warmupFrames: 0 }; },
      async commitFxBankPlan() { return { ok: true }; },
      async rollbackFxBankPlan() { return { ok: true }; },
      async abortFxBankPlan() { return { ok: true }; },
      async finalizeFxBankPlan() {
        inputFinalizeCalls += 1;
        events.push(`finalize-input-${inputFinalizeCalls}`);
        if (inputFinalizeCalls === 1) throw new Error('injected lost input finalization ACK');
        return { ok: true };
      },
    };
    const masterDspBus = {
      async stageFxBankPlan() { return { stageId: 302, warmupFrames: 0 }; },
      async commitFxBankPlan() { return { ok: true }; },
      async rollbackFxBankPlan() { return { ok: true }; },
      async abortFxBankPlan() { return { ok: true }; },
      async finalizeFxBankPlan() {
        masterFinalizeCalls += 1;
        events.push(`finalize-master-${masterFinalizeCalls}`);
        return { ok: true };
      },
    };
    const currentBank = makeBank('bank-1', [null, null, null, null]);
    const nextBank = { ...currentBank, name: 'committed replacement' };
    const engine = Object.assign(Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine, {
      context,
      realtimeRuntime: {},
      routingGraph: { async setInputFxSnapshots() { return undefined; } },
      sharedDspGraph,
      masterDspBus,
      fxMutationQueue: Promise.resolve(),
      fxBanks: [currentBank],
      activeFxBankId: 'bank-1',
      fxGraphs: { input: oldGraph, track: null, output: null },
      getInputFxSnapshots: () => [],
      createBankGraphs: async () => ({ input: null, track: null, output: null }),
      replaceBankGraphs: () => events.push('replace-legacy'),
      publishFxState: () => events.push('publish'),
      waitForSharedFxTransition: async () => undefined,
      recordRuntimeError: (error: Error) => events.push(`runtime-error:${error.message}`),
      pendingSharedFxFinalization: null,
    });

    await (engine as unknown as { installFxBankState(banks: ProjectFxBank[], id: string): Promise<void> })
      .installFxBankState([nextBank], 'bank-1');

    expect((engine as unknown as { fxBanks: ProjectFxBank[] }).fxBanks[0]?.name).toBe('committed replacement');
    expect(inputFinalizeCalls).toBe(2);
    expect(masterFinalizeCalls).toBe(2);
    expect(oldGraph.disposed).toBe(true);
    expect((engine as unknown as { pendingSharedFxFinalization: unknown }).pendingSharedFxFinalization).toBeNull();
    expect(events.filter((event) => event.startsWith('runtime-error:'))).toEqual([]);
  });

  it('keeps a committed bank consistent while a retired Worklet chain awaits cleanup', async () => {
    const events: string[] = [];
    const context = {
      state: 'running',
      sampleRate: 48_000,
      async suspend() { events.push('suspend'); this.state = 'suspended'; },
      async resume() { events.push('resume'); this.state = 'running'; },
    };
    let inputCleanupPending = 1024;
    let masterCleanupPending = 2048;
    let rejectInputFinalize = true;
    let inputFinalizeCalls = 0;
    let masterFinalizeCalls = 0;
    let stageCalls = 0;
    let disposeCalls = 0;
    const sharedDspGraph = {
      async stageFxBankPlan() { stageCalls += 1; return { stageId: 401, warmupFrames: 0 }; },
      async commitFxBankPlan() { return { ok: true }; },
      async rollbackFxBankPlan() { return { ok: true }; },
      async abortFxBankPlan() { return { ok: true }; },
      async finalizeFxBankPlan() {
        inputFinalizeCalls += 1;
        if (rejectInputFinalize) throw new Error('input retired-chain release is temporarily unavailable');
        inputCleanupPending = 0;
        return { ok: true };
      },
    };
    const masterDspBus = {
      async stageFxBankPlan() { return { stageId: 402, warmupFrames: 0 }; },
      async commitFxBankPlan() { return { ok: true }; },
      async rollbackFxBankPlan() { return { ok: true }; },
      async abortFxBankPlan() { return { ok: true }; },
      async finalizeFxBankPlan() {
        masterFinalizeCalls += 1;
        masterCleanupPending = 0;
        return { ok: true };
      },
    };
    const currentBank = makeBank('bank-1', [null, null, null, null]);
    const committedBank = { ...currentBank, name: 'committed despite pending cleanup' };
    const oldGraph = { dispose() { disposeCalls += 1; events.push('dispose-old'); } };
    const engine = Object.assign(Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine, {
      context,
      realtimeRuntime: {},
      routingGraph: { async setInputFxSnapshots() { return undefined; } },
      sharedDspGraph,
      masterDspBus,
      fxMutationQueue: Promise.resolve(),
      fxBanks: [currentBank],
      activeFxBankId: 'bank-1',
      fxGraphs: { input: oldGraph, track: null, output: null },
      getInputFxSnapshots: () => [],
      createBankGraphs: async () => ({ input: null, track: null, output: null }),
      replaceBankGraphs: () => undefined,
      publishFxState: () => undefined,
      waitForSharedFxTransition: async () => undefined,
      recordRuntimeError: (error: Error) => events.push(`runtime-error:${error.message}`),
      pendingSharedFxFinalization: null,
    });
    const install = (banks: ProjectFxBank[], id: string) =>
      (engine as unknown as { installFxBankState(banks: ProjectFxBank[], id: string): Promise<void> })
        .installFxBankState(banks, id);
    const retryCleanup = () =>
      (engine as unknown as { retryPendingSharedFxFinalization(): Promise<void> })
        .retryPendingSharedFxFinalization();

    await install([committedBank], 'bank-1');
    expect((engine as unknown as { fxBanks: ProjectFxBank[] }).fxBanks[0]?.name)
      .toBe('committed despite pending cleanup');
    expect(inputCleanupPending).toBe(1024);
    expect(masterCleanupPending).toBe(0);
    expect(disposeCalls).toBe(1);
    expect((engine as unknown as { pendingSharedFxFinalization: unknown }).pendingSharedFxFinalization)
      .toMatchObject({ inputStageId: 401, masterStageId: 402 });
    expect(inputFinalizeCalls).toBe(2);
    expect(masterFinalizeCalls).toBe(2);

    const secondBank = { ...committedBank, name: 'must wait for cleanup' };
    await expect(install([secondBank], 'bank-1')).rejects.toThrow('retired DSP cleanup is still pending');
    expect(stageCalls).toBe(1);
    expect((engine as unknown as { fxBanks: ProjectFxBank[] }).fxBanks[0]?.name)
      .toBe('committed despite pending cleanup');
    expect(context.state).toBe('running');

    rejectInputFinalize = false;
    await retryCleanup();
    expect(inputCleanupPending).toBe(0);
    expect(masterCleanupPending).toBe(0);
    expect((engine as unknown as { pendingSharedFxFinalization: unknown }).pendingSharedFxFinalization).toBeNull();
    expect(inputFinalizeCalls).toBe(5);
    expect(masterFinalizeCalls).toBe(5);
    expect(disposeCalls).toBe(1);
    expect(context.state).toBe('running');
  });

  it('reports a post-commit resume failure without presenting the committed bank as rolled back', async () => {
    const events: string[] = [];
    let resumeCalls = 0;
    let disposeCalls = 0;
    const context = {
      state: 'running',
      sampleRate: 48_000,
      async suspend() { this.state = 'suspended'; },
      async resume() {
        resumeCalls += 1;
        if (resumeCalls === 2) throw new Error('injected resume failure after commit');
        this.state = 'running';
      },
    };
    const currentBank = makeBank('bank-1', [null, null, null, null]);
    const committedBank = { ...currentBank, name: 'committed while context remains suspended' };
    const sharedDspGraph = {
      async stageFxBankPlan() { return { stageId: 501, warmupFrames: 0 }; },
      async commitFxBankPlan() { return { ok: true }; },
      async rollbackFxBankPlan() { return { ok: true }; },
      async abortFxBankPlan() { return { ok: true }; },
      async finalizeFxBankPlan() { return { ok: true }; },
    };
    const masterDspBus = {
      async stageFxBankPlan() { return { stageId: 502, warmupFrames: 0 }; },
      async commitFxBankPlan() { return { ok: true }; },
      async rollbackFxBankPlan() { return { ok: true }; },
      async abortFxBankPlan() { return { ok: true }; },
      async finalizeFxBankPlan() { return { ok: true }; },
    };
    const engine = Object.assign(Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine, {
      context,
      realtimeRuntime: {},
      routingGraph: { async setInputFxSnapshots() { return undefined; } },
      sharedDspGraph,
      masterDspBus,
      fxMutationQueue: Promise.resolve(),
      fxBanks: [currentBank],
      activeFxBankId: 'bank-1',
      fxGraphs: { input: { dispose() { disposeCalls += 1; } }, track: null, output: null },
      getInputFxSnapshots: () => [],
      createBankGraphs: async () => ({ input: null, track: null, output: null }),
      replaceBankGraphs: () => undefined,
      publishFxState: () => undefined,
      waitForSharedFxTransition: async () => undefined,
      recordRuntimeError: (error: Error) => events.push(error.message),
      pendingSharedFxFinalization: null,
    });

    await expect((engine as unknown as {
      installFxBankState(banks: ProjectFxBank[], id: string): Promise<void>;
    }).installFxBankState([committedBank], 'bank-1')).resolves.toBeUndefined();

    expect((engine as unknown as { fxBanks: ProjectFxBank[] }).fxBanks[0]?.name)
      .toBe('committed while context remains suspended');
    expect(resumeCalls).toBe(2);
    expect(context.state).toBe('suspended');
    expect(disposeCalls).toBe(1);
    expect(events).toEqual(['injected resume failure after commit']);
  });

  it('rejects a candidate runtime failure reported through the shared transition counter', async () => {
    const context = { state: 'running' };
    const transition = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const words = new Int32Array(transition);
    words[0] = -1;
    const engine = Object.assign(Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine, {
      context,
      sharedFxTransitionBuffer: transition,
    });
    await expect((engine as unknown as {
      waitForSharedFxTransition(indices: readonly (0 | 1)[], timeoutMs: number): Promise<void>;
    }).waitForSharedFxTransition([0], 1_000)).rejects.toThrow('failed while warming or rendering');
  });
});
