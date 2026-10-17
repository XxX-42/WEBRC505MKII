const DEFAULT_CHUNK_SIZE = 16384;
const DEFAULT_CHUNK_POOL_SIZE = 3;
const DEFAULT_MAX_RECORDING_CHUNKS = 65536;
const DEFAULT_MAX_RECORDING_FRAMES = DEFAULT_CHUNK_SIZE * DEFAULT_MAX_RECORDING_CHUNKS;

class LooperProcessor extends AudioWorkletProcessor {
    constructor(options = {}) {
        super();

        const processorOptions = options.processorOptions || {};
        this.chunkSize = this.positiveInteger(processorOptions.chunkSize, DEFAULT_CHUNK_SIZE);
        this.chunkPoolSize = this.positiveInteger(processorOptions.chunkPoolSize, DEFAULT_CHUNK_POOL_SIZE);
        this.maxRecordingFrames = this.positiveInteger(
            processorOptions.maxRecordingFrames,
            DEFAULT_MAX_RECORDING_FRAMES,
        );

        // Fixed pool; a slot is null only while its transferred buffer is on the main thread.
        this.chunkBuffers = new Array(this.chunkPoolSize);
        for (let index = 0; index < this.chunkPoolSize; index += 1) {
            this.chunkBuffers[index] = new Float32Array(this.chunkSize);
        }

        // Reused for every transfer so a full chunk boundary does not create message/list objects.
        this.chunkMessage = {
            type: 'RECORD_CHUNK',
            chunkIndex: 0,
            sequence: 0,
            validFrames: 0,
            samples: null,
        };
        this.chunkTransferList = [null];
        this.completeMessage = {
            type: 'RECORD_COMPLETE',
            framesCaptured: 0,
            droppedFrames: 0,
            overflowEvents: 0,
            maxRecordingFrames: this.maxRecordingFrames,
            limitReached: false,
            chunksSent: 0,
        };

        this.isRecording = false;
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
                this.recycleChunk(message.chunkIndex, message.samples);
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

        if (this.activeChunkIndex >= 0 && this.activeChunkOffset > 0) {
            this.sendChunk(this.activeChunkIndex, this.activeChunkOffset);
        }
        this.activeChunkIndex = -1;
        this.activeChunkOffset = 0;

        this.completeMessage.framesCaptured = this.framesCaptured;
        this.completeMessage.droppedFrames = this.droppedFrames;
        this.completeMessage.overflowEvents = this.overflowEvents;
        this.completeMessage.limitReached = this.limitReached;
        this.completeMessage.chunksSent = this.chunksSent;
        this.port.postMessage(this.completeMessage);
    }

    recycleChunk(chunkIndex, samples) {
        if (
            Number.isInteger(chunkIndex) &&
            chunkIndex >= 0 &&
            chunkIndex < this.chunkPoolSize &&
            samples instanceof Float32Array &&
            samples.length === this.chunkSize
        ) {
            this.chunkBuffers[chunkIndex] = samples;
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

    recordSample(sample) {
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

        const chunk = this.chunkBuffers[this.activeChunkIndex];
        if (!chunk) {
            this.activeChunkIndex = -1;
            this.activeChunkOffset = 0;
            this.noteDroppedFrame();
            return;
        }

        chunk[this.activeChunkOffset] = sample;
        this.activeChunkOffset += 1;
        this.framesCaptured += 1;
        this.overflowActive = false;

        if (this.activeChunkOffset === this.chunkSize) {
            this.sendChunk(this.activeChunkIndex, this.chunkSize);
        }
    }

    sendChunk(chunkIndex, validFrames) {
        const samples = this.chunkBuffers[chunkIndex];
        if (!samples) return;

        this.chunkBuffers[chunkIndex] = null;
        this.chunkMessage.chunkIndex = chunkIndex;
        this.chunkMessage.sequence = this.chunksSent;
        this.chunkMessage.validFrames = validFrames;
        this.chunkMessage.samples = samples;
        this.chunkTransferList[0] = samples.buffer;
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
                const inputChannel = input && channel < inputChannelCount ? input[channel] : null;
                for (let frame = 0; frame < outputChannel.length; frame += 1) {
                    outputChannel[frame] = inputChannel && frame < inputChannel.length
                        ? inputChannel[frame]
                        : 0;
                }
            }
        }

        // The existing recording path is mono and captures processed input channel 0.
        const inputChannel0 = input && inputChannelCount > 0 ? input[0] : null;
        if (this.isRecording && inputChannel0) {
            for (let frame = 0; frame < inputChannel0.length; frame += 1) {
                this.recordSample(inputChannel0[frame]);
            }
        }

        return true;
    }
}

registerProcessor('looper-processor', LooperProcessor);
