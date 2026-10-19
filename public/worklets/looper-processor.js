const DEFAULT_CHUNK_SIZE = 16384;
const DEFAULT_CHUNK_POOL_SIZE = 3;
const DEFAULT_MAX_RECORDING_CHUNKS = 65536;
const DEFAULT_MAX_RECORDING_FRAMES = DEFAULT_CHUNK_SIZE * DEFAULT_MAX_RECORDING_CHUNKS;
const MAX_CAPTURE_CHANNELS = 2;

class LooperProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const p = options.processorOptions || {};
    this.chunkSize = this.positiveInteger(p.chunkSize, DEFAULT_CHUNK_SIZE);
    this.chunkPoolSize = this.positiveInteger(p.chunkPoolSize, DEFAULT_CHUNK_POOL_SIZE);
    this.configuredMaxRecordingFrames = this.positiveInteger(p.maxRecordingFrames, DEFAULT_MAX_RECORDING_FRAMES);
    this.maxRecordingSamples = this.positiveInteger(p.maxRecordingSamples, this.configuredMaxRecordingFrames * MAX_CAPTURE_CHANNELS);
    this.maxRecordingFrames = this.configuredMaxRecordingFrames;
    this.chunkBufferSamples = this.chunkSize * MAX_CAPTURE_CHANNELS;
    this.chunkBuffers = Array.from({ length: this.chunkPoolSize }, () => new Float32Array(this.chunkBufferSamples));
    this.chunkMessage = { type: 'RECORD_CHUNK', chunkIndex: 0, sequence: 0, validFrames: 0, channelCount: 1, samples: null };
    this.chunkTransferList = [null];
    this.completeMessage = { type: 'RECORD_COMPLETE', framesCaptured: 0, droppedFrames: 0, overflowEvents: 0, maxRecordingFrames: this.maxRecordingFrames, channelCount: 1, limitReached: false, chunksSent: 0 };
    this.isRecording = false;
    this.blocksProcessed = 0;
    this.framesCaptured = 0;
    this.chunksSent = 0;
    this.droppedFrames = 0;
    this.overflowEvents = 0;
    this.limitReached = false;
    this.overflowActive = false;
    this.captureChannelCount = 0;
    this.activeChunkIndex = -1;
    this.activeChunkOffset = 0;
    this.port.onmessage = (event) => {
      const m = event.data;
      if (!m) return;
      if (m.type === 'START_RECORD') this.startRecording();
      else if (m.type === 'STOP_RECORD') this.stopRecording();
      else if (m.type === 'RECYCLE_CHUNK') this.recycleChunk(m.chunkIndex, m.samples);
    };
  }
  positiveInteger(value, fallback) { return Number.isInteger(value) && value > 0 ? value : fallback; }
  startRecording() {
    if (this.isRecording) return;
    this.isRecording = true;
    this.framesCaptured = 0; this.chunksSent = 0; this.droppedFrames = 0; this.overflowEvents = 0;
    this.limitReached = false; this.overflowActive = false; this.captureChannelCount = 0;
    this.maxRecordingFrames = this.configuredMaxRecordingFrames;
    this.activeChunkIndex = -1; this.activeChunkOffset = 0;
  }
  stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;
    if (this.activeChunkIndex >= 0 && this.activeChunkOffset > 0) this.sendChunk(this.activeChunkIndex, this.activeChunkOffset);
    this.activeChunkIndex = -1; this.activeChunkOffset = 0;
    const channels = this.captureChannelCount || 1;
    Object.assign(this.completeMessage, { framesCaptured: this.framesCaptured, droppedFrames: this.droppedFrames, overflowEvents: this.overflowEvents, maxRecordingFrames: this.maxRecordingFrames, channelCount: channels, limitReached: this.limitReached, chunksSent: this.chunksSent });
    this.port.postMessage(this.completeMessage);
  }
  recycleChunk(index, samples) {
    if (Number.isInteger(index) && index >= 0 && index < this.chunkPoolSize && samples instanceof Float32Array && samples.length === this.chunkBufferSamples) this.chunkBuffers[index] = samples;
  }
  findAvailableChunk() {
    for (let i = 0; i < this.chunkPoolSize; i += 1) if (this.chunkBuffers[i]) return i;
    return -1;
  }
  configureCaptureChannels(inputChannelCount) {
    if (this.captureChannelCount > 0) return;
    this.captureChannelCount = Math.max(1, Math.min(MAX_CAPTURE_CHANNELS, inputChannelCount || 1));
    this.maxRecordingFrames = Math.min(this.configuredMaxRecordingFrames, Math.floor(this.maxRecordingSamples / this.captureChannelCount));
  }
  noteDroppedFrame() {
    this.droppedFrames += 1;
    if (!this.overflowActive) { this.overflowEvents += 1; this.overflowActive = true; }
  }
  recordFrame(inputChannels, frame) {
    if (this.framesCaptured >= this.maxRecordingFrames) { this.limitReached = true; this.noteDroppedFrame(); return; }
    if (this.activeChunkIndex < 0) {
      this.activeChunkIndex = this.findAvailableChunk(); this.activeChunkOffset = 0;
      if (this.activeChunkIndex < 0) { this.noteDroppedFrame(); return; }
    }
    const chunk = this.chunkBuffers[this.activeChunkIndex];
    if (!chunk) { this.activeChunkIndex = -1; this.activeChunkOffset = 0; this.noteDroppedFrame(); return; }
    const channels = this.captureChannelCount || 1;
    const base = this.activeChunkOffset * channels;
    for (let channel = 0; channel < channels; channel += 1) {
      const input = inputChannels[channel] || null;
      chunk[base + channel] = input && frame < input.length ? (input[frame] || 0) : 0;
    }
    this.activeChunkOffset += 1; this.framesCaptured += 1; this.overflowActive = false;
    if (this.activeChunkOffset === this.chunkSize) this.sendChunk(this.activeChunkIndex, this.chunkSize);
  }
  sendChunk(index, validFrames) {
    const samples = this.chunkBuffers[index];
    if (!samples) return;
    this.chunkBuffers[index] = null;
    Object.assign(this.chunkMessage, { chunkIndex: index, sequence: this.chunksSent, validFrames, channelCount: this.captureChannelCount || 1, samples });
    this.chunkTransferList[0] = samples.buffer;
    this.port.postMessage(this.chunkMessage, this.chunkTransferList);
    this.chunksSent += 1; this.activeChunkIndex = -1; this.activeChunkOffset = 0;
  }
  process(inputs, outputs) {
    this.blocksProcessed += 1;
    const input = inputs[0], output = outputs[0];
    const inCount = input ? input.length : 0, outCount = output ? output.length : 0;
    if (output) {
      for (let channel = 0; channel < outCount; channel += 1) {
        const out = output[channel]; if (!out) continue;
        const src = input && channel < inCount ? input[channel] : (inCount === 1 ? input[0] : null);
        for (let frame = 0; frame < out.length; frame += 1) out[frame] = src && frame < src.length ? src[frame] : 0;
      }
    }
    if (this.isRecording && inCount > 0) {
      this.configureCaptureChannels(inCount);
      let frames = 0;
      for (let channel = 0; channel < this.captureChannelCount; channel += 1) {
        const src = input[channel]; if (src && src.length > frames) frames = src.length;
      }
      for (let frame = 0; frame < frames; frame += 1) this.recordFrame(input, frame);
    }
    return true;
  }
}
registerProcessor('looper-processor', LooperProcessor);
