// New, auditable fixture after workspace loss. This is not restored old raw data.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInThisContext } from 'node:vm';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Session } from 'node:inspector';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, 'docs/performance/20261022-recovery');
const profileOnly = process.env.PROFILE_ONLY === '1';
const workload = process.env.WORKLOAD ?? 'harmonic';
assert.ok(['harmonic', 'noise'].includes(workload));
const workloadSuffix = workload === 'noise' ? '-noise' : '';
const output = resolve(process.argv[2] ?? `${directory}/${profileOnly ? `browser-main-global-profile-proof${workloadSuffix}` : `browser-main-global-ab${workloadSuffix}`}.json`);
const rate = 48000, blockFrames = 128, tracks = 5, bankBlocks = 256;
const timingBlocks = 512, warmupBlocks = 1024, parityBlocks = 1024, rounds = 6;
const frequencies = [147, 196, 220, 330, 440];
const parameters = { mix: 1, robotPitch: 7, robotFormantSemitones: 0 };
const expectedHashes = {
  baseline: 'ef9eee02f79425b2c2b3dbb68c64e70638896c449a8294c3e69493a089d350ab',
  candidate: 'd438eb0dbcefd1eb6ba2f5052f598d66cc277139f9b5d45bab8831ae96e1c8d5',
};
const sources = {
  baseline: readFileSync(`${directory}/fixtures/fx-processor-before.js`, 'utf8'),
  candidate: readFileSync(`${directory}/fixtures/fx-processor-combined.js`, 'utf8'),
};
const hash = data => createHash('sha256').update(data).digest('hex');
const sourceHashes = Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, hash(v)]));
assert.deepEqual(sourceHashes, expectedHashes);
assert.equal(hash(readFileSync(`${root}/public/worklets/fx-processor.js`)), sourceHashes.candidate);

function withGlobals(values, callback) {
  const old = Object.fromEntries(Object.keys(values).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  try {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    return callback();
  } finally {
    for (const [key, descriptor] of Object.entries(old)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}
function load(version) {
  let Constructor;
  class WorkletBase { constructor() { this.port = { onmessage: null, postMessage() {} }; } }
  withGlobals({ AudioWorkletProcessor: WorkletBase, sampleRate: rate, currentFrame: 0,
    registerProcessor(name, constructor) { assert.equal(name, 'rc505-fx-processor'); Constructor = constructor; } }, () => {
    runInThisContext(sources[version], { filename: `recovered-${version}-worklet.js` });
  });
  assert.equal(typeof Constructor, 'function');
  return Constructor;
}
const constructors = { baseline: load('baseline'), candidate: load('candidate') };
// Exactly the same precomputed input objects are reused in both versions.
// Each 32768-frame bank restarts phase, so this is not continuous-pure-tone input.
const noiseSeed = 0x5052026;
const noiseStates = Array.from({ length: tracks }, (_, track) => [0, 1].map(channel => (noiseSeed ^ Math.imul(track + 1, 0x9e3779b9) ^ Math.imul(channel + 1, 0x85ebca6b)) >>> 0));
const initialNoiseStates = noiseStates.map(states => states.slice());
const bank = Array.from({ length: tracks }, (_, track) => Array.from({ length: bankBlocks }, (_, block) =>
  Array.from({ length: 2 }, (_, channel) => Float32Array.from({ length: blockFrames }, (_, offset) => {
    if (workload === 'noise') {
      const next = (Math.imul(noiseStates[track][channel], 1664525) + 1013904223) >>> 0;
      noiseStates[track][channel] = next;
      return 0.25 * (2 * next / 0x100000000 - 1);
    }
    const phase = 2 * Math.PI * frequencies[track] * (block * blockFrames + offset) / rate;
    return 0.2 * Math.sin(phase) + (channel ? 0.04 * Math.sin(3 * phase) : 0.06 * Math.sin(2 * phase));
  }))));
const bytes = view => Buffer.from(view.buffer, view.byteOffset, view.byteLength);
function bankHash() {
  const h = createHash('sha256');
  for (const blocks of bank) for (const channels of blocks) for (const samples of channels) h.update(bytes(samples));
  return h.digest('hex');
}
const inputHash = bankHash();
function create(version, capture = false) {
  const messages = Array.from({ length: tracks }, () => []);
  const counters = Array.from({ length: tracks }, () => ({ messages: 0, psola: 0, signalsmith: 0 }));
  const processors = Array.from({ length: tracks }, (_, track) => {
    const p = new constructors[version]({ processorOptions: { algorithm: 'robot', sampleRate: rate, parameters, bypassed: false } });
    p.port.postMessage = message => {
      counters[track].messages += 1;
      if (message.type === 'robot-mode') counters[track][message.mode] += 1;
      if (capture) messages[track].push(message);
    };
    assert.equal(p.core.bypassed, false);
    assert.equal(p.core.wet.current, 1);
    assert.equal(p.core.wet.target, 1);
    return p;
  });
  const outputs = Array.from({ length: tracks }, () => [new Float32Array(blockFrames), new Float32Array(blockFrames)]);
  const inputWrappers = bank.map(blocks => blocks.map(channels => [channels]));
  const outputWrappers = outputs.map(channels => [channels]);
  let frame = 0;
  return { processors, outputs, messages, counters, get frame() { return frame; }, execute(blocks) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'currentFrame');
    try {
      for (let block = 0; block < blocks; block += 1) {
        globalThis.currentFrame = frame;
        const index = (frame / blockFrames) % bankBlocks;
        for (let track = 0; track < tracks; track += 1) {
          processors[track].process(inputWrappers[track][index], outputWrappers[track]);
        }
        frame += blockFrames;
      }
    } finally {
      if (previous) Object.defineProperty(globalThis, 'currentFrame', previous); else delete globalThis.currentFrame;
    }
  } };
}

// Correctness and active-path assertions MUST finish before any measurement.
const original = create('baseline', true), changed = create('candidate', true);
const pcmHashers = Array.from({ length: tracks }, () => createHash('sha256'));
const energy = Array(tracks).fill(0), dryDifference = Array(tracks).fill(0);
const fullScanCounts = Array.from({ length: tracks }, () => ({ controller: 0, liveDetector: 0 }));
for (let block = 0; block < parityBlocks; block += 1) {
  // Noise-only correctness instrumentation, absent from all timing runners.
  // Poison the last needed lag; a finite overwrite proves that full-scan path ran.
  if (workload === 'noise') for (const processor of changed.processors) {
    const robot = processor.core.robot, detector = robot.psolaProcessor.detector;
    robot.yinCmnd[robot.maxLag] = NaN;
    detector.normalizedDifferences[detector.maximumLag] = NaN;
  }
  original.execute(1); changed.execute(1);
  if (workload === 'noise') for (let track = 0; track < tracks; track += 1) {
    const robot = changed.processors[track].core.robot, detector = robot.psolaProcessor.detector;
    if (Number.isFinite(robot.yinCmnd[robot.maxLag])) fullScanCounts[track].controller += 1;
    if (Number.isFinite(detector.normalizedDifferences[detector.maximumLag])) fullScanCounts[track].liveDetector += 1;
  }
  for (let track = 0; track < tracks; track += 1) {
    for (let channel = 0; channel < 2; channel += 1) {
      const a = original.outputs[track][channel], b = changed.outputs[track][channel];
      assert.ok(bytes(a).equals(bytes(b)), `PCM mismatch block ${block}, track ${track}, channel ${channel}`);
      pcmHashers[track].update(bytes(b));
      for (let sample = 0; sample < blockFrames; sample += 1) {
        assert.ok(Number.isFinite(b[sample]));
        energy[track] += b[sample] ** 2;
        dryDifference[track] += (b[sample] - bank[track][block % bankBlocks][channel][sample]) ** 2;
      }
    }
  }
}
assert.deepEqual(changed.messages, original.messages);
assert.equal(bankHash(), inputHash, 'Input bank was mutated');
for (let track = 0; track < tracks; track += 1) {
  assert.ok(energy[track] > 1); assert.ok(dryDifference[track] > 1);
  if (workload === 'harmonic') assert.ok(changed.counters[track].psola > 0, 'No active PSOLA mode event');
  else {
    assert.ok(changed.counters[track].signalsmith > 0, 'No unvoiced fallback mode event');
    assert.ok(fullScanCounts[track].controller > 0 && fullScanCounts[track].liveDetector > 0, 'Full-scan path not observed in both detectors');
  }
  assert.ok(changed.counters[track].messages > 0);
  assert.equal(changed.processors[track].core.framesProcessed, parityBlocks * blockFrames);
  assert.equal(changed.processors[track].core.bypassed, false);
}
const result = {
  harnessSha256: hash(readFileSync(import.meta.filename)),
  generatedAt: new Date().toISOString(), fixture: 'Node main-global, unmodified actual FxProcessor IIFE bundles',
  scope: 'Five independent active/wet ROBOT worklet kernels; not Chrome, AudioContext, whole Browser mixer graph, external Signalsmith adapter or callback deadlines',
  workload, noiseSeed: workload === 'noise' ? noiseSeed : null, initialNoiseStates: workload === 'noise' ? initialNoiseStates : null,
  recoveredRaw: false, sourceHashes, nodeVersion: process.version,
  configuration: { rate, blockFrames, tracks, channels: 2, bankBlocks, frequencies, parameters, bypassed: false, timingBlocks, warmupBlocks, parityBlocks, rounds },
  signal: workload === 'noise' ? 'Deterministic uniform LCG noise, independent stereo/track seeds, repeated 32768-frame bank; not microphone or infinite white noise' : 'Precomputed harmonic stereo banks repeat every 32768 frames with phase discontinuities; not continuous pure tones',
  inputHash, fullScanCounts: workload === 'noise' ? fullScanCounts : null, parity: { framesPerTrack: parityBlocks * blockFrames, pcmBitExact: true, messagesExact: true,
    pcmHashes: pcmHashers.map(h => h.digest('hex')), energy, dryDifference, modeCounters: changed.counters,
    messageCounts: changed.messages.map(m => m.length), framesProcessed: changed.processors.map(p => p.core.framesProcessed) }, results: [],
};
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
const median = values => { const sorted = values.toSorted((a, b) => a - b); return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2; };
if (profileOnly) {
  const runner = create('candidate');
  runner.execute(warmupBlocks);
  const profileBlocks = 16384;
  const session = new Session();
  session.connect();
  const post = (method, parameters = {}) => new Promise((accept, reject) => {
    session.post(method, parameters, (error, reply) => error ? reject(error) : accept(reply));
  });
  let profile;
  try {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    await post('Profiler.start');
    runner.execute(profileBlocks);
    ({ profile } = await post('Profiler.stop'));
  } finally {
    session.disconnect();
  }
  assert.ok(profile.samples.length > 0, 'Empty CPU profile');
  for (let track = 0; track < tracks; track += 1) {
    assert.equal(runner.processors[track].core.bypassed, false);
    assert.equal(runner.processors[track].core.framesProcessed, (warmupBlocks + profileBlocks) * blockFrames);
    assert.ok(runner.counters[track][workload === 'noise' ? 'signalsmith' : 'psola'] > 0);
  }
  const profilePath = output.replace(/\.json$/, '') + '.cpuprofile';
  const profileText = JSON.stringify(profile);
  writeFileSync(profilePath, profileText + '\n');
  const selfSamples = new Map();
  for (const id of profile.samples) selfSamples.set(id, (selfSamples.get(id) ?? 0) + 1);
  result.profile = {
    candidateOnly: true, baselineProfiled: false, samplingIntervalMicroseconds: 1000,
    profileBlocks, framesPerTrack: profileBlocks * blockFrames, warmupBlocks,
    profilePath, profileSha256: hash(profileText + '\n'), samples: profile.samples.length,
    note: 'Only warmed candidate execute is enclosed by Profiler.start/stop. Inspector callback bookends may contribute a few samples. Sample shares are not performance improvement measurements.',
    modeCountersAfterWarmupAndProfile: runner.counters,
    framesProcessed: runner.processors.map(p => p.core.framesProcessed),
    topSelfSamples: profile.nodes.map(node => ({
      functionName: node.callFrame.functionName, url: node.callFrame.url,
      lineNumberZeroBased: node.callFrame.lineNumber, columnNumberZeroBased: node.callFrame.columnNumber,
      selfSamples: selfSamples.get(node.id) ?? 0,
      sharePercent: 100 * (selfSamples.get(node.id) ?? 0) / profile.samples.length,
    })).sort((a, b) => b.selfSamples - a.selfSamples).slice(0, 25),
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
} else if (!process.env.NO_TIMING) for (const order of ['ABBA', 'BAAB']) {
  const runners = { baseline: create('baseline'), candidate: create('candidate') };
  runners.baseline.execute(warmupBlocks); runners.candidate.execute(warmupBlocks);
  const sequence = order === 'ABBA' ? ['baseline', 'candidate', 'candidate', 'baseline'] : ['candidate', 'baseline', 'baseline', 'candidate'];
  const runs = [];
  for (let round = 0; round < rounds; round += 1) for (const version of sequence) {
    const startFrame = runners[version].frame, start = process.hrtime.bigint();
    runners[version].execute(timingBlocks);
    runs.push({ round, version, startFrame, endFrame: runners[version].frame, milliseconds: Number(process.hrtime.bigint() - start) / 1e6 });
  }
  const baselineMs = median(runs.filter(r => r.version === 'baseline').map(r => r.milliseconds));
  const candidateMs = median(runs.filter(r => r.version === 'candidate').map(r => r.milliseconds));
  result.results.push({ order, baselineMedianMs: baselineMs, candidateMedianMs: candidateMs, improvementPercent: 100 * (1 - candidateMs / baselineMs), runs });
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ ...result, results: result.results.map(({ runs, ...summary }) => summary) }, null, 2));
