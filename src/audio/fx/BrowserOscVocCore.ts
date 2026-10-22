import { SampleFrameScheduler } from '../dsp/SampleFrameScheduler';
import { BrowserVocoderCore } from './vocoder/BrowserVocoderCore';
import { BrowserOfficialVoiceOscillator, validateVoiceControls, voiceAttackSeconds, voiceReleaseSeconds, type OfficialVoiceWaveform } from './dsp/BrowserOfficialVoiceDsp';

export type BrowserOscVocWaveform = 0 | 1 | 2;

/**
 * Parameters for the clean-room OSC VOC (M) carrier/vocoder processor.
 * `midiChannel` is one-based (1..16), matching the effect descriptor. `mix`
 * intentionally belongs to the shared host wet/dry path, not this wet-only
 * processor.
 */
export interface BrowserOscVocParameters {
  /** 0: saw, 1: square, 2: 25%-duty pulse. */
  waveform?: number;
  /** One-based MIDI channel filter, 1..16. */
  midiChannel?: number;
  /** Transpose the MIDI note in semitones, -24..24. */
  octave?: number;
  /** Internal ERB vocoder band count, integer 8..24 (default 16). */
  bands?: number;
}

export interface BrowserOscVocOfficialParameters { carrier?: number; tone?: number; attack?: number; octave?: number; mod_sens?: number; release?: number }
const OFFICIAL_LIMITS = { carrier: [0, 4], tone: [-50, 50], attack: [0, 100], octave: [0, 3], mod_sens: [-50, 50], release: [0, 100] } as const;

const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;
const MAX_EVENT_COUNT = 256;
const MIN_BANDS = 8;
const MAX_BANDS = 24;
const ATTACK_SECONDS = 0.005;
const RELEASE_SECONDS = 0.035;
const MAX_INPUT_MAGNITUDE = 8;
const MAX_OUTPUT_MAGNITUDE = 4;
const EVENT_NOTE_ON = 1;
const EVENT_NOTE_OFF = 2;
const EVENT_ALL_NOTES_OFF = 3;
const EVENT_KIND_SHIFT = 14;
const EVENT_CHANNEL_SHIFT = 7;
const MIDI_NOTE_COUNT = 128;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cleanSample(value: number): number {
  return Number.isFinite(value) ? clamp(value, -MAX_INPUT_MAGNITUDE, MAX_INPUT_MAGNITUDE) : 0;
}

/** PolyBLEP residual around a discontinuity for a normalized phase step. */
function polyBlep(phase: number, step: number): number {
  if (step <= 0) return 0;
  if (phase < step) {
    const t = phase / step;
    return (2 * t) - (t * t) - 1;
  }
  if (phase > 1 - step) {
    const t = (phase - 1) / step;
    return (t * t) + (2 * t) + 1;
  }
  return 0;
}

/**
 * Clean-room monophonic MIDI oscillator feeding the shared 16-band-default
 * BrowserVocoderCore analysis/envelope/filterbank. MIDI events are explicitly
 * timestamped in absolute sample frames; this processor does not connect to an
 * external MIDI device and has no Roland sound-quality acceptance claim.
 *
 * Processing is wet-only: the shared FX host owns mix and bypass. Both output
 * channels carry the same centered mono vocoder result. The modulator analysis
 * itself is the exact `BrowserVocoderCore.processWithCarrier` path.
 */
export class BrowserOscVocCore {
  readonly sampleRate: number;
  readonly latencySamples = 0;
  readonly eventCapacity = MAX_EVENT_COUNT;

  private attackCoefficient: number;
  private releaseCoefficient: number;
  private vocoder: BrowserVocoderCore;
  private scheduler: SampleFrameScheduler;
  private currentWaveform: BrowserOscVocWaveform;
  private selectedChannel: number;
  private octaveSemitones: number;
  private activeBands: number;
  private readonly officialOscillator: BrowserOfficialVoiceOscillator;
  private officialEnabled = false;
  private officialCarrier = 0;
  private officialOctave = 2;
  private phase = 0;
  private phaseStep = 440 / 48000;
  private lastFrequencyHz = 440;
  private voiceTarget = 0;
  private voiceEnvelope = 0;
  private latestNote = -1;
  private noteSequence = 0;
  private currentLeft = 0;
  private currentRight = 0;
  private readonly heldVelocities = new Float64Array(MIDI_NOTE_COUNT);
  private readonly heldOrder = new Float64Array(MIDI_NOTE_COUNT);

  constructor(sampleRate = 48000, parameters: BrowserOscVocParameters = {}, initialFrame = 0) {
    if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
      throw new RangeError(`Browser OSC VOC sample rate must be from ${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE} Hz.`);
    }
    this.sampleRate = sampleRate;
    this.officialOscillator = new BrowserOfficialVoiceOscillator(sampleRate);
    this.attackCoefficient = Math.exp(-1 / (ATTACK_SECONDS * sampleRate));
    this.releaseCoefficient = Math.exp(-1 / (RELEASE_SECONDS * sampleRate));
    this.currentWaveform = 0;
    this.selectedChannel = 1;
    this.octaveSemitones = 0;
    this.activeBands = 16;
    BrowserOscVocCore.validateInitialFrame(initialFrame);
    this.scheduler = new SampleFrameScheduler(MAX_EVENT_COUNT, initialFrame);
    this.vocoder = new BrowserVocoderCore(sampleRate, { bands: 16, carrier: 0 });
    this.setParameters(parameters);
  }

  get outputLeft(): number { return this.currentLeft; }
  get outputRight(): number { return this.currentRight; }
  get currentFrame(): number { return this.scheduler.currentFrame; }
  get pendingEventCount(): number { return this.scheduler.queuedCount; }
  get activeNote(): number | null { return this.latestNote >= 0 ? this.latestNote : null; }
  get targetFrequencyHz(): number { return this.lastFrequencyHz; }
  get waveform(): BrowserOscVocWaveform { return this.currentWaveform; }
  get midiChannel(): number { return this.selectedChannel; }
  get octave(): number { return this.octaveSemitones; }
  get bands(): number { return this.activeBands; }

  /** Validate the whole update before applying any part of it. */
  setParameters(parameters: BrowserOscVocParameters): void {
    for (const key of Object.keys(parameters)) {
      if (key !== 'waveform' && key !== 'midiChannel' && key !== 'octave' && key !== 'bands') {
        throw new RangeError(`Browser OSC VOC does not support the ${key} parameter.`);
      }
    }

    const nextWaveform = parameters.waveform === undefined
      ? this.currentWaveform
      : BrowserOscVocCore.validateWaveform(parameters.waveform);
    const nextChannel = parameters.midiChannel === undefined
      ? this.selectedChannel
      : BrowserOscVocCore.validateChannel(parameters.midiChannel);
    const nextOctave = parameters.octave === undefined
      ? this.octaveSemitones
      : BrowserOscVocCore.validateOctave(parameters.octave);
    const nextBands = parameters.bands === undefined
      ? this.activeBands
      : BrowserOscVocCore.validateBands(parameters.bands);

    if (nextBands !== this.activeBands) {
      this.vocoder.setParameters({ bands: nextBands });
      this.activeBands = nextBands;
    }
    this.currentWaveform = nextWaveform;
    this.octaveSemitones = nextOctave;
    if (nextChannel !== this.selectedChannel) {
      this.selectedChannel = nextChannel;
      this.heldVelocities.fill(0);
      this.heldOrder.fill(0);
      this.latestNote = -1;
      this.voiceTarget = 0;
    }
    this.refreshPitch();
  }

  /** Additive official domain: OCTAVE ordinals 0/1/2/3 mean -2/-1/0/+1 octaves. */
  setOfficialParameters(parameters: BrowserOscVocOfficialParameters): void {
    validateVoiceControls(parameters, OFFICIAL_LIMITS, 'OSC VOC (M)');
    if (!Object.values(parameters).some(value => value !== undefined)) return;
    if (!this.officialEnabled) {
      this.vocoder.setVoiceShapingParameters({ tone: 0, attack: 50, mod_sens: 0, release: 50 });
      this.attackCoefficient = Math.exp(-1 / (voiceAttackSeconds(50) * this.sampleRate));
      this.releaseCoefficient = Math.exp(-1 / (voiceReleaseSeconds(50) * this.sampleRate));
      this.officialEnabled = true;
    }
    if (parameters.carrier !== undefined) this.officialCarrier = parameters.carrier;
    if (parameters.octave !== undefined) this.officialOctave = parameters.octave;
    this.octaveSemitones = (this.officialOctave - 2) * 12;
    this.officialOscillator.setWaveform(this.officialCarrier as OfficialVoiceWaveform);
    if (parameters.attack !== undefined) this.attackCoefficient = Math.exp(-1 / (voiceAttackSeconds(parameters.attack) * this.sampleRate));
    if (parameters.release !== undefined) this.releaseCoefficient = Math.exp(-1 / (voiceReleaseSeconds(parameters.release) * this.sampleRate));
    const shaping: { tone?: number; attack?: number; release?: number; mod_sens?: number } = {};
    if (parameters.tone !== undefined) shaping.tone = parameters.tone;
    if (parameters.attack !== undefined) shaping.attack = parameters.attack;
    if (parameters.release !== undefined) shaping.release = parameters.release;
    if (parameters.mod_sens !== undefined) shaping.mod_sens = parameters.mod_sens;
    this.vocoder.setVoiceShapingParameters(shaping);
    this.refreshPitch();
  }

  /** Queue a MIDI note-on at an absolute frame; velocity 0 means note-off. */
  noteOn(channel: number, note: number, velocity: number, frame: number): void {
    BrowserOscVocCore.validateEvent(channel, note, frame);
    if (!Number.isInteger(velocity) || velocity < 0 || velocity > 127) {
      throw new RangeError('Browser OSC VOC MIDI velocity must be an integer from 0 to 127.');
    }
    this.enqueue(frame, velocity === 0 ? EVENT_NOTE_OFF : EVENT_NOTE_ON, channel, note, velocity);
  }

  /** Queue a MIDI note-off at an absolute frame. */
  noteOff(channel: number, note: number, frame: number): void {
    BrowserOscVocCore.validateEvent(channel, note, frame);
    this.enqueue(frame, EVENT_NOTE_OFF, channel, note, 0);
  }

  /** Schedule a sample-aligned panic, discarding stale pending MIDI events. */
  allNotesOff(frame: number): void {
    if (!Number.isSafeInteger(frame) || frame < this.currentFrame) {
      throw new RangeError(`Browser OSC VOC all-notes-off frame must be a safe integer at or after ${this.currentFrame}.`);
    }
    const code = EVENT_ALL_NOTES_OFF << EVENT_KIND_SHIFT;
    if (!this.scheduler.replacePendingWith(frame, code, 0)) {
      throw new RangeError('Browser OSC VOC could not schedule all-notes-off while processing a block.');
    }
  }

  /** Process one sample frame. Omitted right input means mono input. */
  processSample(modulatorLeft: number, modulatorRight = modulatorLeft): void {
    if (!Number.isSafeInteger(this.currentFrame + 1)) {
      throw new RangeError('Browser OSC VOC sample-frame cursor would exceed the safe integer range.');
    }
    if (!this.scheduler.beginBlock(1)) throw new Error('Browser OSC VOC sample scheduler is already processing a block.');
    while (this.scheduler.nextEventOffset() === 0) this.applyDequeuedEvent();
    this.renderSample(modulatorLeft, modulatorRight);
    if (!this.scheduler.endBlock()) throw new Error('Browser OSC VOC sample scheduler did not finish its frame.');
  }

  /**
   * Align with an AudioWorklet global currentFrame before events are queued.
   * A pending event cannot be rebased because its timestamp is already exact.
   */
  synchronizeFrame(frame: number): void {
    BrowserOscVocCore.validateInitialFrame(frame);
    if (frame === this.currentFrame) return;
    if (this.scheduler.queuedCount > 0) {
      throw new RangeError('Browser OSC VOC cannot synchronize its frame while MIDI events are pending.');
    }
    this.scheduler = new SampleFrameScheduler(MAX_EVENT_COUNT, frame);
  }

  /**
   * Process any block length. `modulatorRight` may be omitted for mono input;
   * mono wet output is duplicated into the requested left/right buffers.
   */
  processBlock(
    modulatorLeft: ArrayLike<number>,
    modulatorRight: ArrayLike<number> | null | undefined,
    outputLeft: Float32Array,
    outputRight: Float32Array,
    frameCount = modulatorLeft.length,
  ): void {
    if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
      throw new RangeError('Browser OSC VOC frame count must be a non-negative safe integer.');
    }
    if (modulatorLeft.length < frameCount || (modulatorRight && modulatorRight.length < frameCount)) {
      throw new RangeError('Browser OSC VOC input buffers are shorter than the requested frame count.');
    }
    if (outputLeft.length < frameCount || outputRight.length < frameCount) {
      throw new RangeError('Browser OSC VOC output buffers are shorter than the requested frame count.');
    }
    if (!Number.isSafeInteger(this.currentFrame + frameCount)) {
      throw new RangeError('Browser OSC VOC sample-frame cursor would exceed the safe integer range.');
    }
    if (!this.scheduler.beginBlock(frameCount)) throw new Error('Browser OSC VOC sample scheduler is already processing a block.');

    let nextEventOffset = this.scheduler.nextEventOffset();
    for (let frame = 0; frame < frameCount; frame += 1) {
      while (nextEventOffset === frame) {
        this.applyDequeuedEvent();
        nextEventOffset = this.scheduler.nextEventOffset();
      }
      const right = modulatorRight ? modulatorRight[frame] ?? 0 : modulatorLeft[frame] ?? 0;
      this.renderSample(modulatorLeft[frame] ?? 0, right);
      outputLeft[frame] = this.currentLeft;
      outputRight[frame] = this.currentRight;
    }
    if (!this.scheduler.endBlock()) throw new Error('Browser OSC VOC left an unprocessed event in the current block.');
  }

  /** Reset voice, frame clock, event queue, oscillator and the shared vocoder. */
  reset(initialFrame = 0): void {
    BrowserOscVocCore.validateInitialFrame(initialFrame);
    this.scheduler = new SampleFrameScheduler(MAX_EVENT_COUNT, initialFrame);
    this.vocoder.reset();
    this.heldVelocities.fill(0);
    this.heldOrder.fill(0);
    this.phase = 0;
    this.officialOscillator.reset();
    this.phaseStep = 440 / this.sampleRate;
    this.lastFrequencyHz = 440;
    this.voiceTarget = 0;
    this.voiceEnvelope = 0;
    this.latestNote = -1;
    this.noteSequence = 0;
    this.currentLeft = 0;
    this.currentRight = 0;
  }

  private enqueue(frame: number, kind: number, channel: number, note: number, velocity: number): void {
    if (!Number.isSafeInteger(frame) || frame < this.currentFrame) {
      throw new RangeError(`Browser OSC VOC MIDI frame must be a safe integer at or after ${this.currentFrame}.`);
    }
    const code = (kind << EVENT_KIND_SHIFT) | (channel << EVENT_CHANNEL_SHIFT) | note;
    if (!this.scheduler.scheduleAtFrame(frame, code, velocity)) {
      throw new RangeError(this.scheduler.queuedCount >= MAX_EVENT_COUNT
        ? `Browser OSC VOC MIDI event queue is full (${MAX_EVENT_COUNT}).`
        : 'Browser OSC VOC could not schedule the MIDI event.');
    }
  }

  private applyDequeuedEvent(): void {
    if (!this.scheduler.dequeueNextEvent()) return;
    const code = this.scheduler.eventCode;
    const kind = code >> EVENT_KIND_SHIFT;
    const channel = (code >> EVENT_CHANNEL_SHIFT) & 0x7f;
    const note = code & 0x7f;
    if (kind === EVENT_ALL_NOTES_OFF) {
      this.heldVelocities.fill(0);
      this.heldOrder.fill(0);
      this.latestNote = -1;
      this.voiceTarget = 0;
      return;
    }
    if (channel !== this.selectedChannel) return;

    if (kind === EVENT_NOTE_ON && this.scheduler.eventValue > 0) {
      this.heldVelocities[note] = this.scheduler.eventValue / 127;
      this.noteSequence += 1;
      this.heldOrder[note] = this.noteSequence;
    } else if (kind === EVENT_NOTE_OFF) {
      this.heldVelocities[note] = 0;
      this.heldOrder[note] = 0;
    }
    this.selectMostRecentHeldNote();
  }

  private selectMostRecentHeldNote(): void {
    let selected = -1;
    let selectedOrder = 0;
    for (let note = 0; note < MIDI_NOTE_COUNT; note += 1) {
      const order = this.heldOrder[note] ?? 0;
      if (order > selectedOrder) {
        selected = note;
        selectedOrder = order;
      }
    }
    this.latestNote = selected;
    this.voiceTarget = selected >= 0 ? this.heldVelocities[selected] ?? 0 : 0;
    if (selected >= 0) this.refreshPitch();
  }

  private refreshPitch(): void {
    if (this.latestNote < 0) return;
    const frequency = 440 * (2 ** ((this.latestNote - 69 + this.octaveSemitones) / 12));
    const boundedFrequency = clamp(frequency, 0, this.sampleRate * 0.45);
    this.lastFrequencyHz = Number.isFinite(boundedFrequency) ? boundedFrequency : 0;
    this.phaseStep = this.lastFrequencyHz / this.sampleRate;
    this.officialOscillator.setFrequency(this.lastFrequencyHz);
  }

  private renderSample(modulatorLeft: number, modulatorRight: number): void {
    const modulator = (cleanSample(modulatorLeft) + cleanSample(modulatorRight)) * 0.5;
    const coefficient = this.voiceTarget > this.voiceEnvelope
      ? this.attackCoefficient
      : this.releaseCoefficient;
    this.voiceEnvelope = clamp(
      (coefficient * this.voiceEnvelope) + ((1 - coefficient) * this.voiceTarget),
      0,
      1,
    );

    let carrier = (this.officialEnabled ? this.officialOscillator.processSample() : this.nextCarrierSample()) * this.voiceEnvelope;
    if (!Number.isFinite(carrier)) carrier = 0;
    const output = this.vocoder.processWithCarrier(modulator, carrier);
    const safeOutput = Number.isFinite(output) ? clamp(output, -MAX_OUTPUT_MAGNITUDE, MAX_OUTPUT_MAGNITUDE) : 0;
    this.currentLeft = safeOutput;
    this.currentRight = safeOutput;
  }

  private nextCarrierSample(): number {
    const phase = this.phase;
    const step = Math.min(this.phaseStep, 0.45);
    let sample: number;
    if (this.currentWaveform === 0) {
      sample = (2 * phase) - 1 - polyBlep(phase, step);
    } else {
      const duty = this.currentWaveform === 1 ? 0.5 : 0.25;
      const fallingEdgePhase = phase >= duty ? phase - duty : phase + 1 - duty;
      sample = (phase < duty ? 1 : -1)
        + polyBlep(phase, step)
        - polyBlep(fallingEdgePhase, step);
    }
    this.phase += step;
    if (this.phase >= 1) this.phase -= 1;
    return Number.isFinite(sample) ? sample : 0;
  }

  private static validateWaveform(value: number): BrowserOscVocWaveform {
    if (!Number.isInteger(value) || value < 0 || value > 2) {
      throw new RangeError('Browser OSC VOC waveform must be 0 (saw), 1 (square), or 2 (pulse).');
    }
    return value as BrowserOscVocWaveform;
  }

  private static validateChannel(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 16) {
      throw new RangeError('Browser OSC VOC MIDI channel must be an integer from 1 to 16.');
    }
    return value;
  }

  private static validateOctave(value: number): number {
    if (!Number.isFinite(value) || value < -24 || value > 24) {
      throw new RangeError('Browser OSC VOC octave transpose must be between -24 and 24 semitones.');
    }
    return value;
  }

  private static validateBands(value: number): number {
    if (!Number.isInteger(value) || value < MIN_BANDS || value > MAX_BANDS) {
      throw new RangeError(`Browser OSC VOC bands must be an integer from ${MIN_BANDS} to ${MAX_BANDS}.`);
    }
    return value;
  }

  private static validateEvent(channel: number, note: number, frame: number): void {
    if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
      throw new RangeError('Browser OSC VOC MIDI event channel must be an integer from 1 to 16.');
    }
    if (!Number.isInteger(note) || note < 0 || note > 127) {
      throw new RangeError('Browser OSC VOC MIDI note must be an integer from 0 to 127.');
    }
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new RangeError('Browser OSC VOC MIDI frame must be a non-negative safe integer.');
    }
  }

  private static validateInitialFrame(frame: number): void {
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new RangeError('Browser OSC VOC sample frame must be a non-negative safe integer.');
    }
  }
}
