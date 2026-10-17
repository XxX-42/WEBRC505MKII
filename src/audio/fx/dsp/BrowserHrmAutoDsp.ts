/**
 * Clean-room, provisional Browser HRM AUTO analysis and MIDI voice-assignment
 * core. This class does not render or transpose audio. It tracks one pitched
 * (normally monophonic) source with a bounded decimated-YIN detector, parses
 * timestamped MIDI note events for one configured channel, and publishes
 * bounded fixed-size target-shift state events for a host pitch shifter.
 *
 * Provisional voicing rules: with one held MIDI note, its pitch class is
 * snapped to the configured key/scale and the diatonic third and fifth above
 * it are selected; with two or more unique held notes, the two lowest held
 * notes are selected and independently snapped to the configured scale. Each
 * target is placed in the octave nearest the current detected source pitch,
 * then exposed as a semitone shift from that source (clamped to +/-24).
 * Repeated note-ons are counted; a matching note-off decrements that count.
 * Inputs containing chords/polyphonic material are unsupported by this single
 * F0 tracker. Detector acquisition is approximately 30–60 ms at 48 kHz for
 * 55–110 Hz fundamentals; this varies with sample rate, source and analysis
 * hop. These semantics and latency are clean-room estimates, not Roland
 * specifications or sound-quality acceptance.
 *
 * All rings and scratch storage are allocated at construction. `processSample`
 * is bounded and does not allocate. MIDI/state queues have fixed capacities;
 * their overflow counters are observable. MIDI access/permission is entirely
 * outside this DSP core and must be explicitly opt-in in the host.
 */

export type BrowserHrmAutoScale = 0 | 1 | 2 | 3 | 4;
export type BrowserHrmAutoVoiceCount = 1 | 2;
export type BrowserHrmAutoMidiEventType = 'noteOn' | 'noteOff';

export interface BrowserHrmAutoParameters {
  /** Catalog value 0..11, where 0 is C. */
  key?: number;
  /** 0 Major, 1 natural minor, 2 harmonic minor, 3 Dorian, 4 Mixolydian. */
  scale?: number;
  /** 1-based MIDI channel. */
  midiChannel?: number;
  /** Catalog effect mix 0..100; retained for the host adapter. */
  mix?: number;
  /** Host may request one or two pitch-shifter voices. Defaults to two. */
  voices?: number;
}

export type BrowserHrmAutoStateReason = 0 | 1 | 2;

const DEFAULT_EVENT_CAPACITY = 128;
const DEFAULT_STATE_CAPACITY = 128;
const DECIMATION_FACTOR = 4;
const YIN_RING_SIZE = 2048;
const YIN_RING_MASK = YIN_RING_SIZE - 1;
const YIN_HOP = 64;
const MIN_F0_HZ = 55;
const MAX_F0_HZ = 1100;
const MIN_RMS = 0.0008;
const CONFIDENCE_THRESHOLD = 0.62;
const INACTIVE_TARGET = -128;
const STATE_TARGET_EPSILON = 0.25;
const MAX_NOTE = 127;
const SCALE_INTERVALS: readonly (readonly number[])[] = [
  [0, 2, 4, 5, 7, 9, 11], // Major
  [0, 2, 3, 5, 7, 8, 10], // Natural minor
  [0, 2, 3, 5, 7, 8, 11], // Harmonic minor
  [0, 2, 3, 5, 7, 9, 10], // Dorian
  [0, 2, 4, 5, 7, 9, 10], // Mixolydian
];

export class BrowserHrmAutoDsp {
  readonly sampleRate: number;

  pitchEstimateHz = 0;
  pitchEstimateMidi = 0;
  pitchConfidence = 0;
  hasPitch = false;
  midiOverflowCount = 0;
  stateOverflowCount = 0;
  framesProcessed = 0;

  /** Mutable output fields populated by `tryPopStateChange`; no event object is allocated. */
  lastStateChangeFrame = -1;
  lastStateChangeReason: BrowserHrmAutoStateReason = 0;
  lastStateChangeNote = -1;
  lastStateChangeNoteOn = false;
  lastStateChangeActiveCount = 0;
  lastStateChangeVoiceCount = 0;
  lastStateChangeTarget1 = INACTIVE_TARGET;
  lastStateChangeTarget2 = INACTIVE_TARGET;

  private readonly minLag: number;
  private readonly maxLag: number;
  private readonly yinWindow: number;
  private readonly decimatedRate: number;
  private readonly yinRing = new Float32Array(YIN_RING_SIZE);
  private readonly yinCmnd = new Float32Array(256);
  private readonly midiFrames: Float64Array;
  private readonly midiTypes: Uint8Array;
  private readonly midiChannels: Uint8Array;
  private readonly midiNotes: Uint8Array;
  private midiCount = 0;
  private readonly stateFrames: Float64Array;
  private readonly stateReasons: Uint8Array;
  private readonly stateNotes: Int16Array;
  private readonly stateNoteOns: Uint8Array;
  private readonly stateActiveCounts: Uint8Array;
  private readonly stateVoiceCounts: Uint8Array;
  private readonly stateTargets1: Float32Array;
  private readonly stateTargets2: Float32Array;
  private stateHead = 0;
  private stateTail = 0;
  private stateCount = 0;
  private readonly activeNoteCounts = new Uint8Array(128);
  private activeNoteCount = 0;
  private keyValue: number;
  private scaleValue: BrowserHrmAutoScale;
  private midiChannelValue: number;
  private mixValue: number;
  private voicesValue: BrowserHrmAutoVoiceCount;
  private currentVoiceCount = 0;
  private currentTarget1 = INACTIVE_TARGET;
  private currentTarget2 = INACTIVE_TARGET;
  private decimationSum = 0;
  private decimationCount = 0;
  private decimatedSamples = 0;
  private analysisCountdown = YIN_HOP;
  private totalSinceReset = 0;
  private failedAnalyses = 0;
  private lastProcessedFrame = 0;

  constructor(
    sampleRate: number,
    options: BrowserHrmAutoParameters & { eventCapacity?: number; stateCapacity?: number } = {},
  ) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8_000 ? sampleRate : 48_000;
    this.decimatedRate = this.sampleRate / DECIMATION_FACTOR;
    this.maxLag = Math.min(255, Math.floor(this.decimatedRate / MIN_F0_HZ));
    this.minLag = Math.max(2, Math.floor(this.decimatedRate / MAX_F0_HZ));
    this.yinWindow = Math.min(384, Math.max(64, this.maxLag * 2));
    const midiCapacity = this.capacity(options.eventCapacity, DEFAULT_EVENT_CAPACITY);
    const stateCapacity = this.capacity(options.stateCapacity, DEFAULT_STATE_CAPACITY);
    this.midiFrames = new Float64Array(midiCapacity);
    this.midiTypes = new Uint8Array(midiCapacity);
    this.midiChannels = new Uint8Array(midiCapacity);
    this.midiNotes = new Uint8Array(midiCapacity);
    this.stateFrames = new Float64Array(stateCapacity);
    this.stateReasons = new Uint8Array(stateCapacity);
    this.stateNotes = new Int16Array(stateCapacity);
    this.stateNoteOns = new Uint8Array(stateCapacity);
    this.stateActiveCounts = new Uint8Array(stateCapacity);
    this.stateVoiceCounts = new Uint8Array(stateCapacity);
    this.stateTargets1 = new Float32Array(stateCapacity);
    this.stateTargets2 = new Float32Array(stateCapacity);
    this.keyValue = this.clampKey(options.key ?? 0);
    this.scaleValue = this.clampScale(options.scale ?? 0);
    this.midiChannelValue = this.clampChannel(options.midiChannel ?? 1);
    this.mixValue = this.clampMix(options.mix ?? 70);
    this.voicesValue = this.clampVoices(options.voices ?? 2);
  }

  get latencyFrames(): number {
    return (this.yinWindow + this.maxLag + YIN_HOP) * DECIMATION_FACTOR;
  }

  get activeMidiNoteCount(): number { return this.activeNoteCount; }
  get queueDepth(): number { return this.midiCount; }
  get stateQueueDepth(): number { return this.stateCount; }
  get key(): number { return this.keyValue; }
  get scale(): BrowserHrmAutoScale { return this.scaleValue; }
  get midiChannel(): number { return this.midiChannelValue; }
  get mixPercent(): number { return this.mixValue; }
  get configuredVoiceCount(): BrowserHrmAutoVoiceCount { return this.voicesValue; }
  get targetVoiceCount(): number { return this.currentVoiceCount; }
  get targetSemitones1(): number { return this.currentTarget1; }
  get targetSemitones2(): number { return this.currentTarget2; }

  /**
   * Enqueue a sample-frame-stamped MIDI note event. Events are kept in stable
   * frame order and the fixed queue rejects an event on overflow. `noteOn`
   * with velocity zero follows MIDI semantics and is treated as `noteOff`.
   */
  enqueueMidiEvent(
    type: BrowserHrmAutoMidiEventType,
    channel: number,
    note: number,
    velocity: number,
    frame: number,
  ): boolean {
    if (type !== 'noteOn' && type !== 'noteOff') return false;
    if (!Number.isInteger(channel) || channel < 1 || channel > 16) return false;
    if (!Number.isInteger(note) || note < 0 || note > MAX_NOTE) return false;
    if (!Number.isFinite(frame) || frame < 0) return false;
    if (this.midiCount >= this.midiFrames.length) {
      this.midiOverflowCount += 1;
      return false;
    }
    const normalizedType = type === 'noteOn' && velocity > 0 ? 1 : 0;
    const eventFrame = Math.floor(frame);
    let insertion = this.midiCount;
    while (insertion > 0 && this.midiFrames[insertion - 1]! > eventFrame) {
      this.copyMidiEvent(insertion - 1, insertion);
      insertion -= 1;
    }
    this.midiFrames[insertion] = eventFrame;
    this.midiTypes[insertion] = normalizedType;
    this.midiChannels[insertion] = channel;
    this.midiNotes[insertion] = note;
    this.midiCount += 1;
    return true;
  }

  /** Update control values. Changing channel clears held notes to avoid stuck voices. */
  setParameters(parameters: BrowserHrmAutoParameters): void {
    let changed = false;
    if (Number.isFinite(parameters.key)) {
      const next = this.clampKey(parameters.key as number);
      changed ||= next !== this.keyValue;
      this.keyValue = next;
    }
    if (Number.isFinite(parameters.scale)) {
      const next = this.clampScale(parameters.scale as number);
      changed ||= next !== this.scaleValue;
      this.scaleValue = next;
    }
    if (Number.isFinite(parameters.midiChannel)) {
      const next = this.clampChannel(parameters.midiChannel as number);
      if (next !== this.midiChannelValue) {
        this.midiChannelValue = next;
        this.activeNoteCounts.fill(0);
        this.activeNoteCount = 0;
        changed = true;
      }
    }
    if (Number.isFinite(parameters.mix)) this.mixValue = this.clampMix(parameters.mix as number);
    if (Number.isFinite(parameters.voices)) {
      const next = this.clampVoices(parameters.voices as number);
      changed ||= next !== this.voicesValue;
      this.voicesValue = next;
    }
    if (changed) this.recomputeTargets(this.lastProcessedFrame, 0, -1, false, true);
  }

  /** Analyze one mono sample using an absolute audio frame. */
  processSample(input: number, frame: number): void {
    const sampleFrame = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : this.framesProcessed;
    const sample = Number.isFinite(input) ? Math.max(-8, Math.min(8, input)) : 0;
    this.framesProcessed += 1;
    this.lastProcessedFrame = sampleFrame;
    this.applyDueMidiEvents(sampleFrame);

    this.decimationSum += sample;
    this.decimationCount += 1;
    if (this.decimationCount >= DECIMATION_FACTOR) {
      this.pushDecimatedSample(this.decimationSum / DECIMATION_FACTOR, sampleFrame);
      this.decimationSum = 0;
      this.decimationCount = 0;
    }
  }

  /** Index in the ascending MIDI-note ordering; returns -1 for an invalid index. */
  getActiveMidiNote(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.activeNoteCount) return -1;
    let ordinal = 0;
    for (let note = 0; note <= MAX_NOTE; note += 1) {
      if (this.activeNoteCounts[note] === 0) continue;
      if (ordinal === index) return note;
      ordinal += 1;
    }
    return -1;
  }

  /** Pop the next fixed state record into the mutable lastStateChange* fields. */
  tryPopStateChange(): boolean {
    if (this.stateCount <= 0) return false;
    const index = this.stateHead;
    this.lastStateChangeFrame = this.stateFrames[index]!;
    this.lastStateChangeReason = this.stateReasons[index]! as BrowserHrmAutoStateReason;
    this.lastStateChangeNote = this.stateNotes[index]!;
    this.lastStateChangeNoteOn = this.stateNoteOns[index] !== 0;
    this.lastStateChangeActiveCount = this.stateActiveCounts[index]!;
    this.lastStateChangeVoiceCount = this.stateVoiceCounts[index]!;
    this.lastStateChangeTarget1 = this.stateTargets1[index]!;
    this.lastStateChangeTarget2 = this.stateTargets2[index]!;
    this.stateHead += 1;
    if (this.stateHead >= this.stateFrames.length) this.stateHead = 0;
    this.stateCount -= 1;
    return true;
  }

  reset(): void {
    this.yinRing.fill(0);
    this.yinCmnd.fill(0);
    this.midiFrames.fill(0);
    this.midiTypes.fill(0);
    this.midiChannels.fill(0);
    this.midiNotes.fill(0);
    this.stateFrames.fill(0);
    this.stateReasons.fill(0);
    this.stateNotes.fill(0);
    this.stateNoteOns.fill(0);
    this.stateActiveCounts.fill(0);
    this.stateVoiceCounts.fill(0);
    this.stateTargets1.fill(0);
    this.stateTargets2.fill(0);
    this.activeNoteCounts.fill(0);
    this.midiCount = 0;
    this.stateHead = 0;
    this.stateTail = 0;
    this.stateCount = 0;
    this.activeNoteCount = 0;
    this.currentVoiceCount = 0;
    this.currentTarget1 = INACTIVE_TARGET;
    this.currentTarget2 = INACTIVE_TARGET;
    this.decimationSum = 0;
    this.decimationCount = 0;
    this.decimatedSamples = 0;
    this.analysisCountdown = YIN_HOP;
    this.totalSinceReset = 0;
    this.failedAnalyses = 0;
    this.pitchEstimateHz = 0;
    this.pitchEstimateMidi = 0;
    this.pitchConfidence = 0;
    this.hasPitch = false;
    this.midiOverflowCount = 0;
    this.stateOverflowCount = 0;
    this.framesProcessed = 0;
    this.lastProcessedFrame = 0;
    this.lastStateChangeFrame = -1;
    this.lastStateChangeReason = 0;
    this.lastStateChangeNote = -1;
    this.lastStateChangeNoteOn = false;
    this.lastStateChangeActiveCount = 0;
    this.lastStateChangeVoiceCount = 0;
    this.lastStateChangeTarget1 = INACTIVE_TARGET;
    this.lastStateChangeTarget2 = INACTIVE_TARGET;
  }

  private applyDueMidiEvents(frame: number): void {
    while (this.midiCount > 0 && this.midiFrames[0]! <= frame) {
      const eventFrame = this.midiFrames[0]!;
      const type = this.midiTypes[0]!;
      const channel = this.midiChannels[0]!;
      const note = this.midiNotes[0]!;
      for (let i = 1; i < this.midiCount; i += 1) this.copyMidiEvent(i, i - 1);
      this.midiCount -= 1;
      if (channel !== this.midiChannelValue) continue;
      if (type === 1) {
        const activeCount = this.activeNoteCounts[note]!;
        if (activeCount === 0) this.activeNoteCount += 1;
        if (activeCount < 255) this.activeNoteCounts[note] = activeCount + 1;
        this.recomputeTargets(eventFrame, 1, note, true, true);
      } else {
        const activeCount = this.activeNoteCounts[note]!;
        if (activeCount > 0) {
          this.activeNoteCounts[note] = activeCount - 1;
          if (this.activeNoteCounts[note] === 0) {
            this.activeNoteCount -= 1;
          }
          this.recomputeTargets(eventFrame, 2, note, false, true);
        }
      }
    }
  }

  private pushDecimatedSample(sample: number, frame: number): void {
    this.yinRing[this.decimatedSamples & YIN_RING_MASK] = sample;
    this.decimatedSamples += 1;
    this.totalSinceReset += 1;
    this.analysisCountdown -= 1;
    if (this.analysisCountdown <= 0) {
      this.analysisCountdown = YIN_HOP;
      if (this.totalSinceReset >= this.yinWindow + this.maxLag) this.analyzePitch(frame);
    }
  }

  private analyzePitch(frame: number): void {
    const newest = this.decimatedSamples - 1;
    let energy = 0;
    for (let i = 0; i < this.yinWindow; i += 1) {
      const sample = this.yinRing[(newest - i) & YIN_RING_MASK]!;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / this.yinWindow);
    if (!Number.isFinite(rms) || rms < MIN_RMS) {
      this.clearPitch(frame);
      return;
    }

    let cumulative = 0;
    let bestLag = -1;
    let bestCmnd = 1;
    let firstThresholdLag = -1;
    for (let lag = 1; lag <= this.maxLag; lag += 1) {
      let difference = 0;
      for (let i = 0; i < this.yinWindow; i += 1) {
        const a = this.yinRing[(newest - i) & YIN_RING_MASK]!;
        const b = this.yinRing[(newest - i - lag) & YIN_RING_MASK]!;
        const delta = a - b;
        difference += delta * delta;
      }
      cumulative += difference;
      const normalized = lag === 1 || cumulative <= 1e-20 ? 1 : (difference * lag) / cumulative;
      this.yinCmnd[lag] = normalized;
      if (lag >= this.minLag && normalized < bestCmnd) {
        bestCmnd = normalized;
        bestLag = lag;
      }
      if (lag >= this.minLag && firstThresholdLag < 0 && normalized < 0.16) firstThresholdLag = lag;
    }

    if (firstThresholdLag >= 0) {
      let lag = firstThresholdLag;
      while (lag < this.maxLag && this.yinCmnd[lag + 1]! < this.yinCmnd[lag]!) lag += 1;
      bestLag = lag;
      bestCmnd = this.yinCmnd[lag]!;
    }
    if (bestLag < this.minLag || bestLag > this.maxLag || bestCmnd > (firstThresholdLag >= 0 ? 0.45 : 0.25)) {
      this.failedAnalyses += 1;
      if (this.failedAnalyses >= 2) this.clearPitch(frame);
      return;
    }

    const before = this.yinCmnd[bestLag - 1] ?? bestCmnd;
    const center = this.yinCmnd[bestLag] ?? bestCmnd;
    const after = this.yinCmnd[bestLag + 1] ?? center;
    const denominator = before - (2 * center) + after;
    const correction = Math.abs(denominator) > 1e-8
      ? Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denominator))
      : 0;
    const frequency = this.decimatedRate / (bestLag + correction);
    if (!Number.isFinite(frequency) || frequency < MIN_F0_HZ || frequency > MAX_F0_HZ) {
      this.failedAnalyses += 1;
      if (this.failedAnalyses >= 2) this.clearPitch(frame);
      return;
    }
    this.failedAnalyses = 0;
    this.pitchEstimateHz = frequency;
    this.pitchEstimateMidi = 69 + (12 * Math.log2(frequency / 440));
    this.pitchConfidence = Math.max(0, Math.min(1, 1 - bestCmnd));
    const nextHasPitch = this.pitchConfidence >= CONFIDENCE_THRESHOLD;
    if (!nextHasPitch) {
      this.hasPitch = false;
      this.clearPitch(frame);
      return;
    }
    const previousHasPitch = this.hasPitch;
    this.hasPitch = true;
    if (this.activeNoteCount > 0 && (previousHasPitch !== nextHasPitch || this.targetsNeedRefresh())) {
      this.recomputeTargets(frame, 0, -1, false, false);
    }
  }

  private clearPitch(frame: number): void {
    const hadPitch = this.hasPitch;
    this.pitchEstimateHz = 0;
    this.pitchEstimateMidi = 0;
    this.pitchConfidence = 0;
    this.hasPitch = false;
    this.failedAnalyses = 0;
    if (hadPitch && this.activeNoteCount > 0) this.recomputeTargets(frame, 0, -1, false, true);
  }

  private recomputeTargets(
    frame: number,
    reason: BrowserHrmAutoStateReason,
    note: number,
    noteOn: boolean,
    forceEvent: boolean,
  ): void {
    const oldCount = this.currentVoiceCount;
    const oldTarget1 = this.currentTarget1;
    const oldTarget2 = this.currentTarget2;
    this.currentVoiceCount = 0;
    this.currentTarget1 = INACTIVE_TARGET;
    this.currentTarget2 = INACTIVE_TARGET;

    if (this.activeNoteCount > 0 && this.hasPitch) {
      let first = -1;
      let second = -1;
      for (let midi = 0; midi <= MAX_NOTE; midi += 1) {
        if (this.activeNoteCounts[midi] === 0) continue;
        if (first < 0) first = midi;
        else if (second < 0) { second = midi; break; }
      }
      if (this.activeNoteCount === 1 && first >= 0) {
        const root = this.snapToScale(first);
        const third = this.scaleDegreeAbove(root, 2);
        const fifth = this.scaleDegreeAbove(root, 4);
        this.currentTarget1 = this.shiftToNearestSource(third);
        if (this.voicesValue >= 2) this.currentTarget2 = this.shiftToNearestSource(fifth);
        this.currentVoiceCount = this.voicesValue >= 2 ? 2 : 1;
      } else if (first >= 0) {
        this.currentTarget1 = this.shiftToNearestSource(this.snapToScale(first));
        if (this.voicesValue >= 2 && second >= 0) {
          this.currentTarget2 = this.shiftToNearestSource(this.snapToScale(second));
        }
        this.currentVoiceCount = this.voicesValue >= 2 && second >= 0 ? 2 : 1;
      }
    }

    const targetChanged = this.currentVoiceCount !== oldCount
      || !this.closeTarget(this.currentTarget1, oldTarget1)
      || !this.closeTarget(this.currentTarget2, oldTarget2);
    if (forceEvent || targetChanged) {
      this.pushStateChange(frame, reason, note, noteOn);
    }
  }

  private targetsNeedRefresh(): boolean {
    if (this.activeNoteCount === 0 || !this.hasPitch) return false;
    // Refresh only after a perceptible fraction of a semitone to bound output
    // traffic while still following typical vocal/instrument pitch movement.
    const previous = this.currentTarget1;
    const candidate = this.calculateTarget1();
    return Math.abs(candidate - previous) >= STATE_TARGET_EPSILON;
  }

  private calculateTarget1(): number {
    let first = -1;
    let second = -1;
    for (let midi = 0; midi <= MAX_NOTE; midi += 1) {
      if (this.activeNoteCounts[midi] === 0) continue;
      if (first < 0) first = midi;
      else if (second < 0) { second = midi; break; }
    }
    if (first < 0) return INACTIVE_TARGET;
    const target = this.activeNoteCount === 1
      ? this.scaleDegreeAbove(this.snapToScale(first), 2)
      : this.snapToScale(first);
    return this.shiftToNearestSource(target);
  }

  private pushStateChange(frame: number, reason: BrowserHrmAutoStateReason, note: number, noteOn: boolean): void {
    if (this.stateCount >= this.stateFrames.length) {
      this.stateOverflowCount += 1;
      return;
    }
    const index = this.stateTail;
    this.stateFrames[index] = frame;
    this.stateReasons[index] = reason;
    this.stateNotes[index] = note;
    this.stateNoteOns[index] = noteOn ? 1 : 0;
    this.stateActiveCounts[index] = this.activeNoteCount;
    this.stateVoiceCounts[index] = this.currentVoiceCount;
    this.stateTargets1[index] = this.currentTarget1;
    this.stateTargets2[index] = this.currentTarget2;
    this.stateTail += 1;
    if (this.stateTail >= this.stateFrames.length) this.stateTail = 0;
    this.stateCount += 1;
  }

  private snapToScale(note: number): number {
    const intervals = SCALE_INTERVALS[this.scaleValue]!;
    const baseOctave = Math.floor((note - this.keyValue) / 12);
    let best = note;
    let bestDistance = 127;
    for (let octave = baseOctave - 1; octave <= baseOctave + 1; octave += 1) {
      for (let i = 0; i < intervals.length; i += 1) {
        const candidate = this.keyValue + (12 * octave) + intervals[i]!;
        const distance = Math.abs(candidate - note);
        if (candidate >= 0 && candidate <= MAX_NOTE && distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
    }
    return best;
  }

  private scaleDegreeAbove(root: number, scaleDegrees: number): number {
    const intervals = SCALE_INTERVALS[this.scaleValue]!;
    const rootPc = ((root - this.keyValue) % 12 + 12) % 12;
    let rootDegree = 0;
    for (let i = 0; i < intervals.length; i += 1) {
      if (intervals[i] === rootPc) { rootDegree = i; break; }
    }
    const absoluteDegree = rootDegree + scaleDegrees;
    const octave = Math.floor(absoluteDegree / intervals.length);
    const degree = absoluteDegree - (octave * intervals.length);
    const rootOctave = Math.floor((root - this.keyValue) / 12);
    return this.keyValue + (rootOctave * 12) + (octave * 12) + intervals[degree]!;
  }

  private shiftToNearestSource(targetMidi: number): number {
    const source = this.pitchEstimateMidi;
    let nearest = targetMidi;
    let nearestDistance = Math.abs(targetMidi - source);
    for (let octave = -3; octave <= 3; octave += 1) {
      const candidate = targetMidi + (octave * 12);
      if (candidate < 0 || candidate > MAX_NOTE) continue;
      const distance = Math.abs(candidate - source);
      if (distance < nearestDistance || (distance === nearestDistance && candidate < nearest)) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    return Math.max(-24, Math.min(24, nearest - source));
  }

  private closeTarget(a: number, b: number): boolean {
    if (a === INACTIVE_TARGET || b === INACTIVE_TARGET) return a === b;
    return Math.abs(a - b) < STATE_TARGET_EPSILON;
  }

  private copyMidiEvent(from: number, to: number): void {
    this.midiFrames[to] = this.midiFrames[from]!;
    this.midiTypes[to] = this.midiTypes[from]!;
    this.midiChannels[to] = this.midiChannels[from]!;
    this.midiNotes[to] = this.midiNotes[from]!;
  }

  private capacity(value: number | undefined, fallback: number): number {
    return Number.isInteger(value) ? Math.max(1, Math.min(4096, value as number)) : fallback;
  }

  private clampKey(value: number): number { return Math.max(0, Math.min(11, Math.round(value))); }
  private clampScale(value: number): BrowserHrmAutoScale { return Math.max(0, Math.min(4, Math.round(value))) as BrowserHrmAutoScale; }
  private clampChannel(value: number): number { return Math.max(1, Math.min(16, Math.round(value))); }
  private clampMix(value: number): number { return Math.max(0, Math.min(100, value)); }
  private clampVoices(value: number): BrowserHrmAutoVoiceCount { return value < 1.5 ? 1 : 2; }
}
