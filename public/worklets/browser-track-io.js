/*
 * Browser-only loop I/O processors. The existing looper-processor.js remains
 * the recording capture worker; these separate processors own overdub DSP and
 * bounded loopback capture so capture semantics stay isolated.
 */
const DEFAULT_OVERDUB_POOL_SIZE = 3;
const DEFAULT_OVERDUB_BUFFER_FRAMES = 16384;
const EMPTY_CHANNELS = [];

class BrowserOverdubProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const processorOptions = options.processorOptions || {};
    this.bufferCapacity = this.positiveInteger(
      processorOptions.transferBufferFrames,
      DEFAULT_OVERDUB_BUFFER_FRAMES,
    );
    this.poolSize = this.positiveInteger(processorOptions.transferBufferPoolSize, DEFAULT_OVERDUB_POOL_SIZE);
    this.loopSamples = null;
    this.loopLength = 0;
    this.startFrame = 0;
    this.startOffsetSamples = 0;
    this.latencySamples = 0;
    this.recordingOffsetSamples = 0;
    this.reverse = false;
    this.active = false;
    this.stopped = false;
    this.patchPool = new Array(this.poolSize).fill(null);
    this.patchMessage = { type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 0, indices: null, values: null };
    this.patchTransferList = [null, null];
    this.stopMessage = { type: 'OVERDUB_STOPPED', overflowFrames: 0, overflowEvents: 0, patchesSent: 0 };
    this.patchSequence = 0;
    this.overflowFrames = 0;
    this.overflowEvents = 0;
    this.overflowActive = false;
    this.fallbackCurrentFrame = 0;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message) return;

      if (message.type === 'OVERDUB_INIT') {
        this.initializeOverdub(message);
      } else if (message.type === 'RECYCLE_OVERDUB_BUFFER') {
        this.recyclePatchBuffer(message.slotIndex, message.indices, message.values);
      } else if (message.type === 'OVERDUB_STOP') {
        this.stopOverdub();
      }
    };
  }

  positiveInteger(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  initializeOverdub(message) {
    const samples = message.samples;
    if (!(samples instanceof Float32Array) || samples.length === 0 || !Array.isArray(message.buffers)) {
      this.port.postMessage({ type: 'OVERDUB_ERROR', message: 'Overdub loop data was invalid.' });
      return;
    }

    this.loopSamples = samples;
    this.loopLength = samples.length;
    this.startFrame = Number.isFinite(message.startFrame) ? Math.floor(message.startFrame) : 0;
    this.startOffsetSamples = Number.isFinite(message.startOffsetSamples) ? Math.floor(message.startOffsetSamples) : 0;
    this.latencySamples = Number.isFinite(message.latencySamples) ? Math.floor(message.latencySamples) : 0;
    this.recordingOffsetSamples = Number.isFinite(message.recordingOffsetSamples)
      ? Math.trunc(message.recordingOffsetSamples)
      : 0;
    this.reverse = message.reverse === true;

    for (let index = 0; index < this.poolSize; index += 1) {
      const buffer = message.buffers[index];
      if (
        buffer &&
        Number.isInteger(buffer.slotIndex) &&
        buffer.slotIndex >= 0 &&
        buffer.slotIndex < this.poolSize &&
        buffer.indices instanceof Uint32Array &&
        buffer.indices.length === this.bufferCapacity &&
        buffer.values instanceof Float32Array &&
        buffer.values.length === this.bufferCapacity
      ) {
        this.patchPool[buffer.slotIndex] = {
          indices: buffer.indices,
          values: buffer.values,
          validFrames: 0,
        };
      }
    }
    this.active = true;
    this.stopped = false;
  }

  recyclePatchBuffer(slotIndex, indices, values) {
    if (
      !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= this.poolSize ||
      !(indices instanceof Uint32Array) || indices.length !== this.bufferCapacity ||
      !(values instanceof Float32Array) || values.length !== this.bufferCapacity
    ) return;

    this.patchPool[slotIndex] = { indices, values, validFrames: 0 };
  }

  findAvailablePatch() {
    for (let index = 0; index < this.poolSize; index += 1) {
      const buffer = this.patchPool[index];
      if (buffer && buffer.validFrames < this.bufferCapacity) return index;
    }
    return -1;
  }

  noteOverflow() {
    this.overflowFrames += 1;
    if (!this.overflowActive) {
      this.overflowEvents += 1;
      this.overflowActive = true;
    }
  }

  wrapIndex(value) {
    const length = this.loopLength;
    if (length <= 0) return 0;
    let wrapped = value % length;
    if (wrapped < 0) wrapped += length;
    return wrapped;
  }

  sendPatch(slotIndex) {
    const patch = this.patchPool[slotIndex];
    if (!patch || patch.validFrames <= 0) return;

    this.patchPool[slotIndex] = null;
    this.patchMessage.sequence = this.patchSequence;
    this.patchMessage.slotIndex = slotIndex;
    this.patchMessage.validFrames = patch.validFrames;
    this.patchMessage.indices = patch.indices;
    this.patchMessage.values = patch.values;
    this.patchTransferList[0] = patch.indices.buffer;
    this.patchTransferList[1] = patch.values.buffer;
    this.port.postMessage(this.patchMessage, this.patchTransferList);
    this.patchSequence += 1;
  }

  stopOverdub() {
    if (this.stopped) return;
    this.active = false;
    this.stopped = true;
    this.stopMessage.overflowFrames = this.overflowFrames;
    this.stopMessage.overflowEvents = this.overflowEvents;
    this.stopMessage.patchesSent = this.patchSequence;
    this.port.postMessage(this.stopMessage);
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0] || EMPTY_CHANNELS;
    const outputChannels = outputs[0] || EMPTY_CHANNELS;
    let frames = 0;
    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel];
      if (output && output.length > frames) frames = output.length;
    }

    const input = inputChannels[0] || null;
    const loop = this.loopSamples;
    if (this.active && loop && this.loopLength > 0) {
      const renderFrame = typeof currentFrame === 'number' ? currentFrame : this.fallbackCurrentFrame;
      let patchSlot = -1;

      for (let frame = 0; frame < frames; frame += 1) {
        const elapsedFrame = renderFrame + frame - this.startFrame;
        const playIndex = this.wrapIndex(this.reverse
          ? this.startOffsetSamples - elapsedFrame
          : this.startOffsetSamples + elapsedFrame);

        if (input && frame < input.length) {
          if (patchSlot < 0) patchSlot = this.findAvailablePatch();
          if (patchSlot < 0) {
            this.noteOverflow();
          } else {
            const patch = this.patchPool[patchSlot];
            if (patch) {
              const writeBase = this.reverse
                ? playIndex + this.latencySamples
                : playIndex - this.latencySamples;
              const writeIndex = this.wrapIndex(writeBase - this.recordingOffsetSamples);
              loop[writeIndex] += input[frame] || 0;
              const patchOffset = patch.validFrames;
              patch.indices[patchOffset] = writeIndex;
              patch.values[patchOffset] = loop[writeIndex] || 0;
              patch.validFrames += 1;
              this.overflowActive = false;
              if (patch.validFrames === this.bufferCapacity) {
                this.sendPatch(patchSlot);
                patchSlot = -1;
              }
            }
          }
        }

        for (let channel = 0; channel < outputChannels.length; channel += 1) {
          const output = outputChannels[channel];
          if (!output || frame >= output.length) continue;
          output[frame] = channel === 0 ? (loop[playIndex] || 0) : 0;
        }
      }

      if (patchSlot >= 0) this.sendPatch(patchSlot);
    } else {
      for (let channel = 0; channel < outputChannels.length; channel += 1) {
        const output = outputChannels[channel];
        if (!output) continue;
        if (this.stopped && loop && this.loopLength > 0 && channel === 0) {
          for (let frame = 0; frame < output.length; frame += 1) output[frame] = 0;
        } else {
          output.fill(0);
        }
      }
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
