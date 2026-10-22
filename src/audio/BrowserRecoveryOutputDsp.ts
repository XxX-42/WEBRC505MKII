import { BROWSER_PER_TRACK_PARAMETER_KEYS } from './BrowserTrackFxChain';
import { BROWSER_FX_ALGORITHM_INFO, type BrowserFxAlgorithm } from './fx/dsp/BrowserFxDspCore';
import type { BrowserRecoverySnapshot, RecoveryFxParameterValue } from './BrowserRecoverySnapshot';

const READY_TIMEOUT_MS = 12_000;
const EXTRA_NUMERIC_PARAMETERS = [
  'bpm', 'beatShiftOffsetBeats', 'beatShiftCrossfadeMs',
  'vinylFlickSpeed', 'vinylFlickReturnTimeSeconds', 'vinylFlickBrakePercent',
  'hrmAutoKey', 'hrmAutoScale', 'hrmAutoMidiChannel', 'hrmAutoMixPercent',
  'oscVocWaveform', 'oscVocMidiChannel', 'oscVocOctave', 'oscVocBands',
  'robotPitch', 'robotFormantSemitones', 'autoRiffScale', 'autoRiffRateBeats', 'autoRiffSensitivityPercent',
] as const;
const ALLOWED_NUMERIC_PARAMETERS = new Set<string>([
  ...Object.values(BROWSER_PER_TRACK_PARAMETER_KEYS).flat(),
  ...EXTRA_NUMERIC_PARAMETERS,
]);
const ALLOWED_ENUM_PARAMETERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  distortionMode: ['overdrive', 'hard-clip', 'fuzz'],
  dynamicsDetector: ['peak', 'rms'],
  tremoloWaveform: ['sine', 'triangle', 'square'],
  autoPanWaveform: ['sine', 'triangle', 'square'],
});
const ALGORITHM_EXTRA_PARAMETERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'beat-shift': ['beatShiftOffsetBeats', 'beatShiftCrossfadeMs', 'bpm'],
  'vinyl-flick': ['vinylFlickSpeed', 'vinylFlickReturnTimeSeconds', 'vinylFlickBrakePercent'],
  'hrm-auto': ['hrmAutoKey', 'hrmAutoScale', 'hrmAutoMidiChannel', 'hrmAutoMixPercent'],
  'osc-voc': ['oscVocWaveform', 'oscVocMidiChannel', 'oscVocOctave', 'oscVocBands'],
  robot: ['robotPitch', 'robotFormantSemitones'],
  'auto-riff': ['autoRiffScale', 'autoRiffRateBeats', 'autoRiffSensitivityPercent'],
});

export interface BrowserRecoveryOutputDsp {
  readonly algorithm: BrowserFxAlgorithm;
  readonly parameters: Readonly<Record<string, RecoveryFxParameterValue>>;
  readonly enabled: boolean;
  readonly node: AudioWorkletNode;
  readonly state: 'ready';
  dispose(): void;
}

export type RecoveryOutputModuleLoader = (context: AudioContext) => Promise<void>;

function isAlgorithm(value: unknown): value is BrowserFxAlgorithm {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BROWSER_FX_ALGORITHM_INFO, value);
}

function validateParameters(parameters: Readonly<Record<string, RecoveryFxParameterValue>>, algorithm: BrowserFxAlgorithm): void {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error(`Recovery output DSP ${algorithm} has an invalid parameter snapshot.`);
  }
  const admitted = new Set<string>([
    ...(BROWSER_PER_TRACK_PARAMETER_KEYS[algorithm] ?? []),
    ...(ALGORITHM_EXTRA_PARAMETERS[algorithm] ?? []),
    ...(algorithm === 'distortion' ? ['distortionMode'] : []),
    ...(algorithm === 'dynamics' ? ['dynamicsDetector'] : []),
    ...(algorithm === 'tremolo' ? ['tremoloWaveform'] : []),
    ...(algorithm === 'auto-pan' ? ['autoPanWaveform'] : []),
  ]);
  for (const [key, value] of Object.entries(parameters)) {
    if (!admitted.has(key)) throw new Error(`Recovery output DSP ${algorithm} parameter ${key} is not valid for that algorithm.`);
    const enumValues = ALLOWED_ENUM_PARAMETERS[key];
    if (enumValues) {
      if (typeof value !== 'string' || !enumValues.includes(value)) {
        throw new Error(`Recovery output DSP ${algorithm} parameter ${key} has an invalid enum value.`);
      }
    } else if (!ALLOWED_NUMERIC_PARAMETERS.has(key) || typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Recovery output DSP ${algorithm} parameter ${key} is unsupported or non-finite.`);
    }
  }
}

export function validateBrowserRecoveryOutputDspSnapshot(
  outputDsp: BrowserRecoverySnapshot['fx']['outputDsp'],
): void {
  if (typeof outputDsp.enabled !== 'boolean' || !outputDsp.parameters || typeof outputDsp.parameters !== 'object' || Array.isArray(outputDsp.parameters)) {
    throw new Error('Recovery output DSP snapshot is malformed.');
  }
  if (outputDsp.algorithm === null) {
    if (Object.keys(outputDsp.parameters).length !== 0 || outputDsp.enabled) {
      throw new Error('Recovery output DSP has parameters or enabled state without an algorithm.');
    }
    return;
  }
  if (!isAlgorithm(outputDsp.algorithm)) throw new Error(`Recovery output DSP algorithm ${outputDsp.algorithm} is unsupported.`);
  validateParameters(outputDsp.parameters, outputDsp.algorithm);
}

/** Build, configure and silence-check a detached output-DSP worklet stage. */
export async function buildBrowserRecoveryOutputDsp(
  context: AudioContext,
  silentSink: GainNode,
  outputDsp: BrowserRecoverySnapshot['fx']['outputDsp'],
  loadModule: RecoveryOutputModuleLoader,
): Promise<BrowserRecoveryOutputDsp | null> {
  validateBrowserRecoveryOutputDspSnapshot(outputDsp);
  const algorithm = outputDsp.algorithm as BrowserFxAlgorithm | null;
  if (algorithm === null) return null;
  if (context.state !== 'suspended' || silentSink.gain.value !== 0) {
    throw new Error('Recovery output DSP requires a suspended context and a zero-gain sink.');
  }
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
    throw new Error('Recovery output DSP requires Browser AudioWorklet support.');
  }
  await loadModule(context);

  const node = new AudioWorkletNode(context, 'rc505-fx-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: {
      algorithm,
      sampleRate: context.sampleRate,
      parameters: outputDsp.parameters,
      // Preserve the requested activation state, but the node has no source
      // and its only destination is a zero-gain candidate sink.
      bypassed: !outputDsp.enabled,
    },
  });
  let disposed = false;
  try {
    node.connect(silentSink);
    await new Promise<void>((resolve, reject) => {
      const expectedKeys = Object.keys(outputDsp.parameters).sort();
      const previousMessage = node.port.onmessage;
      const previousProcessorError = node.onprocessorerror;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timeout);
        node.port.onmessage = previousMessage;
        node.onprocessorerror = previousProcessorError;
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      timeout = setTimeout(() => finish(new Error(`Recovery output DSP ${algorithm} did not acknowledge configuration within ${READY_TIMEOUT_MS} ms.`)), READY_TIMEOUT_MS);
      node.port.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data as { type?: unknown; message?: unknown; parameterKeys?: unknown } | null;
        if (message?.type === 'error') {
          finish(new Error(typeof message.message === 'string' ? message.message : 'Recovery output DSP rejected its parameters.'));
          return;
        }
        if (message?.type !== 'configure-ack') return;
        const received = Array.isArray(message.parameterKeys)
          ? message.parameterKeys.filter((key): key is string => typeof key === 'string').sort()
          : [];
        if (received.length !== expectedKeys.length || received.some((key, index) => key !== expectedKeys[index])) {
          finish(new Error(`Recovery output DSP ${algorithm} acknowledged a different parameter set.`));
          return;
        }
        finish();
      };
      node.onprocessorerror = () => finish(new Error(`Recovery output DSP ${algorithm} processor failed.`));
      try {
        node.port.postMessage({ type: 'configure', parameters: outputDsp.parameters });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (context.state !== 'suspended' || silentSink.gain.value !== 0) {
      throw new Error('Recovery output DSP candidate left the suspended/muted state while becoming ready.');
    }
    return Object.freeze({
      algorithm,
      parameters: Object.freeze({ ...outputDsp.parameters }),
      enabled: outputDsp.enabled,
      node,
      state: 'ready' as const,
      dispose() {
        if (disposed) return;
        disposed = true;
        try { node.disconnect(); } catch { /* idempotent candidate cleanup */ }
        try { node.port.close?.(); } catch { /* AudioContext close remains final cleanup */ }
      },
    });
  } catch (error) {
    if (!disposed) {
      disposed = true;
      try { node.disconnect(); } catch { /* candidate context closes on caller failure */ }
      try { node.port.close?.(); } catch { /* candidate context closes on caller failure */ }
    }
    throw error;
  }
}
