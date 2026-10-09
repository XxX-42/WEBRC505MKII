const COMPRESSOR_PROCESSOR_NAME = 'webrc505-linked-compressor';
const MIN_SIGNAL_LEVEL = 1e-8;
const DB_TO_GAIN = Math.LN10 / 20;

class WebRC505CompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'thresholdDb', defaultValue: -24, minValue: -120, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 12, minValue: 1, maxValue: 40, automationRate: 'k-rate' },
      { name: 'kneeDb', defaultValue: 30, minValue: 0, maxValue: 40, automationRate: 'k-rate' },
      { name: 'attackSeconds', defaultValue: 0.003, minValue: 0.0001, maxValue: 1, automationRate: 'k-rate' },
      { name: 'releaseSeconds', defaultValue: 0.25, minValue: 0.001, maxValue: 3, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.envelope = 0;
  }

  process(inputs, outputs, parameters) {
    const inputChannels = inputs[0];
    const outputChannels = outputs[0];
    const outputLeft = outputChannels && outputChannels[0];
    if (!outputLeft) return true;

    const frames = outputLeft.length;
    const inputLeft = inputChannels && inputChannels[0];
    const inputRight = inputChannels && inputChannels.length > 1 ? inputChannels[1] : inputLeft;
    const outputRight = outputChannels.length > 1 ? outputChannels[1] : null;
    const thresholdDb = this.readParameter(parameters, 'thresholdDb', -24, -120, 0);
    const ratio = this.readParameter(parameters, 'ratio', 12, 1, 40);
    const kneeDb = this.readParameter(parameters, 'kneeDb', 30, 0, 40);
    const attackSeconds = this.readParameter(parameters, 'attackSeconds', 0.003, 0.0001, 1);
    const releaseSeconds = this.readParameter(parameters, 'releaseSeconds', 0.25, 0.001, 3);
    const attackCoefficient = Math.exp(-1 / (attackSeconds * sampleRate));
    const releaseCoefficient = Math.exp(-1 / (releaseSeconds * sampleRate));
    const compressionEnabled = ratio > 1;
    const lowerKneeLevel = compressionEnabled
      ? Math.exp((thresholdDb - kneeDb * 0.5) * DB_TO_GAIN)
      : Infinity;
    let envelope = Number.isFinite(this.envelope) && this.envelope >= 0 ? this.envelope : 0;

    for (let frame = 0; frame < frames; frame += 1) {
      let left = inputLeft && frame < inputLeft.length ? inputLeft[frame] : 0;
      let right = inputRight && frame < inputRight.length ? inputRight[frame] : left;
      if (!Number.isFinite(left)) left = 0;
      if (!Number.isFinite(right)) right = 0;

      const detectorLevel = Math.max(Math.abs(left), Math.abs(right));
      const coefficient = detectorLevel > envelope ? attackCoefficient : releaseCoefficient;
      envelope = detectorLevel + coefficient * (envelope - detectorLevel);

      let gain = 1;
      if (envelope > lowerKneeLevel && envelope > MIN_SIGNAL_LEVEL) {
        const inputDb = 20 * Math.log10(envelope);
        const aboveThresholdDb = inputDb - thresholdDb;
        let outputDb = inputDb;

        if (kneeDb > 0 && aboveThresholdDb > -kneeDb * 0.5 && aboveThresholdDb < kneeDb * 0.5) {
          const kneePositionDb = aboveThresholdDb + kneeDb * 0.5;
          outputDb = inputDb + ((1 / ratio) - 1) * (kneePositionDb * kneePositionDb) / (2 * kneeDb);
        } else if (aboveThresholdDb >= kneeDb * 0.5) {
          outputDb = thresholdDb + aboveThresholdDb / ratio;
        }

        gain = Math.exp((outputDb - inputDb) * DB_TO_GAIN);
        if (!Number.isFinite(gain) || gain < 0) gain = 0;
      }

      const compressedLeft = left * gain;
      const compressedRight = right * gain;
      outputLeft[frame] = Number.isFinite(compressedLeft) ? compressedLeft : 0;
      if (outputRight) outputRight[frame] = Number.isFinite(compressedRight) ? compressedRight : 0;
    }

    this.envelope = Number.isFinite(envelope) && envelope >= 0 ? envelope : 0;
    return true;
  }

  readParameter(parameters, name, fallback, minimum, maximum) {
    const values = parameters[name];
    const value = values && values.length > 0 ? values[0] : fallback;
    if (!Number.isFinite(value)) return fallback;
    return Math.max(minimum, Math.min(maximum, value));
  }
}

registerProcessor(COMPRESSOR_PROCESSOR_NAME, WebRC505CompressorProcessor);
