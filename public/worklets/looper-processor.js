class LooperProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.isRecording = false;
        this.recordedBuffers = []; // Array of Float32Array chunks

        this.port.onmessage = (event) => {
            if (event.data.type === 'START_RECORD') {
                this.isRecording = true;
                this.recordedBuffers = [];
            } else if (event.data.type === 'STOP_RECORD') {
                this.isRecording = false;
                this.exportBuffer();
            }
        };
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        // Safety check
        if (!input || input.length === 0) return true;

        // Pass through (Monitoring)
        // Copy input channels to output channels
        if (output && output.length > 0) {
            for (let i = 0; i < Math.min(input.length, output.length); i++) {
                output[i].set(input[i]);
            }
        }

        // Record (Mono for now, taking first channel)
        if (this.isRecording) {
            const inputChannel0 = input[0];
            if (inputChannel0) {
                // We must clone the data because the buffer is reused by the browser
                this.recordedBuffers.push(new Float32Array(inputChannel0));
            }
        }

        return true;
    }

    exportBuffer() {
        if (this.recordedBuffers.length === 0) {
            this.port.postMessage({ type: 'RECORD_COMPLETE', buffer: new Float32Array(0) });
            return;
        }

        // Calculate total length
        let totalLength = 0;
        for (const buffer of this.recordedBuffers) {
            totalLength += buffer.length;
        }

        const result = new Float32Array(totalLength);

        let offset = 0;
        for (const buffer of this.recordedBuffers) {
            result.set(buffer, offset);
            offset += buffer.length;
        }

        // Send back to main thread
        // Transfer the buffer to avoid copy
        this.port.postMessage({ type: 'RECORD_COMPLETE', buffer: result }, [result.buffer]);
        this.recordedBuffers = [];
    }
}

registerProcessor('looper-processor', LooperProcessor);
