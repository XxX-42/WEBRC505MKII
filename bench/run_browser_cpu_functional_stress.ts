/**
 * CPU-only, Node-hosted functional stress simulation. This exercises production
 * Browser DSP classes and source AudioWorklet processors with synthetic signals.
 * It is not an AudioWorklet/browser/device run; it makes no XRUN, P99, deadline,
 * acoustic-latency, zero-GC or hardware-performance claim.
 *
 * Default: process 30 minutes of 48 kHz audio frames. Override SIM_SECONDS and
 * STRESS_OUTPUT only for smoke tests or alternate result locations.
 */
import { createContext, runInContext } from 'node:vm';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BrowserFxDspCore } from '../src/audio/fx/dsp/BrowserFxDspCore';
import { LiveMonoPitchProcessor } from '../src/audio/pitch/liveMono';
import { createCleanRoomPatternEvents } from '../src/audio/rhythm/events';
import { RHYTHM_PATTERN_CATALOG } from '../src/audio/rhythm/catalog';
import { RhythmWorkletCore } from '../src/audio/worklet/RhythmProcessor';

const sampleRate = 48_000;
const simulatedSeconds = positiveInt(process.env.SIM_SECONDS, 1_800);
const targetFrames = sampleRate * simulatedSeconds;
const maxBlockFrames = 256;
const blockPattern = [64, 96, 128, 192, 256] as const;
const progressFrames = sampleRate * 60;
const outputPath = resolve(process.env.STRESS_OUTPUT ?? 'bench/results/browser_cpu_functional_stress_30min.json');

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RangeError(`Invalid positive integer: ${value}`);
  return parsed;
}

interface PortMessage {
  readonly type?: string;
  readonly sequence?: number;
  readonly chunkIndex?: number;
  readonly validFrames?: number;
  readonly framesCaptured?: number;
  readonly droppedFrames?: number;
  readonly overflowEvents?: number;
  readonly chunksSent?: number;
  readonly slotIndex?: number;
  readonly samples?: Float32Array;
  readonly indices?: Uint32Array;
  readonly values?: Float32Array;
}

class SimPort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onPost: ((message: PortMessage) => void) | null = null;
  postMessage(message: PortMessage): void { this.onPost?.(message); }
}

class SimAudioWorkletProcessor {
  readonly port = new SimPort();
  constructor(_options?: unknown) {}
}

interface WorkletInstance {
  readonly port: SimPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  readonly framesCaptured?: number;
  readonly chunksSent?: number;
  readonly droppedFrames?: number;
  readonly overflowEvents?: number;
  readonly overflowFrames?: number;
  readonly patchesSent?: number;
}

type WorkletCtor = new (options?: unknown) => WorkletInstance;

const registered = new Map<string, WorkletCtor>();
const vmState = {
  currentFrame: 0,
  Float32Array,
  Uint32Array,
  Uint8Array,
  Int32Array,
  AudioWorkletProcessor: SimAudioWorkletProcessor,
  registerProcessor(name: string, ctor: WorkletCtor): void { registered.set(name, ctor); },
};
const vmContext = createContext(vmState);
runInContext(readFileSync(resolve('public/worklets/looper-processor.js'), 'utf8'), vmContext);
runInContext(readFileSync(resolve('public/worklets/browser-track-io.js'), 'utf8'), vmContext);

const Recorder = registered.get('looper-processor');
const Overdub = registered.get('rc505-overdub-processor');
if (!Recorder || !Overdub) throw new Error('Expected recording and overdub AudioWorklet source processors were not registered');

const maxBuffer = (frames: number) => new Float32Array(frames);
const inputL = maxBuffer(maxBlockFrames);
const inputR = maxBuffer(maxBlockFrames);
const chainScratchL = maxBuffer(maxBlockFrames);
const chainScratchR = maxBuffer(maxBlockFrames);
const chainAltL = maxBuffer(maxBlockFrames);
const chainAltR = maxBuffer(maxBlockFrames);
const trackMixL = maxBuffer(maxBlockFrames);
const trackMixR = maxBuffer(maxBlockFrames);
const rhythmMono = maxBuffer(maxBlockFrames);
const overdubInput = maxBuffer(maxBlockFrames);
const recorderOutL = maxBuffer(maxBlockFrames);
const recorderOutR = maxBuffer(maxBlockFrames);
const overdubOut = maxBuffer(maxBlockFrames);
const monoPitchInput = maxBuffer(maxBlockFrames);
const monoPitchOutput = maxBuffer(maxBlockFrames);
const rhythmViews = new Map(blockPattern.map((frames) => [frames, rhythmMono.subarray(0, frames)] as const));
const inputBankOutput = { left: inputL as Float32Array, right: inputR as Float32Array };
const trackBankOutput = { left: trackMixL as Float32Array, right: trackMixR as Float32Array };

// Five one-second loop buffers stand in for five deterministic playback sources.
// Track zero is run through the production LIVE_MONO processor (YIN/PSOLA).
const loopFrames = sampleRate;
const trackBuffers = Array.from({ length: 5 }, (_, track) => {
  const data = new Float32Array(loopFrames);
  const fundamental = 110 + track * 55;
  for (let i = 0; i < loopFrames; i += 1) {
    const phase = (2 * Math.PI * i) / sampleRate;
    data[i] = 0.075 * Math.sin(phase * fundamental)
      + 0.017 * Math.sin(phase * fundamental * 2.01)
      + 0.006 * Math.sin(phase * fundamental * 3.02);
  }
  return data;
});
const liveInput = new Float32Array(loopFrames);
for (let i = 0; i < loopFrames; i += 1) {
  liveInput[i] = 0.12 * Math.sin(2 * Math.PI * 220 * i / sampleRate)
    + 0.012 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
}

const inputFx = [
  new BrowserFxDspCore('lpf', sampleRate, { cutoffHz: 9_000, q: 0.71 }),
  new BrowserFxDspCore('distortion', sampleRate, { driveDb: 8, mix: 0.35, distortionMode: 'overdrive' }),
  new BrowserFxDspCore('vibrato', sampleRate, { vibratoRateHz: 0.7, vibratoDepthPercent: 38, vibratoDelayMs: 3.5, mix: 0.72 }),
  new BrowserFxDspCore('sustainer', sampleRate, { thresholdDb: -30, ratio: 5, releaseMs: 180, outputDb: 0, mix: 0.9 }),
];
const trackFx = [
  new BrowserFxDspCore('chorus', sampleRate, { chorusDelayMs: 15, chorusDepthMs: 5, chorusVoices: 2, mix: 0.2 }),
  new BrowserFxDspCore('reverb', sampleRate, { decaySeconds: 1.2, dampingHz: 8_000, mix: 0.12 }),
  new BrowserFxDspCore('delay', sampleRate, { delayTimeMs: 240, delayFeedback: 0.12, delayToneHz: 7_000, mix: 0.13 }),
  new BrowserFxDspCore('auto-pan', sampleRate, { autoPanRateHz: 0.32, autoPanDepth: 0.45, mix: 0.7 }),
];
for (const fx of [...inputFx, ...trackFx]) fx.setBypass(false, 0);
const liveMono = new LiveMonoPitchProcessor({ sampleRate, semitones: 5, minimumFrequencyHz: 110, maximumFrequencyHz: 700 });

const pattern = RHYTHM_PATTERN_CATALOG[0];
if (!pattern) throw new Error('The 240-pattern Browser metadata catalog was empty');
const rhythmEvents = createCleanRoomPatternEvents(pattern, {
  sampleRate, bpm: 112, startFrame: 0, bars: 1, variation: 'D', section: 'main',
});
const rhythm = new RhythmWorkletCore(sampleRate);
rhythm.configure({
  sampleRate,
  bpm: 112,
  swingPercent: 58,
  quantizeGrid: '1/16',
  startFrame: 0,
  stepsPerBar: pattern.meter.numerator * (16 / pattern.meter.denominator),
  kitIndex: 1,
  maxVoices: 24,
  eventTemplate: rhythmEvents,
});

const workletBuffers = [inputL, inputR, chainScratchL, chainScratchR, chainAltL, chainAltR, trackMixL, trackMixR, overdubInput, recorderOutL, recorderOutR, overdubOut];
const workletViews = new WeakMap<Float32Array, Map<number, Float32Array>>();
for (const buffer of workletBuffers) workletViews.set(buffer, new Map(blockPattern.map((frames) => [frames, buffer.subarray(0, frames)] as const)));
const view = (buffer: Float32Array, frames: number) => workletViews.get(buffer)!.get(frames) ?? buffer.subarray(0, frames);
const recorderInputChannels = [view(inputL, 64)];
const recorderInputs = [recorderInputChannels];
const recorderOutputChannels = [view(recorderOutL, 64), view(recorderOutR, 64)];
const recorderOutputs = [recorderOutputChannels];
const overdubInputChannels = [view(overdubInput, 64)];
const overdubInputs = [overdubInputChannels];
const overdubOutputChannels = [view(overdubOut, 64)];
const overdubOutputs = [overdubOutputChannels];

const recorder = new Recorder({ processorOptions: { chunkSize: 16_384, chunkPoolSize: 3, maxRecordingFrames: targetFrames } });
let recordingChunks = 0;
let recordingFrames = 0;
let recordingSequenceError = false;
let recordingDroppedFrames = 0;
recorder.port.onPost = (message) => {
  if (message.type === 'RECORD_CHUNK') {
    if (message.sequence !== recordingChunks) recordingSequenceError = true;
    recordingChunks += 1;
    recordingFrames += message.validFrames ?? 0;
    const recycled = message.samples;
    if (!recycled || message.sequence === undefined) throw new Error('Malformed record chunk in worklet simulation');
    if (message.chunkIndex === undefined) throw new Error('Record chunk did not report its pool slot');
    recorder.port.onmessage?.({ data: { type: 'RECYCLE_CHUNK', chunkIndex: message.chunkIndex, samples: recycled } });
  } else if (message.type === 'RECORD_COMPLETE') {
    recordingDroppedFrames = message.droppedFrames ?? 0;
  }
};
recorder.port.onmessage?.({ data: { type: 'START_RECORD' } });

const overdubLoop = trackBuffers[0]!;
const overdubPoolSize = 3;
const overdubChunkFrames = 16_384;
const overdub = new Overdub({ processorOptions: { transferBufferFrames: overdubChunkFrames, transferBufferPoolSize: overdubPoolSize } });
const makeOverdubBuffers = () => Array.from({ length: overdubPoolSize }, (_, slotIndex) => ({
  slotIndex,
  indices: new Uint32Array(overdubChunkFrames),
  values: new Float32Array(overdubChunkFrames),
}));
let overdubPatches = 0;
let overdubPatchFrames = 0;
let overdubOverflowFrames = 0;
let overdubSequenceError = false;
overdub.port.onPost = (message) => {
  if (message.type === 'OVERDUB_PATCH') {
    if (message.sequence !== overdubPatches) overdubSequenceError = true;
    overdubPatches += 1;
    overdubPatchFrames += message.validFrames ?? 0;
    const slotIndex = message.slotIndex;
    if (slotIndex === undefined || !message.indices || !message.values) throw new Error('Malformed overdub patch in worklet simulation');
    overdub.port.onmessage?.({ data: { type: 'RECYCLE_OVERDUB_BUFFER', slotIndex, indices: message.indices, values: message.values } });
  } else if (message.type === 'OVERDUB_STOPPED') {
    overdubOverflowFrames = message.overflowFrames ?? 0;
  } else if (message.type === 'OVERDUB_ERROR') {
    throw new Error(`Overdub worklet error: ${String((message as PortMessage & { message?: string }).message)}`);
  }
};
overdub.port.onmessage?.({ data: {
  type: 'OVERDUB_INIT',
  samples: overdubLoop,
  buffers: makeOverdubBuffers(),
  startFrame: 0,
  startOffsetSamples: 0,
  latencySamples: 0,
  recordingOffsetSamples: 0,
  reverse: false,
} });

const startTime = performance.now();
const cpuStart = process.cpuUsage();
const memoryStart = process.memoryUsage();
let frame = 0;
let blocks = 0;
let outputNonFinite = 0;
let outputAbsMax = 0;
let checksum = 0;
let lastCheckpointFrame = 0;
let parameterEpoch = 0;
let progressEvents = 0;
const lastLog = () => {
  const simulated = frame / sampleRate;
  process.stdout.write(`CPU functional simulation ${simulated.toFixed(0)}/${simulatedSeconds}s, ${blocks} blocks\n`);
};

function runBank(cores: readonly BrowserFxDspCore[], initialL: Float32Array, initialR: Float32Array, frames: number, result: { left: Float32Array; right: Float32Array }): void {
  let left = initialL;
  let right = initialR;
  for (let index = 0; index < cores.length; index += 1) {
    const destinationL = left === chainScratchL ? chainAltL : chainScratchL;
    const destinationR = right === chainScratchR ? chainAltR : chainScratchR;
    cores[index]!.processBlock(left, right, destinationL, destinationR, frames);
    left = destinationL;
    right = destinationR;
  }
  result.left = left;
  result.right = right;
}

while (frame < targetFrames) {
  const requestedBlock = blockPattern[blocks % blockPattern.length]!;
  const frames = Math.min(requestedBlock, targetFrames - frame);
  for (let offset = 0; offset < frames; offset += 1) {
    const sourceIndex = (frame + offset) % loopFrames;
    inputL[offset] = liveInput[sourceIndex]!;
    inputR[offset] = liveInput[sourceIndex]! * 0.93;
  }

  runBank(inputFx, inputL, inputR, frames, inputBankOutput);
  const inputOutL = inputBankOutput.left;
  const inputOutR = inputBankOutput.right;
  vmState.currentFrame = frame;
  recorderInputChannels[0] = view(inputOutL, frames);
  recorderOutputChannels[0] = view(recorderOutL, frames);
  recorderOutputChannels[1] = view(recorderOutR, frames);
  recorder.process(recorderInputs, recorderOutputs);
  for (let offset = 0; offset < frames; offset += 1) overdubInput[offset] = inputOutL[offset]! * 0.002;
  overdubInputChannels[0] = view(overdubInput, frames);
  overdubOutputChannels[0] = view(overdubOut, frames);
  overdub.process(overdubInputs, overdubOutputs);

  for (let offset = 0; offset < frames; offset += 1) {
    const sourceIndex = (frame + offset) % loopFrames;
    monoPitchInput[offset] = overdubLoop[sourceIndex]!;
    let sumL = inputOutL[offset]! * 0.35;
    let sumR = inputOutR[offset]! * 0.35;
    for (let track = 1; track < trackBuffers.length; track += 1) {
      const sample = trackBuffers[track]![sourceIndex]!;
      sumL += sample;
      sumR += sample * (track % 2 === 0 ? 0.86 : 1.04);
    }
    trackMixL[offset] = sumL;
    trackMixR[offset] = sumR;
  }
  liveMono.process(monoPitchInput, monoPitchOutput, frames);
  for (let offset = 0; offset < frames; offset += 1) {
    trackMixL[offset] += monoPitchOutput[offset]! * 0.5;
    trackMixR[offset] += monoPitchOutput[offset]! * 0.5;
  }
  rhythm.renderInto(frame, rhythmViews.get(frames) ?? rhythmMono.subarray(0, frames));
  for (let offset = 0; offset < frames; offset += 1) {
    const drum = rhythmMono[offset]! * 0.22;
    trackMixL[offset] += drum;
    trackMixR[offset] += drum;
  }

  runBank(trackFx, trackMixL, trackMixR, frames, trackBankOutput);
  const trackOutL = trackBankOutput.left;
  const trackOutR = trackBankOutput.right;
  for (let offset = 0; offset < frames; offset += 1) {
    const left = trackOutL[offset]!;
    const right = trackOutR[offset]!;
    if (!Number.isFinite(left) || !Number.isFinite(right)) outputNonFinite += 1;
    outputAbsMax = Math.max(outputAbsMax, Math.abs(Number.isFinite(left) ? left : 0), Math.abs(Number.isFinite(right) ? right : 0));
    checksum += (Number.isFinite(left) ? left : 0) * (((frame + offset) % 127) + 1);
  }

  frame += frames;
  blocks += 1;
  if (frame - lastCheckpointFrame >= progressFrames) {
    lastCheckpointFrame = frame;
    progressEvents += 1;
    lastLog();
  }
  if (frame >= parameterEpoch * sampleRate * 10) {
    parameterEpoch += 1;
    inputFx[0]!.setParameters({ cutoffHz: 500 + ((parameterEpoch * 733) % 18_000) });
    inputFx[1]!.setParameters({ driveDb: 2 + ((parameterEpoch * 3) % 24) });
    inputFx[2]!.setParameters({
      vibratoRateHz: 0.1 + ((parameterEpoch % 9) * 0.17),
      vibratoDepthPercent: 10 + ((parameterEpoch * 7) % 80),
      vibratoDelayMs: 0.5 + ((parameterEpoch % 8) * 0.7),
    });
    inputFx[3]!.setParameters({
      thresholdDb: -42 + ((parameterEpoch * 3) % 22),
      ratio: 1.5 + ((parameterEpoch % 8) * 1.5),
      releaseMs: 50 + ((parameterEpoch % 10) * 45),
      outputDb: -3 + ((parameterEpoch % 4) * 1.5),
    });
    trackFx[1]!.setParameters({ decaySeconds: 0.4 + ((parameterEpoch * 0.37) % 3), mix: 0.08 + ((parameterEpoch % 5) * 0.02) });
    trackFx[3]!.setParameters({ autoPanRateHz: 0.1 + ((parameterEpoch % 9) * 0.17), autoPanDepth: 0.25 + ((parameterEpoch % 5) * 0.12) });
  }
}
recorder.port.onmessage?.({ data: { type: 'STOP_RECORD' } });
overdub.port.onmessage?.({ data: { type: 'OVERDUB_STOP' } });

const durationMs = performance.now() - startTime;
const cpu = process.cpuUsage(cpuStart);
const memoryEnd = process.memoryUsage();
const result = {
  schema: 'rc505-browser-cpu-functional-simulation-v1',
  status: outputNonFinite === 0 && !recordingSequenceError && !overdubSequenceError && recordingDroppedFrames === 0 && overdubOverflowFrames === 0 ? 'passed-functional-simulation' : 'failed',
  explicitlyNotEvidenceFor: ['browser AudioWorklet execution', 'physical device audio', 'XRUN/dropout acceptance', 'P99/P99.9/deadline compliance', 'acoustic latency', 'whole-app CPU admission', '30-minute hardware acceptance'],
  environment: { platform: process.platform, arch: process.arch, node: process.version, sampleRate, channels: 2, blockPatternFrames: [...blockPattern], actualElapsedSeconds: durationMs / 1000 },
  workload: {
    simulatedAudioSeconds: simulatedSeconds,
    simulatedFrames: frame,
    callbackBlocks: blocks,
    fiveTrackPlaybackMix: true,
    inputFxBank: inputFx.map((fx) => fx.algorithm),
    trackFxBank: trackFx.map((fx) => fx.algorithm),
    pitch: { mode: 'LIVE_MONO clean-room YIN/PSOLA', semitones: liveMono.semitones, minimumFrequencyHz: liveMono.minimumFrequencyHz, maximumFrequencyHz: liveMono.maximumFrequencyHz, latencySamples: liveMono.latencySamples },
    rhythm: { patternId: pattern.id, patternName: pattern.pattern, kitIndex: 1, voicesPeak: rhythm.peakVoiceCount, voicesStolen: rhythm.stolenVoiceCount },
    recording: { framesCaptured: recordingFrames, chunks: recordingChunks, droppedFrames: recordingDroppedFrames, sequenceError: recordingSequenceError },
    overdub: { patches: overdubPatches, patchFrames: overdubPatchFrames, overflowFrames: overdubOverflowFrames, sequenceError: overdubSequenceError },
    parameterAutomationUpdates: parameterEpoch,
  },
  functionalChecks: { nonFiniteOutputSamples: outputNonFinite, outputPeak: outputAbsMax, checksum, rhythmProgressCheckpoints: progressEvents },
  cpuUsageMicros: cpu,
  memoryBytes: { startRss: memoryStart.rss, endRss: memoryEnd.rss, startHeapUsed: memoryStart.heapUsed, endHeapUsed: memoryEnd.heapUsed },
  notes: [
    'Loop data, input, rhythm, and kit timbres are synthetic and clean-room; this is a software simulation only.',
    'The workload executes production BrowserFxDspCore, LiveMonoPitchProcessor, RhythmWorkletCore, and source recording/overdub AudioWorklet processor code in a Node VM with a same-process simulated MessagePort.',
    'The actual audio callback worklet thread, structured-clone timing, browser scheduling, UI, browser memory, and audio hardware are not exercised.',
    'No callback timing percentile, XRUN, latency, fidelity or acoustic claim is reported.',
  ],
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`Wrote ${outputPath}\n`);
process.stdout.write(`${JSON.stringify({ status: result.status, actualElapsedSeconds: durationMs / 1000, simulatedAudioSeconds: simulatedSeconds, blocks, recordingChunks, overdubPatches, nonFinite: outputNonFinite, checksum }, null, 2)}\n`);
if (result.status !== 'passed-functional-simulation') process.exitCode = 1;
