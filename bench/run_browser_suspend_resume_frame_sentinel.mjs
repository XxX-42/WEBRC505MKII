#!/usr/bin/env node
/**
 * Real Chromium probe for distinguishing an AudioContext-wide frame jump from
 * a callback gap isolated to the production Browser input-capture worklet.
 * It uses only a generated oscillator; no microphone or physical output is used.
 *
 *   node bench/run_browser_suspend_resume_frame_sentinel.mjs [--cycles 50] [--output path]
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArgs({
  options: {
    cycles: { type: 'string', default: '50' },
    'sample-rate-hz': { type: 'string', default: '44100' },
    'browser-version': { type: 'string' },
    output: { type: 'string' },
  },
}).values;
const cycles = Number(options.cycles);
const sampleRate = Number(options['sample-rate-hz']);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 500) throw new RangeError('--cycles must be 1..500');
if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('--sample-rate-hz must be 8000..192000');

const capturePath = resolve(ROOT, 'public/worklets/browser-input-capture.js');
const captureOriginal = await readFile(capturePath, 'utf8');
const captureConfigLine = '    const config = options.processorOptions || {};';
if (captureOriginal.split(captureConfigLine).length !== 2) throw new Error('Expected exactly one capture worklet processor-options read to instrument.');
const captureWithProbe = captureOriginal.replace(captureConfigLine,
  `${captureConfigLine}\n    this.__sentinel = config.__sentinel;\n    this.__sentinelSlot = config.__sentinelSlot;`);
const frameEndLine = '    const frameEnd = frameStart + frames;';
if (captureWithProbe.split(frameEndLine).length !== 2) throw new Error('Expected exactly one capture worklet frame-end calculation to instrument.');
const captureInstrumented = captureWithProbe.replace(frameEndLine,
  `    {\n      const sequence = Atomics.add(this.__sentinel, this.__sentinelSlot, 1);\n      const base = 2 + (this.__sentinelSlot * 20000 + sequence) * 3;\n      if (sequence < 20000) {\n        const raw = rawLeft;\n        const nonSilent = !!raw && (raw[0] !== 0 || raw[31] !== 0 || raw[63] !== 0 || raw[95] !== 0);\n        Atomics.store(this.__sentinel, base, frameStart);\n        Atomics.store(this.__sentinel, base + 1, frames);\n        Atomics.store(this.__sentinel, base + 2, Number(nonSilent));\n      }\n    }\n` + frameEndLine);
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const instrumentedCaptureSha256 = createHash('sha256').update(captureInstrumented).digest('hex');
const globalSentinel = `class ContextFrameSentinel extends AudioWorkletProcessor {
  constructor(options) { super(); this.sentinel = options.processorOptions.sentinel; this.slot = options.processorOptions.slot; }
  process(inputs, outputs) {
    const frames = outputs[0][0].length;
    const sequence = Atomics.add(this.sentinel, this.slot, 1);
    const base = 2 + (this.slot * 20000 + sequence) * 3;
    if (sequence < 20000) { Atomics.store(this.sentinel, base, currentFrame); Atomics.store(this.sentinel, base + 1, frames); Atomics.store(this.sentinel, base + 2, 0); }
    return true;
  }
}
registerProcessor('rc505-context-frame-sentinel', ContextFrameSentinel);`;

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-embedder-policy', 'require-corp');
  if (pathname === '/global-sentinel.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    response.end(globalSentinel);
  } else if (pathname === '/capture-instrumented.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    response.end(captureInstrumented);
  } else {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><meta charset="utf-8"><title>RC-505 frame sentinel</title><body>AudioContext sentinel probe</body>');
  }
});

await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.goto(baseUrl);
  const browserVersion = browser.version();
  const run = await page.evaluate(async ({ baseUrl, cycles, sampleRate }) => {
    const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') throw new Error('The isolated probe page must have SharedArrayBuffer support.');
    const capacity = 20_000;
    const sentinelBuffer = new SharedArrayBuffer((2 + 2 * capacity * 3) * Int32Array.BYTES_PER_ELEMENT);
    const sentinel = new Int32Array(sentinelBuffer);
    const count = (slot) => Atomics.load(sentinel, slot);
    const readFrames = (slot) => {
      const total = Math.min(count(slot), capacity);
      const frames = new Array(total);
      const base = 2 + slot * capacity * 3;
      for (let index = 0; index < total; index += 1) {
        const offset = base + index * 3;
        frames[index] = { frameStart: Atomics.load(sentinel, offset), frames: Atomics.load(sentinel, offset + 1), inputNonSilent: Atomics.load(sentinel, offset + 2) === 1 };
      }
      return frames;
    };
    const origin = new URL(baseUrl);
    await context.audioWorklet.addModule(new URL('/global-sentinel.js', origin));
    await context.audioWorklet.addModule(new URL('/capture-instrumented.js', origin));
    const globalNode = new AudioWorkletNode(context, 'rc505-context-frame-sentinel', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { sentinel, slot: 0 } });
    const captureNode = new AudioWorkletNode(context, 'rc505-input-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { __sentinel: sentinel, __sentinelSlot: 1 } });
    const oscillator = new OscillatorNode(context, { frequency: 997 });
    const mute = new GainNode(context, { gain: 0 });
    const log = { lifecycle: [], sampleRate: context.sampleRate };
    globalNode.connect(mute);
    oscillator.connect(captureNode);
    captureNode.connect(mute);
    mute.connect(context.destination);
    oscillator.start();
    await context.resume();
    const waitFor = async (predicate, timeoutMs = 3000) => {
      const until = performance.now() + timeoutMs;
      while (!predicate()) {
        if (performance.now() > until) throw new Error('Timed out waiting for both independent frame sentinels.');
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    };
    await waitFor(() => count(0) >= 24 && count(1) >= 24);
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const before = { global: count(0), capture: count(1), currentTime: context.currentTime, state: context.state };
      await context.suspend();
      const suspendedAt = { currentTime: context.currentTime, state: context.state };
      await new Promise(resolve => setTimeout(resolve, 4));
      await context.resume();
      await waitFor(() => count(0) >= before.global + 3 && count(1) >= before.capture + 3);
      log.lifecycle.push({
        cycle, before, suspendedAt, resumedAt: { currentTime: context.currentTime, state: context.state },
        firstPostResumeGlobalFrameStart: Atomics.load(sentinel, 2 + before.global * 3),
        firstPostResumeCaptureFrameStart: Atomics.load(sentinel, 2 + capacity * 3 + before.capture * 3),
        latestGlobalFrameStart: Atomics.load(sentinel, 2 + (count(0) - 1) * 3),
        latestCaptureFrameStart: Atomics.load(sentinel, 2 + capacity * 3 + (count(1) - 1) * 3),
      });
    }
    await context.suspend();
    const final = { state: context.state, currentTime: context.currentTime, globalCallbacks: count(0), captureCallbacks: count(1) };
    oscillator.stop();
    globalNode.disconnect(); captureNode.disconnect(); mute.disconnect();
    await context.close();
    return { global: readFrames(0), capture: readFrames(1), lifecycle: log.lifecycle, sampleRate: log.sampleRate, final };
  }, { baseUrl, cycles, sampleRate });

  const analyze = (entries) => {
    const gaps = [];
    for (let i = 1; i < entries.length; i += 1) {
      const previous = entries[i - 1];
      const current = entries[i];
      const deltaFrames = current.frameStart - (previous.frameStart + previous.frames);
      if (deltaFrames !== 0) gaps.push({ previousIndex: i - 1, currentIndex: i, previousFrameStart: previous.frameStart, previousFrames: previous.frames, currentFrameStart: current.frameStart, deltaFrames });
    }
    return gaps;
  };
  const globalGaps = analyze(run.global);
  const captureGaps = analyze(run.capture);
  const signature = (gap) => `${gap.previousFrameStart}/${gap.previousFrames}/${gap.currentFrameStart}/${gap.deltaFrames}`;
  const sharedDiscontinuities = globalGaps.filter((gap) => captureGaps.some((captureGap) => signature(captureGap) === signature(gap)));
  const classification = globalGaps.length === 0 && captureGaps.length === 0
    ? 'NO_GAP_REPRODUCED'
    : globalGaps.length === 0 && captureGaps.length > 0
      ? 'CAPTURE_NODE_ONLY'
      : captureGaps.length === 0
        ? 'CONTEXT_GLOBAL_ONLY'
        : sharedDiscontinuities.length === globalGaps.length && sharedDiscontinuities.length === captureGaps.length
          ? 'SHARED_CONTEXT_TIMELINE_DISCONTINUITY'
          : 'BOTH_OR_MIXED';
  const result = {
    schemaVersion: 1,
    benchmark: 'rc505_browser_suspend_resume_frame_sentinel',
    completedAtUtc: new Date().toISOString(),
    sourceHead,
    browser: { name: 'Chromium (Playwright)', version: browserVersion },
    sampleRateHz: run.sampleRate,
    requestedSuspendResumeCycles: cycles,
    outputDevice: 'Chromium synthetic zero-gain destination path; no physical output assertion',
    inputDevice: 'Generated 997 Hz OscillatorNode feeding the production browser-input-capture worklet; no microphone permission',
    sentinels: {
      contextGlobal: { implementation: 'independent AudioWorkletProcessor reading AudioWorkletGlobalScope.currentFrame and writing to a preallocated SharedArrayBuffer ring', callbacks: run.global.length, discontinuities: globalGaps },
      productionCaptureTap: { implementation: 'production public/worklets/browser-input-capture.js with test-only writes to a preallocated SharedArrayBuffer ring before lastFrameEnd assignment; input sentinel samples are checked without allocation', sourcePath: 'public/worklets/browser-input-capture.js', testInstrumentedSourceSha256: instrumentedCaptureSha256, callbacks: run.capture.length, nonSilentInputCallbacks: run.capture.filter(item => item.inputNonSilent).length, discontinuities: captureGaps },
    },
    classification,
    coincidentContextAndCaptureDiscontinuities: sharedDiscontinuities,
    lifecycle: run.lifecycle,
    final: run.final,
    limits: [
      'This is a software-only Chromium AudioContext/AudioWorklet observation; it does not measure hardware XRUNs, device clock drift, or audible output.',
      'The context-wide reference is a second AudioWorklet node in the same rendering quantum, not an independent physical device clock.',
      'A no-gap result applies only to the recorded run and cannot explain the historical summary-only 128-frame report.',
    ],
  };
  const outputPath = options.output ? resolve(options.output) : resolve(ROOT, 'bench/results', `browser_suspend_resume_frame_sentinel_${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outputPath, browserVersion, classification: result.classification, globalCallbacks: run.global.length, captureCallbacks: run.capture.length, globalGaps: globalGaps.length, captureGaps: captureGaps.length, nonSilentCaptureCallbacks: result.sentinels.productionCaptureTap.nonSilentInputCallbacks })}\n`);
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
