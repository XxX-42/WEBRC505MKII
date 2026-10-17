/* Test-only allocation-free stereo pass-through for the headless render pump. */
class Rc505BenchOutputProbe extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const heartbeatBuffer = options?.processorOptions?.heartbeatBuffer;
    this.heartbeat = heartbeatBuffer instanceof SharedArrayBuffer
      ? new Int32Array(heartbeatBuffer)
      : null;
    this.port.postMessage({ type: 'rc505-bench-output-probe-ready' });
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0];
    const outputChannels = outputs[0];
    if (!outputChannels) return true;

    for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex += 1) {
      const output = outputChannels[channelIndex];
      const input = inputChannels?.[channelIndex] ?? inputChannels?.[0];
      for (let frame = 0; frame < output.length; frame += 1) {
        output[frame] = input?.[frame] ?? 0;
      }
    }
    if (this.heartbeat) {
      Atomics.add(this.heartbeat, 0, 1);
      Atomics.add(this.heartbeat, 1, outputChannels[0]?.length ?? 0);
    }
    return true;
  }
}

registerProcessor('rc505-bench-output-finite-probe', Rc505BenchOutputProbe);
