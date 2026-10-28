/** Explicitly opt-in, read-only Web MIDI Timing Clock monitor. */

import type { MidiAccessLike, MidiInputLike, MidiMessageEventLike, MidiInputState } from './MidiInputController';

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
}

export interface MidiClockInputOptions {
  readonly requestMIDIAccess?: () => Promise<MidiAccessLike> | undefined;
  readonly onChange?: () => void;
  readonly now?: () => number;
}

const CLOCK_STATUS = 0xf8;
const HISTORY_SIZE = 24;
const STALE_AFTER_MS = 1000;
const MAX_RELATIVE_JITTER = 0.05;

interface PortClockState {
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

/**
 * Observes one-byte F8 messages only. It never forwards messages to the note
 * engine or changes Transport tempo, phase, or playback state.
 */
export class MidiClockInputController {
  private readonly requestAccess: () => Promise<MidiAccessLike> | undefined;
  private readonly onChange?: () => void;
  private readonly now: () => number;
  private connection: MidiInputState = 'disconnected';
  private access?: MidiAccessLike;
  private readonly inputs = new Map<MidiInputLike, (event: MidiMessageEventLike) => void>();
  private readonly portClocks = new Map<MidiInputLike, PortClockState>();
  private generation = 0;
  private pending?: Promise<MidiInputState>;

  private readonly handleStateChange = (): void => {
    this.syncInputs();
    this.onChange?.();
  };

  constructor(options: MidiClockInputOptions = {}) {
    this.requestAccess = options.requestMIDIAccess ?? requestBrowserMidiAccess;
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
    pending = Promise.resolve(accessPromise).then((access) => {
      if (generation !== this.generation) return this.connection;
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
    for (const [input, listener] of this.inputs) input.removeEventListener('midimessage', listener);
    this.inputs.clear();
    this.access = undefined;
    this.portClocks.clear();
    this.setConnection('disconnected');
    this.onChange?.();
  }

  getSnapshot(nowMs = this.now()): MidiClockSnapshot {
    const streams = [...this.portClocks.values()];
    const activeStreams = streams.filter((stream) => stream.lastTickAtMs !== null
      && Math.max(0, nowMs - stream.lastTickAtMs) <= STALE_AFTER_MS);
    const signal: MidiClockSignal = activeStreams.length > 1
      ? 'ambiguous'
      : activeStreams.length === 1 ? 'observed' : streams.some((stream) => stream.lastTickAtMs !== null) ? 'stale' : 'waiting';
    const source = activeStreams.length === 1 ? activeStreams[0] : undefined;
    const stability: MidiClockStability = !source || source.intervals.length < HISTORY_SIZE
      ? 'insufficient-data'
      : this.isStable(source.intervals) ? 'stable' : 'unstable';
    const medianInterval = source ? this.median(source.intervals) : 0;
    return Object.freeze({
      connection: this.connection,
      signal,
      stability: signal === 'observed' ? stability : 'insufficient-data',
      tickCount: source?.tickCount ?? activeStreams.reduce((total, stream) => total + stream.tickCount, 0),
      lastTickAtMs: source?.lastTickAtMs ?? null,
      measuredBpm: medianInterval > 0 ? 60000 / (medianInterval * 24) : null,
      inputCount: this.inputs.size,
    });
  }

  private syncInputs(): void {
    const access = this.access;
    if (!access) return;
    const current = new Set<MidiInputLike>();
    access.inputs.forEach((input) => current.add(input));
    for (const [input, listener] of this.inputs) {
      if (!current.has(input)) {
        input.removeEventListener('midimessage', listener);
        this.inputs.delete(input);
        this.portClocks.delete(input);
      }
    }
    for (const input of current) {
      if (this.inputs.has(input)) continue;
      const listener = (event: MidiMessageEventLike): void => this.handleMessage(event, input);
      input.addEventListener('midimessage', listener);
      this.inputs.set(input, listener);
      this.portClocks.set(input, { intervals: [], lastTickAtMs: null, tickCount: 0 });
    }
  }

  private handleMessage(event: MidiMessageEventLike, input: MidiInputLike): void {
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
