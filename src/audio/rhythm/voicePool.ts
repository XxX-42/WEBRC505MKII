import { getDrumKitByIndex, getDrumKitByName, type DrumKitProfile } from "./kits";
import type { CleanRoomDrumEvent, DrumInstrument } from "./events";

export interface DrumVoicePoolOptions {
  readonly sampleRate: number;
  readonly kit: DrumKitProfile | number | string;
  readonly maxVoices?: number;
}

interface VoiceSlot {
  instrumentIndex: number;
  sequence: number;
  seed: number;
  velocity: number;
  startFrame: number;
  endFrame: number;
  roundRobin: number;
  amplitude: number;
}

const INSTRUMENT_INDEX: Readonly<Record<DrumInstrument, number>> = {
  kick: 0,
  snare: 1,
  closedHat: 2,
  openHat: 3,
  tom: 4,
  ride: 5,
  clap: 6,
  brush: 7,
};
const POOL_INSTRUMENTS: readonly DrumInstrument[] = ["kick", "snare", "closedHat", "openHat", "tom", "ride", "clap", "brush"];

// A rhythm pattern is far smaller than this bounded queue. Its storage is allocated once
// per processor, then reused. The AudioWorklet render path never creates event wrappers.
const PENDING_CAPACITY = 4096;

/**
 * Bounded, deterministic procedural drum renderer. Voices and event queue storage are
 * fixed-size. `scheduleFrame` + `renderInto` are the allocation-free real-time APIs;
 * object-based `schedule` and allocating `renderBlock` are convenience methods for tests
 * and offline callers. Noise is a pure function of seed + absolute sample index.
 */
export class DrumVoicePool {
  readonly sampleRate: number;
  readonly kit: DrumKitProfile;
  readonly maxVoices: number;

  private readonly voices: VoiceSlot[];
  private readonly pendingFrames = new Float64Array(PENDING_CAPACITY);
  private readonly pendingSequences = new Float64Array(PENDING_CAPACITY);
  private readonly pendingSeeds = new Uint32Array(PENDING_CAPACITY);
  private readonly pendingVelocities = new Uint8Array(PENDING_CAPACITY);
  private readonly pendingInstruments = new Uint8Array(PENDING_CAPACITY);
  private pendingHead = 0;
  private pendingTail = 0;
  private readonly roundRobinCounters = new Uint32Array(POOL_INSTRUMENTS.length);
  private nextSequence = 0;
  private lastRenderEnd: number | null = null;
  private _peakVoices = 0;
  private _stolenVoices = 0;
  private _startedVoices = 0;

  constructor(options: DrumVoicePoolOptions) {
    if (!Number.isFinite(options.sampleRate) || options.sampleRate < 8000) {
      throw new RangeError("sampleRate must be a finite value of at least 8000 Hz");
    }
    this.sampleRate = options.sampleRate;
    this.kit = resolveKit(options.kit);
    this.maxVoices = options.maxVoices ?? 16;
    if (!Number.isSafeInteger(this.maxVoices) || this.maxVoices < 1 || this.maxVoices > 64) {
      throw new RangeError("maxVoices must be an integer between 1 and 64");
    }
    this.voices = Array.from({ length: this.maxVoices }, () => ({
      instrumentIndex: -1,
      sequence: 0,
      seed: 0,
      velocity: 0,
      startFrame: 0,
      endFrame: 0,
      roundRobin: 0,
      amplitude: 0,
    }));
  }

  get activeVoiceCount(): number {
    let count = 0;
    for (let index = 0; index < this.voices.length; index += 1) {
      if (this.voices[index]!.instrumentIndex >= 0) count += 1;
    }
    return count;
  }

  get pendingEventCount(): number {
    return this.pendingTail - this.pendingHead;
  }

  get peakVoiceCount(): number {
    return this._peakVoices;
  }

  get stolenVoiceCount(): number {
    return this._stolenVoices;
  }

  get startedVoiceCount(): number {
    return this._startedVoices;
  }

  /** Returns the next round-robin slot that would be assigned for an instrument. */
  peekRoundRobin(instrument: DrumInstrument): number {
    const instrumentIndex = INSTRUMENT_INDEX[instrument];
    return (this.roundRobinCounters[instrumentIndex] ?? 0) % this.kit.timbre.roundRobinCount;
  }

  /** Convenience entry point for clean-room event objects; used outside process(). */
  schedule(event: CleanRoomDrumEvent): void {
    assertEvent(event);
    this.scheduleFrame(event.instrument, event.velocity, event.seed, event.frame);
  }

  /**
   * Schedule primitives into the fixed typed-array queue. This method performs no object,
   * array, Map, or node allocation and is safe for the AudioWorklet render callback.
   */
  scheduleFrame(instrument: DrumInstrument, velocity: number, seed: number, frame: number): void {
    const instrumentIndex = INSTRUMENT_INDEX[instrument];
    if (instrumentIndex === undefined) throw new RangeError(`Unknown drum instrument: ${String(instrument)}`);
    if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127) {
      throw new RangeError("event.velocity must be an integer from 1 to 127");
    }
    if (!Number.isSafeInteger(seed)) throw new RangeError("event.seed must be a safe integer");
    if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("event.frame must be a non-negative safe integer");
    if (this.lastRenderEnd !== null && frame < this.lastRenderEnd) {
      throw new RangeError("Cannot schedule a drum event into audio frames that have already been rendered");
    }
    this.ensureQueueSpace();

    const sequence = this.nextSequence++;
    let insertion = this.pendingTail;
    if (this.pendingTail > this.pendingHead && frame < this.pendingFrames[this.pendingTail - 1]!) {
      // The worklet's sorted template normally appends; retain stable insertion semantics
      // for offline callers that schedule events out of order.
      let low = this.pendingHead;
      let high = this.pendingTail;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.pendingFrames[middle]! <= frame) low = middle + 1;
        else high = middle;
      }
      insertion = low;
      for (let index = this.pendingTail; index > insertion; index -= 1) {
        this.copyPending(index - 1, index);
      }
    }
    this.pendingFrames[insertion] = frame;
    this.pendingSequences[insertion] = sequence;
    this.pendingSeeds[insertion] = seed >>> 0;
    this.pendingVelocities[insertion] = velocity;
    this.pendingInstruments[insertion] = instrumentIndex;
    this.pendingTail += 1;
  }

  scheduleMany(events: readonly CleanRoomDrumEvent[]): void {
    for (let index = 0; index < events.length; index += 1) this.schedule(events[index]!);
  }

  /** Render a mono block beginning at an absolute integer sample frame. */
  renderBlock(startFrame: number, frameCount: number): Float32Array {
    if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
      throw new RangeError("frameCount must be a non-negative safe integer");
    }
    const output = new Float32Array(frameCount);
    this.renderInto(startFrame, output);
    return output;
  }

  /** Render directly into caller-owned storage; no per-call output allocation. */
  renderInto(startFrame: number, output: Float32Array): void {
    if (!Number.isSafeInteger(startFrame) || startFrame < 0) {
      throw new RangeError("startFrame must be a non-negative safe integer");
    }
    const frameCount = output.length;
    if (this.lastRenderEnd !== null && startFrame < this.lastRenderEnd) {
      throw new RangeError("renderBlock must advance monotonically on the absolute sample-frame timeline");
    }
    const endFrame = startFrame + frameCount;
    if (!Number.isSafeInteger(endFrame)) throw new RangeError("render range exceeds safe sample-frame precision");

    for (let offset = 0; offset < frameCount; offset += 1) {
      const frame = startFrame + offset;
      for (let index = 0; index < this.voices.length; index += 1) {
        const voice = this.voices[index]!;
        if (voice.instrumentIndex >= 0 && frame >= voice.endFrame) voice.instrumentIndex = -1;
      }
      while (this.pendingHead < this.pendingTail && this.pendingFrames[this.pendingHead]! <= frame) {
        const eventFrame = this.pendingFrames[this.pendingHead]!;
        const sequence = this.pendingSequences[this.pendingHead]!;
        const seed = this.pendingSeeds[this.pendingHead]!;
        const velocity = this.pendingVelocities[this.pendingHead]!;
        const instrumentIndex = this.pendingInstruments[this.pendingHead]!;
        this.pendingHead += 1;
        const duration = this.voiceDurationFrames(instrumentIndex);
        if (eventFrame + duration > frame) {
          this.startVoice(instrumentIndex, velocity, seed, eventFrame, sequence, duration);
        }
      }
      let sample = 0;
      for (let voiceIndex = 0; voiceIndex < this.voices.length; voiceIndex += 1) {
        const voice = this.voices[voiceIndex]!;
        if (voice.instrumentIndex < 0) continue;
        if (frame >= voice.endFrame) {
          voice.instrumentIndex = -1;
          continue;
        }
        sample += this.sampleVoice(voice, frame);
      }
      const drive = 1 + this.kit.timbre.saturation * 3;
      output[offset] = Math.tanh(sample * drive) / Math.tanh(drive);
    }

    for (let index = 0; index < this.voices.length; index += 1) {
      const voice = this.voices[index]!;
      if (voice.instrumentIndex >= 0 && endFrame >= voice.endFrame) voice.instrumentIndex = -1;
    }
    this.lastRenderEnd = endFrame;
    this.compactConsumedQueue();
  }

  /** Reset voices, queue, counters, and the absolute render cursor. */
  reset(): void {
    this.pendingHead = 0;
    this.pendingTail = 0;
    this.roundRobinCounters.fill(0);
    for (let index = 0; index < this.voices.length; index += 1) {
      this.voices[index]!.instrumentIndex = -1;
    }
    this.nextSequence = 0;
    this.lastRenderEnd = null;
    this._peakVoices = 0;
    this._stolenVoices = 0;
    this._startedVoices = 0;
  }

  private ensureQueueSpace(): void {
    if (this.pendingTail < PENDING_CAPACITY) return;
    this.compactConsumedQueue();
    if (this.pendingTail >= PENDING_CAPACITY) {
      throw new RangeError(`Drum event queue capacity (${PENDING_CAPACITY}) exceeded`);
    }
  }

  private compactConsumedQueue(): void {
    if (this.pendingHead === 0) return;
    if (this.pendingHead === this.pendingTail) {
      this.pendingHead = 0;
      this.pendingTail = 0;
      return;
    }
    if (this.pendingHead < 128 && this.pendingTail < PENDING_CAPACITY) return;
    const count = this.pendingTail - this.pendingHead;
    this.pendingFrames.copyWithin(0, this.pendingHead, this.pendingTail);
    this.pendingSequences.copyWithin(0, this.pendingHead, this.pendingTail);
    this.pendingSeeds.copyWithin(0, this.pendingHead, this.pendingTail);
    this.pendingVelocities.copyWithin(0, this.pendingHead, this.pendingTail);
    this.pendingInstruments.copyWithin(0, this.pendingHead, this.pendingTail);
    this.pendingHead = 0;
    this.pendingTail = count;
  }

  private copyPending(from: number, to: number): void {
    this.pendingFrames[to] = this.pendingFrames[from]!;
    this.pendingSequences[to] = this.pendingSequences[from]!;
    this.pendingSeeds[to] = this.pendingSeeds[from]!;
    this.pendingVelocities[to] = this.pendingVelocities[from]!;
    this.pendingInstruments[to] = this.pendingInstruments[from]!;
  }

  private voiceDurationFrames(instrumentIndex: number): number {
    const t = this.kit.timbre;
    const durationMs = instrumentIndex === INSTRUMENT_INDEX.kick ? t.kickDecayMs
      : instrumentIndex === INSTRUMENT_INDEX.snare || instrumentIndex === INSTRUMENT_INDEX.clap ? t.snareDecayMs
        : instrumentIndex === INSTRUMENT_INDEX.tom ? t.tomDecayMs
          : instrumentIndex === INSTRUMENT_INDEX.openHat || instrumentIndex === INSTRUMENT_INDEX.ride ? Math.max(t.hatDecayMs * 2.8, 90)
            : instrumentIndex === INSTRUMENT_INDEX.brush ? Math.max(t.snareDecayMs * 1.7, 160)
              : t.hatDecayMs;
    return Math.max(1, Math.round((this.sampleRate * durationMs) / 1000));
  }

  private startVoice(
    instrumentIndex: number,
    velocity: number,
    seed: number,
    startFrame: number,
    sequence: number,
    duration: number,
  ): void {
    let slotIndex = -1;
    for (let index = 0; index < this.voices.length; index += 1) {
      if (this.voices[index]!.instrumentIndex < 0) { slotIndex = index; break; }
    }
    if (slotIndex < 0) {
      // Oldest start frame is the voice-steal policy; stable array order resolves ties.
      slotIndex = 0;
      for (let index = 1; index < this.voices.length; index += 1) {
        const candidate = this.voices[index]!;
        const oldest = this.voices[slotIndex]!;
        if (candidate.startFrame < oldest.startFrame || (candidate.startFrame === oldest.startFrame && candidate.sequence < oldest.sequence)) {
          slotIndex = index;
        }
      }
      this._stolenVoices += 1;
    }
    const voice = this.voices[slotIndex]!;
    const rrCounter = this.roundRobinCounters[instrumentIndex]!;
    const roundRobin = rrCounter % this.kit.timbre.roundRobinCount;
    this.roundRobinCounters[instrumentIndex] = rrCounter + 1;
    const normalizedVelocity = velocity / 127;
    voice.instrumentIndex = instrumentIndex;
    voice.sequence = sequence;
    voice.seed = seed;
    voice.velocity = velocity;
    voice.startFrame = startFrame;
    voice.endFrame = startFrame + duration;
    voice.roundRobin = roundRobin;
    voice.amplitude = Math.pow(normalizedVelocity, this.kit.timbre.velocityExponent) * (0.965 + roundRobin * 0.017);
    this._startedVoices += 1;
    const active = this.activeVoiceCount;
    if (active > this._peakVoices) this._peakVoices = active;
  }

  private sampleVoice(voice: VoiceSlot, absoluteFrame: number): number {
    const instrument = POOL_INSTRUMENTS[voice.instrumentIndex]!;
    const ageFrames = absoluteFrame - voice.startFrame;
    const age = ageFrames / this.sampleRate;
    const duration = (voice.endFrame - voice.startFrame) / this.sampleRate;
    const t = this.kit.timbre;
    const rrDetune = 1 + (voice.roundRobin - (t.roundRobinCount - 1) / 2) * 0.0015;
    const envelope = Math.exp(-6.2 * age / Math.max(duration, 0.001));
    let signal: number;

    switch (instrument) {
      case "kick": {
        const initialHz = (t.kickHz + t.kickPitchDropHz) * rrDetune;
        const settledHz = t.kickHz * rrDetune;
        const pitchDropTime = 0.018 + (voice.roundRobin % 3) * 0.002;
        const cycles = settledHz * age + (initialHz - settledHz) * pitchDropTime * (1 - Math.exp(-age / pitchDropTime));
        const click = deterministicNoise(voice.seed, ageFrames) * Math.exp(-age / 0.006) * 0.13;
        signal = Math.sin(2 * Math.PI * cycles) * envelope + click;
        break;
      }
      case "snare": {
        const noise = highPassedNoise(voice.seed, ageFrames);
        const body = Math.sin(2 * Math.PI * (t.snareHz * rrDetune) * age) * Math.exp(-age / Math.max(duration * 0.28, 0.02));
        signal = noise * t.snareNoiseMix + body * (1 - t.snareNoiseMix) * 0.75;
        signal *= envelope;
        break;
      }
      case "clap": {
        const pulse = Math.exp(-age / Math.max(duration * 0.20, 0.012))
          + 0.55 * Math.exp(-Math.abs(age - 0.014) / Math.max(duration * 0.16, 0.010))
          + 0.32 * Math.exp(-Math.abs(age - 0.029) / Math.max(duration * 0.13, 0.008));
        signal = highPassedNoise(voice.seed, ageFrames) * pulse * 0.62;
        break;
      }
      case "closedHat":
      case "openHat":
      case "ride": {
        const bright = highPassedNoise(voice.seed, ageFrames);
        const metallic = Math.sin(2 * Math.PI * t.hatCutoffHz * age)
          + 0.45 * Math.sin(2 * Math.PI * t.hatCutoffHz * 1.37 * age)
          + 0.28 * Math.sin(2 * Math.PI * t.hatCutoffHz * 1.91 * age);
        const hatDecay = instrument === "closedHat" ? duration * 0.30 : duration * 0.65;
        const rideWeight = instrument === "ride" ? 0.46 : 0.22;
        signal = (bright * (1 - rideWeight) + metallic * rideWeight) * Math.exp(-age / Math.max(hatDecay, 0.008));
        break;
      }
      case "tom": {
        const pitchDropTime = 0.045;
        const cycles = t.tomHz * age + t.tomHz * 0.75 * pitchDropTime * (1 - Math.exp(-age / pitchDropTime));
        signal = Math.sin(2 * Math.PI * cycles) * envelope + highPassedNoise(voice.seed, ageFrames) * 0.08 * envelope;
        break;
      }
      case "brush": {
        const smoothNoise = deterministicNoise(voice.seed, ageFrames) * 0.50
          + deterministicNoise(voice.seed, Math.max(0, ageFrames - 1)) * 0.35
          + deterministicNoise(voice.seed, Math.max(0, ageFrames - 2)) * 0.15;
        signal = smoothNoise * envelope * 0.5 + Math.sin(2 * Math.PI * (t.snareHz * 0.65) * age) * envelope * 0.10;
        break;
      }
    }
    return signal * voice.amplitude * (1 - t.roomMix * 0.22);
  }
}

function resolveKit(kit: DrumKitProfile | number | string): DrumKitProfile {
  if (typeof kit === "number") {
    const match = getDrumKitByIndex(kit);
    if (match) return match;
  } else if (typeof kit === "string") {
    const match = getDrumKitByName(kit);
    if (match) return match;
  } else if (kit && kit.timbreProvenance === "clean-room-procedural") {
    return kit;
  }
  throw new RangeError(`Unknown drum kit: ${String(kit)}`);
}

function assertEvent(event: CleanRoomDrumEvent): void {
  if (!Number.isSafeInteger(event.frame) || event.frame < 0) {
    throw new RangeError("event.frame must be a non-negative safe integer");
  }
  if (!Number.isInteger(event.velocity) || event.velocity < 1 || event.velocity > 127) {
    throw new RangeError("event.velocity must be an integer from 1 to 127");
  }
  if (!Number.isSafeInteger(event.seed)) throw new RangeError("event.seed must be a safe integer");
  if (event.provenance !== "clean-room-generated") throw new RangeError("DrumVoicePool accepts clean-room generated events only");
}

function deterministicNoise(seed: number, sampleIndex: number): number {
  let value = (seed ^ Math.imul(sampleIndex + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return ((value >>> 0) / 0x7fffffff) - 1;
}

function highPassedNoise(seed: number, sampleIndex: number): number {
  return (deterministicNoise(seed, sampleIndex) - deterministicNoise(seed, Math.max(0, sampleIndex - 1))) * 0.5;
}
