import { translateBrowserOfficialSourceParameters } from './fx/dsp/OfficialBrowserSourceParameters';
import { isOfficialFxSlotAllowed } from './fx/official/parameters';
import { BROWSER_OFFICIAL_PARAMETER_KEYS } from './fx/official/browserBindings';
import { BROWSER_OFFICIAL_PARAMETER_KEYS as BROWSER_OFFICIAL_STREAM_KEYS } from './fx/dsp/OfficialBrowserParameters';
import { findOfficialRuntimeParameter, resolveOfficialEffect, isOfficialRuntimeValueValid, mergeOfficialParameterEdit } from './fx/official/parameters';
import { TrackAudio } from './TrackAudio';
import { Track, TrackState } from '../core/types';
import { Transport } from '../core/Transport';
import { FXChain } from './FXChain';
import type { FXBase } from './fx/FXBase';
import { fxCatalogIdForDisplayLabel } from './fx/fxTypeIdentity';
import { FilterFX } from './fx/FilterFX';
import { DelayFX } from './fx/DelayFX';
import { ReverbFX } from './fx/ReverbFX';
import { SlicerFX } from './fx/SlicerFX';
import { PhaserFX } from './fx/PhaserFX';
import { BrowserAutoRiffFX } from './fx/BrowserAutoRiffFX';
import { BrowserTransposeFX } from './fx/BrowserTransposeFX';
import { BrowserPitchBendFX } from './fx/BrowserPitchBendFX';
import { BrowserManualHarmonistFX } from './fx/BrowserManualHarmonistFX';
import { BrowserHrmAutoFX } from './fx/BrowserHrmAutoFX';
import { isNativeLoopTransportConfig, type NativeLoopTransportConfig } from './NativeBridgeClient';
import { BrowserRobotFX } from './fx/BrowserRobotFX';
import { BrowserOctaveFX } from './fx/BrowserOctaveFX';
import { BrowserVocoderFX } from './fx/BrowserVocoderFX';
import { MidiInputController, type MidiInputState, type MidiNoteEvent } from './MidiInputController';
import type { BrowserFxAlgorithm, BrowserFxParameters } from './fx/dsp/BrowserFxDspCore';
import { copyRecoveryFxParameters, type BrowserRecoveryFxSlot, type BrowserRecoverySnapshot } from './BrowserRecoverySnapshot';
import { BrowserWorkletFX, BROWSER_WORKLET_FX_TYPES, type BrowserWorkletFxName } from './fx/BrowserWorkletFX';
import { BrowserTrackFxChain, type BrowserTrackFxStatus } from './BrowserTrackFxChain';
import { createBrowserPcmHistoryBudget, getBrowserPcmHistoryBudget } from './PcmHistoryBudget';
import {
    encodeProjectArchive,
    PROJECT_ARCHIVE_LIMITS,
    type ProjectArchive,
    type ProjectArchiveInput,
    type ProjectArchiveTrackList,
    type BrowserProjectRestoreToken,
} from './projectArchive';

import { RhythmEngine } from './RhythmEngine';
import type { IAudioEngine, InputCaptureSession } from './AudioEngineInterface';
import {
    addAudioWorkletModuleWithTimeout,
    getUserMediaWithTimeout,
    resumeAudioContextWithTimeout,
    withBrowserAudioTimeout,
} from './browserAudioStartup';

export interface BrowserAudioLatencyInfo {
    sampleRate: number;
    baseLatencyMs: number | null;
    outputLatencyMs: number | null;
    estimatedMonitoringLatencyMs: number | null;
    roundTripLatencyMs: number | null;
}

function disconnectAudioNodeIfConnected(node: AudioNode, destination: AudioNode): void {
    try {
        node.disconnect(destination);
    } catch (error) {
        // Web Audio specifies InvalidAccessError when that exact edge is absent.
        // Other graph failures remain visible to the caller.
        if (error && typeof error === 'object' && 'name' in error
            && (error as { name?: unknown }).name === 'InvalidAccessError') return;
        throw error;
    }
}

export interface BrowserAudioUiStatus {
    mode: 'browser';
    bridgeAvailable: boolean;
    engineRunning: boolean;
    ready: boolean;
    message: string;
    lastError: string;
    /** Input readiness is independent of output/worklet readiness. */
    inputReady?: boolean;
    /** The shared input worklet has a contiguous pre-roll ring for exact-frame capture. */
    inputCaptureReady?: boolean;
    /** Input is connected but the shared capture ring is warming or rewarming. */
    inputCaptureWarming?: boolean;
    inputCaptureWarmupReason?: string;
    inputCaptureUnavailableReason?: string;
    inputState?: 'not-requested' | 'requesting' | 'ready' | 'error';
    inputError?: string;
    /** Candidate recovery is installed, muted and suspended until an explicit resume click. */
    recoveryAwaitingUserResume?: boolean;
}

const CLOSED_AUDIO_CONTEXT_ERROR = 'Browser AudioContext is permanently closed. Existing loops remain in memory; export them from Memory before reloading because reloading without an exported project loses unsaved loops.';
const MINIMUM_EXACT_CAPTURE_PREROLL_FRAMES = 8_192;

export type BrowserStepSlicerControl = 'step_count' | 'rate_beats' | 'pan_depth_percent' | 'filter_hz';
export interface BrowserMidiInputTarget {
    readonly path: 'input' | 'track';
    readonly slot: 'A' | 'B' | 'C' | 'D';
    /** OSC VOC is the default; HRM AUTO (M) may target a shared bank or one private A–D slot. */
    readonly effectId?: 'osc_voc_m' | 'hrm_auto_m';
    /** 1–5 selects that private Track A–D chain; 0/omitted keeps legacy Input+shared Track OSC broadcast. */
    readonly trackId?: number;
}

export type BrowserLoopTransportFxName = 'BEAT SHIFT' | 'VINYL FLICK';
export interface BrowserTrackTransportStatus {
    readonly trackIndex: number;
    readonly trackId: number;
    /** Experimental source transport; legacy Track-bank processing remains shared after TrackMix. */
    readonly routeMode: 'experimental-source-pre-track-mix-shared-postmix';
    readonly perTrackFxChainAvailable: boolean;
    /** True while a source-aware reader is currently driving this track. */
    readonly active: boolean;
    /** Active source-aware A–D slots, even if the track is stopped or unavailable. */
    readonly configuredEffects: ReadonlyArray<{
        readonly slot: 'A' | 'B' | 'C' | 'D';
        readonly type: BrowserLoopTransportFxName;
    }>;
    readonly unsupportedEffects: ReadonlyArray<{
        readonly slot: 'A' | 'B' | 'C' | 'D';
        readonly type: BrowserLoopTransportFxName;
        readonly reason: string;
    }>;
    /** Reverse, LIVE_MONO, and LIVE_POLY conflicts are reported here per track. */
    readonly unavailableReason: string | null;
}

export class BrowserAudioEngine implements IAudioEngine {
    public context: AudioContext;
    /** Transparent master-bus worklet that reports the actual browser quantum. */
    public workletNode: AudioWorkletNode | null = null;
    /** Optional clean-room DSP worklet inserted on the Browser output path. */
    public outputDspFxNode: AudioWorkletNode | null = null;
    public tracks: TrackAudio[] = [];
    public sharedBuffer: SharedArrayBuffer | null = null;
    public trackStates: Int32Array | null = null; // State enum
    public trackPositions: Float32Array | null = null; // 0.0 to 1.0
    public roundTripLatency: number = 0; // in seconds

    // ========================================
    // AUDIO I/O MANAGEMENT (CRITICAL SAFETY)
    // ========================================

    private currentInputStream: MediaStreamAudioSourceNode | null = null;
    private currentMediaStream: MediaStream | null = null;
    private inputDeviceRequestGeneration = 0;
    private currentInputRequestGeneration = 0;
    private inputTrackEndedHandlers: Array<{ track: MediaStreamTrack; listener: EventListener }> = [];
    private monitorGainNode: GainNode | null = null;
    private inputCaptureNode: AudioWorkletNode | null = null;
    private inputCaptureMuteGainNode: GainNode | null = null;
    private inputCaptureGeneration = 0;
    private nextInputCaptureSessionId = 1;
    private inputCaptureReady = false;
    private inputCaptureReadyGeneration = 0;
    private inputCaptureWarmupReason = '';
    private inputCaptureUnavailableReason = '';
    private closedAudioContextHandled = false;
    private readonly inputCaptureSessions = new Map<number, {
        readonly session: InputCaptureSession;
        readonly listener: (message: unknown) => void;
    }>();
    private readonly inputCaptureReadyWaiters = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
    private readonly inputCaptureRecycleMessage = {
        type: 'RECYCLE_CHUNK', trackIndex: 0, sessionId: 0, chunkIndex: 0,
        channels: [] as Float32Array[],
    };
    private readonly inputCaptureRecycleTransfers: Transferable[] = [new ArrayBuffer(0), new ArrayBuffer(0)];
    private readonly handleAudioContextStateChange = () => {
        if (this.isAudioContextClosed()) {
            this.handleClosedAudioContext();
            return;
        }
        // Suspended contexts are not output-ready. Publish both suspension and
        // resume transitions so the UI never advertises a live audio graph
        // while the browser has stopped its render thread.
        this.emitStatus();
    };
    private readonly transportBpmChangeListener = () => this.handleTransportBpmChange();
    private transportBpmChangeSubscribed = false;

    // FX Chains & Mixing
    public inputFxChain: FXChain;
    public outputFxChain: FXChain;
    public trackMixNode: GainNode;
    public masterGainNode: GainNode;

    // Rhythm Engine
    public rhythmEngine: RhythmEngine;

    public selectedInputDeviceId: string | null = null;
    public selectedOutputDeviceId: string | null = null;
    /** Last render-quantum size observed from the browser; 0 means not yet known. */
    public selectedBufferFrames: number = 0;
    public monitoringEnabled: boolean = false; // DEFAULT: FALSE to prevent feedback!
    private monitoringListeners = new Set<(enabled: boolean) => void>();
    private latencyListeners = new Set<(info: BrowserAudioLatencyInfo) => void>();
    private statusListeners = new Set<(status: BrowserAudioUiStatus) => void>();
    private midiInputListeners = new Set<(state: MidiInputState) => void>();
    private midiInputState: MidiInputState = 'disconnected';
    private readonly midiInput: MidiInputController;
    private initialized = false;
    private lastError = '';
    private inputState: 'not-requested' | 'requesting' | 'ready' | 'error' = 'not-requested';
    private inputError = '';
    private workletModulePromises = new Map<string, Promise<void>>();
    private fxWorkletModuleReady: Promise<void> | null = null;
    private fxWorkletGeneration = 0;
    private outputDspAlgorithmValue: BrowserFxAlgorithm | null = null;
    private outputDspParametersValue: BrowserFxParameters = {};
    private outputDspEnabledValue = false;
    private recoveryAdoptionState: 'new' | 'prepared' | 'claimed' | 'adopted' = 'new';
    /** Stays pending across a partial output-runtime failure after AudioContext.resume(). */
    private recoveredOutputRuntimeReady = false;
    private preparedRecoverySnapshot: BrowserRecoverySnapshot | null = null;
    /** Real private A–D banks before TrackMix; legacy trackFxInstances stay postmix. */
    private perTrackFxChains: BrowserTrackFxChain[] = [];
    /** Explicit one-track source-transport overrides; they never enter shared A–D processing. */
    private trackLoopTransportOverrides = new Map<number, NativeLoopTransportConfig>();
    private handleTransportBpmChange(): void {
        const bpm = Transport.getInstance().bpm;
        const legacyTempo = new Set(['beat-repeat', 'beat-scatter', 'roll', 'beat-shift', 'pattern-slicer', 'step-slicer', 'isolator', 'reverse-delay', 'reverse-reverb', 'osc-bot', 'warp']);
        for (const fx of [...this.trackFxInstances, ...this.inputFxInstances]) {
            if (fx instanceof BrowserWorkletFX && (legacyTempo.has(fx.algorithm) || BROWSER_OFFICIAL_STREAM_KEYS[fx.algorithm])) fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && BROWSER_OFFICIAL_STREAM_KEYS[fx.algorithm]) fx.setParam('quarterNotesPerMeasure', Transport.getInstance().quarterNotesPerMeasure);
            if (fx instanceof BrowserAutoRiffFX) { fx.setParam('bpm', bpm); fx.setParam('quarterNotesPerMeasure', Transport.getInstance().quarterNotesPerMeasure); }
        }
        for (const track of this.tracks ?? []) track.refreshLoopTransportTempo();
        for (const bank of this.perTrackFxChains ?? []) bank.setBpm(bpm);
    }

    public constructor(options: {
        context?: AudioContext;
        deferTransportBpmChangeSubscription?: boolean;
        loadDevicePreferences?: boolean;
        historyBudgetBytes?: number;
    } = {}) {
        this.context = options.context ?? new AudioContext({
            latencyHint: 'interactive',
            sampleRate: 44100,
        });
        this.context.addEventListener?.('statechange', this.handleAudioContextStateChange);
        const historyBudget = options.historyBudgetBytes === undefined
            ? getBrowserPcmHistoryBudget(this)
            : createBrowserPcmHistoryBudget(this, options.historyBudgetBytes);

        this.midiInput = new MidiInputController(
            (event) => this.handleMidiNote(event),
            { onStateChange: (state) => {
                this.midiInputState = state;
                for (const listener of this.midiInputListeners) listener(state);
            } },
        );

        // Initialize SharedArrayBuffer
        this.sharedBuffer = new SharedArrayBuffer(1024);
        this.trackStates = new Int32Array(this.sharedBuffer, 0, 5);
        this.trackPositions = new Float32Array(this.sharedBuffer, 20, 5);

        // Create monitor gain node (for software monitoring)
        this.monitorGainNode = this.context.createGain();
        this.monitorGainNode.gain.value = 0; // MUTED by default (SAFETY!)
        this.monitorGainNode.connect(this.context.destination);

        // Initialize FX Chains & Mixing
        this.inputFxChain = new FXChain(this.context);
        this.outputFxChain = new FXChain(this.context);
        this.trackMixNode = this.context.createGain();
        this.masterGainNode = this.context.createGain();

        // Master Routing: TrackMix -> OutputFX -> MasterGain -> Destination
        this.trackMixNode.connect(this.outputFxChain.input);
        this.outputFxChain.output.connect(this.masterGainNode);
        this.masterGainNode.connect(this.context.destination);
        this.inputFxChain.output.connect(this.monitorGainNode);

        // Initialize Rhythm Engine
        this.rhythmEngine = new RhythmEngine(this.context, () => this.emitStatus());
        this.rhythmEngine.connect(this.masterGainNode);

        // Initialize 5 tracks
        for (let i = 0; i < 5; i++) {
            const trackData = new Track(i + 1);
            const track = new TrackAudio(this, trackData, i, this.trackStates, this.trackPositions, historyBudget);
            const bank = new BrowserTrackFxChain(this.context, () => this.ensureFxWorkletModule(), () => this.emitStatus(), () => Transport.getInstance().bpm, () => Transport.getInstance().quarterNotesPerMeasure, (trackId) => this.tracks[trackId - 1]?.playbackSourceOutput ?? null);
            track.installTrackFxInsert(bank.input, bank.output);
            this.perTrackFxChains.push(bank);
            this.tracks.push(track);
        }

        // Load saved device preferences
        if (options.loadDevicePreferences !== false) this.loadDevicePreferences();
        if (!options.deferTransportBpmChangeSubscription) this.attachTransportBpmChangeSubscription();
    }

    /** Build the actual, stopped five-track graph from candidate-context PCM. */
    public async restoreRecoverySnapshot(snapshot: BrowserRecoverySnapshot): Promise<void> {
        if (this.recoveryAdoptionState !== 'new' || this.context.state !== 'suspended'
            || this.context.sampleRate !== snapshot.source.sampleRate || this.tracks.length !== 5
            || this.hasTransportBpmChangeSubscription() || this.currentMediaStream || this.currentInputStream
            || this.midiInputState !== 'disconnected') {
            throw new Error('Browser recovery graph must be a new, suspended, disconnected five-track engine.');
        }
        if (snapshot.pcmHistoryBudget.limitBytes < 0 || !Number.isSafeInteger(snapshot.pcmHistoryBudget.limitBytes)
            || this.tracks.some((track) => track.historyBudgetBytes !== snapshot.pcmHistoryBudget.limitBytes)) {
            throw new Error('Candidate Browser engine did not receive the saved shared PCM history budget.');
        }
        const pcm = TrackAudio.restoreRecoverySnapshotsAtomically(this.tracks, snapshot.tracks);
        if (!pcm.ok) throw new Error(pcm.reason || 'Candidate Browser engine could not restore all five PCM/history snapshots.');

        const rhythmApplied = this.rhythmEngine.setSettings({
            patternIndex: snapshot.rhythm.patternIndex,
            kitIndex: snapshot.rhythm.kitIndex,
            variation: snapshot.rhythm.variation as 'A' | 'B' | 'C',
            section: snapshot.rhythm.section as 'intro' | 'main' | 'fill' | 'ending',
            swingPercent: snapshot.rhythm.swingPercent,
            quantizeGrid: snapshot.rhythm.quantizeGrid as '1/16' | '1/8' | '1/4',
        });
        if (!rhythmApplied || this.rhythmEngine.isRunning) throw new Error('Candidate Browser rhythm settings could not be restored in stopped state.');
        this.rhythmEngine.setVolume(snapshot.rhythm.volumePercent);

        const restoreSharedBank = (location: 'input' | 'track', savedSlots: readonly BrowserRecoveryFxSlot[]) => {
            for (let index = 0; index < savedSlots.length; index += 1) {
                const saved = savedSlots[index]!;
                if (!saved.type) continue;
                this.setFxType(location, index, saved.type);
                const parameters: Record<string, number> = {};
                for (const [key, value] of Object.entries(saved.parameters)) {
                    if (key === 'bypassed' && saved.type.trim().toUpperCase() === 'SLICER') continue;
                    if (typeof value !== 'number' || !Number.isFinite(value)) {
                        throw new Error(`Candidate Browser ${location} ${saved.type} slot ${saved.slot} has a parameter that cannot be applied to its live adapter.`);
                    }
                    parameters[key] = value;
                }
                if (Object.keys(parameters).length > 0) this.setFxNamedParameters(location, index, parameters);
                if (saved.amount !== null) this.setFxParam(location, index, saved.amount);
                this.setFxActive(location, index, saved.active);
            }
        };
        restoreSharedBank('input', snapshot.fx.input);
        restoreSharedBank('track', snapshot.fx.sharedTrack);

        for (let trackIndex = 0; trackIndex < snapshot.fx.privateTracks.length; trackIndex += 1) {
            const trackId = trackIndex + 1;
            for (let slotIndex = 0; slotIndex < snapshot.fx.privateTracks[trackIndex]!.length; slotIndex += 1) {
                const saved = snapshot.fx.privateTracks[trackIndex]![slotIndex]!;
                if (!saved.type) continue;
                if (!this.setTrackFxType(trackId, slotIndex, saved.type)) {
                    throw new Error(`Candidate Browser Track ${trackId} slot ${saved.slot} rejected ${saved.type}.`);
                }
                if (saved.amount !== null && !this.setTrackFxParameter(trackId, slotIndex, saved.amount)) {
                    throw new Error(`Candidate Browser Track ${trackId} ${saved.type} rejected its saved amount.`);
                }
                const parameters: Record<string, number> = {};
                for (const [key, value] of Object.entries(saved.parameters)) {
                    if (typeof value !== 'number' || !Number.isFinite(value)) {
                        throw new Error(`Candidate Browser Track ${trackId} ${saved.type} slot ${saved.slot} has a non-numeric named parameter.`);
                    }
                    parameters[key] = value;
                }
                if (Object.keys(parameters).length > 0 && !this.setTrackFxNamedParameters(trackId, slotIndex, parameters)) {
                    throw new Error(`Candidate Browser Track ${trackId} ${saved.type} rejected its saved named parameters.`);
                }
                if (!this.setTrackFxActive(trackId, slotIndex, saved.active)) {
                    throw new Error(`Candidate Browser Track ${trackId} ${saved.type} rejected its saved active state.`);
                }
            }
        }
        await this.waitForRecoveryFxReady(snapshot);

        for (const override of snapshot.fx.sourceOverrides) {
            if (!isNativeLoopTransportConfig(override.config) || !this.setLoopTransport(override.trackId, override.config)) {
                throw new Error(`Candidate Browser Track ${override.trackId} rejected its saved source-reader override.`);
            }
        }

        if (snapshot.fx.outputDsp.algorithm !== null) {
            const configured = await this.setOutputDspFx(
                snapshot.fx.outputDsp.algorithm as BrowserFxAlgorithm,
                snapshot.fx.outputDsp.parameters as BrowserFxParameters,
                snapshot.fx.outputDsp.enabled,
            );
            if (!configured) throw new Error('Candidate Browser output DSP could not be created.');
        }

        for (const [index, saved] of snapshot.tracks.entries()) {
            const track = this.tracks[index]!;
            if (saved.pitch.mode === 'LIVE_MONO') {
                await track.setLiveMonoPitchEnabled(true, {
                    semitones: saved.pitch.liveMono.semitones,
                    minimumFrequencyHz: saved.pitch.liveMono.minimumFrequencyHz,
                    maximumFrequencyHz: saved.pitch.liveMono.maximumFrequencyHz,
                });
            } else if (saved.pitch.mode === 'LIVE_POLY') {
                await track.setLivePolyPitchEnabled(true, {
                    semitones: saved.pitch.livePoly.semitones,
                    playbackRate: saved.pitch.livePoly.playbackRate,
                    tonalityLimitHz: saved.pitch.livePoly.tonalityLimitHz,
                });
            }
        }
        this.restoreDisconnectedMidiTarget(snapshot.midi.target);
        this.trackMixNode.gain.setValueAtTime(snapshot.trackMixGainValue, this.context.currentTime);
        // AudioParam.value can continue reporting the intrinsic default while
        // a suspended context has a scheduled value at currentTime. Set the
        // immediate value too so the zero-gain invariant is observable and
        // remains in force if the context resumes before later setup.
        this.monitorGainNode!.gain.value = 0;
        this.monitorGainNode!.gain.setValueAtTime(0, this.context.currentTime);
        this.masterGainNode.gain.value = 0;
        this.masterGainNode.gain.setValueAtTime(0, this.context.currentTime);
        this.monitoringEnabled = false;
        if (this.context.state !== 'suspended') throw new Error('Candidate Browser AudioContext left the suspended state while restoring its graph.');
    }

    private async waitForRecoveryFxReady(snapshot: BrowserRecoverySnapshot): Promise<void> {
        const deadline = Date.now() + 12_000;
        while (true) {
            const privateStatuses = this.getTrackFxStatus();
            const sharedStatuses = [
                this.getSharedFxRecoverySnapshot('input'),
                this.getSharedFxRecoverySnapshot('track'),
            ];
            const error = [...privateStatuses.flatMap((bank) => bank.slots), ...sharedStatuses.flat()]
                .find((slot) => slot.state === 'error');
            if (error) throw new Error(`Candidate Browser FX ${error.type ?? error.slot} failed readiness: ${error.error ?? 'unknown error'}.`);
            const loading = [...privateStatuses.flatMap((bank) => bank.slots), ...sharedStatuses.flat()]
                .some((slot) => slot.state === 'loading');
            if (!loading) break;
            if (Date.now() >= deadline) throw new Error('Candidate Browser FX readiness timed out; old PCM remains available.');
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        const privateActual = this.perTrackFxChains.map((bank) => bank.getRecoverySnapshot());
        if (JSON.stringify(privateActual) !== JSON.stringify(snapshot.fx.privateTracks)) {
            throw new Error('Candidate Browser per-track FX parameters differ from the saved acknowledged configuration.');
        }
        for (const location of ['input', 'track'] as const) {
            const actual = this.getSharedFxRecoverySnapshot(location);
            const expected = location === 'input' ? snapshot.fx.input : snapshot.fx.sharedTrack;
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                throw new Error(`Candidate Browser ${location} FX differ from the saved acknowledged configuration.`);
            }
        }
    }

    private restoreDisconnectedMidiTarget(target: BrowserRecoverySnapshot['midi']['target']): void {
        this.midiInput.disconnect();
        this.midiInputState = 'disconnected';
        this.clearMidiTargetState();
        this.midiRoutingMode = 'legacy-broadcast';
        if (!target) return;
        const slotIndex = this.slotIndex(target.slot as BrowserMidiInputTarget['slot']);
        if (slotIndex < 0) throw new Error('Saved Browser MIDI target has an invalid slot.');
        if ((target.effectId === 'osc_voc_m' || target.effectId === 'hrm_auto_m') && Number.isInteger(target.trackId) && target.trackId! > 0) {
            const bank = target.path === 'track' ? this.getPerTrackFxChain(target.trackId!) : undefined;
            const effectId = target.effectId;
            if (!bank?.canReceiveMidiNotes(slotIndex, effectId)) throw new Error('Saved Browser private MIDI target is not ready in the candidate graph.');
            this.selectedTrackMidiTarget = { trackId: target.trackId!, slotIndex, effectId };
            this.midiRoutingMode = effectId === 'hrm_auto_m' ? 'private-track-hrm-auto' : 'private-track-osc-voc';
            return;
        }
        if (target.effectId === 'hrm_auto_m' && (target.path === 'input' || target.path === 'track')) {
            const effect = (target.path === 'input' ? this.inputFxInstances : this.trackFxInstances)[slotIndex];
            if (!(effect instanceof BrowserHrmAutoFX) || !effect.processorReady || effect.error) {
                throw new Error('Saved Browser shared HRM AUTO MIDI target is not ready in the candidate graph.');
            }
            this.selectedHrmAutoMidiTarget = { path: target.path, slot: target.slot as BrowserMidiInputTarget['slot'], effect };
            this.midiRoutingMode = 'hrm-auto';
            return;
        }
        throw new Error('Saved Browser MIDI target is unsupported by the recovery graph.');
    }

    /**
     * Recovery candidates are prepared against a private suspended context and
     * must not observe the shared Transport until the facade publishes them.
     * This explicit, idempotent hook makes that ownership boundary reversible.
     */
    public attachTransportBpmChangeSubscription(): void {
        if (this.transportBpmChangeSubscribed) return;
        Transport.getInstance().on('bpm-change', this.transportBpmChangeListener);
        Transport.getInstance().on('time-signature-change', this.transportBpmChangeListener);
        this.transportBpmChangeSubscribed = true;
    }

    public detachTransportBpmChangeSubscription(): void {
        if (!this.transportBpmChangeSubscribed) return;
        Transport.getInstance().off('bpm-change', this.transportBpmChangeListener);
        Transport.getInstance().off('time-signature-change', this.transportBpmChangeListener);
        this.transportBpmChangeSubscribed = false;
    }

    /**
     * Retire a successfully replaced, already-closed engine. Track PCM and
     * history buffers deliberately remain on the retired object for export;
     * only context-bound graph ownership and global subscriptions are released.
     */
    public retireAfterRecoveryAdoption(): void {
        this.assertRetirableAfterRecoveryAdoption();
        this.detachTransportBpmChangeSubscription();
        this.context.removeEventListener?.('statechange', this.handleAudioContextStateChange);
        this.midiInput.disconnect();
        for (const track of this.tracks) track.dispose();
        this.rhythmEngine.dispose();
        for (const bank of this.perTrackFxChains) bank.dispose();
        for (const effect of this.inputFxInstances) effect?.dispose?.();
        for (const effect of this.trackFxInstances) effect?.dispose?.();
        this.inputFxChain.dispose();
        this.outputFxChain.dispose();
        if (this.outputDspFxNode) {
            this.outputDspFxNode.port.onmessage = null;
            this.outputDspFxNode.onprocessorerror = null;
            try { this.outputDspFxNode.disconnect(); } catch { /* old context is closed */ }
            try { this.outputDspFxNode.port.close(); } catch { /* already closed */ }
            this.outputDspFxNode = null;
        }
        try { this.monitorGainNode?.disconnect(); } catch { /* old context is closed */ }
        try { this.trackMixNode.disconnect(); } catch { /* old context is closed */ }
        try { this.masterGainNode.disconnect(); } catch { /* old context is closed */ }
        // Do not clear tracks or their history budget: the caller owns this
        // retired object until it no longer needs PCM export/diagnostics.
    }

    public assertRetirableAfterRecoveryAdoption(): void {
        if (this.context.state !== 'closed') {
            throw new Error('An old Browser engine can be retired only after its AudioContext is closed.');
        }
        if (this.tracks.length !== 5) throw new Error('Old Browser engine does not own all five PCM tracks.');
        for (const track of this.tracks) track.assertRetirableAfterContextClosed();
    }

    public hasTransportBpmChangeSubscription(): boolean {
        return this.transportBpmChangeSubscribed;
    }

    /** Return false if a closed-engine snapshot changed while recovery prepared. */
    public isRecoverySnapshotCurrent(snapshot: BrowserRecoverySnapshot): boolean {
        if (this.context.state !== 'closed') return false;
        try {
            const current = this.getRecoverySnapshot();
            if (snapshot.schemaVersion !== current.schemaVersion
                || snapshot.source.sampleRate !== current.source.sampleRate
                || snapshot.source.inputDevicePreference !== current.source.inputDevicePreference
                || snapshot.source.outputDevicePreference !== current.source.outputDevicePreference
                || snapshot.source.lastObservedRenderBlockFrames !== current.source.lastObservedRenderBlockFrames
                || JSON.stringify(snapshot.transport) !== JSON.stringify(current.transport)
                || JSON.stringify(snapshot.rhythm) !== JSON.stringify(current.rhythm)
                || JSON.stringify(snapshot.fx) !== JSON.stringify(current.fx)
                || JSON.stringify(snapshot.midi) !== JSON.stringify(current.midi)
                || snapshot.monitoringWasEnabled !== current.monitoringWasEnabled
                || snapshot.outputGainValue !== current.outputGainValue
                || snapshot.trackMixGainValue !== current.trackMixGainValue
                || JSON.stringify(snapshot.recoveryPolicy) !== JSON.stringify(current.recoveryPolicy)
                || snapshot.pcmHistoryBudget.retainedBytes !== current.pcmHistoryBudget.retainedBytes
                || snapshot.pcmHistoryBudget.limitBytes !== current.pcmHistoryBudget.limitBytes
                || snapshot.tracks.length !== current.tracks.length) return false;
            return snapshot.tracks.every((saved, index) => {
                const now = current.tracks[index];
                if (!now || saved.buffer !== now.buffer || saved.history.buffer !== now.history.buffer) return false;
                const strip = (track: typeof saved) => ({
                    ...track,
                    buffer: null,
                    history: { ...track.history, buffer: null },
                });
                return JSON.stringify(strip(saved)) === JSON.stringify(strip(now));
            });
        } catch {
            return false;
        }
    }

    /** Validate and mute a fully materialized, unpublished recovery engine. */
    public prepareRecoveryAdoption(snapshot: BrowserRecoverySnapshot): void {
        if (this.recoveryAdoptionState === 'claimed' || this.recoveryAdoptionState === 'adopted') {
            throw new Error('Recovery engine ownership has already been claimed or adopted.');
        }
        if (this.recoveryAdoptionState === 'prepared') {
            if (this.preparedRecoverySnapshot === snapshot) return;
            throw new Error('Recovery engine is already prepared for a different snapshot.');
        }
        if (this.context.state !== 'suspended' || this.context.sampleRate !== snapshot.source.sampleRate) {
            throw new Error('Recovery engine must use the saved sample rate in a suspended AudioContext.');
        }
        if (this.tracks.length !== 5 || this.tracks.some((track, index) => {
            const saved = snapshot.tracks[index];
            if (!saved || track.historyBusy) return true;
            const current = track.getRecoverySnapshot();
            return current.buffer !== saved.buffer || current.history.buffer !== saved.history.buffer
                || current.state !== (saved.buffer ? TrackState.STOPPED : TrackState.EMPTY)
                || current.isReverse !== saved.isReverse
                || JSON.stringify(current.settings) !== JSON.stringify(saved.settings)
                || JSON.stringify(current.pitch) !== JSON.stringify(saved.pitch)
                || JSON.stringify(current.sourceTransport) !== JSON.stringify(saved.sourceTransport)
                || JSON.stringify({ ...current.history, buffer: null }) !== JSON.stringify({ ...saved.history, buffer: null });
        })) {
            throw new Error('Recovery engine does not contain the complete stopped five-track PCM/history snapshot.');
        }
        const transport = Transport.getInstance();
        if (transport.bpm !== snapshot.transport.bpm
            || transport.timeSignature[0] !== snapshot.transport.timeSignature[0]
            || transport.timeSignature[1] !== snapshot.transport.timeSignature[1]
            || transport.masterTrackId !== snapshot.transport.masterTrackId
            || transport.masterLoopLengthSamples !== snapshot.transport.masterLoopLengthSamples
            || transport.measureLength !== snapshot.transport.measureLength) {
            throw new Error('Recovery engine transport does not match the still-current project snapshot.');
        }
        const candidatePrivateFx = this.perTrackFxChains.map((bank) => bank.getRecoverySnapshot());
        const candidateSourceOverrides = Array.from(this.trackLoopTransportOverrides.entries())
            .map(([trackId, config]) => ({ trackId, config }));
        const candidateMidiTarget = this.selectedTrackMidiTarget
            ? { path: 'track', slot: ['A', 'B', 'C', 'D'][this.selectedTrackMidiTarget.slotIndex] ?? 'A',
                effectId: this.selectedTrackMidiTarget.effectId, trackId: this.selectedTrackMidiTarget.trackId }
            : this.selectedHrmAutoMidiTarget
                ? { path: this.selectedHrmAutoMidiTarget.path, slot: this.selectedHrmAutoMidiTarget.slot,
                    effectId: 'hrm_auto_m', trackId: null }
                : null;
        if (JSON.stringify(this.rhythmEngine.getRecoverySnapshot()) !== JSON.stringify(snapshot.rhythm)
            || JSON.stringify(candidatePrivateFx) !== JSON.stringify(snapshot.fx.privateTracks)
            || JSON.stringify(this.getSharedFxRecoverySnapshot('input')) !== JSON.stringify(snapshot.fx.input)
            || JSON.stringify(this.getSharedFxRecoverySnapshot('track')) !== JSON.stringify(snapshot.fx.sharedTrack)
            || JSON.stringify(candidateSourceOverrides) !== JSON.stringify(snapshot.fx.sourceOverrides)
            || this.outputDspAlgorithmValue !== snapshot.fx.outputDsp.algorithm
            || JSON.stringify(this.outputDspParametersValue) !== JSON.stringify(snapshot.fx.outputDsp.parameters)
            || this.outputDspEnabledValue !== snapshot.fx.outputDsp.enabled
            || JSON.stringify(candidateMidiTarget) !== JSON.stringify(snapshot.midi.target)) {
            throw new Error('Recovery engine FX, rhythm, MIDI target, or source-reader settings do not match the prepared snapshot.');
        }
        if (this.rhythmEngine.isRunning || this.monitoringEnabled || this.currentMediaStream || this.currentInputStream
            || this.inputCaptureNode || this.midiInputState !== 'disconnected') {
            throw new Error('Recovery engine must remain stopped, muted, disconnected from input and MIDI, and free of capture nodes.');
        }
        if (this.hasTransportBpmChangeSubscription()) {
            throw new Error('Recovery engine subscribed to shared Transport before adoption; discard this candidate and prepare it with deferred subscription.');
        }
        // The context is suspended, so these zeroes cannot produce an audible
        // transition. Keep it muted until an explicit user-activation resume.
        this.monitorGainNode!.gain.value = 0;
        this.monitorGainNode!.gain.setValueAtTime(0, this.context.currentTime);
        this.masterGainNode.gain.value = 0;
        this.masterGainNode.gain.setValueAtTime(0, this.context.currentTime);
        this.trackMixNode.gain.setValueAtTime(snapshot.trackMixGainValue, this.context.currentTime);
        this.selectedInputDeviceId = snapshot.source.inputDevicePreference;
        this.selectedOutputDeviceId = snapshot.source.outputDevicePreference;
        this.preparedRecoverySnapshot = snapshot;
        this.recoveryAdoptionState = 'prepared';
    }

    public claimRecoveryAdoption(snapshot: BrowserRecoverySnapshot): boolean {
        if (this.recoveryAdoptionState !== 'prepared' || this.preparedRecoverySnapshot !== snapshot) return false;
        this.recoveryAdoptionState = 'claimed';
        return true;
    }

    public releaseRecoveryAdoptionClaim(): void {
        if (this.recoveryAdoptionState === 'claimed') this.recoveryAdoptionState = 'prepared';
    }

    public completeRecoveryAdoption(): boolean {
        if (this.recoveryAdoptionState !== 'claimed') return false;
        this.recoveryAdoptionState = 'adopted';
        return true;
    }

    public getRecoveryAdoptionState(): 'new' | 'prepared' | 'claimed' | 'adopted' {
        return this.recoveryAdoptionState;
    }

    public isRecoveryAwaitingUserResume(): boolean {
        return this.recoveryAdoptionState === 'adopted'
            && !this.recoveredOutputRuntimeReady
            && this.context.state !== 'closed';
    }

    public async init() {
        if (this.isAudioContextClosed()) {
            this.handleClosedAudioContext();
            throw new Error(CLOSED_AUDIO_CONTEXT_ERROR);
        }
        if (this.initialized) {
            await this.resumeFromUserActivation();
            return;
        }

        try {
            await this.resumeFromUserActivation();
            await this.initializeOutputRuntime();

            if (this.selectedInputDeviceId) {
                try {
                    await this.setInputDevice(this.selectedInputDeviceId);
                } catch {
                    // A denied or unavailable microphone must not disable Browser output.
                }
            }

            if (this.selectedOutputDeviceId) {
                await this.setOutputDevice(this.selectedOutputDeviceId);
            }

            this.initialized = true;
            this.lastError = '';
            this.emitLatencyInfo();
            this.emitStatus();
        } catch (error) {
            this.initialized = false;
            this.lastError = this.isAudioContextClosed()
                ? CLOSED_AUDIO_CONTEXT_ERROR
                : error instanceof Error ? error.message : String(error);
            this.emitStatus();
            if (this.isAudioContextClosed()) throw new Error(CLOSED_AUDIO_CONTEXT_ERROR);
            throw error;
        }
    }

    /**
     * Resume and initialize only the recovered output graph. Saved input
     * preference is deliberately not auto-connected; a later explicit UI
     * action requests microphone access.
     */
    public async initializeRecoveredOutputFromUserActivation(): Promise<void> {
        if (!this.isRecoveryAwaitingUserResume()) {
            throw new Error('Recovered Browser output is not waiting for its explicit user-activation resume.');
        }
        try {
            // Resume synchronously from this trusted click before any
            // worklet-module awaits can consume the browser activation. If a
            // previous attempt resumed successfully but module setup failed,
            // retry only the output setup; never fall through to init(), which
            // may reconnect the saved microphone preference.
            if (this.context.state !== 'running') await this.resumeFromUserActivation();
            await this.initializeOutputRuntime();
            if (this.selectedOutputDeviceId) {
                if (!('setSinkId' in this.context)) {
                    this.lastError = 'Recovered audio is using the browser default output because this browser cannot restore the saved output device.';
                } else {
                    try {
                        await this.setOutputDevice(this.selectedOutputDeviceId);
                    } catch (error) {
                        // A stale output-device ID must not strand the recovered
                        // project muted. Keep the setting visible as a warning,
                        // use the browser's current sink, and let the user pick
                        // another device from Audio Settings.
                        this.lastError = `Recovered audio is using the browser default output; the saved output device could not be selected: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
            }
            this.initialized = true;
            this.recoveredOutputRuntimeReady = true;
            this.emitLatencyInfo();
            this.emitStatus();
        } catch (error) {
            this.initialized = false;
            this.lastError = this.isAudioContextClosed()
                ? CLOSED_AUDIO_CONTEXT_ERROR
                : error instanceof Error ? error.message : String(error);
            this.emitStatus();
            throw error;
        }
    }

    private async initializeOutputRuntime(): Promise<void> {
        await this.loadAudioWorkletModule('/worklets/looper-processor.js');
        try {
            await this.loadAudioWorkletModule('/worklets/browser-input-capture.js');
            this.inputCaptureUnavailableReason = '';
        } catch (error) {
            // Keep the established per-track recorder available if this
            // optional shared-tap worklet cannot load; TrackAudio reports
            // that it is using the higher-latency path.
            this.inputCaptureUnavailableReason = error instanceof Error ? error.message : String(error);
        }
        await this.ensureTrackIoWorkletModule();
        await this.loadAudioWorkletModule('/worklets/browser-block-meter.js');

        if (this.workletNode) return;
        const meterNode = new AudioWorkletNode(this.context, 'rc505-browser-block-meter', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
        });
        meterNode.port.onmessage = (event: MessageEvent) => {
            const message = event.data as { type?: string; frames?: number } | null;
            if (message?.type === 'render-quantum-shape' && Number.isInteger(message.frames)
                && (message.frames ?? 0) > 0 && message.frames !== this.selectedBufferFrames) {
                this.selectedBufferFrames = message.frames as number;
                this.emitLatencyInfo();
            }
        };
        try {
            this.masterGainNode.disconnect();
            this.masterGainNode.connect(meterNode);
            meterNode.connect(this.context.destination);
            this.workletNode = meterNode;
        } catch (error) {
            meterNode.port.onmessage = null;
            meterNode.disconnect();
            this.masterGainNode.disconnect();
            this.masterGainNode.connect(this.context.destination);
            throw error;
        }
    }

    /** Resume the Browser output graph from an explicit user gesture. */
    public async resumeFromUserActivation(): Promise<void> {
        if (this.isAudioContextClosed()) {
            this.handleClosedAudioContext();
            throw new Error(CLOSED_AUDIO_CONTEXT_ERROR);
        }
        if (this.context.state === 'running') return;
        try {
            await resumeAudioContextWithTimeout(this.context);
            if (this.isAudioContextClosed()) throw new Error(CLOSED_AUDIO_CONTEXT_ERROR);
            this.emitStatus();
        } catch (error) {
            this.lastError = this.isAudioContextClosed()
                ? CLOSED_AUDIO_CONTEXT_ERROR
                : error instanceof Error ? error.message : String(error);
            this.emitStatus();
            if (this.isAudioContextClosed()) throw new Error(CLOSED_AUDIO_CONTEXT_ERROR);
            throw error;
        }
    }

    /** Load Browser overdub/loopback worklets without introducing a main-thread fallback. */
    public async ensureTrackIoWorkletModule(): Promise<void> {
        if (!this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
            throw new Error('AudioWorklet is unavailable in this browser context');
        }
        await this.loadAudioWorkletModule('/worklets/browser-track-io.js');
    }

    /**
     * Put one selected clean-room DSP stage on the real Browser master-output
     * path. The stage is per-engine and replaces the previous DSP selection;
     * existing input/track FX graphs remain intact. The call returns false for
     * contexts that cannot provide AudioWorklet rather than silently using a
     * main-thread fallback.
     */
    public async setOutputDspFx(
        algorithm: BrowserFxAlgorithm,
        parameters: BrowserFxParameters = {},
        enabled = true,
    ): Promise<boolean> {
        if (!this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;

        const generation = ++this.fxWorkletGeneration;
        await this.ensureFxWorkletModule();
        if (generation !== this.fxWorkletGeneration) return false;

        const node = new AudioWorkletNode(this.context, 'rc505-fx-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: 'explicit',
            processorOptions: {
                algorithm,
                sampleRate: this.context.sampleRate,
                parameters,
                bypassed: !enabled,
            },
        });

        // Keep the old route intact until the actual processor confirms it has
        // accepted the requested configuration. The temporary sink is muted;
        // this also lets recovery validate output DSP while its context stays
        // suspended, without publishing an unready stage to the master path.
        let readinessSink: GainNode | null = null;
        try {
            readinessSink = this.context.createGain();
            readinessSink.gain.value = 0;
            readinessSink.connect(this.context.destination);
            node.connect(readinessSink);
            await this.waitForOutputDspReady(node, algorithm, parameters);
        } catch (error) {
            try { node.disconnect(); } catch { /* unpublished node */ }
            try { readinessSink?.disconnect(); } catch { /* unpublished sink */ }
            throw error;
        }

        // If another request won while the module/processor was becoming
        // ready, discard this node before it can alter the live signal route.
        if (generation !== this.fxWorkletGeneration) {
            try { if (readinessSink) node.disconnect(readinessSink); } catch { /* unpublished node */ }
            try { node.disconnect(); } catch { /* unpublished node */ }
            try { readinessSink?.disconnect(); } catch { /* unpublished sink */ }
            return false;
        }

        const output = this.outputFxChain.output;
        const previous = this.outputDspFxNode;
        try { if (readinessSink) node.disconnect(readinessSink); } catch { /* already detached */ }
        try { readinessSink?.disconnect(); } catch { /* already detached */ }
        if (previous) {
            output.disconnect(previous);
            previous.disconnect();
        } else {
            // The constructor's direct connection is retained until a DSP node
            // is requested, so ordinary Browser audio is unchanged by default.
            output.disconnect(this.masterGainNode);
        }

        output.connect(node);
        node.connect(this.masterGainNode);
        this.outputDspFxNode = node;
        this.outputDspAlgorithmValue = algorithm;
        this.outputDspParametersValue = { ...parameters };
        this.outputDspEnabledValue = enabled;
        node.onprocessorerror = () => {
            if (this.outputDspFxNode !== node) return;
            this.lastError = `Browser output DSP ${algorithm} processor failed after installation.`;
            this.emitStatus();
        };
        return true;
    }

    private waitForOutputDspReady(
        node: AudioWorkletNode,
        algorithm: BrowserFxAlgorithm,
        parameters: BrowserFxParameters,
    ): Promise<void> {
        const timeoutMs = 12_000;
        return new Promise<void>((resolve, reject) => {
            const previousMessage = node.port.onmessage;
            const previousProcessorError = node.onprocessorerror;
            let settled = false;
            let timeout: ReturnType<typeof setTimeout>;
            const cleanup = () => {
                clearTimeout(timeout);
                node.port.onmessage = previousMessage;
                node.onprocessorerror = previousProcessorError;
            };
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error);
                else resolve();
            };
            timeout = setTimeout(() => finish(new Error(`Browser output DSP ${algorithm} did not acknowledge configuration within ${timeoutMs} ms.`)), timeoutMs);
            node.port.onmessage = (event: MessageEvent<unknown>) => {
                const message = event.data as { type?: unknown; message?: unknown; parameterKeys?: unknown } | null;
                if (message?.type === 'error') {
                    finish(new Error(typeof message.message === 'string' ? message.message : `Browser output DSP ${algorithm} rejected its configuration.`));
                    return;
                }
                if (message?.type !== 'configure-ack') return;
                const expectedKeys = Object.keys(parameters).sort();
                const receivedKeys = Array.isArray(message.parameterKeys)
                    ? message.parameterKeys.filter((key): key is string => typeof key === 'string').sort()
                    : [];
                if (receivedKeys.length !== expectedKeys.length
                    || receivedKeys.some((key, index) => key !== expectedKeys[index])) {
                    finish(new Error(`Browser output DSP ${algorithm} acknowledged a different parameter set.`));
                    return;
                }
                finish();
            };
            node.onprocessorerror = () => finish(new Error(`Browser output DSP ${algorithm} processor failed before readiness.`));
            try { node.port.postMessage({ type: 'configure', parameters }); }
            catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        });
    }

    /** Bypass/activate the current output DSP with a short click-free ramp. */
    public setOutputDspFxEnabled(enabled: boolean, rampFrames = this.selectedBufferFrames || 128): void {
        if (this.outputDspFxNode) this.outputDspEnabledValue = enabled;
        this.outputDspFxNode?.port.postMessage({
            type: 'set-bypass',
            value: !enabled,
            rampFrames: Math.max(0, Math.floor(rampFrames)),
        });
    }

    /** Smoothly update parameters on the currently selected output algorithm. */
    public configureOutputDspFx(parameters: BrowserFxParameters): void {
        if (!this.outputDspFxNode) return;
        this.outputDspParametersValue = { ...this.outputDspParametersValue, ...parameters };
        this.outputDspFxNode?.port.postMessage({ type: 'configure', parameters });
    }

    // ========================================
    // DEVICE ENUMERATION
    // ========================================

    /**
     * Get list of available audio input and output devices
     */
    public async getDevices(): Promise<{ inputs: MediaDeviceInfo[], outputs: MediaDeviceInfo[] }> {
        let permissionStream: MediaStream | null = null;
        try {
            // Request permissions first
            permissionStream = await getUserMediaWithTimeout(navigator.mediaDevices, { audio: true });

            const devices = await navigator.mediaDevices.enumerateDevices();

            const inputs = devices.filter(d => d.kind === 'audioinput');
            const outputs = devices.filter(d => d.kind === 'audiooutput');

            console.log(`Found ${inputs.length} input devices, ${outputs.length} output devices`);

            return { inputs, outputs };
        } catch (error) {
            console.error('Failed to enumerate devices:', error);
            return { inputs: [], outputs: [] };
        } finally {
            permissionStream?.getTracks().forEach(track => track.stop());
        }
    }

    // ========================================
    // INPUT DEVICE MANAGEMENT
    // ========================================

    /**
     * Set input device (microphone)
     * SAFETY: Automatically disconnects old stream to prevent feedback
     */
    public async setInputDevice(deviceId: string) {
        if (this.isAudioContextClosed()) {
            this.handleClosedAudioContext();
            throw new Error(CLOSED_AUDIO_CONTEXT_ERROR);
        }
        const requestGeneration = ++this.inputDeviceRequestGeneration;
        console.log(`\n?? Switching input device to: ${deviceId}`);
        this.inputState = 'requesting';
        this.inputError = '';
        this.emitStatus();

        try {
            const stream = await this.requestInputStream(deviceId);
            if (!this.isCurrentInputDeviceRequest(requestGeneration)) {
                this.stopInputMediaStream(stream);
                return;
            }
            const replaced = await this.replaceInputStream(stream, requestGeneration, deviceId || null);
            if (!replaced || !this.isCurrentInputDeviceRequest(requestGeneration)) return;
            this.inputState = 'ready';
            this.inputError = '';

            console.log('  ? New input device connected');
            console.log(`  ??  Monitoring: ${this.monitoringEnabled ? 'ENABLED' : 'DISABLED (SAFE)'}\n`);

        } catch (error) {
            if (!this.isCurrentInputDeviceRequest(requestGeneration)) return;
            if (deviceId && this.shouldFallbackToDefaultInput(error)) {
                console.warn('  Requested input device is unavailable or overconstrained. Falling back to the default microphone.');
                try {
                    const fallbackStream = await this.requestInputStream('');
                    if (!this.isCurrentInputDeviceRequest(requestGeneration)) {
                        this.stopInputMediaStream(fallbackStream);
                        return;
                    }
                    const replaced = await this.replaceInputStream(fallbackStream, requestGeneration, null);
                    if (!replaced || !this.isCurrentInputDeviceRequest(requestGeneration)) return;
                    this.inputState = 'ready';
                    this.inputError = '';
                    this.monitoringListeners.forEach(listener => listener(this.monitoringEnabled));
                    this.emitLatencyInfo();
                    this.emitStatus();
                    console.log('  ? Default input device connected');
                    return;
                } catch (fallbackError) {
                    if (!this.isCurrentInputDeviceRequest(requestGeneration)) return;
                    this.inputState = this.hasLiveInputStream() ? 'ready' : 'error';
                    this.inputError = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                    this.emitStatus();
                    console.error('Failed to set default input device after fallback:', fallbackError);
                    throw fallbackError;
                }
            }
            if (!this.isCurrentInputDeviceRequest(requestGeneration)) return;
            this.inputState = this.hasLiveInputStream() ? 'ready' : 'error';
            this.inputError = error instanceof Error ? error.message : String(error);
            this.emitStatus();
            console.error('Failed to set input device:', error);
            throw error;
        }

        if (!this.isCurrentInputDeviceRequest(requestGeneration)) return;
        this.monitoringListeners.forEach(listener => listener(this.monitoringEnabled));
        this.emitLatencyInfo();
        this.emitStatus();
    }

    // ========================================
    // OUTPUT DEVICE MANAGEMENT
    // ========================================

    /**
     * Set output device (speakers/headphones)
     */
    public async setOutputDevice(deviceId: string) {
        console.log(`\n?? Switching output device to: ${deviceId}`);

        try {
            // Use setSinkId if available (Chrome/Edge)
            if ('setSinkId' in this.context) {
                await (this.context as any).setSinkId(deviceId);
                this.selectedOutputDeviceId = deviceId;
                this.saveDevicePreferences();
                console.log('  ? Output device changed\n');
            } else {
                console.warn('  ??  setSinkId not supported in this browser\n');
            }
        } catch (error) {
            console.error('Failed to set output device:', error);
            throw error;
        }

        this.emitLatencyInfo();
    }

    // ========================================
    // FX CONTROL INTERFACE
    // ========================================

    // ========================================
    // DYNAMIC FX ROUTING (Phase 5b)
    // ========================================

    // FX Instances for Input and Track (4 slots each: A, B, C, D)
    private inputFxInstances: (FXBase | null)[] = [null, null, null, null];
    private trackFxInstances: (FXBase | null)[] = [null, null, null, null];
    private officialFxParameterOverrides = new WeakMap<FXBase, Record<string, number>>();
    private inputFxTypes: (string | null)[] = [null, null, null, null];
    private trackFxTypes: (string | null)[] = [null, null, null, null];
    private inputFxActive: boolean[] = [false, false, false, false];
    /** Track-bank transport FX use TrackAudio readers; their shared postmix worklets stay bypassed. */
    private trackFxActive: boolean[] = [false, false, false, false];

    /** Targeted methods never dispatch to the compatible legacy shared postmix bank. */
    public setTrackFxType(trackId: number, slotIndex: number, type: string): boolean {
        const bank = this.getPerTrackFxChain(trackId);
        if (!bank) return false;
        const selected = this.selectedTrackMidiTarget;
        if (selected?.trackId === trackId && selected.slotIndex === slotIndex) {
            const currentType = bank.getStatus(trackId).slots[slotIndex]?.type ?? '';
            if (currentType.toUpperCase() !== type.trim().toUpperCase()) this.disconnectMidiInput();
        }
        return bank.setType(slotIndex, type);
    }

    public setTrackFxParameter(trackId: number, slotIndex: number, value: number): boolean {
        return this.getPerTrackFxChain(trackId)?.setParameter(slotIndex, value) ?? false;
    }

    public setTrackFxNamedParameters(trackId: number, slotIndex: number, parameters: Record<string, number>): boolean {
        return this.getPerTrackFxChain(trackId)?.setNamedParameters(slotIndex, parameters) ?? false;
    }

    public setTrackFxActive(trackId: number, slotIndex: number, active: boolean): boolean {
        if (active === false && this.selectedTrackMidiTarget?.trackId === trackId
            && this.selectedTrackMidiTarget.slotIndex === slotIndex) this.disconnectMidiInput();
        return this.getPerTrackFxChain(trackId)?.setActive(slotIndex, active) ?? false;
    }

    public getTrackFxStatus(trackId?: number): BrowserTrackFxStatus[] {
        if (trackId !== undefined) {
            const bank = this.getPerTrackFxChain(trackId);
            return bank ? [bank.getStatus(trackId)] : [];
        }
        return (this.perTrackFxChains ?? []).map((bank, index) => bank.getStatus(index + 1));
    }

    private getSharedFxRecoverySnapshot(location: 'input' | 'track'): readonly BrowserRecoveryFxSlot[] {
        const instances = location === 'input' ? this.inputFxInstances : this.trackFxInstances;
        const types = location === 'input' ? this.inputFxTypes : this.trackFxTypes;
        const active = location === 'input' ? this.inputFxActive : this.trackFxActive;
        return Object.freeze(instances.map((effect, index) => {
            const parameters = effect?.getParameterSnapshot?.();
            const effectState = effect as (FXBase & { processorReady?: boolean; error?: string }) | null;
            const error = effectState?.error || null;
            return Object.freeze({
                slot: ['A', 'B', 'C', 'D'][index] as BrowserRecoveryFxSlot['slot'],
                type: types[index] ?? null,
                requestedType: null,
                active: Boolean(active[index]),
                requestedActive: null,
                state: !effect ? 'empty' as const : error ? 'error' as const
                    : effectState?.processorReady === false ? 'loading' as const : 'ready' as const,
                amount: null,
                parameters: copyRecoveryFxParameters(parameters),
                parametersCaptured: Boolean(parameters),
                error,
            });
        }));
    }

    /**
     * Captures the complete reconstructable Browser configuration without stopping audio, copying
     * PCM, or changing ownership. It is a preparation contract only; it cannot transfer DSP history
     * or authorize a microphone reconnect.
     */
    public getRecoverySnapshot(): BrowserRecoverySnapshot {
        if (this.context.state !== 'closed') {
            throw new Error('Browser recovery snapshots are available only after the old AudioContext has closed.');
        }
        if (this.tracks.length !== 5 || this.perTrackFxChains.length !== 5) {
            throw new Error('Browser recovery snapshot requires the complete five-track A–D graph.');
        }
        const transport = Transport.getInstance();
        const transportRevision = transport.projectMutationRevision;
        if (transportRevision >= Number.MAX_SAFE_INTEGER) {
            throw new Error('Browser recovery snapshot is unavailable because the transport revision is exhausted.');
        }
        if (this.tracks.some((track) => track.historyBusy)) {
            throw new Error('Finish recording, overdubbing, clearing, or history work on every track before capturing Browser recovery.');
        }
        const historyBudget = Object.freeze({
            retainedBytes: this.tracks[0]!.historyTotalRetainedBytes,
            limitBytes: this.tracks[0]!.historyBudgetBytes,
        });
        const outputGainValue = this.masterGainNode.gain.value;
        const trackMixGainValue = this.trackMixNode.gain.value;
        if (!Number.isFinite(this.context.sampleRate) || this.context.sampleRate <= 0
            || !Number.isFinite(outputGainValue) || !Number.isFinite(trackMixGainValue)) {
            throw new Error('Browser recovery snapshot was not captured because the audio graph contains invalid rate or gain values.');
        }
        if (this.tracks.some((track) => track.historyTotalRetainedBytes !== historyBudget.retainedBytes
            || track.historyBudgetBytes !== historyBudget.limitBytes)) {
            throw new Error('Browser recovery snapshot was not captured because the five tracks do not share one consistent PCM history budget.');
        }
        const tracks = Object.freeze(this.tracks.map((track) => track.getRecoverySnapshot()));
        const trackFx = Object.freeze(this.perTrackFxChains.map((bank) => bank.getRecoverySnapshot()));
        const transportSnapshot = Object.freeze({
            bpm: transport.bpm,
            timeSignature: Object.freeze([...transport.timeSignature] as [number, number]),
            state: transport.state,
            masterTrackId: transport.masterTrackId,
            masterLoopLengthSamples: transport.masterLoopLengthSamples,
            measureLength: transport.measureLength,
            projectMutationRevision: transportRevision,
        });
        const rhythm = this.rhythmEngine.getRecoverySnapshot();
        const sourceOverrides = Object.freeze(Array.from(this.trackLoopTransportOverrides.entries())
            .map(([trackId, config]) => Object.freeze({ trackId, config: Object.freeze({ ...config }) })));
        const selectedTarget = this.selectedTrackMidiTarget
            ? Object.freeze({
                path: 'track', slot: ['A', 'B', 'C', 'D'][this.selectedTrackMidiTarget.slotIndex] ?? 'A',
                effectId: this.selectedTrackMidiTarget.effectId, trackId: this.selectedTrackMidiTarget.trackId,
            })
            : this.selectedHrmAutoMidiTarget
                ? Object.freeze({ path: this.selectedHrmAutoMidiTarget.path, slot: this.selectedHrmAutoMidiTarget.slot, effectId: 'hrm_auto_m', trackId: null })
                : null;
        const snapshot: BrowserRecoverySnapshot = Object.freeze({
            schemaVersion: 2,
            source: Object.freeze({
                contextState: this.context.state,
                sampleRate: this.context.sampleRate,
                inputDevicePreference: this.selectedInputDeviceId,
                outputDevicePreference: this.selectedOutputDeviceId,
                lastObservedRenderBlockFrames: this.selectedBufferFrames,
            }),
            transport: transportSnapshot,
            rhythm,
            tracks,
            pcmHistoryBudget: Object.freeze({
                retainedBytes: historyBudget.retainedBytes,
                limitBytes: historyBudget.limitBytes,
            }),
            fx: Object.freeze({
                input: this.getSharedFxRecoverySnapshot('input'),
                sharedTrack: this.getSharedFxRecoverySnapshot('track'),
                privateTracks: Object.freeze(trackFx),
                sourceOverrides,
                outputDsp: Object.freeze({
                    algorithm: this.outputDspAlgorithmValue,
                    parameters: copyRecoveryFxParameters(this.outputDspParametersValue),
                    enabled: this.outputDspEnabledValue,
                }),
            }),
            midi: Object.freeze({ sourceInputState: this.midiInputState, target: selectedTarget }),
            monitoringWasEnabled: this.monitoringEnabled,
            outputGainValue,
            trackMixGainValue,
            recoveryPolicy: Object.freeze({
                playback: 'start-stopped',
                monitoring: 'start-muted',
                input: 'explicit-user-reconnect',
                midi: 'target-restored-disconnected',
                dynamicDspState: 'not-captured',
                effectTails: 'discarded',
            }),
        });
        if (transport.projectMutationRevision !== transportRevision
            || this.tracks.some((track, index) => track.historyBusy
                || track.projectRevision !== tracks[index]!.projectPcmRevision
                || track.state !== tracks[index]!.state)) {
            throw new Error('Browser recovery snapshot was canceled because audio or project transport changed during capture.');
        }
        return snapshot;
    }

    private getPerTrackFxChain(trackId: number): BrowserTrackFxChain | undefined {
        if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) return undefined;
        return this.perTrackFxChains?.[trackId - 1];
    }
    /** Only the explicitly connected HRM AUTO slot receives melodic MIDI events. */
    private selectedHrmAutoMidiTarget: {
        path: BrowserMidiInputTarget['path'];
        slot: BrowserMidiInputTarget['slot'];
        effect: BrowserHrmAutoFX;
    } | null = null;
    private selectedTrackMidiTarget: { trackId: number; slotIndex: number; effectId: 'osc_voc_m' | 'hrm_auto_m' } | null = null;
    private midiRoutingMode: 'none' | 'legacy-broadcast' | 'hrm-auto' | 'private-track-osc-voc' | 'private-track-hrm-auto' = 'legacy-broadcast';

    /**
     * Set FX Type for a specific slot
     * @param location 'input' or 'track'
     * @param slotIndex 0-3 (A-D)
     * @param type 'FILTER' | 'DELAY' | 'REVERB' | 'SLICER'
     */
    public setFxType(location: 'input' | 'track', slotIndex: number, type: string) {
        if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 3 || typeof type !== 'string') return;
        this.trackFxActive ??= [false, false, false, false];

        // Reject stale/manual calls too: Browser Track-only beat FX never enter Input.
        const normalizedType = type.trim().toUpperCase();
        if (location === 'input' && (normalizedType === 'BEAT REPEAT' || normalizedType === 'BEAT SCATTER'
            || normalizedType === 'BEAT SHIFT' || normalizedType === 'VINYL FLICK')) {
            console.warn(`${normalizedType} is available only in the Browser Track FX bank.`);
            return;
        }

        const fxTypes = location === 'input' ? this.inputFxTypes : this.trackFxTypes;
        const fxInstances = location === 'input' ? this.inputFxInstances : this.trackFxInstances;

        // The FX panel uses an empty choice (or NONE) to remove a slot. Tear
        // down a source-aware reader first so its transport can return cleanly
        // to the ordinary TrackAudio source route.
        if (normalizedType === '' || normalizedType === 'NONE') {
            const previousFx = fxInstances[slotIndex];
            if (previousFx instanceof BrowserHrmAutoFX && previousFx === this.selectedHrmAutoMidiTarget?.effect) {
                this.disconnectMidiInput();
            }
            if (previousFx instanceof BrowserWorkletFX && previousFx.algorithm === 'osc-voc') previousFx.clearMidiNotes(this.nextMidiFrame());
            previousFx?.dispose();
            fxInstances[slotIndex] = null;
            fxTypes[slotIndex] = null;
            if (location === 'track') {
                this.trackFxActive[slotIndex] = false;
                this.syncAllTrackLoopTransportFx();
                this.rebuildOutputChain();
            } else {
                this.inputFxActive[slotIndex] = false;
                this.rebuildInputChain();
            }
            return;
        }

        if (fxTypes[slotIndex] === type) {
            return;
        }

        const newFx = this.createFxInstance(type);
        if (!newFx) {
            console.warn(`Unknown FX type: ${type}`);
            return;
        }

        const previousFx = (location === 'input' ? this.inputFxInstances : this.trackFxInstances)[slotIndex];
        if (previousFx instanceof BrowserHrmAutoFX && previousFx === this.selectedHrmAutoMidiTarget?.effect) {
            this.disconnectMidiInput();
        }
        if (previousFx instanceof BrowserWorkletFX && previousFx.algorithm === 'osc-voc') previousFx.clearMidiNotes(this.nextMidiFrame());

        // Update Chain
        if (location === 'input') {
            this.inputFxInstances[slotIndex]?.dispose();
            this.inputFxInstances[slotIndex] = newFx;
            this.inputFxTypes[slotIndex] = type;
            this.inputFxActive[slotIndex] = false;
            this.rebuildInputChain();

        } else {
            this.trackFxInstances[slotIndex]?.dispose();
            this.trackFxInstances[slotIndex] = newFx;
            this.trackFxTypes[slotIndex] = type;
            this.trackFxActive[slotIndex] = false;
            if (this.isLoopTransportFxName(normalizedType)) {
                // Source-aware transport must never also process the shared
                // TrackMix postmix stream.
                newFx.setBypass(true);
            }
            this.syncAllTrackLoopTransportFx();
            this.rebuildOutputChain();
        }

        console.log(`FX Set: ${location.toUpperCase()} [${['A', 'B', 'C', 'D'][slotIndex]}] -> ${type}`);
    }

    /** Query source-aware Track transport support and conflicts for every loop. */
    public getTrackTransportStatus(): BrowserTrackTransportStatus[] {
        const configuredEffects = [0, 1, 2, 3].flatMap((slotIndex) => {
            const type = this.trackFxTypes[slotIndex]?.trim().toUpperCase() ?? '';
            const fx = this.trackFxInstances[slotIndex];
            if (!this.trackFxActive?.[slotIndex] || !(fx instanceof BrowserWorkletFX)
                || !this.isLoopTransportFxName(type) || this.getTrackTransportPlacementReason(slotIndex)) return [];
            return [{ slot: ['A', 'B', 'C', 'D'][slotIndex] as 'A' | 'B' | 'C' | 'D', type }];
        });
        const unsupportedEffects = [0, 1, 2, 3].flatMap((slotIndex) => {
            const type = this.trackFxTypes[slotIndex]?.trim().toUpperCase() ?? '';
            const fx = this.trackFxInstances[slotIndex];
            const reason = this.getTrackTransportPlacementReason(slotIndex);
            if (!this.trackFxActive?.[slotIndex] || !(fx instanceof BrowserWorkletFX)
                || !this.isLoopTransportFxName(type) || !reason) return [];
            return [{ slot: ['A', 'B', 'C', 'D'][slotIndex] as 'A' | 'B' | 'C' | 'D', type, reason }];
        });
        return (this.tracks ?? []).map((track, trackIndex) => {
            const trackId = track.track.id;
            const override = this.trackLoopTransportOverrides?.get(trackId);
            const configured = override
                ? (override.mode === 'beatShift'
                    ? [{ slot: 'A' as const, type: 'BEAT SHIFT' as const }]
                    : override.mode === 'vinylFlick' ? [{ slot: 'A' as const, type: 'VINYL FLICK' as const }] : [])
                : configuredEffects.map((effect) => ({ ...effect }));
            return {
                trackIndex,
                trackId,
                routeMode: 'experimental-source-pre-track-mix-shared-postmix' as const,
                perTrackFxChainAvailable: Boolean(this.perTrackFxChains?.[trackIndex]),
                active: track.loopTransportActive,
                configuredEffects: configured,
                unsupportedEffects: override ? [] : unsupportedEffects.map((effect) => ({ ...effect })),
                unavailableReason: track.loopTransportUnavailableReason ?? (configured.length > 0 && track.state === TrackState.OVERDUBBING
                    ? 'Source-aware loop transport is unavailable during overdub; canonical write alignment is retained' : null),
            };
        });
    }

    private isLoopTransportFxName(type: string | null): type is BrowserLoopTransportFxName {
        const normalized = type?.trim().toUpperCase();
        return normalized === 'BEAT SHIFT' || normalized === 'VINYL FLICK';
    }

    /** Source readers run before TrackMix, so no active earlier A–D stage may be skipped. */
    private getTrackTransportPlacementReason(slotIndex: number): string | null {
        for (let previousIndex = 0; previousIndex < slotIndex; previousIndex += 1) {
            if (!this.trackFxActive?.[previousIndex] || !this.trackFxTypes[previousIndex]) continue;
            const currentSlot = ['A', 'B', 'C', 'D'][slotIndex];
            const previousSlot = ['A', 'B', 'C', 'D'][previousIndex];
            return `Track FX ${currentSlot} source-aware transport is unsupported because active slot ${previousSlot} must run before it`;
        }
        return null;
    }

    /** Keep each TrackAudio's source-aware A–D snapshot aligned with its Track-bank slot. */
    private syncTrackLoopTransportFx(slotIndex: number): void {
        const type = this.trackFxTypes[slotIndex]?.trim().toUpperCase() ?? '';
        const fx = this.trackFxInstances[slotIndex];
        const enabled = Boolean(this.trackFxActive?.[slotIndex]
            && fx instanceof BrowserWorkletFX
            && this.isLoopTransportFxName(type)
            && !this.getTrackTransportPlacementReason(slotIndex));
        const canonicalType: BrowserLoopTransportFxName | null = enabled && this.isLoopTransportFxName(type) ? type : null;
        let parameters: Record<string, number> = {};
        if (enabled && fx instanceof BrowserWorkletFX) {
            parameters = Object.fromEntries(
                Object.entries(fx.getParameterSnapshot()).filter((entry): entry is [string, number] =>
                    typeof entry[1] === 'number' && Number.isFinite(entry[1])
                    && !(canonicalType === 'BEAT SHIFT' && entry[0] === 'bpm')),
            );
        }
        if (enabled && fx instanceof BrowserWorkletFX) parameters = { ...translateBrowserOfficialSourceParameters(fx.algorithm, parameters) };
        for (const track of this.tracks ?? []) {
            // Once a user has selected the dedicated per-loop source stage,
            // legacy shared-bank synchronization must not overwrite it.
            if (this.trackLoopTransportOverrides?.has(track.track.id)) continue;
            track.configureLoopTransportFx(slotIndex, canonicalType, parameters);
        }
    }

    /**
     * Configure a separate source-readhead stage for one stored loop. This is
     * before that track's A–D inserts and is not an ordered A–D effect slot.
     * Browser and Native use one source-stage VINYL contract: speed selects
     * motor target independently, while mix linearly blends canonical and
     * transported loop playback. This does not make the source stage an A–D
     * insert or imply sound-quality acceptance.
     */
    public setLoopTransport(trackId: number, config: NativeLoopTransportConfig): boolean {
        if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5 || !isNativeLoopTransportConfig(config)) return false;
        const track = this.tracks?.[trackId - 1];
        if (!track) return false;
        this.trackLoopTransportOverrides ??= new Map<number, NativeLoopTransportConfig>();
        if (track.state === TrackState.OVERDUBBING) {
            this.lastError = 'Browser source transport cannot change during overdub; canonical loop-frame writes are in progress.';
            this.emitStatus();
            return false;
        }

        const previous = this.trackLoopTransportOverrides.get(trackId);
        this.trackLoopTransportOverrides.set(trackId, { ...config });
        let accepted = true;
        if (config.mode === 'beatShift') {
            accepted = track.configureLoopTransportFx(0, 'BEAT SHIFT', {
                    offset: config.beatOffsetBeats,
                    crossfade: config.crossfadeMs,
                });
        } else if (config.mode === 'vinylFlick') {
            accepted = track.configureLoopTransportFx(0, 'VINYL FLICK', {
                    speed: config.vinylSpeedPercent,
                    mixPercent: config.vinylMixPercent,
                    'return-time': config.motorReturnSeconds,
                    brake: config.brakePercent,
                });
        }
        if (!accepted) {
            if (previous) this.trackLoopTransportOverrides.set(trackId, previous);
            else this.trackLoopTransportOverrides.delete(trackId);
            this.lastError = 'Browser rejected the source-stage change; the previous per-loop route is retained.';
            this.emitStatus();
            return false;
        }
        for (let slotIndex = 1; slotIndex < 4; slotIndex += 1) track.configureLoopTransportFx(slotIndex, null);
        if (config.mode === 'off') track.configureLoopTransportFx(0, null);
        this.lastError = '';
        this.emitStatus();
        return true;
    }

    /** Restore the legacy shared source-reader route for a previously overridden Browser loop. */
    public clearLoopTransportOverride(trackId: number): boolean {
        if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5 || !this.tracks?.[trackId - 1]) return false;
        if (this.tracks[trackId - 1]!.state === TrackState.OVERDUBBING) {
            this.lastError = 'Browser source transport cannot change during overdub; canonical loop-frame writes are in progress.';
            this.emitStatus();
            return false;
        }
        this.trackLoopTransportOverrides?.delete(trackId);
        for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) this.syncTrackLoopTransportFx(slotIndex);
        this.lastError = '';
        this.emitStatus();
        return true;
    }

    private syncAllTrackLoopTransportFx(): void {
        for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) this.syncTrackLoopTransportFx(slotIndex);
    }

    private createFxInstance(type: string): FXBase | null {
        const context = this.context;
        // Selector strings retain their user-facing experimental suffix, but
        // the adapter choice is keyed by the stable clean-room catalog ID.
        const catalogId = fxCatalogIdForDisplayLabel(type);

        if (catalogId === 'auto-riff') {
            if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
                this.lastError = 'AudioWorklet is unavailable; AUTO RIFF remains bypassed.';
                this.emitStatus();
                return null;
            }
            const effect = new BrowserAutoRiffFX(
                context,
                () => this.ensureFxWorkletModule(),
                (error) => {
                    this.lastError = `Browser DSP AUTO RIFF failed: ${error.message}`;
                    this.emitStatus();
                },
            );
            effect.setParam('bpm', Transport.getInstance().bpm);
            effect.setParam('quarterNotesPerMeasure', Transport.getInstance().quarterNotesPerMeasure);
            return effect;
        }
        if (catalogId === 'hrm-auto-m') {
            if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
                this.lastError = 'AudioWorklet is unavailable; HRM AUTO (M) remains bypassed.';
                this.emitStatus();
                return null;
            }
            return new BrowserHrmAutoFX(context, () => this.ensureFxWorkletModule(), (error) => {
                this.lastError = `Browser HRM AUTO (M) failed: ${error.message}`;
                this.emitStatus();
            });
        }
        if (catalogId === 'robot') {
            if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
                this.lastError = 'AudioWorklet is unavailable; ROBOT remains bypassed.';
                this.emitStatus();
                return null;
            }
            return new BrowserRobotFX(context, () => this.ensureFxWorkletModule(), (error) => {
                this.lastError = `Browser ROBOT failed: ${error.message}`;
                this.emitStatus();
            });
        }

        switch (type) {
            case 'DSP LPF':
            case 'DSP BPF':
            case 'DSP HPF':
            case 'FLANGER':
            case 'RING.MOD':
            case 'DELAY':
            case 'MOD DELAY':
            case 'PANNING DELAY':
            case 'CHORUS':
            case 'PHASER':
            case 'TREMOLO':
            case 'AUTO PAN':
            case 'DIST':
            case 'PREAMP':
            case 'SYNTH':
            case 'G2B':
            case 'VOCODER':
            case 'ELECTRIC':
            case 'DYNAMICS':
            case 'SUSTAINER':
            case 'FDN8 REVERB':
            case 'GATE REVERB':
            case 'STEREO ENHANCE':
            case 'BEAT REPEAT':
            case 'BEAT SCATTER':
            case 'ROLL':
            case 'FREEZE':
            case 'BEAT SHIFT':
            case 'REVERSE DELAY':
            case 'REVERSE REVERB':
            case 'REVERSE REVERB (EXPERIMENTAL)':
            case 'WARP':
            case 'WARP (EXPERIMENTAL)':
            case 'PATTERN SLICER':
            case 'STEP SLICER':
            case 'LO-FI':
            case 'EQ':
            case 'MANUAL PAN':
            case 'TAPE ECHO':
            case 'TWIST':
            case 'GRANULAR DELAY':
            case 'RADIO':
            case 'VIBRATO':
            case 'SLOW GEAR':
            case 'ISOLATOR':
            case 'VINYL FLICK':
            case 'OSC VOC (M)':
            case 'OSC BOT': {
                if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
                    this.lastError = `AudioWorklet is unavailable; ${type} remains bypassed.`;
                    this.emitStatus();
                    return null;
                }
                const name = (type === 'REVERSE REVERB (EXPERIMENTAL)' || type === 'WARP (EXPERIMENTAL)' ? type.replace(' (EXPERIMENTAL)', '') : type) as BrowserWorkletFxName;
                return new BrowserWorkletFX(
                    context,
                    name,
                    () => this.ensureFxWorkletModule(),
                    (error) => {
                        this.lastError = `Browser DSP ${name} failed: ${error.message}`;
                        this.emitStatus();
                    },
                    { ...(name === 'BEAT REPEAT' || name === 'BEAT SCATTER' || name === 'ROLL' || name === 'BEAT SHIFT' || name === 'ISOLATOR' || name === 'REVERSE DELAY' || name === 'REVERSE REVERB' || name === 'PATTERN SLICER' || name === 'STEP SLICER' || name === 'OSC BOT' || name === 'WARP' ? { bpm: Transport.getInstance().bpm } : name === 'OSC VOC (M)' ? { oscVocWaveform: 0, oscVocMidiChannel: 1, oscVocOctave: 0, oscVocBands: 16, mix: 0.7 } : name === 'VOCODER' ? { vocoderBands: 16, vocoderCarrier: 1, mix: 0.7 } : name === 'ELECTRIC' ? { electricCharacter: 0, electricPitchSnapPercent: 50, electricToneHz: 5000, mix: 0.7 } : {}), ...(BROWSER_OFFICIAL_STREAM_KEYS[BROWSER_WORKLET_FX_TYPES[name]] ? { bpm: Transport.getInstance().bpm, ...(Transport.getInstance().quarterNotesPerMeasure !== 4 ? { quarterNotesPerMeasure: Transport.getInstance().quarterNotesPerMeasure } : {}) } : {}) },
                    { sourceAwareLoopTransport: name === 'BEAT SHIFT' || name === 'VINYL FLICK', legacyVocoderMixPercent: name === 'VOCODER', getVocoderCarrierSource: (trackId) => this.tracks?.[trackId - 1]?.playbackSourceOutput ?? null },
                );
            }
            case 'TRANSPOSE': {
                if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
                    this.lastError = 'AudioWorklet is unavailable; TRANSPOSE remains bypassed.';
                    this.emitStatus();
                    return null;
                }
                return new BrowserTransposeFX(context, (error) => {
                    this.lastError = error.message;
                    this.emitStatus();
                });
            }
            case 'PITCH BEND': {
                if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
                    this.lastError = 'AudioWorklet is unavailable; PITCH BEND remains bypassed.';
                    this.emitStatus();
                    return null;
                }
                return new BrowserPitchBendFX(context, (error) => {
                    this.lastError = error.message;
                    this.emitStatus();
                });
            }
            case 'HRM MANUAL': {
                if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
                    this.lastError = 'AudioWorklet is unavailable; HRM MANUAL remains bypassed.';
                    this.emitStatus();
                    return null;
                }
                return new BrowserManualHarmonistFX(context, (error) => {
                    this.lastError = error.message;
                    this.emitStatus();
                });
            }
            case 'OCTAVE': {
                if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
                    this.lastError = 'AudioWorklet is unavailable; OCTAVE remains bypassed.';
                    this.emitStatus();
                    return null;
                }
                return new BrowserOctaveFX(context, (error) => {
                    this.lastError = error.message;
                    this.emitStatus();
                });
            }
            case 'FILTER':
                return new FilterFX(context);
            case 'REVERB':
                return new ReverbFX(context);
            case 'SLICER':
                return new SlicerFX(context);
            default:
                return null;
        }
    }

    private ensureFxWorkletModule(): Promise<void> {
        if (!this.context.audioWorklet) {
            return Promise.reject(new Error('AudioWorklet is unavailable in this browser context.'));
        }
        if (!this.fxWorkletModuleReady) {
            this.fxWorkletModuleReady = addAudioWorkletModuleWithTimeout(
                this.context.audioWorklet,
                '/worklets/fx-processor.js',
            );
        }
        return this.fxWorkletModuleReady.catch((error: unknown) => {
            this.fxWorkletModuleReady = null;
            throw error;
        });
    }

    private loadAudioWorkletModule(moduleUrl: string): Promise<void> {
        if (!this.context.audioWorklet) {
            return Promise.reject(new Error('AudioWorklet is unavailable in this browser context.'));
        }
        const promises = this.workletModulePromises ?? (this.workletModulePromises = new Map());
        const existing = promises.get(moduleUrl);
        if (existing) return existing;

        let loading: Promise<void>;
        loading = addAudioWorkletModuleWithTimeout(this.context.audioWorklet, moduleUrl).catch((error: unknown) => {
            if (promises.get(moduleUrl) === loading) promises.delete(moduleUrl);
            throw error;
        });
        promises.set(moduleUrl, loading);
        return loading;
    }

    /** Request Web MIDI permission only after a user-triggered explicit call. */
    public connectMidiInput(target?: BrowserMidiInputTarget): Promise<MidiInputState> {
        if (!target) {
            this.releaseAndClearMidiTarget();
            this.midiRoutingMode = 'legacy-broadcast';
            return this.midiInput.connect();
        }
        if (!this.isValidMidiTarget(target)) {
            this.releaseAndClearMidiTarget();
            this.midiRoutingMode = 'none';
            this.lastError = 'The selected MIDI FX target is invalid.';
            this.emitStatus();
            return Promise.resolve('error');
        }
        if (target.effectId === 'osc_voc_m' && (target.trackId ?? 0) > 0) {
            const bank = target.path === 'track' && target.trackId !== undefined
                ? this.getPerTrackFxChain(target.trackId)
                : undefined;
            const slotIndex = this.slotIndex(target.slot);
            if (!bank || !bank.canReceiveMidiNotes(slotIndex)) {
                this.releaseAndClearMidiTarget();
                this.midiRoutingMode = 'none';
                this.lastError = `Selected Track ${target.trackId} OSC VOC (M) slot ${target.slot} is unavailable or not ready.`;
                this.emitStatus();
                return Promise.resolve('error');
            }
            this.releaseAndClearMidiTarget();
            this.selectedTrackMidiTarget = { trackId: target.trackId!, slotIndex, effectId: 'osc_voc_m' };
            this.midiRoutingMode = 'private-track-osc-voc';
            return this.midiInput.connect();
        }
        if (target.effectId === 'hrm_auto_m' && (target.trackId ?? 0) > 0) {
            const bank = target.path === 'track' && target.trackId !== undefined
                ? this.getPerTrackFxChain(target.trackId)
                : undefined;
            const slotIndex = this.slotIndex(target.slot);
            if (!bank || !bank.canReceiveMidiNotes(slotIndex, 'hrm_auto_m')) {
                this.releaseAndClearMidiTarget();
                this.midiRoutingMode = 'none';
                this.lastError = `Selected Track ${target.trackId} HRM AUTO (M) slot ${target.slot} is unavailable or not ready.`;
                this.emitStatus();
                return Promise.resolve('error');
            }
            this.releaseAndClearMidiTarget();
            this.selectedTrackMidiTarget = { trackId: target.trackId!, slotIndex, effectId: 'hrm_auto_m' };
            this.midiRoutingMode = 'private-track-hrm-auto';
            return this.midiInput.connect();
        }
        if (target.effectId !== 'hrm_auto_m') {
            this.releaseAndClearMidiTarget();
            this.midiRoutingMode = 'legacy-broadcast';
            return this.midiInput.connect();
        }
        const slotIndex = this.slotIndex(target.slot);
        const instances = target.path === 'input' ? this.inputFxInstances : this.trackFxInstances;
        const fx = instances[slotIndex];
        if (!(fx instanceof BrowserHrmAutoFX)) {
            this.releaseAndClearMidiTarget();
            this.midiRoutingMode = 'none';
            this.lastError = `Selected HRM AUTO (M) slot ${target.path.toUpperCase()} ${target.slot} is unavailable.`;
            this.emitStatus();
            return Promise.resolve('error');
        }
        this.releaseAndClearMidiTarget();
        this.selectHrmAutoMidiTarget(target, fx);
        this.midiRoutingMode = 'hrm-auto';
        return this.midiInput.connect();
    }

    public disconnectMidiInput(): void {
        this.midiInput.disconnect();
        this.clearMidiTargetState();
    }

    public getMidiInputState(): MidiInputState {
        return this.midiInputState;
    }

    public onMidiInputStateChange(listener: (state: MidiInputState) => void): () => void {
        this.midiInputListeners.add(listener);
        try { listener(this.midiInputState); }
        catch (error) {
            this.midiInputListeners.delete(listener);
            throw error;
        }
        return () => this.midiInputListeners.delete(listener);
    }

    private handleMidiNote(event: MidiNoteEvent): void {
        const performanceNow = typeof performance !== 'undefined' && Number.isFinite(performance.now())
            ? performance.now()
            : event.timeStampMs;
        const remainingTimestampSeconds = Math.max(0, (event.timeStampMs - performanceNow) / 1000);
        // Web MIDI delivery and MessagePort transfer are asynchronous. Keep a
        // small bounded lead so an on-time device timestamp is not already
        // behind the AudioWorklet's current sample frame when it arrives.
        const targetTime = this.context.currentTime + remainingTimestampSeconds + 0.02;
        const frame = Math.ceil(targetTime * this.context.sampleRate);
        const selectedAuto = this.midiRoutingMode === 'hrm-auto' ? this.selectedHrmAutoMidiTarget?.effect : undefined;
        if (selectedAuto) {
            const accepted = selectedAuto.sendMidiNote({
                ...event,
                velocity: event.velocity,
                frame,
            });
            if (!accepted) {
                this.lastError = selectedAuto.error || 'HRM AUTO (M) rejected a Web MIDI note event.';
                this.emitStatus();
            }
        }
        if ((this.midiRoutingMode === 'private-track-osc-voc' || this.midiRoutingMode === 'private-track-hrm-auto') && this.selectedTrackMidiTarget) {
            const { trackId, slotIndex, effectId } = this.selectedTrackMidiTarget;
            const accepted = this.getPerTrackFxChain(trackId)?.sendMidiNote(slotIndex, {
                channel: event.channel,
                note: event.note,
                velocity: Math.round(event.velocity * 127),
                noteOn: event.noteOn,
                frame,
                timeStampMs: event.timeStampMs,
            });
            if (!accepted) {
                this.lastError = `Track ${trackId} ${effectId === 'hrm_auto_m' ? 'HRM AUTO' : 'OSC VOC'} rejected a Web MIDI note event.`;
                this.emitStatus();
            }
        } else if (this.midiRoutingMode === 'legacy-broadcast' || this.midiRoutingMode === undefined) {
            for (const fx of [...this.inputFxInstances, ...this.trackFxInstances]) {
                if (!(fx instanceof BrowserWorkletFX) || fx.algorithm !== 'osc-voc') continue;
                const accepted = fx.sendMidiNote({
                    channel: event.channel,
                    note: event.note,
                    velocity: Math.round(event.velocity * 127),
                    noteOn: event.noteOn,
                    frame,
                });
                if (!accepted) this.lastError = fx.error || 'OSC VOC rejected a Web MIDI note event.';
            }
        }
    }

    private selectHrmAutoMidiTarget(target: BrowserMidiInputTarget, effect: BrowserHrmAutoFX): void {
        if (this.selectedHrmAutoMidiTarget?.effect === effect) return;
        this.clearHrmAutoMidiTarget();
        this.selectedHrmAutoMidiTarget = { path: target.path, slot: target.slot, effect };
    }

    private clearHrmAutoMidiTarget(): void {
        this.selectedHrmAutoMidiTarget?.effect.clearMidiState();
        this.selectedHrmAutoMidiTarget = null;
    }

    private releaseAndClearMidiTarget(): void {
        if (typeof this.midiInput?.releaseHeldNotes === 'function') this.midiInput.releaseHeldNotes();
        this.clearMidiTargetState();
    }

    private clearMidiTargetState(): void {
        this.clearHrmAutoMidiTarget();
        const target = this.selectedTrackMidiTarget;
        if (target) this.getPerTrackFxChain(target.trackId)?.clearMidiNotes(target.slotIndex, this.nextMidiFrame());
        this.selectedTrackMidiTarget = null;
        this.midiRoutingMode = 'none';
    }

    private nextMidiFrame(): number {
        return Math.ceil((this.context.currentTime * this.context.sampleRate) + (this.context.sampleRate * 0.02));
    }

    private isValidMidiTarget(target: BrowserMidiInputTarget): boolean {
        if ((target.path !== 'input' && target.path !== 'track') || !['A', 'B', 'C', 'D'].includes(target.slot)) return false;
        if (target.effectId !== undefined && target.effectId !== 'osc_voc_m' && target.effectId !== 'hrm_auto_m') return false;
        if (target.trackId === undefined || target.trackId === 0) return true;
        if (!Number.isInteger(target.trackId) || target.trackId < 1 || target.trackId > 5 || target.path !== 'track') return false;
        return target.effectId === 'osc_voc_m' || target.effectId === 'hrm_auto_m';
    }

    private slotIndex(slot: BrowserMidiInputTarget['slot']): number {
        return slot === 'A' ? 0 : slot === 'B' ? 1 : slot === 'C' ? 2 : 3;
    }

    /**
     * Rebuild the entire Input FX Chain
     * Source -> Slot A -> Slot B -> Slot C -> Slot D -> Monitor/Tracks
     */
    private rebuildInputChain() {
        // Disconnect everything first? 
        // It's tricky to disconnect "everything" without tracking connections.
        // Simplified approach: Re-connect the chain flow.

        // 1. Disconnect Input Source
        if (this.currentInputStream) {
            this.currentInputStream.disconnect();
        }

        // 2. Chain nodes

        // If no input, we can't connect, but we prepare the chain.
        // Actually, we need a stable "Input Head" node.
        // Let's use inputFxChain.input as the Head, and inputFxChain.output as the Tail.
        // But wait, I want to replace the internal logic of inputFxChain.

        // Let's use the existing `this.inputFxChain.input` and `this.inputFxChain.output` as anchors.
        // We will disconnect `this.inputFxChain.input` from its internal hardcoded chain 
        // and route it through our dynamic slots.

        const head = this.inputFxChain.input;
        const tail = this.inputFxChain.output;

        // Break existing internal connections of FXChain if possible, 
        // or just ignore FXChain's internal graph and repurpose the input/output nodes?
        // FXChain constructor connects input->compressor->...->output.
        // I should disconnect that.
        head.disconnect();

        let currentNode: AudioNode = head;

        this.inputFxInstances.forEach((fx) => {
            if (fx) {
                currentNode.connect(fx.input);
                currentNode = fx.output;
            }
        });

        currentNode.connect(tail);

        // Re-connect Input Source to Head if needed (it should already be connected to inputFxChain.input)
        if (this.currentInputStream) {
            this.currentInputStream.connect(head);
        }
    }

    /**
     * Rebuild the Output FX Chain: the shared postmix from all loops enters
     * Track FX A–D before the master output. These slots do not target a
     * particular loop track independently.
     */
    private rebuildOutputChain() {
        const head = this.outputFxChain.input;
        const tail = this.outputFxChain.output;

        head.disconnect();

        let currentNode: AudioNode = head;

        this.trackFxInstances.forEach((fx) => {
            if (fx) {
                currentNode.connect(fx.input);
                currentNode = fx.output;
            }
        });

        currentNode.connect(tail);

        // Ensure TrackMix is connected to Head
        this.trackMixNode.disconnect();
        this.trackMixNode.connect(head);
    }

    /**
     * Set FX Parameter
     * @param location 'input' | 'track'
     * @param slotIndex 0-3
     * @param value 0-100
     */
    public setFxParam(location: 'input' | 'track', slotIndex: number, value: number) {
        // SAFETY CHECK: Ensure value is a finite number
        if (typeof value !== 'number' || isNaN(value) || !isFinite(value)) {
            console.error(`FX Error: Invalid param value received for slot ${slotIndex}:`, value);
            return;
        }

        const instances = location === 'input' ? this.inputFxInstances : this.trackFxInstances;
        const fx = instances[slotIndex];
        if (fx) {
            // Map 0-100 to 0-1 or appropriate range
            // Most FX expect 0-1 for "amount" or "mix"
            // Let's assume a generic 'amount' parameter for now, 
            // or map based on FX type if we had access to it.
            // FXBase interface has setParam(key, val).

            // For now, we control the main parameter (e.g. Filter Frequency, Reverb Mix)
            // We need to know WHAT parameter to control.
            // Simplified: "amount" controls the most significant param.

            // We can check the name or just pass 'amount' and let FX handle it?
            // FXBase doesn't have a standardized 'amount'.
            // Let's try to be smart.

            if (fx instanceof FilterFX) {
                fx.setParam('frequency', value); // 0-100 -> mapped inside
            } else if (fx instanceof ReverbFX) {
                fx.setParam('mix', value / 100);
            } else if (fx instanceof DelayFX) {
                fx.setParam('mix', value / 100);
            } else if (fx instanceof SlicerFX) {
                fx.setParam('rate', value);
            } else if (fx instanceof PhaserFX) {
                fx.setParam('rate', value);
            } else if (fx instanceof BrowserWorkletFX) {
                fx.setAmount(value / 100);
            } else if (fx instanceof BrowserTransposeFX) {
                fx.setParam('shift', (value / 100 * 48) - 24);
            } else if (fx instanceof BrowserManualHarmonistFX) {
                fx.setParam('mix_percent', value);
            } else if (fx instanceof BrowserHrmAutoFX) {
                fx.setParam('mix', value);
            } else if (fx instanceof BrowserRobotFX) {
                fx.setParam('robot.mix', value);
            } else if (fx instanceof BrowserOctaveFX) {
                fx.setParam('mix_percent', value);
            } else if (fx instanceof BrowserVocoderFX) {
                fx.setParam('mix', value);
            } else if (fx instanceof BrowserPitchBendFX) {
                fx.setParam('range', (value / 100) * 24);
            }
            for (const [key, authored] of Object.entries(fx.getParameterSnapshot?.() ?? this.officialFxParameterOverrides?.get(fx) ?? {})) {
                if (key.startsWith('official_') && typeof authored === 'number') fx.setParam(key, authored);
            }
            if (location === 'track' && fx instanceof BrowserWorkletFX && this.isLoopTransportFxName(this.trackFxTypes[slotIndex] ?? null)) {
                this.syncTrackLoopTransportFx(slotIndex);
            }
        }
    }

    /** Set authored named controls on one existing Browser catalog slot. */
    public setFxNamedParameters(location: 'input' | 'track', slotIndex: number, parameters: Record<string, number>) {
        if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 3 || !parameters || typeof parameters !== 'object') return;
        const instances = location === 'input' ? this.inputFxInstances : this.trackFxInstances;
        const fx = instances[slotIndex];
        if (!fx) return;
        const entries = Object.entries(parameters).sort(([a], [b]) => Number(b === 'official_variant') - Number(a === 'official_variant'));
        const overrides = this.officialFxParameterOverrides ??= new WeakMap<FXBase, Record<string, number>>();
        let authored = overrides.get(fx) ?? {};
        const type = (location === 'input' ? this.inputFxTypes : this.trackFxTypes)?.[slotIndex] ?? '';
        if (entries.some(([key]) => key.startsWith('official_')) && !isOfficialFxSlotAllowed(type, location, slotIndex)) return;
        const source = resolveOfficialEffect(type, { ...authored, ...parameters });
        const algorithm = 'algorithm' in fx ? String(fx.algorithm) : '';
        const admitted = BROWSER_OFFICIAL_PARAMETER_KEYS[algorithm] ?? [];
        const invalid = entries.find(([key, value]) => key.startsWith('official_') && (
            !admitted.includes(key) || (algorithm === 'vocoder' && key === 'official_carrier' && (value < 6 || value > 10 || !Number.isInteger(value))) || (key === 'official_variant' ? value !== 1 && value !== 2
                : key === 'official_step_index' ? !Number.isInteger(value) || value < 1 || value > 16 : !(() => { const parameter = findOfficialRuntimeParameter(source, key); return parameter && isOfficialRuntimeValueValid(parameter, value); })())));
        if (invalid) {
            this.lastError = `Unsupported official ${type} parameter: ${invalid[0]}. Slot bypassed.`;
            fx.setBypass(true);
            if (location === 'track' && this.isLoopTransportFxName(type)) {
                this.trackFxActive[slotIndex] = false;
                this.syncTrackLoopTransportFx(slotIndex);
            }
            this.emitStatus();
            return;
        }
        for (const [key, value] of entries) {
            if (key.startsWith('official_')) authored = mergeOfficialParameterEdit(authored, key, value);
        }
        overrides.set(fx, authored);
        for (const [key, value] of entries) {
            if (typeof key !== 'string' || key.length === 0) continue;
            // TRANSPOSE itself rejects invalid values by switching to a clean
            // bypass; do not silently keep a previously active pitch target.
            if (fx instanceof BrowserTransposeFX) fx.setParam(key, value);
            else if (fx instanceof BrowserManualHarmonistFX) fx.setParam(key, value);
            else if (fx instanceof BrowserHrmAutoFX) fx.setParam(key, value);
            else if (fx instanceof BrowserRobotFX) fx.setParam(key, value);
            else if (fx instanceof BrowserOctaveFX) fx.setParam(key, value);
            else if (fx instanceof BrowserVocoderFX) fx.setParam(key, value);
            else if (fx instanceof BrowserPitchBendFX) fx.setParam(key, value);
            else if (Number.isFinite(value)) fx.setParam(key, value);
        }
        for (const [key, value] of Object.entries(fx.getParameterSnapshot?.() ?? authored)) {
            if (key.startsWith('official_') && typeof value === 'number') fx.setParam(key, value);
        }
        if (location === 'track' && fx instanceof BrowserWorkletFX && this.isLoopTransportFxName(this.trackFxTypes[slotIndex] ?? null)) {
            this.syncTrackLoopTransportFx(slotIndex);
        }
    }

    /** Set one zero-based STEP SLICER amplitude target without exposing the rest of the Browser FX internals. */
    public setStepSlicerStep(location: 'input' | 'track', slotIndex: number, stepIndex: number, amplitudePercent: number) {
        if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 3) return;
        if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 15 || !Number.isFinite(amplitudePercent)) return;
        const instances = location === 'input' ? this.inputFxInstances : this.trackFxInstances;
        const effect = instances[slotIndex];
        if (!(effect instanceof BrowserWorkletFX) || effect.algorithm !== 'step-slicer') return;
        const level = Math.max(0, Math.min(100, Math.round(amplitudePercent)));
        const key = `step_${String(stepIndex + 1).padStart(2, '0')}`;
        effect.setParam(key, level);
    }

    /** Set a bounded musical/global STEP SLICER control on one Browser bank slot. */
    public setStepSlicerControl(
        location: 'input' | 'track',
        slotIndex: number,
        control: BrowserStepSlicerControl,
        value: number,
    ) {
        if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 3 || !Number.isFinite(value)) return;
        const instances = location === 'input' ? this.inputFxInstances : this.trackFxInstances;
        const effect = instances[slotIndex];
        if (!(effect instanceof BrowserWorkletFX) || effect.algorithm !== 'step-slicer') return;

        let bounded = value;
        if (control === 'step_count') {
            bounded = [4, 8, 16].reduce((closest, candidate) =>
                Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest, 4);
        } else if (control === 'rate_beats') {
            bounded = [0.25, 0.5, 1, 2, 4].reduce((closest, candidate) =>
                Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest, 0.25);
        } else if (control === 'pan_depth_percent') {
            bounded = Math.round(Math.max(0, Math.min(100, value)));
        } else {
            bounded = Math.round(Math.max(20, Math.min(20000, value)));
        }
        effect.setParam(control, bounded);
    }

    /**
     * Set FX Active/Bypass
     */
    public setFxActive(location: 'input' | 'track', slotIndex: number, active: boolean) {
        if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 3) return;
        const instances = location === 'input' ? this.inputFxInstances : this.trackFxInstances;
        const fx = instances[slotIndex];
        if (fx) {
            if (location === 'track') {
                this.trackFxActive ??= [false, false, false, false];
                const type = this.trackFxTypes[slotIndex];
                const sourceAware = this.isLoopTransportFxName(type ?? null);
                this.trackFxActive[slotIndex] = Boolean(active);
                // Active is represented by TrackAudio's source route for these
                // two effects, so the shared postmix adapter must remain dry.
                fx.setBypass(sourceAware ? true : !active);
                this.syncAllTrackLoopTransportFx();
            } else {
                this.inputFxActive[slotIndex] = Boolean(active);
                fx.setBypass(!active);
            }
        }
    }

    // ========================================
    // MONITORING CONTROL (CRITICAL SAFETY)
    // ========================================

    /**
     * Enable/disable software monitoring
     * WARNING: Only use with headphones to prevent feedback!
     */
    public setMonitoring(enabled: boolean) {
        this.monitoringEnabled = enabled;

        if (this.monitorGainNode) {
            // Smooth transition to prevent clicks
            this.monitorGainNode.gain.setTargetAtTime(
                enabled ? 1.0 : 0.0,
                this.context.currentTime,
                0.01
            );
        }

        console.log(`\n?? Software Monitoring: ${enabled ? 'ENABLED ??' : 'DISABLED (SAFE)'}`);
        if (enabled) {
            console.log('  ??  WARNING: Use headphones only! Speakers will cause feedback!\n');
        } else {
            console.log('  ? Safe mode - no direct monitoring\n');
        }

        this.monitoringListeners.forEach(listener => listener(this.monitoringEnabled));
        this.emitStatus();
    }

    public onMonitoringChange(listener: (enabled: boolean) => void) {
        this.monitoringListeners.add(listener);
        try { listener(this.monitoringEnabled); }
        catch (error) {
            this.monitoringListeners.delete(listener);
            throw error;
        }
        return () => {
            this.monitoringListeners.delete(listener);
        };
    }

    public getLatencyInfo(): BrowserAudioLatencyInfo {
        const audioContext = this.context as AudioContext & { outputLatency?: number };
        const baseLatencyMs = Number.isFinite(this.context.baseLatency)
            ? this.context.baseLatency * 1000
            : null;
        const outputLatencyMs = Number.isFinite(audioContext.outputLatency)
            ? (audioContext.outputLatency ?? 0) * 1000
            : null;
        const estimatedMonitoringLatencyMs = baseLatencyMs !== null
            ? baseLatencyMs + (outputLatencyMs ?? baseLatencyMs)
            : outputLatencyMs;

        return {
            sampleRate: this.context.sampleRate,
            baseLatencyMs,
            outputLatencyMs,
            estimatedMonitoringLatencyMs,
            roundTripLatencyMs: this.roundTripLatency > 0 ? this.roundTripLatency * 1000 : null,
        };
    }

    public onLatencyInfoChange(listener: (info: BrowserAudioLatencyInfo) => void) {
        this.latencyListeners.add(listener);
        try { listener(this.getLatencyInfo()); }
        catch (error) {
            this.latencyListeners.delete(listener);
            throw error;
        }
        return () => {
            this.latencyListeners.delete(listener);
        };
    }

    private hasLiveInputStream(): boolean {
        const audioTracks = this.currentMediaStream?.getAudioTracks() ?? [];
        return this.currentInputStream !== null && audioTracks.length > 0
            && audioTracks.some((track) => track.readyState !== 'ended');
    }

    public getUiStatus(): BrowserAudioUiStatus {
        const contextState = this.context.state;
        const closed = this.isAudioContextClosed();
        const recoveryAwaitingUserResume = this.isRecoveryAwaitingUserResume();
        const ready = this.initialized && contextState === 'running';
        const liveInput = !closed && this.hasLiveInputStream();
        const captureReady = liveInput && this.inputCaptureReady
            && this.inputCaptureReadyGeneration === this.inputCaptureGeneration;
        const captureWarming = liveInput && !captureReady && !this.inputCaptureUnavailableReason
            && (this.inputState === 'requesting' || this.inputCaptureNode !== null);
        return {
            mode: 'browser',
            bridgeAvailable: true,
            engineRunning: ready,
            ready,
            message: ready ? 'BROWSER AUDIO READY'
                : recoveryAwaitingUserResume ? 'LOOPS RECOVERED · CLICK TO FINISH OUTPUT SETUP; INPUT REMAINS DISCONNECTED'
                : closed ? 'BROWSER AUDIO CONTEXT CLOSED · EXPORT LOOPS BEFORE RELOADING'
                    : this.initialized && (contextState === 'suspended' || contextState === 'interrupted')
                        ? `BROWSER AUDIO ${contextState.toUpperCase()} · CLICK RETRY AUDIO`
                        : 'BROWSER AUDIO NOT INITIALIZED',
            lastError: closed ? (this.lastError || CLOSED_AUDIO_CONTEXT_ERROR) : this.lastError,
            inputReady: liveInput,
            inputCaptureReady: captureReady,
            inputCaptureWarming: captureWarming,
            inputCaptureWarmupReason: captureWarming ? this.inputCaptureWarmupReason : '',
            inputCaptureUnavailableReason: this.inputCaptureUnavailableReason,
            inputState: closed && this.selectedInputDeviceId ? 'error' : this.inputState,
            inputError: closed && this.selectedInputDeviceId ? (this.inputError || 'The Browser AudioContext closed; reconnect input after audio recovery.') : this.inputError,
            recoveryAwaitingUserResume,
        };
    }

    public onStatusChange(listener: (status: BrowserAudioUiStatus) => void) {
        this.statusListeners.add(listener);
        try { listener(this.getUiStatus()); }
        catch (error) {
            this.statusListeners.delete(listener);
            throw error;
        }
        return () => {
            this.statusListeners.delete(listener);
        };
    }

    public isNativeReady() {
        return this.getUiStatus().ready;
    }

    public isBridgeAvailable() {
        return true;
    }

    public supportsFx() {
        return true;
    }

    public supportsRhythm() {
        return true;
    }

    public supportsReverse() {
        return true;
    }

    public isTrackAvailable(trackId: number) {
        return trackId >= 1 && trackId <= this.tracks.length;
    }

    /** Export only the documented v1 project subset: PCM, BPM, transport timing, and project name. */
    public async exportProjectArchive(name: string): Promise<Uint8Array> {
        if (this.tracks.length !== 5) throw new Error('Project memory export requires all five Browser tracks');
        const revisions = this.tracks.map((track) => track.projectRevision);
        const snapshots = this.tracks.map((track) => track.getProjectPcmSnapshot());
        const pcmBytes = snapshots.reduce((sum, snapshot) => sum + (snapshot ? snapshot.frameCount * snapshot.channels * Float32Array.BYTES_PER_ELEMENT : 0), 0);
        if (!Number.isSafeInteger(pcmBytes) || pcmBytes > PROJECT_ARCHIVE_LIMITS.maxPayloadBytes) {
            throw new Error(`Project PCM exceeds the ${Math.floor(PROJECT_ARCHIVE_LIMITS.maxPayloadBytes / (1024 * 1024))} MiB archive payload limit`);
        }
        const transport = Transport.getInstance();
        const transportSnapshot = {
            bpm: transport.bpm,
            masterTrackId: transport.masterTrackId,
            measureLengthSeconds: transport.measureLength,
            masterLoopLengthSamples: transport.masterLoopLengthSamples,
            timeSignatureNumerator: transport.timeSignature[0],
            timeSignatureDenominator: transport.timeSignature[1],
        };
        if (transportSnapshot.masterTrackId !== null) {
            const master = snapshots[transportSnapshot.masterTrackId - 1];
            if (!master || master.frameCount !== transportSnapshot.masterLoopLengthSamples) {
                throw new Error('Project export canceled because master-loop length does not match the referenced track PCM');
            }
        } else if (transportSnapshot.masterLoopLengthSamples !== 0 || transportSnapshot.measureLengthSeconds !== 0) {
            throw new Error('Project export canceled because unmastered transport metadata contains loop timing');
        }
        const projectTransport = {
            masterTrackId: transportSnapshot.masterTrackId,
            // setBpm() can leave the live measure cache stale; archive the consistent
            // value derived from its saved BPM/signature and restore that exact timing.
            measureLengthSeconds: transportSnapshot.masterTrackId === null ? 0 : transport.getMeasureDuration(),
            masterLoopLengthSamples: transportSnapshot.masterLoopLengthSamples,
            timeSignatureNumerator: transportSnapshot.timeSignatureNumerator,
            timeSignatureDenominator: transportSnapshot.timeSignatureDenominator,
        };
        const tracks = snapshots.map((snapshot) => snapshot ? {
            sampleRate: snapshot.sampleRate,
            frameCount: snapshot.frameCount,
            channels: snapshot.channels,
            channelData: snapshot.channelData,
        } : null) as unknown as ProjectArchiveTrackList;
        const input: ProjectArchiveInput = {
            name,
            bpm: transportSnapshot.bpm,
            transport: projectTransport,
            tracks,
        };
        // The codec writes PCM into its final archive before awaiting digest work.
        // Any edit during the async digest phase aborts the save rather than storing
        // a mixed-generation project.
        const archive = await encodeProjectArchive(input);
        const currentTransport = Transport.getInstance();
        if (this.tracks.some((track, index) => track.projectRevision !== revisions[index] || track.historyBusy)
            || currentTransport.bpm !== transportSnapshot.bpm
            || currentTransport.masterTrackId !== transportSnapshot.masterTrackId
            || currentTransport.measureLength !== transportSnapshot.measureLengthSeconds
            || currentTransport.masterLoopLengthSamples !== transportSnapshot.masterLoopLengthSamples
            || currentTransport.timeSignature[0] !== transportSnapshot.timeSignatureNumerator
            || currentTransport.timeSignature[1] !== transportSnapshot.timeSignatureDenominator) {
            throw new Error('Project memory export canceled because a track changed while the archive was being prepared');
        }
        return archive;
    }

    /** Capture the state a delayed ProjectMemory load is allowed to replace. */
    public captureProjectRestoreToken(): BrowserProjectRestoreToken {
        const transport = Transport.getInstance();
        return Object.freeze({
            tracks: Object.freeze(this.tracks.map((track) => Object.freeze({
                revision: track.projectRevision,
                historyBusy: track.historyBusy,
                canUndo: track.canUndo,
                canRedo: track.canRedo,
                retainedHistoryBytes: track.historyRetainedBytes,
                unavailableReason: track.historyUnavailableReason,
            }))),
            transport: Object.freeze({
                bpm: transport.bpm,
                state: transport.state,
                masterTrackId: transport.masterTrackId,
                measureLengthSeconds: transport.measureLength,
                masterLoopLengthSamples: transport.masterLoopLengthSamples,
                timeSignatureNumerator: transport.timeSignature[0],
                timeSignatureDenominator: transport.timeSignature[1],
            }),
        });
    }

    private matchesProjectRestoreToken(token: BrowserProjectRestoreToken): boolean {
        if (token.tracks.length !== this.tracks.length) return false;
        const tracksMatch = this.tracks.every((track, index) => {
            const expected = token.tracks[index];
            return expected !== undefined
                && track.projectRevision === expected.revision
                && track.historyBusy === expected.historyBusy
                && track.canUndo === expected.canUndo
                && track.canRedo === expected.canRedo
                && track.historyRetainedBytes === expected.retainedHistoryBytes
                && track.historyUnavailableReason === expected.unavailableReason;
        });
        const transport = Transport.getInstance();
        return tracksMatch
            && transport.bpm === token.transport.bpm
            && transport.state === token.transport.state
            && transport.masterTrackId === token.transport.masterTrackId
            && transport.measureLength === token.transport.measureLengthSeconds
            && transport.masterLoopLengthSamples === token.transport.masterLoopLengthSamples
            && transport.timeSignature[0] === token.transport.timeSignatureNumerator
            && transport.timeSignature[1] === token.transport.timeSignatureDenominator;
    }

    /** Prepare five new AudioBuffers off to the side, then atomically publish them. */
    public restoreProjectArchive(project: ProjectArchive, archiveBytes: number, operationToken: BrowserProjectRestoreToken): void {
        if (this.tracks.length !== 5 || project.tracks.length !== 5) throw new Error('Project memory import requires exactly five Browser tracks');
        if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 1 || archiveBytes > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
            throw new Error('Project archive size is outside the supported import limit');
        }
        if (operationToken.tracks.some((track) => track.historyBusy) || !this.matchesProjectRestoreToken(operationToken)) {
            throw new Error('Project load canceled because a track, PCM history, or transport changed while the archive was being read; retry after edits finish');
        }
        const transport = Transport.getInstance();
        const transportState = project.transport;
        if (!Number.isFinite(project.bpm) || project.bpm < 40 || project.bpm > 300
            || !Number.isFinite(transportState.measureLengthSeconds) || transportState.measureLengthSeconds < 0
            || !Number.isSafeInteger(transportState.masterLoopLengthSamples) || transportState.masterLoopLengthSamples < 0
            || !Number.isInteger(transportState.timeSignatureNumerator) || transportState.timeSignatureNumerator < 1 || transportState.timeSignatureNumerator > 32
            || !Number.isInteger(transportState.timeSignatureDenominator) || ![1, 2, 4, 8, 16, 32].includes(transportState.timeSignatureDenominator)) {
            throw new Error('Project transport metadata is invalid');
        }
        if (this.tracks.some((track) => track.historyBusy)) {
            throw new Error('Stop recording and overdubbing on every track before loading project memory');
        }
        const masterId = transportState.masterTrackId;
        if (masterId !== null && (!Number.isInteger(masterId) || masterId < 1 || masterId > 5 || !project.tracks[masterId - 1])) {
            throw new Error('Project master track does not refer to a non-empty loop');
        }
        if (masterId === null && (transportState.masterLoopLengthSamples !== 0 || transportState.measureLengthSeconds !== 0)) {
            throw new Error('Project has transport timing metadata without a master track');
        }

        let incomingPcmBytes = 0;
        for (const track of project.tracks) {
            if (!track) continue;
            if (track.channels !== 1 && track.channels !== 2 || !Number.isSafeInteger(track.frameCount) || track.frameCount < 1
                || !Number.isFinite(track.sampleRate) || track.sampleRate < 8_000 || track.sampleRate > 384_000
                || track.pcm.length !== track.frameCount * track.channels) {
                throw new Error('Project contains an invalid loop length, sample rate, or channel count');
            }
            incomingPcmBytes += track.pcm.byteLength;
            for (const sample of track.pcm) {
                if (!Number.isFinite(sample)) throw new Error('Project contains a non-finite PCM sample');
            }
        }
        if (masterId !== null) {
            const masterTrack = project.tracks[masterId - 1]!;
            if (transportState.masterLoopLengthSamples !== masterTrack.frameCount) {
                throw new Error('Project master-loop sample length does not match the referenced track PCM');
            }
            const quarterNotesPerMeasure = transportState.timeSignatureNumerator * 4 / transportState.timeSignatureDenominator;
            const expectedMeasureLength = quarterNotesPerMeasure * 60 / project.bpm;
            if (Math.abs(transportState.measureLengthSeconds - expectedMeasureLength) > Math.max(1e-9, expectedMeasureLength * 1e-9)) {
                throw new Error('Project master measure timing is inconsistent with its BPM and time signature');
            }
        }
        if (!Number.isSafeInteger(incomingPcmBytes) || incomingPcmBytes > PROJECT_ARCHIVE_LIMITS.maxPayloadBytes) {
            throw new Error('Project PCM exceeds the supported aggregate payload limit');
        }
        const currentPcmBytes = this.tracks.reduce((sum, track) => {
            const snapshot = track.getProjectPcmSnapshot();
            return sum + (snapshot ? snapshot.frameCount * snapshot.channels * Float32Array.BYTES_PER_ELEMENT : 0);
        }, 0);
        const retainedHistoryBytes = this.tracks.reduce((sum, track) => sum + track.historyRetainedBytes, 0);
        // Conservative all-at-once peak estimate: existing loops/history, archive bytes,
        // decoded PCM, and five candidate AudioBuffers. This is an admission guard, not
        // a claim about opaque browser/engine memory beyond these PCM allocations.
        const estimatedPeakBytes = currentPcmBytes + retainedHistoryBytes + archiveBytes + incomingPcmBytes + incomingPcmBytes;
        const MAX_PROJECT_TRANSACTION_PCM_BYTES = 4 * 1024 * 1024 * 1024;
        if (!Number.isSafeInteger(estimatedPeakBytes) || estimatedPeakBytes > MAX_PROJECT_TRANSACTION_PCM_BYTES) {
            throw new Error('Load canceled: the current loops plus archive and five prepared loops exceed the 4 GiB project-operation PCM estimate');
        }

        const revisions = operationToken.tracks.map((track) => track.revision);
        const replacements = project.tracks.map((track) => {
            if (!track) return null;
            const buffer = this.context.createBuffer(track.channels, track.frameCount, track.sampleRate);
            for (let frame = 0; frame < track.frameCount; frame += 1) {
                for (let channel = 0; channel < track.channels; channel += 1) {
                    buffer.getChannelData(channel)[frame] = track.pcm[frame * track.channels + channel]!;
                }
            }
            return buffer;
        });
        if (this.tracks.some((track, index) => track.projectRevision !== revisions[index] || track.historyBusy)) {
            throw new Error('Load canceled because a track changed while new AudioBuffers were being prepared');
        }
        const restore = TrackAudio.restoreProjectBuffersAtomically(this.tracks, replacements, revisions);
        if (!restore.ok) throw new Error(restore.reason ?? 'Project memory restore was rejected');

        transport.stop();
        transport.resetMasterTrack();
        transport.timeSignature = [transportState.timeSignatureNumerator, transportState.timeSignatureDenominator];
        transport.masterTrackId = masterId;
        transport.measureLength = transportState.measureLengthSeconds;
        transport.masterLoopLengthSamples = transportState.masterLoopLengthSamples;
        transport.setBpm(project.bpm);
    }

    // ========================================
    // DEVICE PREFERENCES (LOCALSTORAGE)
    // ========================================

    private saveDevicePreferences() {
        try {
            localStorage.setItem('audioInputDeviceId', this.selectedInputDeviceId || '');
            localStorage.setItem('audioOutputDeviceId', this.selectedOutputDeviceId || '');
            console.log('  ?? Device preferences saved');
        } catch (error) {
            console.warn('Failed to save device preferences:', error);
        }
    }

    private loadDevicePreferences() {
        try {
            this.selectedInputDeviceId = localStorage.getItem('audioInputDeviceId') || null;
            this.selectedOutputDeviceId = localStorage.getItem('audioOutputDeviceId') || null;

            if (this.selectedInputDeviceId || this.selectedOutputDeviceId) {
                console.log('?? Loaded saved device preferences');
            }
        } catch (error) {
            console.warn('Failed to load device preferences:', error);
        }
    }

    // ========================================
    // TEST AUDIO
    // ========================================

    /**
     * Play a short test tone to verify output device
     */
    public playTestTone() {
        const osc = this.context.createOscillator();
        const gain = this.context.createGain();

        osc.connect(gain);
        gain.connect(this.context.destination);

        osc.frequency.value = 440; // A4
        gain.gain.value = 0.3;

        const now = this.context.currentTime;
        osc.start(now);
        osc.stop(now + 0.2); // 200ms beep

        console.log('?? Test tone played (440Hz, 200ms)');
    }

    // ========================================
    // LEGACY METHODS (UPDATED FOR SAFETY)
    // ========================================

    /**
     * Get input stream for recording
     * SAFETY: Returns the managed input stream
     */
    public async getInputStream(): Promise<MediaStreamAudioSourceNode> {
        if (this.isAudioContextClosed()) {
            this.handleClosedAudioContext();
            throw new Error(CLOSED_AUDIO_CONTEXT_ERROR);
        }
        if (this.currentInputStream && !this.hasLiveInputStream() && this.currentMediaStream) {
            this.handleInputTrackEnded(this.currentMediaStream, this.currentInputStream, this.currentInputRequestGeneration);
        }
        if (!this.currentInputStream) {
            // Initialize default input if not set
            await this.setInputDevice(this.selectedInputDeviceId || '');
        }
        if (!this.currentInputStream || !this.hasLiveInputStream()) {
            throw new Error('No live audio input device is connected.');
        }
        return this.currentInputStream;
    }

    public async getProcessedInputNode(): Promise<AudioNode> {
        await this.getInputStream();
        return this.inputFxChain.output;
    }

    // ========================================
    // LOOPBACK LATENCY TEST
    // ========================================

    private async getTestStream(): Promise<MediaStream> {
        try {
            return await this.requestInputStream(this.selectedInputDeviceId || '');
        } catch (error) {
            if (this.selectedInputDeviceId && this.shouldFallbackToDefaultInput(error)) {
                return this.requestInputStream('');
            }
            throw error;
        }
    }

    public async runLoopbackTest(): Promise<number> {
        if (this.isAudioContextClosed()) {
            this.handleClosedAudioContext();
            throw new Error(CLOSED_AUDIO_CONTEXT_ERROR);
        }
        console.log('Starting Loopback Latency Test...');

        try {
            await this.ensureTrackIoWorkletModule();
        } catch (error) {
            this.lastError = `Loopback capture requires AudioWorklet: ${error instanceof Error ? error.message : String(error)}`;
            this.emitStatus();
            throw new Error(`${this.lastError}. Track playback remains available.`);
        }

        let stream: MediaStream;
        try {
            stream = await this.getTestStream();
        } catch (e) {
            console.error('Failed to get test stream', e);
            throw new Error('Could not access microphone. Check permissions.');
        }

        const captureResult: { buffer: Float32Array | null; error: string | null } = { buffer: null, error: null };
        const source = this.context.createMediaStreamSource(stream);
        const recorder = new AudioWorkletNode(this.context, 'rc505-loopback-capture', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: 'explicit',
            processorOptions: { captureFrames: this.context.sampleRate },
        });
        recorder.port.onmessage = (event: MessageEvent) => {
            const message = event.data as { type?: string; framesCaptured?: number; samples?: Float32Array } | null;
            if (
                message?.type === 'LOOPBACK_CAPTURE' &&
                message.samples instanceof Float32Array &&
                Number.isInteger(message.framesCaptured) &&
                (message.framesCaptured ?? 0) > 0
            ) {
                captureResult.buffer = message.samples;
            }
        };
        recorder.onprocessorerror = () => {
            captureResult.error = 'The loopback AudioWorklet stopped unexpectedly.';
        };

        const mute = this.context.createGain();
        mute.gain.value = 0;
        const osc = this.context.createOscillator();
        const oscGain = this.context.createGain();
        const signalDelay = 0.1;

        try {
            source.connect(recorder);
            recorder.connect(mute);
            mute.connect(this.context.destination);

            osc.frequency.value = 1000;
            oscGain.gain.value = 0.8;
            osc.connect(oscGain);
            oscGain.connect(this.context.destination);

            const now = this.context.currentTime;
            osc.start(now + signalDelay);
            osc.stop(now + signalDelay + 0.05);

            // One second of mono capture is returned as a single bounded transfer.
            // Waiting through the same observation window preserves the old test timing.
            await new Promise(resolve => setTimeout(resolve, 1200));
        } finally {
            recorder.port.onmessage = null;
            osc.disconnect();
            oscGain.disconnect();
            source.disconnect();
            recorder.disconnect();
            mute.disconnect();
            stream.getTracks().forEach(t => t.stop());
        }

        const recordingBuffer = captureResult.buffer as Float32Array | null;
        if (captureResult.error) {
            this.lastError = captureResult.error;
            this.emitStatus();
            throw new Error(captureResult.error);
        }
        if (!recordingBuffer) {
            this.lastError = 'AudioWorklet loopback capture did not return a complete sample buffer.';
            this.emitStatus();
            throw new Error(this.lastError);
        }

        let peakIndex = -1;
        const threshold = 0.05;
        for (let i = 0; i < recordingBuffer.length; i++) {
            const sample = recordingBuffer[i];
            if (sample !== undefined && Math.abs(sample) > threshold) {
                peakIndex = i;
                break;
            }
        }

        if (peakIndex === -1) {
            throw new Error('Signal not detected. Increase volume/check loopback.');
        }

        const latencyMs = ((peakIndex / this.context.sampleRate) - signalDelay) * 1000;
        console.log(`Latency Test: Peak at ${(peakIndex / this.context.sampleRate).toFixed(4)}s, Delay ${signalDelay}s, Result ${latencyMs.toFixed(2)}ms`);

        this.lastError = '';
        this.emitStatus();
        return Math.max(0, latencyMs);
    }

    public setLatency(latencyMs: number) {
        this.roundTripLatency = latencyMs / 1000;
        console.log(`Latency compensation set to: ${this.roundTripLatency.toFixed(4)}s`);
        this.emitLatencyInfo();
    }

    // ========================================
    // TRACK EDITING (Phase 7)
    // ========================================

    public checkAndResetMaster(clearedTrackId: number) {
        const transport = Transport.getInstance();
        if (transport.masterTrackId !== clearedTrackId) return;

        // Check if any other track is playing or has content
        const hasContent = this.tracks.some(t => t.track.id !== clearedTrackId && t.state !== TrackState.EMPTY);

        if (!hasContent) {
            transport.resetMasterTrack();
        }
    }

    public clearTrack(trackIndex: number) {
        if (this.tracks[trackIndex]) {
            this.tracks[trackIndex].clear();
        }
    }

    public stopAllTracks() {
        this.tracks.forEach(track => {
            if (track.state !== TrackState.EMPTY) {
                track.triggerStop();
            }
        });
    }

    public playAllTracks() {
        this.tracks.forEach(track => {
            if (track.state === TrackState.STOPPED) {
                track.play();
            }
        });
    }

    public toggleReverse(trackIndex: number) {
        if (this.tracks[trackIndex]) {
            this.tracks[trackIndex].toggleReverse();
        }
    }

    private createInputConstraints(deviceId: string): MediaStreamConstraints {
        return {
            audio: {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                echoCancellation: false,
                autoGainControl: false,
                noiseSuppression: false
            }
        };
    }

    private async requestInputStream(deviceId: string): Promise<MediaStream> {
        return getUserMediaWithTimeout(navigator.mediaDevices, this.createInputConstraints(deviceId));
    }

    private isCurrentInputDeviceRequest(generation: number): boolean {
        return generation === this.inputDeviceRequestGeneration;
    }

    private stopInputMediaStream(stream: MediaStream): void {
        stream.getTracks().forEach((track) => {
            if (track.readyState !== 'ended') track.stop();
        });
    }

    private detachInputTrackEndedHandlers(stream?: MediaStream): void {
        const tracks = stream ? new Set(stream.getTracks()) : null;
        const keep: typeof this.inputTrackEndedHandlers = [];
        for (const entry of this.inputTrackEndedHandlers) {
            if (!tracks || tracks.has(entry.track)) entry.track.removeEventListener('ended', entry.listener);
            else keep.push(entry);
        }
        this.inputTrackEndedHandlers = keep;
    }

    private attachInputTrackEndedHandlers(
        stream: MediaStream,
        source: MediaStreamAudioSourceNode,
        requestGeneration: number,
    ): void {
        this.detachInputTrackEndedHandlers();
        const audioTracks = stream.getAudioTracks();
        for (const track of audioTracks) {
            const listener: EventListener = () => this.handleInputTrackEnded(stream, source, requestGeneration);
            track.addEventListener('ended', listener, { once: true });
            this.inputTrackEndedHandlers.push({ track, listener });
        }
        // Some browsers/devices can return a stream whose track has already
        // ended. Do not treat a source node backed by that stream as ready.
        if (audioTracks.length === 0 || audioTracks.some((track) => track.readyState === 'ended')) {
            this.handleInputTrackEnded(stream, source, requestGeneration);
        }
    }

    private handleInputTrackEnded(
        stream: MediaStream,
        source: MediaStreamAudioSourceNode,
        requestGeneration: number,
    ): void {
        if (this.currentMediaStream !== stream || this.currentInputStream !== source
            || this.currentInputRequestGeneration !== requestGeneration) return;

        this.detachInputTrackEndedHandlers(stream);
        try { source.disconnect(); } catch { /* the source may already be disconnected */ }
        this.currentInputStream = null;
        this.currentMediaStream = null;
        this.stopInputMediaStream(stream);

        const reason = 'The selected input device ended or disconnected.';
        this.inputCaptureUnavailableReason = reason;
        this.disposeInputCaptureTap('input-device-ended');
        for (const track of this.tracks) track.handleInputUnavailable(reason);

        // Do not overwrite the status of a newer device request that is still
        // pending. Its success or failure will publish the final state.
        const newerInputRequestPending = this.inputState === 'requesting'
            && this.inputDeviceRequestGeneration !== requestGeneration;
        if (!newerInputRequestPending) {
            this.inputState = 'error';
            this.inputError = reason;
        }
        this.monitoringListeners.forEach((listener) => listener(this.monitoringEnabled));
        this.emitLatencyInfo();
        this.emitStatus();
    }

    private async replaceInputStream(
        stream: MediaStream,
        requestGeneration: number,
        selectedDeviceId: string | null,
    ): Promise<boolean> {
        if (!this.isCurrentInputDeviceRequest(requestGeneration)) {
            this.stopInputMediaStream(stream);
            return false;
        }
        if (stream.getAudioTracks().length === 0
            || stream.getAudioTracks().some((track) => track.readyState === 'ended')) {
            this.stopInputMediaStream(stream);
            throw new Error('The selected input device returned no live audio track.');
        }
        try {
            this.postInputCaptureReady(false);
        } catch (error) {
            this.inputCaptureUnavailableReason = error instanceof Error ? error.message : String(error);
            this.disposeInputCaptureTap('input-generation-reset-failed');
        }
        let nextInput: MediaStreamAudioSourceNode | null = null;
        try {
            nextInput = this.context.createMediaStreamSource(stream);
            nextInput.connect(this.inputFxChain.input);
        } catch (error) {
            nextInput?.disconnect();
            this.stopInputMediaStream(stream);
            if (this.isCurrentInputDeviceRequest(requestGeneration) && this.currentInputStream) {
                const incumbent = this.currentInputStream;
                if (incumbent) {
                    try { await this.activateInputCaptureTap(requestGeneration, incumbent); }
                    catch { /* keep the incumbent input usable */ }
                }
            }
            throw error;
        }

        // The permission prompt can resolve out of order. Check once more at
        // the synchronous graph-switch boundary so a stale stream is never
        // installed after a newer user request has begun.
        if (!this.isCurrentInputDeviceRequest(requestGeneration)) {
            nextInput.disconnect();
            this.stopInputMediaStream(stream);
            return false;
        }

        if (this.currentInputStream) {
            this.currentInputStream.disconnect();
            console.log('  ? Disconnected old input node');
        }

        if (this.currentMediaStream) {
            this.detachInputTrackEndedHandlers(this.currentMediaStream);
            this.stopInputMediaStream(this.currentMediaStream);
            console.log('  ? Stopped old input stream');
        }

        this.currentInputStream = nextInput;
        this.currentMediaStream = stream;
        this.currentInputRequestGeneration = requestGeneration;
        this.selectedInputDeviceId = selectedDeviceId;
        this.saveDevicePreferences();
        this.attachInputTrackEndedHandlers(stream, nextInput, requestGeneration);
        if (this.currentInputStream !== nextInput || this.currentMediaStream !== stream) return false;

        try {
            await this.activateInputCaptureTap(requestGeneration, nextInput);
            if (!this.isCurrentInputDeviceRequest(requestGeneration)
                || this.currentInputStream !== nextInput || this.currentMediaStream !== stream) return false;
            this.inputCaptureUnavailableReason = '';
        } catch (error) {
            const candidateIsCurrent = this.isCurrentInputDeviceRequest(requestGeneration)
                && this.currentInputStream === nextInput && this.currentMediaStream === stream;
            if (candidateIsCurrent) {
                this.inputCaptureReady = false;
                this.inputCaptureUnavailableReason = error instanceof Error ? error.message : String(error);
                console.warn('Shared input capture tap is unavailable; the legacy per-track recorder remains available.', error);
            }
        }
        return this.currentInputStream === nextInput && this.currentMediaStream === stream;
    }

    private async activateInputCaptureTap(
        requestGeneration: number,
        expectedSource: MediaStreamAudioSourceNode,
    ): Promise<void> {
        if (!this.isCurrentInputDeviceRequest(requestGeneration)
            || this.currentInputStream !== expectedSource || !this.hasLiveInputStream()) {
            throw new Error('Input device request was superseded before shared capture warm-up.');
        }
        if (!this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
            throw new Error('AudioWorklet is unavailable for shared input capture.');
        }
        await this.loadAudioWorkletModule('/worklets/browser-input-capture.js');
        if (!this.isCurrentInputDeviceRequest(requestGeneration)
            || this.currentInputStream !== expectedSource || !this.hasLiveInputStream()) {
            throw new Error('Input device request was superseded before shared capture initialization.');
        }

        if (!this.inputCaptureNode) {
            const node = new AudioWorkletNode(this.context, 'rc505-input-capture', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                channelCount: 2,
                channelCountMode: 'max',
                channelInterpretation: 'speakers',
                processorOptions: {
                    trackCount: 5,
                    chunkSize: 16_384,
                    chunkPoolSize: 3,
                    preRollFrames: 8_192,
                    maxRecordingBytes: 384 * 1024 * 1024,
                    sampleRate: this.context.sampleRate,
                },
            });
            const mute = this.context.createGain();
            mute.gain.value = 0;
            try {
                this.inputFxChain.output.connect(node);
                node.connect(mute);
                mute.connect(this.context.destination);
            } catch (error) {
                try { disconnectAudioNodeIfConnected(this.inputFxChain.output, node); } catch { /* failed graph setup */ }
                node.disconnect();
                mute.disconnect();
                throw error;
            }
            node.port.onmessage = (event: MessageEvent) => this.handleInputCaptureMessage(event.data);
            node.onprocessorerror = () => {
                this.inputCaptureReady = false;
                this.inputCaptureReadyGeneration = 0;
                this.inputCaptureWarmupReason = '';
                this.inputCaptureUnavailableReason = 'The shared input capture AudioWorklet stopped unexpectedly.';
                this.rejectInputCaptureReadyWaiters(new Error(this.inputCaptureUnavailableReason));
                for (const [trackIndex, record] of this.inputCaptureSessions) {
                    record.listener({
                        type: 'CAPTURE_ERROR', trackIndex, sessionId: record.session.sessionId,
                        inputGeneration: record.session.inputGeneration, reason: 'capture-processor-error',
                    });
                }
                this.emitStatus();
            };
            this.inputCaptureNode = node;
            this.inputCaptureMuteGainNode = mute;
        }

        const ready = this.postInputCaptureReady(true);
        if (!ready) throw new Error('Shared input capture worklet is unavailable.');
        const generation = this.inputCaptureGeneration;
        try {
            await withBrowserAudioTimeout(
                () => ready,
                'Browser shared input capture warm-up',
                3_000,
            );
            if (!this.isCurrentInputDeviceRequest(requestGeneration)
                || this.currentInputStream !== expectedSource || !this.hasLiveInputStream()) {
                throw new Error('Input device request was superseded during shared capture warm-up.');
            }
        } catch (error) {
            const waiter = this.inputCaptureReadyWaiters.get(generation);
            if (waiter) {
                this.inputCaptureReadyWaiters.delete(generation);
                waiter.reject(error instanceof Error ? error : new Error(String(error)));
            }
            throw error;
        }
        this.inputCaptureUnavailableReason = '';
    }

    private postInputCaptureReady(ready: boolean): Promise<void> | null {
        const node = this.inputCaptureNode;
        if (!node) {
            this.inputCaptureReady = false;
            return null;
        }
        const generation = ++this.inputCaptureGeneration;
        this.inputCaptureReady = false;
        this.inputCaptureReadyGeneration = 0;
        this.inputCaptureWarmupReason = ready ? 'Warming the shared capture pre-roll before recording is enabled.' : '';
        if (ready) this.inputCaptureUnavailableReason = '';
        this.rejectInputCaptureReadyWaiters(new Error('Input capture generation changed.'));
        let readyPromise: Promise<void> | null = null;
        if (ready) {
            readyPromise = new Promise<void>((resolve, reject) => {
                this.inputCaptureReadyWaiters.set(generation, { resolve, reject });
            });
        }
        try {
            node.port.postMessage({
                type: 'INPUT_READY', ready, generation,
                sampleRate: this.context.sampleRate,
            });
        } catch (error) {
            this.rejectInputCaptureReadyWaiters(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
        this.emitStatus();
        return readyPromise;
    }

    private rejectInputCaptureReadyWaiters(error: Error): void {
        for (const [generation, waiter] of this.inputCaptureReadyWaiters) {
            this.inputCaptureReadyWaiters.delete(generation);
            waiter.reject(error);
        }
    }

    private handleInputCaptureMessage(message: any): void {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'INPUT_CAPTURE_NOT_READY') {
            if (message.inputGeneration !== this.inputCaptureGeneration
                || message.sampleRate !== this.context.sampleRate) return;
            this.inputCaptureReady = false;
            this.inputCaptureReadyGeneration = 0;
            this.inputCaptureWarmupReason = typeof message.reason === 'string'
                ? `Shared capture is rewarming after ${message.reason}.`
                : 'Shared capture is rewarming after an input timeline reset.';
            this.emitStatus();
            return;
        }
        if (message.type === 'INPUT_CAPTURE_READY') {
            if (message.inputGeneration !== this.inputCaptureGeneration
                || message.sampleRate !== this.context.sampleRate) return;
            const validRange = Number.isSafeInteger(message.oldestAvailableFrame)
                && message.oldestAvailableFrame >= 0
                && Number.isSafeInteger(message.latestAvailableFrame)
                && message.latestAvailableFrame >= message.oldestAvailableFrame
                && Number.isSafeInteger(message.preRollValidFrames)
                && Number.isSafeInteger(message.preRollCapacityFrames)
                && Number.isSafeInteger(message.requiredPreRollFrames)
                && message.requiredPreRollFrames >= MINIMUM_EXACT_CAPTURE_PREROLL_FRAMES
                && message.requiredPreRollFrames <= message.preRollCapacityFrames
                && message.preRollValidFrames >= message.requiredPreRollFrames
                && message.preRollValidFrames <= message.preRollCapacityFrames
                && message.latestAvailableFrame - message.oldestAvailableFrame === message.preRollValidFrames;
            if (!validRange) {
                this.inputCaptureUnavailableReason = 'The shared capture worklet reported an invalid pre-roll readiness range.';
                this.inputCaptureReady = false;
                this.inputCaptureReadyGeneration = 0;
                this.rejectInputCaptureReadyWaiters(new Error(this.inputCaptureUnavailableReason));
                this.emitStatus();
                return;
            }
            this.inputCaptureReady = true;
            this.inputCaptureReadyGeneration = message.inputGeneration;
            this.inputCaptureWarmupReason = '';
            this.inputCaptureUnavailableReason = '';
            const waiter = this.inputCaptureReadyWaiters.get(message.inputGeneration);
            if (waiter) {
                this.inputCaptureReadyWaiters.delete(message.inputGeneration);
                waiter.resolve();
            }
            this.emitStatus();
            return;
        }
        const trackIndex = message.trackIndex;
        const record = Number.isInteger(trackIndex) ? this.inputCaptureSessions.get(trackIndex) : undefined;
        if (!record || record.session.sessionId !== message.sessionId
            || record.session.inputGeneration !== message.inputGeneration) {
            if (message.type === 'RECORD_CHUNK') this.recycleUnclaimedInputCaptureChunk(message);
            return;
        }
        record.listener(message);
    }

    private recycleUnclaimedInputCaptureChunk(message: any): void {
        const node = this.inputCaptureNode;
        const channels = message.channels;
        if (!node || !Number.isInteger(message.trackIndex) || !Number.isSafeInteger(message.sessionId)
            || !Number.isInteger(message.chunkIndex) || !Array.isArray(channels)
            || channels.length < 1 || channels.length > 2
            || channels.some((channel: unknown) => !(channel instanceof Float32Array) || channel.length !== 16_384)) return;
        const recycle = this.inputCaptureRecycleMessage;
        recycle.trackIndex = message.trackIndex;
        recycle.sessionId = message.sessionId;
        recycle.chunkIndex = message.chunkIndex;
        recycle.channels = channels;
        const transfers = this.inputCaptureRecycleTransfers;
        transfers.length = channels.length;
        for (let index = 0; index < channels.length; index += 1) transfers[index] = channels[index]!.buffer;
        node.port.postMessage(recycle, transfers);
    }

    public recycleInputCaptureChunk(
        session: InputCaptureSession,
        chunkIndex: number,
        channels: Float32Array[],
    ): boolean {
        const record = this.inputCaptureSessions.get(session.trackIndex);
        if (!record || record.session.sessionId !== session.sessionId
            || record.session.inputGeneration !== session.inputGeneration
            || record.session.node !== session.node || !Number.isInteger(chunkIndex)
            || chunkIndex < 0 || chunkIndex >= 3 || !Array.isArray(channels)
            || channels.length < 1 || channels.length > 2
            || channels.some((channel) => !(channel instanceof Float32Array) || channel.length !== 16_384)) return false;
        const recycle = this.inputCaptureRecycleMessage;
        recycle.trackIndex = session.trackIndex;
        recycle.sessionId = session.sessionId;
        recycle.chunkIndex = chunkIndex;
        recycle.channels = channels;
        const transfers = this.inputCaptureRecycleTransfers;
        transfers.length = channels.length;
        for (let index = 0; index < channels.length; index += 1) transfers[index] = channels[index]!.buffer;
        try {
            session.node.port.postMessage(recycle, transfers);
            return true;
        } catch (error) {
            this.inputCaptureUnavailableReason = error instanceof Error ? error.message : String(error);
            return false;
        }
    }

    public getInputCaptureRequestFrame(): number | null {
        if (!this.inputCaptureReady || !this.hasLiveInputStream()) return null;
        return Math.ceil(this.context.currentTime * this.context.sampleRate);
    }

    public beginInputCaptureSession(
        trackIndex: number,
        startFrame: number,
        listener: (message: unknown) => void,
        maxRecordingFrames?: number,
    ): InputCaptureSession | null {
        const node = this.inputCaptureNode;
        if (!node || !this.inputCaptureReady || this.inputCaptureReadyGeneration !== this.inputCaptureGeneration
            || !this.hasLiveInputStream() || !Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= 5
            || !Number.isSafeInteger(startFrame) || startFrame < 0 || this.inputCaptureSessions.has(trackIndex)
            || (maxRecordingFrames !== undefined && (!Number.isSafeInteger(maxRecordingFrames)
                || maxRecordingFrames < 0 || maxRecordingFrames > 1_000_000))) return null;
        if (!Number.isSafeInteger(this.nextInputCaptureSessionId) || this.nextInputCaptureSessionId <= 0) return null;
        const session: InputCaptureSession = {
            node,
            trackIndex,
            sessionId: this.nextInputCaptureSessionId++,
            inputGeneration: this.inputCaptureGeneration,
            startFrame,
            ...(maxRecordingFrames !== undefined ? { maxRecordingFrames } : {}),
        };
        this.inputCaptureSessions.set(trackIndex, { session, listener });
        try {
            node.port.postMessage({
                type: 'START_CAPTURE', trackIndex, sessionId: session.sessionId,
                inputGeneration: session.inputGeneration, startFrame,
                ...(maxRecordingFrames !== undefined ? { maxRecordingFrames } : {}),
                maxRecordingBytes: 384 * 1024 * 1024,
            });
            return session;
        } catch (error) {
            this.inputCaptureSessions.delete(trackIndex);
            this.inputCaptureUnavailableReason = error instanceof Error ? error.message : String(error);
            return null;
        }
    }

    public stopInputCaptureSession(session: InputCaptureSession, stopFrame: number): boolean {
        const record = this.inputCaptureSessions.get(session.trackIndex);
        if (!record || record.session.sessionId !== session.sessionId || record.session.node !== session.node
            || !Number.isSafeInteger(stopFrame) || stopFrame < session.startFrame) return false;
        try {
            session.node.port.postMessage({
                type: 'STOP_CAPTURE', trackIndex: session.trackIndex,
                sessionId: session.sessionId, inputGeneration: session.inputGeneration,
                stopFrame,
            });
            return true;
        } catch {
            return false;
        }
    }

    public abortInputCaptureSession(session: InputCaptureSession): void {
        const record = this.inputCaptureSessions.get(session.trackIndex);
        if (!record || record.session.sessionId !== session.sessionId || record.session.node !== session.node) return;
        try {
            session.node.port.postMessage({
                type: 'ABORT_CAPTURE', trackIndex: session.trackIndex,
                sessionId: session.sessionId, inputGeneration: session.inputGeneration,
            });
        } catch { /* the context may already be closed */ }
    }

    public releaseInputCaptureSession(session: InputCaptureSession): void {
        const record = this.inputCaptureSessions.get(session.trackIndex);
        if (record?.session.sessionId === session.sessionId && record.session.node === session.node) {
            this.inputCaptureSessions.delete(session.trackIndex);
        }
    }

    private disposeInputCaptureTap(reason: string): void {
        for (const waiter of this.inputCaptureReadyWaiters.values()) waiter.reject(new Error(reason));
        this.inputCaptureReadyWaiters.clear();
        this.inputCaptureReady = false;
        this.inputCaptureReadyGeneration = 0;
        this.inputCaptureWarmupReason = '';
        for (const [trackIndex, record] of this.inputCaptureSessions) {
            record.listener({
                type: 'CAPTURE_ERROR', trackIndex, sessionId: record.session.sessionId,
                inputGeneration: record.session.inputGeneration, reason,
            });
        }
        this.inputCaptureSessions.clear();
        const node = this.inputCaptureNode;
        if (node) {
            node.port.onmessage = null;
            node.onprocessorerror = null;
            try { disconnectAudioNodeIfConnected(this.inputFxChain.output, node); } catch { /* context closing */ }
            try { node.disconnect(); } catch { /* already disconnected */ }
            try { node.port.close?.(); } catch { /* already closed */ }
        }
        try { this.inputCaptureMuteGainNode?.disconnect(); } catch { /* already disconnected */ }
        this.inputCaptureNode = null;
        this.inputCaptureMuteGainNode = null;
    }

    private shouldFallbackToDefaultInput(error: unknown): boolean {
        if (!(error instanceof DOMException)) return false;
        return error.name === 'OverconstrainedError' || error.name === 'NotFoundError' || error.name === 'NotReadableError';
    }

    private emitLatencyInfo() {
        const info = this.getLatencyInfo();
        this.latencyListeners.forEach(listener => listener(info));
    }

    private emitStatus() {
        const status = this.getUiStatus();
        this.statusListeners.forEach(listener => listener(status));
    }

    /** A closed AudioContext cannot be resumed; keep PCM/history available for export. */
    private handleClosedAudioContext(): void {
        if (this.closedAudioContextHandled) return;
        this.closedAudioContextHandled = true;
        const reason = 'The Browser AudioContext closed. Any active recording or overdub was canceled; existing loop PCM and history were preserved.';
        this.initialized = false;
        this.lastError = CLOSED_AUDIO_CONTEXT_ERROR;

        // Invalidate an outstanding getUserMedia request before stopping the
        // current stream, so a late permission result is immediately stopped.
        const generation = ++this.inputDeviceRequestGeneration;
        this.currentInputRequestGeneration = generation;
        this.detachInputTrackEndedHandlers();
        const source = this.currentInputStream;
        const stream = this.currentMediaStream;
        this.currentInputStream = null;
        this.currentMediaStream = null;
        source?.disconnect();
        if (stream) this.stopInputMediaStream(stream);
        this.inputState = this.selectedInputDeviceId ? 'error' : 'not-requested';
        this.inputError = this.selectedInputDeviceId ? reason : '';

        this.disposeInputCaptureTap('audio-context-closed');
        for (const track of this.tracks) track.handleInputUnavailable(reason);
        this.monitoringListeners.forEach((listener) => listener(false));
        this.emitLatencyInfo();
        this.emitStatus();
    }

    private isAudioContextClosed(): boolean {
        // OfflineAudioContext is used by deterministic worklet tests and becomes
        // closed after rendering; it is not the live Browser graph this status
        // describes.
        return typeof AudioContext !== 'undefined'
            && this.context instanceof AudioContext
            && this.context.state === 'closed';
    }
}
