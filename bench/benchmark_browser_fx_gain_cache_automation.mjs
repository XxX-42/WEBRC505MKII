#!/usr/bin/env node
/**
 * Browser OfflineAudioContext differential for stationary and automated
 * equal-power mix/bypass coefficients. This is not live callback timing.
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  strict: true,
  options: {
    'baseline-ref': { type: 'string', default: 'HEAD' },
    algorithm: { type: 'string', default: 'reverb' },
    'sample-rate-hz': { type: 'string', default: '44100' },
    'duration-seconds': { type: 'string', default: '3' },
    rounds: { type: 'string', default: '2' },
    browser: { type: 'string', default: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? '/tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell' },
    output: { type: 'string', required: true },
  },
});
const sampleRateHz = Number(values['sample-rate-hz']);
const durationSeconds = Number(values['duration-seconds']);
const rounds = Number(values.rounds);
if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 192_000
  || !Number.isFinite(durationSeconds) || durationSeconds < 1.5 || durationSeconds > 10
  || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5) {
  throw new RangeError('Use a sample rate 8–192 kHz, duration 1.5–10 seconds, and 1–5 rounds');
}
const browserPath = resolve(values.browser);
const baselineSource = execFileSync('git', ['show', `${values['baseline-ref']}:public/worklets/fx-processor.js`], {
  cwd: root,
  maxBuffer: 8 * 1024 * 1024,
}).toString('utf8');
const candidateSource = await readFile(resolve(root, 'public/worklets/fx-processor.js'), 'utf8');
const sources = { baseline: baselineSource, candidate: candidateSource };
const server = createServer((request, response) => {
  const version = request.url === '/baseline.js' ? 'baseline' : request.url === '/candidate.js' ? 'candidate' : null;
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>RC-505 FX gain-cache diagnostic</title>');
    return;
  }
  if (!version) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
  response.end(sources[version]);
});

let browser;
try {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local server failed to bind');
  browser = await chromium.launch({ executablePath: browserPath, headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const measured = await page.evaluate(async ({ port, sampleRateHz, durationSeconds, rounds, algorithm }) => {
    const frames = Math.floor(sampleRateHz * durationSeconds);
    async function render(version) {
      const context = new OfflineAudioContext(2, frames, sampleRateHz);
      await context.audioWorklet.addModule(`http://127.0.0.1:${port}/${version}.js`);
      const node = new AudioWorkletNode(context, 'rc505-fx-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { algorithm, sampleRate: sampleRateHz, parameters: { mix: 0.2 }, bypassed: false },
      });
      const input = context.createBuffer(2, frames, sampleRateHz);
      const left = input.getChannelData(0);
      const right = input.getChannelData(1);
      for (let frame = 0; frame < frames; frame += 1) {
        const time = frame / sampleRateHz;
        left[frame] = 0.23 * Math.sin(2 * Math.PI * 440 * time) + 0.08 * Math.sin(2 * Math.PI * 1_307 * time);
        right[frame] = 0.19 * Math.sin(2 * Math.PI * 659 * time + 0.2) - 0.05 * Math.sin(2 * Math.PI * 1_711 * time);
      }
      const source = context.createBufferSource();
      source.buffer = input;
      source.connect(node);
      node.connect(context.destination);
      source.start();
      const ackWaiters = [];
      node.port.onmessage = (event) => {
        if (event.data?.type === 'configure-ack') ackWaiters.shift()?.();
      };
      const rendering = context.startRendering();
      const startedAt = performance.now();
      for (const event of [
        { time: 0.25, mix: 0.91 },
        { time: 0.55, mix: 0.12 },
        { time: 0.85, mix: 0.74, bypass: true, rampFrames: 701 },
        { time: 1.15, mix: 0.38, bypass: false, rampFrames: 911 },
      ]) {
        if (event.time >= durationSeconds) continue;
        await context.suspend(event.time);
        const acknowledged = new Promise((resolveAck, rejectAck) => {
          const timeout = setTimeout(() => rejectAck(new Error(`Timed out waiting for ${version} configure ACK at ${event.time}s`)), 2_000);
          ackWaiters.push(() => { clearTimeout(timeout); resolveAck(); });
        });
        node.port.postMessage({ type: 'configure', parameters: { mix: event.mix } });
        if (event.bypass !== undefined) node.port.postMessage({ type: 'set-bypass', value: event.bypass, rampFrames: event.rampFrames });
        await context.resume();
        await acknowledged;
      }
      const output = await rendering;
      const elapsedMilliseconds = performance.now() - startedAt;
      const outLeft = output.getChannelData(0);
      const outRight = output.getChannelData(1);
      const bytes = new Uint8Array(outLeft.byteLength + outRight.byteLength);
      bytes.set(new Uint8Array(outLeft.buffer, outLeft.byteOffset, outLeft.byteLength));
      bytes.set(new Uint8Array(outRight.buffer, outRight.byteOffset, outRight.byteLength), outLeft.byteLength);
      let energy = 0;
      let finite = true;
      for (let frame = 0; frame < outLeft.length; frame += 1) {
        const l = outLeft[frame];
        const r = outRight[frame];
        finite &&= Number.isFinite(l) && Number.isFinite(r);
        energy += l * l + r * r;
      }
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const outputSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      source.disconnect();
      node.disconnect();
      return { version, frames, elapsedMilliseconds, realtimeRatio: elapsedMilliseconds / (durationSeconds * 1_000), finite, rms: Math.sqrt(energy / (frames * 2)), outputSha256 };
    }
    const warmupSeconds = 0.5;
    const runs = [];
    for (let round = 0; round < rounds; round += 1) {
      for (const [version, label] of [['baseline', 'A1'], ['candidate', 'B1'], ['candidate', 'B2'], ['baseline', 'A2']]) {
        // Warm up both code paths before each measured render, without mixing
        // warmup timing into the report.
        const warmupFrames = Math.floor(sampleRateHz * warmupSeconds);
        if (warmupFrames > 0) {
          const warmupContext = new OfflineAudioContext(2, warmupFrames, sampleRateHz);
          await warmupContext.audioWorklet.addModule(`http://127.0.0.1:${port}/${version}.js`);
          const warmupNode = new AudioWorkletNode(warmupContext, 'rc505-fx-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { algorithm, sampleRate: sampleRateHz, parameters: { mix: 0.2 }, bypassed: false } });
          warmupNode.connect(warmupContext.destination);
          await warmupContext.startRendering();
          warmupNode.disconnect();
        }
        runs.push({ round: round + 1, label: `${label}-R${round + 1}`, ...(await render(version)) });
      }
    }
    return { frames, runs };
  }, { port: address.port, sampleRateHz, durationSeconds, rounds, algorithm: values.algorithm });

  const summary = {};
  for (const version of ['baseline', 'candidate']) {
    const group = measured.runs.filter((run) => run.version === version);
    const times = group.map((run) => run.realtimeRatio).sort((a, b) => a - b);
    summary[version] = {
      runs: group.length,
      medianRealtimeRatio: times[Math.floor(times.length / 2)],
      meanRealtimeRatio: times.reduce((sum, value) => sum + value, 0) / times.length,
      finite: group.every((run) => run.finite),
      outputHashes: [...new Set(group.map((run) => run.outputSha256))],
    };
  }
  const result = {
    schemaVersion: 1,
    benchmark: 'rc505_browser_offline_context_fx_gain_cache_automation',
    generatedAtUtc: new Date().toISOString(),
    repositoryHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString('utf8').trim(),
    browserVersion: await browser.version(),
    browserPath,
    baselineRef: values['baseline-ref'],
    algorithm: values.algorithm,
    sampleRateHz,
    durationSeconds,
    rounds,
    controlSequence: [
      'mix target 0.91 at 0.25s', 'mix target 0.12 at 0.55s',
      'mix target 0.74 and bypass-on 701-frame ramp at 0.85s',
      'mix target 0.38 and bypass-off 911-frame ramp at 1.15s',
    ],
    timingSource: 'performance.now around OfflineAudioContext.startRendering in Chrome; diagnostic only, not realtime callback timing.',
    excludedClaims: ['No live callback deadline, XRUN, multi-node full-graph acceptance, or physical hardware test.'],
    baselineSha256: createHash('sha256').update(baselineSource).digest('hex'),
    candidateSha256: createHash('sha256').update(candidateSource).digest('hex'),
    summary,
    bitIdenticalAcrossAllMeasuredRenders: new Set(measured.runs.map((run) => run.outputSha256)).size === 1,
    runs: measured.runs,
  };
  const outputPath = resolve(root, values.output);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outputPath, summary, bitIdenticalAcrossAllMeasuredRenders: result.bitIdenticalAcrossAllMeasuredRenders }, null, 2)}\n`);
} finally {
  await browser?.close();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
