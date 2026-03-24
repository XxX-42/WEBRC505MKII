import type { IAudioEngine } from './AudioEngineInterface';
import {
    applyRecordingOffset,
    getBrowserRecordingOffsetConfig,
    shiftBufferWithRecordingOffset,
} from './browserRecordingOffset';
import { FXChain } from './FXChain';
import { Track, TrackState, TransportState } from '../core/types';
import { Transport } from '../core/Transport';

export class TrackAudio {
    public track: Track;
    public state: TrackState = TrackState.EMPTY;

    private engine: IAudioEngine;
    private transport: Transport;
    private audioBuffer: AudioBuffer | null = null;
    private sourceNode: AudioBufferSourceNode | null = null;
    private gainNode: GainNode;
    private panNode: StereoPannerNode;
    public fxChain: FXChain;

    // Recording state
    private isRecording: boolean = false;
    public isReverse: boolean = false;


    private workletNode: AudioWorkletNode | null = null;
    private overdubProcessor: ScriptProcessorNode | null = null;
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

    public get disabledReason(): string {
        return '';
    }

    public get transportEnabled(): boolean {
        return true;
    }

    private getBrowserRecordingOffsetConfig() {
        return getBrowserRecordingOffsetConfig(this.engine.context.sampleRate, {
            inputDeviceId: this.engine.selectedInputDeviceId ?? null,
            outputDeviceId: this.engine.selectedOutputDeviceId ?? null,
            sampleRate: this.engine.context.sampleRate,
            bufferFrames: this.engine.selectedBufferFrames ?? 128,
        });
    }

    private startPositionUpdater() {
        const update = () => {
            // Update State
            if (this.sharedStates) {
                Atomics.store(this.sharedStates, this.trackIndex, Object.values(TrackState).indexOf(this.state));
            }

            // Update Position
            if (this.state === TrackState.PLAYING && this.audioBuffer && this.sourceNode) {
                const ctx = this.engine.context;
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
                    const progress = (ctx.currentTime % duration) / duration;
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

    // --- Transport & State Logic ---

    public triggerRecord() {
        if (this.state === TrackState.EMPTY) {
            this.scheduleRecordingStart();
        } else if (this.state === TrackState.RECORDING) {
            this.scheduleRecordingStop();
        } else if (this.state === TrackState.PLAYING) {
            this.state = TrackState.OVERDUBBING;
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
            return;
        }

        this.stop();
        this.state = TrackState.STOPPED;
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

    public async startRecording() {
        if (this.isRecording) return;

        const ctx = this.engine.context;
        const input = await this.engine.getProcessedInputNode();
        this.resumeAfterRecording = true;

        const workletNode = new AudioWorkletNode(ctx, 'looper-processor');

        workletNode.port.onmessage = (event) => {
            if (event.data.type === 'RECORD_COMPLETE') {
                const rawBuffer = event.data.buffer;
                if (rawBuffer.length > 0) {
                    this.processRecordedBuffer(rawBuffer);
                }
            }
        };

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
        this.workletNode.port.postMessage({ type: 'STOP_RECORD' });

        setTimeout(() => {
            if (this.workletNode) {
                this.workletNode.port.onmessage = null;
                this.workletNode.disconnect();
                this.workletNode = null;
            }
        }, 100);
    }

    private processRecordedBuffer(rawBuffer: Float32Array) {
        const ctx = this.engine.context;
        const browserOffset = this.getBrowserRecordingOffsetConfig();
        const latencySamples = Math.round(this.engine.roundTripLatency * ctx.sampleRate);

        let startOffset = Math.max(0, latencySamples);
        if (startOffset >= rawBuffer.length) startOffset = 0;

        const compensatedLength = rawBuffer.length - startOffset;
        const compensatedBuffer = new Float32Array(compensatedLength);
        compensatedBuffer.set(rawBuffer.subarray(startOffset));
        const offsetCompensatedBuffer = shiftBufferWithRecordingOffset(compensatedBuffer, browserOffset.recordingOffsetSamples);

        const durationSeconds = offsetCompensatedBuffer.length / ctx.sampleRate;
        const lengthSamples = offsetCompensatedBuffer.length;

        console.log(`Track ${this.track.id} recorded: ${durationSeconds.toFixed(2)}s (${lengthSamples} samples)`);

        // ========================================
        // MASTER / SLAVE LOGIC
        // ========================================

        let finalBufferData = offsetCompensatedBuffer;

        if (!this.transport.hasMasterTrack()) {
            // This is the first track - it becomes the master
            console.log(`\n🎯 Track ${this.track.id} is becoming the MASTER track`);

            // Set master track with enhanced BPM calculation
            this.transport.setMasterTrack(
                this.track.id,
                durationSeconds,
                ctx.sampleRate,
                lengthSamples
            );

            // Start global transport
            this.transport.start();

            console.log(`✓ Global transport started with calculated BPM\n`);
        } else {
            // This is a slave track - Apply Hard Quantization (Drift Fix)
            const masterLength = this.transport.masterLoopLengthSamples;

            // Calculate ratio (how many measures)
            let ratio = Math.round(lengthSamples / masterLength);
            if (ratio < 1) ratio = 1; // Minimum 1 loop

            const perfectLength = ratio * masterLength;

            console.log(`Track ${this.track.id} recorded as SLAVE track (Master: Track ${this.transport.masterTrackId})`);
            console.log(`Drift Fix: Resized track from ${lengthSamples} to ${perfectLength} (Exact multiple: ${ratio})`);

            // Resize buffer
            if (lengthSamples !== perfectLength) {
                const resizedBuffer = new Float32Array(perfectLength);

                if (lengthSamples > perfectLength) {
                    // Slice (Truncate)
                    resizedBuffer.set(offsetCompensatedBuffer.subarray(0, perfectLength));
                } else {
                    // Pad (Fill with zeros - default behavior of new Float32Array)
                    resizedBuffer.set(offsetCompensatedBuffer);
                }

                finalBufferData = resizedBuffer;
            }
        }

        // Create final AudioBuffer
        this.audioBuffer = ctx.createBuffer(1, finalBufferData.length, ctx.sampleRate);
        this.audioBuffer.copyToChannel(new Float32Array(finalBufferData), 0);

        if (this.resumeAfterRecording) {
            this.state = TrackState.PLAYING;
            this.play();
        } else {
            this.state = TrackState.STOPPED;
        }

        this.resumeAfterRecording = true;
    }

    public play() {
        if (!this.audioBuffer) return;

        this.stop();

        const ctx = this.engine.context;
        this.sourceNode = ctx.createBufferSource();
        this.sourceNode.buffer = this.audioBuffer;
        this.sourceNode.loop = true;
        this.sourceNode.connect(this.fxChain.input);

        // Reverse Playback Support
        if (this.isReverse) {
            this.sourceNode.playbackRate.value = -1;
        }

        this.sourceNode.start(0, this.startOffset);
        this.startTime = ctx.currentTime;

        this.state = TrackState.PLAYING;
    }

    public stop() {
        if (this.sourceNode) {
            this.sourceNode.stop();
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }
        this.state = TrackState.STOPPED;
    }

    public clear() {
        this.cancelQuantizeWait();
        this.abortRecording();
        this.stopOverdub();
        this.stop();
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

        console.log(`Track ${this.track.id} cleared`);
    }

    public toggleReverse() {
        this.isReverse = !this.isReverse;
        console.log(`Track ${this.track.id} reverse: ${this.isReverse}`);

        if (this.state === TrackState.PLAYING && this.sourceNode && this.audioBuffer) {
            // We need to restart playback to reset the time anchor for accurate position tracking
            const ctx = this.engine.context;
            const now = ctx.currentTime;
            const elapsed = now - this.startTime;
            const duration = this.audioBuffer.duration;

            // Calculate current position where we stopped
            let currentPos = 0;
            if (!this.isReverse) {
                // Was Reverse, Now Forward
                // Previous state was Reverse.
                // Pos = (Offset - elapsed) % duration
                // But wait, the logic below uses samples.
                // Let's stick to seconds for start() offset.

                // If we were Reverse:
                // We started at startOffset, went backwards for elapsed.
                // currentPos = startOffset - elapsed
                currentPos = this.startOffset - elapsed;
            } else {
                // Was Forward, Now Reverse
                // We started at startOffset, went forward for elapsed.
                currentPos = this.startOffset + elapsed;
            }

            // Wrap around
            while (currentPos < 0) currentPos += duration;
            while (currentPos >= duration) currentPos -= duration;

            this.startOffset = currentPos;

            // Restart Source
            this.sourceNode.stop();
            this.sourceNode.disconnect();

            this.sourceNode = ctx.createBufferSource();
            this.sourceNode.buffer = this.audioBuffer;
            this.sourceNode.loop = true;
            this.sourceNode.connect(this.fxChain.input);

            this.sourceNode.playbackRate.value = this.isReverse ? -1 : 1;
            this.sourceNode.start(0, this.startOffset);

            this.startTime = now;
        }
    }


    // ========================================
    // OVERDUB LOGIC (ScriptProcessor)
    // ========================================

    private async startOverdub() {
        if (!this.audioBuffer) return;

        const ctx = this.engine.context;
        const input = await this.engine.getProcessedInputNode();

        // Create ScriptProcessor for real-time buffer manipulation
        // Buffer size 4096 gives ~92ms latency, acceptable for overdub processing loop
        this.overdubProcessor = ctx.createScriptProcessor(4096, 1, 1);

        this.overdubProcessor.onaudioprocess = (e) => {
            // Capture audioBuffer locally to satisfy TypeScript null checks in callback
            const audioBuffer = this.audioBuffer;
            if (this.state !== TrackState.OVERDUBBING || !audioBuffer) return;

            const inputData = e.inputBuffer.getChannelData(0);
            const trackBuffer = audioBuffer.getChannelData(0);
            const outputData = e.outputBuffer.getChannelData(0);
            const bufferLen = trackBuffer.length;

            if (bufferLen === 0) return;

            // Calculate current position in the track buffer
            const currentTime = e.playbackTime;
            const elapsedTime = currentTime - this.startTime;
            const rawSampleOffset = Math.floor(elapsedTime * ctx.sampleRate);
            const startSampleOffset = Math.floor(this.startOffset * ctx.sampleRate);

            const browserOffset = this.getBrowserRecordingOffsetConfig();
            // Existing browser path compensation plus user recording-offset trim.
            const latencySamples = Math.floor(this.engine.roundTripLatency * ctx.sampleRate);
            const userOffsetSamples = browserOffset.recordingOffsetSamples;

            for (let i = 0; i < inputData.length; i++) {
                let playIdx: number;
                let writeIdx: number;

                if (this.isReverse) {
                    // Reverse Playback Logic
                    // Pos = (StartOffset - (Elapsed + i))
                    let pos = (startSampleOffset - (rawSampleOffset + i));

                    // Wrap
                    while (pos < 0) pos += bufferLen;
                    pos = pos % bufferLen;

                    playIdx = pos;

                    const baseWriteIdx = playIdx + latencySamples;
                    writeIdx = applyRecordingOffset(baseWriteIdx, userOffsetSamples, bufferLen);
                } else {
                    // Forward Playback Logic
                    // Pos = (StartOffset + (Elapsed + i))
                    let pos = (startSampleOffset + (rawSampleOffset + i));

                    playIdx = pos % bufferLen;

                    const baseWriteIdx = playIdx - latencySamples;
                    writeIdx = applyRecordingOffset(baseWriteIdx, userOffsetSamples, bufferLen);
                }

                // Add input to the past position
                trackBuffer[writeIdx]! += inputData[i]!;

                // Output current track position
                outputData[i] = trackBuffer[playIdx]!;
            }
        };

        // Connect: Input -> Processor -> Destination (mute processor output to avoid double monitoring)
        // We only need the processor to run, so we connect it to a Gain(0) -> Destination
        const muteGain = ctx.createGain();
        muteGain.gain.value = 0;

        input.connect(this.overdubProcessor);
        this.overdubProcessor.connect(muteGain);
        muteGain.connect(ctx.destination);
    }

    private stopOverdub() {
        if (this.overdubProcessor) {
            this.overdubProcessor.disconnect();
            this.overdubProcessor = null;
        }
    }

    private abortRecording() {
        this.isRecording = false;
        this.resumeAfterRecording = false;

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
