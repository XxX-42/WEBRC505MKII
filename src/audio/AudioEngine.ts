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

import { RhythmEngine } from './RhythmEngine';
import type { IAudioEngine } from './AudioEngineInterface';

export interface LatencyInfo {
    sampleRate: number;
    baseLatencyMs: number | null;
    outputLatencyMs: number | null;
    estimatedMonitoringLatencyMs: number | null;
    roundTripLatencyMs: number | null;
}

export class AudioEngine implements IAudioEngine {
    private static instance: AudioEngine;
    public context: AudioContext;
    public workletNode: AudioWorkletNode | null = null;
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
    public monitoringEnabled: boolean = false; // DEFAULT: FALSE to prevent feedback!
    private monitoringListeners = new Set<(enabled: boolean) => void>();
    private latencyListeners = new Set<(info: LatencyInfo) => void>();

    private constructor() {
        this.context = new AudioContext({
            latencyHint: 'interactive',
            sampleRate: 44100,
        });

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
            this.tracks.push(new TrackAudio(this, trackData, i, this.trackStates, this.trackPositions));
        }

        // Load saved device preferences
        this.loadDevicePreferences();
    }

    public static getInstance(): AudioEngine {
        if (!AudioEngine.instance) {
            AudioEngine.instance = new AudioEngine();
        }
        return AudioEngine.instance;
    }

    public async init() {
        if (this.context.state === 'suspended') {
            await this.context.resume();
        }

        try {
            await this.context.audioWorklet.addModule('/worklets/looper-processor.js');
            console.log('AudioWorklet module loaded');
        } catch (e) {
            console.error('Failed to load AudioWorklet module', e);
        }

        // Initialize with saved or default input device
        if (this.selectedInputDeviceId) {
            await this.setInputDevice(this.selectedInputDeviceId);
        }

        // Initialize output device
        if (this.selectedOutputDeviceId) {
            await this.setOutputDevice(this.selectedOutputDeviceId);
        }

        this.emitLatencyInfo();
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
        console.log(`\n🎤 Switching input device to: ${deviceId}`);

        try {
            const stream = await this.requestInputStream(deviceId);
            this.replaceInputStream(stream);

            this.selectedInputDeviceId = deviceId || null;
            this.saveDevicePreferences();

            console.log('  ✓ New input device connected');
            console.log(`  ⚠️  Monitoring: ${this.monitoringEnabled ? 'ENABLED' : 'DISABLED (SAFE)'}\n`);

        } catch (error) {
            if (deviceId && this.shouldFallbackToDefaultInput(error)) {
                console.warn('  Requested input device is unavailable or overconstrained. Falling back to the default microphone.');
                try {
                    const fallbackStream = await this.requestInputStream('');
                    this.replaceInputStream(fallbackStream);
                    this.selectedInputDeviceId = null;
                    this.saveDevicePreferences();
                    console.log('  ✓ Default input device connected');
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
        console.log(`\n🔊 Switching output device to: ${deviceId}`);

        try {
            // Use setSinkId if available (Chrome/Edge)
            if ('setSinkId' in this.context) {
                await (this.context as any).setSinkId(deviceId);
                this.selectedOutputDeviceId = deviceId;
                this.saveDevicePreferences();
                console.log('  ✓ Output device changed\n');
            } else {
                console.warn('  ⚠️  setSinkId not supported in this browser\n');
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
                fx.setParam('frequency', value); // 0-100 -> mapped inside
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

        if (this.monitorGainNode) {
            // Smooth transition to prevent clicks
            this.monitorGainNode.gain.setTargetAtTime(
                enabled ? 1.0 : 0.0,
                this.context.currentTime,
                0.01
            );
        }

        console.log(`\n🎧 Software Monitoring: ${enabled ? 'ENABLED ⚠️' : 'DISABLED (SAFE)'}`);
        if (enabled) {
            console.log('  ⚠️  WARNING: Use headphones only! Speakers will cause feedback!\n');
        } else {
            console.log('  ✓ Safe mode - no direct monitoring\n');
        }

        this.monitoringListeners.forEach(listener => listener(this.monitoringEnabled));
    }

    public onMonitoringChange(listener: (enabled: boolean) => void) {
        this.monitoringListeners.add(listener);
        return () => {
            this.monitoringListeners.delete(listener);
        };
    }

    public getLatencyInfo(): LatencyInfo {
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

    public onLatencyInfoChange(listener: (info: LatencyInfo) => void) {
        this.latencyListeners.add(listener);
        listener(this.getLatencyInfo());
        return () => {
            this.latencyListeners.delete(listener);
        };
    }

    // ========================================
    // DEVICE PREFERENCES (LOCALSTORAGE)
    // ========================================

    private saveDevicePreferences() {
        try {
            localStorage.setItem('audioInputDeviceId', this.selectedInputDeviceId || '');
            localStorage.setItem('audioOutputDeviceId', this.selectedOutputDeviceId || '');
            console.log('  💾 Device preferences saved');
        } catch (error) {
            console.warn('Failed to save device preferences:', error);
        }
    }

    private loadDevicePreferences() {
        try {
            this.selectedInputDeviceId = localStorage.getItem('audioInputDeviceId') || null;
            this.selectedOutputDeviceId = localStorage.getItem('audioOutputDeviceId') || null;

            if (this.selectedInputDeviceId || this.selectedOutputDeviceId) {
                console.log('📂 Loaded saved device preferences');
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

        console.log('🔔 Test tone played (440Hz, 200ms)');
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

        let stream: MediaStream;
        try {
            stream = await this.getTestStream();
        } catch (e) {
            console.error('Failed to get test stream', e);
            throw new Error('Could not access microphone. Check permissions.');
        }

        const source = this.context.createMediaStreamSource(stream);
        const recorder = this.context.createScriptProcessor(4096, 1, 1);
        const recordingBuffer = new Float32Array(this.context.sampleRate * 1.0);
        let writeIndex = 0;

        recorder.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            if (writeIndex < recordingBuffer.length) {
                const len = Math.min(input.length, recordingBuffer.length - writeIndex);
                recordingBuffer.set(input.subarray(0, len), writeIndex);
                writeIndex += len;
            }
        };

        const mute = this.context.createGain();
        mute.gain.value = 0;
        source.connect(recorder);
        recorder.connect(mute);
        mute.connect(this.context.destination);

        const osc = this.context.createOscillator();
        const oscGain = this.context.createGain();
        osc.frequency.value = 1000;
        oscGain.gain.value = 0.8;
        osc.connect(oscGain);
        oscGain.connect(this.context.destination);

        const now = this.context.currentTime;
        const signalDelay = 0.1;
        osc.start(now + signalDelay);
        osc.stop(now + signalDelay + 0.05);

        await new Promise(resolve => setTimeout(resolve, 1200));

        osc.disconnect();
        oscGain.disconnect();
        source.disconnect();
        recorder.disconnect();
        mute.disconnect();
        stream.getTracks().forEach(t => t.stop());

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
            console.log('  ✓ Disconnected old input node');
        }

        if (this.currentMediaStream) {
            this.currentMediaStream.getTracks().forEach(track => track.stop());
            console.log('  ✓ Stopped old input stream');
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
}
