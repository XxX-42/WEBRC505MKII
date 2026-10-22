#!/usr/bin/env node
/**
 * Supplemental synchronous Node VM per-quantum distribution diagnostic.
 * NOT browser AudioWorklet callback timing, a scheduler/XRUN test, or hardware
 * realtime acceptance. The timed region contains only calls to the exact
 * bundled production processor(s), with numeric performance.now timestamps.
 * Timing buffers, signal/output blocks and processor instances are allocated
 * before measurement; no logging, output scanning or harness array creation
 * occurs inside a measured region. Timestamp overhead is not subtracted.
 *
 * Usage: node bench/measure_browser_worklet_vm_quantiles.mjs BASE.js FINAL.js OUT.json
 * Optional: BLOCKS=256 ROUNDS=2 WARMUP=128 RATES=44100,48000 CHANNELS=1,2
 *           TRACKS=1,5 ALGORITHMS=bypass,reverb,gate-reverb,reverse-reverb,preamp,distortion,phaser,mod-delay,tape-echo
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import vm from 'node:vm';

const [baselinePath, candidatePath, outputPath] = process.argv.slice(2);
if (!outputPath) throw Error('Usage: BASELINE.js FINAL.js OUTPUT.json');
const blocks = Number(process.env.BLOCKS ?? 256);
const rounds = Number(process.env.ROUNDS ?? 2);
const warmup = Number(process.env.WARMUP ?? 128);
for (const [name, count] of Object.entries({ blocks, rounds, warmup })) {
  if (!Number.isSafeInteger(count) || count < 1) throw RangeError(`${name} must be a positive integer`);
}
const list = (name, fallback) => process.env[name]?.split(',').map(x => x.trim()) ?? fallback;
const sources = { baseline: readFileSync(baselinePath, 'utf8'), candidate: readFileSync(candidatePath, 'utf8') };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const runtimes = Object.fromEntries(Object.entries(sources).map(([version, source]) => {
  let Processor;
  const globals = {
    AudioWorkletProcessor: class { constructor() { this.configurationErrors = []; this.port = { onmessage: null, postMessage: message => { if (message?.type === 'error') this.configurationErrors.push(message.message); } }; } },
    registerProcessor(name, constructor) { if (name === 'rc505-fx-processor') Processor = constructor; },
    currentFrame: 0,
    sampleRate: 48000,
  };
  vm.runInNewContext(source, globals, { filename: version + '-fx-processor.js' });
  if (!Processor) throw Error(`Missing processor registration: ${version}`);
  return [version, { globals, Processor }];
}));
const memory = () => ({ ...process.memoryUsage(), sampledAtUtc: new Date().toISOString() });
function distribution(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  const quantile = q => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
  return {
    count: sorted.length,
    meanMs: sorted.reduce((sum, x) => sum + x, 0) / sorted.length,
    medianMs: quantile(0.5), p95Ms: quantile(0.95), p99Ms: quantile(0.99), maxMs: sorted.at(-1), minMs: sorted[0],
  };
}
function createRun(version, rate, channels, tracks, algorithm) {
  const { Processor, globals } = runtimes[version];
  const processors = Array.from({ length: tracks }, () => new Processor({ processorOptions: {
    algorithm: algorithm === 'bypass' ? 'reverb' : algorithm,
    sampleRate: rate, bypassed: algorithm === 'bypass',
    parameters: algorithm === 'preamp' ? { preampModel: 4, preampGainPercent: 90, preampLevelDb: -6 } : algorithm === 'distortion' ? { distortionMode: 'fuzz', driveDb: 24, outputDb: -6, mix: 0.7 } : { decaySeconds: 8, mix: 0.7, dampingHz: 9000 },
  } }));
  const configurationErrors = processors.flatMap(processor => processor.configurationErrors);
  if (configurationErrors.length) throw Error(JSON.stringify(configurationErrors));
  const inputs = processors.map((_, track) => [Array.from({ length: channels }, (_, channel) =>
    Float32Array.from({ length: 128 }, (_, frame) =>
      0.12 * Math.sin(2 * Math.PI * (233 + track * 71 + channel * 307) * frame / rate) + (frame === 0 ? 0.4 : 0)))]);
  const outputs = processors.map(() => [Array.from({ length: channels }, () => new Float32Array(128))]);
  const durations = new Float64Array(blocks * rounds * 2);
  let currentFrame = 0, measuredCount = 0;
  for (let block = 0; block < warmup; block++) {
    globals.currentFrame = currentFrame;
    for (let track = 0; track < tracks; track++) processors[track].process(inputs[track], outputs[track]);
    currentFrame += 128;
  }
  function pass() {
    const memoryBefore = memory();
    const from = measuredCount;
    for (let block = 0; block < blocks; block++) {
      globals.currentFrame = currentFrame;
      const start = performance.now();
      for (let track = 0; track < tracks; track++) processors[track].process(inputs[track], outputs[track]);
      const end = performance.now();
      durations[measuredCount++] = end - start;
      currentFrame += 128;
    }
    const memoryAfter = memory();
    // Inspection and aggregation are outside the measured regions.
    let finite = true, energy = 0, stereoDifference = 0;
    for (const bus of outputs) for (let channel = 0; channel < channels; channel++) for (let frame = 0; frame < 128; frame++) {
      const sample = bus[0][channel][frame];
      finite &&= Number.isFinite(sample);
      energy += sample * sample;
      if (channel === 1) stereoDifference += Math.abs(sample - bus[0][0][frame]);
    }
    return {
      version, distribution: distribution(durations.subarray(from, measuredCount)), memoryBefore, memoryAfter,
      memoryDeltaBytes: Object.fromEntries(['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'].map(key => [key, memoryAfter[key] - memoryBefore[key]])),
      lastBlockFinite: finite, lastBlockRms: Math.sqrt(energy / (tracks * channels * 128)),
      lastBlockStereoDifference: channels === 2 ? stereoDifference : null,
    };
  }
  return { pass, summary: () => distribution(durations.subarray(0, measuredCount)) };
}

const timerSamples = new Float64Array(4096);
for (let i = 0; i < timerSamples.length; i++) { const start = performance.now(); timerSamples[i] = performance.now() - start; }
const output = {
  schemaVersion: 1, benchmark: 'exact_browser_worklet_node_vm_per_quantum_distributions',
  startedAtUtc: new Date().toISOString(), sourceHashes: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, sha256(source)])),
  node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
  sampleFramesPerQuantum: 128, measuredQuantaPerPass: blocks, rounds, warmupQuanta: warmup,
  ordering: 'ABBA for each round, freshly constructed independent baseline/candidate state per scenario',
  timer: 'Node performance.now; numerical timing array preallocated; timestamp overhead not subtracted',
  emptyTimestampPairMs: distribution(timerSamples),
  limitations: [
    'Synchronous exact-source Node VM calls, NOT actual browser callback timing or scheduling.',
    'One measured quantum invokes all requested independent FX instances sequentially; not production TrackAudio loops.',
    'Reverse-reverb is an effect, not reversed loop playback. KeepPitch and the Signalsmith runtime are not measured.',
    'No audio device, callback deadline, XRUN, or long-duration endpoint continuity acceptance.',
    'Process memory snapshots include both runtimes, harness, all live scenarios and V8 GC; not per-worklet attribution or peak RSS.',
    'Heap/RSS deltas are point-in-time changes, not proof of allocations within a callback; GC may produce negative deltas.',
    'Shared cloud CPU scheduling and V8 JIT/GC variation remain uncontrolled even when workers coordinate an isolated slot.',
    'Last-block finite/RMS checks are diagnostic only; use separate full-stream PCM matrix for correctness.',
  ],
  actualBrowserCallback: { meanMs: null, medianMs: null, p95Ms: null, p99Ms: null, maxMs: null, reason: 'Chromium launch blocked by environment Unix-socket restriction; no actual browser callback samples.' },
  actualHardwareXruns: null, processMemoryBeforeScenarios: memory(), scenarios: [],
};
for (const rate of list('RATES', [44100, 48000]).map(Number))
for (const channels of list('CHANNELS', [1, 2]).map(Number))
for (const tracks of list('TRACKS', [1, 5]).map(Number))
for (const algorithm of list('ALGORITHMS', ['bypass', 'reverb', 'gate-reverb', 'reverse-reverb', 'preamp', 'distortion', 'phaser', 'mod-delay', 'tape-echo'])) {
  const runs = { baseline: createRun('baseline', rate, channels, tracks, algorithm), candidate: createRun('candidate', rate, channels, tracks, algorithm) };
  const passes = [];
  for (let round = 0; round < rounds; round++) for (const version of ['baseline', 'candidate', 'candidate', 'baseline']) passes.push({ round, ...runs[version].pass() });
  const scenario = { rate, channels, tracks, algorithm, distributions: { baseline: runs.baseline.summary(), candidate: runs.candidate.summary() }, passes };
  output.scenarios.push(scenario);
  console.log(JSON.stringify({ rate, channels, tracks, algorithm, ...scenario.distributions }));
  // Persist completed scenarios for diagnostics. Only completed=true is final.
  writeFileSync(outputPath, JSON.stringify({ ...output, completed: false }, null, 2) + '\n');
}
output.processMemoryAfterScenarios = memory();
output.completed = true;
output.completedAtUtc = new Date().toISOString();
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
