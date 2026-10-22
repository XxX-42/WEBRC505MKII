#!/usr/bin/env node
/**
 * Chrome tracing diagnostic for the full production AudioWorklet workload.
 * It deliberately reuses the existing 35-node full-runtime page and captures
 * Chrome trace events around the real worklet graph. Tracing is intrusive and
 * this output is profiling evidence, never a realtime acceptance result.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = resolve(process.env.RC505_CFT_PATH ?? '/tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell');
const durationSeconds = Number(process.env.RC505_PROFILE_DURATION_SECONDS ?? 8);
const sampleRateHz = Number(process.env.RC505_PROFILE_SAMPLE_RATE_HZ ?? 44_100);
const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
const outputPath = resolve(process.argv[2] ?? `bench/results/browser_worklet_trace_35node_${stamp}.json`);
const categories = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-audio-worklet',
  'disabled-by-default-webaudio',
  'webaudio',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.hires',
].join(',');

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  throw new Error('Refusing to launch Chrome as root; sandboxing remains enabled');
}
if (!Number.isFinite(durationSeconds) || durationSeconds < 2 || durationSeconds > 30) {
  throw new RangeError('RC505_PROFILE_DURATION_SECONDS must be from 2 through 30');
}
if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 192_000) {
  throw new RangeError('RC505_PROFILE_SAMPLE_RATE_HZ must be an integer from 8000 through 192000');
}
await access(browserPath);
const versionResult = spawnSync(browserPath, ['--version'], { encoding: 'utf8', timeout: 15_000 });
if (versionResult.status !== 0) throw new Error(`Could not query browser version: ${(versionResult.stderr || versionResult.stdout).trim()}`);

const server = await createServer({
  configFile: false,
  root,
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
let browser;
let traceEvents = [];
let resultSummary = null;
let harnessError = null;
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP listening port');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: browserPath, headless: true, chromiumSandbox: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (message) => { if (message.type() === 'error') process.stderr.write(`[browser] ${message.text()}\n`); });
  page.on('pageerror', (error) => process.stderr.write(`[pageerror] ${error.message}\n`));
  const url = new URL('/bench/browser_audio_worklet_stress.html', origin);
  url.searchParams.set('seconds', String(durationSeconds));
  url.searchParams.set('sampleRate', String(sampleRateHz));
  url.searchParams.set('profile', 'full-runtime');
  url.searchParams.set('operationIntervalSeconds', '30');
  const response = await page.goto(url.toString(), { waitUntil: 'networkidle' });
  if (!response?.ok()) throw new Error(`Stress page HTTP status ${response?.status() ?? 'missing'}`);
  await page.locator('#start').click();
  await page.waitForFunction(() => window.__rc505Bench?.ready || window.__rc505Bench?.error, null, { timeout: 90_000 });
  const setup = await page.evaluate(() => ({
    ready: window.__rc505Bench?.ready,
    error: window.__rc505Bench?.error,
    readySlots: window.__rc505Bench?.readySlots,
    nodeCount: window.__rc505Bench?.nodeCount,
  }));
  if (!setup.ready) throw new Error(`35-node Browser graph setup failed: ${JSON.stringify(setup)}`);

  const cdp = await context.newCDPSession(page);
  cdp.on('Tracing.dataCollected', (event) => { traceEvents.push(...event.value); });
  const tracingComplete = new Promise((resolveComplete, rejectComplete) => {
    const timeout = setTimeout(() => rejectComplete(new Error('Chrome tracingComplete timeout')), durationSeconds * 1000 + 120_000);
    cdp.once('Tracing.tracingComplete', (event) => { clearTimeout(timeout); resolveComplete(event); });
  });
  await cdp.send('Tracing.start', {
    categories,
    options: 'record-as-much-as-possible',
    transferMode: 'ReportEvents',
  });
  const startedAtUtc = new Date().toISOString();
  await page.waitForFunction(() => window.__rc505BenchResult || window.__rc505BenchError, null, { timeout: durationSeconds * 1000 + 120_000 });
  const pageState = await page.evaluate(() => ({
    error: window.__rc505BenchError ?? null,
    result: window.__rc505BenchResult ?? null,
    diagnostic: window.__rc505BenchDiagnostic ?? null,
    progress: window.__rc505Bench?.progress ?? null,
  }));
  resultSummary = pageState.result;
  harnessError = pageState.error;
  await cdp.send('Tracing.end');
  const traceCompletion = await tracingComplete;
  const traceStats = {
    eventCount: traceEvents.length,
    profileEventCount: traceEvents.filter((event) => event.name === 'Profile' || event.name === 'ProfileChunk').length,
    eventNameCounts: Object.fromEntries([...traceEvents.reduce((map, event) => map.set(event.name, (map.get(event.name) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).slice(0, 40)),
    threadNames: [...new Set(traceEvents.map((event) => event.tid).filter((tid) => tid !== undefined))].length,
    traceComplete: traceCompletion?.stream !== undefined || traceCompletion?.dataLossOccurred !== undefined,
    dataLossOccurred: traceCompletion?.dataLossOccurred ?? null,
  };
  const output = {
    schemaVersion: 1,
    benchmark: 'rc505_chrome_trace_full_runtime_35_worklet_graph',
    generatedAtUtc: new Date().toISOString(),
    startedAtUtc,
    repoHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    browserBinaryVersion: (versionResult.stdout || versionResult.stderr).trim(),
    browserPath,
    playwrightBrowserVersion: await browser.version(),
    chromiumSandboxRequested: true,
    launchArguments: [],
    graph: { profile: 'full-runtime', expectedWorklets: 35, readyWorklets: setup.readySlots, sampleRateHz, durationSeconds },
    traceCategories: categories,
    tracingIsIntrusive: true,
    pageHarnessError: harnessError,
    pageProgress: pageState.progress,
    pageResultProgression: resultSummary?.contextProgression ?? pageState.diagnostic?.contextProgression ?? null,
    pageResultCallbackCounts: resultSummary?.metrics?.callbackCounts ?? pageState.diagnostic?.metrics?.callbackCounts ?? null,
    traceStats,
    traceEvents,
    interpretation: [
      'Profiling run executes the existing real Chromium AudioWorklet full-runtime graph (35 processors) at the requested sample rate.',
      'Chrome tracing and the existing benchmark instrumentation are intrusive; do not compare directly with untraced product runs or treat as realtime acceptance.',
      'No physical audio endpoint/XRUN counter is available; software AudioContext progression and callback proxies remain distinct.',
      'Inspect trace thread names and event/category details before attributing cost to a specific DSP stage.',
    ],
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`Saved Chrome worklet trace: ${outputPath}\n`);
  process.stdout.write(`Events: ${traceStats.eventCount}; Profile events: ${traceStats.profileEventCount}; Browser: ${output.browserBinaryVersion}; harness error: ${harnessError ?? 'none'}\n`);
} finally {
  await browser?.close().catch(() => undefined);
  await server.close();
}
