import { TrackAudio } from './TrackAudio';
import { Track, TrackState, TransportState } from '../core/types';
import { Transport } from '../core/Transport';
import { FXChain } from './FXChain';
import type { FXBase } from './fx/FXBase';
import { FilterFX } from './fx/FilterFX';
import { DelayFX } from './fx/DelayFX';
import { ReverbFX } from './fx/ReverbFX';
import { SlicerFX } from './fx/SlicerFX';
import { PhaserFX } from './fx/PhaserFX';

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
  loopRecordingChannelCount: 1;
  loopPlaybackOutputChannelCount: 2;
  loopChannelLayout: 'mono input downmix, duplicated to stereo playback';
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
}

export interface BrowserAudioUiStatus {
    mode: 'browser';
    bridgeAvailable: boolean;
    engineRunning: boolean;
    ready: boolean;
    message: string;
    lastError: string;
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

    // FX Chains & Mixing
    public inputFxChain: FXChain;
    public outputFxChain: FXChain;
    public trackMixNode: GainNode;
    public masterGainNode: GainNode;

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
    private lastError = '';
    private transportListenersInstalled = false;

    private readonly handleTransportStart = () => {
        void this.realtimeRuntime?.setClock(true).catch((error) => this.recordRuntimeError(error));
    };
    private readonly handleTransportStop = () => {
        void this.realtimeRuntime?.setClock(false).catch((error) => this.recordRuntimeError(error));
    };
    private readonly handleTransportBpmChange = () => {
        void this.realtimeRuntime?.setBpm(Transport.getInstance().bpm).catch((error) => this.recordRuntimeError(error));
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

        // Initialize Rhythm Engine
        this.rhythmEngine = new RhythmEngine(this.context);
        this.rhythmEngine.connect(this.masterGainNode);

        // Initialize 5 tracks
        for (let i = 0; i < 5; i++) {
            const trackData = new Track(i + 1);
            this.tracks.push(new TrackAudio(this, trackData, i, this.trackStates, this.trackPositions));
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

            if (this.context.state === 'suspended') {
                await this.context.resume();
            }

            await this.context.audioWorklet.addModule(BROWSER_REALTIME_WORKLET_URL);

            if (!this.workletNode || !this.realtimeRuntime) {
                const controlBuffer = this.sharedBuffer;
                const workletNode = new AudioWorkletNode(this.context, BROWSER_REALTIME_WORKLET_NAME, {
                    numberOfInputs: 1,
                    numberOfOutputs: 7,
                    outputChannelCount: [2, 2, 2, 2, 2, 2, 2],
                    channelCount: 2,
                    channelCountMode: 'explicit',
                    processorOptions: { controlBuffer },
                });
                this.workletNode = workletNode;
                this.realtimeRuntime = new BrowserRealtimeRuntime(workletNode, controlBuffer, this.context.sampleRate);
                this.realtimeRuntime.setMessageHandler((message) => this.handleRuntimeMessage(message));

                this.inputFxChain.output.connect(workletNode, 0, 0);
                for (let track = 0; track < this.tracks.length; track += 1) {
                    workletNode.connect(this.tracks[track]!.fxChain.input, track, 0);
                }
                workletNode.connect(this.monitorGainNode!, 5, 0);
                workletNode.connect(this.rhythmEngine.outputNode, 6, 0);
                await this.realtimeRuntime.prepareAllTracks();
                this.rhythmEngine.setRealtimeControl((running, pattern) => {
                    void this.realtimeRuntime?.setRhythm(running, pattern).catch((error) => this.recordRuntimeError(error));
                });
            }

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
            void this.realtimeRuntime.setBpm(transport.bpm).catch((error) => this.recordRuntimeError(error));
            if (transport.state === TransportState.PLAYING) {
                void this.realtimeRuntime.setClock(true).catch((error) => this.recordRuntimeError(error));
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
            this.replaceInputStream(stream, deviceId || null);
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
                    this.replaceInputStream(fallbackStream, null);
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
    public async setOutputDevice(deviceId: string) {
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

    // FX Instances for Input and Track (4 slots each: A, B, C, D)
    private inputFxInstances: (FXBase | null)[] = [null, null, null, null];
    private trackFxInstances: (FXBase | null)[] = [null, null, null, null];
    private inputFxTypes: (string | null)[] = [null, null, null, null];
    private trackFxTypes: (string | null)[] = [null, null, null, null];

    /**
     * Set FX Type for a specific slot
     * @param location 'input' or 'track'
     * @param slotIndex 0-3 (A-D)
     * @param type 'FILTER' | 'DELAY' | 'REVERB' | 'SLICER'
     */
    public setFxType(location: 'input' | 'track', slotIndex: number, type: string) {
        if (slotIndex < 0 || slotIndex > 3) return;

        const fxTypes = location === 'input' ? this.inputFxTypes : this.trackFxTypes;
        if (fxTypes[slotIndex] === type) {
            return;
        }

        const newFx = this.createFxInstance(type);
        if (!newFx) {
            console.warn(`Unknown FX type: ${type}`);
            return;
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
            this.rebuildOutputChain();
        }

        console.log(`FX Set: ${location.toUpperCase()} [${['A', 'B', 'C', 'D'][slotIndex]}] -> ${type}`);
    }

    private createFxInstance(type: string): FXBase | null {
        const context = this.context;

        switch (type) {
            case 'FILTER':
                return new FilterFX(context);
            case 'DELAY':
                return new DelayFX(context);
            case 'REVERB':
                return new ReverbFX(context);
            case 'SLICER':
                return new SlicerFX(context);
            case 'PHASER':
                return new PhaserFX(context);
            default:
                return null;
        }
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
     * Rebuild the entire Output FX Chain
     * TrackMix -> Slot A -> Slot B -> Slot C -> Slot D -> MasterGain
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
                fx.setParam('frequency', value / 100);
            } else if (fx.name === 'COMPRESSOR') {
                fx.setParam('amount', value / 100);
            } else if (fx instanceof ReverbFX) {
                fx.setParam('mix', value / 100);
            } else if (fx instanceof DelayFX) {
                fx.setParam('mix', value / 100);
            } else if (fx instanceof SlicerFX) {
                fx.setParam('rate', value);
            } else if (fx instanceof PhaserFX) {
                fx.setParam('rate', value);
            }
        }
    }

    /**
     * Set FX Active/Bypass
     */
    public setFxActive(location: 'input' | 'track', slotIndex: number, active: boolean) {
        const instances = location === 'input' ? this.inputFxInstances : this.trackFxInstances;
        const fx = instances[slotIndex];
        if (fx) {
            fx.setBypass(!active);
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

        if (this.realtimeRuntime) {
            void this.realtimeRuntime.enqueue(BrowserRealtimeOpcode.SET_MONITOR, -1, enabled ? 1 : 0)
                .catch((error) => this.recordRuntimeError(error));
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
            quantumFrames: BROWSER_REALTIME_QUANTUM_FRAMES,
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
        };
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
            loopRecordingChannelCount: 1,
            loopPlaybackOutputChannelCount: 2,
            loopChannelLayout: 'mono input downmix, duplicated to stereo playback',
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
        };
    }

    private installTransportListeners() {
        if (this.transportListenersInstalled) return;
        const transport = Transport.getInstance();
        transport.on('start', this.handleTransportStart);
        transport.on('stop', this.handleTransportStop);
        transport.on('bpm-change', this.handleTransportBpmChange);
        this.transportListenersInstalled = true;
    }

    private handleRuntimeMessage(message: BrowserRealtimeRuntimeMessage) {
        if (message.type === 'CLOCK_TICK' && typeof message.beatOrdinal === 'number' && typeof message.frame === 'number') {
            Transport.getInstance().emitWorkletBeat(message.beatOrdinal, message.frame);
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

    public get isReady() {
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

        await this.realtimeRuntime.armLoopbackCapture(captureBuffer, captureStartFrame, captureFrames);
        const osc = this.context.createOscillator();
        const oscGain = this.context.createGain();
        osc.type = 'sine';
        osc.frequency.value = 1000;
        oscGain.gain.value = 0.05;
        osc.connect(oscGain);
        oscGain.connect(this.context.destination);
        const signalTime = signalFrame / this.context.sampleRate;
        try {
            osc.start(signalTime);
            osc.stop(signalTime + 0.12);
            await captureComplete;
        } finally {
            try { osc.disconnect(); } catch { /* already disconnected */ }
            try { oscGain.disconnect(); } catch { /* already disconnected */ }
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
        const supported = navigator.mediaDevices.getSupportedConstraints?.() as (MediaTrackSupportedConstraints & { latency?: boolean }) | undefined;
        const audio: MediaTrackConstraints & { latency?: ConstrainDouble } = {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            sampleRate: { ideal: this.context.sampleRate },
            channelCount: { ideal: 1 },
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

    private replaceInputStream(stream: MediaStream, requestedDeviceId: string | null) {
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
