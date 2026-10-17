interface SignalsmithStretchWasmModule {
  HEAP8: Int8Array;
  _presetDefault(channels: number, sampleRate: number): void;
  _presetCheaper(channels: number, sampleRate: number): void;
  _setBuffers(channels: number, samplesPerChannel: number): number;
  _setTransposeSemitones(semitones: number, tonalityLimit: number): void;
  _process(inputSamples: number, outputSamples: number): void;
  _inputLatency(): number;
  _outputLatency(): number;
  _blockSamples(): number;
  _intervalSamples(): number;
}

declare const createSignalsmithStretchWasm: () => Promise<SignalsmithStretchWasmModule>;
export default createSignalsmithStretchWasm;
