/** Explicitly connected Web MIDI Timing Clock observer with an optional selected-source realtime event callback. */

import type { MidiAccessLike, MidiInputLike, MidiMessageEventLike, MidiInputState } from './MidiInputController';
import { MidiClockEstimator, type MidiClockEstimateSnapshot } from './MidiClockEstimator';
import { MidiAudioFrameMapper, type MidiAudioAnchor, type MidiAudioFrameMapResult } from './MidiAudioFrameMapper';

export type MidiClockSignal = 'waiting' | 'observed' | 'stale' | 'ambiguous';
export type MidiClockStability = 'insufficient-data' | 'stable' | 'unstable';

export interface MidiClockSnapshot {
  readonly connection: MidiInputState;
  readonly signal: MidiClockSignal;
  readonly stability: MidiClockStability;
  readonly tickCount: number;
  readonly lastTickAtMs: number | null;
  /** Latest selected-source MIDI Start (FA), when observed. This is diagnostic only. */
  readonly lastStartAtMs: number | null;
  /** Performance-time projection of FA onto the current AudioContext frame clock. */
  readonly startFrameMapping: MidiAudioFrameMapResult;
  readonly measuredBpm: number | null;
  readonly inputCount: number;
  readonly inputs: readonly MidiClockInputPort[];
  readonly selectedInputKey: string | null;
  readonly selectedInputName: string | null;
  /** Relative to the first F8 pulse observed from the selected source; not a downbeat. */
  readonly phaseRelativeTicks: number | null;
  readonly phaseRelativeQuarter: number | null;
  readonly phaseLocked: boolean;
  /** Recent, consecutive clean F8 evidence for transport control; not sample phase alignment. */
  readonly phaseControlReady: boolean;
  readonly phaseConsecutiveTrustedIntervals: number;
  readonly phaseState: 'waiting' | 'acquiring' | 'locked' | 'stale';
  readonly phaseAcceptedIntervals: number;
  readonly phaseRequiredIntervals: number;
  readonly phaseInferredMissingTicks: number;
  readonly phaseRejectedIntervals: number;
  readonly frameMapping: MidiAudioFrameMapResult;
}

/** Session-only key and display name. The Web MIDI port ID is never exposed or persisted. */
export interface MidiClockInputPort {
  readonly key: string;
  readonly name: string;
}

export interface MidiClockInputOptions {
  readonly requestMIDIAccess?: () => Promise<MidiAccessLike> | undefined;
  readonly requestPermissionStatus?: () => Promise<MidiPermissionStatusLike> | undefined;
  readonly onChange?: () => void;
  readonly now?: () => number;
  /** Optional read-only running AudioContext clock sample; used for Tech diagnostics only. */
  readonly getAudioAnchor?: () => MidiAudioAnchor | null;
  /** Selected-source realtime events, with the clock evidence available at receipt. */
  readonly onSelectedRealtimeMessage?: (event: MidiClockRealtimeEvent) => void;
}

export interface MidiClockRealtimeEvent {
  readonly status: 'clock' | 'start' | 'stop';
  readonly timestampMs: number;
  readonly sourceKey: string;
  readonly clock: MidiClockEstimateSnapshot;
}

export interface MidiPermissionStatusLike {
  readonly state: 'granted' | 'denied' | 'prompt';
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

const CLOCK_STATUS = 0xf8;
const HISTORY_SIZE = 24;
const STALE_AFTER_MS = 1000;
const MAX_RELATIVE_JITTER = 0.05;

interface PortClockState {
  key: string;
  name: string;
  intervals: number[];
  lastTickAtMs: number | null;
  tickCount: number;
}

function requestBrowserMidiAccess(): Promise<MidiAccessLike> | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const midiNavigator = navigator as unknown as { requestMIDIAccess?: () => Promise<MidiAccessLike> };
  if (typeof midiNavigator.requestMIDIAccess !== 'function') return undefined;
  return midiNavigator.requestMIDIAccess.call(navigator);
}

function requestBrowserMidiPermissionStatus(): Promise<MidiPermissionStatusLike> | undefined {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return undefined;
  try {
    return navigator.permissions.query({ name: 'midi' } as PermissionDescriptor) as Promise<MidiPermissionStatusLike>;
  } catch {
    return undefined;
  }
}

/**
 * Observes one-byte MIDI realtime messages from a single selected port. With
 * no callback configured it is read-only; the optional callback is responsible
 * for explicit application-level control policy.
 */
export class MidiClockInputController {
  private readonly requestAccess: () => Promise<MidiAccessLike> | undefined;
  private readonly requestPermissionStatus: () => Promise<MidiPermissionStatusLike> | undefined;
  private readonly onChange?: () => void;
  private readonly now: () => number;
  private readonly getAudioAnchor?: () => MidiAudioAnchor | null;
  private readonly onSelectedRealtimeMessage?: (event: MidiClockRealtimeEvent) => void;
  private readonly frameMapper = new MidiAudioFrameMapper();
  private observedAudioContext: object | null = null;
  private audioContextStateListener: (() => void) | null = null;
  private connection: MidiInputState = 'disconnected';
  private access?: MidiAccessLike;
  private permissionStatus?: MidiPermissionStatusLike;
  private readonly inputs = new Map<MidiInputLike, (event: MidiMessageEventLike) => void>();
  private readonly portClocks = new Map<MidiInputLike, PortClockState>();
  private readonly portKeys = new WeakMap<MidiInputLike, string>();
  private nextPortKey = 1;
  private selectedInputKey: string | null = null;
  private readonly phaseEstimator = new MidiClockEstimator();
  private lastStartAtMs: number | null = null;
  private startFrameMapping: MidiAudioFrameMapResult = Object.freeze({
    ok: false, frame: null, reason: 'unanchored', driftPpm: null, anchorCount: 0,
  });
  private generation = 0;
  private pending?: Promise<MidiInputState>;

  private readonly handleStateChange = (): void => {
    try {
      this.syncInputs();
      this.onChange?.();
    } catch (error) {
      // A revoked permission or invalidated MIDI access must fail closed.
      this.disconnect();
      this.setConnection(this.isPermissionError(error) ? 'permission-denied' : 'error');
    }
  };

  private readonly handlePermissionChange = (): void => {
    if (this.permissionStatus?.state !== 'denied') return;
    this.disconnect();
    this.setConnection('permission-denied');
  };

  private readonly handleAudioContextStateChange = (): void => {
    // A suspend/resume pair may happen between diagnostic polling ticks. Any
    // state transition makes the old performance/audio affine model unusable.
    this.frameMapper.reset();
    this.phaseEstimator.reset();
    this.lastStartAtMs = null;
    this.startFrameMapping = this.unmappedFrame();
    this.onChange?.();
  };

  constructor(options: MidiClockInputOptions = {}) {
    this.requestAccess = options.requestMIDIAccess ?? requestBrowserMidiAccess;
    this.requestPermissionStatus = options.requestPermissionStatus ?? requestBrowserMidiPermissionStatus;
    this.onChange = options.onChange;
    this.now = options.now ?? (() => performance.now());
    this.getAudioAnchor = options.getAudioAnchor;
    this.onSelectedRealtimeMessage = options.onSelectedRealtimeMessage;
  }

  connect(): Promise<MidiInputState> {
    if (this.access) return Promise.resolve(this.connection);
    if (this.pending) return this.pending;
    let accessPromise: Promise<MidiAccessLike> | undefined;
    try { accessPromise = this.requestAccess(); }
    catch (error) {
      this.setConnection(this.isPermissionError(error) ? 'permission-denied' : 'error');
      return Promise.resolve(this.connection);
    }
    if (!accessPromise) {
      this.setConnection('unsupported');
      return Promise.resolve(this.connection);
    }
    const generation = ++this.generation;
    this.setConnection('connecting');
    let pending: Promise<MidiInputState>;
    pending = Promise.resolve(accessPromise).then(async (access) => {
      if (generation !== this.generation) return this.connection;
      let permissionStatus: MidiPermissionStatusLike | undefined;
      try { permissionStatus = await this.requestPermissionStatus(); }
      catch { /* Permissions API querying is optional; MIDIAccess remains the authority. */ }
      if (generation !== this.generation) return this.connection;
      if (permissionStatus?.state === 'denied') {
        this.setConnection('permission-denied');
        return this.connection;
      }
      this.permissionStatus = permissionStatus;
      permissionStatus?.addEventListener('change', this.handlePermissionChange);
      this.access = access;
      access.addEventListener('statechange', this.handleStateChange);
      this.syncInputs();
      this.setConnection('connected');
      return this.connection;
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.setConnection(this.isPermissionError(error) ? 'permission-denied' : 'error');
      }
      return this.connection;
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  disconnect(): void {
    this.generation += 1;
    this.pending = undefined;
    const access = this.access;
    if (access) access.removeEventListener('statechange', this.handleStateChange);
    this.permissionStatus?.removeEventListener('change', this.handlePermissionChange);
    this.permissionStatus = undefined;
    for (const [input, listener] of this.inputs) input.removeEventListener('midimessage', listener);
    this.inputs.clear();
    this.access = undefined;
    this.portClocks.clear();
    this.selectedInputKey = null;
    this.phaseEstimator.reset();
    this.frameMapper.reset();
    this.lastStartAtMs = null;
    this.startFrameMapping = this.unmappedFrame();
    this.watchAudioContext(null);
    this.setConnection('disconnected');
    this.onChange?.();
  }

  /** Select exactly one connected input for observation; null clears selection. */
  selectInput(key: string | null): boolean {
    if (key === null) {
      this.selectedInputKey = null;
      this.phaseEstimator.reset();
      this.frameMapper.reset();
      this.lastStartAtMs = null;
      this.startFrameMapping = this.unmappedFrame();
      this.onChange?.();
      return true;
    }
    const exists = [...this.portClocks.values()].some((clock) => clock.key === key);
    if (!exists) return false;
    this.selectedInputKey = key;
    this.phaseEstimator.reset();
    this.frameMapper.reset();
    this.lastStartAtMs = null;
    this.startFrameMapping = this.unmappedFrame();
    const selected = [...this.portClocks.values()].find((clock) => clock.key === key);
    if (selected) {
      selected.intervals = [];
      selected.lastTickAtMs = null;
      selected.tickCount = 0;
    }
    this.onChange?.();
    return true;
  }

  getSnapshot(nowMs = this.now()): MidiClockSnapshot {
    const streams = [...this.portClocks.values()];
    const source = streams.find((stream) => stream.key === this.selectedInputKey);
    const sourceActive = !!source && source.lastTickAtMs !== null
      && Math.max(0, nowMs - source.lastTickAtMs) <= STALE_AFTER_MS;
    const lastRelevantEventAtMs = source ? Math.max(source.lastTickAtMs ?? -Infinity, this.lastStartAtMs ?? -Infinity) : -Infinity;
    if (this.lastStartAtMs !== null && nowMs - lastRelevantEventAtMs > STALE_AFTER_MS) {
      this.lastStartAtMs = null;
      this.startFrameMapping = this.unmappedFrame('stale-event');
      this.phaseEstimator.reset();
    }
    const signal: MidiClockSignal = !source ? 'waiting'
      : sourceActive ? 'observed' : source.lastTickAtMs !== null ? 'stale' : 'waiting';
    const stability: MidiClockStability = !source || source.intervals.length < HISTORY_SIZE
      ? 'insufficient-data'
      : this.isStable(source.intervals) ? 'stable' : 'unstable';
    const medianInterval = source ? this.median(source.intervals) : 0;
    const phase = source ? this.phaseEstimator.getSnapshot(nowMs) : null;
    const shouldSampleAudioClock = this.connection === 'connected' && source !== undefined && this.getAudioAnchor !== undefined;
    const anchor = shouldSampleAudioClock ? this.getAudioAnchor?.() : null;
    if (anchor) {
      this.watchAudioContext(anchor.contextKey);
      this.frameMapper.addAnchor(anchor);
    } else {
      this.frameMapper.reset();
      this.watchAudioContext(null);
    }
    const frameMapping = source?.lastTickAtMs !== null && source?.lastTickAtMs !== undefined
      ? this.frameMapper.map(source.lastTickAtMs, nowMs)
      : this.frameMapper.map(Number.NaN, nowMs);
    return Object.freeze({
      connection: this.connection,
      signal,
      stability: signal === 'observed' ? stability : 'insufficient-data',
      tickCount: source?.tickCount ?? 0,
      lastTickAtMs: source?.lastTickAtMs ?? null,
      lastStartAtMs: source ? this.lastStartAtMs : null,
      startFrameMapping: source ? this.startFrameMapping : this.unmappedFrame(),
      measuredBpm: medianInterval > 0 ? 60000 / (medianInterval * 24) : null,
      inputCount: this.inputs.size,
      inputs: Object.freeze([...this.portClocks.values()].map((clock) => Object.freeze({ key: clock.key, name: clock.name }))),
      selectedInputKey: this.selectedInputKey,
      selectedInputName: source?.name ?? null,
      phaseRelativeTicks: phase?.phaseTicks ?? null,
      phaseRelativeQuarter: phase?.beatPhase ?? null,
      phaseLocked: phase?.phaseLocked ?? false,
      phaseControlReady: phase?.controlReady ?? false,
      phaseConsecutiveTrustedIntervals: phase?.consecutiveTrustedIntervals ?? 0,
      phaseState: phase?.state ?? 'waiting',
      phaseAcceptedIntervals: phase?.acceptedIntervals ?? 0,
      phaseRequiredIntervals: phase?.requiredIntervals ?? 6,
      phaseInferredMissingTicks: phase?.inferredMissingTicks ?? 0,
      phaseRejectedIntervals: phase?.rejectedIntervals ?? 0,
      frameMapping,
    });
  }

  private syncInputs(): void {
    const access = this.access;
    if (!access) return;
    const current = new Set<MidiInputLike>();
    const portNames = new Map<MidiInputLike, string>();
    const nameCounts = new Map<string, number>();
    access.inputs.forEach((input) => {
      if (input.state === 'disconnected') return;
      current.add(input);
      const port = input as MidiInputLike & { name?: string | null; manufacturer?: string | null };
      const baseName = [port.manufacturer, port.name].filter((part) => typeof part === 'string' && part.trim()).join(' ')
        || `MIDI input ${current.size}`;
      const occurrence = (nameCounts.get(baseName) ?? 0) + 1;
      nameCounts.set(baseName, occurrence);
      portNames.set(input, occurrence === 1 ? baseName : `${baseName} (${occurrence})`);
    });
    for (const [input, listener] of this.inputs) {
      if (!current.has(input)) {
        const removedKey = this.portClocks.get(input)?.key;
        input.removeEventListener('midimessage', listener);
        this.inputs.delete(input);
        this.portClocks.delete(input);
        if (removedKey && this.selectedInputKey === removedKey) {
          this.selectedInputKey = null;
          this.phaseEstimator.reset();
          this.frameMapper.reset();
          this.lastStartAtMs = null;
          this.startFrameMapping = this.unmappedFrame();
        }
      }
    }
    for (const input of current) {
      if (this.inputs.has(input)) continue;
      const listener = (event: MidiMessageEventLike): void => this.handleMessage(event, input);
      input.addEventListener('midimessage', listener);
      this.inputs.set(input, listener);
      let key = this.portKeys.get(input);
      if (!key) {
        key = `midi-input-${this.nextPortKey++}`;
        this.portKeys.set(input, key);
      }
      this.portClocks.set(input, { key, name: portNames.get(input) ?? `MIDI input ${this.inputs.size}`, intervals: [], lastTickAtMs: null, tickCount: 0 });
    }
    for (const [input, clock] of this.portClocks) {
      const name = portNames.get(input);
      if (name) clock.name = name;
    }
    if (this.selectedInputKey && ![...this.portClocks.values()].some((clock) => clock.key === this.selectedInputKey)) {
      this.selectedInputKey = null;
    }
  }

  private watchAudioContext(contextKey: object | null): void {
    if (this.observedAudioContext === contextKey) return;
    if (this.observedAudioContext && this.audioContextStateListener) {
      const previous = this.observedAudioContext as {
        removeEventListener?: (type: 'statechange', listener: () => void) => void;
      };
      previous.removeEventListener?.('statechange', this.audioContextStateListener);
    }
    this.observedAudioContext = contextKey;
    this.audioContextStateListener = null;
    if (!contextKey) return;
    const next = contextKey as {
      addEventListener?: (type: 'statechange', listener: () => void) => void;
    };
    if (typeof next.addEventListener !== 'function') return;
    this.audioContextStateListener = this.handleAudioContextStateChange;
    next.addEventListener('statechange', this.audioContextStateListener);
  }

  private handleMessage(event: MidiMessageEventLike, input: MidiInputLike): void {
    // Ignore events already queued when a port was disconnected or permission was revoked.
    if (!this.inputs.has(input)) return;
    const data = event?.data;
    if (!data || data.length !== 1 || !Number.isFinite(event.timeStamp)) return;
    const clock = this.portClocks.get(input);
    if (!clock) return;
    const time = event.timeStamp;
    if (clock.key !== this.selectedInputKey) return;
    if (data[0] === 0xfa) {
      this.notifySelectedRealtimeMessage('start', time, clock.key);
      this.phaseEstimator.reset();
      this.lastStartAtMs = time;
      const anchor = this.getAudioAnchor?.() ?? null;
      if (anchor) {
        this.watchAudioContext(anchor.contextKey);
        this.frameMapper.addAnchor(anchor);
        this.startFrameMapping = this.frameMapper.map(time, this.now());
      } else {
        this.frameMapper.reset();
        this.startFrameMapping = this.unmappedFrame();
      }
      this.onChange?.();
      return;
    }
    if (data[0] === 0xfc) {
      this.notifySelectedRealtimeMessage('stop', time, clock.key);
      return;
    }
    if (data[0] !== CLOCK_STATUS) return;
    if (clock.lastTickAtMs !== null) {
      const interval = time - clock.lastTickAtMs;
      if (interval > 0 && Number.isFinite(interval)) {
        clock.intervals.push(interval);
        if (clock.intervals.length > HISTORY_SIZE) clock.intervals.shift();
      }
    }
    clock.lastTickAtMs = time;
    clock.tickCount += 1;
    const estimate = this.phaseEstimator.push(time, clock.key);
    this.notifySelectedRealtimeMessage('clock', time, clock.key, estimate);
    this.onChange?.();
  }

  private notifySelectedRealtimeMessage(
    status: MidiClockRealtimeEvent['status'],
    timestampMs: number,
    sourceKey: string,
    estimate = this.phaseEstimator.getSnapshot(timestampMs),
  ): void {
    try {
      this.onSelectedRealtimeMessage?.({ status, timestampMs, sourceKey, clock: estimate });
    } catch (error) {
      console.error('Selected MIDI clock event handler failed', error);
    }
  }

  private unmappedFrame(reason: MidiAudioFrameMapResult['reason'] = 'unanchored'): MidiAudioFrameMapResult {
    return Object.freeze({ ok: false, frame: null, reason, driftPpm: null, anchorCount: 0 });
  }

  private isStable(intervals: readonly number[]): boolean {
    const median = this.median(intervals);
    return median > 0 && intervals.every((interval) => Math.abs(interval - median) / median <= MAX_RELATIVE_JITTER);
  }

  private median(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const lower = sorted[middle - 1];
    const upper = sorted[middle];
    return sorted.length % 2 === 0 && lower !== undefined && upper !== undefined
      ? (lower + upper) / 2
      : sorted[middle] ?? 0;
  }

  private setConnection(state: MidiInputState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.onChange?.();
  }

  private isPermissionError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error
      && ((error as { name?: unknown }).name === 'NotAllowedError' || (error as { name?: unknown }).name === 'SecurityError');
  }
}
