/* Test-only pass-through registered after the benchmark wrapper. */
class Rc505BenchInstrumentedHeartbeat extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const inputChannels = inputs[0];
    const outputChannels = outputs[0];
    if (!outputChannels) return true;
    for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex += 1) {
      const output = outputChannels[channelIndex];
      const input = inputChannels?.[channelIndex] ?? inputChannels?.[0];
      for (let frame = 0; frame < output.length; frame += 1) output[frame] = input?.[frame] ?? 0;
    }
    return true;
  }
}

registerProcessor('rc505-bench-instrumented-heartbeat', Rc505BenchInstrumentedHeartbeat);
