/*
 * Browser-only loop I/O processors. Recording capture remains in
 * looper-processor.js; this file owns stereo-safe overdub DSP and bounded
 * mono loopback capture for latency measurement.
 */
const DEFAULT_OVERDUB_POOL_SIZE = 3;
const DEFAULT_OVERDUB_BUFFER_FRAMES = 16384;
const EMPTY_CHANNELS = [];

class BrowserOverdubProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const p = options.processorOptions || {};
    this.bufferCapacity = this.positiveInteger(p.transferBufferFrames, DEFAULT_OVERDUB_BUFFER_FRAMES);
    this.poolSize = this.positiveInteger(p.transferBufferPoolSize, DEFAULT_OVERDUB_POOL_SIZE);
    this.loopSamples = null; this.loopLength = 0; this.channelCount = 1;
    this.startFrame = 0; this.startOffsetSamples = 0; this.latencySamples = 0; this.recordingOffsetSamples = 0;
    this.reverse = false; this.active = false; this.stopped = false;
    this.patchPool = new Array(this.poolSize).fill(null);
    this.patchMessage = { type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 0, channelCount: 1, indices: null, values: null };
    this.patchTransferList = [null, null];
    this.stopMessage = { type: 'OVERDUB_STOPPED', overflowFrames: 0, overflowEvents: 0, patchesSent: 0 };
    this.patchSequence = 0; this.overflowFrames = 0; this.overflowEvents = 0; this.overflowActive = false; this.fallbackCurrentFrame = 0;
    this.port.onmessage = (event) => {
      const m = event.data; if (!m) return;
      if (m.type === 'OVERDUB_INIT') this.initializeOverdub(m);
      else if (m.type === 'RECYCLE_OVERDUB_BUFFER') this.recyclePatchBuffer(m.slotIndex, m.indices, m.values);
      else if (m.type === 'OVERDUB_STOP') this.stopOverdub();
    };
  }
  positiveInteger(value, fallback) { return Number.isInteger(value) && value > 0 ? value : fallback; }
  initializeOverdub(m) {
    const samples = m.samples, channels = m.channelCount === 2 ? 2 : 1;
    if (!(samples instanceof Float32Array) || samples.length === 0 || samples.length % channels !== 0 || !Array.isArray(m.buffers)) {
      this.port.postMessage({ type: 'OVERDUB_ERROR', message: 'Overdub loop data was invalid.' }); return;
    }
    this.channelCount = channels; this.loopSamples = samples; this.loopLength = samples.length / channels;
    this.startFrame = Number.isFinite(m.startFrame) ? Math.floor(m.startFrame) : 0;
    this.startOffsetSamples = Number.isFinite(m.startOffsetSamples) ? Math.floor(m.startOffsetSamples) : 0;
    this.latencySamples = Number.isFinite(m.latencySamples) ? Math.floor(m.latencySamples) : 0;
    this.recordingOffsetSamples = Number.isFinite(m.recordingOffsetSamples) ? Math.trunc(m.recordingOffsetSamples) : 0;
    this.reverse = m.reverse === true;
    for (let i = 0; i < this.poolSize; i += 1) {
      const b = m.buffers[i];
      if (b && Number.isInteger(b.slotIndex) && b.slotIndex >= 0 && b.slotIndex < this.poolSize &&
          b.indices instanceof Uint32Array && b.indices.length === this.bufferCapacity &&
          b.values instanceof Float32Array && b.values.length === this.bufferCapacity * channels) {
        this.patchPool[b.slotIndex] = { indices: b.indices, values: b.values, validFrames: 0 };
      }
    }
    this.active = true; this.stopped = false;
  }
  recyclePatchBuffer(slotIndex, indices, values) {
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= this.poolSize ||
        !(indices instanceof Uint32Array) || indices.length !== this.bufferCapacity ||
        !(values instanceof Float32Array) || values.length !== this.bufferCapacity * this.channelCount) return;
    this.patchPool[slotIndex] = { indices, values, validFrames: 0 };
  }
  findAvailablePatch() {
    for (let i = 0; i < this.poolSize; i += 1) { const b = this.patchPool[i]; if (b && b.validFrames < this.bufferCapacity) return i; }
    return -1;
  }
  noteOverflow() { this.overflowFrames += 1; if (!this.overflowActive) { this.overflowEvents += 1; this.overflowActive = true; } }
  wrapIndex(value) {
    if (this.loopLength <= 0) return 0;
    let wrapped = value % this.loopLength; if (wrapped < 0) wrapped += this.loopLength; return wrapped;
  }
  sendPatch(slotIndex) {
    const p = this.patchPool[slotIndex]; if (!p || p.validFrames <= 0) return;
    this.patchPool[slotIndex] = null;
    Object.assign(this.patchMessage, { sequence: this.patchSequence, slotIndex, validFrames: p.validFrames, channelCount: this.channelCount, indices: p.indices, values: p.values });
    this.patchTransferList[0] = p.indices.buffer; this.patchTransferList[1] = p.values.buffer;
    this.port.postMessage(this.patchMessage, this.patchTransferList); this.patchSequence += 1;
  }
  stopOverdub() {
    if (this.stopped) return; this.active = false; this.stopped = true;
    Object.assign(this.stopMessage, { overflowFrames: this.overflowFrames, overflowEvents: this.overflowEvents, patchesSent: this.patchSequence });
    this.port.postMessage(this.stopMessage);
  }
  process(inputs, outputs) {
    const inputChannels = inputs[0] || EMPTY_CHANNELS, outputChannels = outputs[0] || EMPTY_CHANNELS;
    let frames = 0;
    for (let c = 0; c < outputChannels.length; c += 1) { const out = outputChannels[c]; if (out && out.length > frames) frames = out.length; }
    const loop = this.loopSamples;
    if (this.active && loop && this.loopLength > 0) {
      const renderFrame = typeof currentFrame === 'number' ? currentFrame : this.fallbackCurrentFrame;
      let patchSlot = -1;
      for (let frame = 0; frame < frames; frame += 1) {
        const elapsed = renderFrame + frame - this.startFrame;
        const playIndex = this.wrapIndex(this.reverse ? this.startOffsetSamples - elapsed : this.startOffsetSamples + elapsed);
        let hasInput = false;
        for (let c = 0; c < this.channelCount; c += 1) {
          const src = inputChannels[c] || (inputChannels.length === 1 ? inputChannels[0] : null);
          if (src && frame < src.length) { hasInput = true; break; }
        }
        if (hasInput) {
          if (patchSlot < 0) patchSlot = this.findAvailablePatch();
          if (patchSlot < 0) this.noteOverflow();
          else {
            const p = this.patchPool[patchSlot];
            if (p) {
              const writeBase = this.reverse ? playIndex + this.latencySamples : playIndex - this.latencySamples;
              const writeIndex = this.wrapIndex(writeBase - this.recordingOffsetSamples);
              const patchOffset = p.validFrames; p.indices[patchOffset] = writeIndex;
              for (let c = 0; c < this.channelCount; c += 1) {
                const src = inputChannels[c] || inputChannels[0] || null;
                const sample = src && frame < src.length ? (src[frame] || 0) : 0;
                const si = writeIndex * this.channelCount + c;
                loop[si] = (loop[si] || 0) + sample;
                p.values[patchOffset * this.channelCount + c] = loop[si] || 0;
              }
              p.validFrames += 1; this.overflowActive = false;
              if (p.validFrames === this.bufferCapacity) { this.sendPatch(patchSlot); patchSlot = -1; }
            }
          }
        }
        for (let c = 0; c < outputChannels.length; c += 1) {
          const out = outputChannels[c]; if (!out || frame >= out.length) continue;
          out[frame] = c < this.channelCount ? (loop[playIndex * this.channelCount + c] || 0) : 0;
        }
      }
      if (patchSlot >= 0) this.sendPatch(patchSlot);
    } else {
      for (let c = 0; c < outputChannels.length; c += 1) { const out = outputChannels[c]; if (out) out.fill(0); }
    }
    if (typeof currentFrame !== 'number') this.fallbackCurrentFrame += frames;
    return true;
  }
}

class BrowserLoopbackCaptureProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const processorOptions = options.processorOptions || {};
    const requestedFrames = processorOptions.captureFrames;
    this.captureFrames = Number.isInteger(requestedFrames) && requestedFrames > 0
      ? Math.min(requestedFrames, 1_000_000)
      : 44100;
    this.captureBuffer = new Float32Array(this.captureFrames);
    this.framesCaptured = 0;
    this.complete = false;
    this.captureMessage = { type: 'LOOPBACK_CAPTURE', framesCaptured: 0, samples: this.captureBuffer };
    this.captureTransferList = [this.captureBuffer.buffer];
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0] || EMPTY_CHANNELS;
    const outputChannels = outputs[0] || EMPTY_CHANNELS;
    let frames = 0;
    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel];
      if (output && output.length > frames) frames = output.length;
    }

    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel];
      if (!output) continue;
      const input = inputChannels[channel] || (channel === 0 ? inputChannels[0] : null);
      if (!input) {
        output.fill(0);
      } else {
        const count = Math.min(output.length, input.length);
        for (let frame = 0; frame < count; frame += 1) output[frame] = input[frame] || 0;
        for (let frame = count; frame < output.length; frame += 1) output[frame] = 0;
      }
    }

    const input = inputChannels[0];
    if (!this.complete && input) {
      const remaining = this.captureFrames - this.framesCaptured;
      const count = Math.min(input.length, remaining);
      if (count > 0) {
        const writeStart = this.framesCaptured;
        for (let frame = 0; frame < count; frame += 1) {
          this.captureBuffer[writeStart + frame] = input[frame] || 0;
        }
        this.framesCaptured += count;
      }
      if (this.framesCaptured >= this.captureFrames) {
        this.complete = true;
        this.captureMessage.framesCaptured = this.framesCaptured;
        this.port.postMessage(this.captureMessage, this.captureTransferList);
      }
    }

    return true;
  }
}

registerProcessor('rc505-overdub-processor', BrowserOverdubProcessor);
registerProcessor('rc505-loopback-capture', BrowserLoopbackCaptureProcessor);
