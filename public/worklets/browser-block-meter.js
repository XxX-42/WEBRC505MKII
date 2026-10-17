/*
 * Transparent master-bus AudioWorklet used to observe the browser's real
 * render-quantum shape. AudioWorklet callback lengths are provided by the
 * browser and are intentionally never assumed to be 128 frames.
 */
class BrowserBlockMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lastFrames = -1;
    this.lastInputChannels = -1;
    this.lastOutputChannels = -1;
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0] || [];
    const outputChannels = outputs[0] || [];
    let frames = 0;

    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel];
      if (output && output.length > frames) frames = output.length;
    }

    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel];
      if (!output) continue;
      const input = inputChannels[channel];
      if (!input || input.length !== output.length) {
        output.fill(0);
      } else {
        output.set(input);
      }
    }

    if (
      frames !== this.lastFrames ||
      inputChannels.length !== this.lastInputChannels ||
      outputChannels.length !== this.lastOutputChannels
    ) {
      this.lastFrames = frames;
      this.lastInputChannels = inputChannels.length;
      this.lastOutputChannels = outputChannels.length;
      this.port.postMessage({
        type: 'render-quantum-shape',
        frames,
        inputChannels: inputChannels.length,
        outputChannels: outputChannels.length,
      });
    }

    return true;
  }
}

registerProcessor('rc505-browser-block-meter', BrowserBlockMeterProcessor);
