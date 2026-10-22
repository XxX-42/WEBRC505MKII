#!/usr/bin/env node
/**
 * Relative Browser DSP diagnostic using the exact shipped FX AudioWorklet in
 * Chromium's OfflineAudioContext. This is not live callback timing, an XRUN
 * test, a multi-FX graph, or hardware acceptance.
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
const defaultBrowser = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? '/tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell';
const { values } = parseArgs({
  strict: true,
  options: {
    'baseline-ref': { type: 'string', default: 'ec2d037' },
    algorithm: { type: 'string', default: 'distortion' },
    'sample-rate-hz': { type: 'string', default: '44100' },
    'duration-seconds': { type: 'string', default: '4' },
    rounds: { type: 'string', default: '3' },
    browser: { type: 'string', default: defaultBrowser },
    output: { type: 'string' },
  },
});
const sampleRateHz = Number(values['sample-rate-hz']);
const durationSeconds = Number(values['duration-seconds']);
const rounds = Number(values.rounds);
if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 192_000
  || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 60
  || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10) {
  throw new RangeError('Use an 8–192 kHz rate, duration > 0 and <= 60 seconds, and 1–10 rounds');
}
const browserPath = resolve(values.browser);
const baselineSource = execFileSync('git', ['show', `${values['baseline-ref']}:public/worklets/fx-processor.js`], {
  cwd: root,
  maxBuffer: 8 * 1024 * 1024,
}).toString('utf8');
const candidateSource = await readFile(resolve(root, 'public/worklets/fx-processor.js'), 'utf8');
const sourceSha256 = (source) => createHash('sha256').update(source).digest('hex');
const sources = { baseline: baselineSource, candidate: candidateSource };
const server = createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>RC-505 Offline FX diagnostic</title>');
    return;
  }
  const version = request.url === '/baseline.js' ? 'baseline'
    : request.url === '/candidate.js' ? 'candidate' : null;
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
  if (!address || typeof address === 'string') throw new Error('Local diagnostic server failed to bind');
  browser = await chromium.launch({ executablePath: browserPath, headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const measured = await page.evaluate(async ({ port, sampleRateHz, durationSeconds, rounds, algorithm }) => {
    const frames = Math.floor(sampleRateHz * durationSeconds);
    const parameters = algorithm === 'distortion'
      ? { driveDb: 8, outputDb: 0, mix: 0.35, distortionMode: 'overdrive' }
      : {};
    async function render(version, seconds) {
      const frameCount = Math.max(1, Math.floor(sampleRateHz * seconds));
      const context = new OfflineAudioContext(2, frameCount, sampleRateHz);
      await context.audioWorklet.addModule(`http://127.0.0.1:${port}/${version}.js`);
      const node = new AudioWorkletNode(context, 'rc505-fx-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { algorithm, sampleRate: sampleRateHz, parameters, bypassed: false },
      });
      const input = context.createBuffer(2, frameCount, sampleRateHz);
      const left = input.getChannelData(0);
      const right = input.getChannelData(1);
      let random = 0x12345678;
      for (let frame = 0; frame < frameCount; frame += 1) {
        const time = frame / sampleRateHz;
        random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
        const leftNoise = ((random / 0x1_0000_0000) - 0.5) * 0.04;
        random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
        const rightNoise = ((random / 0x1_0000_0000) - 0.5) * 0.04;
        left[frame] = 0.21 * Math.sin(2 * Math.PI * 440 * time)
          + 0.04 * Math.sin(2 * Math.PI * 1_307 * time) + leftNoise;
        right[frame] = 0.18 * Math.sin(2 * Math.PI * 659 * time + 0.2)
          + 0.03 * Math.sin(2 * Math.PI * 1_711 * time) + rightNoise;
        if (frame % 8_192 === 0) {
          left[frame] += 0.8;
          right[frame] -= 0.6;
        }
      }
      const source = context.createBufferSource();
      source.buffer = input;
      source.connect(node);
      node.connect(context.destination);
      source.start();
      const startedAt = performance.now();
      const output = await context.startRendering();
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
      return {
        version,
        frames: frameCount,
        elapsedMilliseconds,
        realtimeRatio: elapsedMilliseconds / (seconds * 1_000),
        finite,
        rms: Math.sqrt(energy / (outLeft.length * 2)),
        outputSha256,
      };
    }

    const warmupSeconds = Math.min(0.75, durationSeconds);
    const warmups = [await render('baseline', warmupSeconds), await render('candidate', warmupSeconds)];
    const runs = [];
    for (let round = 0; round < rounds; round += 1) {
      for (const [version, label] of [['baseline', 'A1'], ['candidate', 'B1'], ['candidate', 'B2'], ['baseline', 'A2']]) {
        runs.push({ round: round + 1, label: `${label}-R${round + 1}`, ...(await render(version, durationSeconds)) });
      }
    }
    return { frames, warmupSeconds, warmups, runs };
  }, { port: address.port, sampleRateHz, durationSeconds, rounds, algorithm: values.algorithm });
  const grouped = Object.fromEntries(['baseline', 'candidate'].map((version) => {
    const results = measured.runs.filter((run) => run.version === version);
    const ratios = results.map((run) => run.realtimeRatio).sort((a, b) => a - b);
    return [version, {
      runCount: results.length,
      medianRealtimeRatio: ratios[Math.floor(ratios.length / 2)],
      meanRealtimeRatio: ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length,
      outputsFinite: results.every((run) => run.finite),
      distinctOutputHashes: [...new Set(results.map((run) => run.outputSha256))],
      rmsValues: [...new Set(results.map((run) => run.rms))],
    }];
  }));
  const sameOutput = measured.runs.every((run) => run.outputSha256 === measured.runs[0]?.outputSha256);
  const output = {
    schemaVersion: 1,
    benchmark: 'rc505_browser_offline_context_single_fx_relative_kernel_diagnostic',
    generatedAtUtc: new Date().toISOString(),
    repositoryHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString('utf8').trim(),
    browserVersion: await browser.version(),
    browserExecutable: browserPath,
    algorithm: values.algorithm,
    sampleRateHz,
    measuredAudioSecondsPerRun: durationSeconds,
    rounds,
    timingSource: 'Main-thread performance.now() surrounding OfflineAudioContext.startRendering() in Chrome for Testing; offline render time is not live-callback timing.',
    exclusions: [
      'No live AudioContext callback scheduling, deadline, XRUN, whole graph, CPU contention, or physical output.',
      'One effect processor at a time; does not establish the 5-track/20-private-slot aggregate performance.',
      'Deterministic stereo noise/multitone/impulse excitation is for runtime equivalence, not sound-quality acceptance.',
    ],
    baselineSource: { ref: `${values['baseline-ref']}:public/worklets/fx-processor.js`, sha256: sourceSha256(baselineSource) },
    candidateSource: { path: 'public/worklets/fx-processor.js', sha256: sourceSha256(candidateSource) },
    warmups: measured.warmups,
    runs: measured.runs,
    summary: { ...grouped, bitIdenticalOutputAcrossVersions: sameOutput },
  };
  const outputPath = values.output
    ? resolve(root, values.output)
    : resolve(root, 'bench/results', `browser_fx_offline_${Date.now()}.json`);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outputPath, summary: output.summary, runs: output.runs }, null, 2)}\n`);
} finally {
  await browser?.close();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
