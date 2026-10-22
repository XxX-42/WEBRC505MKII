#!/usr/bin/env node
/**
 * Same-process ABBA kernel comparison for the constructor-selected Browser FX
 * scalar dispatcher. This is a Node VM diagnostic, never a live callback or
 * full-runtime acceptance test.
 *
 * Usage: node bench/compare_browser_fx_dispatch_abba.mjs BASELINE.js CANDIDATE.js OUTPUT.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import vm from 'node:vm';

const [baselinePathArg, candidatePathArg, outputPathArg] = process.argv.slice(2);
if (!baselinePathArg || !candidatePathArg || !outputPathArg) {
  throw new Error('Usage: node bench/compare_browser_fx_dispatch_abba.mjs BASELINE.js CANDIDATE.js OUTPUT.json');
}
const sampleRateHz = Number(process.env.RC505_FX_DISPATCH_SAMPLE_RATE ?? 44_100);
const blockFrames = 128;
const warmupBlocks = 64;
const measuredBlocks = Number(process.env.RC505_FX_DISPATCH_BLOCKS ?? 256);
if (!Number.isSafeInteger(measuredBlocks) || measuredBlocks < 1) throw new RangeError('RC505_FX_DISPATCH_BLOCKS must be a positive integer');
const allAlgorithms = [
  'lpf', 'bpf', 'hpf', 'ring-mod', 'flanger', 'dynamics', 'delay', 'chorus', 'phaser',
  'tremolo', 'reverb', 'gate-reverb', 'distortion',
];
const requestedAlgorithms = process.env.RC505_FX_DISPATCH_ALGORITHMS?.split(',').map((item) => item.trim()).filter(Boolean);
const algorithms = requestedAlgorithms ?? allAlgorithms;
if (algorithms.length === 0 || algorithms.some((algorithm) => !allAlgorithms.includes(algorithm))) {
  throw new RangeError(`RC505_FX_DISPATCH_ALGORITHMS must be a subset of: ${allAlgorithms.join(', ')}`);
}
const baselinePath = resolve(baselinePathArg);
const candidatePath = resolve(candidatePathArg);
const [baselineSource, candidateSource] = await Promise.all([
  readFile(baselinePath, 'utf8'),
  readFile(candidatePath, 'utf8'),
]);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function createProcessorClass(source, filename) {
  const registrations = new Map();
  class MockAudioWorkletProcessor {
    constructor() { this.port = { onmessage: null, postMessage() {} }; }
  }
  const globals = {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    registerProcessor(name, Constructor) { registrations.set(name, Constructor); },
    sampleRate: sampleRateHz,
    currentFrame: 0,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.runInNewContext(source, globals, { filename });
  const Processor = registrations.get('rc505-fx-processor');
  if (typeof Processor !== 'function') throw new Error(`${filename} did not register rc505-fx-processor`);
  return { Processor, globals };
}

const baseline = createProcessorClass(baselineSource, baselinePath);
const candidate = createProcessorClass(candidateSource, candidatePath);
const inputLeft = new Float32Array(blockFrames);
const inputRight = new Float32Array(blockFrames);
const outputLeft = new Float32Array(blockFrames);
const outputRight = new Float32Array(blockFrames);
for (let frame = 0; frame < blockFrames; frame += 1) {
  const t = frame / sampleRateHz;
  inputLeft[frame] = 0.21 * Math.sin(2 * Math.PI * 440 * t) + 0.04 * Math.sin(2 * Math.PI * 1_307 * t);
  inputRight[frame] = 0.18 * Math.sin(2 * Math.PI * 659 * t + 0.2) + 0.03 * Math.sin(2 * Math.PI * 1_711 * t);
}
const inputs = [[inputLeft, inputRight]];
const outputs = [[outputLeft, outputRight]];

function createRun(runtime, algorithm) {
  const processor = new runtime.Processor({ processorOptions: {
    algorithm,
    sampleRate: sampleRateHz,
    parameters: {},
    bypassed: false,
  } });
  let frame = 0;
  const execute = (count) => {
    for (let index = 0; index < count; index += 1) {
      runtime.globals.currentFrame = frame;
      processor.process(inputs, outputs);
      frame += blockFrames;
    }
  };
  execute(warmupBlocks);
  return () => {
    let energy = 0;
    let finite = true;
    const started = process.hrtime.bigint();
    for (let index = 0; index < measuredBlocks; index += 1) {
      runtime.globals.currentFrame = frame;
      processor.process(inputs, outputs);
      frame += blockFrames;
      for (let sample = 0; sample < blockFrames; sample += 1) {
        const left = outputLeft[sample];
        const right = outputRight[sample];
        finite &&= Number.isFinite(left) && Number.isFinite(right);
        energy += left * left + right * right;
      }
    }
    const elapsedNs = Number(process.hrtime.bigint() - started);
    const audioSeconds = (measuredBlocks * blockFrames) / sampleRateHz;
    return {
      elapsedMilliseconds: elapsedNs / 1e6,
      realtimeRatio: elapsedNs / (audioSeconds * 1e9),
      nanosecondsPerInputFrame: elapsedNs / (measuredBlocks * blockFrames),
      finite,
      outputRms: Math.sqrt(energy / (measuredBlocks * blockFrames * 2)),
    };
  };
}

const results = [];
for (const algorithm of algorithms) {
  const runs = [
    createRun(baseline, algorithm),
    createRun(candidate, algorithm),
    createRun(candidate, algorithm),
    createRun(baseline, algorithm),
  ];
  // ABBA order is retained per algorithm to reduce run-order/thermal drift.
  const [baselineA1, candidateB1, candidateB2, baselineA2] = runs.map((run) => run());
  const baselineMean = (baselineA1.realtimeRatio + baselineA2.realtimeRatio) / 2;
  const candidateMean = (candidateB1.realtimeRatio + candidateB2.realtimeRatio) / 2;
  results.push({
    algorithm,
    order: ['A1', 'B1', 'B2', 'A2'],
    baselineA1,
    candidateB1,
    candidateB2,
    baselineA2,
    baselineMeanRealtimeRatio: baselineMean,
    candidateMeanRealtimeRatio: candidateMean,
    relativeKernelTimeReductionPercent: (baselineMean - candidateMean) / baselineMean * 100,
    allRunsFinite: [baselineA1, candidateB1, candidateB2, baselineA2].every((run) => run.finite),
  });
}

const result = {
  schemaVersion: 1,
  benchmark: 'rc505_browser_fx_dispatch_same_process_abba',
  generatedAtUtc: new Date().toISOString(),
  repositoryHead: process.env.RC505_REPOSITORY_HEAD ?? null,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  sampleRateHz,
  blockFrames,
  warmupBlocks,
  measuredBlocks,
  baselineSourcePath: baselinePath,
  baselineSourceSha256: sha256(baselineSource),
  candidateSourcePath: candidatePath,
  candidateSourceSha256: sha256(candidateSource),
  timingSource: 'process.hrtime.bigint() around synchronous worklet process() in a Node VM; per-algorithm A/B/B/A run order.',
  exclusions: [
    'No AudioWorklet scheduler, AudioContext, cross-thread scheduling, or physical endpoint.',
    'One FX processor at a time; no 20-slot graph, LIVE_POLY nodes, rhythm engine, recording, or host scheduling.',
    'Output exact-equivalence is asserted by tests/unit/browser-fx-scalar-dispatch.spec.ts, not inferred from benchmark RMS.',
    'Results are diagnostic and cannot pass the Browser/native realtime, XRUN, quality, or hardware gates.',
  ],
  results,
};
await writeFile(resolve(outputPathArg), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
