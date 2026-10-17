import { TrackAudio } from './TrackAudio';
import { Track, TrackState } from '../core/types';
import { Transport } from '../core/Transport';
import { FXChain } from './FXChain';
import type { FXBase } from './fx/FXBase';
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
import { BrowserRobotFX } from './fx/BrowserRobotFX';
import { BrowserOctaveFX } from './fx/BrowserOctaveFX';
import { BrowserVocoderFX } from './fx/BrowserVocoderFX';
import { MidiInputController, type MidiInputState, type MidiNoteEvent } from './MidiInputController';
import type { BrowserFxAlgorithm, BrowserFxParameters } from './fx/dsp/BrowserFxDspCore';
import { BrowserWorkletFX, type BrowserWorkletFxName } from './fx/BrowserWorkletFX';
import { BrowserTrackFxChain, type BrowserTrackFxStatus } from './BrowserTrackFxChain';

import { RhythmEngine } from './RhythmEngine';
import type { IAudioEngine } from './AudioEngineInterface';

export interface BrowserAudioLatencyInfo {
    sampleRate: number;
    baseLatencyMs: number | null;
    outputLatencyMs: number | null;
    estimatedMonitoringLatencyMs: number | null;
    roundTripLatencyMs: number | null;
}

export interface BrowserAudioUiStatus {
    mode: 'browser';
    bridgeAvailable: boolean;
    engineRunning: boolean;
    ready: boolean;
    message: string;
    lastError: string;
}

export type BrowserStepSlicerControl = 'step_count' | 'rate_beats' | 'pan_depth_percent' | 'filter_hz';
export interface BrowserMidiInputTarget {
    readonly path: 'input' | 'track';
    readonly slot: 'A' | 'B' | 'C' | 'D';
    /** Omitted/OSC VOC targets retain the existing broadcast-to-OSC behavior. */
    readonly effectId?: 'osc_voc_m' | 'hrm_auto_m';
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
    private monitorGainNode: GainNode | null = null;

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
    private fxWorkletModuleReady: Promise<void> | null = null;
    private fxWorkletGeneration = 0;
    private trackIoWorkletModuleReady: Promise<void> | null = null;
    /** Real private A–D banks before TrackMix; legacy trackFxInstances stay postmix. */
    private perTrackFxChains: BrowserTrackFxChain[] = [];
    private handleTransportBpmChange(): void {
        const bpm = Transport.getInstance().bpm;
        this.trackFxInstances.forEach((fx) => {
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'beat-repeat') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'beat-scatter') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'roll') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'beat-shift') {
                fx.setParam('bpm', bpm);
            }
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'pattern-slicer') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'step-slicer') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'isolator') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'reverse-delay') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'reverse-reverb') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'osc-bot') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'warp') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserAutoRiffFX) fx.setParam('bpm', bpm);
        });
        for (const fx of this.inputFxInstances) {
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'isolator') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'roll') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'reverse-delay') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'reverse-reverb') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'pattern-slicer') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'step-slicer') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'osc-bot') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserWorkletFX && fx.algorithm === 'warp') fx.setParam('bpm', bpm);
            if (fx instanceof BrowserAutoRiffFX) fx.setParam('bpm', bpm);
        }
        for (const track of this.tracks ?? []) track.refreshLoopTransportTempo();
        for (const bank of this.perTrackFxChains ?? []) bank.setBpm(bpm);
    }

    public constructor() {
        this.context = new AudioContext({
            latencyHint: 'interactive',
            sampleRate: 44100,
        });

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
        this.rhythmEngine = new RhythmEngine(this.context);
        this.rhythmEngine.connect(this.masterGainNode);

        // Initialize 5 tracks
        for (let i = 0; i < 5; i++) {
            const trackData = new Track(i + 1);
            const track = new TrackAudio(this, trackData, i, this.trackStates, this.trackPositions);
            const bank = new BrowserTrackFxChain(this.context, () => this.ensureFxWorkletModule(), () => this.emitStatus(), () => Transport.getInstance().bpm);
            track.installTrackFxInsert(bank.input, bank.output);
            this.perTrackFxChains.push(bank);
            this.tracks.push(track);
        }

        // Load saved device preferences
        this.loadDevicePreferences();
        Transport.getInstance().on('bpm-change', this.handleTransportBpmChange.bind(this));
    }

    public async init() {
        if (this.initialized) {
            if (this.context.state === 'suspended') await this.context.resume();
            return;
        }

        try {
            if (this.context.state === 'suspended') {
                await this.context.resume();
            }

            await this.context.audioWorklet.addModule('/worklets/looper-processor.js');
            await this.ensureTrackIoWorkletModule();
            await this.context.audioWorklet.addModule('/worklets/browser-block-meter.js');

            if (!this.workletNode) {
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
                    if (
                        message?.type === 'render-quantum-shape' &&
                        Number.isInteger(message.frames) &&
                        (message.frames ?? 0) > 0 &&
                        message.frames !== this.selectedBufferFrames
                    ) {
                        this.selectedBufferFrames = message.frames as number;
                        this.emitLatencyInfo();
                    }
                };
                this.masterGainNode.disconnect();
                this.masterGainNode.connect(meterNode);
                meterNode.connect(this.context.destination);
                this.workletNode = meterNode;
            }

            if (this.selectedInputDeviceId) {
                await this.setInputDevice(this.selectedInputDeviceId);
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
            this.lastError = error instanceof Error ? error.message : String(error);
            this.emitStatus();
            throw error;
        }
    }

    /** Load Browser overdub/loopback worklets without introducing a main-thread fallback. */
    public async ensureTrackIoWorkletModule(): Promise<void> {
        if (!this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
            throw new Error('AudioWorklet is unavailable in this browser context');
        }

        if (!this.trackIoWorkletModuleReady) {
            this.trackIoWorkletModuleReady = this.context.audioWorklet
                .addModule('/worklets/browser-track-io.js')
                .catch((error: unknown) => {
                    this.trackIoWorkletModuleReady = null;
                    throw error;
                });
        }

        await this.trackIoWorkletModuleReady;
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
        if (!this.fxWorkletModuleReady) {
            this.fxWorkletModuleReady = this.context.audioWorklet.addModule('/worklets/fx-processor.js');
        }
        try {
            await this.fxWorkletModuleReady;
        } catch (error) {
            if (generation === this.fxWorkletGeneration) this.fxWorkletModuleReady = null;
            throw error;
        }
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

        // If another request won the race while the module was loading, discard
        // this unused node before it can alter the live signal route.
        if (generation !== this.fxWorkletGeneration) {
            node.disconnect();
            return false;
        }

        const output = this.outputFxChain.output;
        const previous = this.outputDspFxNode;
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
        return true;
    }

    /** Bypass/activate the current output DSP with a short click-free ramp. */
    public setOutputDspFxEnabled(enabled: boolean, rampFrames = this.selectedBufferFrames || 128): void {
        this.outputDspFxNode?.port.postMessage({
            type: 'set-bypass',
            value: !enabled,
            rampFrames: Math.max(0, Math.floor(rampFrames)),
        });
    }

    /** Smoothly update parameters on the currently selected output algorithm. */
    public configureOutputDspFx(parameters: BrowserFxParameters): void {
        this.outputDspFxNode?.port.postMessage({ type: 'configure', parameters });
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
    public async setInputDevice(deviceId: string) {
        console.log(`\n?? Switching input device to: ${deviceId}`);

        try {
            const stream = await this.requestInputStream(deviceId);
            this.replaceInputStream(stream);

            this.selectedInputDeviceId = deviceId || null;
            this.saveDevicePreferences();

            console.log('  ? New input device connected');
            console.log(`  ??  Monitoring: ${this.monitoringEnabled ? 'ENABLED' : 'DISABLED (SAFE)'}\n`);

        } catch (error) {
            if (deviceId && this.shouldFallbackToDefaultInput(error)) {
                console.warn('  Requested input device is unavailable or overconstrained. Falling back to the default microphone.');
                try {
                    const fallbackStream = await this.requestInputStream('');
                    this.replaceInputStream(fallbackStream);
                    this.selectedInputDeviceId = null;
                    this.saveDevicePreferences();
                    console.log('  ? Default input device connected');
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
    private inputFxTypes: (string | null)[] = [null, null, null, null];
    private trackFxTypes: (string | null)[] = [null, null, null, null];
    /** Track-bank transport FX use TrackAudio readers; their shared postmix worklets stay bypassed. */
    private trackFxActive: boolean[] = [false, false, false, false];

    /** Targeted methods never dispatch to the compatible legacy shared postmix bank. */
    public setTrackFxType(trackId: number, slotIndex: number, type: string): boolean {
        return this.getPerTrackFxChain(trackId)?.setType(slotIndex, type) ?? false;
    }

    public setTrackFxParameter(trackId: number, slotIndex: number, value: number): boolean {
        return this.getPerTrackFxChain(trackId)?.setParameter(slotIndex, value) ?? false;
    }

    public setTrackFxNamedParameters(trackId: number, slotIndex: number, parameters: Record<string, number>): boolean {
        return this.getPerTrackFxChain(trackId)?.setNamedParameters(slotIndex, parameters) ?? false;
    }

    public setTrackFxActive(trackId: number, slotIndex: number, active: boolean): boolean {
        return this.getPerTrackFxChain(trackId)?.setActive(slotIndex, active) ?? false;
    }

    public getTrackFxStatus(trackId?: number): BrowserTrackFxStatus[] {
        if (trackId !== undefined) {
            const bank = this.getPerTrackFxChain(trackId);
            return bank ? [bank.getStatus(trackId)] : [];
        }
        return (this.perTrackFxChains ?? []).map((bank, index) => bank.getStatus(index + 1));
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
                previousFx.clearMidiState();
                this.selectedHrmAutoMidiTarget = null;
            }
            previousFx?.dispose();
            fxInstances[slotIndex] = null;
            fxTypes[slotIndex] = null;
            if (location === 'track') {
                this.trackFxActive[slotIndex] = false;
                this.syncAllTrackLoopTransportFx();
                this.rebuildOutputChain();
            } else {
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
            previousFx.clearMidiState();
            this.selectedHrmAutoMidiTarget = null;
        }

        // Update Chain
        if (location === 'input') {
            this.inputFxInstances[slotIndex]?.dispose();
            this.inputFxInstances[slotIndex] = newFx;
            this.inputFxTypes[slotIndex] = type;
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
        return (this.tracks ?? []).map((track, trackIndex) => ({
            trackIndex,
            trackId: track.track.id,
            routeMode: 'experimental-source-pre-track-mix-shared-postmix' as const,
            perTrackFxChainAvailable: Boolean(this.perTrackFxChains?.[trackIndex]),
            active: track.loopTransportActive,
            configuredEffects: configuredEffects.map((effect) => ({ ...effect })),
            unsupportedEffects: unsupportedEffects.map((effect) => ({ ...effect })),
            unavailableReason: track.loopTransportUnavailableReason,
        }));
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
        for (const track of this.tracks ?? []) {
            track.configureLoopTransportFx(slotIndex, canonicalType, parameters);
        }
    }

    private syncAllTrackLoopTransportFx(): void {
        for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) this.syncTrackLoopTransportFx(slotIndex);
    }

    private createFxInstance(type: string): FXBase | null {
        const context = this.context;

        if (type === 'AUTO RIFF' || type === 'AUTO RIFF (EXPERIMENTAL)') {
            if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
                this.lastError = 'AudioWorklet is unavailable; AUTO RIFF remains bypassed.';
                this.emitStatus();
                return null;
            }
            return new BrowserAutoRiffFX(
                context,
                () => this.ensureFxWorkletModule(),
                (error) => {
                    this.lastError = `Browser DSP AUTO RIFF failed: ${error.message}`;
                    this.emitStatus();
                },
            );
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
                    name === 'BEAT REPEAT' || name === 'BEAT SCATTER' || name === 'ROLL' || name === 'BEAT SHIFT' || name === 'ISOLATOR' || name === 'REVERSE DELAY' || name === 'REVERSE REVERB' || name === 'PATTERN SLICER' || name === 'STEP SLICER' || name === 'OSC BOT' || name === 'WARP' ? { bpm: Transport.getInstance().bpm } : name === 'OSC VOC (M)' ? { oscVocWaveform: 0, oscVocMidiChannel: 1, oscVocOctave: 0, oscVocBands: 16, mix: 0.7 } : name === 'ELECTRIC' ? { electricCharacter: 0, electricPitchSnapPercent: 50, electricToneHz: 5000, mix: 0.7 } : {},
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
            case 'HRM AUTO (M)': {
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
            case 'ROBOT': {
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
            case 'VOCODER': {
                if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
                    this.lastError = 'AudioWorklet is unavailable; VOCODER remains bypassed.';
                    this.emitStatus();
                    return null;
                }
                return new BrowserVocoderFX(context, () => this.ensureFxWorkletModule(), (error) => {
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
            this.fxWorkletModuleReady = this.context.audioWorklet.addModule('/worklets/fx-processor.js');
        }
        return this.fxWorkletModuleReady.catch((error: unknown) => {
            this.fxWorkletModuleReady = null;
            throw error;
        });
    }

    /** Request Web MIDI permission only after a user-triggered explicit call. */
    public connectMidiInput(target?: BrowserMidiInputTarget): Promise<MidiInputState> {
        if (!target) {
            this.clearHrmAutoMidiTarget();
            return this.midiInput.connect();
        }
        if (target.effectId !== 'hrm_auto_m') {
            this.clearHrmAutoMidiTarget();
            return this.midiInput.connect();
        }
        const slotIndex = this.slotIndex(target.slot);
        const instances = target.path === 'input' ? this.inputFxInstances : this.trackFxInstances;
        const fx = instances[slotIndex];
        if (!(fx instanceof BrowserHrmAutoFX)) {
            this.clearHrmAutoMidiTarget();
            this.lastError = `Selected HRM AUTO (M) slot ${target.path.toUpperCase()} ${target.slot} is unavailable.`;
            this.emitStatus();
            return Promise.resolve('error');
        }
        this.selectHrmAutoMidiTarget(target, fx);
        return this.midiInput.connect();
    }

    public disconnectMidiInput(): void {
        this.midiInput.disconnect();
        this.clearHrmAutoMidiTarget();
    }

    public getMidiInputState(): MidiInputState {
        return this.midiInputState;
    }

    public onMidiInputStateChange(listener: (state: MidiInputState) => void): () => void {
        this.midiInputListeners.add(listener);
        listener(this.midiInputState);
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
        const selectedAuto = this.selectedHrmAutoMidiTarget?.effect;
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

    private selectHrmAutoMidiTarget(target: BrowserMidiInputTarget, effect: BrowserHrmAutoFX): void {
        if (this.selectedHrmAutoMidiTarget?.effect === effect) return;
        this.clearHrmAutoMidiTarget();
        this.selectedHrmAutoMidiTarget = { path: target.path, slot: target.slot, effect };
    }

    private clearHrmAutoMidiTarget(): void {
        this.selectedHrmAutoMidiTarget?.effect.clearMidiState();
        this.selectedHrmAutoMidiTarget = null;
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
        for (const [key, value] of Object.entries(parameters)) {
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
            message: this.initialized ? 'BROWSER AUDIO READY' : 'BROWSER AUDIO NOT INITIALIZED',
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
        return navigator.mediaDevices.getUserMedia(this.createInputConstraints(deviceId));
    }

    private replaceInputStream(stream: MediaStream) {
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
        this.currentInputStream.connect(this.inputFxChain.input);
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
