import type { FXBase } from './FXBase';

type FailureHandler = (error: Error) => void;

type VocoderWorkletPort = MessagePort & {
  onmessage: ((event: MessageEvent) => void) | null;
};

/**
 * FXBase adapter for the shipped Browser FX worklet. Processor installation is
 * asynchronous and starts as exact wire-through; failures leave a dry route.
 */
export class BrowserVocoderFX implements FXBase {
  readonly name = 'VOCODER';
  readonly input: GainNode;
  readonly output: GainNode;
  readonly ready: Promise<void>;
  readonly latencySamples = 0;

  private readonly context: AudioContext;
  private readonly ensureModule: () => Promise<void>;
  private readonly onFailure?: FailureHandler;
  private readonly directGain: GainNode;
  private readonly workletGain: GainNode;
  private node: AudioWorkletNode | null = null;
  private parameters = { vocoderBands: 16, vocoderCarrier: 1, mix: 0.7 };
  private bypassed = true;
  private disposed = false;
  private failed = false;
  private failedParameterKey: string | null = null;
  public error = '';

  constructor(context: AudioContext, ensureModule: () => Promise<void>, onFailure?: FailureHandler) {
    this.context = context;
    this.ensureModule = ensureModule;
    this.onFailure = onFailure;
    this.input = context.createGain();
    this.output = context.createGain();
    this.directGain = context.createGain();
    this.workletGain = context.createGain();
    this.input.connect(this.directGain);
    this.directGain.connect(this.output);
    this.workletGain.connect(this.output);
    this.applyRouting();
    this.ready = this.installProcessor();
  }

  setParam(key: string, value: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(value)) {
      this.failClosed(`Browser VOCODER ${key} must be a finite number.`, key);
      return;
    }

    if (key === 'formant') {
      this.failClosed('Browser VOCODER formant shifting is unsupported; no formant remapping is applied.', key);
      return;
    }
    if (key === 'bands') {
      if (!Number.isInteger(value) || value < 8 || value > 24) {
        this.failClosed('Browser VOCODER bands must be an integer from 8 to 24.', key);
        return;
      }
      this.parameters.vocoderBands = value;
    } else if (key === 'carrier') {
      if (!Number.isInteger(value) || value < 0 || value > 2) {
        this.failClosed('Browser VOCODER carrier must be 0 (voice input), 1 (saw), or 2 (square).', key);
        return;
      }
      this.parameters.vocoderCarrier = value;
    } else if (key === 'mix') {
      if (value < 0 || value > 100) {
        this.failClosed('Browser VOCODER mix must be between 0 and 100 percent.', key);
        return;
      }
      this.parameters.mix = value / 100;
    } else {
      this.failClosed(`Browser VOCODER does not support the ${key} parameter.`, key);
      return;
    }

    this.clearParameterFailure(key);
    this.node?.port.postMessage({ type: 'configure', parameters: this.parameters });
    this.applyRouting();
  }

  setBypass(bypass: boolean): void {
    if (this.disposed) return;
    this.bypassed = bypass;
    this.node?.port.postMessage({ type: 'set-bypass', value: bypass, rampFrames: 128 });
    this.applyRouting();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    this.input.disconnect();
    this.directGain.disconnect();
    this.workletGain.disconnect();
    this.output.disconnect();
  }

  private async installProcessor(): Promise<void> {
    try {
      await this.ensureModule();
      if (this.disposed) return;
      const node = new AudioWorkletNode(this.context, 'rc505-fx-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: {
          algorithm: 'vocoder',
          sampleRate: this.context.sampleRate,
          parameters: { ...this.parameters },
          bypassed: true,
        },
      });
      node.onprocessorerror = () => this.failRuntime('Browser VOCODER AudioWorklet processor failed.');
      const port = node.port as VocoderWorkletPort;
      port.onmessage = (event: MessageEvent): void => {
        const message = event.data as { type?: string; message?: unknown } | null;
        if (message?.type === 'error') {
          this.failRuntime(`Browser VOCODER rejected a worklet update: ${String(message.message ?? 'unknown error')}`);
        }
      };
      this.node = node;
      this.input.connect(node);
      node.connect(this.workletGain);
      node.port.postMessage({ type: 'configure', parameters: this.parameters });
      node.port.postMessage({ type: 'set-bypass', value: this.bypassed, rampFrames: 0 });
      this.applyRouting();
    } catch (cause) {
      this.failRuntime(
        `Browser VOCODER worklet unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private clearParameterFailure(key: string): void {
    if (this.failedParameterKey !== key) return;
    this.failedParameterKey = null;
    this.failed = false;
    this.error = '';
  }

  private failClosed(message: string, parameterKey: string): void {
    this.failed = true;
    this.failedParameterKey = parameterKey;
    this.reportError(message);
    this.node?.port.postMessage({ type: 'set-bypass', value: true, rampFrames: 0 });
    this.applyRouting();
  }

  private failRuntime(message: string): void {
    this.failed = true;
    this.failedParameterKey = null;
    this.reportError(message);
    this.node?.port.postMessage({ type: 'set-bypass', value: true, rampFrames: 0 });
    this.applyRouting();
  }

  private reportError(message: string): void {
    if (this.error === message) return;
    this.error = message;
    this.onFailure?.(new Error(message));
  }

  private applyRouting(): void {
    const direct = this.bypassed || this.failed || !this.node ? 1 : 0;
    const wet = direct ? 0 : 1;
    const now = this.context.currentTime;
    this.directGain.gain.setTargetAtTime(direct, now, 0.005);
    this.workletGain.gain.setTargetAtTime(wet, now, 0.005);
  }
}
