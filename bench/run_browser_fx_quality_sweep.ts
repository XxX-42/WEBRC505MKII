/**
 * Reproducible raw-signal baseline for every catalogued, implemented Browser
 * FX algorithm. This calls the production TypeScript DSP core with synthetic
 * stereo tones/impulses and arbitrary software block lengths. It is a
 * measurement artifact generator, not a sound-quality acceptance decision,
 * AudioWorklet/device timing benchmark, or Roland-fidelity test.
 *
 * Run with: npx vite-node bench/run_browser_fx_quality_sweep.ts
 * Override output with FX_QUALITY_OUTPUT=/path/to/report.json
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FX_CATALOG } from '../src/audio/fx/catalog';
import {
  BROWSER_WORKLET_FX_TYPES,
  type BrowserWorkletFxName,
} from '../src/audio/fx/BrowserWorkletFX';
import {
  BROWSER_FX_ALGORITHM_INFO,
  BrowserFxDspCore,
  type BrowserFxAlgorithm,
} from '../src/audio/fx/dsp/BrowserFxDspCore';

const SAMPLE_RATE = 48_000;
const FRAME_COUNT = SAMPLE_RATE;
const BLOCK_PATTERN = [64, 96, 128, 192, 256] as const;
const RAW_PATH = resolve(process.env.FX_QUALITY_RAW ?? 'bench/results/browser_fx_quality_2026-10-17.raw.f32');
const REPORT_PATH = resolve(process.env.FX_QUALITY_OUTPUT ?? 'bench/results/browser_fx_quality_2026-10-17.json');

function runtimeName(displayName: string): BrowserWorkletFxName {
  switch (displayName) {
    case 'LPF': return 'DSP LPF';
    case 'BPF': return 'DSP BPF';
    case 'HPF': return 'DSP HPF';
    case 'REVERB': return 'FDN8 REVERB';
    default: return displayName as BrowserWorkletFxName;
  }
}

function synthesizeInput() {
  const left = new Float32Array(FRAME_COUNT);
  const right = new Float32Array(FRAME_COUNT);
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const impulse = frame === 128 ? 0.5 : 0;
    left[frame] = impulse + 0.25 * Math.sin((2 * Math.PI * 997 * frame) / SAMPLE_RATE);
    right[frame] = -0.5 * impulse + 0.2 * Math.sin((2 * Math.PI * 401 * frame) / SAMPLE_RATE);
  }
  return { left, right };
}

function channelMetrics(samples: Float32Array) {
  let peak = 0;
  let sum = 0;
  let squareSum = 0;
  let nonFiniteSamples = 0;
  let overFullScaleSamples = 0;
  for (const raw of samples) {
    if (!Number.isFinite(raw)) {
      nonFiniteSamples += 1;
      continue;
    }
    const value = raw;
    peak = Math.max(peak, Math.abs(value));
    sum += value;
    squareSum += value * value;
    if (Math.abs(value) > 1) overFullScaleSamples += 1;
  }
  return {
    frames: samples.length,
    peakAbs: peak,
    rms: Math.sqrt(squareSum / samples.length),
    meanDc: sum / samples.length,
    nonFiniteSamples,
    samplesAboveFullScale: overFullScaleSamples,
  };
}

function hashSamples(samples: Float32Array) {
  return createHash('sha256')
    .update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
    .digest('hex');
}

function asRawBytes(samples: Float32Array) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

function main() {
  const input = synthesizeInput();
  const rawParts: Buffer[] = [];
  const results: Array<Record<string, unknown>> = [];
  let byteOffset = 0;

  const catalogEffects = FX_CATALOG.filter((effect) => effect.implementationStatus === 'implemented'
    && effect.runtimeImplementations?.some((item) => item.runtime === 'browser'));
  for (const effect of catalogEffects) {
    const name = runtimeName(effect.displayName);
    const algorithm: BrowserFxAlgorithm = BROWSER_WORKLET_FX_TYPES[name];
    const core = new BrowserFxDspCore(algorithm, SAMPLE_RATE, { bpm: 120 });
    core.setBypass(false, 0);

    const outputLeft = new Float32Array(FRAME_COUNT);
    const outputRight = new Float32Array(FRAME_COUNT);
    const startedAt = performance.now();
    let offset = 0;
    let blockIndex = 0;
    while (offset < FRAME_COUNT) {
      const blockFrames = Math.min(BLOCK_PATTERN[blockIndex % BLOCK_PATTERN.length]!, FRAME_COUNT - offset);
      core.processBlock(
        input.left.subarray(offset, offset + blockFrames),
        input.right.subarray(offset, offset + blockFrames),
        outputLeft.subarray(offset, offset + blockFrames),
        outputRight.subarray(offset, offset + blockFrames),
        blockFrames,
      );
      offset += blockFrames;
      blockIndex += 1;
    }
    const elapsedMs = performance.now() - startedAt;

    const rawStart = byteOffset;
    for (const samples of [input.left, input.right, outputLeft, outputRight]) {
      const bytes = asRawBytes(samples);
      rawParts.push(bytes);
      byteOffset += bytes.byteLength;
    }
    results.push({
      catalogId: effect.id,
      sourceIndex: effect.sourceIndex,
      displayName: effect.displayName,
      browserEffectName: name,
      algorithm,
      algorithmicLatencySamples: BROWSER_FX_ALGORITHM_INFO[algorithm].algorithmicLatencySamples,
      inputSha256: `${hashSamples(input.left)}:${hashSamples(input.right)}`,
      outputSha256: `${hashSamples(outputLeft)}:${hashSamples(outputRight)}`,
      rawOffsetBytes: rawStart,
      rawLayout: ['inputLeft', 'inputRight', 'outputLeft', 'outputRight'],
      rawFramesPerChannel: FRAME_COUNT,
      input: { left: channelMetrics(input.left), right: channelMetrics(input.right) },
      output: { left: channelMetrics(outputLeft), right: channelMetrics(outputRight) },
      processingElapsedMs: elapsedMs,
      processingTimingNote: 'Wall elapsed around a Node-hosted DSP core loop; not AudioWorklet callback CPU or real-time evidence.',
    });
  }

  const raw = Buffer.concat(rawParts);
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    status: 'RAW_MEASUREMENTS_NOT_ACCEPTANCE',
    runtime: 'Node-hosted production TypeScript BrowserFxDspCore',
    scope: 'All FX_CATALOG effects marked implemented with a Browser runtime route; experimental BEAT SHIFT excluded.',
    sampleRateHz: SAMPLE_RATE,
    framesPerChannel: FRAME_COUNT,
    durationSeconds: FRAME_COUNT / SAMPLE_RATE,
    blockPatternFrames: BLOCK_PATTERN,
    inputSignal: 'Independent stereo 997 Hz / 401 Hz sinusoids at 0.25 / 0.20 amplitude plus a 0.5 / -0.25 impulse at frame 128.',
    parameterization: 'BrowserFxDspCore constructor defaults with BPM 120; no custom algorithm parameters.',
    rawFile: RAW_PATH,
    rawFormat: 'Little-endian Float32 interleaved by effect as inputLeft, inputRight, outputLeft, outputRight; each channel is FRAME_COUNT samples.',
    rawBytes: raw.byteLength,
    rawSha256: createHash('sha256').update(raw).digest('hex'),
    effectCount: results.length,
    measurements: results,
    limitations: [
      'Synthetic deterministic signals are diagnostic inputs, not perceptual music or reference-device captures.',
      'Metrics record peak, RMS, DC mean, non-finite count and samples above full scale; this script applies no subjective or product quality threshold.',
      'Node core measurements do not substitute for the shipped AudioWorklet, browser/device timing, XRUN, acoustic latency or hardware acceptance.',
      'Clean-room reconstructions are not original Roland algorithms, presets or factory samples.',
    ],
  };

  mkdirSync(dirname(RAW_PATH), { recursive: true });
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(RAW_PATH, raw);
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  const nonFinite = results.reduce((total, result) => {
    const output = result.output as { left: { nonFiniteSamples: number }; right: { nonFiniteSamples: number } };
    return total + output.left.nonFiniteSamples + output.right.nonFiniteSamples;
  }, 0);
  process.stdout.write(`Wrote ${results.length} FX raw baselines (${raw.byteLength} bytes); non-finite output samples: ${nonFinite}\n`);
  process.stdout.write(`Report: ${REPORT_PATH}\nRaw: ${RAW_PATH}\n`);
  if (nonFinite > 0) process.exitCode = 1;
}

main();
