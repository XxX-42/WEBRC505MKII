import { evaluateRealtimeWorklet } from './evaluateRealtimeWorklet';
import { BrowserRealtimeRuntime } from '../../src/audio/BrowserRealtimeRuntime';
import {
  BROWSER_REALTIME_QUANTUM_FRAMES,
  BrowserRealtimeOpcode,
  TrackMetaWord,
  createControlSharedBuffer,
} from '../../src/audio/browserRealtimeProtocol';

type PortMessage = Record<string, unknown>;

interface ProcessorPort {
  onmessage: ((event: { data: PortMessage }) => void) | null;
  onmessageerror: (() => void) | null;
  messages: PortMessage[];
  postMessage(message: PortMessage): void;
  start(): void;
  close(): void;
}

class HarnessProcessorBase {
  public port: ProcessorPort = {
    onmessage: null,
    onmessageerror: null,
    messages: [],
    postMessage(message) { this.messages.push(message); },
    start() {},
    close() {},
  };
}

interface RealtimeProcessor extends HarnessProcessorBase {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  handlePortMessage(message: unknown): void;
  rhythmStep: number;
  rhythmNextStepFrame: number;
}

export type CoreAudioSource = (frame: number, channel: 0 | 1) => number;

export interface CoreAudioHarness {
  runtime: BrowserRealtimeRuntime;
  processor: RealtimeProcessor;
  controlBuffer: SharedArrayBuffer;
  currentFrame(): number;
  processQuantum(source?: CoreAudioSource, frames?: number): Float32Array[][];
  lastQuantumOutput(): Float32Array[][];
  processFrames(frames: number, source?: CoreAudioSource, acceleratedBlockFrames?: number): Promise<void>;
  run<T>(operation: Promise<T>, source?: CoreAudioSource, advanceUntilFrame?: number): Promise<T>;
  command(
    opcode: number,
    track: number,
    arg0?: number,
    arg1?: number,
    flags?: number,
    source?: CoreAudioSource,
    targetFrame?: number,
  ): Promise<Awaited<ReturnType<BrowserRealtimeRuntime['enqueue']>>>;
  createAudioBuffer(left: Float32Array, right?: Float32Array): AudioBuffer;
  dispose(): void;
}

export function createCoreAudioHarness(sampleRate = 48_000): CoreAudioHarness {
  const controlBuffer = createControlSharedBuffer();
  let RegisteredProcessor: (new (options: unknown) => HarnessProcessorBase) | null = null;
  let frame = 0;
  const scope: Record<string, unknown> = {
    AudioWorkletProcessor: HarnessProcessorBase,
    registerProcessor: (_name: string, processor: new (options: unknown) => HarnessProcessorBase) => {
      RegisteredProcessor = processor;
    },
    SharedArrayBuffer,
    Int32Array,
    Uint8Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    Atomics,
    Math,
    Number,
    Array,
    Object,
    Map,
    Set,
    Error,
    RangeError,
    performance,
    console,
    sampleRate,
    currentFrame: 0,
  };
  evaluateRealtimeWorklet(scope);
  if (!RegisteredProcessor) throw new Error('The actual realtime Worklet source did not register a processor.');
  const processor = new RegisteredProcessor({ processorOptions: { controlBuffer } }) as RealtimeProcessor;
  const runtimePort = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage(message: PortMessage) {
      processor.handlePortMessage(message);
    },
  };
  processor.port.postMessage = (message) => {
    processor.port.messages.push(message);
    runtimePort.onmessage?.({ data: message } as MessageEvent);
  };
  const runtime = new BrowserRealtimeRuntime(
    { port: runtimePort } as unknown as AudioWorkletNode,
    controlBuffer,
    sampleRate,
  );

  let inputLeft = new Float32Array(BROWSER_REALTIME_QUANTUM_FRAMES);
  let inputRight = new Float32Array(BROWSER_REALTIME_QUANTUM_FRAMES);
  let outputs = createOutputs(BROWSER_REALTIME_QUANTUM_FRAMES);

  const processQuantum = (source: CoreAudioSource = () => 0, frames = BROWSER_REALTIME_QUANTUM_FRAMES) => {
    if (!Number.isInteger(frames) || frames < 1 || frames > 16_384) {
      throw new RangeError('A simulated realtime Worklet block must contain 1–16384 frames.');
    }
    if (frames > inputLeft.length) {
      inputLeft = new Float32Array(frames);
      inputRight = new Float32Array(frames);
    }
    for (let offset = 0; offset < frames; offset += 1) {
      inputLeft[offset] = source(frame + offset, 0);
      inputRight[offset] = source(frame + offset, 1);
    }
    if (frames !== outputs[0]![0]!.length) outputs = createOutputs(frames);
    scope.currentFrame = frame;
    processor.process([[inputLeft.subarray(0, frames), inputRight.subarray(0, frames)]], outputs);
    frame += frames;
    return outputs;
  };

  const processFrames = async (
    frames: number,
    source: CoreAudioSource = () => 0,
    acceleratedBlockFrames = BROWSER_REALTIME_QUANTUM_FRAMES,
  ) => {
    if (!Number.isSafeInteger(frames) || frames < 0) throw new RangeError('Frame count must be a non-negative safe integer.');
    if (!Number.isInteger(acceleratedBlockFrames) || acceleratedBlockFrames < 1 || acceleratedBlockFrames > 16_384) {
      throw new RangeError('Accelerated Worklet blocks must contain 1–16384 frames.');
    }
    let processed = 0;
    let quantumCount = 0;
    while (processed < frames) {
      // Bulk acceleration must respect the Worklet's prepared 4096-frame
      // timeline scratch capacity. Direct processQuantum calls still permit
      // larger blocks so rejection paths can be exercised deliberately.
      const count = Math.min(acceleratedBlockFrames, 4096, frames - processed);
      processQuantum(source, count);
      processed += count;
      quantumCount += 1;
      // Storage growth is asynchronous on the engine thread. Yield often enough
      // for its worklet message round-trip, but keep this accelerated simulation
      // many orders faster than real-time.
      if (acceleratedBlockFrames > BROWSER_REALTIME_QUANTUM_FRAMES || (quantumCount & 63) === 0) {
        const microtaskBudget = acceleratedBlockFrames > BROWSER_REALTIME_QUANTUM_FRAMES ? 24 : 3;
        for (let turn = 0; turn < microtaskBudget; turn += 1) await Promise.resolve();
      }
    }
    await Promise.resolve();
    await Promise.resolve();
  };

  const run = async <T>(
    operation: Promise<T>,
    source: CoreAudioSource = () => 0,
    advanceUntilFrame?: number,
  ): Promise<T> => {
    let done = false;
    let result!: T;
    let failure: unknown;
    void operation.then((value) => { result = value; done = true; }, (error: unknown) => { failure = error; done = true; });
    const control = new Int32Array(controlBuffer);
    let attempts = 0;
    while (!done && attempts < 500_000) {
      attempts += 1;
      await Promise.resolve();
      const commandQueued = (Atomics.load(control, 0) >>> 0) !== (Atomics.load(control, 1) >>> 0);
      const awaitingTargetFrame = advanceUntilFrame !== undefined && frame <= advanceUntilFrame;
      if (commandQueued || awaitingTargetFrame) processQuantum(source);
      // When worklet commands are not queued, the operation is in an async
      // main-thread phase such as a bounded PCM export chunk. Yield directly
      // to its timer instead of busy-spinning microtasks and starving timers.
      else await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (!done) throw new Error('The integrated Worklet/Runtime action did not receive its expected ACK or storage message.');
    if (failure !== undefined) throw failure;
    return result;
  };

  const command: CoreAudioHarness['command'] = async (
    opcode: number,
    track: number,
    arg0 = 0,
    arg1 = 0,
    flags = 0,
    source = () => 0,
    targetFrame,
  ) => await run(runtime.enqueue(opcode, track, arg0, arg1, targetFrame, flags), source, targetFrame);

  return {
    runtime,
    processor,
    controlBuffer,
    currentFrame: () => frame,
    processQuantum,
    lastQuantumOutput: () => outputs,
    processFrames,
    run,
    command,
    createAudioBuffer(left, right = left) {
      const channels = [left, right];
      return {
        numberOfChannels: 2,
        length: left.length,
        sampleRate,
        duration: left.length / sampleRate,
        getChannelData(channel: number) { return channels[channel]!; },
        copyFromChannel() {},
        copyToChannel() {},
      } as unknown as AudioBuffer;
    },
    dispose() { runtime.dispose(); },
  };
}

function createOutputs(frames: number): Float32Array[][] {
  return Array.from({ length: 7 }, () => [new Float32Array(frames), new Float32Array(frames)]);
}

export async function recordBaseTrack(
  harness: CoreAudioHarness,
  track: number,
  frames: number,
  source: CoreAudioSource,
): Promise<number> {
  await harness.run(harness.runtime.prepareTrack(track));
  await harness.run(harness.runtime.beginTake(track, 'BASE'));
  await harness.command(BrowserRealtimeOpcode.START_RECORD, track, 0, 0, 0, source);
  await harness.processFrames(frames, source);
  const stopped = await harness.command(BrowserRealtimeOpcode.STOP_RECORD, track, 0, 0, 0, source);
  return stopped.loopFrames;
}

export function readTrackMeta(harness: CoreAudioHarness, track: number, field: number): number {
  const metadata = harness.runtime.getTrackMetadata(track);
  if (!metadata) throw new Error(`Track ${track + 1} metadata is not allocated.`);
  if (field === TrackMetaWord.PLAY_POSITION) return Atomics.load(metadata, field);
  return Atomics.load(metadata, field);
}
