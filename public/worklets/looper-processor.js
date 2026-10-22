const DEFAULT_CHUNK_SIZE = 16384;
const DEFAULT_CHUNK_POOL_SIZE = 3;
const DEFAULT_MAX_RECORDING_CHUNKS = 65536;
const DEFAULT_MAX_RECORDING_FRAMES = DEFAULT_CHUNK_SIZE * DEFAULT_MAX_RECORDING_CHUNKS;
const MAX_CAPTURE_CHANNELS = 2;
const BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT;

class LooperProcessor extends AudioWorkletProcessor {
    constructor(options = {}) {
        super();

        const processorOptions = options.processorOptions || {};
        this.chunkSize = this.positiveInteger(processorOptions.chunkSize, DEFAULT_CHUNK_SIZE);
        this.chunkPoolSize = this.positiveInteger(processorOptions.chunkPoolSize, DEFAULT_CHUNK_POOL_SIZE);
        this.configuredMaxRecordingFrames = this.positiveInteger(
            processorOptions.maxRecordingFrames,
            DEFAULT_MAX_RECORDING_FRAMES,
        );
        this.maxRecordingBytes = this.positiveInteger(
            processorOptions.maxRecordingBytes,
            this.configuredMaxRecordingFrames * BYTES_PER_SAMPLE,
        );

        // Fixed pool; a slot is null only while its transferred buffer is on the main thread.
        this.chunkBuffers = new Array(this.chunkPoolSize);
        for (let index = 0; index < this.chunkPoolSize; index += 1) {
            this.chunkBuffers[index] = [new Float32Array(this.chunkSize), new Float32Array(this.chunkSize)];
        }

        // Reused for every transfer so a full chunk boundary does not create message/list objects.
        this.chunkMessage = {
            type: 'RECORD_CHUNK',
            chunkIndex: 0,
            sequence: 0,
            validFrames: 0,
            channelCount: 1,
            samples: null,
            channels: null,
        };
        this.chunkTransferList = [null, null];
        this.completeMessage = {
            type: 'RECORD_COMPLETE',
            framesCaptured: 0,
            droppedFrames: 0,
            overflowEvents: 0,
            maxRecordingFrames: 0,
            maxRecordingBytes: this.maxRecordingBytes,
            channelCount: 0,
            limitReached: false,
            chunksSent: 0,
        };

        this.isRecording = false;
        // Keep the inserted passthrough alive until capture is explicitly
        // stopped, then let AudioWorklet retire this one-shot node. Returning
        // true forever keeps the processor scheduled after TrackAudio disconnects it.
        this.shouldContinue = true;
        this.captureChannelCount = 0;
        this.maxRecordingFrames = this.configuredMaxRecordingFrames;
        this.blocksProcessed = 0;
        this.framesCaptured = 0;
        this.chunksSent = 0;
        this.droppedFrames = 0;
        this.overflowEvents = 0;
        this.limitReached = false;
        this.overflowActive = false;
        this.activeChunkIndex = -1;
        this.activeChunkOffset = 0;

        this.port.onmessage = (event) => {
            const message = event.data;
            if (!message) return;

            if (message.type === 'START_RECORD') {
                this.startRecording();
            } else if (message.type === 'STOP_RECORD') {
                this.stopRecording();
            } else if (message.type === 'RECYCLE_CHUNK') {
                this.recycleChunk(message.chunkIndex, message.samples, message.channels);
            }
        };
    }

    positiveInteger(value, fallback) {
        return Number.isInteger(value) && value > 0 ? value : fallback;
    }

    startRecording() {
        if (this.isRecording) return;
        this.isRecording = true;
        this.framesCaptured = 0;
        this.captureChannelCount = 0;
        this.maxRecordingFrames = this.configuredMaxRecordingFrames;
        this.droppedFrames = 0;
        this.overflowEvents = 0;
        this.limitReached = false;
        this.overflowActive = false;
        this.activeChunkIndex = -1;
        this.activeChunkOffset = 0;
    }

    stopRecording() {
        if (!this.isRecording) return;
        this.isRecording = false;
        this.shouldContinue = false;

        if (this.activeChunkIndex >= 0 && this.activeChunkOffset > 0) {
            this.sendChunk(this.activeChunkIndex, this.activeChunkOffset);
        }
        this.activeChunkIndex = -1;
        this.activeChunkOffset = 0;

        this.completeMessage.framesCaptured = this.framesCaptured;
        this.completeMessage.droppedFrames = this.droppedFrames;
        this.completeMessage.overflowEvents = this.overflowEvents;
        this.completeMessage.maxRecordingFrames = this.maxRecordingFrames;
        this.completeMessage.maxRecordingBytes = this.maxRecordingBytes;
        this.completeMessage.channelCount = this.captureChannelCount;
        this.completeMessage.limitReached = this.limitReached;
        this.completeMessage.chunksSent = this.chunksSent;
        this.port.postMessage(this.completeMessage);
    }

    recycleChunk(chunkIndex, samples, channels) {
        if (
            Number.isInteger(chunkIndex) &&
            chunkIndex >= 0 &&
            chunkIndex < this.chunkPoolSize &&
            (Array.isArray(channels) || samples instanceof Float32Array)
        ) {
            const recycled = Array.isArray(channels) ? channels : [samples];
            if (recycled.length !== this.captureChannelCount || recycled.some((channel) =>
                !(channel instanceof Float32Array) || channel.length !== this.chunkSize
            )) return;
            this.chunkBuffers[chunkIndex] = recycled;
        }
    }

    findAvailableChunk() {
        for (let index = 0; index < this.chunkPoolSize; index += 1) {
            if (this.chunkBuffers[index]) return index;
        }
        return -1;
    }

    noteDroppedFrame() {
        this.droppedFrames += 1;
        if (!this.overflowActive) {
            this.overflowEvents += 1;
            this.overflowActive = true;
        }
    }

    configureCaptureChannels(inputChannelCount) {
        if (this.captureChannelCount > 0) return;
        this.captureChannelCount = Math.max(1, Math.min(MAX_CAPTURE_CHANNELS, inputChannelCount));
        this.maxRecordingFrames = Math.min(
            this.configuredMaxRecordingFrames,
            Math.floor(this.maxRecordingBytes / BYTES_PER_SAMPLE / this.captureChannelCount),
        );
        if (this.captureChannelCount === 1) {
            // A mono stream only transfers/retains its left sample array.
            // Drop the unused right-side pool arrays before capture grows.
            for (let slot = 0; slot < this.chunkBuffers.length; slot += 1) {
                this.chunkBuffers[slot].length = 1;
            }
        }
        this.port.postMessage({
            type: 'RECORD_CONFIGURED',
            channelCount: this.captureChannelCount,
            maxRecordingFrames: this.maxRecordingFrames,
            maxRecordingBytes: this.maxRecordingBytes,
        });
    }

    recordFrame(leftSample, rightSample) {
        if (this.captureChannelCount === 0) return;
        if (this.framesCaptured >= this.maxRecordingFrames) {
            this.limitReached = true;
            this.noteDroppedFrame();
            return;
        }

        if (this.activeChunkIndex < 0) {
            this.activeChunkIndex = this.findAvailableChunk();
            this.activeChunkOffset = 0;
            if (this.activeChunkIndex < 0) {
                this.noteDroppedFrame();
                return;
            }
        }

        const chunkChannels = this.chunkBuffers[this.activeChunkIndex];
        if (!chunkChannels || chunkChannels.length !== this.captureChannelCount) {
            this.activeChunkIndex = -1;
            this.activeChunkOffset = 0;
            this.noteDroppedFrame();
            return;
        }

        chunkChannels[0][this.activeChunkOffset] = leftSample;
        if (this.captureChannelCount > 1) chunkChannels[1][this.activeChunkOffset] = rightSample;
        this.activeChunkOffset += 1;
        this.framesCaptured += 1;
        this.overflowActive = false;

        if (this.activeChunkOffset === this.chunkSize) {
            this.sendChunk(this.activeChunkIndex, this.chunkSize);
        }
    }

    sendChunk(chunkIndex, validFrames) {
        const channels = this.chunkBuffers[chunkIndex];
        if (!channels) return;

        this.chunkBuffers[chunkIndex] = null;
        this.chunkMessage.chunkIndex = chunkIndex;
        this.chunkMessage.sequence = this.chunksSent;
        this.chunkMessage.validFrames = validFrames;
        this.chunkMessage.channelCount = this.captureChannelCount;
        this.chunkMessage.samples = channels[0];
        this.chunkMessage.channels = channels;
        this.chunkTransferList.length = this.captureChannelCount;
        for (let channel = 0; channel < this.captureChannelCount; channel += 1) {
            this.chunkTransferList[channel] = channels[channel].buffer;
        }
        this.port.postMessage(this.chunkMessage, this.chunkTransferList);
        this.chunksSent += 1;

        this.activeChunkIndex = -1;
        this.activeChunkOffset = 0;
    }

    process(inputs, outputs) {
        this.blocksProcessed += 1;
        const input = inputs[0];
        const output = outputs[0];
        const inputChannelCount = input ? input.length : 0;
        const outputChannelCount = output ? output.length : 0;

        // Preserve monitoring with short/long channel arrays and actual callback lengths.
        if (output) {
            for (let channel = 0; channel < outputChannelCount; channel += 1) {
                const outputChannel = output[channel];
                if (!outputChannel) continue;
                const inputChannel = input && channel < inputChannelCount
                    ? input[channel]
                    : inputChannelCount === 1 ? input[0] : null;
                for (let frame = 0; frame < outputChannel.length; frame += 1) {
                    outputChannel[frame] = inputChannel && frame < inputChannel.length
                        ? inputChannel[frame]
                        : 0;
                }
            }
        }

        const inputChannel0 = input && inputChannelCount > 0 ? input[0] : null;
        if (this.isRecording && inputChannel0) {
            this.configureCaptureChannels(inputChannelCount);
            const inputChannel1 = inputChannelCount > 1 ? input[1] : null;
            for (let frame = 0; frame < inputChannel0.length; frame += 1) {
                const left = inputChannel0[frame] || 0;
                const right = inputChannel1 && frame < inputChannel1.length
                    ? inputChannel1[frame] || 0
                    : left;
                this.recordFrame(left, right);
            }
        }

        return this.shouldContinue;
    }
}

registerProcessor('looper-processor', LooperProcessor);
