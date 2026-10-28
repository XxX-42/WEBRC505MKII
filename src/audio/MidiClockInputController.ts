/** Explicitly opt-in, read-only Web MIDI Timing Clock monitor. */

import type { MidiAccessLike, MidiInputLike, MidiMessageEventLike, MidiInputState } from './MidiInputController';
import { MidiClockEstimator } from './MidiClockEstimator';

export type MidiClockSignal = 'waiting' | 'observed' | 'stale' | 'ambiguous';
export type MidiClockStability = 'insufficient-data' | 'stable' | 'unstable';

export interface MidiClockSnapshot {
  readonly connection: MidiInputState;
  readonly signal: MidiClockSignal;
  readonly stability: MidiClockStability;
  readonly tickCount: number;
  readonly lastTickAtMs: number | null;
  readonly measuredBpm: number | null;
  readonly inputCount: number;
  readonly inputs: readonly MidiClockInputPort[];
  readonly selectedInputKey: string | null;
  readonly selectedInputName: string | null;
  /** Relative to the first F8 pulse observed from the selected source; not a downbeat. */
  readonly phaseRelativeTicks: number | null;
  readonly phaseRelativeQuarter: number | null;
  readonly phaseLocked: boolean;
  readonly phaseState: 'waiting' | 'acquiring' | 'locked' | 'stale';
  readonly phaseAcceptedIntervals: number;
  readonly phaseRequiredIntervals: number;
  readonly phaseInferredMissingTicks: number;
  readonly phaseRejectedIntervals: number;
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
 * Observes one-byte F8 messages only. It never forwards messages to the note
 * engine or changes Transport tempo, phase, or playback state.
 */
export class MidiClockInputController {
  private readonly requestAccess: () => Promise<MidiAccessLike> | undefined;
  private readonly requestPermissionStatus: () => Promise<MidiPermissionStatusLike> | undefined;
  private readonly onChange?: () => void;
  private readonly now: () => number;
  private connection: MidiInputState = 'disconnected';
  private access?: MidiAccessLike;
  private permissionStatus?: MidiPermissionStatusLike;
  private readonly inputs = new Map<MidiInputLike, (event: MidiMessageEventLike) => void>();
  private readonly portClocks = new Map<MidiInputLike, PortClockState>();
  private readonly portKeys = new WeakMap<MidiInputLike, string>();
  private nextPortKey = 1;
  private selectedInputKey: string | null = null;
  private readonly phaseEstimator = new MidiClockEstimator();
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

  constructor(options: MidiClockInputOptions = {}) {
    this.requestAccess = options.requestMIDIAccess ?? requestBrowserMidiAccess;
    this.requestPermissionStatus = options.requestPermissionStatus ?? requestBrowserMidiPermissionStatus;
    this.onChange = options.onChange;
    this.now = options.now ?? (() => performance.now());
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
    this.setConnection('disconnected');
    this.onChange?.();
  }

  /** Select exactly one connected input for observation; null clears selection. */
  selectInput(key: string | null): boolean {
    if (key === null) {
      this.selectedInputKey = null;
      this.phaseEstimator.reset();
      this.onChange?.();
      return true;
    }
    const exists = [...this.portClocks.values()].some((clock) => clock.key === key);
    if (!exists) return false;
    this.selectedInputKey = key;
    this.phaseEstimator.reset();
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
    const signal: MidiClockSignal = !source ? 'waiting'
      : sourceActive ? 'observed' : source.lastTickAtMs !== null ? 'stale' : 'waiting';
    const stability: MidiClockStability = !source || source.intervals.length < HISTORY_SIZE
      ? 'insufficient-data'
      : this.isStable(source.intervals) ? 'stable' : 'unstable';
    const medianInterval = source ? this.median(source.intervals) : 0;
    const phase = source ? this.phaseEstimator.getSnapshot(nowMs) : null;
    return Object.freeze({
      connection: this.connection,
      signal,
      stability: signal === 'observed' ? stability : 'insufficient-data',
      tickCount: source?.tickCount ?? 0,
      lastTickAtMs: source?.lastTickAtMs ?? null,
      measuredBpm: medianInterval > 0 ? 60000 / (medianInterval * 24) : null,
      inputCount: this.inputs.size,
      inputs: Object.freeze([...this.portClocks.values()].map((clock) => Object.freeze({ key: clock.key, name: clock.name }))),
      selectedInputKey: this.selectedInputKey,
      selectedInputName: source?.name ?? null,
      phaseRelativeTicks: phase?.phaseTicks ?? null,
      phaseRelativeQuarter: phase?.beatPhase ?? null,
      phaseLocked: phase?.phaseLocked ?? false,
      phaseState: phase?.state ?? 'waiting',
      phaseAcceptedIntervals: phase?.acceptedIntervals ?? 0,
      phaseRequiredIntervals: phase?.requiredIntervals ?? 6,
      phaseInferredMissingTicks: phase?.inferredMissingTicks ?? 0,
      phaseRejectedIntervals: phase?.rejectedIntervals ?? 0,
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

  private handleMessage(event: MidiMessageEventLike, input: MidiInputLike): void {
    // Ignore events already queued when a port was disconnected or permission was revoked.
    if (!this.inputs.has(input)) return;
    const data = event?.data;
    if (!data || data.length !== 1 || data[0] !== CLOCK_STATUS || !Number.isFinite(event.timeStamp)) return;
    const clock = this.portClocks.get(input);
    if (!clock) return;
    const time = event.timeStamp;
    if (clock.lastTickAtMs !== null) {
      const interval = time - clock.lastTickAtMs;
      if (interval > 0 && Number.isFinite(interval)) {
        clock.intervals.push(interval);
        if (clock.intervals.length > HISTORY_SIZE) clock.intervals.shift();
      }
    }
    clock.lastTickAtMs = time;
    clock.tickCount += 1;
    if (clock.key === this.selectedInputKey) this.phaseEstimator.push(time, clock.key);
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
