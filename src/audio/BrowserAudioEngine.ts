import { TrackAudio } from './TrackAudio';
import { MemorySettings, Track, TrackState, TransportState } from '../core/types';
import { Transport } from '../core/Transport';
import { FXChain } from './FXChain';
import { defaultFXRegistry, type FxNodeGraph } from './fx/FXRegistry';
import type { FXSnapshot } from './fx/FXBase';

import { RhythmEngine } from './RhythmEngine';
import type { IAudioEngine } from './AudioEngineInterface';
import { BrowserRealtimeRuntime, type BrowserRealtimeRuntimeMessage } from './BrowserRealtimeRuntime';
import {
    BROWSER_REALTIME_QUANTUM_FRAMES,
    BROWSER_REALTIME_SAMPLE_RATE,
    BROWSER_REALTIME_TRACK_COUNT,
    BROWSER_REALTIME_WORKLET_NAME,
    BROWSER_REALTIME_WORKLET_URL,
    CONTROL_TRACK_POSITIONS_BYTE_OFFSET,
    CONTROL_TRACK_STATES_BYTE_OFFSET,
    BrowserRealtimeOpcode,
    createControlSharedBuffer,
    type BrowserRealtimeMetrics,
} from './browserRealtimeProtocol';
import {
    getBrowserLatencyCalibration,
    setBrowserLatencyCalibration,
    type BrowserLatencyCalibration,
    type BrowserLatencyCalibrationScope,
} from './browserLatencyCalibration';
import type { ProjectFxBank, ProjectFxUnit, ProjectMixer } from '../project/projectTypes';
import { validateLoopEngineSettings, type LoopEngineSettings, type LoopEngineSettingsPatch } from './loopSettings';
import type { RhythmKitDocument, RhythmPatternDocument, RhythmRuntimeSnapshot } from './rhythmTypes';
import type { FxMidiInputEvent } from './nativeFxProtocol';
import { createEnabledFxParameters, selectContinuousFxParameter } from './fxParameterControls';
import {
    BrowserFxMidiQueueWriter,
    createBrowserFxMidiBuffer,
    isValidFxMidiInputEvent,
} from './browserFxMidiProtocol';
import {
    BrowserRoutingGraph,
    type BrowserRoutingState,
    type BrowserRoutingPatch,
    type BrowserRoutingSourceNode,
} from './browserRouting';
import {
    BROWSER_SHARED_DSP_MASTER_PROCESSOR_NAME,
    BROWSER_SHARED_DSP_MASTER_WORKLET_URL,
    BROWSER_SHARED_DSP_ROUTE_CAPABILITIES,
    BrowserSharedDspMasterBus,
    BrowserSharedDspGraph,
    loadBrowserSharedDspArtifact,
    completeSharedDspPrepareParameters,
    sharedDspFxOrdinal,
    sharedDspFxType,
    type SharedDspFilterRequest,
    type SharedDspFxBankPlan,
    type SharedDspFxCatalogEntry,
    type SharedDspFxUnitPlan,
    type SharedDspReply,
} from './sharedDspGraph';

export interface BrowserAudioLatencyInfo {
    sampleRate: number;
    baseLatencyMs: number | null;
    outputLatencyMs: number | null;
    inputLatencyMs: null;
    estimatedMonitoringLatencyMs: number | null;
    roundTripLatencyMs: number | null;
    inputLatencySource: null;
    outputLatencySource: string | null;
    driverReportedStreamLatencyMs: null;
    driverReportedStreamLatencySource: null;
    roundTripLatencyNote: string;
    xrunsOrDropouts: null;
}

export interface BrowserAudioIoSnapshot {
  contextSampleRate: number;
  contextBaseLatencyMs: number | null;
  contextOutputLatencyMs: number | null;
  loopRecordingChannelCount: 2;
  loopPlaybackOutputChannelCount: 2;
  loopChannelLayout: 'stereo planar LR; stereo input preserved and mono input duplicated to LR';
  inputDeviceId: string | null;
  inputLabel: string | null;
  inputSampleRate: number | null;
  inputChannelCount: number | null;
  inputLatencyMs: number | null;
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  outputDeviceId: string | null;
  outputLabel: string | null;
  outputSinkType: string | null;
  /** Added software delay for routing the rhythm bus back into recording inputs. */
  rhythmRoutingDelayFrames: number | null;
}

export interface BrowserAudioUiStatus {
    mode: 'browser';
    bridgeAvailable: boolean;
    engineRunning: boolean;
    ready: boolean;
    message: string;
    lastError: string;
}

export type FxBankLocation = 'input' | 'track' | 'output';

export interface FxStateSnapshot {
    activeBankId: string;
    banks: ProjectFxBank[];
}

export class BrowserAudioEngine implements IAudioEngine {
    public context: AudioContext;
    public workletNode: AudioWorkletNode | null = null;
    public tracks: TrackAudio[] = [];
    public sharedBuffer: SharedArrayBuffer | null = null;
    public trackStates: Int32Array | null = null; // State enum
    public trackPositions: Float32Array | null = null; // 0.0 to 1.0
    public roundTripLatency = 0; // Compatibility field; zero means no current measured calibration.
    public measuredRoundTripLatencyMs: number | null = null;
    public realtimeRuntime: BrowserRealtimeRuntime | null = null;
    public sharedDspGraph: BrowserSharedDspGraph | null = null;
    public masterFxWorkletNode: AudioWorkletNode | null = null;
    public readonly memorySettings = new MemorySettings();
    public projectMixer: ProjectMixer = {
        masterLevel: 1,
        tracks: Array.from({ length: 5 }, (_, index) => ({ trackId: index + 1, level: 1, pan: 0, muted: false, solo: false })),
    };
    public activeFxBankId = 'bank-1';
    public fxBanks: ProjectFxBank[] = Array.from({ length: 4 }, (_, index) => ({
        id: `bank-${index + 1}`,
        name: `Bank ${index + 1}`,
        input: [null, null, null, null],
        track: [null, null, null, null],
        output: [null, null, null, null],
    }));

    // ========================================
    // AUDIO I/O MANAGEMENT (CRITICAL SAFETY)
    // ========================================

    private currentInputStream: MediaStreamAudioSourceNode | null = null;
    private currentMediaStream: MediaStream | null = null;
    private monitorGainNode: GainNode | null = null;
    private currentInputSettings: MediaTrackSettings | null = null;
    private currentInputLabel: string | null = null;
    private currentOutputLabel: string | null = null;
    private currentCalibration: BrowserLatencyCalibration | null = null;
    private loopbackCaptureResolve: (() => void) | null = null;
    private routingGraph: BrowserRoutingGraph | null = null;
    private rhythmRouteDelay: DelayNode | null = null;
    private masterDspBus: BrowserSharedDspMasterBus | null = null;
    private sharedFxTransitionBuffer: SharedArrayBuffer | null = null;
    private sharedDspFxCatalog: SharedDspFxCatalogEntry[] = [];
    private sharedDspModuleSha256: string | null = null;
    private sharedDspLooperProcessorInstanceId: number | null = null;
    private sharedDspMasterProcessorInstanceId: number | null = null;
    private sharedDspLooperMidiQueue: BrowserFxMidiQueueWriter | null = null;
    private sharedDspMasterMidiQueue: BrowserFxMidiQueueWriter | null = null;
    private sharedDspFxCarrierControlBuffer: SharedArrayBuffer | null = null;
    private sharedDspFxCarrierControl: Int32Array | null = null;
    private sharedDspFxCarrierSource: AudioNode | null = null;
    private observedQuantumFrames: number | null = null;
    private readonly routingListeners = new Set<(state: BrowserRoutingState) => void>();

    // FX Chains & Mixing
    public inputFxChain: FXChain;
    public outputFxChain: FXChain;
    public trackMixNode: GainNode;
    public masterGainNode: GainNode;
    private inputBankSourceNode: GainNode;
    private inputBankReturnNode: GainNode;
    private trackBankSourceNode: GainNode;
    private trackBankReturnNode: GainNode;
    private outputBankSourceNode: GainNode;
    private outputBankReturnNode: GainNode;
    private fxGraphs: Record<FxBankLocation, FxNodeGraph | null> = { input: null, track: null, output: null };
    private readonly fxStateListeners = new Set<(state: FxStateSnapshot) => void>();
    private readonly trackFxSends = [false, false, false, false, false];
    private fxMutationQueue: Promise<void> = Promise.resolve();
    private pendingSharedFxFinalization: {
        inputStageId: number;
        masterStageId: number;
        allowUnrenderedFinalize: boolean;
    } | null = null;

    // Rhythm Engine
    public rhythmEngine: RhythmEngine;

    public selectedInputDeviceId: string | null = null;
    public selectedOutputDeviceId: string | null = null;
    public selectedBufferFrames: number = 128;
    public monitoringEnabled: boolean = false; // DEFAULT: FALSE to prevent feedback!
    private monitoringListeners = new Set<(enabled: boolean) => void>();
    private latencyListeners = new Set<(info: BrowserAudioLatencyInfo) => void>();
    private statusListeners = new Set<(status: BrowserAudioUiStatus) => void>();
    private initialized = false;
    private suppressTransportBpmCommand = false;
    private compressorFailure: Error | null = null;
    private lastError = '';
    private transportListenersInstalled = false;
    private suppressTransportMasterCommand = false;
    private suppressTransportStopCommand = false;

    private readonly handleTransportStart = () => {
        const runtime = this.realtimeRuntime;
        if (!runtime) return;
        void (async () => {
            const transport = Transport.getInstance();
            if (transport.masterTrackId !== null) {
                this.tracks[transport.masterTrackId - 1]?.syncMasterPlaybackSpeed();
            }
            // Start and phase-lock atomically. Separate SET_CLOCK and epoch
            // commands can be drained in different render callbacks.
            const epochAck = await runtime.setMasterClockEpoch(
                this.getTransportClockOrigin(transport, runtime),
                transport.bpm,
                undefined,
                true,
            );
            if (epochAck.status !== 0 && epochAck.status !== 1) {
                throw new Error(`Worklet rejected atomic transport start (status ${epochAck.status}).`);
            }
        })().catch((error) => this.recordRuntimeError(error));
    };
    private readonly handleTransportStop = () => {
        if (this.suppressTransportStopCommand) return;
        void this.realtimeRuntime?.setClock(false).catch((error) => this.recordRuntimeError(error));
    };
    private readonly handleTransportBpmChange = () => {
        if (this.suppressTransportBpmCommand) return;
        const runtime = this.realtimeRuntime;
        if (!runtime) return;
        const transport = Transport.getInstance();
        void (async () => {
            if (transport.hasMasterTrack()) {
                this.tracks[transport.masterTrackId! - 1]?.syncMasterPlaybackSpeed();
            }
            const epochAck = await runtime.setMasterClockEpoch(this.getTransportClockOrigin(transport, runtime), transport.bpm);
            if (epochAck.status !== 0 && epochAck.status !== 1) {
                throw new Error(`Worklet rejected BPM and phase update (status ${epochAck.status}).`);
            }
        })().catch((error) => this.recordRuntimeError(error));
    };
    private readonly handleTransportMasterChange = () => {
        if (this.suppressTransportMasterCommand) return;
        const transport = Transport.getInstance();
        if (transport.masterTrackId !== null) {
            this.tracks[transport.masterTrackId - 1]?.syncMasterPlaybackSpeed();
        }
        this.syncWorkletMasterEpoch();
    };

    public constructor() {
        this.context = new AudioContext({
            latencyHint: 'interactive',
            sampleRate: BROWSER_REALTIME_SAMPLE_RATE,
        });

        if (typeof SharedArrayBuffer !== 'undefined' && typeof window !== 'undefined' && window.crossOriginIsolated) {
            this.sharedBuffer = createControlSharedBuffer();
            this.trackStates = new Int32Array(this.sharedBuffer, CONTROL_TRACK_STATES_BYTE_OFFSET, BROWSER_REALTIME_TRACK_COUNT);
            this.trackPositions = new Float32Array(this.sharedBuffer, CONTROL_TRACK_POSITIONS_BYTE_OFFSET, BROWSER_REALTIME_TRACK_COUNT);
        }

        // Create monitor gain node (for software monitoring)
        this.monitorGainNode = this.context.createGain();
        this.monitorGainNode.gain.value = 1; // The worklet gates monitoring at the target sample; silence is its default.

        // Initialize FX Chains & Mixing
        this.inputFxChain = new FXChain(this.context);
        this.outputFxChain = new FXChain(this.context);
        this.trackMixNode = this.context.createGain();
        this.masterGainNode = this.context.createGain();
        this.monitorGainNode.connect(this.masterGainNode);
        this.inputBankSourceNode = this.context.createGain();
        this.inputBankReturnNode = this.context.createGain();
        this.trackBankSourceNode = this.context.createGain();
        this.trackBankReturnNode = this.context.createGain();
        this.outputBankSourceNode = this.context.createGain();
        this.outputBankReturnNode = this.context.createGain();

        // Stable route anchors let bank graphs swap without disconnecting FXChain's
        // owned edges or any unrelated source fan-out.
        this.trackMixNode.connect(this.outputFxChain.input);
        this.outputFxChain.output.connect(this.outputBankSourceNode);
        this.outputBankSourceNode.connect(this.outputBankReturnNode);
        this.outputBankReturnNode.connect(this.masterGainNode);
        this.inputFxChain.output.connect(this.inputBankSourceNode);
        this.inputBankSourceNode.connect(this.inputBankReturnNode);
        this.trackBankSourceNode.connect(this.trackBankReturnNode);
        this.trackBankReturnNode.connect(this.trackMixNode);

        // Initialize Rhythm Engine
        this.rhythmEngine = new RhythmEngine(this.context);
        this.rhythmEngine.connect(this.masterGainNode);

        // Initialize 5 tracks
        for (let i = 0; i < 5; i++) {
            const trackData = this.memorySettings.tracks[i] ?? new Track(i + 1);
            this.tracks.push(new TrackAudio(this, trackData, i, this.trackStates, this.trackPositions));
        }
        this.tracks.forEach((track, index) => {
            if (track.track.fxSw === 'ON') {
                track.outputNode.disconnect(this.trackMixNode);
                track.outputNode.connect(this.trackBankSourceNode);
                this.trackFxSends[index] = true;
            }
        });

        const compressorFailureHandler = (error: Error) => {
            this.compressorFailure = error;
            this.lastError = `Compressor AudioWorklet failed and the affected FX chain is in dry bypass: ${error.message}`;
            this.emitStatus();
        };
        for (const chain of this.getFxChains()) {
            chain.onProcessorError = compressorFailureHandler;
        }

        // Load saved device preferences
        this.loadDevicePreferences();
    }

    public async init() {
        if (this.initialized) return;
        try {
            if (typeof SharedArrayBuffer === 'undefined' || typeof window === 'undefined' || !window.crossOriginIsolated) {
                throw new Error('Browser realtime audio requires cross-origin isolation. Serve with COOP: same-origin and COEP: require-corp headers.');
            }
            if (this.context.sampleRate >= 96_000) {
                throw new Error('96 kHz browser audio is gated until the real-time path has been qualified at that rate.');
            }
            if (this.context.sampleRate !== BROWSER_REALTIME_SAMPLE_RATE) {
                throw new Error(`Browser realtime audio requires a ${BROWSER_REALTIME_SAMPLE_RATE} Hz AudioContext; this device opened at ${this.context.sampleRate} Hz.`);
            }
            if (!this.sharedBuffer) {
                this.sharedBuffer = createControlSharedBuffer();
                this.trackStates = new Int32Array(this.sharedBuffer, CONTROL_TRACK_STATES_BYTE_OFFSET, BROWSER_REALTIME_TRACK_COUNT);
                this.trackPositions = new Float32Array(this.sharedBuffer, CONTROL_TRACK_POSITIONS_BYTE_OFFSET, BROWSER_REALTIME_TRACK_COUNT);
            }
            if (!this.sharedDspLooperMidiQueue) {
                this.sharedDspLooperMidiQueue = new BrowserFxMidiQueueWriter(createBrowserFxMidiBuffer());
                this.sharedDspMasterMidiQueue = new BrowserFxMidiQueueWriter(createBrowserFxMidiBuffer());
                this.sharedDspFxCarrierControlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
                this.sharedDspFxCarrierControl = new Int32Array(this.sharedDspFxCarrierControlBuffer);
            }

            // A newly-created or previously used context can already be
            // running under a user gesture. Stop its render thread before the
            // first shared-DSP module/Worklet preparation; playback resumes
            // only after the processor reports SHARED_DSP_READY.
            if (!this.workletNode && this.context.state === 'running') await this.context.suspend();
            const sharedDspArtifact = await loadBrowserSharedDspArtifact();
            await this.context.audioWorklet.addModule(BROWSER_REALTIME_WORKLET_URL);
            await this.context.audioWorklet.addModule(BROWSER_SHARED_DSP_MASTER_WORKLET_URL);
            await Promise.all(this.getFxChains().map((chain) => chain.initialize()));

            if (!this.workletNode || !this.realtimeRuntime) {
                this.observedQuantumFrames = null;
                const controlBuffer = this.sharedBuffer;
                this.sharedFxTransitionBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
                const workletNode = new AudioWorkletNode(this.context, BROWSER_REALTIME_WORKLET_NAME, {
                    // Input 0 is the global monitor/reference feed; ports 1..5
                    // carry each track's independently routed record source.
                    // Input 0 is the global monitor/reference feed, ports 1..5
                    // carry per-track recording, and port 6 is an optional
                    // independent stereo carrier for VOCODER FX.
                    numberOfInputs: BROWSER_REALTIME_TRACK_COUNT + 2,
                    numberOfOutputs: 7,
                    outputChannelCount: [2, 2, 2, 2, 2, 2, 2],
                    channelCount: 2,
                    // Preserve the connected source's actual channel count.
                    // VOCODER routing validates the observed Worklet input
                    // channels and must reject mono instead of silently
                    // upmixing it to a two-channel carrier.
                    channelCountMode: 'clamped-max',
                    processorOptions: {
                        controlBuffer,
                        fxTransitionBuffer: this.sharedFxTransitionBuffer,
                        perTrackInputs: true,
                        sharedDspModule: sharedDspArtifact.module,
                        sharedDspMaxBlockFrames: 4096,
                        fxMidiBuffer: this.sharedDspLooperMidiQueue.buffer,
                        fxCarrierControl: this.sharedDspFxCarrierControlBuffer,
                        trackFxSendMask: this.tracks.map((track) => track.track.fxSw === 'ON'),
                    },
                });
                const sharedDspReady = await this.waitForSharedDspReady(workletNode);
                this.sharedDspModuleSha256 = sharedDspArtifact.sha256;
                this.sharedDspLooperProcessorInstanceId = Number.isInteger(sharedDspReady.processorInstanceId)
                    ? sharedDspReady.processorInstanceId as number : null;
                this.sharedDspFxCatalog = Array.isArray(sharedDspReady.availableFxCatalog)
                    ? sharedDspReady.availableFxCatalog as SharedDspFxCatalogEntry[]
                    : [];
                this.workletNode = workletNode;
                this.sharedDspGraph = new BrowserSharedDspGraph(workletNode.port);
                this.sharedDspGraph.markReady();
                this.realtimeRuntime = new BrowserRealtimeRuntime(workletNode, controlBuffer, this.context.sampleRate);
                this.realtimeRuntime.setMessageHandler((message) => {
                    this.sharedDspGraph?.receive(message as SharedDspReply);
                    this.handleRuntimeMessage(message);
                });

                this.inputBankReturnNode.connect(workletNode, 0, 0);
                for (let track = 0; track < this.tracks.length; track += 1) {
                    workletNode.connect(this.tracks[track]!.fxChain.input, track, 0);
                }
                workletNode.connect(this.monitorGainNode!, 5, 0);
                workletNode.connect(this.rhythmEngine.outputNode, 6, 0);
                this.rhythmRouteDelay = this.context.createDelay(1);
                this.rhythmRouteDelay.delayTime.value = BROWSER_REALTIME_QUANTUM_FRAMES / this.context.sampleRate;
                workletNode.connect(this.rhythmRouteDelay, 6, 0);
                const masterFxNode = new AudioWorkletNode(this.context, BROWSER_SHARED_DSP_MASTER_PROCESSOR_NAME, {
                    numberOfInputs: 2,
                    numberOfOutputs: 1,
                    outputChannelCount: [2],
                    channelCount: 2,
                    // Keep mono external carriers observable as mono so the
                    // Worklet can fail closed instead of accepting WebAudio's
                    // explicit-mode zero-filled right-channel upmix.
                    channelCountMode: 'clamped-max',
                    processorOptions: {
                        sharedDspModule: sharedDspArtifact.module,
                        maxBlockFrames: 4096,
                        fxTransitionBuffer: this.sharedFxTransitionBuffer,
                        fxMidiBuffer: this.sharedDspMasterMidiQueue!.buffer,
                        fxCarrierControl: this.sharedDspFxCarrierControlBuffer,
                    },
                });
                const masterDspReady = await this.waitForMasterDspReady(masterFxNode);
                this.masterFxWorkletNode = masterFxNode;
                this.sharedDspMasterProcessorInstanceId = Number.isInteger(masterDspReady.processorInstanceId)
                    ? masterDspReady.processorInstanceId as number : null;
                this.masterDspBus = new BrowserSharedDspMasterBus(masterFxNode.port);
                this.masterDspBus.markReady();
                masterFxNode.port.onmessage = (event) => this.masterDspBus?.receive(event.data as SharedDspReply);
                this.masterGainNode.connect(masterFxNode);
                if (this.sharedDspFxCarrierSource) this.connectFxCarrierSourceToWorklets(this.sharedDspFxCarrierSource);
                this.routingGraph = new BrowserRoutingGraph(this.context, workletNode, masterFxNode);
                await this.routingGraph.setInputFxSnapshots(this.getInputFxSnapshots());
                await this.routingGraph.setSource({
                    id: 'rhythm', node: this.rhythmRouteDelay, label: 'Rhythm engine', kind: 'rhythm', channelCount: 2,
                    routingDelayFrames: BROWSER_REALTIME_QUANTUM_FRAMES,
                }, 'rhythm');
                this.routingGraph.subscribe((state) => this.routingListeners.forEach((listener) => listener(state)));
                if (this.context.state === 'suspended') await this.context.resume();
                await this.realtimeRuntime.prepareAllTracks();
                this.rhythmEngine.setRealtimeControl((running, pattern, preserveCustomPattern) => {
                    void this.realtimeRuntime?.setRhythm(running, pattern, undefined, preserveCustomPattern)
                        .catch((error) => this.recordRuntimeError(error));
                });
            }

            if (this.context.state === 'suspended') await this.context.resume();

            if (this.selectedOutputDeviceId) {
                await this.setOutputDevice(this.selectedOutputDeviceId);
            }

            await this.setInputDevice(this.selectedInputDeviceId || '');
            this.installTransportListeners();

            await this.realtimeRuntime.enqueue(
                BrowserRealtimeOpcode.SET_MONITOR,
                -1,
                this.monitoringEnabled ? 1 : 0,
                0,
                this.realtimeRuntime.getImmediateTargetFrame(),
            );

            const transport = Transport.getInstance();
            const epochAck = await this.realtimeRuntime.setMasterClockEpoch(
                this.getTransportClockOrigin(transport, this.realtimeRuntime),
                transport.bpm,
                undefined,
                transport.state === TransportState.PLAYING,
            );
            if (epochAck.status !== 0 && epochAck.status !== 1) {
                throw new Error(`Worklet rejected transport clock restore (status ${epochAck.status}).`);
            }
            void this.realtimeRuntime.setRhythm(this.rhythmEngine.isRunning, this.rhythmEngine.patternIndex)
                .catch((error) => this.recordRuntimeError(error));

            this.initialized = true;
            this.lastError = '';
            this.syncCurrentCalibration();
            this.emitLatencyInfo();
            this.emitStatus();
        } catch (error) {
            this.initialized = false;
            this.lastError = error instanceof Error ? error.message : String(error);
            this.emitStatus();
            throw error;
        }
    }

    // ========================================
    // DEVICE ENUMERATION
    // ========================================

    /**
     * Get list of available audio input and output devices
     */
    public async getDevices(): Promise<{ inputs: MediaDeviceInfo[], outputs: MediaDeviceInfo[] }> {
        try {
            // Request permissions first
            const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            const devices = await navigator.mediaDevices.enumerateDevices();
            permissionStream.getTracks().forEach(track => track.stop());

            const inputs = devices.filter(d => d.kind === 'audioinput');
            const outputs = devices.filter(d => d.kind === 'audiooutput');

            console.log(`Found ${inputs.length} input devices, ${outputs.length} output devices`);

            await this.routingGraph?.setAvailableSinks(outputs);
            return { inputs, outputs };
        } catch (error) {
            console.error('Failed to enumerate devices:', error);
            return { inputs: [], outputs: [] };
        }
    }

    // ========================================
    // INPUT DEVICE MANAGEMENT
    // ========================================

    /**
     * Set input device (microphone)
     * SAFETY: Automatically disconnects old stream to prevent feedback
     */
    public setInputDevice(deviceId: string, projectToken?: symbol): Promise<void> {
        return this.runFxMutation(() => this.applyInputDevice(deviceId), projectToken);
    }

    private async applyInputDevice(deviceId: string): Promise<void> {
        console.log(`\n?? Switching input device to: ${deviceId}`);

        try {
            const stream = await this.requestInputStream(deviceId);
            await this.replaceInputStream(stream, deviceId || null);
            this.selectedInputDeviceId = this.currentInputSettings?.deviceId || deviceId || null;
            this.saveDevicePreferences();
            this.syncCurrentCalibration();

            console.log('  ? New input device connected');
            console.log(`  ??  Monitoring: ${this.monitoringEnabled ? 'ENABLED' : 'DISABLED (SAFE)'}\n`);

        } catch (error) {
            if (deviceId && this.shouldFallbackToDefaultInput(error)) {
                console.warn('  Requested input device is unavailable or overconstrained. Falling back to the default microphone.');
                try {
                    const fallbackStream = await this.requestInputStream('');
                    await this.replaceInputStream(fallbackStream, null);
                    this.selectedInputDeviceId = null;
                    this.saveDevicePreferences();
                    this.syncCurrentCalibration();
                    console.log('  ? Default input device connected');
                    this.emitLatencyInfo();
                    this.emitStatus();
                    return;
                } catch (fallbackError) {
                    console.error('Failed to set default input device after fallback:', fallbackError);
                    throw fallbackError;
                }
            }
            console.error('Failed to set input device:', error);
            throw error;
        }

        this.monitoringListeners.forEach(listener => listener(this.monitoringEnabled));
        this.emitLatencyInfo();
    }

    // ========================================
    // OUTPUT DEVICE MANAGEMENT
    // ========================================

    /**
     * Set output device (speakers/headphones)
     */
    public setOutputDevice(deviceId: string, projectToken?: symbol): Promise<void> {
        return this.runFxMutation(() => this.applyOutputDevice(deviceId), projectToken);
    }

    private async applyOutputDevice(deviceId: string): Promise<void> {
        console.log(`\n?? Switching output device to: ${deviceId}`);

        try {
            const contextWithSink = this.context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
            if (typeof contextWithSink.setSinkId !== 'function') {
                throw new Error('This browser does not support selecting an AudioContext output device.');
            }
            await contextWithSink.setSinkId(deviceId);
            this.selectedOutputDeviceId = deviceId || null;
            const devices = await navigator.mediaDevices.enumerateDevices();
            this.currentOutputLabel = devices.find((device) => device.kind === 'audiooutput' && device.deviceId === deviceId)?.label || null;
            this.saveDevicePreferences();
            this.syncCurrentCalibration();
            if (this.routingGraph) {
                const state = this.routingGraph.getState();
                state.outputs.main.sinkId = this.selectedOutputDeviceId;
                await this.routingGraph.applyState(state);
            }
            console.log('  ? Output device changed\n');
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

    public getFxState(): FxStateSnapshot {
        return { activeBankId: this.activeFxBankId, banks: structuredClone(this.fxBanks) };
    }

    public getRoutingState(): BrowserRoutingState {
        if (!this.routingGraph) throw new Error('Initialize browser audio before reading routing state.');
        return this.routingGraph.getState();
    }

    public subscribeRoutingState(listener: (state: BrowserRoutingState) => void): () => void {
        this.routingListeners.add(listener);
        if (this.routingGraph) listener(this.routingGraph.getState());
        return () => this.routingListeners.delete(listener);
    }

    public updateRoutingState(patch: BrowserRoutingPatch, projectToken?: symbol): Promise<void> {
        if (!this.routingGraph) throw new Error('Initialize browser audio before changing routing.');
        return this.runFxMutation(async () => {
            const previous = this.routingGraph!.getState();
            const nextMainSink = patch.outputs?.main && Object.prototype.hasOwnProperty.call(patch.outputs.main, 'sinkId')
                ? patch.outputs.main.sinkId ?? ''
                : null;
            try {
                if (nextMainSink !== null && nextMainSink !== this.selectedOutputDeviceId) await this.applyOutputDevice(nextMainSink);
                await this.routingGraph!.applyPatch(patch);
            } catch (error) {
                if (this.selectedOutputDeviceId !== previous.outputs.main.sinkId) {
                    try { await this.applyOutputDevice(previous.outputs.main.sinkId ?? ''); }
                    catch (rollbackError) { this.recordRuntimeError(rollbackError); throw error; }
                }
                throw error;
            }
        }, projectToken);
    }

    public applyRoutingStateForProject(state: BrowserRoutingState, token: symbol): Promise<void> {
        if (!this.routingGraph) throw new Error('Initialize browser audio before restoring routing.');
        return this.runFxMutation(async () => {
            const previous = this.routingGraph!.getState();
            try {
                if (state.outputs.main.sinkId !== this.selectedOutputDeviceId) await this.applyOutputDevice(state.outputs.main.sinkId ?? '');
                await this.routingGraph!.applyState(state);
            } catch (error) {
                if (this.selectedOutputDeviceId !== previous.outputs.main.sinkId) {
                    try { await this.applyOutputDevice(previous.outputs.main.sinkId ?? ''); }
                    catch (rollbackError) { this.recordRuntimeError(rollbackError); throw error; }
                }
                throw error;
            }
        }, token);
    }

    public resetRoutingStateForProject(token: symbol): Promise<void> {
        if (!this.routingGraph) throw new Error('Initialize browser audio before resetting routing.');
        return this.runFxMutation(() => this.routingGraph!.resetState(), token);
    }

    public getFxBanks(): ProjectFxBank[] { return structuredClone(this.fxBanks); }
    public getActiveFxBankId(): string { return this.activeFxBankId; }
    public getAvailableFxTypes(): string[] {
        return [...defaultFXRegistry.getTypes(), ...this.sharedDspFxCatalog.map((entry) => sharedDspFxType(entry.ordinal))];
    }

    public getSharedDspFxCatalog(): SharedDspFxCatalogEntry[] {
        return structuredClone(this.sharedDspFxCatalog);
    }

    public subscribeFxState(listener: (state: FxStateSnapshot) => void): () => void {
        this.fxStateListeners.add(listener);
        listener(this.getFxState());
        return () => this.fxStateListeners.delete(listener);
    }

    public selectFxBank(id: string): Promise<void> {
        return this.runFxMutation(async () => {
            const bank = this.fxBanks.find((candidate) => candidate.id === id);
            if (!bank) throw new RangeError(`FX bank ${id} does not exist.`);
            if (id === this.activeFxBankId) return;
            await this.installFxBankState(this.fxBanks, id);
        });
    }

    public async applyFxBankStateForProject(
        banks: ProjectFxBank[],
        activeBankId: string,
        token: symbol,
    ): Promise<void> {
        if (!this.initialized || !this.realtimeRuntime || typeof token !== 'symbol') {
            throw new Error('Project FX state requires initialized browser audio and the project lock token.');
        }
        if (!Array.isArray(banks) || banks.length !== 4 || new Set(banks.map((bank) => bank.id)).size !== 4) {
            throw new TypeError('Project FX state must contain four uniquely named banks.');
        }
        const normalizedBanks = banks.map((bank) => {
            if (!bank || typeof bank.id !== 'string' || typeof bank.name !== 'string') throw new TypeError('Project FX bank metadata is invalid.');
            const normalized = { ...bank } as ProjectFxBank;
            for (const location of ['input', 'track', 'output'] as const) {
                if (!Array.isArray(bank[location]) || bank[location].length !== 4) throw new TypeError(`Project FX ${location} bank must have four slots.`);
                normalized[location] = bank[location].map((slot) => this.validateFxUnit(slot));
            }
            return normalized;
        });
        const active = normalizedBanks.find((bank) => bank.id === activeBankId);
        if (!active) throw new TypeError(`Active project FX bank ${activeBankId} is missing.`);

        return await this.runFxMutation(async () => {
            await this.installFxBankState(normalizedBanks, activeBankId);
        }, token);
    }

    public updateFxBankSlot(location: FxBankLocation, index: number, slot: ProjectFxUnit | null, projectToken?: symbol): Promise<void> {
        const requestedBankId = this.activeFxBankId;
        return this.runFxMutation(async () => {
            if (!['input', 'track', 'output'].includes(location)) throw new TypeError('FX bank location is invalid.');
            if (!Number.isInteger(index) || index < 0 || index >= 4) throw new RangeError('FX slot index must be from 0 through 3.');
            if (requestedBankId !== this.activeFxBankId) throw new Error('Active FX bank changed before the slot update could be applied. Refresh the selected bank and retry.');
            const bankIndex = this.fxBanks.findIndex((candidate) => candidate.id === requestedBankId);
            const bank = this.fxBanks[bankIndex];
            if (!bank) throw new Error(`Active FX bank ${this.activeFxBankId} is missing.`);
            const normalized = this.validateFxUnit(slot);
            const previousUnit = bank[location][index] ?? null;
            const updated: ProjectFxBank = {
                ...bank,
                [location]: bank[location].map((current, slotIndex) => slotIndex === index ? normalized : current),
            };

            if (isSharedDspUnit(previousUnit) || isSharedDspUnit(normalized)) {
                const nextBanks = [...this.fxBanks];
                nextBanks[bankIndex] = updated;
                await this.installFxBankState(nextBanks, requestedBankId);
                return;
            }

            const canUpdateInPlace = previousUnit !== null && normalized !== null &&
                previousUnit.type.toUpperCase() === normalized.type.toUpperCase();
            const previousGraph = this.fxGraphs[location];
            let stagedGraph: FxNodeGraph | null = null;
            let inPlaceEffect: FxNodeGraph['effects'][number] | null = null;
            let inPlaceSnapshot: FXSnapshot | null = null;
            let graphWasReplaced = false;
            let mutatedInPlace = false;
            if (canUpdateInPlace) {
                const effectIndex = bank[location].slice(0, index).filter((item) => item !== null).length;
                const effect = this.fxGraphs[location]?.effects[effectIndex];
                if (!effect) throw new Error(`Live ${location} FX graph is missing slot ${index}.`);
                inPlaceEffect = effect;
                inPlaceSnapshot = effect.getSnapshot();
                try {
                    effect.applySnapshot(normalized as FXSnapshot);
                    mutatedInPlace = true;
                } catch (error) {
                    try { effect.applySnapshot(inPlaceSnapshot); }
                    catch (rollbackError) {
                        const wrapped = new Error(`FX ${location} slot update failed and its live effect could not be restored.`);
                        Object.assign(wrapped, { cause: error, rollbackErrors: [rollbackError] });
                        throw wrapped;
                    }
                    throw error;
                }
            } else {
                stagedGraph = await this.createBankGraph(updated[location]);
                try { this.replaceOneBankGraph(location, stagedGraph); }
                catch (error) {
                    stagedGraph.dispose();
                    throw error;
                }
                graphWasReplaced = true;
            }

            const nextBanks = [...this.fxBanks];
            nextBanks[bankIndex] = updated;
            this.fxBanks = nextBanks;
            try {
                if (location === 'input') await this.routingGraph?.setInputFxSnapshots(this.getInputFxSnapshots());
            } catch (error) {
                const rollbackErrors: unknown[] = [];
                this.fxBanks = this.fxBanks.map((candidate, candidateIndex) => candidateIndex === bankIndex ? bank : candidate);
                if (graphWasReplaced) {
                    try { this.replaceOneBankGraph(location, previousGraph); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
                }
                if (mutatedInPlace && inPlaceEffect && inPlaceSnapshot) {
                    try { inPlaceEffect.applySnapshot(inPlaceSnapshot); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
                }
                if (location === 'input') {
                    try { await this.routingGraph?.setInputFxSnapshots(this.getInputFxSnapshots()); }
                    catch (rollbackError) { rollbackErrors.push(rollbackError); }
                }
                if (stagedGraph && graphWasReplaced && this.fxGraphs[location] !== stagedGraph) stagedGraph.dispose();
                if (rollbackErrors.length > 0) {
                    const rollbackError = new Error(`FX ${location} slot update failed and rollback was incomplete.`);
                    Object.assign(rollbackError, { cause: error, rollbackErrors });
                    throw rollbackError;
                }
                throw error;
            }
            if (graphWasReplaced) previousGraph?.dispose();
            this.publishFxState();
        }, projectToken);
    }

    private async installFxBankState(nextBanks: ProjectFxBank[], nextActiveBankId: string): Promise<void> {
        const nextActiveBank = nextBanks.find((bank) => bank.id === nextActiveBankId);
        if (!nextActiveBank) throw new Error(`FX bank ${nextActiveBankId} is missing.`);
        for (const location of ['input', 'track', 'output'] as const) {
            assertOneFxBackendPerBankRoute(nextActiveBank[location]);
        }
        if (!this.sharedDspGraph || !this.masterDspBus || !this.realtimeRuntime || !this.routingGraph) {
            throw new Error('Shared DSP FX bank requires the prepared Browser Worklets.');
        }
        await this.retryPendingSharedFxFinalization();

        const previousBanks = this.fxBanks;
        const previousActiveBankId = this.activeFxBankId;
        const previousGraphs = { ...this.fxGraphs };
        const previousInputSnapshots = this.getInputFxSnapshots(previousBanks.find((bank) => bank.id === previousActiveBankId));
        const runningBeforeInstall = this.context.state === 'running';
        let stagedGraphs: Record<FxBankLocation, FxNodeGraph> | null = null;
        let graphsInstalled = false;
        let inputStageId: number | null = null;
        let masterStageId: number | null = null;
        let inputWarmupFrames = 0;
        let masterWarmupFrames = 0;
        let inputCommitted = false;
        let masterCommitted = false;
        let statePublished = false;
        let failure: unknown;

        try {
            if (runningBeforeInstall) await this.context.suspend();
            if (this.context.state === 'running') throw new Error('AudioContext must be suspended before preparing an FX bank replacement.');

            stagedGraphs = await this.createBankGraphs(nextActiveBank);
            const plan = this.sharedDspPlanForBank(nextActiveBank);
            const stageResults = await Promise.allSettled([
                this.sharedDspGraph.stageFxBankPlan(plan),
                this.masterDspBus.stageFxBankPlan(plan.output),
            ]);
            if (stageResults[0]?.status === 'fulfilled') {
                inputStageId = Number(stageResults[0].value.stageId);
                inputWarmupFrames = this.readStagedWarmupFrames(stageResults[0].value, 'input/track');
            }
            if (stageResults[1]?.status === 'fulfilled') {
                masterStageId = Number(stageResults[1].value.stageId);
                masterWarmupFrames = this.readStagedWarmupFrames(stageResults[1].value, 'master');
            }
            const stageFailure = stageResults.find((result) => result.status === 'rejected');
            if (stageFailure?.status === 'rejected') throw stageFailure.reason;
            if (inputStageId === null || masterStageId === null ||
                !Number.isSafeInteger(inputStageId) || !Number.isSafeInteger(masterStageId)) {
                throw new Error('Shared DSP Worklets did not return both staged bank tokens.');
            }

            this.replaceBankGraphs(stagedGraphs);
            graphsInstalled = true;
            await this.routingGraph.setInputFxSnapshots(this.getInputFxSnapshots(nextActiveBank));

            await this.sharedDspGraph.commitFxBankPlan(inputStageId, !runningBeforeInstall);
            inputCommitted = true;
            if (runningBeforeInstall) {
                // Let the new input/track graph warm and finish its fade first.
                await this.context.resume();
                await this.waitForSharedFxTransition([0], this.fxTransitionTimeoutMs(inputWarmupFrames));
            }

            // The master candidate only starts consuming live frames after
            // the Looper bank has finished its own warmup and fade.
            await this.masterDspBus.commitFxBankPlan(masterStageId, !runningBeforeInstall);
            masterCommitted = true;
            if (runningBeforeInstall) {
                await this.waitForSharedFxTransition([1], this.fxTransitionTimeoutMs(masterWarmupFrames));
                await this.context.suspend();
            }

            this.fxBanks = nextBanks;
            this.activeFxBankId = nextActiveBankId;
            statePublished = true;
            this.publishFxState();
            stagedGraphs = null;
        } catch (error) {
            failure = error;
            const cleanupErrors: unknown[] = [];
            if ((inputCommitted || masterCommitted) && this.context.state === 'running') {
                try { await this.context.suspend(); }
                catch (suspendError) { cleanupErrors.push(suspendError); }
            }
            if (inputCommitted && inputStageId !== null) {
                try { await this.sharedDspGraph.rollbackFxBankPlan(inputStageId); }
                catch (rollbackError) { cleanupErrors.push(rollbackError); }
            } else if (inputStageId !== null) {
                try { await this.sharedDspGraph.abortFxBankPlan(inputStageId); }
                catch (abortError) { cleanupErrors.push(abortError); }
            }
            if (masterCommitted && masterStageId !== null) {
                try { await this.masterDspBus.rollbackFxBankPlan(masterStageId); }
                catch (rollbackError) { cleanupErrors.push(rollbackError); }
            } else if (masterStageId !== null) {
                try { await this.masterDspBus.abortFxBankPlan(masterStageId); }
                catch (abortError) { cleanupErrors.push(abortError); }
            }
            if (graphsInstalled) {
                try { this.replaceBankGraphs(previousGraphs); }
                catch (rollbackError) { cleanupErrors.push(rollbackError); }
            }
            if (statePublished) {
                this.fxBanks = previousBanks;
                this.activeFxBankId = previousActiveBankId;
            }
            try { await this.routingGraph.setInputFxSnapshots(previousInputSnapshots); }
            catch (rollbackError) { cleanupErrors.push(rollbackError); }
            if (stagedGraphs) this.disposeGraphs(stagedGraphs);
            if (cleanupErrors.length > 0) {
                const rollbackFailure = new Error('FX bank update failed and one or more previous routes could not be restored.');
                Object.assign(rollbackFailure, { cause: error, rollbackErrors: cleanupErrors });
                failure = rollbackFailure;
            }
        }
        if (failure !== undefined) {
            if (runningBeforeInstall && this.context.state === 'suspended') {
                try { await this.context.resume(); }
                catch (resumeError) { this.recordRuntimeError(resumeError); }
            }
            throw failure;
        }
        if (inputStageId !== null && masterStageId !== null) {
            if (this.context.state === 'suspended') {
                await this.finalizeSharedFxStagePair({
                    inputStageId, masterStageId, allowUnrenderedFinalize: !runningBeforeInstall,
                });
            }
        }
        if (runningBeforeInstall && this.context.state === 'suspended') {
            try { await this.context.resume(); }
            catch (resumeError) {
                // The bank is already committed and both Worklets have
                // published it. A failed resume is a runtime fault, not a
                // failed transaction that the caller can safely roll back.
                this.recordRuntimeError(resumeError);
            }
        }
        for (const graph of Object.values(previousGraphs)) graph?.dispose();
        if (failure !== undefined) throw failure;
    }

    private async finalizeSharedFxStagePair(pending: {
        inputStageId: number;
        masterStageId: number;
        allowUnrenderedFinalize: boolean;
    }): Promise<boolean> {
        const requestBoth = () => Promise.allSettled([
            this.sharedDspGraph!.finalizeFxBankPlan(pending.inputStageId, pending.allowUnrenderedFinalize),
            this.masterDspBus!.finalizeFxBankPlan(pending.masterStageId, pending.allowUnrenderedFinalize),
        ]);
        let results = await requestBoth();
        let failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
            // Worklet finalization is idempotent by stage token. A missing ACK
            // after one side released its retired chain can therefore be
            // retried without undoing or re-publishing the committed bank.
            results = await requestBoth();
            failure = results.find((result) => result.status === 'rejected');
        }
        if (failure?.status === 'rejected') {
            this.pendingSharedFxFinalization = pending;
            this.recordRuntimeError(Object.assign(
                new Error('The new FX bank is active, but retired DSP resources remain pending cleanup.'),
                { cause: failure.reason },
            ));
            return false;
        }
        this.pendingSharedFxFinalization = null;
        return true;
    }

    private async retryPendingSharedFxFinalization(): Promise<void> {
        const pending = this.pendingSharedFxFinalization;
        if (!pending) return;
        const wasRunning = this.context.state === 'running';
        if (wasRunning) await this.context.suspend();
        try {
            if (this.context.state === 'running') {
                throw new Error('AudioContext must be suspended before retrying retired FX cleanup.');
            }
            if (!await this.finalizeSharedFxStagePair(pending)) {
                throw new Error('The previous FX bank is committed, but retired DSP cleanup is still pending.');
            }
        } finally {
            if (wasRunning && this.context.state === 'suspended') await this.context.resume();
        }
    }

    private readStagedWarmupFrames(reply: SharedDspReply, route: string): number {
        const warmupFrames = reply.warmupFrames;
        if (typeof warmupFrames !== 'number' || !Number.isSafeInteger(warmupFrames) ||
            warmupFrames < 0 || warmupFrames > 0xffff_ffff) {
            throw new Error(`Shared DSP ${route} stage did not report its prepared startup warmup.`);
        }
        return warmupFrames;
    }

    private fxTransitionTimeoutMs(warmupFrames: number): number {
        const sampleRate = this.context.sampleRate;
        if (!Number.isSafeInteger(warmupFrames) || warmupFrames < 0 ||
            !Number.isFinite(sampleRate) || sampleRate <= 0) {
            throw new Error('Shared DSP startup warmup cannot be converted into a render deadline.');
        }
        const fadeFrames = Math.max(1, Math.round(sampleRate * 0.01));
        // Allow two render-time passes for the actual serial warmup + 10 ms
        // fade, plus one second for message/task scheduling. Long-history FX
        // therefore receive a matching host wait instead of a fixed timeout.
        return Math.ceil(((warmupFrames + fadeFrames) * 2_000) / sampleRate + 1_000);
    }

    private async waitForSharedFxTransition(indices: readonly (0 | 1)[], timeoutMs: number): Promise<void> {
        const buffer = this.sharedFxTransitionBuffer;
        if (!buffer) throw new Error('Shared DSP transition status is unavailable.');
        const words = new Int32Array(buffer);
        const deadline = Date.now() + timeoutMs;
        while (true) {
            for (const index of indices) {
                if (Atomics.load(words, index) < 0) {
                    throw new Error(`Shared DSP FX candidate failed while warming or rendering route ${index}.`);
                }
            }
            if (!indices.some((index) => Atomics.load(words, index) > 0)) break;
            if (this.context.state !== 'running') throw new Error('AudioContext stopped before the selected FX replacement fade completed.');
            if (Date.now() >= deadline) throw new Error('Shared DSP FX replacement fade did not complete in the render thread.');
            await new Promise<void>((resolve) => setTimeout(resolve, 2));
        }
    }

    private sharedDspPlanForBank(bank: ProjectFxBank): SharedDspFxBankPlan {
        const planFor = (location: FxBankLocation): SharedDspFxUnitPlan[] => bank[location]
            .filter((unit): unit is ProjectFxUnit => unit !== null && unit.enabled && isSharedDspUnit(unit))
            .map((unit) => {
                const ordinal = sharedDspFxOrdinal(unit.type)!;
                const parameters = Object.entries(unit.params).map(([id, value]) => ({ id: Number(id), value }));
                return {
                    ordinal,
                    parameters: completeSharedDspPrepareParameters(ordinal, parameters, this.sharedDspFxCatalog),
                };
            });
        return { input: planFor('input'), track: planFor('track'), output: planFor('output') };
    }

    public setTrackFxSend(trackId: number, enabled: boolean, projectToken?: symbol): Promise<void> {
        return this.runFxMutation(async () => {
            if (!Number.isInteger(trackId) || trackId < 1 || trackId > this.tracks.length) {
                throw new RangeError('Track FX send must target a track from 1 through 5.');
            }
            const index = trackId - 1;
            const track = this.tracks[index];
            if (!track) throw new RangeError(`Track ${trackId} is unavailable.`);
            if (this.trackFxSends[index] === enabled) return;
            const previous = this.trackFxSends[index] ?? false;
            if (this.sharedDspGraph) await this.sharedDspGraph.setTrackFxSend(index, enabled);
            try {
                if (enabled) {
                    track.outputNode.disconnect(this.trackMixNode);
                    track.outputNode.connect(this.trackBankSourceNode);
                } else {
                    track.outputNode.disconnect(this.trackBankSourceNode);
                    track.outputNode.connect(this.trackMixNode);
                }
            } catch (error) {
                if (this.sharedDspGraph) {
                    try { await this.sharedDspGraph.setTrackFxSend(index, previous); }
                    catch (rollbackError) { this.recordRuntimeError(rollbackError); }
                }
                throw error;
            }
            this.trackFxSends[index] = enabled;
            track.track.fxSw = enabled ? 'ON' : 'OFF';
        }, projectToken);
    }

    public setFxType(location: 'input' | 'track', slotIndex: number, type: string): void {
        if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 4) return;
        const unit = type.trim().toUpperCase() === 'NONE' || type.trim() === '' ? null : this.createFxSnapshot(type);
        void this.updateFxBankSlot(location, slotIndex, unit).catch((error) => this.recordRuntimeError(error));
    }

    public setFxParam(location: 'input' | 'track', slotIndex: number, value: number): void {
        if (!Number.isFinite(value) || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 4) return;
        const bank = this.fxBanks.find((candidate) => candidate.id === this.activeFxBankId);
        const unit = bank?.[location][slotIndex];
        if (!unit) return;
        const next = structuredClone(unit);
        const normalized = Math.max(0, Math.min(1, value / 100));
        const sharedOrdinal = sharedDspFxOrdinal(next.type);
        if (sharedOrdinal !== null) {
            const descriptor = this.sharedDspFxCatalog.find((entry) => entry.ordinal === sharedOrdinal);
            const parameter = descriptor && selectContinuousFxParameter(descriptor.parameters);
            if (!parameter) return;
            next.params[String(parameter.id)] = parameter.minimum + normalized * (parameter.maximum - parameter.minimum);
            void this.updateFxBankSlot(location, slotIndex, next).catch((error) => this.recordRuntimeError(error));
            return;
        }
        switch (next.type.toUpperCase()) {
            case 'FILTER': next.params.frequency = normalized; break;
            case 'COMPRESSOR': next.params.amount = normalized; break;
            case 'DELAY':
            case 'REVERB': next.params.mix = normalized; break;
            case 'SLICER':
            case 'PHASER': next.params.rate = value; break;
            default: return;
        }
        void this.updateFxBankSlot(location, slotIndex, next).catch((error) => this.recordRuntimeError(error));
    }

    public setFxActive(location: 'input' | 'track', slotIndex: number, active: boolean): void {
        if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 4) return;
        const bank = this.fxBanks.find((candidate) => candidate.id === this.activeFxBankId);
        const unit = bank?.[location][slotIndex];
        if (!unit) return;
        const params = { ...unit.params };
        if (Object.prototype.hasOwnProperty.call(params, '48')) params['48'] = active ? 1 : 0;
        void this.updateFxBankSlot(location, slotIndex, { ...unit, enabled: active, params })
            .catch((error) => this.recordRuntimeError(error));
    }

    private validateFxUnit(slot: ProjectFxUnit | null): ProjectFxUnit | null {
        if (slot === null) return null;
        const ordinal = slot && typeof slot.type === 'string' ? sharedDspFxOrdinal(slot.type) : null;
        const sharedDescriptor = ordinal === null ? undefined : this.sharedDspFxCatalog.find((entry) => entry.ordinal === ordinal);
        const validSharedUnit = Boolean(sharedDescriptor && slot && Object.entries(slot.params ?? {}).every(([key, value]) => {
            if (!/^(0|[1-9]\d*)$/.test(key) || !Number.isFinite(Math.fround(value))) return false;
            const parameter = sharedDescriptor.parameters.find((descriptor) => String(descriptor.id) === key);
            return parameter && Number.isFinite(value) && value >= parameter.minimum && value <= parameter.maximum;
        }));
        if (!slot || typeof slot !== 'object' || typeof slot.enabled !== 'boolean' ||
            (!defaultFXRegistry.supports(slot.type) && !validSharedUnit) ||
            !slot.params || typeof slot.params !== 'object' || Object.values(slot.params).some((value) => !Number.isFinite(value))) {
            throw new TypeError('FX unit must use an available processor, valid reconstruction-safe parameters, and an enabled flag.');
        }
        return structuredClone(slot);
    }

    private createFxSnapshot(type: string): ProjectFxUnit {
        const normalizedType = type.trim().toUpperCase();
        const ordinal = sharedDspFxOrdinal(normalizedType);
        if (ordinal !== null) {
            const descriptor = this.sharedDspFxCatalog.find((entry) => entry.ordinal === ordinal);
            if (!descriptor) throw new TypeError(`Shared DSP FX type ${type} is not available in the loaded module.`);
            const parameters = createEnabledFxParameters(descriptor.parameters);
            return {
                type: sharedDspFxType(ordinal), enabled: true,
                params: parameters,
            };
        }
        if (!defaultFXRegistry.supports(normalizedType)) throw new TypeError(`FX type ${type} is not registered.`);
        const effect = defaultFXRegistry.create(this.context, normalizedType);
        try {
            return { ...effect.getSnapshot(), enabled: true };
        } finally {
            effect.dispose();
        }
    }

    private async createBankGraphs(bank: ProjectFxBank): Promise<Record<FxBankLocation, FxNodeGraph>> {
        const staged = {} as Record<FxBankLocation, FxNodeGraph>;
        try {
            for (const location of ['input', 'track', 'output'] as const) {
                const graph = await this.createBankGraph(bank[location]);
                staged[location] = graph;
            }
            return staged;
        } catch (error) {
            this.disposeGraphs(staged);
            throw error;
        }
    }

    private async createBankGraph(slots: Array<ProjectFxUnit | null>): Promise<FxNodeGraph> {
        assertOneFxBackendPerBankRoute(slots);
        const graph = await defaultFXRegistry.createGraph(
            this.context,
            slots.filter((slot): slot is ProjectFxUnit => slot !== null && !isSharedDspUnit(slot)),
        );
        try {
            await graph.initialize();
            for (const effect of graph.effects) {
                const compressor = effect as typeof effect & { onFailure?: (error: Error) => void };
                if (compressor.name === 'COMPRESSOR') compressor.onFailure = (error) => this.recordRuntimeError(error);
            }
            return graph;
        } catch (error) {
            graph.dispose();
            throw error;
        }
    }

    private replaceBankGraphs(graphs: Record<FxBankLocation, FxNodeGraph | null>): void {
        const previous = { ...this.fxGraphs };
        const applied: FxBankLocation[] = [];
        try {
            for (const location of ['input', 'track', 'output'] as const) {
                this.replaceOneBankGraph(location, graphs[location]);
                applied.push(location);
            }
        } catch (error) {
            for (const location of applied.reverse()) this.replaceOneBankGraph(location, previous[location]);
            throw error;
        }
    }

    private replaceOneBankGraph(location: FxBankLocation, graph: FxNodeGraph | null): void {
        const route = this.getBankRoute(location);
        const previous = this.fxGraphs[location];
        try {
            if (previous) {
                route.source.disconnect(previous.input);
                previous.output.disconnect(route.destination);
            } else {
                route.source.disconnect(route.destination);
            }
            if (graph) {
                route.source.connect(graph.input);
                graph.output.connect(route.destination);
            } else {
                route.source.connect(route.destination);
            }
            this.fxGraphs[location] = graph;
        } catch (error) {
            try { if (graph) { route.source.disconnect(graph.input); graph.output.disconnect(route.destination); } } catch { /* restore old route */ }
            if (previous) {
                route.source.connect(previous.input);
                previous.output.connect(route.destination);
            } else {
                route.source.connect(route.destination);
            }
            throw error;
        }
    }

    private getBankRoute(location: FxBankLocation): { source: GainNode; destination: GainNode } {
        if (location === 'input') return { source: this.inputBankSourceNode, destination: this.inputBankReturnNode };
        if (location === 'track') return { source: this.trackBankSourceNode, destination: this.trackBankReturnNode };
        return { source: this.outputBankSourceNode, destination: this.outputBankReturnNode };
    }

    private disposeGraphs(graphs: Partial<Record<FxBankLocation, FxNodeGraph | null>>): void {
        for (const graph of Object.values(graphs)) graph?.dispose();
    }

    private publishFxState(): void {
        const state = this.getFxState();
        for (const listener of this.fxStateListeners) {
            try { listener(state); } catch (error) { this.recordRuntimeError(error); }
        }
    }

    private runFxMutation<T>(operation: () => Promise<T> | T, projectToken?: symbol): Promise<T> {
        const releaseLease = this.realtimeRuntime?.acquireMutationLease(projectToken);
        const result = this.fxMutationQueue.then(operation);
        this.fxMutationQueue = result.then(() => undefined, () => undefined);
        return result.finally(() => releaseLease?.());
    }

    // ========================================
    // MONITORING CONTROL (CRITICAL SAFETY)
    // ========================================

    /**
     * Enable/disable software monitoring
     * WARNING: Only use with headphones to prevent feedback!
     */
    public setMonitoring(enabled: boolean, projectToken?: symbol): Promise<void> {
        return this.runFxMutation(async () => {
            if (this.realtimeRuntime) {
                await this.realtimeRuntime.enqueue(
                    BrowserRealtimeOpcode.SET_MONITOR,
                    -1,
                    enabled ? 1 : 0,
                    0,
                    this.realtimeRuntime.getImmediateTargetFrame(),
                    0,
                    projectToken,
                );
            }
            this.monitoringEnabled = enabled;
        console.log(`\n?? Software Monitoring: ${enabled ? 'ENABLED ??' : 'DISABLED (SAFE)'}`);
        if (enabled) {
            console.log('  ??  WARNING: Use headphones only! Speakers will cause feedback!\n');
        } else {
            console.log('  ? Safe mode - no direct monitoring\n');
        }

        this.monitoringListeners.forEach(listener => listener(this.monitoringEnabled));
        this.emitStatus();
        }, projectToken);
    }

    public async setMonitoringForProject(enabled: boolean, token: symbol): Promise<void> {
        await this.setMonitoring(enabled, token);
    }

    public onMonitoringChange(listener: (enabled: boolean) => void) {
        this.monitoringListeners.add(listener);
        listener(this.monitoringEnabled);
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

        return {
            sampleRate: this.context.sampleRate,
            baseLatencyMs,
            outputLatencyMs,
            inputLatencyMs: null,
            estimatedMonitoringLatencyMs: null,
            roundTripLatencyMs: this.measuredRoundTripLatencyMs,
            inputLatencySource: null,
            outputLatencySource: outputLatencyMs === null ? null : 'AudioContext.outputLatency API',
            driverReportedStreamLatencyMs: null,
            driverReportedStreamLatencySource: null,
            roundTripLatencyNote: this.measuredRoundTripLatencyMs === null
                ? 'No correlated output-to-input loopback calibration is stored for the active device route and capture format.'
                : 'Measured by scheduled output tone and AudioWorklet capture for the active route; the signal path is not independently verified as analog hardware.',
            xrunsOrDropouts: null,
        };
    }

    public getRealtimeMetrics(): BrowserRealtimeMetrics {
        if (this.realtimeRuntime) return this.realtimeRuntime.getMetrics();
        return {
            sampleRate: this.context.sampleRate,
            quantumFrames: null,
            renderedFrame: 0,
            underruns: 0,
            commandQueueDepth: 0,
            loopFrames: new Array(BROWSER_REALTIME_TRACK_COUNT).fill(0),
            recordingFrames: new Array(BROWSER_REALTIME_TRACK_COUNT).fill(0),
            trackStates: new Array(BROWSER_REALTIME_TRACK_COUNT).fill(0),
            trackPositions: new Array(BROWSER_REALTIME_TRACK_COUNT).fill(0),
            outputMonitorEnabled: false,
            backendMode: 'sab-worklet',
            lastAckSequence: 0,
            commandOverruns: 0,
            processDeadlineMisses: null,
            deadlineMetricAvailable: false,
            inputDropoutBlocks: 0,
            trackCapacityOverruns: 0,
            maxTrackFrames: 0,
            trackCapacityFrames: new Array(BROWSER_REALTIME_TRACK_COUNT).fill(0),
            inputDropoutFrames: 0,
            sharedDspProcessFailures: 0,
            storageAllocatedBytes: 0,
            storageGrowthRequests: 0,
            storageGrowthFailures: 0,
            historyDepth: new Array(BROWSER_REALTIME_TRACK_COUNT).fill(0),
            storageSegments: new Array(BROWSER_REALTIME_TRACK_COUNT).fill(0),
        };
    }

    public getMasterLevel(): number {
        return this.masterGainNode.gain.value;
    }

    public setMasterLevel(value: number, projectToken?: symbol): void {
        const releaseLease = this.realtimeRuntime?.acquireMutationLease(projectToken);
        try {
        if (!Number.isFinite(value)) throw new TypeError('Master level must be finite.');
        const level = Math.max(0, Math.min(2, value));
        this.masterGainNode.gain.setTargetAtTime(level, this.context.currentTime, 0.003);
        this.projectMixer.masterLevel = level;
        } finally {
            releaseLease?.();
        }
    }

    public getMixerState(): ProjectMixer {
        return structuredClone(this.projectMixer);
    }

    public applyMixerState(state: ProjectMixer, projectToken?: symbol): Promise<void> {
        return this.runFxMutation(() => this.applyMixerStateNow(state, projectToken), projectToken);
    }

    private applyMixerStateNow(state: ProjectMixer, projectToken?: symbol): void {
        if (!Array.isArray(state.tracks) || state.tracks.length !== this.tracks.length) {
            throw new TypeError('Mixer state must describe all five tracks.');
        }
        const anySolo = state.tracks.some((track) => track.solo);
        state.tracks.forEach((track, index) => {
            if (track.trackId !== index + 1 || !Number.isFinite(track.level) || !Number.isFinite(track.pan)) {
                throw new TypeError('Mixer state has invalid track values.');
            }
        });
        this.projectMixer = structuredClone(state);
        this.setMasterLevel(state.masterLevel, projectToken);
        state.tracks.forEach((track, index) => this.tracks[index]!.setMixerState(track, anySolo));
    }

    public async syncExternalClock(bpm: number, beatOrdinal = 0) {
        if (!this.initialized || !this.realtimeRuntime) throw new Error('Browser realtime audio is not ready.');
        const safeBpm = Number.isFinite(bpm) ? Math.max(40, Math.min(300, bpm)) : 120;
        const appliedBpm = Math.round(safeBpm * 1_000) / 1_000;
        const safeOrdinal = Number.isFinite(beatOrdinal) ? Math.max(0, Math.floor(beatOrdinal)) : 0;
        const ack = await this.realtimeRuntime.syncExternalClock(appliedBpm, safeOrdinal);
        if (ack.status !== 0 && ack.status !== 1) throw new Error(`Worklet rejected external clock synchronization (status ${ack.status}).`);

        const transport = Transport.getInstance();
        const beatFrames = this.context.sampleRate * 60 / appliedBpm;
        // SYNC_EXTERNAL_CLOCK anchors its phase at the scheduled target, even
        // when the Worklet reports that it executed a late command.
        const externalOrigin = ack.targetFrame - safeOrdinal * beatFrames;
        this.suppressTransportBpmCommand = true;
        try {
            transport.setBpm(appliedBpm);
            transport.setClockEpoch(externalOrigin, appliedBpm, this.context.sampleRate, 'external');
        } finally {
            this.suppressTransportBpmCommand = false;
        }
        if (transport.masterTrackId !== null) this.tracks[transport.masterTrackId - 1]?.syncMasterPlaybackSpeed();
        return ack;
    }

    public async stopTransportForProject(token: symbol): Promise<void> {
        if (!this.initialized || !this.realtimeRuntime) throw new Error('Browser realtime audio is not ready.');
        // Close a latched audio-frame discontinuity before sending sample-time
        // project commands. A suspended context cannot accrue render frames.
        if (this.context.state === 'running') {
            await this.realtimeRuntime.requestTimelineRecoveryForProject(token);
        }
        this.suppressTransportStopCommand = true;
        try {
            Transport.getInstance().stop();
            const ack = await this.realtimeRuntime.setClock(false, token);
            if (ack.status !== 0 && ack.status !== 1) throw new Error(`Worklet rejected project transport stop (status ${ack.status}).`);
        } finally {
            this.suppressTransportStopCommand = false;
        }
    }

    public resetTransportMasterForProject(_token: symbol): void {
        this.suppressTransportMasterCommand = true;
        try {
            Transport.getInstance().resetMasterTrack();
        } finally {
            this.suppressTransportMasterCommand = false;
        }
    }

    public getLoopSettings(): LoopEngineSettings {
        const transport = Transport.getInstance();
        return {
            bpm: transport.bpm,
            masterTrackId: transport.masterTrackId,
            loopSyncMode: this.memorySettings.loopSyncMode,
            tempoSyncMode: this.memorySettings.tempoSyncMode,
            quantize: this.memorySettings.quantize,
        };
    }

    public updateLoopSettings(patch: LoopEngineSettingsPatch): Promise<void> {
        return this.runFxMutation(async () => {
            const next = { ...this.getLoopSettings(), ...patch };
            await this.applyLoopSettings(next, undefined, false);
        });
    }

    public getRhythmSnapshot(): RhythmRuntimeSnapshot {
        if (!this.initialized || !this.realtimeRuntime) throw new Error('Initialize browser audio before reading rhythm settings.');
        return { ...this.realtimeRuntime.getRhythmSnapshot(), volume: this.rhythmEngine.volume };
    }

    public loadRhythmPattern(document: RhythmPatternDocument): Promise<void> {
        if (!this.initialized || !this.realtimeRuntime) throw new Error('Initialize browser audio before changing the rhythm pattern.');
        return this.runFxMutation(() => this.realtimeRuntime!.loadRhythmPattern(document));
    }

    public loadRhythmKit(document: RhythmKitDocument): Promise<void> {
        if (!this.initialized || !this.realtimeRuntime) throw new Error('Initialize browser audio before changing the rhythm kit.');
        return this.runFxMutation(() => this.realtimeRuntime!.loadRhythmKit(document));
    }

    public selectCleanRoomRhythm(patternIndex: number, kitIndex: number): Promise<void> {
        if (!this.initialized || !this.realtimeRuntime) throw new Error('Initialize browser audio before selecting a clean-room rhythm preset.');
        return this.runFxMutation(() => this.realtimeRuntime!.selectCleanRoomRhythm(patternIndex, kitIndex));
    }

    public applyRhythmSnapshot(snapshot: RhythmRuntimeSnapshot): Promise<void> {
        if (!this.initialized || !this.realtimeRuntime) throw new Error('Initialize browser audio before applying rhythm settings.');
        return this.runFxMutation(async () => {
            await this.realtimeRuntime!.applyRhythmSnapshot(snapshot);
            this.rhythmEngine.syncRuntimeState(snapshot.enabled, snapshot.volume);
        });
    }

    public applyRhythmSnapshotForProject(snapshot: RhythmRuntimeSnapshot, token: symbol): Promise<void> {
        if (!this.initialized || !this.realtimeRuntime) throw new Error('Initialize browser audio before applying rhythm settings.');
        return this.runFxMutation(async () => {
            await this.realtimeRuntime!.applyRhythmSnapshot(snapshot, token);
            this.rhythmEngine.syncRuntimeState(snapshot.enabled, snapshot.volume);
        }, token);
    }

    /** Transactional project path; the caller must own Runtime's exact lock token. */
    public async applyLoopSettingsForProject(settings: LoopEngineSettings, token: symbol): Promise<void> {
        await this.runFxMutation(() => this.applyLoopSettings(settings, token, true), token);
    }

    public refreshInputRoutingFxForProject(token: symbol): Promise<void> {
        if (!this.routingGraph) throw new Error('Initialize browser audio before restoring input FX.');
        return this.runFxMutation(() => this.routingGraph!.setInputFxSnapshots(this.getInputFxSnapshots()), token);
    }

    private async applyLoopSettings(settings: LoopEngineSettings, token: symbol | undefined, forceMasterEpoch: boolean): Promise<void> {
        validateLoopEngineSettings(settings);
        if (!this.initialized || !this.realtimeRuntime) throw new Error('Initialize browser audio before changing loop settings.');
        const runtime = this.realtimeRuntime;
        const transport = Transport.getInstance();
        const previous = this.getLoopSettings();
        const metrics = runtime.getMetrics();
        if (settings.masterTrackId !== null && (metrics.loopFrames[settings.masterTrackId - 1] ?? 0) <= 0) {
            throw new Error(`Track ${settings.masterTrackId} has no committed loop and cannot be the master track.`);
        }

        const priorTrackModes = this.tracks.map((track) => track.getRuntimeSettings().tempoSyncMode);
        try {
            await Promise.all(this.tracks.map((track) => {
                const current = track.getRuntimeSettings();
                const next = { ...current, tempoSyncMode: settings.tempoSyncMode };
                return token
                    ? track.updateRuntimeSettingsForProject(next, token)
                    : track.updateRuntimeSettings({ tempoSyncMode: next.tempoSyncMode });
            }));
        } catch (error) {
            await Promise.all(this.tracks.map((track, index) => token
                ? track.updateRuntimeSettingsForProject({ ...track.getRuntimeSettings(), tempoSyncMode: priorTrackModes[index]! }, token).catch(() => undefined)
                : track.updateRuntimeSettings({ tempoSyncMode: priorTrackModes[index]! }).catch(() => undefined)));
            throw error;
        }

        const masterChanged = forceMasterEpoch || settings.masterTrackId !== previous.masterTrackId;
        if (masterChanged) {
            this.suppressTransportMasterCommand = true;
            try {
                transport.resetMasterTrack();
                if (settings.masterTrackId !== null) {
                    const loopFrames = metrics.loopFrames[settings.masterTrackId - 1] ?? 0;
                    transport.setMasterTrack(
                        settings.masterTrackId,
                        loopFrames / this.context.sampleRate,
                        this.context.sampleRate,
                        loopFrames,
                        metrics.renderedFrame,
                    );
                }
            } finally {
                this.suppressTransportMasterCommand = false;
            }
        }
        this.memorySettings.loopSyncMode = settings.loopSyncMode;
        this.memorySettings.tempoSyncMode = settings.tempoSyncMode;
        this.memorySettings.quantize = settings.quantize;
        this.suppressTransportBpmCommand = true;
        try {
            transport.setBpm(settings.bpm);
            if (transport.hasMasterTrack()) transport.measureLength = transport.getMeasureDuration();
        } finally {
            this.suppressTransportBpmCommand = false;
        }
        const epochAck = await runtime.setMasterClockEpoch(
            this.getTransportClockOrigin(transport, runtime),
            settings.bpm,
            token,
        );
        if (epochAck.status !== 0 && epochAck.status !== 1) throw new Error(`Worklet rejected master clock epoch (status ${epochAck.status}).`);
        if (transport.masterTrackId !== null) {
            this.tracks[transport.masterTrackId - 1]?.syncMasterPlaybackSpeed();
        }
    }

    public getIoSnapshot(): BrowserAudioIoSnapshot {
        const contextWithSink = this.context as AudioContext & {
            outputLatency?: number;
            sinkId?: string | { id?: string; type?: string };
        };
        const inputSettings = this.currentInputSettings as (MediaTrackSettings & { latency?: number }) | null;
        const contextSink = typeof contextWithSink.sinkId === 'string'
            ? contextWithSink.sinkId
            : contextWithSink.sinkId?.id || null;
        const outputSinkType = typeof contextWithSink.sinkId === 'string'
            ? (contextWithSink.sinkId ? 'device' : 'default')
            : contextWithSink.sinkId?.type || null;
        const requestedLatency = inputSettings?.latency;

        return {
            contextSampleRate: this.context.sampleRate,
            contextBaseLatencyMs: Number.isFinite(this.context.baseLatency) ? this.context.baseLatency * 1000 : null,
            contextOutputLatencyMs: Number.isFinite(contextWithSink.outputLatency)
                ? (contextWithSink.outputLatency ?? 0) * 1000
                : null,
            loopRecordingChannelCount: 2,
            loopPlaybackOutputChannelCount: 2,
            loopChannelLayout: 'stereo planar LR; stereo input preserved and mono input duplicated to LR',
            inputDeviceId: inputSettings?.deviceId || this.selectedInputDeviceId,
            inputLabel: this.currentInputLabel,
            inputSampleRate: Number.isFinite(inputSettings?.sampleRate) ? inputSettings!.sampleRate! : null,
            inputChannelCount: Number.isFinite(inputSettings?.channelCount) ? inputSettings!.channelCount! : null,
            inputLatencyMs: Number.isFinite(requestedLatency) ? requestedLatency! * 1000 : null,
            echoCancellation: typeof inputSettings?.echoCancellation === 'boolean' ? inputSettings.echoCancellation : null,
            noiseSuppression: typeof inputSettings?.noiseSuppression === 'boolean' ? inputSettings.noiseSuppression : null,
            autoGainControl: typeof inputSettings?.autoGainControl === 'boolean' ? inputSettings.autoGainControl : null,
            outputDeviceId: contextSink || this.selectedOutputDeviceId,
            outputLabel: this.currentOutputLabel,
            outputSinkType,
            rhythmRoutingDelayFrames: this.observedQuantumFrames,
        };
    }

    private installTransportListeners() {
        if (this.transportListenersInstalled) return;
        const transport = Transport.getInstance();
        transport.on('start', this.handleTransportStart);
        transport.on('stop', this.handleTransportStop);
        transport.on('bpm-change', this.handleTransportBpmChange);
        transport.on('master-track-change', this.handleTransportMasterChange);
        this.transportListenersInstalled = true;
    }

    private syncWorkletMasterEpoch(projectToken?: symbol): void {
        const runtime = this.realtimeRuntime;
        if (!runtime) return;
        const transport = Transport.getInstance();
        const origin = this.getTransportClockOrigin(transport, runtime);
        void runtime.setMasterClockEpoch(origin, transport.bpm, projectToken)
            .catch((error) => this.recordRuntimeError(error));
    }

    private getTransportClockOrigin(transport: Transport, runtime: BrowserRealtimeRuntime): number {
        if (transport.hasClockEpoch) return transport.clockOriginFrame;
        return transport.hasMasterTrack() ? transport.masterOriginFrame : runtime.getCurrentFrame();
    }

    private getFxChains(): FXChain[] {
        return [this.inputFxChain, this.outputFxChain, ...this.tracks.map((track) => track.fxChain)];
    }

    private getInputFxSnapshots(bankOverride?: ProjectFxBank): FXSnapshot[] {
        const fixed = Object.values(this.inputFxChain.getSnapshot());
        const bank = bankOverride ?? this.fxBanks.find((candidate) => candidate.id === this.activeFxBankId);
        const slots = bank?.input.filter((unit): unit is ProjectFxUnit => unit !== null && !isSharedDspUnit(unit)) ?? [];
        return [...fixed, ...slots].filter((snapshot) => snapshot.enabled);
    }

    private handleRuntimeMessage(message: BrowserRealtimeRuntimeMessage) {
        if (message.type === 'QUANTUM_OBSERVED' && Number.isInteger(message.frames) && (message.frames ?? 0) > 0) {
            const frames = message.frames!;
            this.observedQuantumFrames = frames;
            const delayTime = this.rhythmRouteDelay?.delayTime;
            if (delayTime) {
                delayTime.setTargetAtTime(frames / this.context.sampleRate, this.context.currentTime, 0.002);
            }
            this.routingGraph?.setSourceRoutingDelayFrames('rhythm', frames);
        } else if (message.type === 'CLOCK_TICK' && typeof message.beatOrdinal === 'number' && typeof message.frame === 'number') {
            Transport.getInstance().emitWorkletBeat(message.beatOrdinal, message.frame);
        } else if (message.type === 'TRACK_STATE_CHANGED' && typeof message.track === 'number') {
            this.tracks[message.track]?.refreshRuntimeStateFromWorklet();
        } else if (message.type === 'TRACK_CAPACITY_REACHED' && typeof message.track === 'number') {
            const track = this.tracks[message.track];
            track?.handleCapacityReached(message.frame ?? this.realtimeRuntime?.getCurrentFrame() ?? 0);
        } else if (message.type === 'LOOPBACK_CAPTURE_COMPLETE') {
            this.loopbackCaptureResolve?.();
            this.loopbackCaptureResolve = null;
        } else if (message.type === 'BOOT_ERROR') {
            this.initialized = false;
            this.lastError = message.message || 'Browser realtime worklet failed to start.';
            this.emitStatus();
        }
    }

    public getSharedDspRouteCapabilities() {
        return BROWSER_SHARED_DSP_ROUTE_CAPABILITIES;
    }

    public getSharedDspRuntimeIdentity() {
        return {
            moduleSha256: this.sharedDspModuleSha256,
            looperProcessorInstanceId: this.sharedDspLooperProcessorInstanceId,
            masterProcessorInstanceId: this.sharedDspMasterProcessorInstanceId,
            contextSampleRate: this.context.sampleRate,
            contextState: this.context.state,
        };
    }

    public getMasterFxOutputNode(): AudioWorkletNode | null {
        return this.masterFxWorkletNode;
    }

    /**
     * Attach an independent AudioNode as the external vocoder carrier.
     * Actual channel count is checked on the Worklet render thread: WebAudio's
     * AudioNode.channelCount is a configuration value and does not reliably
     * describe the connected source's emitted channels. The Worklets reject
     * anything other than an observed stereo carrier without upmixing it.
     */
    public setFxCarrierSource(source: AudioNode | null): boolean {
        if (source === this.sharedDspFxCarrierSource) return true;
        if (source && source.context !== this.context) return false;
        const activeBank = this.fxBanks.find((bank) => bank.id === this.activeFxBankId);
        const vocoderActive = Boolean(activeBank &&
            [...activeBank.input, ...activeBank.track, ...activeBank.output]
                .some((unit) => unit?.enabled && sharedDspFxOrdinal(unit.type) === 20));
        if (!source && vocoderActive) return false;

        const previous = this.sharedDspFxCarrierSource;
        if (source) {
            try {
                this.connectFxCarrierSourceToWorklets(source);
            } catch {
                this.disconnectFxCarrierSourceFromWorklets(source);
                return false;
            }
        }
        if (previous) this.disconnectFxCarrierSourceFromWorklets(previous);
        this.sharedDspFxCarrierSource = source;
        if (this.sharedDspFxCarrierControl) Atomics.store(this.sharedDspFxCarrierControl, 0, source ? 1 : 0);
        return true;
    }

    /** Queue normalized MIDI for each active compatible shared-DSP route. */
    public postFxMidiInput(event: FxMidiInputEvent): boolean {
        if (!isValidFxMidiInputEvent(event) || event.channel !== 0 || !this.realtimeRuntime ||
            !this.workletNode || !this.masterFxWorkletNode) return false;
        const bank = this.fxBanks.find((candidate) => candidate.id === this.activeFxBankId);
        if (!bank) return false;
        const acceptsMidi = (units: Array<ProjectFxUnit | null>) => units.some((unit) => {
            if (!unit?.enabled) return false;
            const ordinal = sharedDspFxOrdinal(unit.type);
            if (ordinal === 21) return true;
            if (ordinal !== 19) return false;
            const mode = unit.params['107'] ?? 2;
            return Number.isFinite(mode) && mode < 1.5;
        });
        const looperRoute = acceptsMidi(bank.input) || acceptsMidi(bank.track);
        const masterRoute = acceptsMidi(bank.output);
        if (!looperRoute && !masterRoute) return false;
        let targetFrame = this.fxMidiTargetFrame(event.timestampMs);
        if (targetFrame === null) return false;
        const looperQueue = looperRoute ? this.sharedDspLooperMidiQueue : null;
        const masterQueue = masterRoute ? this.sharedDspMasterMidiQueue : null;
        if (looperQueue) targetFrame = Math.max(targetFrame, looperQueue.minimumNextTargetFrame);
        if (masterQueue) targetFrame = Math.max(targetFrame, masterQueue.minimumNextTargetFrame);
        if ((looperQueue && !looperQueue.canEnqueue(event, targetFrame)) ||
            (masterQueue && !masterQueue.canEnqueue(event, targetFrame))) return false;
        if ((looperQueue && !looperQueue.enqueue(event, targetFrame)) ||
            (masterQueue && !masterQueue.enqueue(event, targetFrame))) return false;
        return true;
    }

    public getFxMidiQueueDiagnostics(): { looperDropped: number; masterDropped: number } {
        return {
            looperDropped: this.sharedDspLooperMidiQueue?.droppedEvents ?? 0,
            masterDropped: this.sharedDspMasterMidiQueue?.droppedEvents ?? 0,
        };
    }

    private fxMidiTargetFrame(timestampMs: number): number | null {
        const context = this.context;
        const currentFrame = this.realtimeRuntime?.getCurrentFrame();
        if (!Number.isSafeInteger(currentFrame) || currentFrame! < 0 || !Number.isFinite(context.sampleRate) || context.sampleRate <= 0) return null;
        if (typeof context.getOutputTimestamp !== 'function') return null;
        const outputTimestamp = context.getOutputTimestamp();
        if (!outputTimestamp || typeof outputTimestamp.contextTime !== 'number' ||
            typeof outputTimestamp.performanceTime !== 'number' ||
            !Number.isFinite(outputTimestamp.contextTime) ||
            !Number.isFinite(outputTimestamp.performanceTime) || !Number.isFinite(timestampMs)) return null;
        const mapped = Math.round((outputTimestamp.contextTime +
            (timestampMs - outputTimestamp.performanceTime) / 1000) * context.sampleRate);
        if (!Number.isSafeInteger(mapped) || mapped < 0) return null;
        const quantum = this.observedQuantumFrames ?? BROWSER_REALTIME_QUANTUM_FRAMES;
        return Math.max(mapped, currentFrame! + Math.max(1, quantum));
    }

    private connectFxCarrierSourceToWorklets(source: AudioNode): void {
        if (this.workletNode) source.connect(this.workletNode, 0, 6);
        if (this.masterFxWorkletNode) source.connect(this.masterFxWorkletNode, 0, 1);
    }

    private disconnectFxCarrierSourceFromWorklets(source: AudioNode): void {
        if (this.workletNode) {
            try { source.disconnect(this.workletNode, 0, 6); } catch { /* the carrier edge may already be disconnected */ }
        }
        if (this.masterFxWorkletNode) {
            try { source.disconnect(this.masterFxWorkletNode, 0, 1); } catch { /* the carrier edge may already be disconnected */ }
        }
    }

    public configureRealtimeDspFilter(request: SharedDspFilterRequest): Promise<SharedDspReply> {
        if (!this.initialized || !this.sharedDspGraph) {
            return Promise.reject(new Error('Initialize the browser audio engine before configuring shared DSP.'));
        }
        return this.sharedDspGraph.configureFilter(request);
    }

    public clearRealtimeDspFilter(route: SharedDspFilterRequest['route'], track?: number): Promise<SharedDspReply> {
        if (!this.initialized || !this.sharedDspGraph) {
            return Promise.reject(new Error('Initialize the browser audio engine before clearing shared DSP.'));
        }
        return this.sharedDspGraph.clearFilter(route, track);
    }

    private async waitForSharedDspReady(node: AudioWorkletNode, timeoutMs = 5_000): Promise<SharedDspReply> {
        return await new Promise<SharedDspReply>((resolve, reject) => {
            const timeout = setTimeout(() => finish(new Error('Shared DSP Worklet setup did not finish.')), timeoutMs);
            const onProcessorError = () => finish(new Error('Shared DSP Worklet failed during prewarm.'));
            const onMessage = (event: MessageEvent) => {
                const message = event.data as SharedDspReply | null;
                if (message?.type === 'SHARED_DSP_READY') finish(null, message);
                else if (message?.type === 'SHARED_DSP_BOOT_ERROR' || message?.type === 'BOOT_ERROR') {
                    finish(new Error(message.message || 'Shared DSP Worklet could not prepare its module.'));
                }
            };
            const cleanup = () => {
                clearTimeout(timeout);
                node.port.removeEventListener('message', onMessage);
                node.removeEventListener('processorerror', onProcessorError);
            };
            const finish = (error: Error | null, message?: SharedDspReply) => {
                cleanup();
                if (error) {
                    try { node.disconnect(); } catch { /* a processor may already be torn down */ }
                    try { node.port.close(); } catch { /* ignore an already-closed port */ }
                    reject(error);
                }
                else if (message) resolve(message);
                else reject(new Error('Shared DSP Worklet readiness response was empty.'));
            };
            node.addEventListener('processorerror', onProcessorError, { once: true });
            node.port.addEventListener('message', onMessage);
            node.port.start();
        });
    }

    private async waitForMasterDspReady(node: AudioWorkletNode, timeoutMs = 5_000): Promise<SharedDspReply> {
        return await new Promise<SharedDspReply>((resolve, reject) => {
            const timeout = setTimeout(() => finish(new Error('Master DSP Worklet setup did not finish.')), timeoutMs);
            const onProcessorError = () => finish(new Error('Master DSP Worklet failed during prewarm.'));
            const onMessage = (event: MessageEvent) => {
                const message = event.data as SharedDspReply | null;
                if (message?.type === 'MASTER_DSP_READY') finish(null, message);
                else if (message?.type === 'MASTER_DSP_BOOT_ERROR') {
                    finish(new Error(message.message || 'Master DSP Worklet could not prepare its module.'));
                }
            };
            const cleanup = () => {
                clearTimeout(timeout);
                node.port.removeEventListener('message', onMessage);
                node.removeEventListener('processorerror', onProcessorError);
            };
            const finish = (error: Error | null, message?: SharedDspReply) => {
                cleanup();
                if (error) {
                    try { node.disconnect(); } catch { /* processor may already be torn down */ }
                    try { node.port.close(); } catch { /* ignore an already-closed port */ }
                    reject(error);
                } else if (message) resolve(message);
                else reject(new Error('Master DSP Worklet readiness response was empty.'));
            };
            node.addEventListener('processorerror', onProcessorError, { once: true });
            node.port.addEventListener('message', onMessage);
            node.port.start();
        });
    }

    private recordRuntimeError(error: unknown) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.emitStatus();
    }

    private getLatencyCalibrationScope(): BrowserLatencyCalibrationScope {
        const contextWithSink = this.context as AudioContext & { sinkId?: string | { id?: string; type?: string } };
        const contextSinkId = typeof contextWithSink.sinkId === 'string'
            ? contextWithSink.sinkId
            : contextWithSink.sinkId?.id || null;
        return {
            inputDeviceId: this.currentInputSettings?.deviceId || this.selectedInputDeviceId,
            outputDeviceId: contextSinkId || this.selectedOutputDeviceId,
            contextSampleRate: this.context.sampleRate,
            inputSampleRate: Number.isFinite(this.currentInputSettings?.sampleRate)
                ? this.currentInputSettings!.sampleRate!
                : null,
            inputChannelCount: Number.isFinite(this.currentInputSettings?.channelCount)
                ? this.currentInputSettings!.channelCount!
                : null,
        };
    }

    private syncCurrentCalibration() {
        this.currentCalibration = getBrowserLatencyCalibration(this.getLatencyCalibrationScope());
        this.measuredRoundTripLatencyMs = this.currentCalibration?.roundTripLatencyMs ?? null;
        this.roundTripLatency = this.measuredRoundTripLatencyMs === null ? 0 : this.measuredRoundTripLatencyMs / 1000;
    }

    public onLatencyInfoChange(listener: (info: BrowserAudioLatencyInfo) => void) {
        this.latencyListeners.add(listener);
        listener(this.getLatencyInfo());
        return () => {
            this.latencyListeners.delete(listener);
        };
    }

    public getUiStatus(): BrowserAudioUiStatus {
        return {
            mode: 'browser',
            bridgeAvailable: true,
            engineRunning: this.initialized,
            ready: this.initialized,
            message: this.compressorFailure
                ? 'BROWSER AUDIO DEGRADED: COMPRESSOR DISABLED'
                : this.initialized ? 'BROWSER AUDIO READY' : 'BROWSER AUDIO NOT INITIALIZED',
            lastError: this.lastError,
        };
    }

    public onStatusChange(listener: (status: BrowserAudioUiStatus) => void) {
        this.statusListeners.add(listener);
        listener(this.getUiStatus());
        return () => {
            this.statusListeners.delete(listener);
        };
    }

    public isNativeReady() {
        return this.initialized;
    }

    public get isReady() {
        // A failed effect is bypassed and reported as degraded, but the
        // sample-clock engine remains controllable so users can stop or clear.
        return this.initialized;
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
        gain.connect(this.masterGainNode);

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
        if (!this.currentInputStream) {
            // Initialize default input if not set
            await this.setInputDevice(this.selectedInputDeviceId || '');
        }
        return this.currentInputStream!;
    }

    public async getProcessedInputNode(): Promise<AudioNode> {
        await this.getInputStream();
        return this.inputFxChain.output;
    }

    // ========================================
    // LOOPBACK LATENCY TEST
    // ========================================

    public async runLoopbackTest(): Promise<number> {
        if (!this.initialized || !this.realtimeRuntime || !this.workletNode) {
            throw new Error('Initialize browser audio and select input/output devices before running loopback calibration.');
        }
        if (this.loopbackCaptureResolve) {
            throw new Error('A browser loopback calibration is already running.');
        }

        await this.getInputStream();
        if (this.context.state === 'suspended') await this.context.resume();

        const captureFrames = Math.round(this.context.sampleRate * 1.5);
        const captureBuffer = this.realtimeRuntime.createLoopbackCaptureBuffer(captureFrames);
        const captureStartFrame = this.realtimeRuntime.getSafeTargetFrame();
        const signalFrame = captureStartFrame + Math.round(this.context.sampleRate * 0.25);
        const signalIndex = signalFrame - captureStartFrame;
        await this.realtimeRuntime.armLoopbackCapture(captureBuffer, captureStartFrame, captureFrames);

        let captureTimeout: ReturnType<typeof setTimeout> | null = null;
        const captureComplete = new Promise<void>((resolve, reject) => {
            this.loopbackCaptureResolve = () => {
                if (captureTimeout) clearTimeout(captureTimeout);
                this.loopbackCaptureResolve = null;
                resolve();
            };
            captureTimeout = setTimeout(() => {
                this.loopbackCaptureResolve = null;
                reject(new Error('The AudioWorklet did not finish the loopback capture in time.'));
            }, 2_500);
        });

        let osc: OscillatorNode | null = null;
        let oscGain: GainNode | null = null;
        try {
            osc = this.context.createOscillator();
            oscGain = this.context.createGain();
            osc.type = 'sine';
            osc.frequency.value = 1000;
            oscGain.gain.value = 0.05;
            osc.connect(oscGain);
            oscGain.connect(this.masterGainNode);
            const signalTime = signalFrame / this.context.sampleRate;
            osc.start(signalTime);
            osc.stop(signalTime + 0.12);
            await captureComplete;
        } finally {
            try { osc?.disconnect(); } catch { /* already disconnected */ }
            try { oscGain?.disconnect(); } catch { /* already disconnected */ }
            if (captureTimeout) clearTimeout(captureTimeout);
            this.loopbackCaptureResolve = null;
        }

        const captureMeta = new Int32Array(captureBuffer, 0, 16);
        const capturedFrames = Atomics.load(captureMeta, 2);
        const capturedAudio = new Float32Array(captureBuffer, 64, capturedFrames);
        const latencyMs = this.detectLoopbackLatency(capturedAudio, signalIndex);
        if (latencyMs === null) {
            throw new Error('The low-level 1 kHz loopback probe was not detected on the selected input route. Check the route and signal level.');
        }

        console.log(`Output-to-input loopback correlation measured ${latencyMs.toFixed(2)} ms on the active route (${this.context.sampleRate} Hz context, ${this.currentInputSettings?.sampleRate ?? 'unknown'} Hz input); route is unverified as analog hardware.`);
        return latencyMs;
    }

    public setLatency(latencyMs: number) {
        const calibration = setBrowserLatencyCalibration(this.getLatencyCalibrationScope(), latencyMs);
        this.currentCalibration = calibration;
        this.measuredRoundTripLatencyMs = calibration?.roundTripLatencyMs ?? null;
        this.roundTripLatency = this.measuredRoundTripLatencyMs === null ? 0 : this.measuredRoundTripLatencyMs / 1000;
        console.log(`Unverified active-route loopback calibration: ${this.measuredRoundTripLatencyMs === null ? 'unknown' : `${this.measuredRoundTripLatencyMs.toFixed(2)} ms`}`);
        this.emitLatencyInfo();
    }

    private detectLoopbackLatency(samples: Float32Array, signalIndex: number): number | null {
        const sampleRate = this.context.sampleRate;
        const correlationFrames = Math.max(48, Math.round(sampleRate * 0.002));
        const maxDelayFrames = Math.min(Math.round(sampleRate * 0.5), samples.length - signalIndex - correlationFrames);
        if (maxDelayFrames <= 0 || signalIndex < correlationFrames) return null;

        let noiseSquareSum = 0;
        let noiseSampleCount = 0;
        const noiseStart = Math.max(0, signalIndex - Math.round(sampleRate * 0.1));
        for (let index = noiseStart; index < signalIndex; index += 1) {
            const sample = samples[index] ?? 0;
            noiseSquareSum += sample * sample;
            noiseSampleCount += 1;
        }
        const noiseRms = noiseSampleCount > 0 ? Math.sqrt(noiseSquareSum / noiseSampleCount) : 0;
        const threshold = Math.max(1.5, noiseRms * correlationFrames * 0.35);
        const sineTemplate = new Float32Array(correlationFrames);
        const cosineTemplate = new Float32Array(correlationFrames);
        for (let index = 0; index < correlationFrames; index += 1) {
            const phase = (2 * Math.PI * 1000 * index) / sampleRate;
            sineTemplate[index] = Math.sin(phase);
            cosineTemplate[index] = Math.cos(phase);
        }

        for (let delayFrames = 0; delayFrames < maxDelayFrames; delayFrames += 1) {
            const start = signalIndex + delayFrames;
            let sineSum = 0;
            let cosineSum = 0;
            for (let index = 0; index < correlationFrames; index += 1) {
                const sample = samples[start + index] ?? 0;
                sineSum += sample * sineTemplate[index]!;
                cosineSum += sample * cosineTemplate[index]!;
            }
            if (Math.sqrt(sineSum * sineSum + cosineSum * cosineSum) >= threshold) {
                return (delayFrames / sampleRate) * 1000;
            }
        }

        return null;
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

    public async stopAllTracks(): Promise<void> {
        const configured = this.memorySettings.allStopTrk;
        const hasExplicitSelection = configured.some(Boolean);
        const targets = this.tracks.filter((track, index) =>
            (!hasExplicitSelection || configured[index] === true) && track.state !== TrackState.EMPTY,
        );
        await this.runBulkTrackAction(targets, 'stop');
    }

    public async playAllTracks(): Promise<void> {
        const configured = this.memorySettings.allStartTrk;
        const hasExplicitSelection = configured.some(Boolean);
        const targets = this.tracks.filter((track, index) =>
            (!hasExplicitSelection || configured[index] === true) && track.state === TrackState.STOPPED,
        );
        await this.runBulkTrackAction(targets, 'play');
    }

    private async runBulkTrackAction(
        targets: TrackAudio[],
        action: 'play' | 'stop',
    ): Promise<void> {
        const results = await Promise.allSettled(targets.map(async (track) => {
            try {
                if (action === 'play') await track.play();
                else await track.triggerStop();
            } catch (error) {
                const wrapped = new Error(`Track ${track.track.id} ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
                (wrapped as Error & { cause?: unknown }).cause = error;
                throw wrapped;
            }

            const message = track.getLastActionError();
            if (message) throw new Error(`Track ${track.track.id} ${action} failed: ${message}`);
        }));
        const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length > 0) {
            const detail = failures.map((failure) => failure instanceof Error ? failure.message : String(failure)).join('; ');
            throw new Error(`Could not ${action} ${failures.length} track${failures.length === 1 ? '' : 's'}: ${detail}`);
        }
    }

    public toggleReverse(trackIndex: number) {
        if (this.tracks[trackIndex]) {
            this.tracks[trackIndex].toggleReverse();
        }
    }

    private createInputConstraints(deviceId: string): MediaStreamConstraints {
        const supported = navigator.mediaDevices.getSupportedConstraints?.() as (MediaTrackSupportedConstraints & { latency?: boolean }) | undefined;
        const audio: MediaTrackConstraints & { latency?: ConstrainDouble } = {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            sampleRate: { ideal: this.context.sampleRate },
            channelCount: { ideal: 2 },
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: false,
        };
        if (supported?.latency) {
            audio.latency = { ideal: BROWSER_REALTIME_QUANTUM_FRAMES / this.context.sampleRate };
        }
        return {
            audio,
        };
    }

    private async requestInputStream(deviceId: string): Promise<MediaStream> {
        return navigator.mediaDevices.getUserMedia(this.createInputConstraints(deviceId));
    }

    private async replaceInputStream(stream: MediaStream, requestedDeviceId: string | null): Promise<void> {
        if (this.currentInputStream) {
            this.currentInputStream.disconnect();
            this.currentInputStream = null;
            console.log('  ? Disconnected old input node');
        }

        if (this.currentMediaStream) {
            this.currentMediaStream.getTracks().forEach(track => track.stop());
            console.log('  ? Stopped old input stream');
        }

        this.currentInputStream = this.context.createMediaStreamSource(stream);
        this.currentMediaStream = stream;
        const track = stream.getAudioTracks()[0];
        this.currentInputSettings = track?.getSettings() ?? null;
        this.currentInputLabel = track?.label || null;
        this.selectedInputDeviceId = this.currentInputSettings?.deviceId || requestedDeviceId;
        const channelCount = Math.max(1, Math.min(32, Math.floor(this.currentInputSettings?.channelCount || 1)));
        const source: BrowserRoutingSourceNode = {
            id: 'capture',
            node: this.currentInputStream,
            label: this.currentInputLabel || 'Selected capture input',
            kind: 'capture',
            channelCount,
            routingDelayFrames: 0,
        };
        await this.routingGraph?.setSource(source, 'capture');
        if (navigator.mediaDevices?.enumerateDevices) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            await this.routingGraph?.setAvailableSinks(devices);
        }
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
}

function isSharedDspUnit(unit: ProjectFxUnit | null | undefined): boolean {
    return Boolean(unit && sharedDspFxOrdinal(unit.type) !== null);
}

function assertOneFxBackendPerBankRoute(slots: Array<ProjectFxUnit | null>): void {
    const enabledBackends = new Set(slots
        .filter((slot): slot is ProjectFxUnit => slot !== null && slot.enabled)
        .map((slot) => isSharedDspUnit(slot) ? 'shared-dsp' : 'browser-fx'));
    if (enabledBackends.size > 1) {
        throw new Error('This FX route cannot mix shared DSP units with Browser FX units. Move all enabled slots on this route to one processor backend; the stored slot order is preserved.');
    }
}
