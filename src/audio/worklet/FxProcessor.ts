import {
  BROWSER_FX_ALGORITHM_INFO,
  BrowserFxDspCore,
  type BrowserFxAlgorithm,
  type BrowserFxParameters,
} from '../fx/dsp/BrowserFxDspCore';

interface FxWorkletMessageEvent {
  data: unknown;
}

interface FxWorkletPort {
  onmessage: ((event: FxWorkletMessageEvent) => void) | null;
  postMessage?: (message: unknown) => void;
}

interface FxProcessorLike {
  readonly port: FxWorkletPort;
}

type FxProcessorBaseConstructor = new () => FxProcessorLike;

class FallbackFxProcessor implements FxProcessorLike {
  readonly port: FxWorkletPort = { onmessage: null };
}

const fxWorkletGlobals = globalThis as unknown as {
  AudioWorkletProcessor?: FxProcessorBaseConstructor;
  registerProcessor?: (name: string, processor: FxProcessorBaseConstructor) => void;
  sampleRate?: number;
  currentFrame?: number;
};

const FxProcessorBase = fxWorkletGlobals.AudioWorkletProcessor ?? FallbackFxProcessor;

export interface FxProcessorOptions {
  processorOptions?: {
    algorithm?: BrowserFxAlgorithm;
    sampleRate?: number;
    parameters?: BrowserFxParameters;
    /** Worklet defaults to bypassed so adding the node cannot change audio. */
    bypassed?: boolean;
  };
}

export type FxProcessorMessage =
  | { type: 'configure'; parameters: BrowserFxParameters }
  | { type: 'set-bypass'; value: boolean; rampFrames?: number }
  | { type: 'midi-note-on'; channel: number; note: number; velocity: number; frame: number }
  | { type: 'midi-note-off'; channel: number; note: number; frame: number }
  | { type: 'reset' };

function isAlgorithm(value: unknown): value is BrowserFxAlgorithm {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BROWSER_FX_ALGORITHM_INFO, value);
}

/**
 * Standalone AudioWorklet processor for one selected clean-room FX algorithm.
 * It handles actual input/output channel-array lengths (no fixed 128-frame
 * assumption), performs no render-callback allocation, and defaults to true
 * bit-exact bypass until the host explicitly activates it.
 *
 * WorkletPort messages:
 *   { type: 'configure', parameters: { cutoffHz?, q?, mix?, decaySeconds?, dampingHz?, gateThresholdDb?, gateHoldMs?, gateReleaseMs?, ringModHz?, ringModDepth?, driveDb?, outputDb?, distortionMode?, flangerDelayMs?, flangerRateHz?, flangerDepth?, flangerFeedback?, thresholdDb?, ratio?, attackMs?, releaseMs?, dynamicsDetector?, delayTimeMs?, delayFeedback?, delayToneHz?, panningDelayTimeMs?, panningDelayFeedback?, panningDelayPan?, chorusDelayMs?, chorusRateHz?, chorusDepthMs?, chorusVoices?, chorusFeedback?, chorusToneHz?, phaserRateHz?, phaserDepth?, phaserFeedback?, phaserStages?, tremoloRateHz?, tremoloDepth?, tremoloWaveform?, autoPanRateHz?, autoPanDepth?, autoPanWaveform?, stereoWidth?, stereoLowMonoCutoffHz?, stereoDecorrelation?, granularGrainSizeMs?, granularDensityHz?, granularPitchSemitones?, granularPositionJitterPercent?, granularFeedbackPercent?, radioBand?, radioDrive?, radioNoise?, vibratoRateHz?, vibratoDepthPercent?, vibratoDelayMs?, slowGearAttackMs?, slowGearSensitivityPercent?, isolatorLowGainDb?, isolatorMidGainDb?, isolatorHighGainDb?, isolatorGateRateBeats?, isolatorGateDepthPercent?, beatScatterSliceBeats?, beatScatterScatterPercent?, beatScatterPitchSemitones?, beatScatterRepeats?, beatShiftOffsetBeats?, beatShiftCrossfadeMs?, reverseReverbSegmentBeats?, reverseReverbFeedbackPercent?, reverseReverbCrossfadeMs?, reverseReverbDecaySeconds?, reverseReverbDampingCutoffHz?, patternSlicerPattern?, patternSlicerRateBeats?, patternSlicerDepthPercent?, patternSlicerEdgeMs?, stepSlicerStepCount?, stepSlicerRateBeats?, stepSlicerDepthPercent?, stepSlicerPanDepthPercent?, stepSlicerFilterHz?, stepSlicerStep01? ... stepSlicerStep16?, preampModel?, preampGainPercent?, preampBassDb?, preampMiddleDb?, preampTrebleDb?, preampLevelDb?, bpm? } }
 *   SYNTH additionally accepts synthSensitivity, synthWaveform, synthOctave,
 *   synthToneHz, and synthMixPercent.
 *   G2B additionally accepts g2bTrackingPercent, g2bBlendPercent, and g2bBodyHz.
 *   ROBOT accepts robotPitch (-24..24), emits `robot-pitch-target` and bounded
 *   `robot-mode` state, and renders its fixed-latency PSOLA-lite voiced path.
 *   HRM AUTO (M) accepts hrmAutoKey (0..11), hrmAutoScale (0..4),
 *   hrmAutoMidiChannel (1..16), and hrmAutoMixPercent (0..100).
 *   VOCODER additionally accepts vocoderBands (integer 8..24), vocoderCarrier
 *   (0=input, 1=polyBLEP saw, 2=polyBLEP square), and shared mix (0..1).
 *   VOCODER formant shifting is unsupported and rejected by the DSP core.
 *   { type: 'set-bypass', value: boolean, rampFrames?: number }
 *   { type: 'reset' }
 *
 * The processor applies the selected algorithm to channels 0/1. Any additional
 * channels are copied through unchanged because this clean-room core is
 * explicitly stereo; this is not an additional surround-FX implementation.
 * BEAT REPEAT, BEAT SCATTER, and BEAT SHIFT are accepted by the same processor only for
 * host-created Track FX slots; the Browser engine rejects them on Input FX.
 */
export class FxProcessor extends FxProcessorBase {
  readonly core: BrowserFxDspCore;
  private lastRobotModeRevision = -1;

  constructor(options: FxProcessorOptions = {}) {
    super();
    const supplied = options.processorOptions;
    const suppliedAlgorithm: unknown = supplied?.algorithm;
    if (!isAlgorithm(suppliedAlgorithm)) {
      const algorithmDescription = suppliedAlgorithm === undefined ? 'missing' : String(suppliedAlgorithm);
      throw new TypeError(`Unsupported Browser FX algorithm: ${algorithmDescription}`);
    }
    const algorithm = suppliedAlgorithm;
    const rate = Number.isFinite(supplied?.sampleRate)
      ? (supplied?.sampleRate as number)
      : (Number.isFinite(fxWorkletGlobals.sampleRate) ? (fxWorkletGlobals.sampleRate as number) : 48000);
    this.core = new BrowserFxDspCore(algorithm, rate, supplied?.parameters, fxWorkletGlobals.currentFrame ?? 0);
    this.core.setBypass(supplied?.bypassed !== false, 0);
    this.port.onmessage = (event: FxWorkletMessageEvent): void => {
      const message = event.data as Partial<FxProcessorMessage> | null;
      if (message?.type === 'configure') {
        const configureMessage = message as Extract<FxProcessorMessage, { type: 'configure' }>;
        if (configureMessage.parameters && typeof configureMessage.parameters === 'object') {
          try {
            this.core.setParameters(configureMessage.parameters);
            this.port.postMessage?.({
              type: 'configure-ack',
              parameterKeys: Object.keys(configureMessage.parameters),
            });
          } catch (error) {
            this.port.postMessage?.({
              type: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } else if (message?.type === 'set-bypass' && typeof message.value === 'boolean') {
        const bypassMessage = message as Extract<FxProcessorMessage, { type: 'set-bypass' }>;
        const rampFrames = Number.isFinite(bypassMessage.rampFrames)
          ? Math.max(0, Math.floor(bypassMessage.rampFrames as number))
          : 128;
        this.core.setBypass(bypassMessage.value, rampFrames);
      } else if (message?.type === 'midi-note-on') {
        const noteMessage = message as Extract<FxProcessorMessage, { type: 'midi-note-on' }>;
        try {
          this.core.scheduleMidiNoteOn(noteMessage.channel, noteMessage.note, noteMessage.velocity, noteMessage.frame);
          this.port.postMessage?.({ type: 'midi-event-queued', frame: noteMessage.frame });
        } catch (error) {
          this.port.postMessage?.({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      } else if (message?.type === 'midi-note-off') {
        const noteMessage = message as Extract<FxProcessorMessage, { type: 'midi-note-off' }>;
        try {
          this.core.scheduleMidiNoteOff(noteMessage.channel, noteMessage.note, noteMessage.frame);
          this.port.postMessage?.({ type: 'midi-event-queued', frame: noteMessage.frame });
        } catch (error) {
          this.port.postMessage?.({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      } else if (message?.type === 'reset') {
        this.core.reset();
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const inputChannels = inputs[0];
    const outputChannels = outputs[0];
    if (!outputChannels) return true;

    const leftOutput = outputChannels[0] ?? null;
    const rightOutput = outputChannels[1] ?? null;
    const leftInput = inputChannels?.[0] ?? null;
    // Web Audio commonly up-mixes mono input to a stereo output. Duplicate it
    // only for that case; disconnected input remains silence (and lets reverb
    // tails decay naturally).
    const rightInput = this.core.algorithm === 'auto-pan'
      ? (inputChannels?.[1] ?? null)
      : (inputChannels?.[1] ?? (leftInput && rightOutput ? leftInput : null));
    const frames = Math.max(leftOutput?.length ?? 0, rightOutput?.length ?? 0);

    if (Number.isSafeInteger(fxWorkletGlobals.currentFrame)) {
      try {
        this.core.synchronizeFrame(fxWorkletGlobals.currentFrame as number);
      } catch (error) {
        this.port.postMessage?.({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }

    if (leftOutput || rightOutput) {
      const inputIsMono = !inputChannels || inputChannels.length < 2;
      this.core.processBlock(leftInput, rightInput, leftOutput, rightOutput, frames, inputIsMono);
    }

    // AUTO RIFF's analyzer queue is fixed-capacity. Drain it after processing
    // the actual callback frames so control messages never allocate in the
    // analyzer and every event retains its absolute audio-sample timestamp.
    while (this.core.tryPopAutoRiffPitchChange()) {
      this.port.postMessage?.({
        type: 'auto-riff-pitch',
        frame: this.core.lastAutoRiffPitchFrame,
        semitones: this.core.lastAutoRiffPitchSemitones,
      });
    }

    // HRM AUTO's fixed state queue carries absolute-frame target changes from
    // MIDI events and source-pitch acquisition/loss. The host applies the
    // target to pinned Signalsmith LIVE_FX nodes at that sample time plus the
    // nodes' measured algorithmic latency.
    while (this.core.tryPopHrmAutoStateChange()) {
      this.port.postMessage?.({
        type: 'hrm-auto-target',
        frame: this.core.lastHrmAutoStateFrame,
        reason: this.core.lastHrmAutoStateReason,
        note: this.core.lastHrmAutoStateNote,
        noteOn: this.core.lastHrmAutoStateNoteOn,
        activeNoteCount: this.core.lastHrmAutoActiveNoteCount,
        voiceCount: this.core.lastHrmAutoVoiceCount,
        target1: this.core.lastHrmAutoTarget1,
        target2: this.core.lastHrmAutoTarget2,
      });
    }

    // ROBOT emits bounded frame-stamped target state for the host Signalsmith
    // branch and renders the selected PSOLA-lite samples in this worklet.
    while (this.core.tryPopRobotTargetChange()) {
      this.port.postMessage?.({
        type: 'robot-pitch-target',
        frame: this.core.lastRobotTargetFrame,
        semitones: this.core.lastRobotTargetSemitones,
        sourceMidi: this.core.lastRobotTargetSourceMidi,
        targetMidi: this.core.lastRobotTargetMidi,
        sourceHz: this.core.lastRobotTargetHz,
        confidence: this.core.lastRobotTargetConfidence,
        voiced: this.core.lastRobotTargetVoiced,
      });
    }

    if (this.core.algorithm === 'robot' && this.core.robotModeRevision !== this.lastRobotModeRevision) {
      this.lastRobotModeRevision = this.core.robotModeRevision;
      this.port.postMessage?.({
        type: 'robot-mode',
        frame: this.core.lastRobotModeFrame,
        mode: this.core.lastRobotProcessingMode,
        reason: this.core.lastRobotModeReason,
        trackerLatencyFrames: this.core.robotTrackerAcquisitionFrames,
        psolaLatencySamples: this.core.robotPsolaLatencySamples,
      });
    }

    for (let channel = 2; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel];
      if (!output) continue;
      const input = inputChannels?.[channel];
      const inputLength = input?.length ?? 0;
      for (let frame = 0; frame < output.length; frame += 1) {
        output[frame] = input && frame < inputLength ? (input[frame] ?? 0) : 0;
      }
    }
    return true;
  }
}

if (typeof fxWorkletGlobals.registerProcessor === 'function') {
  fxWorkletGlobals.registerProcessor('rc505-fx-processor', FxProcessor as FxProcessorBaseConstructor);
}
