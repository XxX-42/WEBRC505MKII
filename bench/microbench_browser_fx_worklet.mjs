#!/usr/bin/env node
/**
 * Relative DSP-kernel diagnostic for the exact Browser FX AudioWorklet source.
 * This calls the registered processor under a Node VM with stereo Float32
 * blocks. It is not AudioWorklet scheduling, an end-to-end browser benchmark,
 * an XRUN test, or sound-quality acceptance.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(process.env.RC505_FX_MICROBENCH_SOURCE ?? resolve(root, 'public/worklets/fx-processor.js'));
const source = await readFile(sourcePath, 'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const sampleRateHz = Number(process.env.RC505_FX_MICROBENCH_SAMPLE_RATE ?? 44_100);
const blockFrames = 128;
const warmupBlocks = Number(process.env.RC505_FX_MICROBENCH_WARMUP_BLOCKS ?? 32);
const measuredBlocksPerPass = Number(process.env.RC505_FX_MICROBENCH_BLOCKS_PER_PASS ?? 256);
const passes = Number(process.env.RC505_FX_MICROBENCH_PASSES ?? 2);
if (!Number.isSafeInteger(warmupBlocks) || warmupBlocks < 0
  || !Number.isSafeInteger(measuredBlocksPerPass) || measuredBlocksPerPass < 1
  || !Number.isSafeInteger(passes) || passes < 1) {
  throw new RangeError('Microbenchmark warmup, measured blocks, and pass count must be valid positive integer workloads');
}

const algorithms = [
  ['DSP LPF', 'lpf'], ['DIST', 'distortion'], ['CHORUS', 'chorus'], ['DELAY', 'delay'],
  ['PHASER', 'phaser'], ['TREMOLO', 'tremolo'], ['AUTO PAN', 'auto-pan'], ['FDN8 REVERB', 'reverb'],
  ['FLANGER', 'flanger'], ['RING.MOD', 'ring-mod'], ['MOD DELAY', 'mod-delay'], ['PANNING DELAY', 'panning-delay'],
  ['DYNAMICS', 'dynamics'], ['SUSTAINER', 'sustainer'], ['TAPE ECHO', 'tape-echo'], ['GRANULAR DELAY', 'granular-delay'],
  ['PREAMP', 'preamp'], ['GATE REVERB', 'gate-reverb'], ['VIBRATO', 'vibrato'], ['STEREO ENHANCE', 'stereo-enhance'],
];
const selectedAlgorithm = process.env.RC505_FX_MICROBENCH_ALGORITHM?.trim().toLowerCase();
const selectedAlgorithms = selectedAlgorithm
  ? algorithms.filter(([, algorithm]) => algorithm === selectedAlgorithm)
  : algorithms;
if (selectedAlgorithms.length === 0) throw new RangeError(`Unsupported microbenchmark algorithm: ${selectedAlgorithm}`);

const registrations = new Map();
class MockAudioWorkletProcessor {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
}
const workletGlobal = {
  AudioWorkletProcessor: MockAudioWorkletProcessor,
  registerProcessor(name, Constructor) { registrations.set(name, Constructor); },
  sampleRate: sampleRateHz,
  currentFrame: 0,
  console: { log() {}, warn() {}, error() {} },
};
vm.runInNewContext(source, workletGlobal, { filename: 'public/worklets/fx-processor.js' });
const Processor = registrations.get('rc505-fx-processor');
if (typeof Processor !== 'function') throw new Error('FX source did not register rc505-fx-processor');

const leftIn = new Float32Array(blockFrames);
const rightIn = new Float32Array(blockFrames);
const leftOut = new Float32Array(blockFrames);
const rightOut = new Float32Array(blockFrames);
for (let frame = 0; frame < blockFrames; frame += 1) {
  const t = frame / sampleRateHz;
  leftIn[frame] = 0.21 * Math.sin(2 * Math.PI * 440 * t) + 0.04 * Math.sin(2 * Math.PI * 1_307 * t);
  rightIn[frame] = 0.18 * Math.sin(2 * Math.PI * 659 * t + 0.2) + 0.03 * Math.sin(2 * Math.PI * 1_711 * t);
}
const inputs = [[leftIn, rightIn]];
const outputs = [[leftOut, rightOut]];

const results = [];
for (const [catalogName, algorithm] of selectedAlgorithms) {
  const processor = new Processor({ processorOptions: {
    algorithm,
    sampleRate: sampleRateHz,
    parameters: {},
    bypassed: false,
  } });
  let frame = 0;
  for (let i = 0; i < warmupBlocks; i += 1) {
    workletGlobal.currentFrame = frame;
    processor.process(inputs, outputs);
    frame += blockFrames;
  }
  const passResults = [];
  let finiteOutput = true;
  let outputEnergy = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    const started = process.hrtime.bigint();
    for (let i = 0; i < measuredBlocksPerPass; i += 1) {
      workletGlobal.currentFrame = frame;
      processor.process(inputs, outputs);
      frame += blockFrames;
      for (let sample = 0; sample < blockFrames; sample += 1) {
        const left = leftOut[sample];
        const right = rightOut[sample];
        finiteOutput &&= Number.isFinite(left) && Number.isFinite(right);
        outputEnergy += left * left + right * right;
      }
    }
    const elapsedNs = Number(process.hrtime.bigint() - started);
    const audioSeconds = (measuredBlocksPerPass * blockFrames) / sampleRateHz;
    passResults.push({
      elapsedMilliseconds: elapsedNs / 1e6,
      audioSeconds,
      realtimeRatio: elapsedNs / 1e6 / (audioSeconds * 1000),
      nanosecondsPerInputFrame: elapsedNs / (measuredBlocksPerPass * blockFrames),
    });
  }
  results.push({
    catalogName,
    algorithm,
    measuredBlocksPerPass,
    passes: passResults,
    medianRealtimeRatio: [...passResults.map((pass) => pass.realtimeRatio)].sort((a, b) => a - b)[Math.floor(passResults.length / 2)],
    finiteOutput,
    outputRms: Math.sqrt(outputEnergy / (passes * measuredBlocksPerPass * blockFrames * 2)),
  });
}

results.sort((a, b) => b.medianRealtimeRatio - a.medianRealtimeRatio);
const output = {
  schemaVersion: 1,
  benchmark: 'rc505_browser_fx_worklet_node_vm_relative_kernel_microbenchmark',
  generatedAtUtc: new Date().toISOString(),
  repositoryHead: process.env.RC505_REPOSITORY_HEAD ?? null,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  sourcePath: process.env.RC505_FX_MICROBENCH_SOURCE ? sourcePath : 'public/worklets/fx-processor.js',
  sourceSha256,
  sampleRateHz,
  blockFrames,
  warmupBlocks,
  measuredBlocksPerPass,
  passes,
  timingSource: 'Node process.hrtime.bigint() around synchronous worklet process() calls in a Node VM; this is a relative kernel diagnostic only.',
  exclusions: [
    'No browser AudioWorklet scheduler, AudioContext, cross-thread scheduling, or device endpoint.',
    'No 20-slot graph or five Signalsmith LIVE_POLY processors.',
    'One synthetic stereo signal and one processor instance per algorithm; not a representative audio-quality suite.',
    'Results rank relative JavaScript DSP cost in this Node VM and do not pass or replace browser/native realtime acceptance.',
  ],
  results,
};
const outputPath = process.argv[2] ? resolve(process.argv[2]) : null;
if (outputPath) await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
