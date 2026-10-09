import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const MODULE_PATH = resolve(process.cwd(), 'public/worklets/time-stretch-core.js');
const core = await import(pathToFileURL(MODULE_PATH).href);
const moduleHash = createHash('sha256').update(readFileSync(MODULE_PATH)).digest('hex');
const sampleRate = 48_000;
const quantumFrames = 128;
const trackCount = 5;
const historyFrames = 8_192;
const warmupQuanta = 80;
const measuredQuanta = 800;
const speeds = [0.5, 1.3, 2, 0.75, 4];
const requestedLayers = process.argv[2] === 'all'
  ? [1, 8, 32]
  : [Number(process.argv[2] ?? 32)];
if (requestedLayers.some((count) => !Number.isInteger(count) || count < 1 || count > 32)) {
  throw new RangeError('Pass a history-layer count from 1 to 32, or "all".');
}

function makeHistoryReader(track, channel, historyLayerCount) {
  const layers = Array.from({ length: historyLayerCount }, (_, layer) => {
    const samples = new Float32Array(historyFrames);
    const frequency = 43 + track * 19 + layer * 3.17 + channel * 7.3;
    const phase = track * 0.37 + layer * 0.11 + channel * 0.53;
    for (let frame = 0; frame < historyFrames; frame += 1) {
      samples[frame] = Math.sin((2 * Math.PI * frequency * frame) / sampleRate + phase) * (0.45 / historyLayerCount);
    }
    return (sourceFrame) => {
      const first = Math.floor(sourceFrame);
      const second = first + 1 === historyFrames ? 0 : first + 1;
      const fraction = sourceFrame - first;
      return samples[first] + (samples[second] - samples[first]) * fraction;
    };
  });

  return (sourceFrame) => {
    let sum = 0;
    for (let layer = 0; layer < historyLayerCount; layer += 1) sum += layers[layer](sourceFrame);
    return sum;
  };
}

function makeBenchTracks(historyLayerCount) {
  return Array.from({ length: trackCount }, (_, track) => ({
    state: core.createTimeStretchState(core.TIME_STRETCH_WINDOW_FRAMES, core.TIME_STRETCH_HOP_FRAMES),
    left: makeHistoryReader(track, 0, historyLayerCount),
    right: makeHistoryReader(track, 1, historyLayerCount),
  }));
}

function renderQuantum(tracks) {
  for (let frame = 0; frame < quantumFrames; frame += 1) {
    for (let track = 0; track < trackCount; track += 1) {
      const item = tracks[track];
      core.processTimeStretchFrame(item.state, historyFrames, speeds[track], false, item.left, item.right);
    }
  }
}

function summarize(durationsMs, scenario, historyLayerCount) {
  const sorted = Array.from(durationsMs).sort((left, right) => left - right);
  const percentile = (rank) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * rank) - 1)];
  const maximum = sorted.at(-1) ?? 0;
  const quantumBudgetMs = quantumFrames / sampleRate * 1000;
  return {
    scenario,
    historyLayersPerChannel: historyLayerCount,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: maximum,
    p99WithinQuantumBudget: percentile(0.99) <= quantumBudgetMs,
    maxWithinQuantumBudget: maximum <= quantumBudgetMs,
  };
}

function measureSameHop(historyLayerCount) {
  const tracks = makeBenchTracks(historyLayerCount);
  for (let index = 0; index < warmupQuanta; index += 1) {
    for (const item of tracks) {
      core.resetTimeStretchState(item.state);
      item.state.pendingIndex = core.TIME_STRETCH_HOP_FRAMES;
    }
    const startedAt = performance.now();
    for (let track = 0; track < trackCount; track += 1) {
      const item = tracks[track];
      core.processTimeStretchFrame(item.state, historyFrames, speeds[track], false, item.left, item.right);
    }
    if (!Number.isFinite(performance.now() - startedAt)) throw new Error('Invalid warm-up timing.');
  }

  const durationsMs = new Float64Array(measuredQuanta);
  for (let quantum = 0; quantum < measuredQuanta; quantum += 1) {
    for (const item of tracks) {
      core.resetTimeStretchState(item.state);
      item.state.pendingIndex = core.TIME_STRETCH_HOP_FRAMES;
    }
    const startedAt = performance.now();
    for (let track = 0; track < trackCount; track += 1) {
      const item = tracks[track];
      core.processTimeStretchFrame(item.state, historyFrames, speeds[track], false, item.left, item.right);
    }
    durationsMs[quantum] = performance.now() - startedAt;
  }
  return summarize(durationsMs, 'five-track-same-hop-start', historyLayerCount);
}

function prepareScheduledTracks(tracks) {
  for (let track = 0; track < trackCount; track += 1) {
    const item = tracks[track];
    core.resetTimeStretchState(item.state);
    core.processTimeStretchFrame(item.state, historyFrames, speeds[track], false, item.left, item.right);
    item.state.pendingIndex = Math.round(core.TIME_STRETCH_HOP_FRAMES * 0.74);
    item.state.nextReady = false;
  }
}

function measureTwoTrackPrefetch(historyLayerCount) {
  const tracks = makeBenchTracks(historyLayerCount);
  for (let index = 0; index < warmupQuanta; index += 1) {
    prepareScheduledTracks(tracks);
    const startedAt = performance.now();
    for (let track = 0; track < 2; track += 1) {
      const item = tracks[track];
      core.prepareTimeStretchHop(item.state, historyFrames, speeds[track], false, item.left, item.right);
    }
    renderQuantum(tracks);
    if (!Number.isFinite(performance.now() - startedAt)) throw new Error('Invalid warm-up timing.');
  }

  const durationsMs = new Float64Array(measuredQuanta);
  for (let quantum = 0; quantum < measuredQuanta; quantum += 1) {
    prepareScheduledTracks(tracks);
    const startedAt = performance.now();
    for (let track = 0; track < 2; track += 1) {
      const item = tracks[track];
      core.prepareTimeStretchHop(item.state, historyFrames, speeds[track], false, item.left, item.right);
    }
    renderQuantum(tracks);
    durationsMs[quantum] = performance.now() - startedAt;
  }
  return summarize(durationsMs, 'two-track-prefetch-plus-five-track-128-frame-quantum', historyLayerCount);
}

const quantumBudgetMs = quantumFrames / sampleRate * 1000;
const results = requestedLayers.flatMap((layers) => [
  measureSameHop(layers),
  measureTwoTrackPrefetch(layers),
]);
const report = {
  benchmark: 'shared-time-stretch-module-five-track-budget-profile',
  modulePath: MODULE_PATH,
  moduleSha256: moduleHash,
  sampleRate,
  quantumFrames,
  quantumBudgetMs,
  windowFrames: core.TIME_STRETCH_WINDOW_FRAMES,
  hopFrames: core.TIME_STRETCH_HOP_FRAMES,
  trackCount,
  speeds,
  warmupQuanta,
  measuredQuanta,
  results,
  limitations: [
    'Runs the exact shared ESM module with synthetic history readers in Node V8, not inside Chromium AudioWorklet.',
    'The same-hop case forces all five tracks to generate an FFT hop in one measured block.',
    'The scheduled case measures two hop preparations, all five tracks processing one complete 128-frame quantum, and synthetic history reads.',
    'It excludes the rest of the Worklet graph, composite-layer flattening, browser scheduling, device callbacks, and hardware XRUN qualification.',
  ],
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
