import { browserAutoRecThreshold } from './BrowserAutoRecSettings';
import type { IAudioEngine, InputCaptureSession } from './AudioEngineInterface';
import {
    getBrowserRecordingOffsetConfig,
} from './browserRecordingOffset';
import { FXChain } from './FXChain';
import { createLiveMonoPitchNode, createLivePolyPitchNode, type LiveMonoPitchNode, type LivePolyPitchNode } from './pitch';
import { createHqWavExport, type HqWavExportRequestOptions, type HqWavExportResult } from './export/hqWavExport';
import { Track, TrackState, TransportState } from '../core/types';
import { Transport } from '../core/Transport';
import { audioBufferPcmBytes, getBrowserPcmHistoryBudget, PcmHistoryBudget } from './PcmHistoryBudget';
import type { BrowserRecoveryTrack } from './BrowserRecoverySnapshot';
import type { TrackMarkActionResult, TrackMarkState } from './TrackMark';

const RECORDING_CHUNK_SIZE = 16_384;
const RECORDING_CHUNK_POOL_SIZE = 3;
// Bound shared-capture stop finalization so a suspended or failed context
// cannot leave the track permanently busy; timeout discards the incomplete
// take and preserves incumbent PCM/history.
const RECORDING_CAPTURE_STOP_ACK_TIMEOUT_MS = 5_000;
const sharedCaptureRetryReasons = new Set([
    'capture-readiness-epoch-changed', 'capture-preroll-not-ready',
    'request-frame-outside-preroll', 'input-frame-discontinuity',
]);
const OVERDUB_TRANSFER_BUFFER_FRAMES = 16_384;
const OVERDUB_TRANSFER_BUFFER_POOL_SIZE = 3;
// Reduce MessagePort traffic without allowing the live AudioBuffer update to
// lag by the full 16,384-frame startup-capacity buffer (372 ms at 44.1 kHz).
// At 44.1 kHz this bounds the normal flush interval to ~11.6 ms; STOP flushes
// the exact partial tail immediately at its requested sample boundary.
const OVERDUB_PATCH_FLUSH_FRAMES = 512;
const OVERDUB_STARTUP_BACKFILL_FRAMES = 8_192;
const OVERDUB_STARTUP_CAPTURE_TIMEOUT_MS = 1_000;
// Retain enough exact write-before values to reverse a bounded number of
// already-applied frames that raced the main-thread STOP request. This is a
// fixed control-thread allocation, not an AudioWorklet allocation.
const OVERDUB_STOP_ROLLBACK_JOURNAL_FRAMES = 8_192;
// A stopped worklet normally publishes its final patch sequence and terminal
// ACK on the next render quantum. Bound the host-side wait so a closed or
// disconnected AudioContext cannot leave the track permanently busy.
const OVERDUB_STOP_ACK_TIMEOUT_MS = 5_000;
// Bound captured Float32 PCM to 384 MiB per track across every recorded channel.
// The limit is per-frame adjusted: mono is about 34.9 minutes at 48 kHz, stereo
// about 17.5 minutes at 48 kHz and 4m22s at 192 kHz. That highest-rate stereo
// maximum is 262.144s; 300s there would need about 439.5 MiB, so this strict
// 384 MiB cap does not promise 300s at 192 kHz. Finalization temporarily keeps
// transferred chunks while assembling contiguous channels, then allocates the playback AudioBuffer: for
// a same-length master, PCM may peak near 3x this cap (1.125 GiB/track), plus
// the fixed 384 KiB worklet pool. Slave-loop sizing can allocate a larger final
// AudioBuffer when it expands a take to an integer master-loop multiple.
const MAX_RECORDING_CAPTURE_BYTES = 384 * 1024 * 1024;
const MAX_RECORDING_CHUNKS = MAX_RECORDING_CAPTURE_BYTES / Float32Array.BYTES_PER_ELEMENT / RECORDING_CHUNK_SIZE;
const MAX_RECORDING_CHANNELS = 2;

export type LoopTransportFxName = 'BEAT SHIFT' | 'VINYL FLICK';

interface OverdubStopRollbackJournal {
    readonly capacity: number;
    readonly inputFrames: Float64Array;
    readonly loopIndices: Uint32Array;
    readonly leftBefore: Float32Array;
    readonly rightBefore: Float32Array | null;
    writeCursor: number;
    retainedFrames: number;
}

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
const LOOP_MOTOR_CURVE_SAMPLES = 1025;
const LOOP_MOTOR_MAX_AUTOMATION_SECONDS = LOOP_MOTOR_MAX_RETURN_SECONDS * 20;
const LOOP_MOTOR_INTEGRATION_STEPS = 32;
const DEFAULT_LOOP_MOTOR_RETURN_SECONDS = 1.5;
const DEFAULT_LOOP_MOTOR_BRAKE_PERCENT = 35;

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
    return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function disconnectAudioNodeIfConnected(node: AudioNode, destination: AudioNode): void {
    try {
        node.disconnect(destination);
    } catch (error) {
        // Web Audio specifies InvalidAccessError when that exact edge is absent.
        // Do not hide TypeErrors or other graph failures; those must remain visible.
        if (error && typeof error === 'object' && 'name' in error
            && (error as { name?: unknown }).name === 'InvalidAccessError') return;
        throw error;
    }
}

function wrapLoopPhase(phaseSeconds: number, durationSeconds: number): number {
    if (!Number.isFinite(phaseSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
    return ((phaseSeconds % durationSeconds) + durationSeconds) % durationSeconds;
}

function loopMotorTargetRate(speed: number): number {
    // Match the Native source stage: mix blends streams and never scales speed.
    return Math.max(0, Math.min(2, 1 + (speed / 100)));
}

/** Exact closed-form position, velocity, and rate integral for one second-order motor interval. */
function evaluateLoopMotor(state: LoopMotorState, seconds: number): { point: LoopMotorPoint; integral: number } {
    const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    if (t === 0) return { point: { rate: state.rate, velocity: state.velocity }, integral: 0 };

    const returnTime = clampFinite(state.returnTimeSeconds, LOOP_MOTOR_MIN_RETURN_SECONDS, LOOP_MOTOR_MAX_RETURN_SECONDS, DEFAULT_LOOP_MOTOR_RETURN_SECONDS);
    const omega = 2 / returnTime;
    const zeta = 0.7 + (1.2 * (clampFinite(state.brakePercent, 0, 100, DEFAULT_LOOP_MOTOR_BRAKE_PERCENT) / 100));
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
        type: 'RECORD_CONFIGURED';
        channelCount: number;
        maxRecordingFrames: number;
        maxRecordingBytes: number;
        requestedStartFrame?: number;
        captureStartFrame?: number;
        sessionId?: number;
        inputGeneration?: number;
        startReceivedFrame?: number;
        requestAgeAtStartFrames?: number;
        preRollCapacityFrames?: number;
        preRollValidFrames?: number;
    }
    | {
        type: 'RECORD_CHUNK';
        chunkIndex: number;
        sequence: number;
        validFrames: number;
        channelCount?: number;
        samples?: Float32Array;
        channels?: Float32Array[];
        startFrame?: number;
        sessionId?: number;
        inputGeneration?: number;
    }
    | {
        type: 'RECORD_COMPLETE';
        framesCaptured: number;
        droppedFrames: number;
        overflowEvents: number;
        maxRecordingFrames: number;
        maxRecordingBytes?: number;
        channelCount?: number;
        limitReached: boolean;
        chunksSent: number;
        status?: 'complete' | 'incomplete';
        requestedStartFrame?: number;
        stopFrame?: number;
        startReceivedFrame?: number;
        requestAgeAtStartFrames?: number;
        preRollCapacityFrames?: number;
        preRollValidFrames?: number;
        timelineOverlapEvents?: number;
        timelineOverlapFrames?: number;
        sessionId?: number;
        inputGeneration?: number;
    }
    | {
        type: 'CAPTURE_ERROR' | 'RECORD_ABORTED';
        sessionId: number;
        inputGeneration: number;
        reason?: string;
        chunksSent?: number;
        requestedStartFrame?: number;
        stopFrame?: number;
        startReceivedFrame?: number;
        requestAgeAtStartFrames?: number;
        oldestAvailableFrame?: number;
        latestAvailableFrame?: number;
        callbackFrameStart?: number;
        callbackFrameCount?: number;
        previousCallbackEndFrame?: number;
        preRollEndAtCallbackStart?: number;
        preRollCapacityFrames?: number;
        preRollValidFrames?: number;
        inputReady?: boolean;
        currentInputGeneration?: number;
        sampleRate?: number;
    };

interface TrackPcmSnapshot {
    buffer: AudioBuffer | null;
    isReverse: boolean;
    master: { bpm: number; measureLength: number; lengthSamples: number } | null;
}

export interface ProjectTrackPcmSnapshot {
    readonly revision: number;
    readonly sampleRate: number;
    readonly frameCount: number;
    readonly channels: 1 | 2;
    /** Read-only views into the completed loop; the archive encoder consumes them synchronously. */
    readonly channelData: readonly Float32Array[];
}

export interface ProjectBufferRestoreResult {
    readonly ok: boolean;
    readonly reason?: string;
}

export class TrackAudio {
    /** Read-only committed phrase existence; first recording is not a phrase yet. */
    public get hasCommittedPhrase(): boolean { return this.audioBuffer !== null; }
    public track: Track;
    public state: TrackState = TrackState.EMPTY;

    private engine: IAudioEngine;
    private transport: Transport;
    private audioBuffer: AudioBuffer | null = null;
    private projectPcmRevision = 0;
    private readonly pcmHistoryBudget: PcmHistoryBudget;
    private readonly markBudgetOwner: object = {};
    private readonly overdubSnapshotBudgetOwner: object = {};
    private pendingOverdubRollbackSnapshot: TrackPcmSnapshot | null = null;
    private overdubBaselineSnapshot: TrackPcmSnapshot | null = null;
    // Only this alternate state is retained. Undo and redo swap ownership with
    // the live AudioBuffer; overdub makes its one copy before the first patch.
    private pcmHistory: { snapshot: TrackPcmSnapshot; direction: 'undo' | 'redo' } | null = null;
    private historyFailureReason: string | null = null;
    private markedPcm: AudioBuffer | null = null;
    private hasCommittedOverdub = false;
    private markOperationBusy = false;
    private markRequestedGeneration = 0;
    private markAppliedGeneration = 0;
    private markFailureReason: string | null = null;
    private pendingClear = false;
    private sourceNode: AudioBufferSourceNode | null = null;
    private sourceGainNode: GainNode | null = null;
    // Vinyl has an independent unity-rate canonical reader and motor-driven wet
    // reader, sharing PCM. The wet mix gain sits after crossfade envelopes so
    // parameter edits cannot cancel a pending source-retarget crossfade.
    private loopTransportDrySourceNode: AudioBufferSourceNode | null = null;
    private loopTransportDryGainNode: GainNode | null = null;
    private loopTransportWetMixGainNode: GainNode | null = null;
    private loopTransportCanonicalPhaseSeconds = 0;
    private retiringSourceNode: AudioBufferSourceNode | null = null;
    private retiringSourceGainNode: GainNode | null = null;
    private readonly loopTransportFxSlots: (LoopTransportFxSlot | null)[] = [null, null, null, null];
    /** Retain the selected source stage while Browser overdub writes canonical loop frames. */
    private loopTransportOverdubSnapshot: (LoopTransportFxSlot | null)[] | null = null;
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
    /** Gate loop-reader audio before the public Track FX/Bounce source tap. */
    private readonly loopReaderGateGain: GainNode;
    private sharedTrackFxWetGain: GainNode | null = null;
    private sharedTrackFxDryGain: GainNode | null = null;
    private sharedTrackFxMeterSplit: ChannelSplitterNode | null = null;
    private sharedTrackFxMeterLeft: AnalyserNode | null = null;
    private sharedTrackFxMeterRight: AnalyserNode | null = null;
    private sharedTrackFxMeterSink: GainNode | null = null;
    private readonly sharedTrackFxMeterSamples = [new Float32Array(256), new Float32Array(256)] as const;
    public fxChain: FXChain;
    /** Playback-only pre-strip bus. Never includes live recording-monitor input. */
    public readonly playbackSourceOutput: GainNode;

    // Recording state
    private isRecording: boolean = false;
    private isFinalizingRecording = false;
    private recordingStarting = false;
    private quantizedRecordingStartFrame: number | null = null;
    private quantizedRecordingPhaseRevision: number | null = null;
    private quantizedRecordingTrackSyncRevision: number | null = null;
    private quantizedRecordingStopFrame: number | null = null;
    private quantizedRecordingStopPhaseRevision: number | null = null;
    private quantizedRecordingStopTrackSyncRevision: number | null = null;
    private readonly masterPhaseChangeListener = () => {
        this.invalidateQuantizedRecordingStopIfStale('The master phase changed before the quantized stop; recording stopped at the current audio frame.');
    };
    private invalidateQuantizedRecordingStopIfStale(message: string): void {
        if (this.quantizedRecordingStopFrame === null) return;
        if (this.quantizedRecordingStopPhaseRevision === this.transport.masterPhaseRevision
            && this.quantizedRecordingStopTrackSyncRevision === this.loopSyncSettingsRevision) return;
        this.quantizedRecordingStopFrame = null;
        this.quantizedRecordingStopPhaseRevision = null;
        this.quantizedRecordingStopTrackSyncRevision = null;
        this.recordingDiagnostic = message;
        void this.stopRecording();
    }
    private loopSyncSettingsRevision = 0;
    private lastLoopSyncSw: Track['loopSyncSw'];
    private recordingStartGeneration = 0;
    private recordingStartRetrySuppressionGeneration = 0;
    private recordingCaptureStartCancelled = false;
    private recordingCaptureStartAcknowledged = false;
    private recordingCaptureStartRetryCount = 0;
    private recordingCaptureStopAckTimeout: ReturnType<typeof setTimeout> | null = null;
    public isReverse: boolean = false;


    private workletNode: AudioWorkletNode | null = null;
    private recordingInputNode: AudioNode | null = null;
    private recordingCaptureSession: InputCaptureSession | null = null;
    private readonly recordedChunks: Array<Float32Array[] | null> = new Array(MAX_RECORDING_CHUNKS).fill(null);
    private readonly recordedChunkLengths = new Uint32Array(MAX_RECORDING_CHUNKS);
    private readonly receivedChunkFlags = new Uint8Array(MAX_RECORDING_CHUNKS);
    private readonly recordingCaptureChunkIndices = new Int8Array(MAX_RECORDING_CHUNKS).fill(-1);
    private recordingChannelCount = 1;
    private recordingChunkCount = 0;
    private recordingReceivedChunkMessages = 0;
    private recordingStoredFrames = 0;
    private pendingRecordingComplete: Extract<RecordingWorkletMessage, { type: 'RECORD_COMPLETE' }> | null = null;
    private readonly recycleChunkMessage = {
        type: 'RECYCLE_CHUNK' as const,
        chunkIndex: 0,
        samples: null as Float32Array | null,
        channels: null as Float32Array[] | null,
    };
    private readonly recycleChunkTransferList: Transferable[] = [new ArrayBuffer(0), new ArrayBuffer(0)];
    public recordingFramesCaptured = 0;
    public recordingDroppedFrames = 0;
    public recordingOverflowEvents = 0;
    public recordingMaximumFrames = 0;
    public recordingMaximumDurationSeconds = 0;
    public recordingLimitReached = false;
    public recordingDiagnostic: string | null = null;
    private overdubProcessor: AudioWorkletNode | null = null;
    private overdubReplace2ReaderMuted = false;
    private overdubInputNode: AudioNode | null = null;
    private overdubBounceSourceMix: { node: GainNode; dispose(): void } | null = null;
    private overdubMuteGainNode: GainNode | null = null;
    private overdubStartGeneration = 0;
    private overdubStopping = false;
    private overdubStarting = false;
    private overdubHasEdited = false;
    private overdubReceivedPatchMessages = 0;
    private overdubExpectedPatchMessages: number | null = null;
    private overdubStopAckTimeout: ReturnType<typeof setTimeout> | null = null;
    private overdubRestartAfterStop = false;
    private overdubSessionAudioBuffer: AudioBuffer | null = null;
    private overdubNextPatchSequence = 0;
    private overdubStopFrameTarget: number | null = null;
    private overdubLastAppliedInputFrameExclusive: number | null = null;
    private overdubLastReceivedPatchEndFrame: number | null = null;
    private overdubAppliedFrameCount = 0;
    private overdubStopRollbackJournal: OverdubStopRollbackJournal | null = null;
    private overdubRollbackAborted = false;
    private overdubRollbackRestored = false;
    private overdubCaptureSession: InputCaptureSession | null = null;
    private overdubCaptureGeneration = 0;
    private overdubCaptureRequestFrame: number | null = null;
    private overdubCaptureFirstInputFrame: number | null = null;
    private overdubCaptureChannelCount = 0;
    private overdubCaptureStopRequested = false;
    private overdubCaptureAwaitingCompletion = false;
    private overdubCaptureAborting = false;
    private overdubCaptureAbortTimeout: ReturnType<typeof setTimeout> | null = null;
    private overdubCapturePendingChunkReturns: Array<{ chunkIndex: number; channels: Float32Array[] }> = [];
    private overdubCaptureBuffers: Float32Array[] | null = null;
    private overdubCaptureFrames = 0;
    private overdubCaptureNextSequence = 0;
    private overdubCaptureTimeout: ReturnType<typeof setTimeout> | null = null;
    /** Readable diagnostic for AudioWorklet-unavailable and bounded-pool overflow cases. */
    public overdubDiagnostic: string | null = null;
    private startTime: number = 0;
    private startOffset: number = 0;
    private resumeAfterRecording = true;

    // Quantize state

    // Shared State
    private trackIndex: number;
    private sharedStates: Int32Array | null;
    private sharedPositions: Float32Array | null;
    private positionUpdaterFrame: number | null = null;
    private disposed = false;

    constructor(engine: IAudioEngine, track: Track, index: number, sharedStates: Int32Array | null, sharedPositions: Float32Array | null, historyBudget = getBrowserPcmHistoryBudget(engine)) {
        this.track = track;
        this.lastLoopSyncSw = track.loopSyncSw;
        this.trackIndex = index;
        this.sharedStates = sharedStates;
        this.sharedPositions = sharedPositions;

        this.engine = engine;
        this.pcmHistoryBudget = historyBudget;
        this.transport = Transport.getInstance();
        this.transport.on('master-phase-change', this.masterPhaseChangeListener);
        const ctx = this.engine.context;

        this.gainNode = ctx.createGain();
        this.panNode = ctx.createStereoPanner();
        this.fxChain = new FXChain(ctx);
        this.playbackSourceOutput = ctx.createGain();
        this.playbackSourceOutput.gain.value = 1;
        this.loopReaderGateGain = ctx.createGain();
        this.loopReaderGateGain.gain.value = 1;
        this.loopReaderGateGain.connect(this.playbackSourceOutput);
        this.playbackSourceOutput.connect(this.fxChain.input);

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

    public get isDisposed(): boolean { return this.disposed; }

    /** Includes worklet startup and final patch/chunk acknowledgement barriers. */
    public get historyBusy(): boolean {
        return this.recordingStarting || this.isRecording || this.isFinalizingRecording
            || this.overdubStarting || this.overdubProcessor !== null || this.pendingClear
            || this.state === TrackState.REC_STANDBY || this.state === TrackState.REC_FINISHING;
    }

    public get canUndo(): boolean { return this.canRestoreHistory('undo'); }
    public get canRedo(): boolean { return this.canRestoreHistory('redo'); }
    public get historyRetainedBytes(): number { return audioBufferPcmBytes(this.pcmHistory?.snapshot.buffer ?? null); }
    public get historyTotalRetainedBytes(): number { return this.pcmHistoryBudget.retainedBytes; }
    public get historyBudgetBytes(): number { return this.pcmHistoryBudget.limitBytes; }
    public get projectRevision(): number { return this.projectPcmRevision; }

    public getMarkState(): TrackMarkState {
        const exists = this.markedPcm !== null;
        const bytes = audioBufferPcmBytes(this.audioBuffer);
        const stateBusy = this.historyBusy || this.state === TrackState.RECORDING || this.state === TrackState.OVERDUBBING;
        const withinBudget = this.pcmHistoryBudget.canReplace(this.markBudgetOwner, bytes);
        const unavailableReason = this.markFailureReason
            ?? (this.markOperationBusy ? 'A mark operation is still in progress.'
                : exists ? 'Clear the existing mark before setting another one.'
                    : stateBusy ? 'Finish recording or overdubbing before setting a mark.'
                        : !this.audioBuffer ? 'Record a loop before setting a mark.'
                            : !this.hasCommittedOverdub ? 'Complete an overdub before setting a mark.'
                                : !withinBudget ? this.historyBudgetReason('The mark is unavailable') : null);
        return {
            supported: true,
            exists,
            canSet: !exists && !this.disposed && !this.markOperationBusy && !stateBusy
                && this.audioBuffer !== null && this.hasCommittedOverdub && withinBudget,
            canClear: exists && !this.disposed && !this.markOperationBusy,
            backSupported: false,
            busy: this.markOperationBusy,
            retainedPcmBytes: audioBufferPcmBytes(this.markedPcm),
            unavailableReason,
            requestedGeneration: this.markRequestedGeneration,
            appliedGeneration: this.markAppliedGeneration,
        };
    }

    public setMark(): TrackMarkActionResult {
        const currentState = this.getMarkState();
        if (!currentState.canSet) {
            return { ok: false, reason: currentState.unavailableReason ?? 'A mark cannot be set in the current track state.', state: currentState };
        }
        const source = this.audioBuffer;
        if (!source) return { ok: false, reason: 'Record a loop before setting a mark.', state: this.getMarkState() };

        const revision = this.projectPcmRevision;
        const bytes = audioBufferPcmBytes(source);
        this.markRequestedGeneration += 1;
        this.markOperationBusy = true;
        this.markFailureReason = null;
        try {
            // Marks own a full independent PCM copy; subsequent overdub patches
            // only mutate the live AudioBuffer and never alias this snapshot.
            const copy = this.engine.context.createBuffer(source.numberOfChannels, source.length, source.sampleRate);
            for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
                copy.getChannelData(channel).set(source.getChannelData(channel));
            }
            if (this.disposed || this.audioBuffer !== source || this.projectPcmRevision !== revision || this.historyBusy) {
                this.markFailureReason = 'Track PCM changed while the mark snapshot was being prepared; no mark was installed.';
                this.markOperationBusy = false;
                return { ok: false, reason: this.markFailureReason, state: this.getMarkState() };
            }
            if (!this.pcmHistoryBudget.replace(this.markBudgetOwner, bytes)) {
                this.markFailureReason = this.historyBudgetReason('The mark is unavailable');
                this.markOperationBusy = false;
                return { ok: false, reason: this.markFailureReason, state: this.getMarkState() };
            }
            this.markedPcm = copy;
            this.markAppliedGeneration = this.markRequestedGeneration;
            this.markOperationBusy = false;
            return { ok: true, reason: null, state: this.getMarkState() };
        } catch (error) {
            this.markFailureReason = `Browser could not allocate the independent mark snapshot: ${error instanceof Error ? error.message : String(error)}.`;
            this.markOperationBusy = false;
            return { ok: false, reason: this.markFailureReason, state: this.getMarkState() };
        } finally {
            this.markOperationBusy = false;
        }
    }

    public clearMark(): TrackMarkActionResult {
        if (this.disposed) {
            const state = this.getMarkState();
            return { ok: false, reason: 'This Browser track has been disposed.', state };
        }
        if (!this.markedPcm) {
            const state = this.getMarkState();
            return { ok: false, reason: 'This track does not have a mark to clear.', state };
        }
        if (this.markOperationBusy) {
            const state = this.getMarkState();
            return { ok: false, reason: 'A mark operation is still in progress.', state };
        }
        this.markRequestedGeneration += 1;
        this.clearMarkInternal();
        this.markAppliedGeneration = this.markRequestedGeneration;
        this.markFailureReason = null;
        return { ok: true, reason: null, state: this.getMarkState() };
    }

    private clearMarkInternal(): void {
        this.markedPcm = null;
        this.pcmHistoryBudget.release(this.markBudgetOwner);
    }

    /** Read-only state needed to plan a new Browser AudioContext without mutating this graph. */
    public getRecoverySnapshot(): BrowserRecoveryTrack {
        if (this.historyBusy) {
            throw new Error(`Track ${this.track.id} is recording, finalizing, overdubbing, or changing history; Browser recovery snapshot was not captured.`);
        }
        const history = this.pcmHistory?.snapshot ?? null;
        const settings = Object.freeze({
            measure: Object.freeze({ ...this.track.measure }),
            loopSyncSw: this.track.loopSyncSw,
            tempoSyncSw: this.track.tempoSyncSw,
            reverse: this.track.reverse,
            oneShot: this.track.oneShot,
            pan: this.track.pan,
            playLevel: this.track.playLevel,
            startMode: this.track.startMode,
            stopMode: this.track.stopMode,
            dubMode: this.track.dubMode,
            fxSw: this.track.fxSw,
            filterEnabled: this.track.filterEnabled,
            filterValue: this.track.filterValue,
            filterResonance: this.track.filterResonance,
        });
        const sourceTransport = Object.freeze(this.loopTransportFxSlots.map((slot) => slot
            ? Object.freeze({ ...slot })
            : null));
        const pcmHistory = Object.freeze({
            buffer: history?.buffer ?? null,
            direction: this.pcmHistory?.direction ?? null,
            isReverse: history?.isReverse ?? null,
            master: history?.master ? Object.freeze({ ...history.master }) : null,
            retainedBytes: audioBufferPcmBytes(history?.buffer ?? null),
            unavailableReason: this.historyFailureReason,
        });
        return Object.freeze({
            trackId: this.track.id,
            state: this.state,
            wasPlaying: this.state === TrackState.PLAYING,
            projectPcmRevision: this.projectPcmRevision,
            buffer: this.audioBuffer,
            bufferBytes: audioBufferPcmBytes(this.audioBuffer),
            isReverse: this.isReverse,
            settings,
            pitch: Object.freeze({
                mode: this.livePolyPitchEnabledInternal ? 'LIVE_POLY' as const
                    : this.liveMonoPitchEnabledInternal ? 'LIVE_MONO' as const : 'off' as const,
                liveMono: Object.freeze({
                    semitones: this.liveMonoPitchSemitones,
                    minimumFrequencyHz: this.liveMonoPitchMinimumFrequencyHz,
                    maximumFrequencyHz: this.liveMonoPitchMaximumFrequencyHz,
                }),
                livePoly: Object.freeze({
                    semitones: this.livePolyPitchSemitones,
                    playbackRate: this.livePolyPitchPlaybackRate,
                    tonalityLimitHz: this.livePolyPitchTonalityLimitHz,
                }),
            }),
            history: pcmHistory,
            mark: Object.freeze({
                buffer: this.markedPcm,
                committedOverdub: this.hasCommittedOverdub,
                retainedBytes: audioBufferPcmBytes(this.markedPcm),
            }),
            sourceTransport,
        });
    }

    public getProjectPcmSnapshot(): ProjectTrackPcmSnapshot | null {
        if (this.historyBusy) throw new Error(`Track ${this.track.id} is recording, finalizing, or overdubbing; finish it before exporting project memory`);
        const buffer = this.audioBuffer;
        if (!buffer) return null;
        if (buffer.numberOfChannels !== 1 && buffer.numberOfChannels !== 2) {
            throw new Error(`Track ${this.track.id} uses an unsupported ${buffer.numberOfChannels}-channel loop`);
        }
        return {
            revision: this.projectPcmRevision,
            sampleRate: buffer.sampleRate,
            frameCount: buffer.length,
            channels: buffer.numberOfChannels as 1 | 2,
            channelData: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
        };
    }

    /** Atomically install all five prepared Browser buffers and make each prior loop its one-step undo. */
    public static restoreProjectBuffersAtomically(
        tracks: readonly TrackAudio[],
        replacements: readonly (AudioBuffer | null)[],
        expectedRevisions?: readonly number[],
        historyPolicy: 'retain-undo' | 'memory-boundary' = 'retain-undo',
    ): ProjectBufferRestoreResult {
        if (tracks.length !== 5 || replacements.length !== 5) {
            return { ok: false, reason: 'Project memory restore requires exactly five prepared track buffers.' };
        }
        const budget = tracks[0]?.pcmHistoryBudget;
        if (!budget || tracks.some((track) => track.pcmHistoryBudget !== budget)) {
            return { ok: false, reason: 'Project memory restore could not verify a shared Browser history budget.' };
        }
        if (tracks.some((track) => track.historyBusy)) {
            return { ok: false, reason: 'Stop recording and overdubbing on every track before loading project memory.' };
        }
        if (expectedRevisions && (expectedRevisions.length !== 5
            || tracks.some((track, index) => track.projectPcmRevision !== expectedRevisions[index]))) {
            return { ok: false, reason: 'Project memory restore was canceled because a track changed during preparation.' };
        }
        for (const buffer of replacements) {
            if (buffer && (!Number.isSafeInteger(buffer.length) || buffer.length < 1
                || !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0
                || (buffer.numberOfChannels !== 1 && buffer.numberOfChannels !== 2))) {
                return { ok: false, reason: 'Project memory contains an unsupported or invalid loop buffer.' };
            }
        }

        const snapshots = tracks.map((track) => track.capturePcmSnapshot());
        const historyReplacements = tracks.flatMap((track, index) => ([
            { owner: track, bytes: historyPolicy === 'retain-undo' ? audioBufferPcmBytes(snapshots[index]!.buffer) : 0 },
            { owner: track.markBudgetOwner, bytes: 0 },
        ]));
        if (!budget.canReplaceMany(historyReplacements)) {
            return {
                ok: false,
                reason: `Load canceled: preserving the five current loops for per-track undo would exceed the shared PCM history budget (${budget.limitBytes} bytes, ${Math.round(budget.limitBytes / 1024 / 1024)} MiB). Existing audio is unchanged.`,
            };
        }

        // All validation, buffer creation, and the aggregate history-budget check have
        // completed before any live source or PCM state is changed.
        tracks[0]!.transport.stop();
        for (const track of tracks) track.stop();
        if (!budget.replaceMany(historyReplacements)) {
            // The budget is only changed on the control thread; this protects against
            // unexpected reentrancy without partially installing the project.
            return { ok: false, reason: 'Load canceled because the shared PCM history budget changed during preparation.' };
        }
        for (let index = 0; index < tracks.length; index += 1) {
            const track = tracks[index]!;
            const previous = snapshots[index]!;
            track.pcmHistory = historyPolicy === 'retain-undo' ? { snapshot: previous, direction: 'undo' } : null;
            track.historyFailureReason = null;
            track.markedPcm = null;
            track.hasCommittedOverdub = false;
            track.markFailureReason = null;
            track.audioBuffer = replacements[index]!;
            track.projectPcmRevision += 1;
            track.isReverse = false;
            track.startOffset = 0;
            track.startTime = 0;
            track.loopTransportStartOffsetShiftSeconds = 0;
            track.loopTransportPlaybackInitialized = false;
            track.loopTransportTransitionActive = false;
            track.loopTransportPendingRetarget = false;
            track.state = replacements[index] ? TrackState.STOPPED : TrackState.EMPTY;
            if (track.sharedPositions) track.sharedPositions[track.trackIndex] = 0;
        }
        return { ok: true };
    }

    /**
     * Install a closed-context recovery snapshot into five pristine tracks.
     * Candidate buffers are already cloned into the candidate AudioContext;
     * this method transfers those exact buffer references and restores the
     * one-step history ledger in one control-thread transaction.
     */
    public static restoreRecoverySnapshotsAtomically(
        tracks: readonly TrackAudio[],
        snapshots: readonly BrowserRecoveryTrack[],
    ): ProjectBufferRestoreResult {
        if (tracks.length !== 5 || snapshots.length !== 5) {
            return { ok: false, reason: 'Browser recovery requires exactly five prepared track snapshots.' };
        }
        const budget = tracks[0]?.pcmHistoryBudget;
        if (!budget || tracks.some((track) => track.pcmHistoryBudget !== budget)) {
            return { ok: false, reason: 'Browser recovery could not verify the shared PCM history ledger.' };
        }
        if (tracks.some((track) => track.disposed || track.historyBusy || track.audioBuffer !== null || track.pcmHistory !== null
            || track.projectPcmRevision !== 0 || track.state !== TrackState.EMPTY)) {
            return { ok: false, reason: 'Browser recovery requires five pristine, stopped candidate tracks.' };
        }

        const parsePan = (value: string): number | null => {
            if (value === 'CENTER') return 0;
            const match = /^(L|R)([0-9]{1,2})$/.exec(value);
            if (!match) return null;
            const amount = Number(match[2]);
            if (amount < 1 || amount > 50) return null;
            return match[1] === 'L' ? -amount : amount;
        };
        const replacements: Array<{ owner: object; bytes: number }> = [];
        for (let index = 0; index < snapshots.length; index += 1) {
            const saved = snapshots[index]!;
            const track = tracks[index]!;
            const history = saved.history;
            const mark = saved.mark ?? { buffer: null, committedOverdub: false, retainedBytes: 0 };
            if (saved.trackId !== index + 1 || !Number.isSafeInteger(saved.projectPcmRevision) || saved.projectPcmRevision < 0
                || (saved.state !== TrackState.EMPTY && saved.state !== TrackState.STOPPED)
                || !saved.settings || parsePan(saved.settings.pan) === null
                || !Number.isFinite(saved.settings.playLevel) || saved.settings.playLevel < 0 || saved.settings.playLevel > 200
                || !Number.isFinite(saved.settings.filterValue) || saved.settings.filterValue < 0 || saved.settings.filterValue > 1
                || !Number.isFinite(saved.settings.filterResonance)
                || (saved.buffer && (!Number.isSafeInteger(saved.buffer.length) || saved.buffer.length < 1
                    || (saved.buffer.numberOfChannels !== 1 && saved.buffer.numberOfChannels !== 2)
                    || !Number.isFinite(saved.buffer.sampleRate) || saved.buffer.sampleRate <= 0))
                || (history.buffer && (!Number.isSafeInteger(history.buffer.length) || history.buffer.length < 1
                    || (history.buffer.numberOfChannels !== 1 && history.buffer.numberOfChannels !== 2)
                    || !Number.isFinite(history.buffer.sampleRate) || history.buffer.sampleRate <= 0
                    || (history.direction !== 'undo' && history.direction !== 'redo')
                    || typeof history.isReverse !== 'boolean'))
                || (!history.buffer && (history.direction !== null || history.isReverse !== null || history.master !== null || history.retainedBytes !== 0))
                || (saved.buffer === null && saved.state !== TrackState.EMPTY)
                || (saved.buffer !== null && saved.state !== TrackState.STOPPED)
                || saved.bufferBytes !== audioBufferPcmBytes(saved.buffer)
                || history.retainedBytes !== audioBufferPcmBytes(history.buffer)
                || typeof mark.committedOverdub !== 'boolean'
                || (mark.buffer && (!Number.isSafeInteger(mark.buffer.length) || mark.buffer.length < 1
                    || (mark.buffer.numberOfChannels !== 1 && mark.buffer.numberOfChannels !== 2)
                    || !Number.isFinite(mark.buffer.sampleRate) || mark.buffer.sampleRate <= 0))
                || (!mark.buffer && mark.committedOverdub && saved.buffer === null)
                || (mark.buffer !== null && !mark.committedOverdub)
                || mark.retainedBytes !== audioBufferPcmBytes(mark.buffer)
                || (mark.buffer !== null && (mark.buffer === saved.buffer || mark.buffer === history.buffer))
                || !Array.isArray(saved.sourceTransport) || saved.sourceTransport.length !== 4
                || !saved.pitch || !['off', 'LIVE_MONO', 'LIVE_POLY'].includes(saved.pitch.mode)) {
                return { ok: false, reason: `Track ${index + 1} recovery snapshot is malformed; candidate PCM was not installed.` };
            }
            if (saved.buffer && saved.buffer.sampleRate !== track.engine.context.sampleRate) {
                return { ok: false, reason: `Track ${index + 1} loop sample rate does not match the recovery AudioContext.` };
            }
            if (history.buffer && history.buffer.sampleRate !== track.engine.context.sampleRate) {
                return { ok: false, reason: `Track ${index + 1} undo/redo sample rate does not match the recovery AudioContext.` };
            }
            if (mark.buffer && mark.buffer.sampleRate !== track.engine.context.sampleRate) {
                return { ok: false, reason: `Track ${index + 1} mark sample rate does not match the recovery AudioContext.` };
            }
            replacements.push({ owner: track, bytes: history.retainedBytes });
            replacements.push({ owner: track.markBudgetOwner, bytes: mark.retainedBytes });
        }
        if (!budget.canReplaceMany(replacements)) {
            return { ok: false, reason: `Browser recovery history requires more than the shared ${budget.limitBytes}-byte PCM history budget; no candidate track was changed.` };
        }

        // Ledger admission happens before any track state changes. This budget
        // belongs only to the unpublished candidate engine; a failed build is
        // discarded with that engine and never changes the old ledger.
        if (!budget.replaceMany(replacements)) {
            return { ok: false, reason: 'Browser recovery was canceled because the candidate history budget changed during preparation.' };
        }
        for (let index = 0; index < snapshots.length; index += 1) {
            const track = tracks[index]!;
            const saved = snapshots[index]!;
            const settings = saved.settings;
            track.track.measure = { ...settings.measure } as Track['measure'];
            track.track.loopSyncSw = settings.loopSyncSw as Track['loopSyncSw'];
            track.track.tempoSyncSw = settings.tempoSyncSw as Track['tempoSyncSw'];
            track.track.reverse = settings.reverse as Track['reverse'];
            track.track.oneShot = settings.oneShot as Track['oneShot'];
            track.track.pan = settings.pan === 'CENTER' ? 0 : settings.pan.startsWith('L') ? -Number(settings.pan.slice(1)) : Number(settings.pan.slice(1));
            track.track.playLevel = settings.playLevel;
            track.track.startMode = settings.startMode as Track['startMode'];
            track.track.stopMode = settings.stopMode as Track['stopMode'];
            track.track.dubMode = settings.dubMode as Track['dubMode'];
            track.track.fxSw = settings.fxSw as Track['fxSw'];
            track.track.filterEnabled = settings.filterEnabled;
            track.track.filterValue = settings.filterValue;
            track.track.filterResonance = settings.filterResonance;
            track.isReverse = saved.isReverse;
            track.audioBuffer = saved.buffer;
            track.pcmHistory = saved.history.buffer ? {
                snapshot: {
                    buffer: saved.history.buffer,
                    isReverse: saved.history.isReverse!,
                    master: saved.history.master ? { ...saved.history.master } : null,
                },
                direction: saved.history.direction!,
            } : null;
            const mark = saved.mark ?? { buffer: null, committedOverdub: false, retainedBytes: 0 };
            track.markedPcm = mark.buffer;
            track.hasCommittedOverdub = mark.committedOverdub;
            track.markFailureReason = null;
            track.historyFailureReason = saved.history.unavailableReason;
            track.projectPcmRevision = saved.projectPcmRevision;
            track.state = saved.buffer ? TrackState.STOPPED : TrackState.EMPTY;
            track.startOffset = 0;
            track.startTime = 0;
            track.loopTransportPlaybackInitialized = false;
            track.loopTransportTransitionActive = false;
            track.loopTransportPendingRetarget = false;
            for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) {
                const savedSlot = saved.sourceTransport[slotIndex];
                track.loopTransportFxSlots[slotIndex] = savedSlot ? { ...savedSlot } : null;
                if (savedSlot?.type === 'VINYL FLICK') {
                    const motor = track.loopMotorStates[slotIndex]!;
                    motor.targetRate = loopMotorTargetRate(savedSlot.vinylFlickSpeed);
                    motor.returnTimeSeconds = savedSlot.vinylFlickReturnTimeSeconds;
                    motor.brakePercent = savedSlot.vinylFlickBrakePercent;
                }
            }
            track.liveMonoPitchEnabledInternal = saved.pitch.mode === 'LIVE_MONO';
            track.liveMonoPitchSemitones = saved.pitch.liveMono.semitones;
            track.liveMonoPitchMinimumFrequencyHz = saved.pitch.liveMono.minimumFrequencyHz;
            track.liveMonoPitchMaximumFrequencyHz = saved.pitch.liveMono.maximumFrequencyHz;
            track.livePolyPitchEnabledInternal = saved.pitch.mode === 'LIVE_POLY';
            track.livePolyPitchSemitones = saved.pitch.livePoly.semitones;
            track.livePolyPitchPlaybackRate = saved.pitch.livePoly.playbackRate;
            track.livePolyPitchTonalityLimitHz = saved.pitch.livePoly.tonalityLimitHz;
            track.updateSettings();
            if (track.sharedStates) Atomics.store(track.sharedStates, track.trackIndex, Object.values(TrackState).indexOf(track.state));
            if (track.sharedPositions) track.sharedPositions[track.trackIndex] = 0;
        }
        return { ok: true };
    }

    public get historyUnavailableReason(): string | null {
        if (this.historyBusy) return 'Finish recording or overdubbing before using PCM history.';
        if (this.historyFailureReason) return this.historyFailureReason;
        if (this.pcmHistory && !this.pcmHistoryBudget.canReplace(this, audioBufferPcmBytes(this.audioBuffer))) {
            return this.historyBudgetReason('Undo/redo is unavailable');
        }
        return null;
    }

    /** PCM-only one-step history; unrelated track controls and global FX are unchanged. */
    public undo(): boolean { return this.restoreHistory('undo'); }
    public redo(): boolean { return this.restoreHistory('redo'); }

    private canRestoreHistory(direction: 'undo' | 'redo'): boolean {
        return !this.disposed && !this.historyBusy && this.pcmHistory?.direction === direction
            && this.pcmHistoryBudget.canReplace(this, audioBufferPcmBytes(this.audioBuffer));
    }

    private historyBudgetReason(prefix: string): string {
        return `${prefix}: the shared Browser PCM history budget (${Math.round(this.pcmHistoryBudget.limitBytes / 1024 / 1024)} MiB) cannot retain this loop. Audio is preserved.`;
    }

    private capturePcmSnapshot(buffer = this.audioBuffer): TrackPcmSnapshot {
        return {
            buffer,
            isReverse: this.isReverse,
            master: this.transport.masterTrackId === this.track.id ? {
                bpm: this.transport.bpm,
                measureLength: this.transport.measureLength,
                lengthSamples: this.transport.masterLoopLengthSamples,
            } : null,
        };
    }

    private retainPcmEdit(snapshot: TrackPcmSnapshot, clone = false): boolean {
        const bytes = audioBufferPcmBytes(snapshot.buffer);
        if (!this.pcmHistoryBudget.canReplace(this, bytes)) {
            this.historyFailureReason = this.historyBudgetReason('Undo is unavailable for this edit');
            return false;
        }
        // Drop the obsolete alternate before allocating a replacement copy so
        // transient retained-history PCM also stays within the shared cap.
        this.pcmHistory = null;
        this.pcmHistoryBudget.release(this);
        if (clone && snapshot.buffer) {
            const source = snapshot.buffer;
            try {
                const copy = this.engine.context.createBuffer(source.numberOfChannels, source.length, source.sampleRate);
                for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
                    copy.getChannelData(channel).set(source.getChannelData(channel));
                }
                snapshot = { ...snapshot, buffer: copy };
            } catch {
                this.historyFailureReason = 'PCM history could not allocate its snapshot. The edited audio is preserved; undo is unavailable.';
                return false;
            }
        }
        this.pcmHistoryBudget.replace(this, bytes);
        this.pcmHistory = { snapshot, direction: 'undo' };
        this.historyFailureReason = null;
        return true;
    }

    /** An admitted edit invalidates stale redo even when no new snapshot fits. */
    private invalidatePcmHistoryForEdit(): void {
        this.pcmHistory = null;
        this.pcmHistoryBudget.release(this);
        this.historyFailureReason ??= this.historyBudgetReason('Undo is unavailable for this edit');
    }

    private restoreHistory(direction: 'undo' | 'redo'): boolean {
        if (this.disposed || this.historyBusy || this.pcmHistory?.direction !== direction) return false;
        const current = this.capturePcmSnapshot();
        if (!this.pcmHistoryBudget.replace(this, audioBufferPcmBytes(current.buffer))) return false;
        const target = this.pcmHistory.snapshot;
        const resume = this.state === TrackState.PLAYING;
        this.stop();
        this.pcmHistory = { snapshot: current, direction: direction === 'undo' ? 'redo' : 'undo' };
        this.audioBuffer = target.buffer;
        this.projectPcmRevision += 1;
        this.isReverse = target.isReverse;
        this.startOffset = 0;
        this.startTime = 0;
        this.loopTransportStartOffsetShiftSeconds = 0;
        this.historyFailureReason = null;
        this.state = target.buffer ? TrackState.STOPPED : TrackState.EMPTY;
        if (!target.buffer) {
            this.engine.checkAndResetMaster(this.track.id);
        } else if (!this.transport.hasMasterTrack()) {
            // Restore timing only when this does not overwrite another loop's
            // current master/tempo. PCM history is per track, not a global undo.
            if (target.master) {
                this.transport.masterTrackId = this.track.id;
                this.transport.masterLoopLengthSamples = target.master.lengthSamples;
                this.transport.measureLength = target.master.measureLength;
                this.transport.setBpm(target.master.bpm);
            } else {
                this.transport.setMasterTrack(this.track.id, target.buffer.duration, target.buffer.sampleRate, target.buffer.length);
            }
        }
        if (target.buffer && resume) void this.play();
        this.syncTransportState();
        return true;
    }

    /** Install a private serial bank after the existing strip FX and before level/pan/TrackMix. */
    public installTrackFxInsert(input: AudioNode, output: AudioNode): void {
        if (this.disposed) throw new Error(`Track ${this.track.id} has been disposed.`);
        this.fxChain.output.disconnect(this.gainNode);
        this.fxChain.output.connect(input);
        output.connect(this.gainNode);
    }

    /** Reversible graph edit used only behind the suspended Memory publication fence. */
    public replaceTrackFxInsert(previousInput: AudioNode, previousOutput: AudioNode, input: AudioNode, output: AudioNode): void {
        try {
            this.fxChain.output.connect(input);
            output.connect(this.gainNode);
            this.fxChain.output.disconnect(previousInput);
            previousOutput.disconnect(this.gainNode);
        } catch (error) {
            try { this.fxChain.output.disconnect(input); } catch { /* candidate edge was never installed */ }
            try { output.disconnect(this.gainNode); } catch { /* candidate edge was never installed */ }
            this.fxChain.output.connect(previousInput); previousOutput.connect(this.gainNode);
            throw error;
        }
    }

    /** Settings are validated on an isolated Track before touching live AudioParams. */
    public prepareMemorySettings(saved: Pick<BrowserRecoveryTrack, 'settings' | 'pitch' | 'isReverse' | 'sourceTransport'>): { commit(): void; rollback(): void } {
        const settings = saved.settings;
        const settingKeys = ['measure', 'loopSyncSw', 'tempoSyncSw', 'reverse', 'oneShot', 'pan', 'playLevel', 'startMode', 'stopMode', 'dubMode', 'fxSw', 'filterEnabled', 'filterValue', 'filterResonance'];
        if (!settings || !saved.pitch || typeof saved.isReverse !== 'boolean'
            || Object.keys(settings).length !== settingKeys.length || Object.keys(settings).some((key) => !settingKeys.includes(key))
            || !['off', 'LIVE_MONO', 'LIVE_POLY'].includes(saved.pitch.mode)
            || !['CENTER', ...Array.from({ length: 50 }, (_, index) => `L${index + 1}`), ...Array.from({ length: 50 }, (_, index) => `R${index + 1}`)].includes(settings.pan)
            || !Number.isFinite(settings.playLevel) || settings.playLevel < 0 || settings.playLevel > 200
            || !settings.measure || !['AUTO', 'FREE', 'NOTE'].includes(settings.measure.type)
            || ![settings.loopSyncSw, settings.tempoSyncSw, settings.reverse, settings.oneShot, settings.fxSw].every((value) => value === 'ON' || value === 'OFF')
            || !['IMMEDIATE', 'FADE'].includes(settings.startMode) || !['IMMEDIATE', 'FADE', 'LOOP'].includes(settings.stopMode)
            || !['OVERDUB', 'REPLACE1', 'REPLACE2'].includes(settings.dubMode)
            || typeof settings.filterEnabled !== 'boolean' || !Number.isFinite(settings.filterValue) || settings.filterValue < 0 || settings.filterValue > 1
            || !Number.isFinite(settings.filterResonance)
            || !Number.isFinite(saved.pitch.liveMono?.semitones) || Math.abs(saved.pitch.liveMono.semitones) > 12
            || !Number.isFinite(saved.pitch.liveMono.minimumFrequencyHz) || !Number.isFinite(saved.pitch.liveMono.maximumFrequencyHz)
            || saved.pitch.liveMono.minimumFrequencyHz <= 0 || saved.pitch.liveMono.maximumFrequencyHz <= saved.pitch.liveMono.minimumFrequencyHz
            || !Number.isFinite(saved.pitch.livePoly?.semitones) || Math.abs(saved.pitch.livePoly.semitones) > 24
            || !Number.isFinite(saved.pitch.livePoly.playbackRate) || saved.pitch.livePoly.playbackRate <= 0
            || !Number.isFinite(saved.pitch.livePoly.tonalityLimitHz) || saved.pitch.livePoly.tonalityLimitHz <= 0) {
            throw new Error(`Track ${this.track.id} Memory settings are invalid.`);
        }
        if (!Array.isArray(saved.sourceTransport) || saved.sourceTransport.length !== 4
            || saved.sourceTransport.some((slot) => slot && (!['BEAT SHIFT', 'VINYL FLICK'].includes(slot.type)
                || Object.entries(slot).some(([key, value]) => key !== 'type' && value !== null && (typeof value !== 'number' || !Number.isFinite(value)))))) {
            throw new Error(`Track ${this.track.id} Memory source transport is invalid.`);
        }
        const previous = this.getRecoverySnapshot();
        const apply = (value: Pick<BrowserRecoveryTrack, 'settings' | 'pitch' | 'isReverse' | 'sourceTransport'>) => {
            const s = value.settings;
            Object.assign(this.track, { ...s, measure: { ...s.measure }, pan: s.pan === 'CENTER' ? 0 : s.pan.startsWith('L') ? -Number(s.pan.slice(1)) : Number(s.pan.slice(1)) });
            this.isReverse = value.isReverse;
            this.liveMonoPitchEnabledInternal = value.pitch.mode === 'LIVE_MONO';
            this.liveMonoPitchSemitones = value.pitch.liveMono.semitones;
            this.liveMonoPitchMinimumFrequencyHz = value.pitch.liveMono.minimumFrequencyHz;
            this.liveMonoPitchMaximumFrequencyHz = value.pitch.liveMono.maximumFrequencyHz;
            this.livePolyPitchEnabledInternal = value.pitch.mode === 'LIVE_POLY';
            this.livePolyPitchSemitones = value.pitch.livePoly.semitones;
            this.livePolyPitchPlaybackRate = value.pitch.livePoly.playbackRate;
            this.livePolyPitchTonalityLimitHz = value.pitch.livePoly.tonalityLimitHz;
            for (let index = 0; index < 4; index++) {
                const slot = value.sourceTransport[index];
                this.loopTransportFxSlots[index] = slot ? { ...slot } : null;
                if (slot?.type === 'VINYL FLICK') {
                    const motor = this.loopMotorStates[index]!;
                    motor.targetRate = loopMotorTargetRate(slot.vinylFlickSpeed);
                    motor.returnTimeSeconds = slot.vinylFlickReturnTimeSeconds;
                    motor.brakePercent = slot.vinylFlickBrakePercent;
                }
            }
            this.updateSettings();
        };
        return { commit: () => apply(saved), rollback: () => apply(previous) };
    }

    /** Routes the post-fader loop signal into the shared wet or dry playback sum. */
    public installSharedTrackFxRouting(wetBus: AudioNode, dryBus: AudioNode, initiallyEnabled = true): void {
        if (this.disposed) throw new Error(`Track ${this.track.id} has been disposed.`);
        this.sharedTrackFxWetGain?.disconnect();
        this.sharedTrackFxDryGain?.disconnect();
        this.sharedTrackFxMeterSplit?.disconnect();
        this.sharedTrackFxMeterLeft?.disconnect();
        this.sharedTrackFxMeterRight?.disconnect();
        this.sharedTrackFxMeterSink?.disconnect();
        this.panNode.disconnect();

        const context = this.engine.context;
        const wetGain = context.createGain();
        const dryGain = context.createGain();
        wetGain.gain.value = initiallyEnabled ? 1 : 0;
        dryGain.gain.value = initiallyEnabled ? 0 : 1;
        this.panNode.connect(wetGain);
        this.panNode.connect(dryGain);
        wetGain.connect(wetBus);
        dryGain.connect(dryBus);
        this.sharedTrackFxWetGain = wetGain;
        this.sharedTrackFxDryGain = dryGain;

        // Probe each post-fader stereo channel independently. The analyser
        // branch is muted at the destination and does not sit in the audio path.
        const splitter = context.createChannelSplitter(2);
        const leftAnalyser = context.createAnalyser();
        const rightAnalyser = context.createAnalyser();
        const sink = context.createGain();
        leftAnalyser.fftSize = 256;
        rightAnalyser.fftSize = 256;
        leftAnalyser.smoothingTimeConstant = 0;
        rightAnalyser.smoothingTimeConstant = 0;
        leftAnalyser.channelCount = 1;
        rightAnalyser.channelCount = 1;
        leftAnalyser.channelCountMode = 'explicit';
        rightAnalyser.channelCountMode = 'explicit';
        sink.gain.value = 0;
        this.panNode.connect(splitter);
        splitter.connect(leftAnalyser, 0);
        splitter.connect(rightAnalyser, 1);
        leftAnalyser.connect(sink);
        rightAnalyser.connect(sink);
        sink.connect(context.destination);
        this.sharedTrackFxMeterSplit = splitter;
        this.sharedTrackFxMeterLeft = leftAnalyser;
        this.sharedTrackFxMeterRight = rightAnalyser;
        this.sharedTrackFxMeterSink = sink;
    }

    public setSharedTrackFxApply(enabled: boolean, atTime = this.engine.context.currentTime): boolean {
        const wetGain = this.sharedTrackFxWetGain;
        const dryGain = this.sharedTrackFxDryGain;
        if (!wetGain || !dryGain || typeof enabled !== 'boolean' || !Number.isFinite(atTime)) return false;
        try {
            wetGain.gain.setValueAtTime(enabled ? 1 : 0, atTime);
            dryGain.gain.setValueAtTime(enabled ? 0 : 1, atTime);
            return true;
        } catch {
            return false;
        }
    }

    /** Replace the startup gain fallback with the acknowledged render-thread selector. */
    public installSharedTrackFxRouter(router: AudioWorkletNode, wetBus: AudioNode, dryBus: AudioNode): void {
        if (this.disposed) throw new Error(`Track ${this.track.id} has been disposed.`);
        this.sharedTrackFxWetGain?.disconnect();
        this.sharedTrackFxDryGain?.disconnect();
        this.sharedTrackFxWetGain = null;
        this.sharedTrackFxDryGain = null;
        this.panNode.disconnect();
        this.panNode.connect(router, 0, this.trackIndex);
        router.connect(wetBus, this.trackIndex * 2, 0);
        router.connect(dryBus, (this.trackIndex * 2) + 1, 0);
        if (this.sharedTrackFxMeterSplit) this.panNode.connect(this.sharedTrackFxMeterSplit);
    }

    /** Stage selector edges without allocating or destroying the old fallback/selector. */
    public prepareMemoryTrackFxRouter(previous: AudioWorkletNode | null, candidate: AudioWorkletNode): { commit(): void; rollback(): void; retire(): void } {
        const wet = this.sharedTrackFxWetGain, dry = this.sharedTrackFxDryGain;
        let attached = false;
        const restore = () => {
            try { this.panNode.disconnect(candidate); } catch { /* candidate not connected */ }
            if (previous) this.panNode.connect(previous, 0, this.trackIndex);
            else { if (wet) this.panNode.connect(wet); if (dry) this.panNode.connect(dry); }
            attached = false;
        };
        return {
            commit: () => {
                try {
                    this.panNode.connect(candidate, 0, this.trackIndex);
                    if (previous) this.panNode.disconnect(previous);
                    else { if (wet) this.panNode.disconnect(wet); if (dry) this.panNode.disconnect(dry); }
                    attached = true;
                } catch (error) { restore(); throw error; }
            },
            rollback: () => { if (attached) restore(); },
            retire: () => {
                wet?.disconnect(); dry?.disconnect(); this.sharedTrackFxWetGain = null; this.sharedTrackFxDryGain = null;
            },
        };
    }

    public getPostFaderPreSharedTrackFxMeter(): { peak: number; rms: number } {
        const left = this.sharedTrackFxMeterLeft;
        const right = this.sharedTrackFxMeterRight;
        if (!left || !right) return { peak: 0, rms: 0 };
        const leftSamples = this.sharedTrackFxMeterSamples[0];
        const rightSamples = this.sharedTrackFxMeterSamples[1];
        left.getFloatTimeDomainData(leftSamples);
        right.getFloatTimeDomainData(rightSamples);
        let peak = 0;
        let squareSum = 0;
        for (let index = 0; index < leftSamples.length; index += 1) {
            const leftSample = leftSamples[index]!;
            const rightSample = rightSamples[index]!;
            peak = Math.max(peak, Math.abs(leftSample), Math.abs(rightSample));
            squareSum += leftSample * leftSample + rightSample * rightSample;
        }
        return { peak, rms: Math.sqrt(squareSum / (leftSamples.length * 2)) };
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
        if (this.state === TrackState.OVERDUBBING && this.loopTransportOverdubSnapshot) {
            return 'Source-aware loop transport is suspended during overdub so writes stay aligned to canonical loop frames; it resumes after overdub finalization';
        }
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
        if (this.disposed) return false;
        if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 3) return false;
        const normalizedType = type === null ? null : type.trim().toUpperCase();
        if (normalizedType !== null && normalizedType !== 'BEAT SHIFT' && normalizedType !== 'VINYL FLICK') return false;
        if (this.track.id === this.transport.masterTrackId) this.transport.clearMasterPhaseOrigin();
        // The Browser overdub writer patches canonical loop-frame indices. Do
        // not let a live source-readhead change the heard position underneath
        // that writer; its saved configuration is restored after final ACK.
        if (this.state === TrackState.OVERDUBBING && normalizedType !== null) return false;

        const now = this.engine.context.currentTime;
        const wasPlaying = (this.state === TrackState.PLAYING || this.state === TrackState.OVERDUBBING)
            && !!this.audioBuffer && !!this.sourceNode;
        const hadReader = this.loopTransportPlaybackInitialized;
        const wasReaderPlaying = wasPlaying && hadReader;
        const positionBeforeConfig = wasPlaying && !hadReader ? this.getCurrentPlaybackPosition() : 0;
        if (wasReaderPlaying) this.advanceLoopTransportTo(now);

        const previousSlot = this.loopTransportFxSlots[slotIndex];
        const previousMotor = { ...this.loopMotorStates[slotIndex]! };
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
                slotMotor.targetRate = loopMotorTargetRate(nextSlot.vinylFlickSpeed);
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
                this.loopTransportCanonicalPhaseSeconds = positionBeforeConfig;
                this.loopTransportPhaseTime = now;
                this.loopTransportStartOffsetShiftSeconds = 0;
                this.resetLoopMotorStates();
                this.loopTransportRenderedBeatShiftSeconds = 0;
            }

            if (this.hasConfiguredVinylFlick() && !this.ensureLoopTransportDryReader(now)) {
                this.loopTransportFxSlots[slotIndex] = previousSlot ?? null;
                Object.assign(this.loopMotorStates[slotIndex]!, previousMotor);
                if (!wasReaderPlaying) this.loopTransportPlaybackInitialized = false;
                this.loopTransportRuntimeFallbackReason = 'Canonical dry reader creation failed; current loop playback is retained';
                return false;
            }
            const canonicalRetarget = !!this.loopTransportDrySourceNode
                && !this.hasConfiguredVinylFlick() && hasConfiguredFx;
            if (canonicalRetarget) {
                // When changing from Vinyl back to BEAT SHIFT, its source
                // offset applies to canonical transport, not the old wet phase.
                this.loopTransportPhaseBaseSeconds = this.loopTransportCanonicalPhaseSeconds;
                this.resetLoopMotorStates();
            }
            this.updateLoopTransportMix(now);
            const nextShiftSeconds = this.getLoopTransportBeatShiftSeconds();
            if (canonicalRetarget || Math.abs(nextShiftSeconds - (wasReaderPlaying ? previousShiftSeconds : 0)) > 1e-9) {
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
        if (this.disposed) return;
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
        } else if (normalizedKey === 'mixPercent' || normalizedKey === 'vinylFlickMixPercent') {
            slot.vinylFlickMix = clampFinite(value / 100, 0, 1, slot.vinylFlickMix);
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
        if (this.disposed) throw new Error(`Track ${this.track.id} has been disposed.`);
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
            this.loopTransportStartOffsetShiftSeconds = this.loopTransportPlaybackInitialized && !this.loopTransportDrySourceNode && !this.loopTransportUnavailableReason
                ? this.getLoopTransportBeatShiftSeconds()
                : 0;
        }

        if (enabled && this.liveMonoPitchEnabledInternal) {
            this.liveMonoPitchEnabledInternal = false;
            await this.disposeLiveMonoPitchNode();
            if (this.disposed) return;
        }

        this.livePolyPitchEnabledInternal = enabled;
        this.livePolyPitchSemitones = options.semitones ?? this.livePolyPitchSemitones;
        this.livePolyPitchPlaybackRate = options.playbackRate ?? this.livePolyPitchPlaybackRate;
        this.livePolyPitchTonalityLimitHz = options.tonalityLimitHz ?? this.livePolyPitchTonalityLimitHz;
        this.livePolyPitchFallbackReasonValue = null;

        if (!enabled) {
            if (wasPlaying && this.audioBuffer) {
                await this.play();
                if (this.disposed) return;
            }
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
        if (this.disposed) throw new Error(`Track ${this.track.id} has been disposed.`);
        if (options.semitones !== undefined && (!Number.isFinite(options.semitones) || options.semitones < -12 || options.semitones > 12)) {
            throw new RangeError('LIVE_MONO semitones must be between -12 and +12');
        }
        const wasPlaying = this.state === TrackState.PLAYING;
        if (wasPlaying) {
            this.startOffset = this.getCurrentPlaybackPosition();
            this.loopTransportStartOffsetShiftSeconds = this.loopTransportPlaybackInitialized && !this.loopTransportDrySourceNode && !this.loopTransportUnavailableReason
                ? this.getLoopTransportBeatShiftSeconds()
                : 0;
        }

        if (enabled && this.livePolyPitchEnabledInternal) {
            this.livePolyPitchEnabledInternal = false;
            await this.disposeLivePolyPitchNode();
            if (this.disposed) return;
        }

        this.liveMonoPitchEnabledInternal = enabled;
        this.liveMonoPitchSemitones = options.semitones ?? this.liveMonoPitchSemitones;
        this.liveMonoPitchMinimumFrequencyHz = options.minimumFrequencyHz ?? this.liveMonoPitchMinimumFrequencyHz;
        this.liveMonoPitchMaximumFrequencyHz = options.maximumFrequencyHz ?? this.liveMonoPitchMaximumFrequencyHz;
        this.liveMonoPitchFallbackReasonValue = null;

        if (!enabled) {
            if (wasPlaying && this.audioBuffer) {
                await this.play();
                if (this.disposed) return;
            }
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
            this.positionUpdaterFrame = null;
            if (this.disposed) return;
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
            if (!this.disposed) this.positionUpdaterFrame = requestAnimationFrame(update);
        };
        this.positionUpdaterFrame = requestAnimationFrame(update);
    }

    /**
     * Retire this context-owned track graph without clearing its PCM/history.
     * A caller must first finish or cancel capture/overdub so teardown cannot
     * publish a late edit after a replacement engine has been adopted.
     */
    public dispose(): void {
        if (this.disposed) return;
        this.assertRetirableAfterContextClosed();

        const frame = this.positionUpdaterFrame;
        this.positionUpdaterFrame = null;
        this.transport.off('master-phase-change', this.masterPhaseChangeListener);
        if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);

        this.clearRecordingCaptureStopAckTimeout();
        this.clearOverdubCaptureTimeout();
        if (this.overdubCaptureAbortTimeout !== null) clearTimeout(this.overdubCaptureAbortTimeout);
        this.overdubCaptureAbortTimeout = null;
        if (this.overdubCaptureTimeout !== null) clearTimeout(this.overdubCaptureTimeout);
        this.overdubCaptureTimeout = null;
        if (this.overdubStopAckTimeout !== null) clearTimeout(this.overdubStopAckTimeout);
        this.overdubStopAckTimeout = null;

        // Invalidate outstanding asynchronous route creation before stopping
        // sources; snapshot buffers and history remain owned by this object.
        this.playbackRevision += 1;
        this.recordingStartGeneration += 1;
        this.overdubStartGeneration += 1;
        this.livePolyPitchGeneration += 1;
        this.liveMonoPitchGeneration += 1;
        this.stop();
        // stop() is synchronous. Mark retired before returning to the event loop
        // so no queued port/RAF callback can revive this graph or commit an edit.
        this.disposed = true;
        this.abortRecording();

        const recorder = this.workletNode;
        this.workletNode = null;
        if (recorder) {
            recorder.port.onmessage = null;
            recorder.onprocessorerror = null;
            try { this.recordingInputNode?.disconnect(recorder); } catch { /* old context may already be closed */ }
            try { recorder.disconnect(); } catch { /* already disconnected */ }
            try { recorder.port.close(); } catch { /* already closed */ }
        }
        try { this.recordingInputNode?.disconnect(); } catch { /* already disconnected */ }
        this.recordingInputNode = null;

        const overdub = this.overdubProcessor;
        this.overdubProcessor = null;
        if (overdub) {
            overdub.port.onmessage = null;
            overdub.onprocessorerror = null;
            try { this.overdubInputNode?.disconnect(overdub); } catch { /* old context may already be closed */ }
            try { overdub.disconnect(); } catch { /* already disconnected */ }
            try { overdub.port.close(); } catch { /* already closed */ }
        }
        try { this.overdubInputNode?.disconnect(); } catch { /* already disconnected */ }
        this.overdubBounceSourceMix?.dispose();
        this.overdubBounceSourceMix = null;
        try { this.overdubMuteGainNode?.disconnect(); } catch { /* already disconnected */ }
        this.overdubInputNode = null;
        this.overdubMuteGainNode = null;

        // Context closure is the final Worklet/WASM lifetime barrier. Do not
        // wait for messages from a closed render thread; disconnect() releases
        // the Signalsmith lease immediately for an already-closed context.
        const livePolyNode = this.livePolyPitchNode;
        this.livePolyPitchNode = null;
        this.livePolyPitchNodePromise = null;
        this.livePolyPitchActiveInternal = false;
        if (livePolyNode) {
            try { livePolyNode.disconnect(); } catch { /* old context is closed */ }
            try { livePolyNode.port.close(); } catch { /* already closed */ }
        }
        const liveMonoNode = this.liveMonoPitchNode;
        this.liveMonoPitchNode = null;
        this.liveMonoPitchNodePromise = null;
        this.liveMonoPitchActiveInternal = false;
        if (liveMonoNode) {
            try { liveMonoNode.disconnect(); } catch { /* old context is closed */ }
            try { liveMonoNode.port.close(); } catch { /* already closed */ }
        }

        this.pcmHistoryBudget.release(this.overdubSnapshotBudgetOwner);
        this.pendingOverdubRollbackSnapshot = null;
        this.overdubBaselineSnapshot = null;
        this.overdubStopRollbackJournal = null;
        this.overdubCapturePendingChunkReturns.length = 0;
        this.overdubCaptureBuffers = null;
        this.clearRecordingChunkStorage();
        this.loopReaderGateGain.disconnect();
        this.playbackSourceOutput.disconnect();
        this.sharedTrackFxWetGain?.disconnect();
        this.sharedTrackFxDryGain?.disconnect();
        this.sharedTrackFxMeterSplit?.disconnect();
        this.sharedTrackFxMeterLeft?.disconnect();
        this.sharedTrackFxMeterRight?.disconnect();
        this.sharedTrackFxMeterSink?.disconnect();
        this.fxChain.dispose();
        try { this.gainNode.disconnect(); } catch { /* already disconnected */ }
        try { this.panNode.disconnect(); } catch { /* already disconnected */ }
        this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY;
        this.sharedStates = null;
        this.sharedPositions = null;
    }

    /** Fail early before a facade publishes a candidate and retires this owner. */
    public assertRetirableAfterContextClosed(): void {
        if (this.disposed) return;
        if (this.engine.context.state !== 'closed') {
            throw new Error(`Track ${this.track.id} can only be retired after its AudioContext has closed.`);
        }
        if (this.historyBusy || this.recordingCaptureSession || this.overdubCaptureSession) {
            throw new Error(`Track ${this.track.id} is busy; its graph cannot be retired while preserving PCM history.`);
        }
    }

    public updateSettings() {
        if (this.disposed) return;
        if (this.lastLoopSyncSw !== this.track.loopSyncSw) {
            this.lastLoopSyncSw = this.track.loopSyncSw;
            if (this.loopSyncSettingsRevision < Number.MAX_SAFE_INTEGER) this.loopSyncSettingsRevision += 1;
            else this.loopSyncSettingsRevision = Number.MAX_SAFE_INTEGER;
            this.invalidateQuantizedRecordingStopIfStale('The track LOOP SYNC setting changed before the quantized stop; recording stopped at the current audio frame.');
        }
        if (this.track.id === this.transport.masterTrackId && this.track.loopSyncSw !== 'ON') {
            this.transport.clearMasterPhaseOrigin();
        }
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
        if (this.disposed) return;
        if (this.pendingClear) return;
        if (this.autoRecArmed) { this.abortRecording(); this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY; this.syncTransportState(); return; }
        if (this.state === TrackState.EMPTY) {
            this.scheduleRecordingStart();
        } else if (this.state === TrackState.RECORDING) {
            this.scheduleRecordingStop();
        } else if (this.state === TrackState.PLAYING) {
            // A one-shot track is an audition/retrigger target. It never enters
            // overdub, including when the global record action is REC->DUB.
            if (this.track.oneShot === 'ON') {
                this.startOffset = this.isReverse && this.audioBuffer
                    ? Math.max(0, this.audioBuffer.duration - 1 / this.audioBuffer.sampleRate)
                    : 0;
                void this.play();
                return;
            }
            // The RC-505mkII does not enter overdub while REVERSE is on.
            // Keep the existing loop playing and report why the press had no effect.
            if (this.isReverse) {
                this.overdubDiagnostic = 'Overdub is unavailable while REVERSE is on.';
                return;
            }
            this.suspendLoopTransportForOverdub();
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
        if (this.disposed) return;
        // A Stop/Cancel is authoritative even if the first RECORD_CONFIGURED
        // acknowledgement has not arrived yet, or an automatic rewarm retry
        // is already waiting in a microtask.
        this.recordingStartRetrySuppressionGeneration += 1;
        if (this.recordingCaptureSession && !this.recordingCaptureStartAcknowledged) {
            this.recordingCaptureStartCancelled = true;
        }
        if (this.autoRecArmed) { this.abortRecording(); this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY; this.syncTransportState(); return; }
        if (this.recordingStarting) {
            this.abortRecording();
            this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY;
            this.syncTransportState();
            return;
        }

        const pendingQuantizedCapture = this.recordingCaptureSession;
        if (pendingQuantizedCapture && this.state === TrackState.REC_STANDBY) {
            this.abortRecording();
            this.recordingDiagnostic = 'Quantized recording was cancelled before the worklet start acknowledgement; the previous loop was kept.';
            this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY;
            this.syncTransportState();
            return;
        }

        if (this.state === TrackState.RECORDING || this.state === TrackState.REC_FINISHING) {
            this.resumeAfterRecording = false;
            this.stopRecording();
            return;
        }

        if (this.state === TrackState.OVERDUBBING) {
            this.stopOverdub();
        }

        if (this.state === TrackState.REC_STANDBY) {
            this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY;
            this.syncTransportState();
            return;
        }

        this.stop();
        this.state = TrackState.STOPPED;
        this.syncTransportState();
    }

    private scheduleRecordingStart() {
        if (this.disposed) return;
        if (this.track.loopSyncSw === 'ON' && this.engine.getRecordPlaySettings?.().quantize !== 'OFF'
            && this.engine.isBrowserRhythmRunning?.()) {
            this.recordingDiagnostic = 'Measure quantization with the internal Rhythm is unavailable because its phrase phase is not exposed to the Browser capture clock. Existing loops are preserved.';
            return;
        }
        if (this.engine.getBrowserAutoRecSettings?.().enabled) {
            if (this.track.loopSyncSw === 'ON' && this.engine.getRecordPlaySettings?.().quantize !== 'OFF' && this.transport.hasMasterTrack()) {
                const masterTrackId = this.transport.masterTrackId;
                const masterLoopSync = masterTrackId === null
                    ? null : this.engine.isBrowserTrackLoopSyncEnabled?.(masterTrackId) ?? null;
                if (masterLoopSync !== false) {
                    this.recordingDiagnostic = masterLoopSync === true
                        ? 'AutoRec with measure-quantized start is unavailable; set QUANTIZE OFF. Existing loops are preserved.'
                        : 'AutoRec cannot verify the master LOOP SYNC state for quantized recording. Existing loops are preserved.';
                    return;
                }
            }
            void this.startRecording();
            return;
        }
        // ========================================
        // QUANTIZED RECORDING START LOGIC
        // ========================================

        const measureQuantize = this.engine.getRecordPlaySettings?.().quantize !== 'OFF';
        // A master loop phase is usable only after an ordinary audio source
        // has established its start on the AudioContext frame clock.
        if (this.track.loopSyncSw === 'ON' && measureQuantize && this.transport.hasMasterTrack()) {
            const masterTrackId = this.transport.masterTrackId;
            const masterLoopSync = masterTrackId === null
                ? null : this.engine.isBrowserTrackLoopSyncEnabled?.(masterTrackId) ?? null;
            if (masterLoopSync === false) {
                // Roland applies REC QUANTIZE only when Rhythm, another synced
                // track, or MIDI clock supplies a grid. Browser MIDI clock is
                // unsupported and Rhythm was ruled out above, so this is an
                // ordinary unquantized start rather than a false failure.
                this.startRecording();
                if (this.transport.state !== TransportState.PLAYING) this.transport.start();
                return;
            }
            if (masterLoopSync !== true) {
                this.recordingDiagnostic = 'Measure quantization is unavailable because the master LOOP SYNC state cannot be verified. Existing loops are preserved.';
                return;
            }
            const requestFrame = this.engine.getInputCaptureRequestFrame?.();
            const targetFrame = requestFrame === null || requestFrame === undefined
                ? null : this.transport.getNextMeasureStartFrame(requestFrame);
            if (targetFrame === null) {
                this.recordingDiagnostic = 'Measure quantization is unavailable because the master loop has no verified audio-clock phase. Existing loops are preserved.';
                return;
            }
            this.state = TrackState.REC_STANDBY;
            void this.startRecording(targetFrame, this.transport.masterPhaseRevision, this.loopSyncSettingsRevision);
            return;
        }

        // No quantization grid requested, or this take establishes the master
        if (this.track.loopSyncSw !== 'ON' || !measureQuantize || !this.transport.hasMasterTrack()) {
            // No quantization grid requested, or this take establishes the master
            console.log(`Track ${this.track.id}: Starting recording immediately`);
            this.startRecording();

            // Start transport if it's not running
            if (this.transport.state !== TransportState.PLAYING) {
                this.transport.start();
            }
            return;
        }

        this.recordingDiagnostic = 'Measure quantization is unavailable because the master loop has no verified audio-clock phase. Existing loops are preserved.';
    }

    private scheduleRecordingStop() {
        if (this.disposed) return;
        // ========================================
        // QUANTIZED RECORDING STOP LOGIC
        // ========================================

        // Check if there's a master track
        if (this.track.loopSyncSw !== 'ON' || !this.transport.hasMasterTrack()) {
            // The first take establishes the grid; OFF only disables start quantization.
            console.log(`Track ${this.track.id}: Stopping recording immediately`);
            this.stopRecording();
            return;
        }

        const requestFrame = this.engine.getInputCaptureRequestFrame?.();
        if (this.engine.isBrowserRhythmRunning?.()) {
            this.recordingDiagnostic = 'The internal Rhythm has no verified Browser capture phase; the take will stop at the current audio frame without claiming quantization.';
            this.stopRecording();
            return;
        }
        const captureStartFrame = this.recordingCaptureSession?.startFrame ?? requestFrame ?? -1;
        const stopReferenceFrame = Math.max(requestFrame ?? -1, captureStartFrame);
        const targetFrame = stopReferenceFrame < Number.MAX_SAFE_INTEGER
            ? this.transport.getNextMeasureStartFrame(stopReferenceFrame + 1) : null;
        if (targetFrame === null) {
            this.recordingDiagnostic = 'Master phrase phase is unknown; the take will stop at the current audio frame without claiming quantization.';
            this.stopRecording();
            return;
        }
        this.state = TrackState.REC_FINISHING;
        this.quantizedRecordingStopFrame = targetFrame;
        this.quantizedRecordingStopPhaseRevision = this.transport.masterPhaseRevision;
        this.quantizedRecordingStopTrackSyncRevision = this.loopSyncSettingsRevision;
        void this.stopRecording(targetFrame);
    }

    // --- Audio Logic ---

    private hasConfiguredVinylFlick(): boolean {
        return this.loopTransportFxSlots.some((slot) => slot?.type === 'VINYL FLICK');
    }

    private updateLoopTransportMix(now: number, immediate = false): void {
        if (!this.loopTransportWetMixGainNode || !this.loopTransportDryGainNode) return;
        // Only one source mode is exposed per loop. Legacy multiple-slot motor
        // routing remains an aggregate source stage, not serial A-D processing.
        let dry = 1;
        let hasVinyl = false;
        for (const slot of this.loopTransportFxSlots) {
            if (slot?.type !== 'VINYL FLICK') continue;
            hasVinyl = true;
            dry *= 1 - slot.vinylFlickMix;
        }
        // After removing Vinyl, use the canonical stream immediately; its motor
        // may continue settling silently. A BEAT SHIFT stage still uses wet.
        const wet = hasVinyl ? 1 - dry : this.hasConfiguredLoopTransportFx() ? 1 : 0;
        for (const [gain, target] of [
            [this.loopTransportWetMixGainNode, wet],
            [this.loopTransportDryGainNode, 1 - wet],
        ] as const) {
            const parameter = gain.gain;
            if (immediate) {
                parameter.setValueAtTime(target, now);
                continue;
            }
            // A short linear ramp prevents a mix change or live route promotion
            // from making a discontinuous jump between unrelated sample values.
            // Hold an in-flight ramp before replacing it when supported.
            const current = parameter.value;
            if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(now);
            else {
                parameter.cancelScheduledValues(now);
                parameter.setValueAtTime(current, now);
            }
            parameter.linearRampToValueAtTime(target, now + 0.005);
        }
    }

    private ensureLoopTransportDryReader(now: number): boolean {
        if (this.loopTransportDrySourceNode) return true;
        if (!this.audioBuffer) return false;
        const context = this.engine.context;
        let source: AudioBufferSourceNode | null = null;
        let gain: GainNode | null = null;
        let wetGain: GainNode | null = null;
        try {
            source = context.createBufferSource();
            if (!source) return false;
            gain = context.createGain();
            wetGain = context.createGain();
            source.buffer = this.audioBuffer;
            source.loop = true;
            source.playbackRate.value = 1;
            gain.gain.value = 0;
            wetGain.gain.value = 1;
            source.connect(gain);
            gain.connect(this.loopReaderGateGain);
            wetGain.connect(this.loopReaderGateGain);
            source.start(now, wrapLoopPhase(this.loopTransportCanonicalPhaseSeconds, this.audioBuffer.duration));
            // Publish only after the dry reader started successfully.
            this.sourceGainNode?.disconnect();
            this.sourceGainNode?.connect(wetGain);
            this.retiringSourceGainNode?.disconnect();
            this.retiringSourceGainNode?.connect(wetGain);
            this.loopTransportDrySourceNode = source;
            this.loopTransportDryGainNode = gain;
            this.loopTransportWetMixGainNode = wetGain;
            return true;
        } catch {
            this.stopAndDisconnectBufferSource(source, gain);
            try { wetGain?.disconnect(); } catch { /* failed setup */ }
            // Restore the original live path if reconnecting failed.
            try { this.sourceGainNode?.connect(this.loopReaderGateGain); } catch { /* unavailable graph */ }
            try { this.retiringSourceGainNode?.connect(this.loopReaderGateGain); } catch { /* unavailable graph */ }
            return false;
        }
    }

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
                state.targetRate = loopMotorTargetRate(slot.vinylFlickSpeed);
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
        this.loopTransportCanonicalPhaseSeconds += elapsed;
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
            if (Math.abs(state.rate - state.targetRate) <= 1e-5 && Math.abs(state.velocity) <= 1e-5) continue;
            returnTime = Math.max(returnTime, state.returnTimeSeconds);
        }
        return Math.min(LOOP_MOTOR_MAX_AUTOMATION_SECONDS, Math.max(0.2, returnTime * 20));
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
            source.loop = this.track.oneShot !== 'ON';
            gain.gain.value = gainValue;
            source.connect(gain);
            gain.connect(this.loopTransportWetMixGainNode ?? this.loopReaderGateGain);
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
        if (this.track.oneShot === 'ON') this.attachOneShotEnd(replacement.source, this.playbackRevision, replacement.gain);
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
        // A pending change can also reanchor a Vinyl wet head to canonical
        // transport even when the numeric BEAT SHIFT offset did not change.
        this.retargetLoopTransportSource(desiredShift, this.getLoopTransportCrossfadeMs());
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

    public autoRecArmed = false;

    public async startRecording(quantizedStartFrame?: number, quantizedPhaseRevision?: number, quantizedTrackSyncRevision?: number, sharedCaptureRetryCount = 0) {
        if (this.disposed) return;
        if (this.autoRecArmed || this.recordingStarting || this.isRecording || this.isFinalizingRecording
            || this.overdubStarting || this.overdubProcessor || this.pendingClear) {
            if (quantizedStartFrame !== undefined) this.failQuantizedRecordingStart('The track became busy before the quantized start could be reserved. Existing loops are preserved.');
            return;
        }

        if (this.state === TrackState.EMPTY) {
            this.clearMarkInternal();
            this.hasCommittedOverdub = false;
            this.markFailureReason = null;
        }

        this.clearRecordingCaptureStopAckTimeout();
        const generation = ++this.recordingStartGeneration;
        this.recordingCaptureStartCancelled = false;
        this.recordingStarting = true;
        try {
            const ctx = this.engine.context;
            // Anchor to the input worklet's AudioContext timeline before any
            // awaited setup. If input is not already authorized and warm, use
            // the legacy path rather than pretending a later frame was the
            // user's requested start boundary.
            const autoRec = this.engine.getBrowserAutoRecSettings?.();
            const autoRecEnabled = autoRec?.enabled === true;
            const bounceSourceMask = this.engine.getBrowserBounceSourceMask?.(this.trackIndex) ?? 0;
            const bounceEnabled = bounceSourceMask !== 0;
            if (quantizedStartFrame !== undefined) {
                if (!this.isQuantizedStartCurrent(quantizedPhaseRevision, quantizedTrackSyncRevision)) {
                    this.failQuantizedRecordingStart('The audio-clock phase or shared capture path changed before the quantized start was reserved. Existing loops are preserved.');
                    return;
                }
            }
            if (autoRecEnabled && this.track.loopSyncSw === 'ON' && this.engine.getRecordPlaySettings?.().quantize !== 'OFF' && this.transport.hasMasterTrack()) {
                const masterTrackId = this.transport.masterTrackId;
                const masterLoopSync = masterTrackId === null
                    ? null : this.engine.isBrowserTrackLoopSyncEnabled?.(masterTrackId) ?? null;
                if (masterLoopSync !== false) {
                    this.recordingDiagnostic = masterLoopSync === true
                        ? 'AutoRec with measure-quantized start is unavailable; set QUANTIZE OFF. Existing loops are preserved.'
                        : 'AutoRec cannot verify the master LOOP SYNC state for quantized recording. Existing loops are preserved.';
                    return;
                }
            }
            let requestedCaptureFrame = quantizedStartFrame ?? this.engine.getInputCaptureRequestFrame?.() ?? null;
            const sharedCaptureRequired = autoRecEnabled || bounceEnabled;
            if (sharedCaptureRequired && !this.engine.beginInputCaptureSession) {
                if (quantizedStartFrame !== undefined) {
                    this.failQuantizedRecordingStart('The required shared capture path is unavailable; existing loops are preserved.');
                    return;
                }
                this.recordingDiagnostic = `${autoRecEnabled ? 'AutoRec' : 'Bounce'} requires ready shared input capture. Enable audio/input and retry; existing loops are preserved.`;
                return;
            }
            const input = await this.engine.getProcessedInputNode();
            if (generation !== this.recordingStartGeneration || this.isRecording || this.isFinalizingRecording) return;
            if (quantizedStartFrame !== undefined) {
                if (!this.isQuantizedStartCurrent(quantizedPhaseRevision, quantizedTrackSyncRevision)) {
                    this.failQuantizedRecordingStart('The audio-clock phase or LOOP SYNC setting changed during capture setup. Existing loops are preserved.');
                    return;
                }
                // A shared tap can invalidate its pre-roll while the input
                // monitor path is being prepared. Confirm readiness in the
                // worklet's message order before reserving, then keep the
                // already chosen master-grid frame only if it has not passed.
                // Never move the target to a later measure to hide a gap.
                if (this.engine.waitForInputCaptureReady) {
                    try {
                        await this.engine.waitForInputCaptureReady();
                    } catch (error) {
                        if (generation !== this.recordingStartGeneration) return;
                        this.failQuantizedRecordingStart(`Shared input capture was not ready before the quantized frame could be reserved: ${error instanceof Error ? error.message : String(error)}. Existing loops are preserved.`);
                        return;
                    }
                    if (generation !== this.recordingStartGeneration || this.isRecording || this.isFinalizingRecording) return;
                    const readyFrame = this.engine.getInputCaptureRequestFrame?.();
                    if (!this.isQuantizedStartCurrent(quantizedPhaseRevision, quantizedTrackSyncRevision)) {
                        this.failQuantizedRecordingStart('The audio-clock phase or LOOP SYNC setting changed while shared capture readiness was confirmed. Existing loops are preserved.');
                        return;
                    }
                    if (readyFrame === null || readyFrame === undefined || readyFrame > quantizedStartFrame) {
                        this.failQuantizedRecordingStart('Shared input capture became ready after the reserved master-grid frame had passed; the recording was cancelled without moving the start. Existing loops are preserved.');
                        return;
                    }
                }
            }
            if (sharedCaptureRequired && quantizedStartFrame === undefined) {
                try {
                    // Immediate user starts have no externally specified frame
                    // to preserve. Confirm current readiness in the worklet,
                    // then sample a fresh frame immediately before reserving.
                    await this.engine.waitForInputCaptureReady?.();
                } catch (error) {
                    if (generation !== this.recordingStartGeneration) return;
                    this.recordingDiagnostic = `${autoRecEnabled ? 'AutoRec' : 'Bounce'} could not start because shared input capture did not rewarm: ${error instanceof Error ? error.message : String(error)}. Existing loops are preserved.`;
                    this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY;
                    this.syncTransportState();
                    return;
                }
                if (generation !== this.recordingStartGeneration || this.isRecording || this.isFinalizingRecording) return;
                requestedCaptureFrame = this.engine.getInputCaptureRequestFrame?.() ?? null;
            }
            if (sharedCaptureRequired && requestedCaptureFrame === null) {
                this.recordingDiagnostic = `${autoRecEnabled ? 'AutoRec' : 'Bounce'} requires ready shared input capture. Enable audio/input and retry; existing loops are preserved.`;
                this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY;
                this.syncTransportState();
                return;
            }
            if (autoRecEnabled) {
                const current = this.engine.getBrowserAutoRecSettings?.();
                if (!current?.enabled || current.sensitivity !== autoRec!.sensitivity) return;
            }
            this.resumeAfterRecording = true;

            // Begin with the conservative stereo limit until the worklet reports
            // the source's actual channel count. It recalculates this from the same
            // 384 MiB total PCM byte cap for mono input.
            const maxRecordingFrames = Math.floor(MAX_RECORDING_CAPTURE_BYTES / Float32Array.BYTES_PER_ELEMENT / MAX_RECORDING_CHANNELS);
            this.clearRecordingChunkStorage();
            this.pendingRecordingComplete = null;
            this.recordingFramesCaptured = 0;
            this.recordingDroppedFrames = 0;
            this.recordingOverflowEvents = 0;
            this.recordingMaximumFrames = maxRecordingFrames;
            this.recordingMaximumDurationSeconds = maxRecordingFrames / ctx.sampleRate;
            this.recordingLimitReached = false;
            this.recordingDiagnostic = null;
            this.recordingCaptureChunkIndices.fill(-1);

            if (requestedCaptureFrame !== null && this.engine.beginInputCaptureSession) {
                let captureSession: InputCaptureSession | null = null;
                const onCaptureMessage = (message: unknown) => {
                    if (captureSession) this.handleRecordingMessage(captureSession.node, message as RecordingWorkletMessage);
                };
                captureSession = bounceEnabled
                    ? this.engine.beginInputCaptureSession(this.trackIndex, requestedCaptureFrame, onCaptureMessage,
                        undefined, autoRecEnabled ? browserAutoRecThreshold(autoRec!.sensitivity) : undefined, bounceSourceMask)
                    : autoRecEnabled
                        ? this.engine.beginInputCaptureSession(this.trackIndex, requestedCaptureFrame, onCaptureMessage,
                            undefined, browserAutoRecThreshold(autoRec!.sensitivity))
                        : this.engine.beginInputCaptureSession(this.trackIndex, requestedCaptureFrame, onCaptureMessage);
                if (captureSession) {
                    this.recordingCaptureSession = captureSession;
                    this.recordingCaptureStartAcknowledged = false;
                    this.recordingCaptureStartRetryCount = sharedCaptureRetryCount;
                    if (quantizedStartFrame !== undefined) {
                        this.quantizedRecordingStartFrame = quantizedStartFrame;
                        this.quantizedRecordingPhaseRevision = quantizedPhaseRevision ?? null;
                        this.quantizedRecordingTrackSyncRevision = quantizedTrackSyncRevision ?? null;
                    }
                    this.workletNode = captureSession.node;

                    // Preserve the existing live-input/track-FX route while
                    // the engine-owned shared tap independently captures PCM.
                    try {
                        input.connect(this.fxChain.input);
                    } catch (error) {
                        this.recordingDiagnostic = `Could not connect the live recording monitor path: ${error instanceof Error ? error.message : String(error)}.`;
                        this.abortSharedRecording(captureSession, true);
                        if (quantizedStartFrame !== undefined) this.failQuantizedRecordingStart('The quantized capture monitor setup failed; the previous loop was kept.');
                        return;
                    }
                    this.recordingInputNode = input;
                    this.autoRecArmed = autoRecEnabled;
                    this.isRecording = !autoRecEnabled;
                    this.state = autoRecEnabled || quantizedStartFrame !== undefined ? TrackState.REC_STANDBY : TrackState.RECORDING;
                    return;
                }
                if (autoRecEnabled || bounceEnabled) {
                    if (quantizedStartFrame !== undefined) this.failQuantizedRecordingStart('The shared capture path could not reserve the quantized audio frame. Existing loops are preserved.');
                    else this.recordingDiagnostic = `${autoRecEnabled ? 'AutoRec' : 'Bounce'} could not reserve shared capture. Existing loops are preserved.`;
                    return;
                }
                this.recordingDiagnostic = 'Shared capture was unavailable at the requested frame; using the legacy recorder.';
            } else if (this.engine.getInputCaptureRequestFrame && requestedCaptureFrame === null) {
                this.recordingDiagnostic = 'Shared input capture was not ready at the request frame; the legacy recorder starts after input setup.';
            }

            if (quantizedStartFrame !== undefined) {
                this.failQuantizedRecordingStart('The shared capture path could not reserve the verified quantized audio frame. Existing loops are preserved.');
                return;
            }

            const workletNode = new AudioWorkletNode(ctx, 'looper-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [MAX_RECORDING_CHANNELS],
                channelCount: MAX_RECORDING_CHANNELS,
                channelCountMode: 'max',
                processorOptions: {
                    chunkSize: RECORDING_CHUNK_SIZE,
                    chunkPoolSize: RECORDING_CHUNK_POOL_SIZE,
                    maxRecordingBytes: MAX_RECORDING_CAPTURE_BYTES,
                },
            });

            workletNode.port.onmessage = (event) => {
                this.handleRecordingMessage(workletNode, event.data as RecordingWorkletMessage);
            };

            input.connect(workletNode);
            this.recordingInputNode = input;
            workletNode.connect(this.fxChain.input);

            this.workletNode = workletNode;

            this.isRecording = true;
            this.state = TrackState.RECORDING;

            workletNode.port.postMessage({ type: 'START_RECORD' });
        } catch (error) {
            if (quantizedStartFrame !== undefined) {
                if (generation === this.recordingStartGeneration) {
                    this.failQuantizedRecordingStart(`Quantized recording setup failed: ${error instanceof Error ? error.message : String(error)}. Existing loops are preserved.`);
                }
                return;
            }
            throw error;
        } finally {
            if (generation === this.recordingStartGeneration) this.recordingStarting = false;
        }
    }

    private failQuantizedRecordingStart(message: string): void {
        this.abortRecording();
        this.recordingDiagnostic = message;
        this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY;
        this.syncTransportState();
    }

    private isQuantizedStartCurrent(phaseRevision?: number, trackSyncRevision?: number): boolean {
        const masterTrackId = this.transport.masterTrackId;
        const inputFrame = this.engine.getInputCaptureRequestFrame?.();
        return phaseRevision === this.transport.masterPhaseRevision
            && trackSyncRevision === this.loopSyncSettingsRevision
            && this.track.loopSyncSw === 'ON' && masterTrackId !== null
            && this.engine.isBrowserTrackLoopSyncEnabled?.(masterTrackId) === true
            && this.engine.isBrowserRhythmRunning?.() !== true
            && inputFrame !== null && inputFrame !== undefined
            && !!this.engine.beginInputCaptureSession;
    }

    public async stopRecording(quantizedStopFrame?: number) {
        this.recordingStartRetrySuppressionGeneration += 1;
        if (this.recordingCaptureSession && !this.recordingCaptureStartAcknowledged) {
            this.recordingCaptureStartCancelled = true;
        }
        if (this.disposed) return;
        if (this.autoRecArmed) { this.triggerStop(); return; }
        if ((!this.isRecording && !this.isFinalizingRecording) || !this.workletNode) return;

        this.isRecording = false;
        this.isFinalizingRecording = true;
        if (quantizedStopFrame === undefined) {
            this.quantizedRecordingStopFrame = null;
            this.quantizedRecordingStopPhaseRevision = null;
            this.quantizedRecordingStopTrackSyncRevision = null;
        }
        const captureSession = this.recordingCaptureSession;
        if (quantizedStopFrame !== undefined && !captureSession) {
            this.recordingDiagnostic = 'The shared capture path is unavailable; the take stopped at the current audio frame without claiming quantization.';
            this.workletNode.port.postMessage({ type: 'STOP_RECORD' });
            return;
        }
        if (captureSession) {
            const requestedStopFrame = quantizedStopFrame ?? this.engine.getInputCaptureRequestFrame?.();
            const stopFrame = requestedStopFrame === null || requestedStopFrame === undefined
                ? null : Math.max(requestedStopFrame, captureSession.startFrame);
            if (stopFrame === null || stopFrame === undefined
                || !this.engine.stopInputCaptureSession?.(captureSession, stopFrame)) {
                this.recordingDiagnostic = 'The shared input capture could not acknowledge the requested stop frame; the take was discarded.';
                this.abortSharedRecording(captureSession, true);
            } else {
                this.armRecordingCaptureStopAckTimeout(captureSession);
            }
            return;
        }
        this.workletNode.port.postMessage({ type: 'STOP_RECORD' });
    }

    /** Stop a capture whose live input has ended without committing silent PCM. */
    public handleInputUnavailable(reason: string): void {
        if (this.disposed) return;
        const detail = reason.trim() || 'The input device became unavailable.';
        const recordingWasActive = this.recordingStarting || this.isRecording || this.isFinalizingRecording;
        const captureSession = this.recordingCaptureSession;
        if (captureSession) {
            this.recordingDiagnostic = `${detail} The recording was discarded and the previous loop was kept; recording can be retried.`;
            this.abortSharedRecording(captureSession, true);
        } else if (recordingWasActive) {
            this.abortRecording();
            this.recordingDiagnostic = `${detail} The recording was discarded and the previous loop was kept; recording can be retried.`;
            this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY;
            this.syncTransportState();
        }

        const overdubWasActive = !!this.overdubProcessor || this.overdubStarting
            || this.overdubCaptureSession !== null || this.state === TrackState.OVERDUBBING;
        if (!overdubWasActive) return;

        const overdubCaptureSession = this.overdubCaptureSession;
        if (overdubCaptureSession) this.failOverdubCapture(overdubCaptureSession, 'input-device-ended');

        if (this.overdubProcessor) {
            const rollbackSucceeded = this.overdubRollbackRestored || this.restorePreOverdubPcm();
            this.overdubRollbackAborted = true;
            if (!rollbackSucceeded) this.invalidatePcmHistoryForEdit();
            if (this.state === TrackState.OVERDUBBING) this.state = TrackState.PLAYING;
            this.stopOverdub();
            this.overdubDiagnostic = rollbackSucceeded
                ? `${detail} The overdub was stopped and its complete PCM edit was rolled back; the previous loop and undo history were kept.`
                : `${detail} The overdub was stopped, but its rollback image was unavailable; partial PCM may remain.`;
            this.syncTransportState();
            return;
        }

        // No processor can have committed an overdub patch yet. Invalidate any
        // pending asynchronous start and release its reserved history image.
        this.overdubStartGeneration += 1;
        this.overdubStarting = false;
        if (this.overdubCaptureSession) this.releaseOverdubCaptureSession(this.overdubCaptureSession, true);
        if (!this.overdubHasEdited) this.releasePendingOverdubSnapshot();
        this.overdubBaselineSnapshot = null;
        this.overdubStopRollbackJournal = null;
        this.overdubRollbackAborted = false;
        this.overdubRollbackRestored = false;
        if (this.state === TrackState.OVERDUBBING) this.state = this.audioBuffer ? TrackState.PLAYING : TrackState.EMPTY;
        this.overdubDiagnostic = `${detail} The overdub was cancelled before audio processing; the previous loop and undo history were kept.`;
        this.syncTransportState();
        this.restoreLoopTransportAfterOverdub();
    }

    private handleRecordingMessage(workletNode: AudioWorkletNode, message: RecordingWorkletMessage) {
        if (this.disposed || this.workletNode !== workletNode || !message) return;
        const captureSession = this.recordingCaptureSession;
        if (captureSession && ('sessionId' in message
            && (message.sessionId !== captureSession.sessionId
                || message.inputGeneration !== captureSession.inputGeneration))) return;

        if (message.type === 'CAPTURE_ERROR') {
            if (captureSession) {
                const retryBeforeStartAck = !this.recordingCaptureStartAcknowledged
                    && !this.recordingCaptureStartCancelled
                    && this.quantizedRecordingStartFrame === null
                    && sharedCaptureRetryReasons.has(message.reason || '')
                    && this.recordingCaptureStartRetryCount < 1;
                const retryCount = this.recordingCaptureStartRetryCount;
                const timing = Number.isSafeInteger(message.requestedStartFrame)
                    && Number.isSafeInteger(message.startReceivedFrame)
                    && Number.isSafeInteger(message.preRollCapacityFrames)
                    ? ` Start request R=${message.requestedStartFrame}; tap received it at F=${message.startReceivedFrame}`
                        + ` (age ${message.startReceivedFrame! - message.requestedStartFrame!} frames, capacity ${message.preRollCapacityFrames} frames)`
                        + `; retained [${message.oldestAvailableFrame ?? 'unknown'}, ${message.latestAvailableFrame ?? 'unknown'}),`
                        + ` callback=${message.previousCallbackEndFrame ?? 'unknown'}→${message.callbackFrameStart ?? 'unknown'}`
                        + ` (pre-roll ended ${message.preRollEndAtCallbackStart ?? 'unknown'}),`
                        + ` ${message.preRollValidFrames ?? 'unknown'} valid preroll frames, ready=${message.inputReady ?? 'unknown'},`
                        + ` generation=${message.inputGeneration}/${message.currentInputGeneration ?? 'unknown'},`
                        + ` rate=${message.sampleRate ?? 'unknown'} Hz.`
                    : '';
                this.recordingDiagnostic = `Shared input capture failed: ${message.reason || 'unknown error'}.${timing} The previous track audio was kept; recording can be retried.`;
                this.abortSharedRecording(captureSession, true);
                if (retryBeforeStartAck && this.engine.waitForInputCaptureReady) {
                    const retryGeneration = this.recordingStartGeneration;
                    const retrySuppressionGeneration = this.recordingStartRetrySuppressionGeneration;
                    queueMicrotask(async () => {
                        try {
                            await this.engine.waitForInputCaptureReady?.();
                            if (this.disposed || this.recordingStartGeneration !== retryGeneration
                                || this.recordingStartRetrySuppressionGeneration !== retrySuppressionGeneration
                                || this.pendingClear || this.recordingStarting || this.isRecording || this.isFinalizingRecording) return;
                            await this.startRecording(undefined, undefined, undefined, retryCount + 1);
                        } catch (error) {
                            if (!this.disposed && this.recordingStartGeneration === retryGeneration
                                && this.recordingStartRetrySuppressionGeneration === retrySuppressionGeneration) {
                                this.recordingDiagnostic = `Immediate recording retry stopped during shared capture rewarm: ${error instanceof Error ? error.message : String(error)}. The previous track audio was kept; retry when input is ready.`;
                            }
                        }
                    });
                }
            }
            return;
        }

        if (message.type === 'RECORD_ABORTED') {
            if (captureSession) {
                this.recordingDiagnostic = 'Shared input capture was aborted; the previous track audio was kept.';
                this.abortSharedRecording(captureSession, false);
            }
            return;
        }

        if (captureSession && message.type === 'RECORD_COMPLETE') {
            const rangeLength = Number.isSafeInteger(message.requestedStartFrame)
                && message.requestedStartFrame === captureSession.startFrame
                && Number.isSafeInteger(message.stopFrame)
                && message.stopFrame! >= captureSession.startFrame
                ? message.stopFrame! - captureSession.startFrame
                : -1;
            if (rangeLength < 0 || !Number.isSafeInteger(message.framesCaptured)
                || message.framesCaptured < 0 || message.framesCaptured > rangeLength) {
                this.recordingDiagnostic = 'Shared capture returned an invalid frame-range acknowledgement; the previous track audio was kept.';
                this.abortSharedRecording(captureSession, true);
                return;
            }
        }

        if (message.type === 'RECORD_CONFIGURED') {
            if (captureSession) this.recordingCaptureStartAcknowledged = true;
            if (captureSession && this.quantizedRecordingStartFrame !== null) {
                const masterTrackId = this.transport.masterTrackId;
                const phaseIsCurrent = this.quantizedRecordingPhaseRevision === this.transport.masterPhaseRevision;
                const trackSyncIsCurrent = this.quantizedRecordingTrackSyncRevision === this.loopSyncSettingsRevision;
                const acknowledgedFrame = message.captureStartFrame === this.quantizedRecordingStartFrame
                    && message.requestedStartFrame === this.quantizedRecordingStartFrame
                    && captureSession.startFrame === this.quantizedRecordingStartFrame;
                const syncIsCurrent = this.track.loopSyncSw === 'ON' && masterTrackId !== null
                    && this.engine.isBrowserTrackLoopSyncEnabled?.(masterTrackId) === true
                    && this.engine.isBrowserRhythmRunning?.() !== true;
                if (!phaseIsCurrent || !trackSyncIsCurrent || !acknowledgedFrame || !syncIsCurrent) {
                    this.recordingDiagnostic = 'The master phase or LOOP SYNC setting changed before the worklet start acknowledgement; the scheduled capture was cancelled and the previous loop was kept.';
                    this.abortSharedRecording(captureSession, true);
                    return;
                }
                this.quantizedRecordingStartFrame = null;
                this.quantizedRecordingPhaseRevision = null;
                this.quantizedRecordingTrackSyncRevision = null;
                this.isRecording = true;
                this.state = TrackState.RECORDING;
                this.syncTransportState();
            }
            if (this.autoRecArmed) {
                this.autoRecArmed = false; this.isRecording = true; this.state = TrackState.RECORDING;
                this.ensureTransportRunning();
            }
            const channelCount = Number.isInteger(message.channelCount)
                ? Math.max(1, Math.min(MAX_RECORDING_CHANNELS, message.channelCount))
                : 1;
            // The worklet config message is ordered before any associated
            // chunks. Reject a mid-stream format change rather than mixing
            // incompatible channel layouts in one loop.
            if (this.recordingStoredFrames === 0) {
                this.recordingChannelCount = channelCount;
                this.recordingMaximumFrames = Math.max(0, Math.floor(message.maxRecordingFrames));
                this.recordingMaximumDurationSeconds = this.recordingMaximumFrames / this.engine.context.sampleRate;
            } else if (channelCount !== this.recordingChannelCount) {
                this.recordingDiagnostic = 'Input channel count changed during recording; later audio was ignored.';
                this.recordingOverflowEvents += 1;
            }
            return;
        }

        if (message.type === 'RECORD_CHUNK') {
            this.acceptRecordingChunk(workletNode, message);
            return;
        }

        if (message.type === 'RECORD_COMPLETE') {
            // The worklet also completes itself at the PCM capture limit,
            // without a preceding control-thread stopRecording() call.
            this.isRecording = false;
            this.isFinalizingRecording = true;
            this.quantizedRecordingStopFrame = null;
            this.quantizedRecordingStopPhaseRevision = null;
            this.quantizedRecordingStopTrackSyncRevision = null;
            this.pendingRecordingComplete = message;
            this.finishRecordingWhenReady(workletNode);
            return;
        }
    }

    private acceptRecordingChunk(
        workletNode: AudioWorkletNode,
        message: Extract<RecordingWorkletMessage, { type: 'RECORD_CHUNK' }>,
    ) {
        const captureSession = this.recordingCaptureSession;
        const channels = Array.isArray(message.channels)
            ? message.channels
            : message.samples instanceof Float32Array ? [message.samples] : null;
        this.recordingReceivedChunkMessages += 1;
        if (!channels || channels.length < 1 || channels.length > MAX_RECORDING_CHANNELS
            || channels.some((samples) => !(samples instanceof Float32Array))
            || (channels.length === 2 && channels[0]!.length !== channels[1]!.length)) {
            this.recordingOverflowEvents += 1;
            if (captureSession && channels) this.recycleSharedCaptureChunk(captureSession, message.chunkIndex, channels);
            this.finishRecordingWhenReady(workletNode);
            return;
        }

        const channelCount = typeof message.channelCount === 'number' && Number.isInteger(message.channelCount)
            ? Math.max(1, Math.min(MAX_RECORDING_CHANNELS, message.channelCount))
            : channels.length;
        if (channelCount !== channels.length) {
            this.recordingOverflowEvents += 1;
            if (captureSession) this.recycleSharedCaptureChunk(captureSession, message.chunkIndex, channels);
            this.finishRecordingWhenReady(workletNode);
            return;
        }

        const sequence = Number.isInteger(message.sequence) ? message.sequence : -1;
        const validFrames = Number.isFinite(message.validFrames)
            ? Math.max(0, Math.min(
                Math.floor(message.validFrames),
                ...channels.map((samples) => samples.length),
            ))
            : 0;
        if (captureSession) {
            const expectedStartFrame = captureSession.startFrame + (sequence * RECORDING_CHUNK_SIZE);
            const frameBoundaryValid = Number.isSafeInteger(expectedStartFrame)
                && Number.isSafeInteger(message.startFrame) && message.startFrame === expectedStartFrame;
            const chunkShapeValid = channels.every((samples) => samples.length === RECORDING_CHUNK_SIZE)
                && Number.isInteger(message.chunkIndex) && message.chunkIndex >= 0
                && message.chunkIndex < RECORDING_CHUNK_POOL_SIZE;
            if (!frameBoundaryValid || !chunkShapeValid || validFrames <= 0 || validFrames > RECORDING_CHUNK_SIZE) {
                this.recordingOverflowEvents += 1;
                this.recordingDiagnostic = 'Shared capture returned an invalid chunk boundary; the malformed chunk was discarded.';
                this.recycleSharedCaptureChunk(captureSession, message.chunkIndex, channels);
                this.finishRecordingWhenReady(workletNode);
                return;
            }
        }
        if (this.recordingStoredFrames === 0) this.recordingChannelCount = channelCount;
        if (channelCount !== this.recordingChannelCount) {
            this.recordingOverflowEvents += 1;
            this.recordingDiagnostic = 'Input channel count changed during recording; later audio was ignored.';
            if (captureSession) this.recycleSharedCaptureChunk(captureSession, message.chunkIndex, channels);
            this.finishRecordingWhenReady(workletNode);
            return;
        }

        const hasAvailableSlot = sequence >= 0 && sequence < MAX_RECORDING_CHUNKS;
        const isNewSequence = hasAvailableSlot && this.receivedChunkFlags[sequence] === 0;
        const withinPcmBudget = (this.recordingStoredFrames + validFrames)
            * channelCount * Float32Array.BYTES_PER_ELEMENT <= MAX_RECORDING_CAPTURE_BYTES;
        if (isNewSequence && validFrames > 0 && withinPcmBudget) {
            // Keep ownership of the transferred data on the main thread. It remains a
            // fixed-size chunk; only the small reference table grows (and it is preallocated).
            this.recordedChunks[sequence] = channels;
            this.recordedChunkLengths[sequence] = validFrames;
            this.receivedChunkFlags[sequence] = 1;
            if (captureSession) this.recordingCaptureChunkIndices[sequence] = message.chunkIndex;
            this.recordingChunkCount += 1;
            this.recordingStoredFrames += validFrames;
            this.recordingFramesCaptured = this.recordingStoredFrames;
        } else {
            this.recordingOverflowEvents += 1;
            if (!withinPcmBudget) this.recordingDiagnostic = 'Recording exceeded the 384 MiB per-track PCM capture budget; excess frames were discarded.';
            if (captureSession) this.recycleSharedCaptureChunk(captureSession, message.chunkIndex, channels);
        }

        // Replenish the worklet's fixed pool with a fresh fixed-size buffer. The original
        // chunk stays main-thread-owned for final assembly. This allocation happens only
        // when a chunk message arrives, never in the audio rendering callback.
        if (
            isNewSequence && withinPcmBudget && channels.every((samples) => validFrames === samples.length) &&
            channels.every((samples) => samples.length === RECORDING_CHUNK_SIZE) &&
            (captureSession !== null || !this.isFinalizingRecording) &&
            message.chunkIndex >= 0 && message.chunkIndex < RECORDING_CHUNK_POOL_SIZE
        ) {
            const replacements = channels.map(() => new Float32Array(RECORDING_CHUNK_SIZE));
            if (captureSession) {
                if (this.recycleSharedCaptureChunk(captureSession, message.chunkIndex, replacements)) {
                    this.recordingCaptureChunkIndices[sequence] = -1;
                }
            } else {
                this.recycleChunkMessage.chunkIndex = message.chunkIndex;
                this.recycleChunkMessage.samples = replacements[0] ?? null;
                this.recycleChunkMessage.channels = replacements;
                this.recycleChunkTransferList.length = replacements.length;
                replacements.forEach((replacement, channel) => {
                    this.recycleChunkTransferList[channel] = replacement.buffer;
                });
                workletNode.port.postMessage(this.recycleChunkMessage, this.recycleChunkTransferList);
            }
        }

        this.finishRecordingWhenReady(workletNode);
    }

    private recycleSharedCaptureChunk(
        session: InputCaptureSession,
        chunkIndex: number,
        channels: Float32Array[],
    ): boolean {
        const recycled = this.engine.recycleInputCaptureChunk?.(session, chunkIndex, channels) === true;
        if (!recycled) {
            this.recordingDiagnostic = 'A shared-capture buffer could not be returned to its bounded pool; a later recording may be refused.';
        }
        return recycled;
    }

    private returnRetainedSharedCaptureChunks(session: InputCaptureSession): void {
        for (let sequence = 0; sequence < MAX_RECORDING_CHUNKS; sequence += 1) {
            const chunkIndex = this.recordingCaptureChunkIndices[sequence];
            if (chunkIndex === undefined || chunkIndex < 0) continue;
            const channels = this.recordedChunks[sequence];
            if (channels) this.recycleSharedCaptureChunk(session, chunkIndex, channels);
            this.recordingCaptureChunkIndices[sequence] = -1;
        }
    }

    private abortSharedRecording(session: InputCaptureSession, requestAbort: boolean): void {
        if (this.recordingCaptureSession !== session) return;
        this.clearRecordingCaptureStopAckTimeout();
        if (requestAbort) this.engine.abortInputCaptureSession?.(session);
        this.returnRetainedSharedCaptureChunks(session);
        this.engine.releaseInputCaptureSession?.(session);
        this.recordingCaptureSession = null;
        this.quantizedRecordingStartFrame = null;
        this.quantizedRecordingPhaseRevision = null;
        this.quantizedRecordingTrackSyncRevision = null;
        this.quantizedRecordingStopFrame = null;
        this.quantizedRecordingStopPhaseRevision = null;
        this.quantizedRecordingStopTrackSyncRevision = null;
        try { this.recordingInputNode?.disconnect(this.fxChain.input); } catch { /* already disconnected */ }
        this.recordingInputNode = null;
        if (this.workletNode === session.node) this.workletNode = null;
        this.recordingStartGeneration += 1;
        this.recordingStarting = false;
        this.autoRecArmed = false;
        this.isRecording = false;
        this.isFinalizingRecording = false;
        this.resumeAfterRecording = true;
        this.clearRecordingChunkStorage();
        this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY;
        this.syncTransportState();
    }

    private armRecordingCaptureStopAckTimeout(session: InputCaptureSession): void {
        this.clearRecordingCaptureStopAckTimeout();
        this.recordingCaptureStopAckTimeout = setTimeout(() => {
            this.recordingCaptureStopAckTimeout = null;
            if (this.recordingCaptureSession !== session || !this.isFinalizingRecording) return;
            const contextState = this.engine.context.state ?? 'unknown';
            this.recordingDiagnostic = `Shared input capture did not complete stop within ${RECORDING_CAPTURE_STOP_ACK_TIMEOUT_MS} ms (AudioContext state: ${contextState}); the incomplete take was discarded and the previous loop/history were preserved. Resume audio and retry.`;
            this.abortSharedRecording(session, true);
        }, RECORDING_CAPTURE_STOP_ACK_TIMEOUT_MS);
    }

    private clearRecordingCaptureStopAckTimeout(): void {
        if (this.recordingCaptureStopAckTimeout !== null) clearTimeout(this.recordingCaptureStopAckTimeout);
        this.recordingCaptureStopAckTimeout = null;
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
        this.clearRecordingCaptureStopAckTimeout();
        if (Number.isFinite(message.maxRecordingFrames) && message.maxRecordingFrames > 0) {
            this.recordingMaximumFrames = Math.floor(message.maxRecordingFrames);
            this.recordingMaximumDurationSeconds = this.recordingMaximumFrames / this.engine.context.sampleRate;
        }
        const reportedFrames = Number.isFinite(message.framesCaptured)
            ? Math.max(0, Math.floor(message.framesCaptured))
            : this.recordingStoredFrames;
        const finalFrames = Math.min(reportedFrames, this.recordingStoredFrames);
        const missingFrames = Math.max(0, reportedFrames - finalFrames);

        this.recordingFramesCaptured = finalFrames;
        this.recordingDroppedFrames += Math.max(0, Number.isFinite(message.droppedFrames) ? message.droppedFrames : 0);
        this.recordingDroppedFrames += missingFrames;
        this.recordingOverflowEvents += Math.max(0, Number.isFinite(message.overflowEvents) ? message.overflowEvents : 0);
        this.recordingLimitReached = message.limitReached === true;
        if (missingFrames > 0) this.recordingOverflowEvents += 1;

        if (this.recordingLimitReached) {
            this.recordingDiagnostic = `Recording capacity reached (${Math.ceil(this.recordingMaximumDurationSeconds / 60)} min); ${this.recordingDroppedFrames} frames were dropped.`;
        } else if (this.recordingDroppedFrames > 0) {
            this.recordingDiagnostic = `Audio capture overflow dropped ${this.recordingDroppedFrames} frames.`;
        } else if (!this.recordingDiagnostic) {
            this.recordingDiagnostic = null;
        }

        const timelineOverlapEvents = Number.isSafeInteger(message.timelineOverlapEvents)
            ? Math.max(0, message.timelineOverlapEvents ?? 0) : 0;
        const timelineOverlapFrames = Number.isSafeInteger(message.timelineOverlapFrames)
            ? Math.max(0, message.timelineOverlapFrames ?? 0) : 0;
        if (timelineOverlapEvents > 0 || timelineOverlapFrames > 0) {
            const warning = `The audio timeline repeated or overlapped during capture (${timelineOverlapEvents} block(s), ${timelineOverlapFrames} frame(s) skipped); continuity cannot be verified.`;
            this.recordingDiagnostic = this.recordingDiagnostic
                ? `${this.recordingDiagnostic} ${warning}`
                : warning;
        }

        // The accepted chunks own the channel layout. A mismatched final
        // acknowledgement must never silently drop a captured right channel.
        const completedChannelCount = this.recordingChannelCount;
        if (this.recordingStoredFrames > 0 && Number.isInteger(message.channelCount)
            && message.channelCount !== completedChannelCount) {
            const warning = 'Recording completion channel count differed from captured PCM; all captured channels were preserved.';
            this.recordingDiagnostic = this.recordingDiagnostic ? `${this.recordingDiagnostic} ${warning}` : warning;
            this.recordingOverflowEvents += 1;
        }
        if (finalFrames > 0) {
            const rawBuffers = Array.from({ length: completedChannelCount }, () => new Float32Array(finalFrames));
            let writeOffset = 0;
            for (let sequence = 0; sequence < MAX_RECORDING_CHUNKS; sequence += 1) {
                if (this.receivedChunkFlags[sequence] === 0) continue;
                const chunks = this.recordedChunks[sequence];
                const length = this.recordedChunkLengths[sequence];
                if (!chunks || length === undefined || length === 0) continue;
                const copyFrames = Math.min(length, Math.max(0, finalFrames - writeOffset));
                if (copyFrames <= 0) break;
                for (let channel = 0; channel < completedChannelCount; channel += 1) {
                    const chunk = chunks[channel];
                    const rawBuffer = rawBuffers[channel];
                    if (!chunk || !rawBuffer) continue;
                    rawBuffer.set(chunk.subarray(0, copyFrames), writeOffset);
                }
                writeOffset += copyFrames;
            }

            const captureSession = this.recordingCaptureSession;
            if (captureSession) this.returnRetainedSharedCaptureChunks(captureSession);

            // Release the retained chunk references as soon as the one-time assembly is done.
            // This keeps finalization to at most the assembled float buffer plus AudioBuffer.
            const assembledBuffers = rawBuffers.map((rawBuffer) =>
                writeOffset === rawBuffer.length ? rawBuffer : rawBuffer.subarray(0, writeOffset));
            this.clearRecordingChunkStorage();
            if (assembledBuffers.length === 1) this.processRecordedBuffer(assembledBuffers[0]!);
            else this.processRecordedBuffers(assembledBuffers);
        } else {
            const captureSession = this.recordingCaptureSession;
            if (captureSession) this.returnRetainedSharedCaptureChunks(captureSession);
            // A zero-frame take never replaces PCM. Keep an existing loop
            // stopped, but leave a genuinely empty track EMPTY so Record can
            // start another take instead of routing to play() with no buffer.
            this.state = this.audioBuffer ? TrackState.STOPPED : TrackState.EMPTY;
            const emptyTakeDiagnostic = this.audioBuffer
                ? 'No input frames were captured; the previous loop was preserved.'
                : 'No input frames were captured; the track remains empty and can be recorded again.';
            this.recordingDiagnostic = this.recordingDiagnostic
                ? `${this.recordingDiagnostic} ${emptyTakeDiagnostic}`
                : emptyTakeDiagnostic;
            this.resumeAfterRecording = true;
            this.syncTransportState();
        }

        const captureSession = this.recordingCaptureSession;
        if (captureSession) {
            this.engine.releaseInputCaptureSession?.(captureSession);
            this.recordingCaptureSession = null;
        } else {
            workletNode.port.onmessage = null;
        }
        try { this.recordingInputNode?.disconnect(captureSession ? this.fxChain.input : workletNode); } catch { /* already disconnected */ }
        this.recordingInputNode = null;
        if (!captureSession) {
            workletNode.disconnect();
            workletNode.port.close?.();
        }
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
        this.recordingCaptureChunkIndices.fill(-1);
        this.recordingChunkCount = 0;
        this.recordingReceivedChunkMessages = 0;
        this.recordingStoredFrames = 0;
        this.recordingChannelCount = 1;
        this.pendingRecordingComplete = null;
    }

    private processRecordedBuffer(rawBuffer: Float32Array) {
        this.processRecordedBuffers([rawBuffer]);
    }

    private processRecordedBuffers(rawBuffers: Float32Array[]) {
        const previous = this.capturePcmSnapshot();
        const ctx = this.engine.context;
        const browserOffset = this.getBrowserRecordingOffsetConfig();
        const latencySamples = Math.round(this.engine.roundTripLatency * ctx.sampleRate);
        const frameCount = rawBuffers[0]?.length ?? 0;

        let startOffset = Math.max(0, latencySamples);
        if (startOffset >= frameCount) startOffset = 0;

        const processedLength = frameCount - startOffset;
        const processedBuffers = rawBuffers.map((rawBuffer) => {
            if (startOffset > 0) rawBuffer.copyWithin(0, startOffset);
            const processedBuffer = rawBuffer.subarray(0, processedLength);
            shiftSamplesInPlace(processedBuffer, browserOffset.recordingOffsetSamples);
            return processedBuffer;
        });

        const durationSeconds = processedLength / ctx.sampleRate;
        const lengthSamples = processedLength;

        console.log(`Track ${this.track.id} recorded: ${durationSeconds.toFixed(2)}s (${lengthSamples} samples)`);

        // ========================================
        // MASTER / SLAVE LOGIC
        // ========================================

        let finalBufferLength = lengthSamples;

        const becomesMaster = !this.transport.hasMasterTrack();
        if (!becomesMaster && this.track.loopSyncSw === 'ON') {
            const masterLength = this.transport.masterLoopLengthSamples;
            if (masterLength > 0 && Number.isFinite(masterLength)) {
                const ratio = Math.max(1, Math.round(lengthSamples / masterLength));
                finalBufferLength = ratio * masterLength;
            }
        }

        // Allocate before replacing either the live loop or its existing history.
        const completedBuffer = ctx.createBuffer(processedBuffers.length, finalBufferLength, ctx.sampleRate);
        processedBuffers.forEach((processedBuffer, channel) => {
            completedBuffer.getChannelData(channel).set(processedBuffer.subarray(0, Math.min(processedBuffer.length, finalBufferLength)));
        });
        if (!this.retainPcmEdit(previous)) this.invalidatePcmHistoryForEdit();
        this.audioBuffer = completedBuffer;
        this.projectPcmRevision += 1;
        if (becomesMaster) {
            this.transport.setMasterTrack(this.track.id, durationSeconds, ctx.sampleRate, lengthSamples);
            this.transport.start();
        }

        if (this.resumeAfterRecording) {
            this.state = TrackState.PLAYING;
            this.play();
        } else {
            this.state = TrackState.STOPPED;
            this.syncTransportState();
        }

        if (this.resumeAfterRecording && this.track.oneShot !== 'ON' && this.engine.getRecordPlaySettings?.().recAction === 'REC->DUB' && this.state === TrackState.PLAYING) {
            // Let recording finalization release its capture session before reserving overdub.
            queueMicrotask(() => { if (!this.disposed && !this.pendingClear && this.state === TrackState.PLAYING) this.triggerRecord(); });
        }
        this.resumeAfterRecording = true;
    }

    private async ensureLivePolyPitchNode(): Promise<LivePolyPitchNode> {
        if (this.disposed) throw new Error(`Track ${this.track.id} has been disposed.`);
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
                await node.releaseWasmMemory();
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
        if (this.disposed) throw new Error(`Track ${this.track.id} has been disposed.`);
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
        const oneShot = this.track.oneShot === 'ON';
        this.sourceNode.loop = !oneShot;
        this.sourceGainNode = null;
        if (this.isReverse) {
            this.sourceNode.connect(this.loopReaderGateGain);
        } else {
            // A unity per-source gain makes the normal forward BufferSource
            // path crossfadeable if a read-head effect is selected mid-loop.
            // It is a no-copy, zero-added-latency identity node by default.
            this.sourceGainNode = context.createGain();
            this.sourceGainNode.gain.value = 1;
            this.sourceNode.connect(this.sourceGainNode);
            this.sourceGainNode.connect(this.loopReaderGateGain);
        }
        this.sourceNode.playbackRate.value = this.isReverse ? -1 : 1;
        const startAt = context.currentTime;
        this.sourceNode.start(startAt, this.startOffset);
        const measureFrames = Math.round(this.transport.measureLength * context.sampleRate);
        if (this.track.id === this.transport.masterTrackId && !oneShot && !this.isReverse
            && this.track.loopSyncSw === 'ON' && this.startOffset === 0 && !this.hasConfiguredLoopTransportFx()
            && !this.liveMonoPitchActiveInternal && !this.livePolyPitchActiveInternal
            && Number.isSafeInteger(measureFrames) && Math.abs(this.audioBuffer.length - measureFrames) <= 1) {
            // The current Browser model has no recorded measure-count metadata.
            // Claim phase only when the master buffer is exactly one inferred measure.
            this.transport.establishMasterPhaseOrigin(this.track.id, Math.round(startAt * context.sampleRate), measureFrames);
        }
        if (oneShot) this.attachOneShotEnd(this.sourceNode, this.playbackRevision);
        if (oneShot && this.isReverse) {
            // Chromium keeps some negative-rate, non-looping BufferSources
            // render-active after the reverse head reaches frame zero. Schedule
            // the finite traversal's end on the audio clock as a hard boundary.
            const remainingSeconds = this.startOffset / Math.max(1e-6, Math.abs(this.sourceNode.playbackRate.value));
            this.sourceNode.stop(startAt + remainingSeconds);
        }
        this.startTime = startAt;
        this.loopTransportPlaybackInitialized = false;
        this.loopTransportTransitionActive = false;
        this.loopTransportPendingRetarget = false;
        if (!this.hasConfiguredLoopTransportFx()) this.loopTransportStartOffsetShiftSeconds = 0;
        this.state = TrackState.PLAYING;
        this.ensureTransportRunning();
    }

    private attachOneShotEnd(source: AudioBufferSourceNode, revision: number, completionGain: GainNode | null = this.sourceGainNode): void {
        source.onended = () => {
            if (this.disposed || revision !== this.playbackRevision || this.sourceNode !== source) return;
            this.sourceNode = null;
            this.sourceGainNode = null;
            this.loopTransportPlaybackInitialized = false;
            this.loopTransportTransitionActive = false;
            this.loopTransportPendingRetarget = false;
            this.stopAndDisconnectBufferSource(this.loopTransportDrySourceNode, this.loopTransportDryGainNode);
            this.loopTransportDrySourceNode = null;
            this.loopTransportDryGainNode = null;
            try { this.loopTransportWetMixGainNode?.disconnect(); } catch { /* already disconnected */ }
            this.loopTransportWetMixGainNode = null;
            this.releaseLivePolyPitchNodeForReuse();
            this.releaseLiveMonoPitchNodeForReuse();
            this.state = TrackState.STOPPED;
            if (this.sharedStates) Atomics.store(this.sharedStates, this.trackIndex, Object.values(TrackState).indexOf(TrackState.STOPPED));
            if (this.sharedPositions) this.sharedPositions[this.trackIndex] = 0;
            this.syncTransportState();
            try { source.disconnect(); } catch { /* already disconnected */ }
            try { completionGain?.disconnect(); } catch { /* already disconnected */ }
        };
    }

    private startLoopTransportBufferPlayback(): boolean {
        if (!this.audioBuffer) return false;
        const context = this.engine.context;
        const now = context.currentTime;
        const beatShiftSeconds = this.getLoopTransportBeatShiftSeconds();
        const baseOffset = this.startOffset - this.loopTransportStartOffsetShiftSeconds;

        this.loopTransportPhaseBaseSeconds = baseOffset;
        this.loopTransportCanonicalPhaseSeconds = baseOffset;
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
        if (this.track.oneShot === 'ON') this.attachOneShotEnd(initial.source, this.playbackRevision);
        if (this.hasConfiguredVinylFlick() && !this.ensureLoopTransportDryReader(now)) {
            this.stopAndDisconnectBufferSource(initial.source, initial.gain);
            this.sourceNode = null;
            this.sourceGainNode = null;
            this.loopTransportPlaybackInitialized = false;
            return false;
        }
        this.updateLoopTransportMix(now, true);
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

        node.connect(this.loopReaderGateGain);
        const inputOffsetSeconds = Math.max(0, Math.min(this.startOffset, Math.max(0, buffer.duration - 1 / buffer.sampleRate)));
        try {
            if (this.track.oneShot === 'ON') {
                await node.scheduleSegment({
                    inputOffsetSeconds,
                    inputEndSeconds: buffer.duration,
                    semitones: this.livePolyPitchSemitones,
                    playbackRate: this.livePolyPitchPlaybackRate,
                    tonalityLimitHz: this.livePolyPitchTonalityLimitHz,
                });
            } else {
                await node.scheduleLoop({
                    inputOffsetSeconds,
                    loopStartSeconds: 0,
                    loopEndSeconds: buffer.duration,
                    semitones: this.livePolyPitchSemitones,
                    playbackRate: this.livePolyPitchPlaybackRate,
                    tonalityLimitHz: this.livePolyPitchTonalityLimitHz,
                });
            }
        } catch (error) {
            disconnectAudioNodeIfConnected(node, this.loopReaderGateGain);
            this.livePolyPitchBufferReset = node.clearBuffers().catch(() => undefined);
            throw error;
        }

        if (revision !== this.playbackRevision || !this.livePolyPitchEnabledInternal || this.isReverse) {
            disconnectAudioNodeIfConnected(node, this.loopReaderGateGain);
            this.livePolyPitchBufferReset = node.clearBuffers().catch(() => undefined);
            return;
        }

        this.livePolyPitchActiveInternal = true;
        this.livePolyPitchFallbackReasonValue = null;
        this.startTime = this.engine.context.currentTime;
        this.state = TrackState.PLAYING;
        if (this.track.oneShot === 'ON') {
            const completionSource = this.engine.context.createBufferSource();
            const completionGain = this.engine.context.createGain();
            completionSource.buffer = buffer;
            completionSource.loop = false;
            completionSource.playbackRate.value = this.livePolyPitchPlaybackRate;
            completionGain.gain.value = 0;
            completionSource.connect(completionGain);
            completionGain.connect(this.engine.context.destination);
            completionSource.start(0, inputOffsetSeconds);
            this.sourceNode = completionSource;
            this.sourceGainNode = completionGain;
            this.attachOneShotEnd(completionSource, revision, completionGain);
        }
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
        const oneShot = this.track.oneShot === 'ON';
        source.loop = !oneShot;
        source.playbackRate.value = 1;
        source.connect(node);
        node.connect(this.loopReaderGateGain);
        try {
            source.start(0, Math.max(0, Math.min(this.startOffset, Math.max(0, buffer.duration - 1 / buffer.sampleRate))));
        } catch (error) {
            source.disconnect();
            node.disconnect();
            throw error;
        }

        this.sourceNode = source;
        if (oneShot) this.attachOneShotEnd(source, revision);
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
        // Native's transport cursor remains canonical while Vinyl's wet head
        // travels independently. This also keeps overdub frame indices stable.
        if (this.loopTransportDrySourceNode) return wrapLoopPhase(this.loopTransportCanonicalPhaseSeconds, duration);
        return wrapLoopPhase(this.loopTransportPhaseBaseSeconds + this.loopTransportRenderedBeatShiftSeconds, duration);
    }

    private releaseLivePolyPitchNodeForReuse() {
        const node = this.livePolyPitchNode;
        this.livePolyPitchActiveInternal = false;
        if (!node) return;
        try { void node.stopProcessing(this.engine.context.currentTime).catch(() => undefined); } catch { /* node may already be closed */ }
        disconnectAudioNodeIfConnected(node, this.loopReaderGateGain);
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
        const bufferReset = this.livePolyPitchBufferReset;
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
        try { await bufferReset; } catch { /* disposal below still owns lease release */ }
        await node.releaseWasmMemory();
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
        if (this.disposed || !this.audioBuffer || this.pendingClear) return;

        this.stop();

        // stop() snapshots a source-aware reader's current phase. For an
        // explicit one-shot start/retrigger, discard that cursor after teardown.
        if (this.track.oneShot === 'ON') {
            this.startOffset = this.isReverse
                ? Math.max(0, this.audioBuffer.duration - 1 / this.audioBuffer.sampleRate)
                : 0;
        }

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
        if (this.disposed) return;
        if (this.track.id === this.transport.masterTrackId) this.transport.clearMasterPhaseOrigin();
        if (this.autoRecArmed) this.abortRecording();
        if (this.loopTransportPlaybackInitialized && this.sourceNode && this.audioBuffer
            && (this.state === TrackState.PLAYING || this.state === TrackState.OVERDUBBING)) {
            this.startOffset = this.getLoopTransportOutputPosition();
            this.loopTransportStartOffsetShiftSeconds = this.loopTransportDrySourceNode ? 0 : this.loopTransportRenderedBeatShiftSeconds;
        }
        this.playbackRevision += 1;
        this.stopAndDisconnectBufferSource(this.sourceNode, this.sourceGainNode);
        this.stopAndDisconnectBufferSource(this.retiringSourceNode, this.retiringSourceGainNode);
        this.stopAndDisconnectBufferSource(this.loopTransportDrySourceNode, this.loopTransportDryGainNode);
        try { this.loopTransportWetMixGainNode?.gain.cancelScheduledValues(this.engine.context.currentTime); } catch { /* disconnected gain */ }
        try { this.loopTransportWetMixGainNode?.disconnect(); } catch { /* already disconnected */ }
        this.loopTransportDrySourceNode = null;
        this.loopTransportDryGainNode = null;
        this.loopTransportWetMixGainNode = null;
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

    /** True means cleared, or queued until the overdub's final patch acknowledgement. */
    public clear(): boolean {
        if (this.disposed) return false;
        this.abortRecording();
        this.overdubRestartAfterStop = false;
        if (this.overdubProcessor) {
            this.pendingClear = true;
            this.stop();
            this.stopOverdub();
            return true;
        }
        this.stopOverdub(); // Also cancel an asynchronous overdub startup.
        return this.completeClear();
    }

    private completeClear(): boolean {
        if (this.audioBuffer && !this.retainPcmEdit(this.capturePcmSnapshot())) {
            this.historyFailureReason = this.historyBudgetReason('Clear was cancelled because undo could not be retained');
            this.syncTransportState();
            return false;
        }
        this.stop();
        this.livePolyPitchEnabledInternal = false;
        this.liveMonoPitchEnabledInternal = false;
        this.livePolyPitchFallbackReasonValue = null;
        this.liveMonoPitchFallbackReasonValue = null;
        void this.disposeLivePolyPitchNode();
        void this.disposeLiveMonoPitchNode();
        this.clearMarkInternal();
        this.hasCommittedOverdub = false;
        this.markFailureReason = null;
        this.audioBuffer = null;
        this.projectPcmRevision += 1;
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
        this.restoreLoopTransportAfterOverdub();

        console.log(`Track ${this.track.id} cleared`);
        this.syncTransportState();
        return true;
    }

    public toggleReverse() {
        if (this.disposed) return;
        const wasPlaying = this.state === TrackState.PLAYING && !!this.audioBuffer;
        if (wasPlaying) {
            this.startOffset = this.getCurrentPlaybackPosition();
            this.loopTransportStartOffsetShiftSeconds = this.loopTransportPlaybackInitialized && !this.loopTransportDrySourceNode && !this.loopTransportUnavailableReason
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
        if (!audioBuffer || this.pendingClear) return;
        if (this.overdubProcessor) {
            if (this.overdubStopping) this.overdubRestartAfterStop = true;
            return;
        }

        const generation = ++this.overdubStartGeneration;
        this.overdubStarting = true;
        const dubMode = this.track.dubMode;
        this.overdubReplace2ReaderMuted = dubMode === 'REPLACE2';
        this.loopReaderGateGain.gain.value = this.overdubReplace2ReaderMuted ? 0 : 1;
        const ctx = this.engine.context;
        let createdWorklet: AudioWorkletNode | null = null;
        let createdMuteGain: GainNode | null = null;
        let captureSession: InputCaptureSession | null = null;
        let bounceSourceMix: { node: GainNode; dispose(): void } | null = null;
        let requestFrame: number | null = null;
        const bounceSourceMask = this.engine.getBrowserBounceSourceMask?.(this.trackIndex) ?? 0;

        try {
            const hasSharedCapture = typeof this.engine.getInputCaptureRequestFrame === 'function'
                && typeof this.engine.beginInputCaptureSession === 'function';
            if (hasSharedCapture) {
                requestFrame = this.engine.getInputCaptureRequestFrame!();
                if (requestFrame === null) throw new Error('The shared input capture was not ready at the overdub request frame');
                captureSession = this.beginOverdubCaptureSession(requestFrame, generation, bounceSourceMask);
                if (!captureSession) throw new Error('The shared input capture session could not be reserved at the overdub request frame');
            }

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

            const loopChannels = Array.from(
                { length: Math.max(1, Math.min(MAX_RECORDING_CHANNELS, audioBuffer.numberOfChannels)) },
                (_, channel) => new Float32Array(audioBuffer.getChannelData(channel)),
            );
            if (loopChannels[0]?.length === 0) throw new Error('The loop has no audio samples to overdub');

            const channelCount = loopChannels.length;
            this.prepareOverdubStopRollback(audioBuffer);
            const patchBuffers = Array.from({ length: OVERDUB_TRANSFER_BUFFER_POOL_SIZE }, (_, slotIndex) => ({
                slotIndex,
                indices: new Uint32Array(OVERDUB_TRANSFER_BUFFER_FRAMES),
                values: new Float32Array(OVERDUB_TRANSFER_BUFFER_FRAMES),
                oldValues: new Float32Array(OVERDUB_TRANSFER_BUFFER_FRAMES),
                ...(channelCount > 1 ? { rightValues: new Float32Array(OVERDUB_TRANSFER_BUFFER_FRAMES) } : {}),
                ...(channelCount > 1 ? { oldRightValues: new Float32Array(OVERDUB_TRANSFER_BUFFER_FRAMES) } : {}),
            }));
            const transferList: Transferable[] = loopChannels.map((samples) => samples.buffer);
            for (const buffer of patchBuffers) {
                transferList.push(buffer.indices.buffer, buffer.values.buffer, buffer.oldValues.buffer);
                if (buffer.rightValues) transferList.push(buffer.rightValues.buffer);
                if (buffer.oldRightValues) transferList.push(buffer.oldRightValues.buffer);
            }

            if (bounceSourceMask !== 0) {
                bounceSourceMix = this.engine.createBrowserBounceSourceMix?.(this.trackIndex, bounceSourceMask) ?? null;
                if (!bounceSourceMix) throw new Error('The selected Bounce source mix could not be prepared.');
            }
            const workletNode = new AudioWorkletNode(ctx, 'rc505-overdub-processor', {
                numberOfInputs: bounceSourceMix ? 2 : 1,
                numberOfOutputs: 1,
                outputChannelCount: [channelCount],
                channelCount,
                channelCountMode: 'explicit',
                processorOptions: {
                    transferBufferFrames: OVERDUB_TRANSFER_BUFFER_FRAMES,
                    transferBufferPoolSize: OVERDUB_TRANSFER_BUFFER_POOL_SIZE,
                    batchPatchMessages: true,
                    patchFlushFrames: OVERDUB_PATCH_FLUSH_FRAMES,
                    startupBackfillFrames: OVERDUB_STARTUP_BACKFILL_FRAMES,
                    startupQueueFrames: OVERDUB_STARTUP_BACKFILL_FRAMES,
                    startupReplayFramesPerProcess: 256,
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
            this.overdubReceivedPatchMessages = 0;
            this.overdubExpectedPatchMessages = null;
            this.overdubStopping = false;
            this.overdubDiagnostic = null;

            workletNode.port.onmessage = (event: MessageEvent) => {
                this.handleOverdubMessage(workletNode, audioBuffer, event.data);
            };
            workletNode.onprocessorerror = () => {
                if (this.overdubProcessor !== workletNode) return;
                this.overdubDiagnostic = 'Overdub AudioWorklet stopped unexpectedly; track playback remains audible.';
                this.finishOverdubNode(workletNode);
                this.syncTransportState();
            };
            workletNode.port.postMessage({
                type: 'OVERDUB_INIT',
                // `samples` remains as an alias for the legacy mono processor
                // protocol; new processors consume the complete `channels` list.
                samples: loopChannels[0],
                channels: loopChannels,
                channelCount,
                buffers: patchBuffers,
                startFrame: Math.floor(this.startTime * ctx.sampleRate),
                startOffsetSamples: Math.floor(this.startOffset * ctx.sampleRate),
                latencySamples: Math.floor(this.engine.roundTripLatency * ctx.sampleRate),
                recordingOffsetSamples: this.getBrowserRecordingOffsetConfig().recordingOffsetSamples,
                reverse: this.isReverse,
                dubMode,
                ...(captureSession && requestFrame !== null ? { requestFrame } : {}),
            }, transferList);

            // Preserve the old muted-sink routing. The existing buffer source stays
            // audible while real-time overdub DSP and loop readback remain in the worklet.
            if (bounceSourceMix) input.connect(workletNode, 0, 0);
            else input.connect(workletNode);
            bounceSourceMix?.node.connect(workletNode, 0, 1);
            this.overdubInputNode = input;
            this.overdubBounceSourceMix = bounceSourceMix;
            workletNode.connect(muteGain);
            muteGain.connect(ctx.destination);
        } catch (error) {
            bounceSourceMix?.dispose();
            if (captureSession) this.releaseOverdubCaptureSession(captureSession, true);
            if (generation !== this.overdubStartGeneration) {
                if (!this.overdubHasEdited) this.releasePendingOverdubSnapshot();
                this.overdubBaselineSnapshot = null;
                this.overdubStopRollbackJournal = null;
                return;
            }
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
            if (!this.overdubHasEdited) this.releasePendingOverdubSnapshot();
            this.overdubBaselineSnapshot = null;
            this.overdubStopRollbackJournal = null;
            this.overdubDiagnostic = `Overdub is unavailable: ${error instanceof Error ? error.message : String(error)}. Track playback remains audible.`;
            if (!this.overdubProcessor && this.state === TrackState.OVERDUBBING) this.state = TrackState.PLAYING;
            this.syncTransportState();
            this.restoreLoopTransportAfterOverdub();
        } finally {
            if (generation === this.overdubStartGeneration) this.overdubStarting = false;
            else if (captureSession) this.releaseOverdubCaptureSession(captureSession, true);
            if (generation === this.overdubStartGeneration && !this.overdubProcessor && !this.overdubStarting) {
                this.overdubReplace2ReaderMuted = false;
                this.loopReaderGateGain.gain.value = 1;
            }
        }
    }

    private beginOverdubCaptureSession(startFrame: number, generation: number, bounceSourceMask = 0): InputCaptureSession | null {
        if (!Number.isSafeInteger(startFrame) || startFrame < 0 || this.overdubCaptureSession) return null;
        let session: InputCaptureSession | null = null;
        session = this.engine.beginInputCaptureSession?.(
            this.trackIndex,
            startFrame,
            (message) => {
                if (session) this.handleOverdubCaptureMessage(session, generation, message);
            },
            OVERDUB_STARTUP_BACKFILL_FRAMES,
            undefined,
            bounceSourceMask,
        ) ?? null;
        if (!session) return null;
        this.overdubCaptureSession = session;
        this.overdubCaptureGeneration = generation;
        this.overdubCaptureRequestFrame = startFrame;
        this.overdubCaptureFirstInputFrame = null;
        this.overdubCaptureChannelCount = 0;
        this.overdubCaptureStopRequested = false;
        this.overdubCaptureAwaitingCompletion = false;
        this.overdubCaptureAborting = false;
        this.overdubCapturePendingChunkReturns = [];
        if (this.overdubCaptureAbortTimeout !== null) clearTimeout(this.overdubCaptureAbortTimeout);
        this.overdubCaptureAbortTimeout = null;
        this.overdubCaptureBuffers = null;
        this.overdubCaptureFrames = 0;
        this.overdubCaptureNextSequence = 0;
        this.overdubCaptureTimeout = setTimeout(() => {
            this.failOverdubCapture(session!, 'The exact input backfill did not complete within one second');
        }, OVERDUB_STARTUP_CAPTURE_TIMEOUT_MS);
        return session;
    }

    private clearOverdubCaptureTimeout(): void {
        if (this.overdubCaptureTimeout !== null) clearTimeout(this.overdubCaptureTimeout);
        this.overdubCaptureTimeout = null;
    }

    private releaseOverdubCaptureSession(session: InputCaptureSession, abort: boolean): void {
        if (this.overdubCaptureSession !== session) return;
        this.clearOverdubCaptureTimeout();
        if (abort) {
            // Keep the input-capture lease until its abort ACK. Chunks posted
            // before that ACK still need to be recycled, otherwise the shared
            // tap can lose a pool slot permanently.
            if (!this.overdubCaptureAborting) {
                this.overdubCaptureAborting = true;
                // Once STOP_CAPTURE was accepted, the input worklet may already
                // have moved its slot to idle and queued RECORD_COMPLETE. Sending
                // ABORT after that ACK boundary can strand the lease forever.
                if (!this.overdubCaptureAwaitingCompletion) this.engine.abortInputCaptureSession?.(session);
                this.overdubCaptureAbortTimeout = setTimeout(() => {
                    if (this.overdubCaptureSession === session && this.overdubCaptureAborting) {
                        this.overdubDiagnostic = 'Overdub startup was cancelled; waiting for the shared input tap to acknowledge buffer cleanup.';
                    }
                }, OVERDUB_STARTUP_CAPTURE_TIMEOUT_MS);
            }
            return;
        }
        if (this.overdubCaptureAbortTimeout !== null) clearTimeout(this.overdubCaptureAbortTimeout);
        this.overdubCaptureAbortTimeout = null;
        if (this.overdubCapturePendingChunkReturns.length > 0) {
            const stillPending: Array<{ chunkIndex: number; channels: Float32Array[] }> = [];
            for (const entry of this.overdubCapturePendingChunkReturns) {
                if (this.engine.recycleInputCaptureChunk?.(session, entry.chunkIndex, entry.channels) !== true) {
                    stillPending.push(entry);
                }
            }
            this.overdubCapturePendingChunkReturns = stillPending;
            if (stillPending.length > 0) {
                this.overdubDiagnostic = 'Overdub startup remains blocked because an input-capture chunk could not be returned to the shared tap.';
                return;
            }
        }
        this.engine.releaseInputCaptureSession?.(session);
        this.overdubCaptureSession = null;
        this.overdubCaptureGeneration = 0;
        this.overdubCaptureRequestFrame = null;
        this.overdubCaptureFirstInputFrame = null;
        this.overdubCaptureChannelCount = 0;
        this.overdubCaptureStopRequested = false;
        this.overdubCaptureAwaitingCompletion = false;
        this.overdubCaptureAborting = false;
        this.overdubCaptureBuffers = null;
        this.overdubCaptureFrames = 0;
        this.overdubCaptureNextSequence = 0;
        this.overdubCapturePendingChunkReturns = [];
    }

    private failOverdubCapture(session: InputCaptureSession, reason: string, captureAlreadyComplete = false): void {
        if (this.overdubCaptureSession !== session) return;
        this.overdubDiagnostic = `Overdub startup failed before PCM commit: ${reason}. The existing loop and history were kept.`;
        this.releaseOverdubCaptureSession(session, !captureAlreadyComplete);
        const workletNode = this.overdubProcessor;
        if (workletNode) {
            try { workletNode.port.postMessage({ type: 'OVERDUB_BACKFILL_ERROR', reason }); }
            catch { this.finishOverdubNode(workletNode); }
            return;
        }
        this.overdubStartGeneration += 1;
        this.overdubStarting = false;
        if (this.state === TrackState.OVERDUBBING) this.state = TrackState.PLAYING;
        this.syncTransportState();
        this.restoreLoopTransportAfterOverdub();
    }

    private handleOverdubCaptureMessage(session: InputCaptureSession, generation: number, message: unknown): void {
        if (!message || typeof message !== 'object') return;
        const stale = message as { type?: string; chunkIndex?: number; channels?: Float32Array[] };
        if (this.overdubCaptureSession !== session) {
            if (stale.type === 'RECORD_CHUNK' && Array.isArray(stale.channels)) {
                this.engine.recycleInputCaptureChunk?.(session, stale.chunkIndex ?? -1, stale.channels);
            }
            return;
        }
        if (this.overdubCaptureAborting) {
            if (stale.type === 'RECORD_CHUNK' && Array.isArray(stale.channels)) {
                this.returnOverdubCaptureChunk(session, stale.chunkIndex ?? -1, stale.channels);
            } else if (stale.type === 'CAPTURE_ERROR') {
                this.overdubCapturePendingChunkReturns = [];
                this.releaseOverdubCaptureSession(session, false);
            } else if (stale.type === 'RECORD_ABORTED' || stale.type === 'RECORD_COMPLETE') {
                this.releaseOverdubCaptureSession(session, false);
            }
            return;
        }
        if (generation !== this.overdubStartGeneration) {
            if (stale.type === 'RECORD_CHUNK' && Array.isArray(stale.channels)) {
                this.returnOverdubCaptureChunk(session, stale.chunkIndex ?? -1, stale.channels);
            }
            return;
        }
        const payload = message as {
            type?: string; reason?: string; requestedStartFrame?: number; stopFrame?: number;
            channelCount?: number; maxRecordingFrames?: number; maxRecordingBytes?: number;
            chunkIndex?: number; sequence?: number; validFrames?: number; channels?: Float32Array[];
            startFrame?: number; framesCaptured?: number; droppedFrames?: number; limitReached?: boolean;
            overflowEvents?: number; chunksSent?: number; status?: string; sessionId?: number; inputGeneration?: number;
        };

        if ((payload.sessionId !== undefined && payload.sessionId !== session.sessionId)
            || (payload.inputGeneration !== undefined && payload.inputGeneration !== session.inputGeneration)) return;

        if (payload.type === 'CAPTURE_ERROR' || payload.type === 'RECORD_ABORTED') {
            const reason = payload.reason || 'shared-input-capture-aborted';
            if (payload.type === 'CAPTURE_ERROR') {
                this.overdubCapturePendingChunkReturns = [];
                this.failOverdubCapture(session, reason, true);
            }
            else this.failOverdubCapture(session, reason, true);
            return;
        }
        if (payload.type === 'RECORD_CONFIGURED') {
            const channelCount = payload.channelCount;
            if (payload.sessionId !== session.sessionId || payload.inputGeneration !== session.inputGeneration
                || !Number.isInteger(channelCount) || (channelCount !== 1 && channelCount !== 2)
                || payload.requestedStartFrame !== session.startFrame
                || !Number.isSafeInteger(payload.maxRecordingFrames)
                || payload.maxRecordingFrames !== OVERDUB_STARTUP_BACKFILL_FRAMES
                || payload.maxRecordingBytes !== MAX_RECORDING_CAPTURE_BYTES
                || (this.overdubCaptureChannelCount !== 0 && this.overdubCaptureChannelCount !== channelCount)) {
                this.failOverdubCapture(session, 'input-channel-layout-was-invalid-or-changed');
                return;
            }
            this.overdubCaptureChannelCount = channelCount;
            if (!this.overdubCaptureBuffers) {
                this.overdubCaptureBuffers = Array.from({ length: channelCount }, () => new Float32Array(OVERDUB_STARTUP_BACKFILL_FRAMES));
            }
            return;
        }
        if (payload.type === 'OVERDUB_FIRST_INPUT_FRAME') {
            const requestFrame = this.overdubCaptureRequestFrame;
            const firstInputFrame = payload.stopFrame;
            const channelCount = payload.channelCount;
            if (requestFrame === null || !Number.isSafeInteger(firstInputFrame)
                || firstInputFrame! < requestFrame
                || firstInputFrame! - requestFrame > OVERDUB_STARTUP_BACKFILL_FRAMES
                || payload.requestedStartFrame !== requestFrame
                || !Number.isInteger(channelCount) || (channelCount !== 1 && channelCount !== 2)
                || (this.overdubCaptureFirstInputFrame !== null && this.overdubCaptureFirstInputFrame !== firstInputFrame)
                || (this.overdubCaptureChannelCount !== 0 && this.overdubCaptureChannelCount !== channelCount)) {
                this.failOverdubCapture(session, 'overdub-first-input-frame-did-not-match-the-requested-range');
                return;
            }
            this.overdubCaptureFirstInputFrame = firstInputFrame!;
            this.overdubCaptureChannelCount = channelCount!;
            if (!this.overdubCaptureBuffers) {
                this.overdubCaptureBuffers = Array.from({ length: channelCount! }, () => new Float32Array(OVERDUB_STARTUP_BACKFILL_FRAMES));
            }
            if (!this.overdubCaptureStopRequested) {
                if (!this.engine.stopInputCaptureSession?.(session, firstInputFrame!)) {
                    this.failOverdubCapture(session, 'input-capture-rejected-the-first-input-stop-frame');
                    return;
                }
                this.overdubCaptureStopRequested = true;
                this.overdubCaptureAwaitingCompletion = true;
            }
            return;
        }
        if (payload.type === 'RECORD_CHUNK') {
            const channels = payload.channels;
            const recycle = () => {
                if (Array.isArray(channels)) this.engine.recycleInputCaptureChunk?.(session, payload.chunkIndex ?? -1, channels);
            };
            const startFrame = session.startFrame + this.overdubCaptureNextSequence * RECORDING_CHUNK_SIZE;
            const validFrames = Number.isSafeInteger(payload.validFrames) ? payload.validFrames! : -1;
            const expectedChannelCount = this.overdubCaptureChannelCount;
            if (!Array.isArray(channels) || expectedChannelCount < 1 || channels.length !== expectedChannelCount
                || channels.some((samples) => !(samples instanceof Float32Array) || samples.length !== RECORDING_CHUNK_SIZE)
                || payload.sessionId !== session.sessionId || payload.inputGeneration !== session.inputGeneration
                || payload.channelCount !== expectedChannelCount
                || !Number.isInteger(payload.chunkIndex) || payload.chunkIndex! < 0 || payload.chunkIndex! >= RECORDING_CHUNK_POOL_SIZE
                || payload.sequence !== this.overdubCaptureNextSequence || payload.startFrame !== startFrame
                || validFrames <= 0 || validFrames > RECORDING_CHUNK_SIZE
                || this.overdubCaptureFrames + validFrames > OVERDUB_STARTUP_BACKFILL_FRAMES
                || !this.overdubCaptureBuffers) {
                recycle();
                this.failOverdubCapture(session, 'input-backfill-chunk-had-an-invalid-range-or-format');
                return;
            }
            const dst = this.overdubCaptureFrames;
            for (let channel = 0; channel < expectedChannelCount; channel += 1) {
                this.overdubCaptureBuffers[channel]!.set(channels[channel]!.subarray(0, validFrames), dst);
            }
            this.overdubCaptureFrames += validFrames;
            this.overdubCaptureNextSequence += 1;
            if (!this.returnOverdubCaptureChunk(session, payload.chunkIndex!, channels)) {
                this.failOverdubCapture(session, 'input-backfill-buffer-could-not-be-recycled');
            }
            return;
        }
        if (payload.type !== 'RECORD_COMPLETE') return;

        const requestFrame = this.overdubCaptureRequestFrame;
        const firstInputFrame = this.overdubCaptureFirstInputFrame;
        const expectedFrames = requestFrame !== null && firstInputFrame !== null ? firstInputFrame - requestFrame : -1;
        const channelCount = this.overdubCaptureChannelCount;
        if (payload.sessionId !== session.sessionId || payload.inputGeneration !== session.inputGeneration
            || requestFrame === null || firstInputFrame === null || !this.overdubCaptureStopRequested || expectedFrames < 0
            || expectedFrames > OVERDUB_STARTUP_BACKFILL_FRAMES
            || payload.requestedStartFrame !== requestFrame || payload.stopFrame !== firstInputFrame
            || payload.framesCaptured !== expectedFrames || this.overdubCaptureFrames !== expectedFrames
            || (expectedFrames > 0 && (channelCount !== 1 && channelCount !== 2
                || payload.channelCount !== channelCount))
            // A zero-frame interval may be acknowledged either before the tap
            // has negotiated its input format (0) or after it has observed the
            // first block (the same 1/2-channel format reported by the
            // overdub worklet). Both are valid because no PCM chunk exists to
            // interpret; any other channel count is a protocol mismatch.
            || (expectedFrames === 0 && payload.channelCount !== 0 && payload.channelCount !== channelCount)
            || payload.droppedFrames !== 0 || payload.overflowEvents !== 0 || payload.limitReached !== false
            || payload.maxRecordingFrames !== OVERDUB_STARTUP_BACKFILL_FRAMES
            || payload.maxRecordingBytes !== MAX_RECORDING_CAPTURE_BYTES || payload.status !== 'complete'
            || payload.chunksSent !== this.overdubCaptureNextSequence) {
            const ackSummary = `expected ${requestFrame ?? 'n/a'}..${firstInputFrame ?? 'n/a'} (${expectedFrames}) ch=${channelCount}, received ${payload.requestedStartFrame}..${payload.stopFrame} (${payload.framesCaptured}) ch=${payload.channelCount}, dropped=${payload.droppedFrames}, chunks=${payload.chunksSent}`;
            this.failOverdubCapture(session, `input-backfill-completion-acknowledgement-did-not-match-the-requested-frame-range: ${ackSummary}`, true);
            return;
        }

        if (!this.overdubCaptureBuffers) {
            this.overdubCaptureBuffers = Array.from({ length: channelCount }, () => new Float32Array(OVERDUB_STARTUP_BACKFILL_FRAMES));
        }
        const channels = this.overdubCaptureBuffers;
        const workletNode = this.overdubProcessor;
        if (!workletNode) {
            this.failOverdubCapture(session, 'overdub-worklet-was-not-ready-to-accept-backfill');
            return;
        }
        try {
            workletNode.port.postMessage({
                type: 'OVERDUB_BACKFILL', requestFrame, firstInputFrame,
                validFrames: expectedFrames, channelCount, channels,
            }, channels.map((samples) => samples.buffer));
        } catch (error) {
            this.failOverdubCapture(session, error instanceof Error ? error.message : 'backfill-transfer-failed');
            return;
        }
        this.releaseOverdubCaptureSession(session, false);
    }

    private returnOverdubCaptureChunk(session: InputCaptureSession, chunkIndex: number, channels: Float32Array[]): boolean {
        if (this.engine.recycleInputCaptureChunk?.(session, chunkIndex, channels) === true) return true;
        if (!this.overdubCapturePendingChunkReturns.some((entry) => entry.chunkIndex === chunkIndex)) {
            this.overdubCapturePendingChunkReturns.push({ chunkIndex, channels });
        }
        this.overdubDiagnostic = 'Overdub startup retained an input-capture buffer because the shared tap did not acknowledge its return.';
        return false;
    }

    private handleOverdubMessage(workletNode: AudioWorkletNode, audioBuffer: AudioBuffer, message: unknown) {
        if (this.disposed || !message || typeof message !== 'object' || this.overdubProcessor !== workletNode) return;
        const payload = message as {
            type?: string;
            sequence?: number;
            slotIndex?: number;
            validFrames?: number;
            startInputFrame?: number;
            endInputFrame?: number;
            indices?: Uint32Array;
            values?: Float32Array;
            rightValues?: Float32Array;
            oldValues?: Float32Array;
            oldRightValues?: Float32Array;
            overflowFrames?: number;
            overflowEvents?: number;
            patchesSent?: number;
            message?: string;
            requestFrame?: number;
            requestedStartFrame?: number;
            firstInputFrame?: number;
            channelCount?: number;
            requestedStopFrame?: number;
            appliedExclusiveEnd?: number;
            processorStopFrame?: number;
            stopFrame?: number;
            startupCancelled?: boolean;
        };

        if (payload.type === 'OVERDUB_FIRST_INPUT_FRAME') {
            const session = this.overdubCaptureSession;
            if (!session || this.overdubCaptureAborting
                || this.overdubCaptureGeneration !== this.overdubStartGeneration) {
                this.overdubDiagnostic = 'Overdub startup could not recover the exact requested input frame; the existing loop was kept.';
                if (session) this.releaseOverdubCaptureSession(session, true);
                if (this.overdubProcessor === workletNode) {
                    try { workletNode.port.postMessage({ type: 'OVERDUB_BACKFILL_ERROR', reason: 'capture-session-not-current' }); }
                    catch { this.finishOverdubNode(workletNode); }
                }
                this.syncTransportState();
                return;
            }
            this.handleOverdubCaptureMessage(session, this.overdubCaptureGeneration, {
                type: payload.type,
                requestedStartFrame: payload.requestFrame,
                stopFrame: payload.firstInputFrame,
                channelCount: payload.channelCount,
                sessionId: session.sessionId,
                inputGeneration: session.inputGeneration,
            });
            return;
        }

        if (payload.type === 'OVERDUB_PATCH') {
            this.overdubReceivedPatchMessages += 1;
            const indices = payload.indices;
            const values = payload.values;
            const validFrames = Number.isInteger(payload.validFrames) ? payload.validFrames! : 0;
            if (
                this.overdubSessionAudioBuffer === audioBuffer && this.audioBuffer === audioBuffer &&
                indices instanceof Uint32Array && values instanceof Float32Array
            ) {
                if (payload.sequence !== this.overdubNextPatchSequence) {
                    this.abortOverdubPatchStream(workletNode,
                        'Overdub patch messages arrived out of sequence; the entire edit was rolled back.');
                    return;
                } else {
                    const trackBuffers = Array.from(
                        { length: Math.max(1, Math.min(MAX_RECORDING_CHANNELS, audioBuffer.numberOfChannels)) },
                        (_, channel) => audioBuffer.getChannelData(channel),
                    );
                    const rightValues = payload.rightValues;
                    const oldValues = payload.oldValues;
                    const oldRightValues = payload.oldRightValues;
                    const stereo = trackBuffers.length > 1;
                    const startInputFrame = payload.startInputFrame;
                    const endInputFrame = payload.endInputFrame;
                    let indicesInRange = validFrames > 0 && validFrames <= indices.length;
                    if (indicesInRange) {
                        for (let frame = 0; frame < validFrames; frame += 1) {
                            if (indices[frame]! >= trackBuffers[0]!.length) {
                                indicesInRange = false;
                                break;
                            }
                        }
                    }
                    const patchValid = validFrames > 0 && validFrames <= indices.length && validFrames <= values.length
                        && oldValues instanceof Float32Array && validFrames <= oldValues.length
                        && Number.isSafeInteger(startInputFrame) && startInputFrame! >= 0
                        && Number.isSafeInteger(endInputFrame) && endInputFrame! >= 0
                        && endInputFrame! - startInputFrame! === validFrames
                        && (!stereo || rightValues instanceof Float32Array && validFrames <= rightValues.length)
                        && (!stereo || oldRightValues instanceof Float32Array && validFrames <= oldRightValues.length)
                        && indicesInRange;
                    const rangesOrdered = patchValid && (this.overdubLastReceivedPatchEndFrame === null
                        || startInputFrame! >= this.overdubLastReceivedPatchEndFrame);
                    if (!patchValid || !rangesOrdered) {
                        this.abortOverdubPatchStream(workletNode, stereo
                            ? 'Stereo overdub patch data or source-frame order was invalid; the entire edit was rolled back.'
                            : 'Overdub patch data or source-frame order was invalid; the entire edit was rolled back.');
                        return;
                    } else {
                        this.overdubLastReceivedPatchEndFrame = endInputFrame!;
                        let applyFrames = this.overdubRollbackAborted ? 0 : validFrames;
                        if (applyFrames > 0 && this.overdubStopFrameTarget !== null) {
                            applyFrames = Math.max(0, Math.min(applyFrames, this.overdubStopFrameTarget - startInputFrame!));
                        }
                        const journal = this.overdubStopRollbackJournal;
                        const journalReady = !!journal && !!this.overdubBaselineSnapshot
                            && (this.pendingOverdubRollbackSnapshot === this.overdubBaselineSnapshot
                                || this.pcmHistory?.snapshot === this.overdubBaselineSnapshot);
                        let oldValuesMatch = applyFrames === 0 || journalReady;
                        if (oldValuesMatch && applyFrames > 0) {
                            const expectedLeft = new Map<number, number>();
                            const expectedRight = stereo ? new Map<number, number>() : null;
                            for (let frame = 0; frame < applyFrames; frame += 1) {
                                const index = indices[frame]!;
                                const previousLeft = expectedLeft.has(index)
                                    ? expectedLeft.get(index)!
                                    : trackBuffers[0]![index]!;
                                const previousRight = stereo && expectedRight?.has(index)
                                    ? expectedRight.get(index)!
                                    : (stereo ? trackBuffers[1]![index]! : 0);
                                if (!Number.isFinite(values[frame]!) || !Number.isFinite(oldValues![frame]!)
                                    || !Object.is(previousLeft, oldValues![frame]!)
                                    || (stereo && (!Number.isFinite(rightValues![frame]!)
                                        || !Number.isFinite(oldRightValues![frame]!)
                                        || !Object.is(previousRight, oldRightValues![frame]!)))) {
                                    oldValuesMatch = false;
                                    break;
                                }
                                expectedLeft.set(index, values[frame]!);
                                if (stereo && expectedRight) expectedRight.set(index, rightValues![frame]!);
                            }
                        }
                        if (!oldValuesMatch) {
                            this.abortOverdubPatchStream(workletNode,
                                'Overdub stopped because its rollback snapshot or patch predecessor state was unavailable; the entire edit was rolled back.');
                            return;
                        }
                        for (let frame = 0; frame < applyFrames && oldValuesMatch; frame += 1) {
                            const index = indices[frame]!;
                            const inputFrame = startInputFrame! + frame;
                            this.appendOverdubStopJournal(inputFrame, index, oldValues![frame]!, stereo ? oldRightValues![frame]! : 0);
                            trackBuffers[0]![index] = values[frame]!;
                            if (stereo && rightValues instanceof Float32Array) {
                                trackBuffers[1]![index] = rightValues[frame]!;
                            }
                            this.overdubAppliedFrameCount += 1;
                        }
                        if (applyFrames > 0 && oldValuesMatch) {
                            this.overdubHasEdited = true;
                            this.overdubLastAppliedInputFrameExclusive = startInputFrame! + applyFrames;
                            this.projectPcmRevision += 1;
                        }
                        this.overdubNextPatchSequence += 1;
                    }
                }
            }

            if (!this.overdubStopping && Number.isInteger(payload.slotIndex) && payload.slotIndex! >= 0) {
                const transferList: Transferable[] = [indices?.buffer, values?.buffer, payload.rightValues?.buffer]
                    .concat([payload.oldValues?.buffer, payload.oldRightValues?.buffer])
                    .filter((item): item is ArrayBuffer => item instanceof ArrayBuffer);
                const stereoValid = audioBuffer.numberOfChannels <= 1
                    || payload.rightValues instanceof Float32Array && payload.oldRightValues instanceof Float32Array;
                const expectedTransfers = audioBuffer.numberOfChannels > 1 ? 5 : 3;
                if (indices instanceof Uint32Array && values instanceof Float32Array && stereoValid
                    && payload.oldValues instanceof Float32Array && transferList.length === expectedTransfers) {
                    workletNode.port.postMessage({
                        type: 'RECYCLE_OVERDUB_BUFFER',
                        slotIndex: payload.slotIndex,
                        indices,
                        values,
                        ...(payload.rightValues ? { rightValues: payload.rightValues } : {}),
                        oldValues: payload.oldValues,
                        ...(payload.oldRightValues ? { oldRightValues: payload.oldRightValues } : {}),
                    }, transferList);
                }
            }
            this.finishOverdubWhenReady(workletNode);
            return;
        }

        if (payload.type === 'OVERDUB_ERROR') {
            const workletReason = payload.message ?? 'AudioWorklet error';
            this.overdubDiagnostic = this.overdubDiagnostic?.startsWith('Overdub startup failed before PCM commit:')
                ? `${this.overdubDiagnostic} Worklet: ${workletReason}`
                : `Overdub failed: ${workletReason}. Track playback remains audible.`;
            // ERROR is explanatory, not the terminal barrier. Wait for the
            // stopped ACK and its patch count before retiring the processor.
            if (!this.overdubStopping) {
                this.overdubStopping = true;
                this.watchOverdubDrain(workletNode);
            }
            this.syncTransportState();
            return;
        }

        if (payload.type === 'OVERDUB_STOPPED') {
            const reportedStopFrame = payload.requestedStopFrame;
            const stopFrameAcknowledgedExactly = payload.startupCancelled === true
                || (Number.isSafeInteger(reportedStopFrame) && reportedStopFrame! >= 0
                    && (this.overdubStopFrameTarget === null || reportedStopFrame === this.overdubStopFrameTarget)
                    && Number.isSafeInteger(payload.appliedExclusiveEnd)
                    && payload.appliedExclusiveEnd === reportedStopFrame
                    && Number.isSafeInteger(payload.processorStopFrame)
                    && payload.processorStopFrame! >= reportedStopFrame!);
            if (!stopFrameAcknowledgedExactly) {
                this.abortOverdubPatchStream(workletNode,
                    `Overdub worklet did not confirm the requested stop frame ${this.overdubStopFrameTarget} and exclusive PCM boundary; the entire edit was rolled back.`);
            }
            const patchCountValid = Number.isSafeInteger(payload.patchesSent)
                && payload.patchesSent! >= this.overdubReceivedPatchMessages;
            const overflowCountersValid = Number.isSafeInteger(payload.overflowFrames) && payload.overflowFrames! >= 0
                && Number.isSafeInteger(payload.overflowEvents) && payload.overflowEvents! >= 0;
            if (!patchCountValid || !overflowCountersValid
                || (payload.startupCancelled === true && (payload.patchesSent !== 0 || this.overdubReceivedPatchMessages !== 0))) {
                this.abortOverdubPatchStream(workletNode,
                    'Overdub worklet sent an invalid terminal patch-count or overflow acknowledgement; the entire edit was rolled back.');
                // This terminal message is the worklet's final barrier. Since
                // its counters are invalid, do not wait on an untrusted count;
                // the edit is already rolled back and the node can be retired.
                this.overdubExpectedPatchMessages = this.overdubReceivedPatchMessages;
                this.finishOverdubWhenReady(workletNode);
                return;
            }
            if ((payload.overflowFrames ?? 0) > 0
                && !this.overdubDiagnostic?.startsWith('Overdub startup failed before PCM commit:')) {
                const overflowFrames = payload.overflowFrames!;
                const rollbackSucceeded = this.overdubRollbackRestored || this.restorePreOverdubPcm();
                if (rollbackSucceeded) {
                    this.overdubDiagnostic = `Overdub buffer pool overflow dropped ${overflowFrames} input frames across ${payload.overflowEvents ?? 0} bursts; the complete edit was rolled back to pre-overdub PCM and prior history was retained.`;
                } else {
                    // Keep the reserved pre-overdub snapshot available as an
                    // undo image if any PCM had already been patched. Later
                    // messages are counted/recycled but cannot mutate PCM.
                    this.overdubRollbackAborted = true;
                    this.overdubDiagnostic = `Overdub buffer pool overflow dropped ${overflowFrames} input frames across ${payload.overflowEvents ?? 0} bursts, and automatic PCM restoration failed; partial PCM may remain. Use Undo if the pre-overdub snapshot is available.`;
                }
                this.syncTransportState();
            }
            this.overdubExpectedPatchMessages = payload.patchesSent!;
            this.finishOverdubWhenReady(workletNode);
        }
    }

    private finishOverdubWhenReady(workletNode: AudioWorkletNode): void {
        if (this.overdubProcessor === workletNode && this.overdubExpectedPatchMessages !== null
            && this.overdubReceivedPatchMessages >= this.overdubExpectedPatchMessages) {
            this.finishOverdubNode(workletNode, true);
        }
    }

    private abortOverdubPatchStream(workletNode: AudioWorkletNode, diagnostic: string): void {
        // A malformed later message can arrive after this same processor has
        // already triggered rollback. The baseline copy is intentionally
        // released by the first restore; do not interpret that second call's
        // missing image as permission to discard the user's prior undo step.
        if (!this.overdubRollbackAborted && !this.restorePreOverdubPcm()) this.invalidatePcmHistoryForEdit();
        this.overdubDiagnostic = diagnostic;
        if (this.overdubProcessor === workletNode && !this.overdubStopping) this.stopOverdub();
        this.syncTransportState();
    }

    private finishOverdubNode(workletNode: AudioWorkletNode, allowRestart = false) {
        if (this.overdubStopAckTimeout !== null) {
            clearTimeout(this.overdubStopAckTimeout);
            this.overdubStopAckTimeout = null;
        }
        const captureSession = this.overdubCaptureSession;
        if (captureSession) this.releaseOverdubCaptureSession(captureSession, true);
        const restart = allowRestart && this.overdubRestartAfterStop && this.state === TrackState.OVERDUBBING;
        this.overdubRestartAfterStop = false;
        workletNode.port.onmessage = null;
        workletNode.onprocessorerror = null;
        try { this.overdubInputNode?.disconnect(workletNode); } catch { /* already disconnected */ }
        this.overdubInputNode = null;
        this.overdubBounceSourceMix?.dispose();
        this.overdubBounceSourceMix = null;
        workletNode.disconnect();
        workletNode.port.close?.();
        if (this.overdubMuteGainNode) {
            this.overdubMuteGainNode.disconnect();
            this.overdubMuteGainNode = null;
        }
        let committedOverdub = false;
        if (this.overdubHasEdited && this.pendingOverdubRollbackSnapshot) {
            if (!this.activateOverdubUndoSnapshot()) {
                this.overdubDiagnostic = 'Overdub was rolled back because its reserved PCM history snapshot could not be committed.';
                if (!this.restorePreOverdubPcm()) this.invalidatePcmHistoryForEdit();
            } else if (allowRestart && !this.overdubRollbackAborted) {
                // The terminal message plus every expected patch has arrived,
                // and the undo baseline has been committed to its own slot.
                committedOverdub = true;
            }
        }
        if (this.overdubProcessor === workletNode) this.overdubProcessor = null;
        this.overdubSessionAudioBuffer = null;
        if (!this.overdubHasEdited) this.releasePendingOverdubSnapshot();
        this.overdubBaselineSnapshot = null;
        this.overdubStopping = false;
        this.overdubExpectedPatchMessages = null;
        this.overdubStopFrameTarget = null;
        this.overdubLastAppliedInputFrameExclusive = null;
        this.overdubLastReceivedPatchEndFrame = null;
        this.overdubStopRollbackJournal = null;
        this.overdubAppliedFrameCount = 0;
        this.overdubRollbackAborted = false;
        this.overdubRollbackRestored = false;
        if (!restart) {
            this.overdubReplace2ReaderMuted = false;
            this.loopReaderGateGain.gain.value = 1;
        }
        if (committedOverdub) this.hasCommittedOverdub = true;
        if (this.pendingClear) {
            this.pendingClear = false;
            this.completeClear();
        } else if (restart) void this.startOverdub();
        else {
            // A failure or terminal drain can finish without a user toggle.
            // Only clear OVERDUBBING at the actual retirement barrier, and
            // preserve STOPPED/PLAYING if the user already changed transport.
            if (this.state === TrackState.OVERDUBBING) this.state = TrackState.PLAYING;
            this.restoreLoopTransportAfterOverdub();
        }
    }

    private watchOverdubDrain(workletNode: AudioWorkletNode): void {
        if (this.overdubStopAckTimeout !== null) clearTimeout(this.overdubStopAckTimeout);
        this.overdubStopAckTimeout = setTimeout(() => {
            if (this.overdubProcessor !== workletNode || !this.overdubStopping) return;
            const contextState = (this.engine.context as AudioContext).state ?? 'unknown';
            const pending = this.overdubExpectedPatchMessages === null
                ? 'the terminal stop acknowledgement'
                : `final PCM patches (${this.overdubReceivedPatchMessages}/${this.overdubExpectedPatchMessages} received)`;
            this.overdubDiagnostic = `Overdub stop could not drain ${pending} within ${OVERDUB_STOP_ACK_TIMEOUT_MS} ms (AudioContext state: ${contextState}); the stop-frame cutoff was applied, but missing pre-stop patches may leave a partial overdub. Use Undo to restore the pre-overdub PCM if its history entry was retained.`;
            this.finishOverdubNode(workletNode);
            this.syncTransportState();
        }, OVERDUB_STOP_ACK_TIMEOUT_MS);
    }

    private suspendLoopTransportForOverdub(): void {
        if (this.loopTransportOverdubSnapshot || !this.hasConfiguredLoopTransportFx()) return;
        this.loopTransportOverdubSnapshot = this.loopTransportFxSlots.map((slot) => slot ? { ...slot } : null);
        for (let slotIndex = 0; slotIndex < this.loopTransportFxSlots.length; slotIndex += 1) {
            if (this.loopTransportFxSlots[slotIndex]) this.configureLoopTransportFx(slotIndex, null);
        }
    }

    private prepareOverdubStopRollback(audioBuffer: AudioBuffer): void {
        const channels = audioBuffer.numberOfChannels;
        if (channels !== 1 && channels !== 2) throw new Error('Overdub requires a mono or stereo loop');
        const capacity = OVERDUB_STOP_ROLLBACK_JOURNAL_FRAMES;
        this.overdubStopRollbackJournal = {
            capacity,
            inputFrames: new Float64Array(capacity),
            loopIndices: new Uint32Array(capacity),
            leftBefore: new Float32Array(capacity),
            rightBefore: channels > 1 ? new Float32Array(capacity) : null,
            writeCursor: 0,
            retainedFrames: 0,
        };
        // The normal one-step undo copy is also the bounded full-rollback image
        // if STOP arrives after its tail journal has rolled over. Keep existing
        // history accounted while reserving this candidate; if both cannot fit,
        // reject before the worklet can publish any PCM patch.
        const bytes = audioBufferPcmBytes(audioBuffer);
        const currentBytes = audioBufferPcmBytes(this.pcmHistory?.snapshot.buffer ?? null);
        if (!this.pcmHistoryBudget.replaceMany([
            { owner: this, bytes: currentBytes },
            { owner: this.overdubSnapshotBudgetOwner, bytes },
        ])) {
            this.historyFailureReason = this.historyBudgetReason('Overdub is unavailable until PCM history has enough space');
            throw new Error(this.historyFailureReason);
        }
        try {
            const copy = this.engine.context.createBuffer(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
            for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
                copy.getChannelData(channel).set(audioBuffer.getChannelData(channel));
            }
            this.pendingOverdubRollbackSnapshot = { ...this.capturePcmSnapshot(audioBuffer), buffer: copy };
            this.overdubBaselineSnapshot = this.pendingOverdubRollbackSnapshot;
        } catch (error) {
            this.pcmHistoryBudget.release(this.overdubSnapshotBudgetOwner);
            this.pendingOverdubRollbackSnapshot = null;
            this.overdubBaselineSnapshot = null;
            this.historyFailureReason = `PCM history could not allocate its pre-overdub snapshot: ${error instanceof Error ? error.message : String(error)}.`;
            throw new Error(this.historyFailureReason);
        }
        this.overdubHasEdited = false;
        this.overdubRollbackAborted = false;
        this.overdubRollbackRestored = false;
        this.overdubStopFrameTarget = null;
        this.overdubLastAppliedInputFrameExclusive = null;
        this.overdubLastReceivedPatchEndFrame = null;
        this.overdubAppliedFrameCount = 0;
    }

    private activateOverdubUndoSnapshot(): boolean {
        const snapshot = this.pendingOverdubRollbackSnapshot;
        if (!snapshot || !this.pcmHistoryBudget.transfer(this.overdubSnapshotBudgetOwner, this)) return false;
        this.pcmHistory = { snapshot, direction: 'undo' };
        this.pendingOverdubRollbackSnapshot = null;
        this.historyFailureReason = null;
        return true;
    }

    private releasePendingOverdubSnapshot(): void {
        if (!this.pendingOverdubRollbackSnapshot) return;
        this.pendingOverdubRollbackSnapshot = null;
        this.pcmHistoryBudget.release(this.overdubSnapshotBudgetOwner);
    }

    private appendOverdubStopJournal(inputFrame: number, loopIndex: number, leftBefore: number, rightBefore: number): void {
        const journal = this.overdubStopRollbackJournal;
        if (!journal) throw new Error('Overdub stop rollback journal was not reserved');
        const slot = journal.writeCursor;
        journal.inputFrames[slot] = inputFrame;
        journal.loopIndices[slot] = loopIndex;
        journal.leftBefore[slot] = leftBefore;
        if (journal.rightBefore) journal.rightBefore[slot] = rightBefore;
        journal.writeCursor = (slot + 1) % journal.capacity;
        journal.retainedFrames = Math.min(journal.capacity, journal.retainedFrames + 1);
    }

    private restorePreOverdubPcm(): boolean {
        const current = this.audioBuffer;
        const baselineIsActiveHistory = !!this.overdubBaselineSnapshot
            && this.pcmHistory?.snapshot === this.overdubBaselineSnapshot;
        const snapshot = this.overdubBaselineSnapshot?.buffer;
        if (!current || !snapshot || current.length !== snapshot.length
            || current.numberOfChannels !== snapshot.numberOfChannels || current.sampleRate !== snapshot.sampleRate) return false;
        for (let channel = 0; channel < current.numberOfChannels; channel += 1) {
            current.getChannelData(channel).set(snapshot.getChannelData(channel));
        }
        this.projectPcmRevision += 1;
        if (this.pendingOverdubRollbackSnapshot) this.releasePendingOverdubSnapshot();
        // While an overdub is in flight the previous undo/redo entry remains
        // authoritative. Its budget was reserved alongside this rollback copy;
        // only discard it if the rollback image itself had already become the
        // active history entry.
        if (baselineIsActiveHistory) {
            this.pcmHistory = null;
            this.pcmHistoryBudget.release(this);
        }
        this.overdubBaselineSnapshot = null;
        this.overdubRollbackRestored = true;
        this.overdubDiagnostic = 'The overdub was rolled back because its stop-frame journal exceeded the bounded safety window.';
        this.overdubHasEdited = false;
        this.overdubAppliedFrameCount = 0;
        this.overdubRollbackAborted = true;
        if (this.overdubStopRollbackJournal) {
            this.overdubStopRollbackJournal.writeCursor = 0;
            this.overdubStopRollbackJournal.retainedFrames = 0;
        }
        this.overdubLastAppliedInputFrameExclusive = null;
        return true;
    }

    private rollbackOverdubTail(stopFrame: number): boolean {
        const journal = this.overdubStopRollbackJournal;
        const latest = this.overdubLastAppliedInputFrameExclusive;
        if (!journal || latest === null || latest <= stopFrame) return true;

        const oldestSlot = (journal.writeCursor - journal.retainedFrames + journal.capacity) % journal.capacity;
        const oldestFrame = journal.retainedFrames > 0 ? journal.inputFrames[oldestSlot]! : Number.POSITIVE_INFINITY;
        if (journal.retainedFrames === journal.capacity && oldestFrame > stopFrame) {
            return this.restorePreOverdubPcm();
        }

        const buffer = this.audioBuffer;
        if (!buffer) return false;
        const left = buffer.getChannelData(0);
        const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
        let rolledFrames = 0;
        while (journal.retainedFrames > 0) {
            const slot = (journal.writeCursor - 1 + journal.capacity) % journal.capacity;
            if (journal.inputFrames[slot]! < stopFrame) break;
            const index = journal.loopIndices[slot]!;
            if (index >= left.length || (right && index >= right.length)) return false;
            left[index] = journal.leftBefore[slot]!;
            if (right && journal.rightBefore) right[index] = journal.rightBefore[slot]!;
            journal.writeCursor = slot;
            journal.retainedFrames -= 1;
            rolledFrames += 1;
        }
        if (rolledFrames > 0) {
            this.overdubAppliedFrameCount = Math.max(0, this.overdubAppliedFrameCount - rolledFrames);
            this.projectPcmRevision += 1;
            const lastSlot = (journal.writeCursor - 1 + journal.capacity) % journal.capacity;
            this.overdubLastAppliedInputFrameExclusive = journal.retainedFrames > 0
                ? journal.inputFrames[lastSlot]! + 1 : null;
            if (this.overdubAppliedFrameCount === 0) {
                this.overdubHasEdited = false;
            }
        }
        return true;
    }

    private restoreLoopTransportAfterOverdub(): void {
        const snapshot = this.loopTransportOverdubSnapshot;
        this.loopTransportOverdubSnapshot = null;
        if (!snapshot || this.pendingClear) return;
        for (let slotIndex = 0; slotIndex < snapshot.length; slotIndex += 1) {
            const slot = snapshot[slotIndex];
            if (!slot) continue;
            const parameters: Record<string, number> = slot.type === 'BEAT SHIFT'
                ? { offset: slot.beatShiftOffsetBeats, crossfade: slot.beatShiftCrossfadeMs }
                : {
                    speed: slot.vinylFlickSpeed,
                    mix: slot.vinylFlickMix,
                    'return-time': slot.vinylFlickReturnTimeSeconds,
                    brake: slot.vinylFlickBrakePercent,
                };
            this.configureLoopTransportFx(slotIndex, slot.type, parameters);
        }
    }

    private getOverdubStopFrame(): number | null {
        const fromInputClock = this.engine.getInputCaptureRequestFrame?.();
        if (Number.isSafeInteger(fromInputClock) && fromInputClock! >= 0) return fromInputClock!;
        const context = this.engine.context as AudioContext;
        const currentTime = context.currentTime;
        const sampleRate = context.sampleRate;
        if (!Number.isFinite(currentTime) || currentTime < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
        const frame = Math.ceil(currentTime * sampleRate);
        return Number.isSafeInteger(frame) && frame >= 0 ? frame : null;
    }

    private stopOverdub() {
        this.overdubStartGeneration += 1;
        this.overdubStarting = false;
        const captureSession = this.overdubCaptureSession;
        if (captureSession) this.releaseOverdubCaptureSession(captureSession, true);
        const workletNode = this.overdubProcessor;
        if (!workletNode || this.overdubStopping) return;

        this.overdubStopping = true;
        const stopFrame = this.getOverdubStopFrame();
        this.overdubStopFrameTarget = stopFrame;
        if (stopFrame === null) {
            if (!this.overdubRollbackAborted && !this.restorePreOverdubPcm()) this.invalidatePcmHistoryForEdit();
            this.overdubDiagnostic = 'Overdub was rolled back because the exact stop frame could not be read from the audio clock.';
        } else if (!this.overdubRollbackAborted && !this.rollbackOverdubTail(stopFrame)) {
            if (!this.restorePreOverdubPcm()) this.invalidatePcmHistoryForEdit();
            this.overdubDiagnostic = 'Overdub was rolled back because the stop-frame journal could not restore the post-request tail.';
        }
        this.watchOverdubDrain(workletNode);
        try {
            workletNode.port.postMessage({ type: 'OVERDUB_STOP', stopFrame });
        } catch (error) {
            this.overdubDiagnostic = `Overdub stopped with an AudioWorklet error: ${error instanceof Error ? error.message : String(error)}.`;
            this.finishOverdubNode(workletNode);
        }
    }

    private abortRecording() {
        this.clearRecordingCaptureStopAckTimeout();
        this.recordingStartGeneration += 1;
        this.recordingStarting = false;
        this.quantizedRecordingStartFrame = null;
        this.quantizedRecordingPhaseRevision = null;
        this.quantizedRecordingTrackSyncRevision = null;
        this.autoRecArmed = false;
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
        const captureSession = this.recordingCaptureSession;
        if (captureSession) {
            this.engine.abortInputCaptureSession?.(captureSession);
            this.returnRetainedSharedCaptureChunks(captureSession);
            this.engine.releaseInputCaptureSession?.(captureSession);
            this.recordingCaptureSession = null;
            try { this.recordingInputNode?.disconnect(this.fxChain.input); } catch { /* already disconnected */ }
            this.recordingInputNode = null;
            if (this.workletNode === captureSession.node) this.workletNode = null;
        }
        this.clearRecordingChunkStorage();

        if (this.workletNode && !captureSession) {
            this.workletNode.port.onmessage = null;
            try { this.recordingInputNode?.disconnect(this.workletNode); } catch { /* already disconnected */ }
            this.recordingInputNode = null;
            this.workletNode.disconnect();
            this.workletNode.port.close?.();
            this.workletNode = null;
        }
    }

}

function shiftSamplesInPlace(samples: Float32Array, offsetSamples: number) {
    const length = samples.length;
    if (length < 2 || !Number.isFinite(offsetSamples)) return;

    let shift = Math.trunc(offsetSamples) % length;
    if (shift < 0) shift += length;
    if (shift === 0) return;

    // Existing offset semantics rotate left by the configured sample offset.
    reverseRange(samples, 0, shift);
    reverseRange(samples, shift, length);
    reverseRange(samples, 0, length);
}

function reverseRange(samples: Float32Array, start: number, end: number) {
    let left = start;
    let right = end - 1;
    while (left < right) {
        const value = samples[left] ?? 0;
        samples[left] = samples[right] ?? 0;
        samples[right] = value;
        left += 1;
        right -= 1;
    }
}
