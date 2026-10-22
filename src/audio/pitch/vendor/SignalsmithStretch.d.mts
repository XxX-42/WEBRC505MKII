interface SignalsmithStretchSchedule {
  active?: boolean;
  /** Upstream scheduler uses this as the output timeline cutoff. */
  outputTime?: number;
  output?: number;
  input?: number;
  rate?: number;
  semitones?: number;
  tonalityHz?: number;
  formantSemitones?: number;
  formantCompensation?: boolean;
  formantBaseHz?: number;
  loopStart?: number;
  loopEnd?: number;
}

interface SignalsmithStretchNode extends AudioWorkletNode {
  inputTime: number;
  start(when?: number, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<unknown>;
  stop(when?: number): Promise<unknown>;
  schedule(change: SignalsmithStretchSchedule): Promise<unknown>;
  configure(config: { preset?: 'default' | 'cheaper'; blockMs?: number; intervalMs?: number; splitComputation?: boolean }): Promise<unknown>;
  latency(): Promise<number>;
	wasmHeapBytes(): Promise<number>;
	disposeWasmMemory(): Promise<number>;
	addBuffers(buffers: Float32Array[], transfer?: Transferable[]): Promise<number>;
  dropBuffers(toSeconds?: number): Promise<unknown>;
}

declare const createSignalsmithStretchNode: (
  context: BaseAudioContext,
  options?: AudioWorkletNodeOptions,
) => Promise<SignalsmithStretchNode>;

export default createSignalsmithStretchNode;
