/*
 * Per-track shared Track FX wet/dry selector. One node owns all five selector
 * switches so each gate is applied on the AudioWorklet render thread at an
 * exact AudioContext frame and acknowledged only after that frame is rendered.
 */
const DEFAULT_TRACK_COUNT = 5;
const MAX_QUEUED_CHANGES = 32;
const EMPTY_CHANNELS = [];

class BrowserTrackFxRouterProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const config = options.processorOptions || {};
    this.trackCount = Number.isSafeInteger(config.trackCount) && config.trackCount > 0
      ? Math.min(DEFAULT_TRACK_COUNT, config.trackCount) : DEFAULT_TRACK_COUNT;
    const initial = Array.isArray(config.initialTrackFxApply) ? config.initialTrackFxApply : [];
    this.enabled = new Uint8Array(this.trackCount);
    this.appliedRevision = new Float64Array(this.trackCount);
    for (let track = 0; track < this.trackCount; track += 1) {
      this.enabled[track] = initial[track] === false ? 0 : 1;
    }
    this.queueTrack = new Uint8Array(MAX_QUEUED_CHANGES);
    this.queueEnabled = new Uint8Array(MAX_QUEUED_CHANGES);
    this.queueRevision = new Float64Array(MAX_QUEUED_CHANGES);
    this.queueFrame = new Float64Array(MAX_QUEUED_CHANGES);
    this.queueLength = 0;
    this.ackMessages = new Array(MAX_QUEUED_CHANGES);
    for (let index = 0; index < MAX_QUEUED_CHANGES; index += 1) {
      this.ackMessages[index] = {
        type: 'TRACK_FX_APPLY_ACK', route: 'track', ok: false,
        trackIndex: 0, revision: 0, enabled: false, requestedFrame: 0,
        appliedFrame: 0, reason: '',
      };
    }
    this.immediateAck = {
      type: 'TRACK_FX_APPLY_ACK', route: 'track', ok: false,
      trackIndex: 0, revision: 0, enabled: false, requestedFrame: 0,
      appliedFrame: 0, reason: '',
    };
    this.fallbackFrame = 0;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  postFailure(message, reason) {
    const ack = this.immediateAck;
    ack.trackIndex = Number.isInteger(message?.trackIndex) ? message.trackIndex : -1;
    ack.revision = Number.isSafeInteger(message?.revision) ? message.revision : 0;
    ack.enabled = message?.enabled === true;
    ack.requestedFrame = Number.isSafeInteger(message?.applyFrame) ? message.applyFrame : 0;
    ack.appliedFrame = typeof currentFrame === 'number' && Number.isSafeInteger(currentFrame)
      ? currentFrame : this.fallbackFrame;
    ack.reason = reason;
    this.port.postMessage(ack);
  }

  handleMessage(message) {
    if (!message || message.type !== 'SET_TRACK_FX_APPLY') return;
    const trackIndex = message.trackIndex;
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= this.trackCount
      || typeof message.enabled !== 'boolean'
      || !Number.isSafeInteger(message.revision) || message.revision <= this.appliedRevision[trackIndex]
      || !Number.isSafeInteger(message.applyFrame) || message.applyFrame < 0) {
      this.postFailure(message, 'invalid-track-fx-apply-command');
      return;
    }
    if (this.queueLength >= MAX_QUEUED_CHANGES) {
      this.postFailure(message, 'track-fx-apply-queue-full');
      return;
    }
    let insertAt = this.queueLength;
    while (insertAt > 0 && this.queueFrame[insertAt - 1] > message.applyFrame) {
      this.queueTrack[insertAt] = this.queueTrack[insertAt - 1];
      this.queueEnabled[insertAt] = this.queueEnabled[insertAt - 1];
      this.queueRevision[insertAt] = this.queueRevision[insertAt - 1];
      this.queueFrame[insertAt] = this.queueFrame[insertAt - 1];
      insertAt -= 1;
    }
    this.queueTrack[insertAt] = trackIndex;
    this.queueEnabled[insertAt] = message.enabled ? 1 : 0;
    this.queueRevision[insertAt] = message.revision;
    this.queueFrame[insertAt] = message.applyFrame;
    this.queueLength += 1;
  }

  acknowledgeHead(ok, frame, reason = '') {
    const trackIndex = this.queueTrack[0];
    const revision = this.queueRevision[0];
    const enabled = this.queueEnabled[0] === 1;
    const requestedFrame = this.queueFrame[0];
    if (ok) {
      this.enabled[trackIndex] = enabled ? 1 : 0;
      this.appliedRevision[trackIndex] = revision;
    }
    const ack = this.ackMessages[0];
    ack.trackIndex = trackIndex;
    ack.revision = revision;
    ack.enabled = enabled;
    ack.requestedFrame = requestedFrame;
    ack.appliedFrame = frame;
    ack.ok = ok;
    ack.reason = reason;
    this.port.postMessage(ack);
    for (let index = 1; index < this.queueLength; index += 1) {
      this.queueTrack[index - 1] = this.queueTrack[index];
      this.queueEnabled[index - 1] = this.queueEnabled[index];
      this.queueRevision[index - 1] = this.queueRevision[index];
      this.queueFrame[index - 1] = this.queueFrame[index];
    }
    this.queueLength -= 1;
  }

  process(inputs, outputs) {
    let frames = 0;
    for (let port = 0; port < outputs.length; port += 1) {
      const channels = outputs[port] || EMPTY_CHANNELS;
      for (let channel = 0; channel < channels.length; channel += 1) {
        const output = channels[channel];
        if (output && output.length > frames) frames = output.length;
        if (output) output.fill(0);
      }
    }
    if (frames <= 0) {
      for (let track = 0; track < inputs.length; track += 1) {
        const channels = inputs[track] || EMPTY_CHANNELS;
        if (channels[0] && channels[0].length > frames) frames = channels[0].length;
      }
    }
    if (frames <= 0) return true;
    const frameStart = typeof currentFrame === 'number' && Number.isSafeInteger(currentFrame)
      ? currentFrame : this.fallbackFrame;

    for (let offset = 0; offset < frames; offset += 1) {
      const absoluteFrame = frameStart + offset;
      while (this.queueLength > 0 && this.queueFrame[0] <= absoluteFrame) {
        if (this.queueFrame[0] !== absoluteFrame) {
          this.acknowledgeHead(false, absoluteFrame, 'track-fx-apply-frame-missed');
        } else {
          this.acknowledgeHead(true, absoluteFrame);
        }
      }
      for (let track = 0; track < this.trackCount; track += 1) {
        const source = inputs[track] || EMPTY_CHANNELS;
        const leftInput = source[0] || null;
        const rightInput = source[1] || leftInput;
        const wet = outputs[track * 2] || EMPTY_CHANNELS;
        const dry = outputs[(track * 2) + 1] || EMPTY_CHANNELS;
        const enabled = this.enabled[track] === 1;
        for (let channel = 0; channel < 2; channel += 1) {
          const sourceChannel = channel === 0 ? leftInput : rightInput;
          const wetOutput = wet[channel];
          const dryOutput = dry[channel];
          const sample = sourceChannel && offset < sourceChannel.length ? sourceChannel[offset] : 0;
          if (enabled) {
            if (wetOutput && offset < wetOutput.length) wetOutput[offset] = sample;
          } else if (dryOutput && offset < dryOutput.length) {
            dryOutput[offset] = sample;
          }
        }
      }
    }
    this.fallbackFrame = frameStart + frames;
    return true;
  }
}

registerProcessor('rc505-track-fx-router', BrowserTrackFxRouterProcessor);
