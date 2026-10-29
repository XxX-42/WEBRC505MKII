import { Transport } from '../core/Transport';
import {
  createRhythmRuntimeEventTemplate,
  getDrumKitByIndex,
  getDrumKitByName,
  getRhythmPatternByIndex,
  RHYTHM_QUANTIZE_GRIDS,
  type CleanRoomDrumEvent,
  type DrumKitProfile,
  type RhythmPatternMetadata,
  type RhythmQuantizeGrid,
  type RhythmSection,
  type RhythmVariation,
} from './rhythm';
import type { RhythmMeasurePhaseSnapshot, RhythmWorkletConfiguration } from './worklet/RhythmProcessor';
import type { BrowserRecoverySnapshot } from './BrowserRecoverySnapshot';

/** The three selections retained by the existing RhythmControls UI. */
export type RhythmPattern = 'ROCK' | 'TECHNO' | 'METRONOME';

type PatternSelection =
  | { readonly kind: 'legacy'; readonly value: RhythmPattern }
  | { readonly kind: 'catalog'; readonly index: number };

export interface RhythmPlaybackSettings {
  readonly patternIndex: number;
  readonly kitIndex: number;
  readonly variation: RhythmVariation;
  readonly section: RhythmSection;
  readonly swingPercent: number;
  readonly quantizeGrid: RhythmQuantizeGrid;
}

const LEGACY_CATALOG_INDEX: Record<RhythmPattern, number> = {
  ROCK: 106,       // first 4/4 ROCK metadata row
  TECHNO: 198,     // first electronic-kit's `ELCTRO` metadata row (source spelling retained)
  METRONOME: 210,  // 4/4 GUIDE meter metadata; click events below remain clean-room
};
const WORKLET_URL = '/worklets/rhythm-processor.js';
const WORKLET_PROCESSOR_NAME = 'rc505-rhythm-processor';
const START_LEAD_SECONDS = 0.05;
const MAX_VOICE_COUNT = 16;

type RhythmTimelineStatusMessage =
  | {
    readonly type: 'measure-phase';
    readonly available: boolean;
    readonly requestId: number;
    readonly epoch: number;
    readonly originFrame?: number;
    readonly nextMeasureFrame?: number;
    readonly sampleRate?: number;
    readonly bpm?: number;
    readonly stepsPerBar?: number;
  }
  | {
    readonly type: 'timeline-rewind';
    readonly requestedStartFrame: number;
    readonly expectedStartFrame: number;
    readonly frameCount: number;
  }
  | {
    readonly type: 'timeline-recovered';
    readonly firstStaleStartFrame: number;
    readonly expectedStartFrame: number;
    readonly resumedStartFrame: number;
  };

export class RhythmEngine {
  private readonly context: AudioContext;
  private readonly transport: Transport;
  public readonly outputNode: GainNode;

  private isPlaying = false;
  private selection: PatternSelection = { kind: 'legacy', value: 'ROCK' };
  private kitIndex = 1;
  private variation: RhythmVariation = 'A';
  private section: RhythmSection = 'main';
  private swing = 50;
  private quantize: RhythmQuantizeGrid = '1/16';
  private workletNode: AudioWorkletNode | null = null;
  private workletReady: Promise<AudioWorkletNode> | null = null;
  private phaseRequestId = 0;
  private measurePhase: RhythmMeasurePhaseSnapshot | null = null;
  private readonly phaseChangeListeners = new Set<() => void>();
  private lastError = '';
  private readonly notifyStatus: () => void;
  private transportListenerAttached = false;
  private readonly onBpmChange = (): void => {
    if (this.isPlaying && this.workletNode) this.configureWorklet(this.workletNode);
  };

  constructor(context: AudioContext, notifyStatus: () => void = () => undefined) {
    this.context = context;
    this.notifyStatus = notifyStatus;
    this.transport = Transport.getInstance();
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 0.5;
  }

  /** Current catalog metadata selected by either the legacy control or 240-row API. */
  get patternMetadata(): RhythmPatternMetadata {
    const index = this.selection.kind === 'legacy'
      ? LEGACY_CATALOG_INDEX[this.selection.value]
      : this.selection.index;
    return getRhythmPatternByIndex(index)!;
  }

  get selectedKit(): DrumKitProfile {
    return getDrumKitByIndex(this.kitIndex)!;
  }

  get selectedVariation(): RhythmVariation {
    return this.variation;
  }

  get selectedSection(): RhythmSection {
    return this.section;
  }

  get swingPercent(): number {
    return this.swing;
  }

  get quantizeGrid(): RhythmQuantizeGrid {
    return this.quantize;
  }

  /** Capture settings only. The live voice/worklet phase is intentionally not transferable. */
  getRecoverySnapshot(): BrowserRecoverySnapshot['rhythm'] {
    return Object.freeze({
      patternIndex: this.patternMetadata.globalIndex,
      kitIndex: this.kitIndex,
      variation: this.variation,
      section: this.section,
      swingPercent: this.swing,
      quantizeGrid: this.quantize,
      volumePercent: Math.max(0, Math.min(100, this.outputNode.gain.value * 100)),
      wasRunning: this.isPlaying,
      error: this.lastError,
    });
  }

  get isRunning(): boolean {
    return this.isPlaying;
  }

  /** Worklet-authored phase only; null until an absolute-frame origin is acknowledged. */
  get measurePhaseSnapshot(): RhythmMeasurePhaseSnapshot | null {
    return this.measurePhase;
  }

  onMeasurePhaseChange(listener: () => void): () => void {
    this.phaseChangeListeners.add(listener);
    return () => this.phaseChangeListeners.delete(listener);
  }

  private notifyMeasurePhaseChange(): void {
    for (const listener of this.phaseChangeListeners) listener();
    this.notifyStatus();
  }

  /** Event data and sound generation are clean-room approximations, not factory MIDI. */
  get eventProvenance(): 'clean-room-generated' {
    return 'clean-room-generated';
  }

  get error(): string {
    return this.lastError;
  }

  connect(destination: AudioNode): void {
    this.outputNode.connect(destination);
  }

  /** Existing UI/API signature is unchanged. */
  setPattern(pattern: RhythmPattern): void {
    this.selection = { kind: 'legacy', value: pattern };
    this.restartPatternIfRunning();
  }

  /** Select any of the 240 metadata entries by its one-based global index. */
  setCatalogPattern(globalIndex: number): boolean {
    if (!getRhythmPatternByIndex(globalIndex)) return false;
    this.selection = { kind: 'catalog', index: globalIndex };
    this.restartPatternIfRunning();
    return true;
  }

  /** Select one of the 16 clean-room procedural kit profiles by index or source name. */
  setKit(kit: number | string): boolean {
    const profile = typeof kit === 'number' ? getDrumKitByIndex(kit) : getDrumKitByName(kit);
    if (!profile) return false;
    this.kitIndex = profile.index;
    this.restartPatternIfRunning();
    return true;
  }

  setVariation(variation: RhythmVariation): void {
    this.variation = variation;
    this.restartPatternIfRunning();
  }

  setSection(section: RhythmSection): void {
    this.section = section;
    this.restartPatternIfRunning();
  }

  /** Configure straight-to-triplet/dotted eighth swing for clean-room offbeats. */
  setSwingPercent(value: number): boolean {
    if (!Number.isInteger(value) || value < 50 || value > 75) return false;
    if (this.swing === value) return true;
    this.swing = value;
    this.restartPatternIfRunning();
    return true;
  }

  /** Quantize generated events to the nearest 16th, 8th, or quarter-note grid. */
  setQuantizeGrid(grid: RhythmQuantizeGrid): boolean {
    if (!RHYTHM_QUANTIZE_GRIDS.includes(grid)) return false;
    if (this.quantize === grid) return true;
    this.quantize = grid;
    this.restartPatternIfRunning();
    return true;
  }

  /** Apply all UI settings atomically so a control mount causes at most one restart. */
  setSettings(settings: RhythmPlaybackSettings): boolean {
    const pattern = getRhythmPatternByIndex(settings.patternIndex);
    const kit = getDrumKitByIndex(settings.kitIndex);
    if (!pattern || !kit || !pattern.variations.includes(settings.variation)
      || !isRhythmSection(settings.section)
      || !Number.isInteger(settings.swingPercent) || settings.swingPercent < 50 || settings.swingPercent > 75
      || !RHYTHM_QUANTIZE_GRIDS.includes(settings.quantizeGrid)) {
      return false;
    }
    const unchanged = this.selection.kind === 'catalog'
      && this.selection.index === settings.patternIndex
      && this.kitIndex === settings.kitIndex
      && this.variation === settings.variation
      && this.section === settings.section
      && this.swing === settings.swingPercent
      && this.quantize === settings.quantizeGrid;
    if (unchanged) return true;
    this.selection = { kind: 'catalog', index: settings.patternIndex };
    this.kitIndex = settings.kitIndex;
    this.variation = settings.variation;
    this.section = settings.section;
    this.swing = settings.swingPercent;
    this.quantize = settings.quantizeGrid;
    this.restartPatternIfRunning();
    return true;
  }

  /** Value is 0–100, matching the existing control. */
  setVolume(value: number): void {
    const normalized = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) / 100 : 0;
    this.outputNode.gain.value = normalized;
  }

  /** Loads one worklet processor and starts sample-frame playback; remains fire-and-forget. */
  start(): void {
    if (this.isPlaying) return;
    if (!this.transportListenerAttached) {
      this.transport.on('bpm-change', this.onBpmChange);
      this.transportListenerAttached = true;
    }
    this.isPlaying = true;
    this.lastError = '';
    if (this.context.state === 'suspended') {
      void this.context.resume().catch((error: unknown) => this.recordError(error));
    }
    void this.ensureWorklet().then((node) => {
      if (this.isPlaying) this.configureWorklet(node);
    }).catch((error: unknown) => {
      this.isPlaying = false;
      this.detachTransportListener();
      this.recordError(error);
    });
  }

  stop(): void {
    this.isPlaying = false;
    const requestId = this.invalidateMeasurePhase();
    this.workletNode?.port.postMessage({ type: 'stop', requestId });
    this.detachTransportListener();
  }

  private detachTransportListener(): void {
    if (this.transportListenerAttached) {
      this.transport.off('bpm-change', this.onBpmChange);
      this.transportListenerAttached = false;
    }
  }

  /** Release the module/node and transport listener if an owner tears the engine down. */
  dispose(): void {
    this.stop();
    if (this.workletNode) this.workletNode.port.onmessage = null;
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.workletReady = null;
  }

  private restartPatternIfRunning(): void {
    if (this.isPlaying && this.workletNode) this.configureWorklet(this.workletNode);
  }

  private ensureWorklet(): Promise<AudioWorkletNode> {
    if (this.workletNode) return Promise.resolve(this.workletNode);
    if (this.workletReady) return this.workletReady;

    this.workletReady = (async (): Promise<AudioWorkletNode> => {
      if (!this.context.audioWorklet) throw new Error('AudioWorklet is unavailable in this browser context');
      await this.context.audioWorklet.addModule(WORKLET_URL);
      const node = new AudioWorkletNode(this.context, WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      node.onprocessorerror = (): void => {
        this.invalidateMeasurePhase();
        this.lastError = 'The rhythm AudioWorklet processor stopped unexpectedly';
        this.notifyStatus();
      };
      node.port.onmessage = (event: MessageEvent<unknown>): void => this.handleWorkletStatus(event.data);
      node.connect(this.outputNode);
      this.workletNode = node;
      return node;
    })().catch((error: unknown) => {
      this.workletReady = null;
      throw error;
    });
    return this.workletReady;
  }

  private configureWorklet(node: AudioWorkletNode): void {
    const metadata = this.patternMetadata;
    const bpm = this.transport.bpm;
    const template = this.createEventTemplate(metadata, bpm);
    const stepsPerBar = metadata.meter.numerator * (16 / metadata.meter.denominator);
    const configuration: RhythmWorkletConfiguration = {
      sampleRate: this.context.sampleRate,
      bpm,
      swingPercent: this.swing,
      quantizeGrid: this.quantize,
      startFrame: Math.max(0, Math.ceil((this.context.currentTime + START_LEAD_SECONDS) * this.context.sampleRate)),
      stepsPerBar,
      kitIndex: this.kitIndex,
      maxVoices: MAX_VOICE_COUNT,
      eventTemplate: template,
    };
    const requestId = this.nextPhaseRequestId();
    this.measurePhase = null;
    this.notifyMeasurePhaseChange();
    node.port.postMessage({ type: 'start', requestId, configuration });
  }

  private createEventTemplate(metadata: RhythmPatternMetadata, bpm: number): CleanRoomDrumEvent[] {
    return createRhythmRuntimeEventTemplate(metadata, {
      sampleRate: this.context.sampleRate,
      bpm,
      bars: 1,
      variation: this.variation,
      section: this.section,
    });
  }

  private recordError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.notifyStatus();
  }

  private handleWorkletStatus(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as Partial<RhythmTimelineStatusMessage>;
    if (message.type === 'measure-phase') {
      if (message.requestId !== this.phaseRequestId || !Number.isSafeInteger(message.epoch) || message.epoch! < 1) return;
      if (message.available === false) {
        this.measurePhase = null;
        this.notifyMeasurePhaseChange();
        return;
      }
      if (!this.isPlaying
        || !Number.isSafeInteger(message.originFrame)
        || !Number.isSafeInteger(message.nextMeasureFrame)
        || message.nextMeasureFrame! <= message.originFrame!
        || message.sampleRate !== this.context.sampleRate
        || !Number.isFinite(message.bpm) || message.bpm! <= 0
        || !Number.isSafeInteger(message.stepsPerBar) || message.stepsPerBar! < 1) return;
      const expectedNextMeasureFrame = message.originFrame!
        + Math.round((message.stepsPerBar! * message.sampleRate! * 15) / message.bpm!);
      if (expectedNextMeasureFrame !== message.nextMeasureFrame) return;
      this.measurePhase = Object.freeze({
        type: 'measure-phase',
        available: true,
        requestId: message.requestId,
        epoch: message.epoch!,
        originFrame: message.originFrame!,
        nextMeasureFrame: message.nextMeasureFrame!,
        sampleRate: message.sampleRate!,
        bpm: message.bpm!,
        stepsPerBar: message.stepsPerBar!,
      });
      this.notifyMeasurePhaseChange();
      return;
    }
    if (message.type === 'timeline-rewind'
      && Number.isSafeInteger(message.requestedStartFrame)
      && Number.isSafeInteger(message.expectedStartFrame)
      && Number.isSafeInteger(message.frameCount)) {
      this.measurePhase = null;
      this.notifyMeasurePhaseChange();
      this.lastError = `Rhythm sample timeline moved backward at frame ${message.requestedStartFrame} (expected ${message.expectedStartFrame}). The overlapping ${message.frameCount}-frame block was muted; rhythm state was not rewound.`;
      this.notifyStatus();
      return;
    }
    if (message.type === 'timeline-recovered'
      && Number.isSafeInteger(message.firstStaleStartFrame)
      && Number.isSafeInteger(message.expectedStartFrame)
      && Number.isSafeInteger(message.resumedStartFrame)) {
      this.measurePhase = null;
      this.notifyMeasurePhaseChange();
      this.lastError = `Rhythm resumed on the absolute timeline at frame ${message.resumedStartFrame}. Timeline continuity was interrupted; muted or skipped audio was not buffered for replay.`;
      this.notifyStatus();
    }
  }

  private nextPhaseRequestId(): number {
    if (this.phaseRequestId >= Number.MAX_SAFE_INTEGER) throw new RangeError('Rhythm phase request id is exhausted');
    this.phaseRequestId += 1;
    return this.phaseRequestId;
  }

  private invalidateMeasurePhase(): number {
    this.measurePhase = null;
    this.notifyMeasurePhaseChange();
    return this.nextPhaseRequestId();
  }
}

function isRhythmSection(section: string): section is RhythmSection {
  return section === 'main' || section === 'intro' || section === 'ending' || section === 'fill';
}
