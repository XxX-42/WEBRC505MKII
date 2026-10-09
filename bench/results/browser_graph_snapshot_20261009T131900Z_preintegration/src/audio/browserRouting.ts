import type { FXSnapshot } from './fx/FXBase';
import { defaultFXRegistry, type FxNodeGraph } from './fx/FXRegistry';

export type BrowserRoutingSourceKind = 'capture' | 'rhythm';
export type BrowserRoutingChannelTarget = 'left' | 'right' | 'both';
export type BrowserRoutingBus = 'main' | 'sub' | 'headphones';

export interface BrowserRoutingSource {
  id: string;
  label: string;
  kind: BrowserRoutingSourceKind;
  channelCount: number;
  /** Deliberate graph delay added by this route, in samples. */
  routingDelayFrames: number;
  available: boolean;
}

export interface BrowserRoutingInputChannel {
  sourceId: string;
  sourceChannel: number;
  eq: { enabled: boolean; lowCutHz: number; highCutHz: number; gainDb: number };
}

export interface BrowserRoutingTrackSend {
  trackId: number;
  gain: number;
  targetChannel: BrowserRoutingChannelTarget;
}

export interface BrowserRoutingRoute {
  sourceId: string;
  sourceChannel: number;
  tracks: BrowserRoutingTrackSend[];
  mainGain: number;
  mainTargetChannel: BrowserRoutingChannelTarget;
  subGain: number;
  subTargetChannel: BrowserRoutingChannelTarget;
  headphonesGain: number;
  headphonesTargetChannel: BrowserRoutingChannelTarget;
}

export interface BrowserRoutingSink {
  id: string;
  label: string;
}

export interface BrowserRoutingOutput {
  available: boolean;
  enabled: boolean;
  sinkId: string | null;
  availableSinks: BrowserRoutingSink[];
}

export interface BrowserRoutingState {
  version: 1;
  sources: BrowserRoutingSource[];
  inputChannels: BrowserRoutingInputChannel[];
  routes: BrowserRoutingRoute[];
  outputs: Record<BrowserRoutingBus, BrowserRoutingOutput>;
}

export interface BrowserRoutingPatch {
  inputChannels?: BrowserRoutingInputChannel[];
  routes?: BrowserRoutingRoute[];
  outputs?: Partial<Record<BrowserRoutingBus, Partial<BrowserRoutingOutput>>>;
}

export interface BrowserRoutingSourceNode {
  id: string;
  node: AudioNode;
  label: string;
  kind: BrowserRoutingSourceKind;
  channelCount: number;
  routingDelayFrames?: number;
}

interface SourceInputFxGraph {
  sourceNode: AudioNode;
  sourceChannelCount: number;
  sourceSplitter: ChannelSplitterNode;
  output: ChannelMergerNode;
  pairInputs: ChannelMergerNode[];
  pairOutputs: ChannelSplitterNode[];
  graphs: FxNodeGraph[];
}

const DEFAULT_EQ = { enabled: false, lowCutHz: 20, highCutHz: 20_000, gainDb: 0 };

function routeTarget(channelCount: number, sourceChannel: number): BrowserRoutingChannelTarget {
  return channelCount === 1 ? 'both' : sourceChannel % 2 === 0 ? 'left' : 'right';
}

function createOutput(available: boolean): BrowserRoutingOutput {
  return { available, enabled: false, sinkId: null, availableSinks: [] };
}

function defaultRoute(source: BrowserRoutingSource, sourceChannel: number): BrowserRoutingRoute {
  const targetChannel = routeTarget(source.channelCount, sourceChannel);
  const isCapture = source.kind === 'capture';
  return {
    sourceId: source.id,
    sourceChannel,
    tracks: Array.from({ length: 5 }, (_, index) => ({
      trackId: index + 1,
      gain: isCapture ? 1 : 0,
      targetChannel,
    })),
    mainGain: isCapture ? 1 : 0,
    mainTargetChannel: targetChannel,
    subGain: 0,
    subTargetChannel: targetChannel,
    headphonesGain: 0,
    headphonesTargetChannel: targetChannel,
  };
}

export function createDefaultRoutingForSources(
  sources: readonly BrowserRoutingSource[],
  sinks: readonly BrowserRoutingSink[] = [],
): BrowserRoutingState {
  const activeSources = sources.filter((source) => source.available);
  return {
    version: 1,
    sources: activeSources.map((source) => ({ ...source })),
    inputChannels: activeSources.flatMap((source) => Array.from({ length: source.channelCount }, (_, sourceChannel) => ({
      sourceId: source.id, sourceChannel, eq: { ...DEFAULT_EQ },
    }))),
    routes: activeSources.flatMap((source) => Array.from({ length: source.channelCount }, (_, sourceChannel) => defaultRoute(source, sourceChannel))),
    outputs: {
      main: { available: true, enabled: true, sinkId: null, availableSinks: sinks.map((sink) => ({ ...sink })) },
      sub: { available: true, enabled: false, sinkId: null, availableSinks: sinks.map((sink) => ({ ...sink })) },
      headphones: { available: true, enabled: false, sinkId: null, availableSinks: sinks.map((sink) => ({ ...sink })) },
    },
  };
}

export function createDefaultBrowserRoutingState(): BrowserRoutingState {
  return {
    version: 1,
    sources: [],
    inputChannels: [],
    routes: [],
    outputs: { main: { ...createOutput(true), enabled: true }, sub: createOutput(false), headphones: createOutput(false) },
  };
}

export function validateBrowserRoutingState(value: unknown, availableSources: readonly BrowserRoutingSource[]): BrowserRoutingState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Routing state must be an object.');
  const candidate = value as Partial<BrowserRoutingState>;
  if (candidate.version !== 1 || !Array.isArray(candidate.inputChannels) || !Array.isArray(candidate.routes) || !candidate.outputs) {
    throw new TypeError('Routing state has an unsupported shape or version.');
  }
  const sourceMap = new Map(availableSources.map((source) => [source.id, source]));
  const validateSourceChannel = (sourceId: unknown, sourceChannel: unknown): BrowserRoutingSource => {
    if (typeof sourceId !== 'string' || !Number.isInteger(sourceChannel) || Number(sourceChannel) < 0) {
      throw new TypeError('Routing source channel is invalid.');
    }
    const source = sourceMap.get(sourceId);
    if (!source?.available || Number(sourceChannel) >= source.channelCount) {
      throw new RangeError(`Routing references unavailable source channel ${sourceId}:${String(sourceChannel)}.`);
    }
    return source;
  };
  const targetChannels: readonly string[] = ['left', 'right', 'both'];
  const normalizedInputs = candidate.inputChannels.map((entry) => {
    const source = validateSourceChannel(entry.sourceId, entry.sourceChannel);
    const eq = entry.eq;
    if (!eq || typeof eq.enabled !== 'boolean' || !Number.isFinite(eq.lowCutHz) || eq.lowCutHz < 20 || eq.lowCutHz > 20_000
      || !Number.isFinite(eq.highCutHz) || eq.highCutHz < 20 || eq.highCutHz > 20_000
      || !Number.isFinite(eq.gainDb) || eq.gainDb < -24 || eq.gainDb > 24 || eq.lowCutHz >= eq.highCutHz) {
      throw new RangeError(`Input EQ for ${source.id}:${entry.sourceChannel} is invalid.`);
    }
    return { sourceId: source.id, sourceChannel: Number(entry.sourceChannel), eq: { ...eq } };
  });
  const normalizedRoutes = candidate.routes.map((entry) => {
    const source = validateSourceChannel(entry.sourceId, entry.sourceChannel);
    if (!Array.isArray(entry.tracks) || entry.tracks.length !== 5) throw new TypeError('Every source route must contain five track sends.');
    const tracks = entry.tracks.map((send, index) => {
      if (send.trackId !== index + 1 || !Number.isFinite(send.gain) || send.gain < 0 || send.gain > 2 || !targetChannels.includes(send.targetChannel)) {
        throw new RangeError('A track routing send is invalid.');
      }
      return { ...send };
    });
    for (const [gainName, targetName] of [
      ['mainGain', 'mainTargetChannel'], ['subGain', 'subTargetChannel'], ['headphonesGain', 'headphonesTargetChannel'],
    ] as const) {
      const gain = entry[gainName];
      const target = entry[targetName];
      if (!Number.isFinite(gain) || gain < 0 || gain > 2 || !targetChannels.includes(target)) {
        throw new RangeError(`${gainName} routing send is invalid.`);
      }
    }
    return {
      sourceId: source.id,
      sourceChannel: Number(entry.sourceChannel),
      tracks,
      mainGain: entry.mainGain,
      mainTargetChannel: entry.mainTargetChannel,
      subGain: entry.subGain,
      subTargetChannel: entry.subTargetChannel,
      headphonesGain: entry.headphonesGain,
      headphonesTargetChannel: entry.headphonesTargetChannel,
    };
  });
  const outputs = {} as BrowserRoutingState['outputs'];
  for (const bus of ['main', 'sub', 'headphones'] as const) {
    const output = candidate.outputs[bus];
    if (!output || typeof output.enabled !== 'boolean' || (output.sinkId !== null && typeof output.sinkId !== 'string') || !Array.isArray(output.availableSinks)) {
      throw new TypeError(`${bus} output routing state is invalid.`);
    }
    outputs[bus] = { ...output, availableSinks: output.availableSinks.map((sink) => ({ ...sink })) };
  }
  return {
    version: 1,
    sources: availableSources.map((source) => ({ ...source })),
    inputChannels: normalizedInputs,
    routes: normalizedRoutes,
    outputs,
  };
}

export function parseBrowserRoutingState(value: unknown): BrowserRoutingState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Stored routing state must be an object.');
  const candidate = value as Partial<BrowserRoutingState>;
  if (!Array.isArray(candidate.sources) || candidate.sources.length > 32) throw new TypeError('Stored routing state has an invalid source list.');
  const ids = new Set<string>();
  const sources = candidate.sources.map((value) => {
    if (!value || typeof value !== 'object') throw new TypeError('Stored routing source must be an object.');
    const source = value as BrowserRoutingSource;
    if (typeof source.id !== 'string' || !source.id || source.id.length > 128 || ids.has(source.id)
      || typeof source.label !== 'string' || source.label.length > 256
      || (source.kind !== 'capture' && source.kind !== 'rhythm')
      || !Number.isInteger(source.channelCount) || source.channelCount < 1 || source.channelCount > 32
      || !Number.isInteger(source.routingDelayFrames) || source.routingDelayFrames < 0 || source.routingDelayFrames > 48_000
      || typeof source.available !== 'boolean') {
      throw new TypeError('Stored routing source metadata is invalid.');
    }
    ids.add(source.id);
    return { ...source };
  });
  return validateBrowserRoutingState(candidate, sources);
}

/** Owns only routing-created Web Audio nodes; source nodes remain engine-owned. */
export class BrowserRoutingGraph {
  private readonly context: AudioContext;
  private state = createDefaultBrowserRoutingState();
  private sources = new Map<string, BrowserRoutingSourceNode>();
  private readonly inputSplitters = new Map<string, ChannelSplitterNode>();
  private readonly splitterSources = new Map<string, AudioNode>();
  private readonly inputFxGraphs = new Map<string, SourceInputFxGraph>();
  private readonly inputFxGraphSources = new Map<string, AudioNode>();
  private inputFxSnapshots: FXSnapshot[] = [];
  private readonly channelPaths = new Map<string, { gain: GainNode; filters: BiquadFilterNode[] }>();
  private readonly routeGainNodes = new Map<string, {
    node: GainNode;
    source: AudioNode;
    destination: ChannelMergerNode;
    target: BrowserRoutingChannelTarget;
  }>();
  private routeRebuildCount = 0;
  private readonly channelMergers: ChannelMergerNode[];
  private readonly monitorMerger: ChannelMergerNode;
  private readonly outputMergers: Record<'sub' | 'headphones', ChannelMergerNode>;
  private readonly mainDestinationGain: GainNode;
  private readonly outputGains: Record<'sub' | 'headphones', GainNode>;
  private readonly outputDestinations: Record<'sub' | 'headphones', MediaStreamAudioDestinationNode>;
  private readonly outputElements: Record<'sub' | 'headphones', HTMLAudioElement>;
  private readonly listeners = new Set<(state: BrowserRoutingState) => void>();
  private readonly sinks: BrowserRoutingSink[] = [];

  constructor(
    context: AudioContext,
    workletNode: AudioWorkletNode,
    masterOutput: AudioNode,
  ) {
    this.context = context;
    this.channelMergers = Array.from({ length: 5 }, (_, track) => {
      const merger = context.createChannelMerger(2);
      merger.connect(workletNode, 0, track + 1);
      return merger;
    });
    this.monitorMerger = context.createChannelMerger(2);
    // Source-level input FX runs once before this split. The processed signal
    // fans out to the track record ports and the sample-gated monitor port.
    this.monitorMerger.connect(workletNode, 0, 0);
    this.mainDestinationGain = context.createGain();
    this.mainDestinationGain.gain.value = 1;
    masterOutput.connect(this.mainDestinationGain);
    this.mainDestinationGain.connect(context.destination);
    this.outputMergers = { sub: context.createChannelMerger(2), headphones: context.createChannelMerger(2) };
    this.outputGains = { sub: context.createGain(), headphones: context.createGain() };
    this.outputDestinations = {
      sub: context.createMediaStreamDestination(),
      headphones: context.createMediaStreamDestination(),
    };
    this.outputElements = { sub: new Audio(), headphones: new Audio() };
    for (const bus of ['sub', 'headphones'] as const) {
      const gain = this.outputGains[bus];
      const element = this.outputElements[bus];
      this.outputMergers[bus].connect(gain);
      masterOutput.connect(gain);
      gain.connect(this.outputDestinations[bus]);
      element.srcObject = this.outputDestinations[bus].stream;
      element.autoplay = true;
      element.muted = true;
      element.volume = 1;
    }
    this.state = {
      ...this.state,
      outputs: {
        main: { ...createOutput(true), enabled: true },
        sub: createOutput(true),
        headphones: createOutput(true),
      },
    };
  }

  getState(): BrowserRoutingState { return structuredClone(this.state); }

  getNodeDiagnostics(): { sourceSplitters: number; channelPaths: number; routeSends: number; inputFxPairs: number; routeRebuildCount: number } {
    return {
      sourceSplitters: this.inputSplitters.size,
      channelPaths: this.channelPaths.size,
      routeSends: this.routeGainNodes.size,
      inputFxPairs: [...this.inputFxGraphs.values()].reduce((count, graph) => count + graph.graphs.length, 0),
      routeRebuildCount: this.routeRebuildCount,
    };
  }

  async resetState(): Promise<void> {
    const sinks = this.state.outputs.main.availableSinks;
    const next = createDefaultRoutingForSources(this.state.sources, sinks);
    next.outputs.main.sinkId = this.state.outputs.main.sinkId;
    await this.applyState(next);
  }

  async setInputFxSnapshots(snapshots: readonly FXSnapshot[]): Promise<void> {
    const next = snapshots.map((snapshot) => structuredClone(snapshot));
    const sameShape = next.length === this.inputFxSnapshots.length && next.every((snapshot, index) =>
      snapshot.type.toUpperCase() === this.inputFxSnapshots[index]?.type.toUpperCase());
    const sourceIds = [...this.sources.keys()].sort();
    const graphIds = [...this.inputFxGraphs.keys()].sort();
    const sameSources = sourceIds.length === graphIds.length && sourceIds.every((id, index) => id === graphIds[index]);
    if (sameShape && sameSources && sourceIds.every((id) => this.inputFxGraphSources.get(id) === this.sources.get(id)?.node
      && this.inputFxGraphs.get(id)?.sourceChannelCount === this.sources.get(id)?.channelCount)) {
      const previous = this.inputFxSnapshots.map((snapshot) => structuredClone(snapshot));
      try {
        for (const sourceGraph of this.inputFxGraphs.values()) {
          for (const graph of sourceGraph.graphs) {
            if (graph.effects.length !== next.length) throw new Error('Input FX clone graph does not match its saved slots.');
            graph.effects.forEach((effect, index) => effect.applySnapshot(next[index]!));
          }
        }
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const sourceGraph of this.inputFxGraphs.values()) {
          for (const graph of sourceGraph.graphs) {
            graph.effects.forEach((effect, index) => {
              const snapshot = previous[index];
              if (!snapshot) return;
              try { effect.applySnapshot(snapshot); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
            });
          }
        }
        if (rollbackErrors.length > 0) {
          const rollbackError = new Error('Input FX update failed and one or more source clones could not be restored.');
          Object.assign(rollbackError, { cause: error, rollbackErrors });
          throw rollbackError;
        }
        throw error;
      }
      this.inputFxSnapshots = next;
      return;
    }

    const staged = new Map<string, SourceInputFxGraph>();
    try {
      if (next.length > 0) {
        for (const sourceId of sourceIds) {
          const source = this.sources.get(sourceId);
          if (source) staged.set(sourceId, await this.createSourceInputFxGraph(source, next));
        }
      }
    } catch (error) {
      for (const [sourceId, graph] of staged) this.disposeSourceInputFxGraph(sourceId, graph);
      throw error;
    }
    this.disconnectOwnedRoutes();
    this.disposeInputFxGraphs();
    this.inputFxSnapshots = next;
    for (const [sourceId, graph] of staged) {
      if (!this.sources.has(sourceId)) { this.disposeSourceInputFxGraph(sourceId, graph); continue; }
      this.inputFxGraphs.set(sourceId, graph);
      this.inputFxGraphSources.set(sourceId, graph.sourceNode);
    }
    this.rebuildInputRoutes();
  }

  subscribe(listener: (state: BrowserRoutingState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  async setAvailableSinks(devices: readonly MediaDeviceInfo[]): Promise<void> {
    this.sinks.splice(0, this.sinks.length, ...devices
      .filter((device) => device.kind === 'audiooutput')
      .map((device) => ({ id: device.deviceId, label: device.label || 'Audio output' })));
    const next = this.getState();
    for (const bus of ['main', 'sub', 'headphones'] as const) next.outputs[bus].availableSinks = this.sinks.map((sink) => ({ ...sink }));
    this.state = validateBrowserRoutingState(next, this.state.sources);
    this.emit();
  }

  async setSource(source: BrowserRoutingSourceNode | null, sourceId: string): Promise<void> {
    const previousSource = this.sources.get(sourceId);
    if (source) this.sources.set(sourceId, source);
    else this.sources.delete(sourceId);
    const sources: BrowserRoutingSource[] = [...this.sources.values()].map(({ id, label, kind, channelCount, routingDelayFrames }) => ({
      id, label, kind, channelCount, routingDelayFrames: routingDelayFrames ?? 0, available: true,
    }));
    const previousInputs = new Map(this.state.inputChannels.map((input) => [`${input.sourceId}:${input.sourceChannel}`, input]));
    const previousRoutes = new Map(this.state.routes.map((route) => [`${route.sourceId}:${route.sourceChannel}`, route]));
    const inputChannels: BrowserRoutingInputChannel[] = [];
    const routes: BrowserRoutingRoute[] = [];
    for (const currentSource of sources) {
      for (let channel = 0; channel < currentSource.channelCount; channel += 1) {
        const key = `${currentSource.id}:${channel}`;
        inputChannels.push(previousInputs.get(key) ?? { sourceId: currentSource.id, sourceChannel: channel, eq: { ...DEFAULT_EQ } });
        routes.push(previousRoutes.get(key) ?? defaultRoute(currentSource, channel));
      }
    }
    const next = { ...this.state, sources, inputChannels, routes };
    try {
      await this.applyState(next);
    } catch (error) {
      const committed = source === null
        ? !this.inputSplitters.has(sourceId) && !this.inputFxGraphs.has(sourceId)
        : this.inputSplitters.has(sourceId) && (this.inputFxGraphs.has(sourceId)
          ? this.inputFxGraphSources.get(sourceId) === source.node &&
            this.splitterSources.get(sourceId) === this.inputFxGraphs.get(sourceId)?.output
          : this.splitterSources.get(sourceId) === source.node);
      if (!committed) {
        if (previousSource) this.sources.set(sourceId, previousSource);
        else this.sources.delete(sourceId);
      }
      throw error;
    }
  }

  async applyPatch(patch: BrowserRoutingPatch): Promise<void> {
    const next = this.getState();
    if (patch.inputChannels) next.inputChannels = patch.inputChannels.map((entry) => ({ ...entry, eq: { ...entry.eq } }));
    if (patch.routes) next.routes = patch.routes.map((entry) => ({ ...entry, tracks: entry.tracks.map((send) => ({ ...send })) }));
    if (patch.outputs) {
      for (const bus of ['main', 'sub', 'headphones'] as const) {
        if (patch.outputs[bus]) next.outputs[bus] = { ...next.outputs[bus], ...patch.outputs[bus] };
      }
    }
    await this.applyState(next);
  }

  async applyState(candidate: BrowserRoutingState): Promise<void> {
    const availableSources: BrowserRoutingSource[] = [...this.sources.values()].map(({ id, label, kind, channelCount, routingDelayFrames }) => ({
      id, label, kind, channelCount, routingDelayFrames: routingDelayFrames ?? 0, available: true,
    }));
    const next = validateBrowserRoutingState(candidate, availableSources);
    next.outputs.main.available = true;
    next.outputs.sub.available = true;
    next.outputs.headphones.available = true;
    for (const bus of ['sub', 'headphones'] as const) {
      const output = next.outputs[bus];
      const element = this.outputElements[bus] as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
      if (output.sinkId && output.availableSinks.length > 0 && !output.availableSinks.some((sink) => sink.id === output.sinkId)) {
        throw new Error(`The selected ${bus} output sink is unavailable.`);
      }
      if (output.sinkId !== this.state.outputs[bus].sinkId && typeof element.setSinkId !== 'function') {
        throw new Error(`This browser cannot select a ${bus} output sink.`);
      }
    }
    const topologyChanged = this.isRoutingTopologyChanged(next);
    let stagedGraphs: Map<string, SourceInputFxGraph> | null = null;
    if (topologyChanged && this.hasInputFxSourceTopologyChanged()) {
      stagedGraphs = await this.createInputFxGraphs();
    }
    const outputBefore = new Map(['sub', 'headphones'].map((bus) => {
      const element = this.outputElements[bus as 'sub' | 'headphones'];
      return [bus, { paused: element.paused, muted: element.muted }] as const;
    }));
    const attemptedSinkChanges: Array<'sub' | 'headphones'> = [];
    try {
      for (const bus of ['sub', 'headphones'] as const) {
        const output = next.outputs[bus];
        const element = this.outputElements[bus] as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
        if (output.sinkId !== this.state.outputs[bus].sinkId) {
          attemptedSinkChanges.push(bus);
          await element.setSinkId!(output.sinkId ?? '');
        }
        if (output.enabled && element.paused) await element.play();
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const bus of [...attemptedSinkChanges].reverse()) {
        const element = this.outputElements[bus] as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
        try {
          await element.setSinkId?.(this.state.outputs[bus].sinkId ?? '');
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const bus of ['sub', 'headphones'] as const) {
        const element = this.outputElements[bus];
        const previous = outputBefore.get(bus)!;
        element.muted = previous.muted;
        if (previous.paused && !element.paused) element.pause();
      }
      if (stagedGraphs) {
        for (const [id, graph] of stagedGraphs) this.disposeSourceInputFxGraph(id, graph);
      }
      if (rollbackErrors.length > 0) {
        const wrapped = new Error('Routing update failed and output rollback was incomplete.');
        Object.assign(wrapped, { cause: error, rollbackErrors });
        throw wrapped;
      }
      throw error;
    }
    if (topologyChanged) {
      this.disconnectOwnedRoutes();
      if (stagedGraphs) {
        this.disposeInputFxGraphs();
        for (const [id, graph] of stagedGraphs) {
          if (!this.sources.has(id)) { this.disposeSourceInputFxGraph(id, graph); continue; }
          this.inputFxGraphs.set(id, graph);
          this.inputFxGraphSources.set(id, graph.sourceNode);
        }
      }
    }
    this.state = next;
    if (topologyChanged) this.rebuildInputRoutes();
    else this.updateRouteParameters(next);
    this.mainDestinationGain.gain.setTargetAtTime(next.outputs.main.enabled ? 1 : 0, this.context.currentTime, 0.003);
    this.outputGains.sub.gain.setTargetAtTime(next.outputs.sub.enabled ? 1 : 0, this.context.currentTime, 0.003);
    this.outputGains.headphones.gain.setTargetAtTime(next.outputs.headphones.enabled ? 1 : 0, this.context.currentTime, 0.003);
    this.outputElements.sub.muted = !next.outputs.sub.enabled;
    this.outputElements.headphones.muted = !next.outputs.headphones.enabled;
    if (!next.outputs.sub.enabled) this.outputElements.sub.pause();
    if (!next.outputs.headphones.enabled) this.outputElements.headphones.pause();
    this.emit();
  }

  private rebuildInputRoutes(): void {
    this.routeRebuildCount += 1;
    for (const source of this.sources.values()) {
      const splitter = this.context.createChannelSplitter(source.channelCount);
      const sourceOutput = this.inputFxGraphs.get(source.id)?.output ?? source.node;
      sourceOutput.connect(splitter);
      this.inputSplitters.set(source.id, splitter);
      this.splitterSources.set(source.id, sourceOutput);
      for (let channel = 0; channel < source.channelCount; channel += 1) {
        const config = this.state.inputChannels.find((input) => input.sourceId === source.id && input.sourceChannel === channel);
        if (!config) continue;
        const filters = this.createEqFilters(config.eq);
        if (filters.length) {
          filters.forEach((filter, index) => {
            if (index > 0) filters[index - 1]!.connect(filter);
          });
        }
        const eqGain = this.context.createGain();
        eqGain.gain.value = config.eq.enabled ? 10 ** (config.eq.gainDb / 20) : 1;
        if (filters.length) filters[filters.length - 1]!.connect(eqGain);
        this.channelPaths.set(`${source.id}:${channel}`, { gain: eqGain, filters });
        splitter.connect(filters[0] ?? eqGain, channel, 0);
        const route = this.state.routes.find((entry) => entry.sourceId === source.id && entry.sourceChannel === channel);
        if (!route) continue;
        for (const send of route.tracks) {
          this.connectSend(`${source.id}:${channel}:track:${send.trackId}`, eqGain, this.channelMergers[send.trackId - 1]!, send.gain, send.targetChannel);
        }
        this.connectSend(`${source.id}:${channel}:main`, eqGain, this.monitorMerger, route.mainGain, route.mainTargetChannel);
        this.connectSend(`${source.id}:${channel}:sub`, eqGain, this.outputMergers.sub, route.subGain, route.subTargetChannel);
        this.connectSend(`${source.id}:${channel}:headphones`, eqGain, this.outputMergers.headphones, route.headphonesGain, route.headphonesTargetChannel);
      }
    }
  }

  private createEqFilters(eq: BrowserRoutingInputChannel['eq']): BiquadFilterNode[] {
    const filters: BiquadFilterNode[] = [];
    if (eq.enabled && eq.lowCutHz > 20) {
      const highpass = this.context.createBiquadFilter();
      highpass.type = 'highpass'; highpass.frequency.value = eq.lowCutHz; filters.push(highpass);
    }
    if (eq.enabled && eq.highCutHz < 20_000) {
      const lowpass = this.context.createBiquadFilter();
      lowpass.type = 'lowpass'; lowpass.frequency.value = eq.highCutHz; filters.push(lowpass);
    }
    return filters;
  }

  private connectSend(
    key: string,
    source: AudioNode,
    destination: ChannelMergerNode,
    gainValue: number,
    target: BrowserRoutingChannelTarget,
  ): void {
    const gain = this.context.createGain();
    gain.gain.value = gainValue;
    source.connect(gain);
    if (target === 'left' || target === 'both') gain.connect(destination, 0, 0);
    if (target === 'right' || target === 'both') gain.connect(destination, 0, 1);
    this.routeGainNodes.set(key, { node: gain, source, destination, target });
  }

  private disconnectOwnedRoutes(): void {
    for (const [sourceId, splitter] of this.inputSplitters) {
      try { this.splitterSources.get(sourceId)?.disconnect(splitter); } catch { /* source may already be retired by the engine */ }
      splitter.disconnect();
    }
    this.inputSplitters.clear();
    this.splitterSources.clear();
    for (const { gain, filters } of this.channelPaths.values()) {
      gain.disconnect();
      filters.forEach((filter) => filter.disconnect());
    }
    this.channelPaths.clear();
    for (const { node } of this.routeGainNodes.values()) node.disconnect();
    this.routeGainNodes.clear();
  }

  private updateRouteParameters(next: BrowserRoutingState): void {
    for (const input of next.inputChannels) {
      const path = this.channelPaths.get(`${input.sourceId}:${input.sourceChannel}`);
      if (!path) continue;
      const values = [input.eq.enabled && input.eq.lowCutHz > 20 ? input.eq.lowCutHz : null,
        input.eq.enabled && input.eq.highCutHz < 20_000 ? input.eq.highCutHz : null].filter((value): value is number => value !== null);
      path.filters.forEach((filter, index) => {
        const value = values[index];
        if (value !== undefined) filter.frequency.setTargetAtTime(value, this.context.currentTime, 0.01);
      });
      path.gain.gain.setTargetAtTime(input.eq.enabled ? 10 ** (input.eq.gainDb / 20) : 1, this.context.currentTime, 0.01);
    }
    for (const route of next.routes) {
      route.tracks.forEach((send) => this.setRouteGain(`${route.sourceId}:${route.sourceChannel}:track:${send.trackId}`, send.gain));
      this.setRouteGain(`${route.sourceId}:${route.sourceChannel}:main`, route.mainGain);
      this.setRouteGain(`${route.sourceId}:${route.sourceChannel}:sub`, route.subGain);
      this.setRouteGain(`${route.sourceId}:${route.sourceChannel}:headphones`, route.headphonesGain);
    }
  }

  private setRouteGain(key: string, gain: number): void {
    const route = this.routeGainNodes.get(key);
    route?.node.gain.setTargetAtTime(gain, this.context.currentTime, 0.01);
  }

  private isRoutingTopologyChanged(next: BrowserRoutingState): boolean {
    if (!this.hasSameSourceTopology(next.sources, this.state.sources)) return true;
    if ([...this.sources.entries()].some(([id, source]) => this.inputSplitters.has(id) && (
      this.splitterSources.get(id) !== (this.inputFxGraphs.get(id)?.output ?? source.node) ||
      this.inputFxGraphSources.get(id) !== undefined && this.inputFxGraphSources.get(id) !== source.node ||
      this.inputFxGraphs.get(id)?.sourceChannelCount !== undefined && this.inputFxGraphs.get(id)?.sourceChannelCount !== source.channelCount
    ))) return true;
    if (next.inputChannels.length !== this.state.inputChannels.length || next.routes.length !== this.state.routes.length) return true;
    for (const channel of next.inputChannels) {
      const before = this.state.inputChannels.find((entry) => entry.sourceId === channel.sourceId && entry.sourceChannel === channel.sourceChannel);
      if (!before || this.filterTopology(before.eq) !== this.filterTopology(channel.eq)) return true;
    }
    for (const route of next.routes) {
      const before = this.state.routes.find((entry) => entry.sourceId === route.sourceId && entry.sourceChannel === route.sourceChannel);
      if (!before || before.tracks.length !== route.tracks.length) return true;
      for (let index = 0; index < route.tracks.length; index += 1) {
        if (before.tracks[index]?.targetChannel !== route.tracks[index]?.targetChannel) return true;
      }
      if (before.mainTargetChannel !== route.mainTargetChannel || before.subTargetChannel !== route.subTargetChannel
        || before.headphonesTargetChannel !== route.headphonesTargetChannel) return true;
    }
    return false;
  }

  private filterTopology(eq: BrowserRoutingInputChannel['eq']): string {
    return `${eq.enabled && eq.lowCutHz > 20}:${eq.enabled && eq.highCutHz < 20_000}`;
  }

  private hasInputFxSourceTopologyChanged(): boolean {
    const sourceIds = [...this.sources.keys()].sort();
    const graphIds = [...this.inputFxGraphs.keys()].sort();
    return sourceIds.length !== graphIds.length || sourceIds.some((id, index) => id !== graphIds[index]
      || this.inputFxGraphSources.get(id) !== this.sources.get(id)?.node
      || this.inputFxGraphs.get(id)?.sourceChannelCount !== this.sources.get(id)?.channelCount);
  }

  private async createInputFxGraphs(): Promise<Map<string, SourceInputFxGraph> | null> {
    if (this.inputFxSnapshots.length === 0) return null;
    const staged = new Map<string, SourceInputFxGraph>();
    try {
      for (const [id, source] of this.sources) {
        staged.set(id, await this.createSourceInputFxGraph(source, this.inputFxSnapshots));
      }
      return staged;
    } catch (error) {
      for (const [id, graph] of staged) this.disposeSourceInputFxGraph(id, graph);
      throw error;
    }
  }

  private async createSourceInputFxGraph(
    source: BrowserRoutingSourceNode,
    snapshots: readonly FXSnapshot[],
  ): Promise<SourceInputFxGraph> {
    const sourceSplitter = this.context.createChannelSplitter(source.channelCount);
    const output = this.context.createChannelMerger(source.channelCount);
    const pairInputs: ChannelMergerNode[] = [];
    const pairOutputs: ChannelSplitterNode[] = [];
    const graphs: FxNodeGraph[] = [];
    try {
      source.node.connect(sourceSplitter);
      for (let firstChannel = 0; firstChannel < source.channelCount; firstChannel += 2) {
        const pairInput = this.context.createChannelMerger(2);
        pairInputs.push(pairInput);
        sourceSplitter.connect(pairInput, firstChannel, 0);
        if (firstChannel + 1 < source.channelCount) sourceSplitter.connect(pairInput, firstChannel + 1, 1);
        const graph = await defaultFXRegistry.createGraph(this.context, snapshots, { instant: true });
        graphs.push(graph);
        await graph.initialize();
        pairInput.connect(graph.input);
        const pairOutput = this.context.createChannelSplitter(2);
        pairOutputs.push(pairOutput);
        graph.output.connect(pairOutput);
        pairOutput.connect(output, 0, firstChannel);
        if (firstChannel + 1 < source.channelCount) pairOutput.connect(output, 1, firstChannel + 1);
      }
      return { sourceNode: source.node, sourceChannelCount: source.channelCount, sourceSplitter, output, pairInputs, pairOutputs, graphs };
    } catch (error) {
      try { source.node.disconnect(sourceSplitter); } catch { /* staging may have been externally retired */ }
      sourceSplitter.disconnect();
      pairInputs.forEach((pair) => pair.disconnect());
      pairOutputs.forEach((pair) => pair.disconnect());
      graphs.forEach((graph) => graph.dispose());
      output.disconnect();
      throw error;
    }
  }

  private disposeSourceInputFxGraph(sourceId: string, sourceGraph: SourceInputFxGraph): void {
    try { sourceGraph.sourceNode.disconnect(sourceGraph.sourceSplitter); } catch { /* stream replacement may already have removed this owned edge */ }
    sourceGraph.sourceSplitter.disconnect();
    sourceGraph.pairInputs.forEach((pair) => pair.disconnect());
    sourceGraph.pairOutputs.forEach((pair) => pair.disconnect());
    sourceGraph.graphs.forEach((graph) => graph.dispose());
    sourceGraph.output.disconnect();
    this.inputFxGraphSources.delete(sourceId);
  }

  private disposeInputFxGraphs(): void {
    for (const [sourceId, graph] of this.inputFxGraphs) {
      this.disposeSourceInputFxGraph(sourceId, graph);
    }
    this.inputFxGraphs.clear();
    this.inputFxGraphSources.clear();
  }

  private hasSameSourceTopology(left: readonly BrowserRoutingSource[], right: readonly BrowserRoutingSource[]): boolean {
    if (left.length !== right.length) return false;
    const prior = new Map(right.map((source) => [source.id, source.channelCount]));
    return left.every((source) => prior.get(source.id) === source.channelCount);
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
