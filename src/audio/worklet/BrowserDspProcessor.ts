import { LinearParameterSmoother } from '../dsp/LinearParameterSmoother';

interface WorkletMessageEvent {
  data: unknown;
}

interface WorkletPortLike {
  onmessage: ((event: WorkletMessageEvent) => void) | null;
}

interface WorkletProcessorLike {
  readonly port: WorkletPortLike;
}

type WorkletProcessorConstructor = new () => WorkletProcessorLike;

class FallbackWorkletProcessor implements WorkletProcessorLike {
  readonly port: WorkletPortLike = { onmessage: null };
}

const workletGlobals = globalThis as unknown as {
  AudioWorkletProcessor?: WorkletProcessorConstructor;
  registerProcessor?: (name: string, processor: WorkletProcessorConstructor) => void;
};
const WorkletProcessorBase = workletGlobals.AudioWorkletProcessor ?? FallbackWorkletProcessor;

export interface SetOutputGainMessage {
  type: 'set-output-gain';
  value: number;
  rampFrames?: number;
}

/**
 * A deliberately small browser worklet pass-through skeleton. It can apply a
 * smoothed output gain, but is not the loop engine or a complete audio runtime.
 */
export class BrowserDspProcessor extends WorkletProcessorBase {
  blocksProcessed = 0;
  framesProcessed = 0;
  samplesProcessed = 0;
  mismatchedBlocks = 0;
  channelShapeChanges = 0;
  maxBlockLength = 0;
  lastInputChannels = -1;
  lastOutputChannels = -1;

  private readonly outputGain = new LinearParameterSmoother(1);

  constructor() {
    super();
    this.port.onmessage = (event: WorkletMessageEvent): void => {
      const message = event.data as Partial<SetOutputGainMessage> | null;
      if (message?.type === 'set-output-gain' && typeof message.value === 'number') {
        this.setOutputGainTarget(message.value, message.rampFrames ?? 0);
      }
    };
  }

  setOutputGainTarget(value: number, rampFrames = 0): boolean {
    return this.outputGain.setTarget(value, rampFrames);
  }

  /**
   * Copies input channels to matching output channels and silences unconnected
   * or short inputs. Work is bounded by the actual channel/sample arrays and
   * performs no allocation, node creation, or logging per callback.
   */
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    this.blocksProcessed += 1;
    const inputChannels = inputs[0];
    const outputChannels = outputs[0];
    const inputChannelCount = inputChannels?.length ?? 0;
    const outputChannelCount = outputChannels?.length ?? 0;

    if (
      this.lastInputChannels !== -1 &&
      (this.lastInputChannels !== inputChannelCount || this.lastOutputChannels !== outputChannelCount)
    ) {
      this.channelShapeChanges += 1;
    }
    this.lastInputChannels = inputChannelCount;
    this.lastOutputChannels = outputChannelCount;

    let blockFrames = 0;
    let mismatch = inputChannelCount !== outputChannelCount;
    if (outputChannels) {
      for (let channel = 0; channel < outputChannelCount; channel += 1) {
        const output = outputChannels[channel];
        if (!output) continue;
        if (output.length > blockFrames) blockFrames = output.length;
        const input = inputChannels && channel < inputChannelCount ? inputChannels[channel] : undefined;
        if (!input || input.length !== output.length) mismatch = true;
      }

      for (let frame = 0; frame < blockFrames; frame += 1) {
        const gain = this.outputGain.next();
        for (let channel = 0; channel < outputChannelCount; channel += 1) {
          const output = outputChannels[channel];
          if (!output || frame >= output.length) continue;
          const input = inputChannels && channel < inputChannelCount ? inputChannels[channel] : undefined;
          output[frame] = input && frame < input.length ? (input[frame] ?? 0) * gain : 0;
        }
      }
    }

    if (mismatch) this.mismatchedBlocks += 1;
    this.framesProcessed += blockFrames;
    if (blockFrames > this.maxBlockLength) this.maxBlockLength = blockFrames;
    if (outputChannels) {
      for (let channel = 0; channel < outputChannelCount; channel += 1) {
        this.samplesProcessed += outputChannels[channel]?.length ?? 0;
      }
    }
    return true;
  }
}

if (typeof workletGlobals.registerProcessor === 'function') {
  workletGlobals.registerProcessor('rc505-browser-dsp', BrowserDspProcessor);
}
