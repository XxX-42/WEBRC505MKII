import type { IAudioEngine } from './AudioEngineInterface';
import {
    getBrowserRecordingOffsetConfig,
} from './browserRecordingOffset';
import { FXChain } from './FXChain';
import { createLiveMonoPitchNode, createLivePolyPitchNode, type LiveMonoPitchNode, type LivePolyPitchNode } from './pitch';
import { createHqWavExport, type HqWavExportRequestOptions, type HqWavExportResult } from './export/hqWavExport';
import { Track, TrackState, TransportState } from '../core/types';
import { Transport } from '../core/Transport';

const RECORDING_CHUNK_SIZE = 16_384;
const RECORDING_CHUNK_POOL_SIZE = 3;
const OVERDUB_TRANSFER_BUFFER_FRAMES = 16_384;
const OVERDUB_TRANSFER_BUFFER_POOL_SIZE = 3;
// Bound retained capture PCM to 384 MiB across all channels. Mono retains the
// previous 30+ minute ceiling; stereo uses the same byte budget with half as many frames.
const MAX_RECORDING_CAPTURE_BYTES = 384 * 1024 * 1024;
const MAX_RECORDING_CAPTURE_SAMPLES = MAX_RECORDING_CAPTURE_BYTES / Float32Array.BYTES_PER_ELEMENT;
const MAX_RECORDING_CHANNELS = 2;
const MAX_RECORDING_CHUNKS = MAX_RECORDING_CAPTURE_SAMPLES / RECORDING_CHUNK_SIZE;

export type LoopTransportFxName = 'BEAT SHIFT' | 'VINYL FLICK';

export interface LoopTransportFxConfiguration {
    /** Global Browser FX slot identity; the reader itself is per TrackAudio. */
    slotIndex: number;
    type: LoopTransportFxName | null;
    /** Uses BrowserWorkletFX's existing canonical parameter names. */
    parameters?: Readonly<Record<string, number>>;
}

interface LoopTransportFxSlot {
    type: LoopTransportFxName;
    beatShiftOffsetBeats: number;
    beatShiftCrossfadeMs: number;
    bpm: number | null;
    vinylFlickSpeed: number;
    vinylFlickMix: number;
    vinylFlickReturnTimeSeconds: number;
    vinylFlickBrakePercent: number;
}

interface LoopMotorState {
    rate: number;
    velocity: number;
    targetRate: number;
    returnTimeSeconds: number;
    brakePercent: number;
}

interface LoopMotorPoint {
    rate: number;
    velocity: number;
}

const LOOP_SHIFT_MIN_CROSSFADE_MS = 1;
const LOOP_SHIFT_MAX_CROSSFADE_MS = 10;
const LOOP_MOTOR_MIN_RETURN_SECONDS = 0.05;
const LOOP_MOTOR_MAX_RETURN_SECONDS = 10;
const LOOP_MOTOR_CURVE_SAMPLES = 65;
const LOOP_MOTOR_MAX_AUTOMATION_SECONDS = LOOP_MOTOR_MAX_RETURN_SECONDS * 4;
const LOOP_MOTOR_INTEGRATION_STEPS = 32;
const DEFAULT_LOOP_MOTOR_RETURN_SECONDS = 1.5;
const DEFAULT_LOOP_MOTOR_BRAKE_PERCENT = 35;

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
    return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function wrapLoopPhase(phaseSeconds: number, durationSeconds: number): number {
    if (!Number.isFinite(phaseSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
    return ((phaseSeconds % durationSeconds) + durationSeconds) % durationSeconds;
}

function loopMotorTargetRate(speed: number, mix: number): number {
    // Source-aware Vinyl Flick is an experimental varispeed read head. The
    // existing mix macro scales the distance from unity without duplicating
    // or copying the loop buffer for a second wet/dry stream.
    return Math.max(0, Math.min(2, 1 + ((speed / 100) * mix)));
}

/** Exact closed-form position, velocity, and rate integral for one second-order motor interval. */
function evaluateLoopMotor(state: LoopMotorState, seconds: number): { point: LoopMotorPoint; integral: number } {
    const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    if (t === 0) return { point: { rate: state.rate, velocity: state.velocity }, integral: 0 };

    const returnTime = clampFinite(state.returnTimeSeconds, LOOP_MOTOR_MIN_RETURN_SECONDS, LOOP_MOTOR_MAX_RETURN_SECONDS, DEFAULT_LOOP_MOTOR_RETURN_SECONDS);
    const omega = Math.min(80, 4 / returnTime);
    const zeta = 0.55 + (1.65 * (clampFinite(state.brakePercent, 0, 100, DEFAULT_LOOP_MOTOR_BRAKE_PERCENT) / 100));
    const displacement = state.rate - state.targetRate;
    let rateOffset: number;
    let velocity: number;
    let integralOffset: number;

    if (Math.abs(zeta - 1) < 1e-5) {
        const coefficient = state.velocity + (omega * displacement);
        const decay = Math.exp(-omega * t);
        rateOffset = (displacement + (coefficient * t)) * decay;
        velocity = (coefficient - (omega * (displacement + (coefficient * t)))) * decay;
        integralOffset = (displacement * (1 - decay) / omega)
            + (coefficient * (1 - (decay * (1 + (omega * t)))) / (omega * omega));
    } else if (zeta < 1) {
        const alpha = zeta * omega;
        const dampedFrequency = omega * Math.sqrt(1 - (zeta * zeta));
        const sineCoefficient = (state.velocity + (alpha * displacement)) / dampedFrequency;
        const decay = Math.exp(-alpha * t);
        const cosine = Math.cos(dampedFrequency * t);
        const sine = Math.sin(dampedFrequency * t);
        rateOffset = decay * ((displacement * cosine) + (sineCoefficient * sine));
        velocity = decay
            * (((-alpha * displacement) + (dampedFrequency * sineCoefficient)) * cosine
                + ((-alpha * sineCoefficient) - (dampedFrequency * displacement)) * sine);
        const denominator = alpha * alpha + dampedFrequency * dampedFrequency;
        const cosineIntegral = (alpha + (decay * ((-alpha * cosine) + (dampedFrequency * sine)))) / denominator;
        const sineIntegral = (dampedFrequency + (decay * ((-alpha * sine) - (dampedFrequency * cosine)))) / denominator;
        integralOffset = (displacement * cosineIntegral) + (sineCoefficient * sineIntegral);
    } else {
        const root = Math.sqrt((zeta * zeta) - 1);
        const firstRoot = -omega * (zeta - root);
        const secondRoot = -omega * (zeta + root);
        const firstCoefficient = (state.velocity - (secondRoot * displacement)) / (firstRoot - secondRoot);
        const secondCoefficient = displacement - firstCoefficient;
        const firstDecay = Math.exp(firstRoot * t);
        const secondDecay = Math.exp(secondRoot * t);
        rateOffset = (firstCoefficient * firstDecay) + (secondCoefficient * secondDecay);
        velocity = (firstCoefficient * firstRoot * firstDecay) + (secondCoefficient * secondRoot * secondDecay);
        integralOffset = (firstCoefficient * (firstDecay - 1) / firstRoot)
            + (secondCoefficient * (secondDecay - 1) / secondRoot);
    }

    const unboundedRate = state.targetRate + rateOffset;
    const rate = clampFinite(unboundedRate, 0, 2, state.targetRate);
    if ((unboundedRate <= 0 && velocity < 0) || (unboundedRate >= 2 && velocity > 0)) velocity = 0;
    if (!Number.isFinite(velocity)) velocity = 0;
    const integral = (state.targetRate * t) + integralOffset;
    return {
        point: { rate, velocity },
        integral: Number.isFinite(integral) ? integral : state.targetRate * t,
    };
}

type RecordingWorkletMessage =
    | {
        type: 'RECORD_CHUNK';
        chunkIndex: number;
        sequence: number;
        validFrames: number;
        channelCount: 1 | 2;
        samples: Float32Array;
    }
    | {
        type: 'RECORD_COMPLETE';
        framesCaptured: number;
        droppedFrames: number;
        overflowEvents: number;
        maxRecordingFrames: number;
        channelCount: 1 | 2;
        limitReached: boolean;
        chunksSent: number;
    };

export class TrackAudio {
    public track: Track;
    public state: TrackState = TrackState.EMPTY;

    private engine: IAudioEngine;
    private transport: Transport;
    private audioBuffer: AudioBuffer | null = null;
    private sourceNode: AudioBufferSourceNode | null = null;
    private sourceGainNode: GainNode | null = null;
    private retiringSourceNode: AudioBufferSourceNode | null = null;
    private retiringSourceGainNode: GainNode | null = null;
    private readonly loopTransportFxSlots: (LoopTransportFxSlot | null)[] = [null, null, null, null];
    private readonly loopMotorStates: LoopMotorState[] = Array.from({ length: 4 }, () => ({
        rate: 1,
        velocity: 0,
        targetRate: 1,
        returnTimeSeconds: DEFAULT_LOOP_MOTOR_RETURN_SECONDS,
        brakePercent: DEFAULT_LOOP_MOTOR_BRAKE_PERCENT,
    }));
    private loopTransportPlaybackInitialized = false;
    private loopTransportPhaseBaseSeconds = 0;
    private loopTransportPhaseTime = 0;
    private loopTransportRenderedBeatShiftSeconds = 0;
    /** Shift already folded into the saved offset at the last reader stop/route switch. */
    private loopTransportStartOffsetShiftSeconds = 0;
    private loopTransportTransitionActive = false;
    private loopTransportPendingRetarget = false;
    private loopTransportRuntimeFallbackReason: string | null = null;
    private livePolyPitchNode: LivePolyPitchNode | null = null;
    private livePolyPitchNodePromise: Promise<LivePolyPitchNode> | null = null;
    private livePolyPitchBufferReset: Promise<unknown> = Promise.resolve();
    private livePolyPitchGeneration = 0;
    private livePolyPitchEnabledInternal = false;
    private livePolyPitchActiveInternal = false;
    private livePolyPitchSemitones = 0;
    private livePolyPitchPlaybackRate = 1;
    private livePolyPitchTonalityLimitHz = 8000;
    private livePolyPitchLatencySamplesValue: number | null = null;
    private livePolyPitchFallbackReasonValue: string | null = null;
    private liveMonoPitchNode: LiveMonoPitchNode | null = null;
    private liveMonoPitchNodePromise: Promise<LiveMonoPitchNode> | null = null;
    private liveMonoPitchGeneration = 0;
    private liveMonoPitchEnabledInternal = false;
    private liveMonoPitchActiveInternal = false;
    private liveMonoPitchSemitones = 0;
    private liveMonoPitchMinimumFrequencyHz = 70;
    private liveMonoPitchMaximumFrequencyHz = 1_200;
    private liveMonoPitchLatencySamplesValue: number | null = null;
    private liveMonoPitchFallbackReasonValue: string | null = null;
    private playbackRevision = 0;
    private gainNode: GainNode;
    private panNode: StereoPannerNode;
    public fxChain: FXChain;

    // Recording state
    private isRecording: boolean = false;
    private isFinalizingRecording = false;
    public isReverse: boolean = false;


    private workletNode: AudioWorkletNode | null = null;
    private readonly recordedChunks: Array<Float32Array | null> = new Array(MAX_RECORDING_CHUNKS).fill(null);
    private readonly recordedChunkLengths = new Uint32Array(MAX_RECORDING_CHUNKS);
    private readonly receivedChunkFlags = new Uint8Array(MAX_RECORDING_CHUNKS);
    private recordingChunkCount = 0;
    private recordingReceivedChunkMessages = 0;
    private recordingStoredFrames = 0;
    private recordingChannelCount: 1 | 2 = 1;
    private pendingRecordingComplete: Extract<RecordingWorkletMessage, { type: 'RECORD_COMPLETE' }> | null = null;
    private readonly recycleChunkMessage = {
        type: 'RECYCLE_CHUNK' as const,
        chunkIndex: 0,
        samples: null as Float32Array | null,
    };
    private readonly recycleChunkTransferList: Transferable[] = [new ArrayBuffer(0)];
    public recordingFramesCaptured = 0;
    public recordingDroppedFrames = 0;
    public recordingOverflowEvents = 0;
    public recordingMaximumFrames = 0;
    public recordingMaximumDurationSeconds = 0;
    public recordingLimitReached = false;
    public recordingDiagnostic: string | null = null;
    private overdubProcessor: AudioWorkletNode | null = null;
    private overdubMuteGainNode: GainNode | null = null;
    private overdubStartGeneration = 0;
    private overdubStopping = false;
    private overdubRestartAfterStop = false;
    private overdubSessionAudioBuffer: AudioBuffer | null = null;
    private overdubNextPatchSequence = 0;
    /** Readable diagnostic for AudioWorklet-unavailable and bounded-pool overflow cases. */
    public overdubDiagnostic: string | null = null;
    private startTime: number = 0;
    private startOffset: number = 0;
    private resumeAfterRecording = true;

    // Quantize state
    private waitingForQuantize = false;
    private waitingForQuantizeStop = false;
    private quantizeStartListener: (() => void) | null = null;
    private quantizeStopListener: (() => void) | null = null;

    // Shared State
    private trackIndex: number;
    private sharedStates: Int32Array | null;
    private sharedPositions: Float32Array | null;

    constructor(engine: IAudioEngine, track: Track, index: number, sharedStates: Int32Array | null, sharedPositions: Float32Array | null) {
        this.track = track;
        this.trackIndex = index;
        this.sharedStates = sharedStates;
        this.sharedPositions = sharedPositions;

        this.engine = engine;
        this.transport = Transport.getInstance();
        const ctx = this.engine.context;

        this.gainNode = ctx.createGain();
        this.panNode = ctx.createStereoPanner();
        this.fxChain = new FXChain(ctx);

        // Routing: Source (Buffer/Worklet) -> Gain -> FXChain -> Pan -> Destination
        // Wait, usually Gain (Volume) is post FX? Or pre?
        // Let's do: Source -> FXChain -> Gain -> Pan -> Destination
        // But wait, I want to control volume of the effected signal.
        // So: Source -> FXChain -> Gain -> Pan

        // Re-wiring
        this.fxChain.output.connect(this.gainNode);
        this.gainNode.connect(this.panNode);
        this.panNode.connect(this.engine.trackMixNode);

        this.updateSettings();

        // Start position updater
        this.startPositionUpdater();
    }

    public get isAvailable(): boolean {
        return true;
    }

    /** Install a private serial bank after the existing strip FX and before level/pan/TrackMix. */
    public installTrackFxInsert(input: AudioNode, output: AudioNode): void {
        this.fxChain.output.disconnect(this.gainNode);
        this.fxChain.output.connect(input);
        output.connect(this.gainNode);
    }

    public get disabledReason(): string {
        return '';
    }

    /** True while a source-aware loop read-head is driving this TrackAudio's normal BufferSource route. */
    public get loopTransportActive(): boolean {
        return this.loopTransportPlaybackInitialized && this.sourceNode !== null;
    }

    /** Experimental pre-mix read-head status; does not imply full Track A–D serial-order support. */
    public get loopTransportUnavailableReason(): string | null {
        return this.getLoopTransportConflictReason() ?? this.loopTransportRuntimeFallbackReason;
    }

    private getLoopTransportConflictReason(): string | null {
        if (!this.hasConfiguredLoopTransportFx()) return null;
        if (this.isReverse) return 'BEAT SHIFT and VINYL FLICK loop read-heads currently require forward BufferSource playback';
        if (this.liveMonoPitchEnabledInternal || this.liveMonoPitchActiveInternal) {
            return 'BEAT SHIFT and VINYL FLICK loop read-heads are unavailable while LIVE_MONO playback is enabled';
        }
        if (this.livePolyPitchEnabledInternal || this.livePolyPitchActiveInternal) {
            return 'BEAT SHIFT and VINYL FLICK loop read-heads are unavailable while LIVE_POLY playback is enabled';
        }
        return null;
    }

    /**
     * Installs an experimental source-aware read head before the shared
     * postmix bus. The caller applies each global A–D slot snapshot to all
     * TrackAudio loops; only scalar controls and phase live here, and the
     * AudioBuffer is shared without copies. This does not preserve serial
     * ordering across the full Track A–D DSP chain; the engine reports any
     * placement that would skip an earlier shared stage.
     */
    public configureLoopTransportFx(
        slotIndex: number,
        type: LoopTransportFxName | string | null,
        parameters: Readonly<Record<string, number>> = {},
    ): boolean {
        if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 3) return false;
        const normalizedType = type === null ? null : type.trim().toUpperCase();
        if (normalizedType !== null && normalizedType !== 'BEAT SHIFT' && normalizedType !== 'VINYL FLICK') return false;

        const now = this.engine.context.currentTime;
        const wasPlaying = (this.state === TrackState.PLAYING || this.state === TrackState.OVERDUBBING)
            && !!this.audioBuffer && !!this.sourceNode;
        const hadReader = this.loopTransportPlaybackInitialized;
        const wasReaderPlaying = wasPlaying && hadReader;
        const positionBeforeConfig = wasPlaying && !hadReader ? this.getCurrentPlaybackPosition() : 0;
        if (wasReaderPlaying) this.advanceLoopTransportTo(now);

        const previousSlot = this.loopTransportFxSlots[slotIndex];
        const previousShiftSeconds = hadReader ? this.loopTransportRenderedBeatShiftSeconds : 0;
        let nextSlot: LoopTransportFxSlot | null;
        if (normalizedType === null) {
            nextSlot = null;
        } else if (previousSlot?.type === normalizedType) {
            nextSlot = { ...previousSlot };
        } else {
            nextSlot = {
                type: normalizedType,
                beatShiftOffsetBeats: 0,
                beatShiftCrossfadeMs: 5,
                bpm: null,
                vinylFlickSpeed: 0,
                vinylFlickMix: 0,
                vinylFlickReturnTimeSeconds: DEFAULT_LOOP_MOTOR_RETURN_SECONDS,
                vinylFlickBrakePercent: DEFAULT_LOOP_MOTOR_BRAKE_PERCENT,
            };
        }

        if (nextSlot) {
            for (const [key, value] of Object.entries(parameters)) {
                this.applyLoopTransportParameter(nextSlot, key, value);
            }
        }
        this.loopTransportFxSlots[slotIndex] = nextSlot;

        const slotMotor = this.loopMotorStates[slotIndex];
        if (slotMotor) {
            if (nextSlot?.type === 'VINYL FLICK') {
                slotMotor.targetRate = loopMotorTargetRate(nextSlot.vinylFlickSpeed, nextSlot.vinylFlickMix);
                slotMotor.returnTimeSeconds = nextSlot.vinylFlickReturnTimeSeconds;
                slotMotor.brakePercent = nextSlot.vinylFlickBrakePercent;
            } else if (previousSlot?.type === 'VINYL FLICK') {
                // Removing the effect returns its one read-head contribution
                // smoothly to unity instead of changing rate at the removal edge.
                slotMotor.targetRate = 1;
                slotMotor.returnTimeSeconds = previousSlot.vinylFlickReturnTimeSeconds;
                slotMotor.brakePercent = previousSlot.vinylFlickBrakePercent;
            }
        }

        const hasConfiguredFx = this.hasConfiguredLoopTransportFx();
        if (!hasConfiguredFx) this.loopTransportRuntimeFallbackReason = null;
        const canUseReader = wasPlaying && !this.isReverse
            && !this.liveMonoPitchEnabledInternal && !this.liveMonoPitchActiveInternal
            && !this.livePolyPitchEnabledInternal && !this.livePolyPitchActiveInternal;
        const routeNeedsContinuation = hadReader && this.sourceNode !== null;
        if (canUseReader && (hasConfiguredFx || routeNeedsContinuation)) {
            if (!wasReaderPlaying) {
                // Promote an already-running legacy source without a phase jump.
                // Forward BufferSource playback has a unity source gain so this
                // transition remains bounded and crossfadeable.
                this.loopTransportPlaybackInitialized = true;
                this.loopTransportPhaseBaseSeconds = positionBeforeConfig;
                this.loopTransportPhaseTime = now;
                this.loopTransportStartOffsetShiftSeconds = 0;
                this.resetLoopMotorStates();
                this.loopTransportRenderedBeatShiftSeconds = 0;
            }

            const nextShiftSeconds = this.getLoopTransportBeatShiftSeconds();
            if (Math.abs(nextShiftSeconds - (wasReaderPlaying ? previousShiftSeconds : 0)) > 1e-9) {
                if (this.loopTransportTransitionActive) {
                    this.loopTransportPendingRetarget = true;
                } else {
                    this.retargetLoopTransportSource(nextShiftSeconds, this.getLoopTransportCrossfadeMs());
                }
            } else if (hasConfiguredFx || routeNeedsContinuation) {
                this.scheduleLoopMotorAutomation(this.sourceNode, now);
            }
        }

        return true;
    }

    /** Incrementally updates a named control in an already selected global A-D transport slot. */
    public setLoopTransportFxParameter(slotIndex: number, key: string, value: number): boolean {
        if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 3 || !Number.isFinite(value)) return false;
        const selected = this.loopTransportFxSlots[slotIndex];
        if (!selected) return false;
        return this.configureLoopTransportFx(slotIndex, selected.type, { [key]: value });
    }

    /** Re-anchors a running source after Transport.setBpm emits `bpm-change`. */
    public refreshLoopTransportTempo(): void {
        if (!this.loopTransportPlaybackInitialized || !this.sourceNode || this.isReverse
            || (this.state !== TrackState.PLAYING && this.state !== TrackState.OVERDUBBING)
            || !this.hasConfiguredLoopTransportFx()) return;
        const previousShiftSeconds = this.loopTransportRenderedBeatShiftSeconds;
        this.advanceLoopTransportTo(this.engine.context.currentTime);
        const nextShiftSeconds = this.getLoopTransportBeatShiftSeconds();
        if (Math.abs(nextShiftSeconds - previousShiftSeconds) <= 1e-9) return;
        if (this.loopTransportTransitionActive) {
            this.loopTransportPendingRetarget = true;
        } else {
            this.retargetLoopTransportSource(nextShiftSeconds, this.getLoopTransportCrossfadeMs());
        }
    }

    private applyLoopTransportParameter(slot: LoopTransportFxSlot, key: string, value: number): void {
        if (!Number.isFinite(value)) return;
        const normalizedKey = key.trim();
        if (slot.type === 'BEAT SHIFT') {
            if (normalizedKey === 'offset' || normalizedKey === 'beat-offset' || normalizedKey === 'offset-beats'
                || normalizedKey === 'beat-shift.offset' || normalizedKey === 'beatShiftOffsetBeats') {
                slot.beatShiftOffsetBeats = clampFinite(value, -4, 4, slot.beatShiftOffsetBeats);
            } else if (normalizedKey === 'crossfade' || normalizedKey === 'crossfade-ms'
                || normalizedKey === 'beat-shift.crossfade' || normalizedKey === 'crossfadeMs'
                || normalizedKey === 'beatShiftCrossfadeMs') {
                slot.beatShiftCrossfadeMs = clampFinite(value, LOOP_SHIFT_MIN_CROSSFADE_MS, LOOP_SHIFT_MAX_CROSSFADE_MS, slot.beatShiftCrossfadeMs);
            } else if (normalizedKey === 'bpm') {
                // The initial worklet snapshot may contain BPM; the source reader
                // follows the shared Transport and must not freeze that snapshot.
                slot.bpm = null;
            }
            return;
        }

        if (normalizedKey === 'amount') {
            const amount = clampFinite(value, 0, 1, 0.5);
            slot.vinylFlickSpeed = (amount * 200) - 100;
            slot.vinylFlickMix = amount;
        } else if (normalizedKey === 'speed' || normalizedKey === 'speedPercent'
            || normalizedKey === 'vinyl-flick.speed' || normalizedKey === 'vinylFlickSpeed'
            || normalizedKey === 'vinylFlickSpeedPercent') {
            slot.vinylFlickSpeed = clampFinite(value, -100, 100, slot.vinylFlickSpeed);
        } else if (normalizedKey === 'mix' || normalizedKey === 'vinyl-flick.mix') {
            const normalizedMix = value > 1 ? value / 100 : value;
            slot.vinylFlickMix = clampFinite(normalizedMix, 0, 1, slot.vinylFlickMix);
        } else if (normalizedKey === 'return-time' || normalizedKey === 'return_time_seconds'
            || normalizedKey === 'returnTimeSeconds' || normalizedKey === 'vinyl-flick.return-time'
            || normalizedKey === 'vinylFlickReturnTimeSeconds') {
            slot.vinylFlickReturnTimeSeconds = clampFinite(value, LOOP_MOTOR_MIN_RETURN_SECONDS, LOOP_MOTOR_MAX_RETURN_SECONDS, slot.vinylFlickReturnTimeSeconds);
        } else if (normalizedKey === 'brake' || normalizedKey === 'brake_percent'
            || normalizedKey === 'brakePercent' || normalizedKey === 'vinyl-flick.brake'
            || normalizedKey === 'vinylFlickBrakePercent') {
            slot.vinylFlickBrakePercent = clampFinite(value, 0, 100, slot.vinylFlickBrakePercent);
        }
    }

    private hasConfiguredLoopTransportFx(): boolean {
        return this.loopTransportFxSlots.some((slot) => slot !== null);
    }

    public get transportEnabled(): boolean {
        return true;
    }

    /** Explicit per-track opt-in; false by default so legacy playback is unchanged. */
    public get livePolyPitchEnabled(): boolean {
        return this.livePolyPitchEnabledInternal;
    }

    /** True only while Signalsmith is currently routed into this track's FX chain. */
    public get livePolyPitchActive(): boolean {
        return this.livePolyPitchActiveInternal;
    }

    /** Measured Signalsmith algorithmic latency; null until the Worklet is configured. */
    public get livePolyPitchLatencySamples(): number | null {
        return this.livePolyPitchLatencySamplesValue;
    }

    public get livePolyPitchLatencySeconds(): number | null {
        return this.livePolyPitchLatencySamplesValue === null
            ? null
            : this.livePolyPitchLatencySamplesValue / this.engine.context.sampleRate;
    }

    /** Explains why requested KeepPitch is currently falling back to ordinary playback. */
    public get livePolyPitchFallbackReason(): string | null {
        return this.livePolyPitchFallbackReasonValue;
    }

    /** Per-track opt-in to the dedicated monophonic YIN/PSOLA playback route. */
    public get liveMonoPitchEnabled(): boolean {
        return this.liveMonoPitchEnabledInternal;
    }

    public get liveMonoPitchActive(): boolean {
        return this.liveMonoPitchActiveInternal;
    }

    public get liveMonoPitchLatencySamples(): number | null {
        return this.liveMonoPitchLatencySamplesValue;
    }

    public get liveMonoPitchLatencySeconds(): number | null {
        return this.liveMonoPitchLatencySamplesValue === null
            ? null
            : this.liveMonoPitchLatencySamplesValue / this.engine.context.sampleRate;
    }

    public get liveMonoPitchFallbackReason(): string | null {
        return this.liveMonoPitchFallbackReasonValue;
    }

    /** Whether this Browser track currently owns audio that can be rendered offline. */
    public get canExportHqWav(): boolean {
        return this.audioBuffer !== null
            && !this.isRecording
            && !this.isFinalizingRecording
            && this.state !== TrackState.RECORDING
            && this.state !== TrackState.REC_FINISHING;
    }

    /**
     * Renders a snapshot of this track through Signalsmith HQ_RENDER off the
     * real-time callback, then encodes an aligned WAV. Track audio is copied to
     * a dedicated Worker so export never detaches or mutates the live loop.
     */
    public exportHqWav(
        options: HqWavExportRequestOptions,
        onProgress?: (fraction: number) => void,
    ): Promise<HqWavExportResult> {
        const buffer = this.audioBuffer;
        if (!buffer || !this.canExportHqWav) {
            return Promise.reject(new Error('This track has no completed audio buffer to export'));
        }
        if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) {
            return Promise.reject(new RangeError('HQ WAV export supports one or two channels'));
        }
        const channels = Array.from(
            { length: buffer.numberOfChannels },
            (_, channel) => buffer.getChannelData(channel),
        );
        const { nativeHqEngine: _nativeHqEngine, ...browserOptions } = options;
        return createHqWavExport(channels, {
            ...browserOptions,
            sampleRate: buffer.sampleRate,
        }, onProgress);
    }

    /**
     * Enables or configures the per-track polyphonic pitch/time stretcher.
     * This remains opt-in. Reverse playback deliberately uses the existing buffer
     * source path because Signalsmith's internal loop reader is forward-only.
     */
    public async setLivePolyPitchEnabled(
        enabled: boolean,
        options: { semitones?: number; playbackRate?: number; tonalityLimitHz?: number } = {},
    ): Promise<void> {
        if (options.semitones !== undefined && (!Number.isFinite(options.semitones) || options.semitones < -24 || options.semitones > 24)) {
            throw new RangeError('semitones must be between -24 and +24');
        }
        if (options.playbackRate !== undefined && (!Number.isFinite(options.playbackRate) || options.playbackRate < 0.5 || options.playbackRate > 2)) {
            throw new RangeError('playbackRate must be between 0.5 and 2');
        }
        if (options.tonalityLimitHz !== undefined && (!Number.isFinite(options.tonalityLimitHz) || options.tonalityLimitHz <= 0)) {
            throw new RangeError('tonalityLimitHz must be positive and finite');
        }

        const wasPlaying = this.state === TrackState.PLAYING;
        if (wasPlaying) {
            this.startOffset = this.getCurrentPlaybackPosition();
            this.loopTransportStartOffsetShiftSeconds = this.loopTransportPlaybackInitialized && !this.loopTransportUnavailableReason
                ? this.getLoopTransportBeatShiftSeconds()
                : 0;
        }

        if (enabled && this.liveMonoPitchEnabledInternal) {
            this.liveMonoPitchEnabledInternal = false;
            await this.disposeLiveMonoPitchNode();
        }

        this.livePolyPitchEnabledInternal = enabled;
        this.livePolyPitchSemitones = options.semitones ?? this.livePolyPitchSemitones;
        this.livePolyPitchPlaybackRate = options.playbackRate ?? this.livePolyPitchPlaybackRate;
        this.livePolyPitchTonalityLimitHz = options.tonalityLimitHz ?? this.livePolyPitchTonalityLimitHz;
        this.livePolyPitchFallbackReasonValue = null;

        if (!enabled) {
            if (wasPlaying && this.audioBuffer) await this.play();
            await this.disposeLivePolyPitchNode();
            return;
        }

        // Let play() own route replacement when already running; this invalidates any
        // older asynchronous start before it can resurrect playback after a stop.
        if (wasPlaying && this.audioBuffer) {
            await this.play();
            return;
        }

        if (this.audioBuffer && this.audioBuffer.numberOfChannels > 2) {
            this.livePolyPitchFallbackReasonValue = 'Signalsmith supports at most two channels';
        } else {
            await this.ensureLivePolyPitchNode();
        }
    }

    /** Enables the dedicated monophonic KeepPitch path on this track. */
    public async setLiveMonoPitchEnabled(
        enabled: boolean,
        options: { semitones?: number; minimumFrequencyHz?: number; maximumFrequencyHz?: number } = {},
    ): Promise<void> {
        if (options.semitones !== undefined && (!Number.isFinite(options.semitones) || options.semitones < -12 || options.semitones > 12)) {
            throw new RangeError('LIVE_MONO semitones must be between -12 and +12');
        }
        const wasPlaying = this.state === TrackState.PLAYING;
        if (wasPlaying) {
            this.startOffset = this.getCurrentPlaybackPosition();
            this.loopTransportStartOffsetShiftSeconds = this.loopTransportPlaybackInitialized && !this.loopTransportUnavailableReason
                ? this.getLoopTransportBeatShiftSeconds()
                : 0;
        }

        if (enabled && this.livePolyPitchEnabledInternal) {
            this.livePolyPitchEnabledInternal = false;
            await this.disposeLivePolyPitchNode();
        }

        this.liveMonoPitchEnabledInternal = enabled;
        this.liveMonoPitchSemitones = options.semitones ?? this.liveMonoPitchSemitones;
        this.liveMonoPitchMinimumFrequencyHz = options.minimumFrequencyHz ?? this.liveMonoPitchMinimumFrequencyHz;
        this.liveMonoPitchMaximumFrequencyHz = options.maximumFrequencyHz ?? this.liveMonoPitchMaximumFrequencyHz;
        this.liveMonoPitchFallbackReasonValue = null;

        if (!enabled) {
            if (wasPlaying && this.audioBuffer) await this.play();
            await this.disposeLiveMonoPitchNode();
            return;
        }

        if (wasPlaying && this.audioBuffer) {
            await this.play();
            return;
        }

        if (this.audioBuffer && this.audioBuffer.numberOfChannels > 2) {
            this.liveMonoPitchFallbackReasonValue = 'LIVE_MONO accepts at most two input channels';
        } else {
            await this.ensureLiveMonoPitchNode();
        }
    }

    private getBrowserRecordingOffsetConfig() {
        return getBrowserRecordingOffsetConfig(this.engine.context.sampleRate, {
            inputDeviceId: this.engine.selectedInputDeviceId ?? null,
            outputDeviceId: this.engine.selectedOutputDeviceId ?? null,
            sampleRate: this.engine.context.sampleRate,
            bufferFrames: this.engine.selectedBufferFrames === 0
                ? null
                : this.engine.selectedBufferFrames ?? 128,
        });
    }

    private startPositionUpdater() {
        const update = () => {
            // Update State
            if (this.sharedStates) {
                Atomics.store(this.sharedStates, this.trackIndex, Object.values(TrackState).indexOf(this.state));
            }

            // Update Position
            if (this.state === TrackState.PLAYING && this.audioBuffer && (this.sourceNode || this.livePolyPitchActiveInternal)) {
                // Rough estimation of position
                // ideally we capture start time of sourceNode
                // For now, let's just increment a local counter or use modulo if we knew start time
                // But we don't have start time stored yet.
                // Let's rely on a simple time diff for now, assuming perfect loop

                // Better approach for Phase 3:
                // Just use (currentTime % duration) / duration
                // But we need to offset by when it started relative to context time 0?
                // No, if it's looping, it's just (currentTime % duration)
                // BUT, only if it started at 0.
                // If it started at T, it's ((currentTime - T) % duration)

                // Let's assume it's synced to Transport measure if Master exists?
                // Or just use a simple modulo for visual feedback for now.

                const duration = this.audioBuffer.duration;
                if (duration > 0) {
                    const currentPosition = this.getCurrentPlaybackPosition();
                    const progress = currentPosition / duration;
                    if (this.sharedPositions) {
                        // Float32Array doesn't support Atomics, but single writer is usually fine for UI
                        this.sharedPositions[this.trackIndex] = progress;
                    }
                }
            } else {
                if (this.sharedPositions) {
                    this.sharedPositions[this.trackIndex] = 0;
                }
            }
            requestAnimationFrame(update);
        };
        requestAnimationFrame(update);
    }

    public updateSettings() {
        this.gainNode.gain.value = this.track.playLevel / 100;

        const panStr = this.track.pan;
        let panVal = 0;
        if (panStr === "CENTER") panVal = 0;
        else if (panStr.startsWith("L")) panVal = -parseInt(panStr.substring(1)) / 50;
        else if (panStr.startsWith("R")) panVal = parseInt(panStr.substring(1)) / 50;

        this.panNode.pan.value = panVal;
    }

    private ensureTransportRunning() {
        if (this.transport.state !== TransportState.PLAYING) {
            this.transport.start();
        }
    }

    private isActiveTransportState(state: TrackState) {
        return state === TrackState.REC_STANDBY ||
            state === TrackState.RECORDING ||
            state === TrackState.REC_FINISHING ||
            state === TrackState.PLAYING ||
            state === TrackState.OVERDUBBING;
    }

    private syncTransportState() {
        const trackEngine = this.engine as IAudioEngine & { tracks?: Array<{ state: TrackState }> };
        const hasActiveTracks = trackEngine.tracks?.some((track) => this.isActiveTransportState(track.state)) ?? false;

        if (hasActiveTracks) {
            this.ensureTransportRunning();
            return;
        }

        if (this.transport.state === TransportState.PLAYING) {
            this.transport.stop();
        }
    }

    // --- Transport & State Logic ---

    public triggerRecord() {
        if (this.state === TrackState.EMPTY) {
            this.scheduleRecordingStart();
        } else if (this.state === TrackState.RECORDING) {
            this.scheduleRecordingStop();
        } else if (this.state === TrackState.PLAYING) {
            this.state = TrackState.OVERDUBBING;
            this.ensureTransportRunning();
            this.startOverdub();
        } else if (this.state === TrackState.OVERDUBBING) {
            this.state = TrackState.PLAYING;
            this.stopOverdub();
        } else if (this.state === TrackState.STOPPED) {
            this.play();
        }
    }

    public triggerStop() {
        this.cancelQuantizeWait();

        if (this.state === TrackState.RECORDING || this.state === TrackState.REC_FINISHING) {
            this.resumeAfterRecording = false;
            this.stopRecording();
            return;
        }

        if (this.state === TrackState.OVERDUBBING) {
            this.stopOverdub();
        }

        if (this.state === TrackState.REC_STANDBY) {
            this.state = TrackState.STOPPED;
            this.syncTransportState();
            return;
        }

        this.stop();
        this.state = TrackState.STOPPED;
        this.syncTransportState();
    }

    private scheduleRecordingStart() {
        // ========================================
        // QUANTIZED RECORDING START LOGIC
        // ========================================

        // Check if there's a master track
        if (!this.transport.hasMasterTrack()) {
            // NO MASTER TRACK - This will become the master
            console.log(`Track ${this.track.id}: No master track - starting immediately`);
            this.startRecording();

            // Start transport if it's not running
            if (this.transport.state !== TransportState.PLAYING) {
                this.transport.start();
            }
            return;
        }

        // MASTER TRACK EXISTS - This is a slave track
        // Enter REC_STANDBY state and wait for measure boundary

        console.log(`\n⏸️  Track ${this.track.id}: Entering REC_STANDBY (waiting for measure boundary)`);
        console.log(`   Master track: Track ${this.transport.masterTrackId}`);
        console.log(`   Master loop length: ${this.transport.masterLoopLengthSamples} samples`);

        // Set state to REC_STANDBY (will show red blinking LED in UI)
        this.state = TrackState.REC_STANDBY;
        this.waitingForQuantize = true;
        this.ensureTransportRunning();

        // Listen for next measure boundary
        const onMeasure = () => {
            if (this.waitingForQuantize && this.state === TrackState.REC_STANDBY) {
                console.log(`\n🎬 Track ${this.track.id}: Measure boundary reached - starting recording NOW`);

                this.waitingForQuantize = false;
                this.transport.off('measure', onMeasure);
                this.quantizeStartListener = null;
                this.startRecording();
            }
        };

        this.quantizeStartListener = onMeasure;
        this.transport.on('measure', onMeasure);

        console.log(`   Waiting for next measure event...\n`);
    }

    private scheduleRecordingStop() {
        // ========================================
        // QUANTIZED RECORDING STOP LOGIC
        // ========================================

        // Check if there's a master track
        if (!this.transport.hasMasterTrack()) {
            // NO MASTER TRACK - This IS the master, stop immediately
            console.log(`Track ${this.track.id}: Master track - stopping immediately`);
            this.stopRecording();
            return;
        }

        // MASTER TRACK EXISTS - This is a slave track
        // Enter REC_FINISHING state and wait for measure boundary

        console.log(`\n⏹️  Track ${this.track.id}: Entering REC_FINISHING (waiting for measure boundary to stop)`);
        console.log(`   Master track: Track ${this.transport.masterTrackId}`);
        console.log(`   Master loop length: ${this.transport.masterLoopLengthSamples} samples`);

        // Set state to REC_FINISHING (will show red/green blinking LED in UI)
        this.state = TrackState.REC_FINISHING;
        this.waitingForQuantizeStop = true;
        this.ensureTransportRunning();

        // Listen for next measure boundary
        const onMeasureStop = () => {
            if (this.waitingForQuantizeStop && this.state === TrackState.REC_FINISHING) {
                console.log(`\n🏁 Track ${this.track.id}: Measure boundary reached - stopping recording NOW`);

                this.waitingForQuantizeStop = false;
                this.transport.off('measure', onMeasureStop);
                this.quantizeStopListener = null;
                this.stopRecording();
            }
        };

        this.quantizeStopListener = onMeasureStop;
        this.transport.on('measure', onMeasureStop);

        console.log(`   Waiting for next measure event to complete recording...\n`);
    }

    // --- Audio Logic ---

    private getLoopTransportBeatShiftSeconds(): number {
        let offsetSeconds = 0;
        for (const slot of this.loopTransportFxSlots) {
            if (!slot || slot.type !== 'BEAT SHIFT') continue;
            const bpm = clampFinite(slot.bpm ?? this.transport.bpm, 40, 300, 120);
            offsetSeconds += slot.beatShiftOffsetBeats * (60 / bpm);
        }
        return offsetSeconds;
    }

    private getLoopTransportCrossfadeMs(): number {
        let crossfadeMs = 5;
        for (const slot of this.loopTransportFxSlots) {
            if (slot?.type === 'BEAT SHIFT') {
                crossfadeMs = Math.max(crossfadeMs, slot.beatShiftCrossfadeMs);
            }
        }
        return clampFinite(crossfadeMs, LOOP_SHIFT_MIN_CROSSFADE_MS, LOOP_SHIFT_MAX_CROSSFADE_MS, 5);
    }

    private resetLoopMotorStates(): void {
        for (let index = 0; index < this.loopMotorStates.length; index += 1) {
            const state = this.loopMotorStates[index];
            const slot = this.loopTransportFxSlots[index];
            if (!state) continue;
            state.rate = 1;
            state.velocity = 0;
            if (slot?.type === 'VINYL FLICK') {
                state.targetRate = loopMotorTargetRate(slot.vinylFlickSpeed, slot.vinylFlickMix);
                state.returnTimeSeconds = slot.vinylFlickReturnTimeSeconds;
                state.brakePercent = slot.vinylFlickBrakePercent;
            } else {
                state.targetRate = 1;
                state.returnTimeSeconds = DEFAULT_LOOP_MOTOR_RETURN_SECONDS;
                state.brakePercent = DEFAULT_LOOP_MOTOR_BRAKE_PERCENT;
            }
        }
    }

    private getLoopMotorProductRate(elapsedSeconds = 0): number {
        let rate = 1;
        for (const state of this.loopMotorStates) {
            rate *= elapsedSeconds > 0 ? evaluateLoopMotor(state, elapsedSeconds).point.rate : state.rate;
        }
        return Number.isFinite(rate) ? Math.max(0, Math.min(16, rate)) : 1;
    }

    private advanceLoopTransportTo(time: number): void {
        if (!this.loopTransportPlaybackInitialized || !Number.isFinite(time)) return;
        const elapsed = Math.max(0, time - this.loopTransportPhaseTime);
        if (elapsed <= 0) return;

        // One Vinyl motor (the common case) has a closed-form rate integral,
        // which avoids phase drift even after background-tab throttling. If
        // multiple A–D motor instances are stacked, bounded Simpson sampling
        // integrates their product without unbounded catch-up work.
        const activeMotors = this.loopMotorStates.filter((state) =>
            Math.abs(state.rate - 1) > 1e-7 || Math.abs(state.velocity) > 1e-7 || Math.abs(state.targetRate - 1) > 1e-7,
        );
        let integratedRateSeconds = elapsed;
        if (activeMotors.length === 1) {
            integratedRateSeconds = evaluateLoopMotor(activeMotors[0]!, elapsed).integral;
        } else if (activeMotors.length > 1) {
            const steps = LOOP_MOTOR_INTEGRATION_STEPS;
            const stepSeconds = elapsed / steps;
            let weightedRateSum = 0;
            for (let sample = 0; sample <= steps; sample += 1) {
                const weight = sample === 0 || sample === steps ? 1 : sample % 2 === 0 ? 2 : 4;
                weightedRateSum += weight * this.getLoopMotorProductRate(stepSeconds * sample);
            }
            integratedRateSeconds = (weightedRateSum * stepSeconds) / 3;
        }
        this.loopTransportPhaseBaseSeconds += Number.isFinite(integratedRateSeconds) ? integratedRateSeconds : elapsed;

        for (const state of this.loopMotorStates) {
            const point = evaluateLoopMotor(state, elapsed).point;
            state.rate = point.rate;
            state.velocity = point.velocity;
        }
        this.loopTransportPhaseTime = time;
    }

    private getLoopMotorAutomationHorizonSeconds(): number {
        let returnTime = LOOP_MOTOR_MIN_RETURN_SECONDS;
        for (const state of this.loopMotorStates) {
            returnTime = Math.max(returnTime, state.returnTimeSeconds);
        }
        return Math.min(LOOP_MOTOR_MAX_AUTOMATION_SECONDS, Math.max(0.2, returnTime * 4));
    }

    private scheduleLoopMotorAutomation(source: AudioBufferSourceNode | null, now: number): void {
        if (!source || !this.loopTransportPlaybackInitialized) return;
        const playbackRate = source.playbackRate;
        const currentRate = this.getLoopMotorProductRate();
        const moving = this.loopMotorStates.some((state) => Math.abs(state.rate - state.targetRate) > 1e-5 || Math.abs(state.velocity) > 1e-5);
        try {
            playbackRate.cancelScheduledValues(now);
            if (!moving) {
                playbackRate.setValueAtTime(currentRate, now);
                return;
            }

            const duration = this.getLoopMotorAutomationHorizonSeconds();
            const curve = new Float32Array(LOOP_MOTOR_CURVE_SAMPLES);
            for (let sample = 0; sample < curve.length; sample += 1) {
                const time = duration * sample / (curve.length - 1);
                curve[sample] = this.getLoopMotorProductRate(time);
            }
            let finalRate = 1;
            for (const state of this.loopMotorStates) finalRate *= state.targetRate;
            curve[0] = currentRate;
            curve[curve.length - 1] = Math.max(0, Math.min(16, finalRate));
            playbackRate.setValueCurveAtTime(curve, now, duration);
        } catch {
            // AudioParam implementations without curve automation keep a safe
            // finite rate rather than failing the track's source route.
            playbackRate.value = currentRate;
        }
    }

    private scheduleEqualPowerGain(gain: GainNode, from: number, to: number, now: number, durationSeconds: number): void {
        const values = new Float32Array(33);
        for (let index = 0; index < values.length; index += 1) {
            const progress = index / (values.length - 1);
            const angle = progress * (Math.PI / 2);
            values[index] = from === 0
                ? Math.sin(angle) * to
                : to === 0
                    ? Math.cos(angle) * from
                    : from + ((to - from) * progress);
        }
        try {
            gain.gain.cancelScheduledValues(now);
            gain.gain.setValueAtTime(from, now);
            gain.gain.setValueCurveAtTime(values, now, durationSeconds);
        } catch {
            gain.gain.value = to;
        }
    }

    private createSourceAwareBufferSource(phaseSeconds: number, when: number, gainValue: number): { source: AudioBufferSourceNode; gain: GainNode } | null {
        if (!this.audioBuffer) return null;
        const context = this.engine.context;
        let source: AudioBufferSourceNode | null = null;
        let gain: GainNode | null = null;
        try {
            source = context.createBufferSource();
            if (!source) return null;
            gain = context.createGain();
            if (!gain) {
                source.disconnect();
                return null;
            }
            source.buffer = this.audioBuffer;
            source.loop = true;
            gain.gain.value = gainValue;
            source.connect(gain);
            gain.connect(this.fxChain.input);
            source.playbackRate.value = this.getLoopMotorProductRate();
            this.scheduleLoopMotorAutomation(source, when);
            source.start(when, wrapLoopPhase(phaseSeconds, this.audioBuffer.duration));
            return { source, gain };
        } catch {
            try { source?.stop(); } catch { /* source did not start */ }
            try { source?.disconnect(); } catch { /* already disconnected */ }
            try { gain?.disconnect(); } catch { /* gain was not connected */ }
            return null;
        }
    }

    private retargetLoopTransportSource(beatShiftSeconds: number, crossfadeMs: number): void {
        if (!this.loopTransportPlaybackInitialized || !this.sourceNode || !this.sourceGainNode || !this.audioBuffer) return;
        const context = this.engine.context;
        const now = context.currentTime;
        this.advanceLoopTransportTo(now);
        const targetShift = Number.isFinite(beatShiftSeconds) ? beatShiftSeconds : 0;
        const durationSeconds = clampFinite(crossfadeMs, LOOP_SHIFT_MIN_CROSSFADE_MS, LOOP_SHIFT_MAX_CROSSFADE_MS, 5) / 1000;
        const replacement = this.createSourceAwareBufferSource(
            this.loopTransportPhaseBaseSeconds + targetShift,
            now,
            0,
        );
        if (!replacement) {
            this.loopTransportRuntimeFallbackReason = 'Source-aware reader creation failed; current loop playback is retained';
            this.scheduleLoopMotorAutomation(this.sourceNode, now);
            return;
        }

        const oldSource = this.sourceNode;
        const oldGain = this.sourceGainNode;
        const endTime = now + durationSeconds;
        this.scheduleEqualPowerGain(oldGain, 1, 0, now, durationSeconds);
        this.scheduleEqualPowerGain(replacement.gain, 0, 1, now, durationSeconds);
        this.retiringSourceNode = oldSource;
        this.retiringSourceGainNode = oldGain;
        this.sourceNode = replacement.source;
        this.sourceGainNode = replacement.gain;
        this.loopTransportRenderedBeatShiftSeconds = targetShift;
        this.loopTransportRuntimeFallbackReason = null;
        this.loopTransportTransitionActive = true;
        this.loopTransportPendingRetarget = false;
        oldSource.onended = () => this.finishLoopTransportTransition(oldSource, oldGain);
        try {
            oldSource.stop(endTime);
        } catch {
            this.finishLoopTransportTransition(oldSource, oldGain);
        }
    }

    private finishLoopTransportTransition(source: AudioBufferSourceNode, gain: GainNode): void {
        if (this.retiringSourceNode !== source) return;
        source.onended = null;
        try { source.disconnect(); } catch { /* already disconnected */ }
        try { gain.disconnect(); } catch { /* already disconnected */ }
        this.retiringSourceNode = null;
        this.retiringSourceGainNode = null;
        this.loopTransportTransitionActive = false;
        if (!this.loopTransportPendingRetarget || !this.loopTransportPlaybackInitialized) return;
        const desiredShift = this.getLoopTransportBeatShiftSeconds();
        if (Math.abs(desiredShift - this.loopTransportRenderedBeatShiftSeconds) > 1e-9) {
            this.retargetLoopTransportSource(desiredShift, this.getLoopTransportCrossfadeMs());
        } else {
            this.loopTransportPendingRetarget = false;
        }
    }

    private stopAndDisconnectBufferSource(source: AudioBufferSourceNode | null, gain: GainNode | null): void {
        if (source) {
            source.onended = null;
            try { source.playbackRate.cancelScheduledValues(this.engine.context.currentTime); } catch { /* stopped source */ }
            try { source.stop(); } catch { /* already stopped */ }
            try { source.disconnect(); } catch { /* already disconnected */ }
        }
        if (gain) {
            try { gain.gain.cancelScheduledValues(this.engine.context.currentTime); } catch { /* disconnected gain */ }
            try { gain.disconnect(); } catch { /* already disconnected */ }
        }
    }

    public async startRecording() {
        if (this.isRecording || this.isFinalizingRecording) return;
        const ctx = this.engine.context;
        const input = await this.engine.getProcessedInputNode();
        if (this.isRecording || this.isFinalizingRecording) return;
        this.resumeAfterRecording = true;
        const maxRecordingFrames = MAX_RECORDING_CAPTURE_SAMPLES;
        this.clearRecordingChunkStorage();
        this.pendingRecordingComplete = null;
        this.recordingFramesCaptured = 0;
        this.recordingDroppedFrames = 0;
        this.recordingOverflowEvents = 0;
        this.recordingMaximumFrames = maxRecordingFrames;
        this.recordingMaximumDurationSeconds = maxRecordingFrames / ctx.sampleRate;
        this.recordingLimitReached = false;
        this.recordingDiagnostic = null;
        const workletNode = new AudioWorkletNode(ctx, 'looper-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [MAX_RECORDING_CHANNELS],
            channelCount: MAX_RECORDING_CHANNELS,
            channelCountMode: 'max',
            channelInterpretation: 'speakers',
            processorOptions: {
                chunkSize: RECORDING_CHUNK_SIZE,
                chunkPoolSize: RECORDING_CHUNK_POOL_SIZE,
                maxRecordingFrames,
                maxRecordingSamples: MAX_RECORDING_CAPTURE_SAMPLES,
            },
        });
        workletNode.port.onmessage = (event) => this.handleRecordingMessage(workletNode, event.data as RecordingWorkletMessage);
        input.connect(workletNode);
        workletNode.connect(this.fxChain.input);
        this.workletNode = workletNode;
        this.isRecording = true;
        this.state = TrackState.RECORDING;
        workletNode.port.postMessage({ type: 'START_RECORD' });
    }

    public async stopRecording() {
        if (!this.isRecording || !this.workletNode) return;

        this.isRecording = false;
        this.isFinalizingRecording = true;
        this.workletNode.port.postMessage({ type: 'STOP_RECORD' });
    }

    private handleRecordingMessage(workletNode: AudioWorkletNode, message: RecordingWorkletMessage) {
        if (this.workletNode !== workletNode || !message) return;

        if (message.type === 'RECORD_CHUNK') {
            this.acceptRecordingChunk(workletNode, message);
            return;
        }

        if (message.type === 'RECORD_COMPLETE') {
            this.pendingRecordingComplete = message;
            this.finishRecordingWhenReady(workletNode);
            return;
        }
    }

    private acceptRecordingChunk(
        workletNode: AudioWorkletNode,
        message: Extract<RecordingWorkletMessage, { type: 'RECORD_CHUNK' }>,
    ) {
        const samples = message.samples;
        this.recordingReceivedChunkMessages += 1;
        if (!(samples instanceof Float32Array)) {
            this.recordingOverflowEvents += 1;
            this.finishRecordingWhenReady(workletNode);
            return;
        }
        const channelCount: 1 | 2 = message.channelCount === 2 ? 2 : 1;
        if (this.recordingChunkCount === 0) {
            this.recordingChannelCount = channelCount;
            this.recordingMaximumFrames = Math.floor(MAX_RECORDING_CAPTURE_SAMPLES / channelCount);
            this.recordingMaximumDurationSeconds = this.recordingMaximumFrames / this.engine.context.sampleRate;
        }
        const sequence = Number.isInteger(message.sequence) ? message.sequence : -1;
        const validFrames = Number.isFinite(message.validFrames)
            ? Math.max(0, Math.min(Math.floor(message.validFrames), Math.floor(samples.length / channelCount)))
            : 0;
        const hasAvailableSlot = sequence >= 0 && sequence < MAX_RECORDING_CHUNKS;
        const isNewSequence = hasAvailableSlot && channelCount === this.recordingChannelCount && this.receivedChunkFlags[sequence] === 0;
        if (isNewSequence && validFrames > 0) {
            const retainedSamples = new Float32Array(validFrames * channelCount);
            retainedSamples.set(samples.subarray(0, retainedSamples.length));
            this.recordedChunks[sequence] = retainedSamples;
            this.recordedChunkLengths[sequence] = validFrames;
            this.receivedChunkFlags[sequence] = 1;
            this.recordingChunkCount += 1;
            this.recordingStoredFrames += validFrames;
            this.recordingFramesCaptured = this.recordingStoredFrames;
        } else {
            this.recordingOverflowEvents += 1;
        }
        const expectedPoolSamples = RECORDING_CHUNK_SIZE * MAX_RECORDING_CHANNELS;
        const legacyMonoPoolSamples = RECORDING_CHUNK_SIZE;
        if (
            isNewSequence && validFrames === RECORDING_CHUNK_SIZE &&
            (samples.length === expectedPoolSamples || (channelCount === 1 && samples.length === legacyMonoPoolSamples)) &&
            !this.isFinalizingRecording &&
            message.chunkIndex >= 0 && message.chunkIndex < RECORDING_CHUNK_POOL_SIZE
        ) {
            const replacement = new Float32Array(samples.length);
            this.recycleChunkMessage.chunkIndex = message.chunkIndex;
            this.recycleChunkMessage.samples = replacement;
            this.recycleChunkTransferList[0] = replacement.buffer;
            workletNode.port.postMessage(this.recycleChunkMessage, this.recycleChunkTransferList);
        }
        this.finishRecordingWhenReady(workletNode);
    }

    private finishRecordingWhenReady(workletNode: AudioWorkletNode) {
        const complete = this.pendingRecordingComplete;
        if (!complete || this.workletNode !== workletNode) return;

        const expectedChunks = Number.isFinite(complete.chunksSent)
            ? Math.max(0, Math.floor(complete.chunksSent))
            : this.recordingReceivedChunkMessages;
        if (this.recordingReceivedChunkMessages < expectedChunks) return;

        this.pendingRecordingComplete = null;
        this.finishRecording(workletNode, complete);
    }

    private finishRecording(
        workletNode: AudioWorkletNode,
        message: Extract<RecordingWorkletMessage, { type: 'RECORD_COMPLETE' }>,
    ) {
        const channelCount: 1 | 2 = this.recordingChunkCount > 0 ? this.recordingChannelCount : (message.channelCount === 2 ? 2 : 1);
        const reportedFrames = Number.isFinite(message.framesCaptured) ? Math.max(0, Math.floor(message.framesCaptured)) : this.recordingStoredFrames;
        const missingFrames = Math.max(0, reportedFrames - this.recordingStoredFrames);
        const reportedMaximumFrames = Number.isFinite(message.maxRecordingFrames)
            ? Math.max(0, Math.floor(message.maxRecordingFrames))
            : Math.floor(MAX_RECORDING_CAPTURE_SAMPLES / channelCount);
        this.recordingMaximumFrames = reportedMaximumFrames;
        this.recordingMaximumDurationSeconds = reportedMaximumFrames / this.engine.context.sampleRate;
        this.recordingFramesCaptured = this.recordingStoredFrames;
        this.recordingDroppedFrames += Math.max(0, Number.isFinite(message.droppedFrames) ? message.droppedFrames : 0) + missingFrames;
        this.recordingOverflowEvents += Math.max(0, Number.isFinite(message.overflowEvents) ? message.overflowEvents : 0);
        this.recordingLimitReached = message.limitReached === true;
        if (missingFrames > 0) this.recordingOverflowEvents += 1;
        if (this.recordingLimitReached) {
            this.recordingDiagnostic = `Recording capacity reached (${Math.ceil(this.recordingMaximumDurationSeconds / 60)} min); ${this.recordingDroppedFrames} frames were dropped.`;
        } else if (this.recordingDroppedFrames > 0) {
            this.recordingDiagnostic = `Audio capture overflow dropped ${this.recordingDroppedFrames} frames.`;
        } else this.recordingDiagnostic = null;

        if (this.recordingStoredFrames > 0) {
            const rawBuffer = new Float32Array(this.recordingStoredFrames * channelCount);
            let writeOffset = 0;
            for (let sequence = 0; sequence < MAX_RECORDING_CHUNKS; sequence += 1) {
                if (this.receivedChunkFlags[sequence] === 0) continue;
                const chunk = this.recordedChunks[sequence];
                const frames = this.recordedChunkLengths[sequence];
                if (!chunk || frames === undefined || frames === 0) continue;
                const sampleCount = Math.min(chunk.length, frames * channelCount);
                rawBuffer.set(chunk.subarray(0, sampleCount), writeOffset);
                writeOffset += sampleCount;
            }
            const validSamples = Math.floor(writeOffset / channelCount) * channelCount;
            const assembledBuffer = validSamples === rawBuffer.length ? rawBuffer : rawBuffer.subarray(0, validSamples);
            this.clearRecordingChunkStorage();
            this.processRecordedBuffer(assembledBuffer, channelCount);
        } else {
            this.state = this.resumeAfterRecording ? TrackState.EMPTY : TrackState.STOPPED;
            this.resumeAfterRecording = true;
            this.syncTransportState();
        }
        workletNode.port.onmessage = null;
        workletNode.disconnect();
        if (this.workletNode === workletNode) this.workletNode = null;
        this.clearRecordingChunkStorage();
        this.isFinalizingRecording = false;
    }

    private clearRecordingChunkStorage() {
        for (let index = 0; index < MAX_RECORDING_CHUNKS; index += 1) {
            this.recordedChunks[index] = null;
        }
        this.recordedChunkLengths.fill(0);
        this.receivedChunkFlags.fill(0);
        this.recordingChunkCount = 0;
        this.recordingReceivedChunkMessages = 0;
        this.recordingStoredFrames = 0;
        this.recordingChannelCount = 1;
        this.pendingRecordingComplete = null;
    }

    private processRecordedBuffer(rawBuffer: Float32Array, channelCount: 1 | 2 = 1) {
        const ctx = this.engine.context;
        const channels: 1 | 2 = channelCount === 2 ? 2 : 1;
        const rawFrames = Math.floor(rawBuffer.length / channels);
        if (rawFrames <= 0) {
            this.state = this.resumeAfterRecording ? TrackState.EMPTY : TrackState.STOPPED;
            this.resumeAfterRecording = true;
            this.syncTransportState();
            return;
        }
        const browserOffset = this.getBrowserRecordingOffsetConfig();
        const latencySamples = Math.round(this.engine.roundTripLatency * ctx.sampleRate);
        let startOffset = Math.max(0, latencySamples);
        if (startOffset >= rawFrames) startOffset = 0;
        const lengthSamples = rawFrames - startOffset;
        const durationSeconds = lengthSamples / ctx.sampleRate;
        console.log(`Track ${this.track.id} recorded: ${durationSeconds.toFixed(2)}s (${lengthSamples} frames, ${channels}ch)`);
        let finalBufferLength = lengthSamples;
        if (!this.transport.hasMasterTrack()) {
            console.log(`\n🎯 Track ${this.track.id} is becoming the MASTER track`);
            this.transport.setMasterTrack(this.track.id, durationSeconds, ctx.sampleRate, lengthSamples);
            this.transport.start();
            console.log(`✓ Global transport started with calculated BPM\n`);
        } else {
            const masterLength = this.transport.masterLoopLengthSamples;
            if (masterLength > 0 && Number.isFinite(masterLength)) {
                let ratio = Math.round(lengthSamples / masterLength);
                if (ratio < 1) ratio = 1;
                finalBufferLength = ratio * masterLength;
                console.log(`Track ${this.track.id} recorded as SLAVE track (Master: Track ${this.transport.masterTrackId})`);
                console.log(`Drift Fix: Resized track from ${lengthSamples} to ${finalBufferLength} (Exact multiple: ${ratio})`);
            }
        }
        this.audioBuffer = ctx.createBuffer(channels, finalBufferLength, ctx.sampleRate);
        let shift = lengthSamples > 0 ? Math.trunc(browserOffset.recordingOffsetSamples) % lengthSamples : 0;
        if (shift < 0) shift += lengthSamples;
        const copyFrames = Math.min(lengthSamples, finalBufferLength);
        for (let channel = 0; channel < channels; channel += 1) {
            const output = this.audioBuffer.getChannelData(channel);
            for (let frame = 0; frame < copyFrames; frame += 1) {
                const sourceFrame = startOffset + ((frame + shift) % lengthSamples);
                output[frame] = rawBuffer[(sourceFrame * channels) + channel] ?? 0;
            }
        }
        if (this.resumeAfterRecording) {
            this.state = TrackState.PLAYING;
            this.play();
        } else {
            this.state = TrackState.STOPPED;
            this.syncTransportState();
        }
        this.resumeAfterRecording = true;
    }

    private async ensureLivePolyPitchNode(): Promise<LivePolyPitchNode> {
        if (this.livePolyPitchNode) return this.livePolyPitchNode;
        if (this.livePolyPitchNodePromise) return this.livePolyPitchNodePromise;

        const generation = this.livePolyPitchGeneration;
        const channelCount = this.audioBuffer?.numberOfChannels ?? 1;
        if (channelCount < 1 || channelCount > 2) {
            throw new RangeError('Signalsmith supports one or two track-buffer channels');
        }

        const initialization = createLivePolyPitchNode(this.engine.context, {
            mode: 'LIVE_POLY',
            channels: channelCount as 1 | 2,
            semitones: this.livePolyPitchSemitones,
            playbackRate: this.livePolyPitchPlaybackRate,
            tonalityLimitHz: this.livePolyPitchTonalityLimitHz,
        }).then(async (node) => {
            if (generation !== this.livePolyPitchGeneration || !this.livePolyPitchEnabledInternal) {
                try { await node.stopProcessing(this.engine.context.currentTime); } catch { /* stale node */ }
                try { await node.clearBuffers(); } catch { /* stale node */ }
                node.disconnect();
                node.port.close();
                throw new Error('Live pitch setup was canceled');
            }
            this.livePolyPitchNode = node;
            this.livePolyPitchLatencySamplesValue = node.latencySamples;
            return node;
        });
        this.livePolyPitchNodePromise = initialization;
        try {
            return await initialization;
        } finally {
            if (this.livePolyPitchNodePromise === initialization) this.livePolyPitchNodePromise = null;
        }
    }

    private async ensureLiveMonoPitchNode(): Promise<LiveMonoPitchNode> {
        if (this.liveMonoPitchNode) return this.liveMonoPitchNode;
        if (this.liveMonoPitchNodePromise) return this.liveMonoPitchNodePromise;

        const generation = this.liveMonoPitchGeneration;
        const initialization = createLiveMonoPitchNode(this.engine.context, {
            semitones: this.liveMonoPitchSemitones,
            minimumFrequencyHz: this.liveMonoPitchMinimumFrequencyHz,
            maximumFrequencyHz: this.liveMonoPitchMaximumFrequencyHz,
            outputChannels: 2,
        }).then(async (node) => {
            try {
                await node.ready;
            } catch (error) {
                node.disconnect();
                node.port.close();
                throw error;
            }
            if (generation !== this.liveMonoPitchGeneration || !this.liveMonoPitchEnabledInternal) {
                node.disconnect();
                node.port.close();
                throw new Error('LIVE_MONO setup was canceled');
            }
            this.liveMonoPitchNode = node;
            this.liveMonoPitchLatencySamplesValue = node.latencySamples;
            return node;
        });
        this.liveMonoPitchNodePromise = initialization;
        try {
            return await initialization;
        } finally {
            if (this.liveMonoPitchNodePromise === initialization) this.liveMonoPitchNodePromise = null;
        }
    }

    private startBufferSourcePlayback() {
        if (!this.audioBuffer) return;
        if (this.hasConfiguredLoopTransportFx() && !this.getLoopTransportConflictReason()) {
            if (this.startLoopTransportBufferPlayback()) return;
            this.loopTransportRuntimeFallbackReason = 'Source-aware reader creation failed; ordinary BufferSource playback is used';
        }
        const context = this.engine.context;
        this.sourceNode = context.createBufferSource();
        this.sourceNode.buffer = this.audioBuffer;
        this.sourceNode.loop = true;
        this.sourceGainNode = null;
        if (this.isReverse) {
            this.sourceNode.connect(this.fxChain.input);
        } else {
            // A unity per-source gain makes the normal forward BufferSource
            // path crossfadeable if a read-head effect is selected mid-loop.
            // It is a no-copy, zero-added-latency identity node by default.
            this.sourceGainNode = context.createGain();
            this.sourceGainNode.gain.value = 1;
            this.sourceNode.connect(this.sourceGainNode);
            this.sourceGainNode.connect(this.fxChain.input);
        }
        this.sourceNode.playbackRate.value = this.isReverse ? -1 : 1;
        this.sourceNode.start(0, this.startOffset);
        this.startTime = context.currentTime;
        this.loopTransportPlaybackInitialized = false;
        this.loopTransportTransitionActive = false;
        this.loopTransportPendingRetarget = false;
        if (!this.hasConfiguredLoopTransportFx()) this.loopTransportStartOffsetShiftSeconds = 0;
        this.state = TrackState.PLAYING;
        this.ensureTransportRunning();
    }

    private startLoopTransportBufferPlayback(): boolean {
        if (!this.audioBuffer) return false;
        const context = this.engine.context;
        const now = context.currentTime;
        const beatShiftSeconds = this.getLoopTransportBeatShiftSeconds();
        const baseOffset = this.startOffset - this.loopTransportStartOffsetShiftSeconds;

        this.loopTransportPhaseBaseSeconds = baseOffset;
        this.loopTransportPhaseTime = now;
        this.loopTransportPlaybackInitialized = true;
        this.loopTransportRenderedBeatShiftSeconds = beatShiftSeconds;
        this.loopTransportTransitionActive = false;
        this.loopTransportPendingRetarget = false;
        this.resetLoopMotorStates();
        const initial = this.createSourceAwareBufferSource(baseOffset + beatShiftSeconds, now, 1);
        if (!initial) {
            this.loopTransportPlaybackInitialized = false;
            return false;
        }
        this.sourceNode = initial.source;
        this.sourceGainNode = initial.gain;
        this.loopTransportStartOffsetShiftSeconds = 0;
        this.startTime = now;
        this.state = TrackState.PLAYING;
        this.ensureTransportRunning();
        this.loopTransportRuntimeFallbackReason = null;
        return true;
    }

    private async startLivePolyPitchPlayback(buffer: AudioBuffer, revision: number) {
        const node = await this.ensureLivePolyPitchNode();
        if (revision !== this.playbackRevision || !this.livePolyPitchEnabledInternal || this.isReverse) return;

        if (buffer.duration <= node.latencySeconds) {
            this.livePolyPitchFallbackReasonValue = 'Loop is no longer than the measured Signalsmith algorithmic latency';
            return;
        }

        await this.livePolyPitchBufferReset.catch(() => undefined);
        if (revision !== this.playbackRevision || !this.livePolyPitchEnabledInternal || this.isReverse) return;

        const channels = Array.from(
            { length: Math.min(buffer.numberOfChannels, 2) },
            (_, index) => buffer.getChannelData(index),
        );
        await node.loadBuffer(channels);
        if (revision !== this.playbackRevision || !this.livePolyPitchEnabledInternal || this.isReverse) {
            this.livePolyPitchBufferReset = node.clearBuffers().catch(() => undefined);
            return;
        }

        node.connect(this.fxChain.input);
        try {
            await node.scheduleLoop({
                inputOffsetSeconds: Math.max(0, Math.min(this.startOffset, Math.max(0, buffer.duration - 1 / buffer.sampleRate))),
                loopStartSeconds: 0,
                loopEndSeconds: buffer.duration,
                semitones: this.livePolyPitchSemitones,
                playbackRate: this.livePolyPitchPlaybackRate,
                tonalityLimitHz: this.livePolyPitchTonalityLimitHz,
            });
        } catch (error) {
            node.disconnect();
            this.livePolyPitchBufferReset = node.clearBuffers().catch(() => undefined);
            throw error;
        }

        if (revision !== this.playbackRevision || !this.livePolyPitchEnabledInternal || this.isReverse) {
            node.disconnect();
            this.livePolyPitchBufferReset = node.clearBuffers().catch(() => undefined);
            return;
        }

        this.livePolyPitchActiveInternal = true;
        this.livePolyPitchFallbackReasonValue = null;
        this.startTime = this.engine.context.currentTime;
        this.state = TrackState.PLAYING;
        this.ensureTransportRunning();
    }

    private async startLiveMonoPitchPlayback(buffer: AudioBuffer, revision: number): Promise<boolean> {
        const node = await this.ensureLiveMonoPitchNode();
        if (revision !== this.playbackRevision || !this.liveMonoPitchEnabledInternal || this.isReverse) return false;

        if (buffer.duration <= node.latencySeconds) {
            this.liveMonoPitchFallbackReasonValue = 'Loop is no longer than the measured LIVE_MONO algorithmic latency';
            return false;
        }

        node.setPitch(this.liveMonoPitchSemitones);
        const source = this.engine.context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.playbackRate.value = 1;
        source.connect(node);
        node.connect(this.fxChain.input);
        try {
            source.start(0, Math.max(0, Math.min(this.startOffset, Math.max(0, buffer.duration - 1 / buffer.sampleRate))));
        } catch (error) {
            source.disconnect();
            node.disconnect();
            throw error;
        }

        this.sourceNode = source;
        this.liveMonoPitchActiveInternal = true;
        this.liveMonoPitchFallbackReasonValue = null;
        this.startTime = this.engine.context.currentTime;
        this.state = TrackState.PLAYING;
        this.ensureTransportRunning();
        return true;
    }

    private getCurrentPlaybackPosition(): number {
        const duration = this.audioBuffer?.duration ?? 0;
        if (duration <= 0) return 0;
        if (this.loopTransportPlaybackInitialized && !this.isReverse) {
            return this.getLoopTransportOutputPosition();
        }
        const elapsed = Math.max(0, this.engine.context.currentTime - this.startTime);
        const rate = this.livePolyPitchActiveInternal ? this.livePolyPitchPlaybackRate : 1;
        const raw = this.isReverse
            ? this.startOffset - elapsed
            : this.startOffset + elapsed * rate;
        return ((raw % duration) + duration) % duration;
    }

    /** Position still rendered by the active read-head, even after a mode flag is changed before teardown. */
    private getLoopTransportOutputPosition(): number {
        const duration = this.audioBuffer?.duration ?? 0;
        if (duration <= 0) return 0;
        this.advanceLoopTransportTo(this.engine.context.currentTime);
        return wrapLoopPhase(this.loopTransportPhaseBaseSeconds + this.loopTransportRenderedBeatShiftSeconds, duration);
    }

    private releaseLivePolyPitchNodeForReuse() {
        const node = this.livePolyPitchNode;
        this.livePolyPitchActiveInternal = false;
        if (!node) return;
        try { void node.stopProcessing(this.engine.context.currentTime).catch(() => undefined); } catch { /* node may already be closed */ }
        node.disconnect();
        this.livePolyPitchBufferReset = node.clearBuffers().catch(() => undefined);
    }

    private releaseLiveMonoPitchNodeForReuse() {
        this.liveMonoPitchActiveInternal = false;
        this.liveMonoPitchNode?.disconnect();
    }

    private async disposeLivePolyPitchNode() {
        this.livePolyPitchGeneration += 1;
        const pending = this.livePolyPitchNodePromise;
        const node = this.livePolyPitchNode;
        this.livePolyPitchNodePromise = null;
        this.livePolyPitchNode = null;
        this.livePolyPitchActiveInternal = false;
        if (pending) {
            try { await pending; } catch { /* canceled initialization is expected */ }
        }
        // The pending creation is generation-canceled and owns its own cleanup. Only
        // dispose the node captured at entry; a rapid re-enable may create a new node
        // while this cleanup awaits Worklet acknowledgements.
        if (!node) return;
        if (this.livePolyPitchNode === node) this.livePolyPitchNode = null;
        try { await node.stopProcessing(this.engine.context.currentTime); } catch { /* node may already be stopped */ }
        node.disconnect();
        try { await node.clearBuffers(); } catch { /* node is being disposed */ }
        node.port.close();
    }

    private async disposeLiveMonoPitchNode() {
        this.liveMonoPitchGeneration += 1;
        const pending = this.liveMonoPitchNodePromise;
        const node = this.liveMonoPitchNode;
        this.liveMonoPitchNodePromise = null;
        this.liveMonoPitchNode = null;
        this.liveMonoPitchActiveInternal = false;
        if (pending) {
            try { await pending; } catch { /* canceled initialization is expected */ }
        }
        if (!node) return;
        if (this.liveMonoPitchNode === node) this.liveMonoPitchNode = null;
        node.disconnect();
        node.port.close();
    }

    public async play() {
        if (!this.audioBuffer) return;

        this.stop();

        const revision = this.playbackRevision;
        const buffer = this.audioBuffer;
        if (this.liveMonoPitchEnabledInternal && !this.isReverse && buffer.numberOfChannels <= 2) {
            try {
                if (await this.startLiveMonoPitchPlayback(buffer, revision)) return;
                if (revision !== this.playbackRevision) return;
            } catch (error) {
                if (revision !== this.playbackRevision) return;
                this.liveMonoPitchFallbackReasonValue = error instanceof Error ? error.message : 'LIVE_MONO initialization failed';
                this.releaseLiveMonoPitchNodeForReuse();
            }
        } else if (this.liveMonoPitchEnabledInternal && buffer.numberOfChannels > 2) {
            this.liveMonoPitchFallbackReasonValue = 'LIVE_MONO accepts at most two input channels';
        } else if (this.liveMonoPitchEnabledInternal && this.isReverse) {
            this.liveMonoPitchFallbackReasonValue = 'Reverse playback uses the legacy BufferSource route';
        }

        if (this.livePolyPitchEnabledInternal && !this.isReverse && buffer.numberOfChannels <= 2) {
            try {
                await this.startLivePolyPitchPlayback(buffer, revision);
                if (revision === this.playbackRevision && this.livePolyPitchActiveInternal) return;
                // A concurrent stop/reverse/reset owns the newer route now.
                if (revision !== this.playbackRevision) return;
            } catch (error) {
                if (revision !== this.playbackRevision) return;
                this.livePolyPitchFallbackReasonValue = error instanceof Error ? error.message : 'Signalsmith initialization failed';
                this.releaseLivePolyPitchNodeForReuse();
            }
        } else if (this.livePolyPitchEnabledInternal && buffer.numberOfChannels > 2) {
            this.livePolyPitchFallbackReasonValue = 'Signalsmith supports at most two channels';
        } else if (this.livePolyPitchEnabledInternal && this.isReverse) {
            this.livePolyPitchFallbackReasonValue = 'Reverse playback uses the legacy BufferSource route';
        }

        if (revision === this.playbackRevision) this.startBufferSourcePlayback();
    }

    public stop() {
        if (this.loopTransportPlaybackInitialized && this.sourceNode && this.audioBuffer
            && (this.state === TrackState.PLAYING || this.state === TrackState.OVERDUBBING)) {
            this.startOffset = this.getLoopTransportOutputPosition();
            this.loopTransportStartOffsetShiftSeconds = this.loopTransportRenderedBeatShiftSeconds;
        }
        this.playbackRevision += 1;
        this.stopAndDisconnectBufferSource(this.sourceNode, this.sourceGainNode);
        this.stopAndDisconnectBufferSource(this.retiringSourceNode, this.retiringSourceGainNode);
        this.sourceNode = null;
        this.sourceGainNode = null;
        this.retiringSourceNode = null;
        this.retiringSourceGainNode = null;
        this.loopTransportPlaybackInitialized = false;
        this.loopTransportTransitionActive = false;
        this.loopTransportPendingRetarget = false;
        this.releaseLivePolyPitchNodeForReuse();
        this.releaseLiveMonoPitchNodeForReuse();
        this.state = TrackState.STOPPED;
    }

    public clear() {
        this.cancelQuantizeWait();
        this.abortRecording();
        this.stopOverdub();
        this.stop();
        this.livePolyPitchEnabledInternal = false;
        this.liveMonoPitchEnabledInternal = false;
        this.livePolyPitchFallbackReasonValue = null;
        this.liveMonoPitchFallbackReasonValue = null;
        void this.disposeLivePolyPitchNode();
        void this.disposeLiveMonoPitchNode();
        this.audioBuffer = null;
        this.state = TrackState.EMPTY;
        this.isReverse = false;

        // Reset shared state
        if (this.sharedStates) {
            Atomics.store(this.sharedStates, this.trackIndex, Object.values(TrackState).indexOf(TrackState.EMPTY));
        }
        if (this.sharedPositions) {
            this.sharedPositions[this.trackIndex] = 0;
        }

        // Check master track reset
        this.engine.checkAndResetMaster(this.track.id);

        this.startOffset = 0;
        this.startTime = 0;
        this.loopTransportStartOffsetShiftSeconds = 0;

        console.log(`Track ${this.track.id} cleared`);
        this.syncTransportState();
    }

    public toggleReverse() {
        const wasPlaying = this.state === TrackState.PLAYING && !!this.audioBuffer;
        if (wasPlaying) {
            this.startOffset = this.getCurrentPlaybackPosition();
            this.loopTransportStartOffsetShiftSeconds = this.loopTransportPlaybackInitialized && !this.loopTransportUnavailableReason
                ? this.getLoopTransportBeatShiftSeconds()
                : 0;
        }
        this.isReverse = !this.isReverse;
        console.log(`Track ${this.track.id} reverse: ${this.isReverse}`);

        // Neither pitch worklet supports reversed streaming yet. Use the legacy
        // BufferSource path and retain the best estimated playback offset.
        if (wasPlaying) void this.play();
    }


    // ========================================
    // OVERDUB LOGIC (sample-aware AudioWorklet)
    // ========================================

    private async startOverdub() {
        const audioBuffer = this.audioBuffer;
        if (!audioBuffer) return;
        if (this.overdubProcessor) {
            if (this.overdubStopping) this.overdubRestartAfterStop = true;
            return;
        }

        const generation = ++this.overdubStartGeneration;
        const ctx = this.engine.context;
        let createdWorklet: AudioWorkletNode | null = null;
        let createdMuteGain: GainNode | null = null;

        try {
            const input = await this.engine.getProcessedInputNode();
            if (generation !== this.overdubStartGeneration || this.state !== TrackState.OVERDUBBING || this.audioBuffer !== audioBuffer) return;

            const moduleEngine = this.engine as IAudioEngine & { ensureTrackIoWorkletModule?: () => Promise<void> };
            if (moduleEngine.ensureTrackIoWorkletModule) {
                await moduleEngine.ensureTrackIoWorkletModule();
            } else if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
                await ctx.audioWorklet.addModule('/worklets/browser-track-io.js');
            } else {
                throw new Error('AudioWorklet is unavailable in this browser context');
            }
            if (generation !== this.overdubStartGeneration || this.state !== TrackState.OVERDUBBING || this.audioBuffer !== audioBuffer) return;
            if (typeof AudioWorkletNode === 'undefined') {
                throw new Error('AudioWorkletNode is unavailable in this browser context');
            }

            if (audioBuffer.numberOfChannels < 1 || audioBuffer.numberOfChannels > 2) {
                throw new Error('Browser overdub supports one or two track-buffer channels');
            }
            const channelCount: 1 | 2 = audioBuffer.numberOfChannels === 2 ? 2 : 1;
            const loopSamples = new Float32Array(audioBuffer.length * channelCount);
            for (let channel = 0; channel < channelCount; channel += 1) {
                const source = audioBuffer.getChannelData(channel);
                for (let frame = 0; frame < audioBuffer.length; frame += 1) loopSamples[(frame * channelCount) + channel] = source[frame] ?? 0;
            }
            if (audioBuffer.length === 0) throw new Error('The loop has no audio samples to overdub');

            const patchBuffers = Array.from({ length: OVERDUB_TRANSFER_BUFFER_POOL_SIZE }, (_, slotIndex) => ({
                slotIndex,
                indices: new Uint32Array(OVERDUB_TRANSFER_BUFFER_FRAMES),
                values: new Float32Array(OVERDUB_TRANSFER_BUFFER_FRAMES * channelCount),
            }));
            const transferList: Transferable[] = [loopSamples.buffer];
            for (const buffer of patchBuffers) {
                transferList.push(buffer.indices.buffer, buffer.values.buffer);
            }

            const workletNode = new AudioWorkletNode(ctx, 'rc505-overdub-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [channelCount],
                channelCount,
                channelCountMode: 'explicit',
                processorOptions: {
                    transferBufferFrames: OVERDUB_TRANSFER_BUFFER_FRAMES,
                    transferBufferPoolSize: OVERDUB_TRANSFER_BUFFER_POOL_SIZE,
                },
            });
            createdWorklet = workletNode;
            const muteGain = ctx.createGain();
            createdMuteGain = muteGain;
            muteGain.gain.value = 0;

            this.overdubProcessor = workletNode;
            this.overdubMuteGainNode = muteGain;
            this.overdubSessionAudioBuffer = audioBuffer;
            this.overdubNextPatchSequence = 0;
            this.overdubStopping = false;
            this.overdubDiagnostic = null;

            workletNode.port.onmessage = (event: MessageEvent) => {
                this.handleOverdubMessage(workletNode, audioBuffer, event.data);
            };
            workletNode.onprocessorerror = () => {
                if (this.overdubProcessor !== workletNode) return;
                this.overdubDiagnostic = 'Overdub AudioWorklet stopped unexpectedly; track playback remains audible.';
                if (this.state === TrackState.OVERDUBBING) this.state = TrackState.PLAYING;
                this.finishOverdubNode(workletNode);
                this.syncTransportState();
            };
            workletNode.port.postMessage({
                type: 'OVERDUB_INIT',
                samples: loopSamples,
                channelCount,
                buffers: patchBuffers,
                startFrame: Math.floor(this.startTime * ctx.sampleRate),
                startOffsetSamples: Math.floor(this.startOffset * ctx.sampleRate),
                latencySamples: Math.floor(this.engine.roundTripLatency * ctx.sampleRate),
                recordingOffsetSamples: this.getBrowserRecordingOffsetConfig().recordingOffsetSamples,
                reverse: this.isReverse,
            }, transferList);

            // Preserve the old muted-sink routing. The existing buffer source stays
            // audible while real-time overdub DSP and loop readback remain in the worklet.
            input.connect(workletNode);
            workletNode.connect(muteGain);
            muteGain.connect(ctx.destination);
        } catch (error) {
            if (generation !== this.overdubStartGeneration) return;
            if (createdWorklet) {
                if (this.overdubProcessor === createdWorklet) {
                    this.finishOverdubNode(createdWorklet);
                } else {
                    createdWorklet.port.onmessage = null;
                    createdWorklet.onprocessorerror = null;
                    createdWorklet.disconnect();
                    createdMuteGain?.disconnect();
                }
            } else {
                createdMuteGain?.disconnect();
            }
            this.overdubDiagnostic = `Overdub is unavailable: ${error instanceof Error ? error.message : String(error)}. Track playback remains audible.`;
            if (this.state === TrackState.OVERDUBBING) this.state = TrackState.PLAYING;
            this.syncTransportState();
        }
    }

    private handleOverdubMessage(workletNode: AudioWorkletNode, audioBuffer: AudioBuffer, message: unknown) {
        if (!message || typeof message !== 'object' || this.overdubProcessor !== workletNode) return;
        const payload = message as {
            type?: string;
            sequence?: number;
            slotIndex?: number;
            validFrames?: number;
            indices?: Uint32Array;
            values?: Float32Array;
            channelCount?: number;
            overflowFrames?: number;
            overflowEvents?: number;
            message?: string;
        };

        if (payload.type === 'OVERDUB_PATCH') {
            const indices = payload.indices;
            const values = payload.values;
            const patchChannelCount: 1 | 2 = payload.channelCount === 2 ? 2 : 1;
            const validFrames = Number.isFinite(payload.validFrames)
                ? Math.max(0, Math.min(Math.floor(payload.validFrames as number), indices?.length ?? 0, Math.floor((values?.length ?? 0) / patchChannelCount)))
                : 0;
            if (
                this.overdubSessionAudioBuffer === audioBuffer && this.audioBuffer === audioBuffer &&
                indices instanceof Uint32Array && values instanceof Float32Array
            ) {
                if (payload.sequence !== this.overdubNextPatchSequence) {
                    this.overdubDiagnostic = 'Overdub patch messages arrived out of sample order; a patch was skipped.';
                } else if (patchChannelCount !== audioBuffer.numberOfChannels) {
                    this.overdubDiagnostic = `Overdub patch channel mismatch: expected ${audioBuffer.numberOfChannels}, received ${patchChannelCount}.`;
                } else {
                    const trackBuffers = Array.from({ length: patchChannelCount }, (_, channel) => audioBuffer.getChannelData(channel));
                    for (let frame = 0; frame < validFrames; frame += 1) {
                        const index = indices[frame] ?? audioBuffer.length;
                        if (index >= audioBuffer.length) continue;
                        for (let channel = 0; channel < patchChannelCount; channel += 1) {
                            const trackBuffer = trackBuffers[channel]!;
                            const value = values[(frame * patchChannelCount) + channel];
                            trackBuffer[index] = value ?? trackBuffer[index] ?? 0;
                        }
                    }
                    this.overdubNextPatchSequence += 1;
                }
            }

            if (!this.overdubStopping && Number.isInteger(payload.slotIndex) && payload.slotIndex! >= 0) {
                const transferList: Transferable[] = [indices?.buffer, values?.buffer].filter((item): item is ArrayBuffer => item instanceof ArrayBuffer);
                if (indices instanceof Uint32Array && values instanceof Float32Array && transferList.length === 2) {
                    workletNode.port.postMessage({
                        type: 'RECYCLE_OVERDUB_BUFFER',
                        slotIndex: payload.slotIndex,
                        indices,
                        values,
                    }, transferList);
                }
            }
            return;
        }

        if (payload.type === 'OVERDUB_ERROR') {
            this.overdubDiagnostic = `Overdub failed: ${payload.message ?? 'AudioWorklet error'}. Track playback remains audible.`;
            if (this.state === TrackState.OVERDUBBING) this.state = TrackState.PLAYING;
            this.finishOverdubNode(workletNode);
            this.syncTransportState();
            return;
        }

        if (payload.type === 'OVERDUB_STOPPED') {
            if ((payload.overflowFrames ?? 0) > 0) {
                this.overdubDiagnostic = `Overdub AudioWorklet buffer pool overflow dropped ${payload.overflowFrames} input frames across ${payload.overflowEvents ?? 0} bursts.`;
            }
            this.finishOverdubNode(workletNode, true);
        }
    }

    private finishOverdubNode(workletNode: AudioWorkletNode, allowRestart = false) {
        const restart = allowRestart && this.overdubRestartAfterStop && this.state === TrackState.OVERDUBBING;
        this.overdubRestartAfterStop = false;
        workletNode.port.onmessage = null;
        workletNode.onprocessorerror = null;
        workletNode.disconnect();
        if (this.overdubMuteGainNode) {
            this.overdubMuteGainNode.disconnect();
            this.overdubMuteGainNode = null;
        }
        if (this.overdubProcessor === workletNode) this.overdubProcessor = null;
        this.overdubSessionAudioBuffer = null;
        this.overdubStopping = false;
        if (restart) void this.startOverdub();
    }

    private stopOverdub() {
        this.overdubStartGeneration += 1;
        const workletNode = this.overdubProcessor;
        if (!workletNode || this.overdubStopping) return;

        this.overdubStopping = true;
        try {
            workletNode.port.postMessage({ type: 'OVERDUB_STOP' });
        } catch (error) {
            this.overdubDiagnostic = `Overdub stopped with an AudioWorklet error: ${error instanceof Error ? error.message : String(error)}.`;
            this.finishOverdubNode(workletNode);
        }
    }

    private abortRecording() {
        this.isRecording = false;
        this.isFinalizingRecording = false;
        this.resumeAfterRecording = false;
        this.recordingFramesCaptured = 0;
        this.recordingDroppedFrames = 0;
        this.recordingOverflowEvents = 0;
        this.recordingMaximumFrames = 0;
        this.recordingMaximumDurationSeconds = 0;
        this.recordingLimitReached = false;
        this.recordingDiagnostic = null;
        this.clearRecordingChunkStorage();

        if (this.workletNode) {
            this.workletNode.port.onmessage = null;
            this.workletNode.disconnect();
            this.workletNode = null;
        }
    }

    private cancelQuantizeWait() {
        this.waitingForQuantize = false;
        this.waitingForQuantizeStop = false;

        if (this.quantizeStartListener) {
            this.transport.off('measure', this.quantizeStartListener);
            this.quantizeStartListener = null;
        }

        if (this.quantizeStopListener) {
            this.transport.off('measure', this.quantizeStopListener);
            this.quantizeStopListener = null;
        }
    }
}
