#!/usr/bin/env node
// Offline diagnostics for the project's actual FX classes. This runner never
// opens live input/output devices and its report cannot satisfy physical gates.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = join(ROOT, 'scripts', 'audio-benchmark-fx-harness.html');
const LOCAL_CHROMIUM = process.env.LOCALAPPDATA
  ? resolve(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe')
  : null;
const DEFAULT_BROWSER = process.env.WEBRC_CHROMIUM_PATH
  || (LOCAL_CHROMIUM && existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : chromium.executablePath());
const browserPath = getArg('--browser', DEFAULT_BROWSER);
const outputPath = resolve(getArg('--out', join(tmpdir(), 'webrc-audio-benchmark', 'offline-fx-latest.json')));
const tracePath = outputPath.replace(/\.json$/i, '.trace.json');
const browserPathString = browserPath;
const effectNames = {
  dry: 'Dry path',
  compressorAmount50: 'Compressor (amount 50%)',
  filterUiValue50: 'Filter (UI value 50)',
  filterLowCutoffProbe: 'Filter (low-cutoff probe)',
  delayMixedDefault300ms: 'Delay (mixed, 300 ms)',
  delayFullyWet300ms: 'Delay (fully wet, 300 ms)',
  reverbFullyWetDefault2s: 'Reverb (fully wet, 2 s)',
};

const sessionStartedAt = new Date().toISOString();
const plugin = {
  name: 'webrc-offline-fx-benchmark',
  configureServer(server) {
    server.middlewares.use('/__offline_fx_bench__', async (_request, response) => {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(await readFile(HARNESS));
    });
  },
};

let server;
let browser;
try {
  server = await createServer({
    configFile: false,
    appType: 'custom',
    root: ROOT,
    cacheDir: join(tmpdir(), 'webrc-audio-benchmark', 'vite-cache-software'),
    logLevel: 'error',
    plugins: [plugin],
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not return a TCP listener');
  browser = await chromium.launch({ executablePath: browserPathString, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') process.stderr.write(`[browser] ${message.text()}\n`);
  });
  page.on('pageerror', (error) => process.stderr.write(`[browser-page] ${error.message}\n`));
  await page.goto(`http://127.0.0.1:${address.port}/__offline_fx_bench__`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.fxBenchReady === true, { timeout: 20000 });
  const result = await page.evaluate(() => window.runFxBench());
  const endedAt = new Date().toISOString();
  const measuredAt = endedAt;
  const runId = `offline-fx-${Date.now()}`;
  const metrics = result.summaries.map((summary) => {
    const name = effectNames[summary.caseName] ?? summary.caseName;
    const evidenceRef = basename(tracePath);
    return {
      effectId: `${summary.caseName}-${summary.sampleRate}hz`,
      effectName: `${name} @ ${summary.sampleRate} Hz`,
      firstArrival: measuredScalar(summary.medianOnsetOffsetMs, summary.repeats, summary.sampleRate, evidenceRef, measuredAt),
      peak: measuredScalar(summary.medianPeakOffsetMs, summary.repeats, summary.sampleRate, evidenceRef, measuredAt),
      tail: measuredScalar(median(summary.tailEndAfterPulseMsAll), summary.repeats, summary.sampleRate, evidenceRef, measuredAt),
    };
  });

  const report = {
    schema: 'webrc.instrument-grade-audio',
    schemaVersion: 1,
    reportId: runId,
    run: {
      startedAt: sessionStartedAt,
      endedAt,
      durationSeconds: (Date.parse(endedAt) - Date.parse(sessionStartedAt)) / 1000,
      gateVersion: 'instrument-grade-gate/1.0.0',
      systemUnderTest: 'software-fx-offline-and-compressor-realtime',
      assertionVersions: {
        benchmark: 'audio-benchmark-software/2.0.0',
        fxLatency: 'offline-impulse/relative-1e-4-peak/1.1.0',
      },
    },
    hardware: {
      inputDevice: { id: 'offline:none', label: 'No hardware input (synthetic/offline software only)' },
      outputDevice: { id: 'software:none', label: 'No hardware output (silent software sink)' },
      hardwareSampleRateHz: null,
      processingSampleRateHz: null,
      renderQuantumFrames: null,
    },
    pathEvidence: {
      physicalLoopbackConfirmed: false,
      loopbackDescription: 'Software-only OfflineAudioContext renders of project FX at 44.1, 48, and 96 kHz, plus a synthetic-input live AudioContext compressor check at 48 kHz redirected to a silent software sink; no hardware capture, DAC, or analog path was opened.',
      loopbackEvidenceRef: null,
      independentInputAnchorRef: null,
      independentOutputAnchorRef: null,
      adcToBrowserEvidenceRef: null,
      browserToDspEvidenceRef: null,
      dspToDacEvidenceRef: null,
      dacToAdcEvidenceRef: null,
    },
    metrics: {
      hardwareRtl: unknownDistribution(),
      input: unknownDistribution(),
      output: unknownDistribution(),
      jitter: unknownScalar('ms'),
      trigger: unknownDistribution(),
      triggerByAction: { REC: unknownDistribution(), PLAY: unknownDistribution(), STOP: unknownDistribution(), FX: unknownDistribution() },
      overdubAlignment: unknownDistribution(),
      renderQuantum: unknownScalar('frames'),
      fxLatency: metrics,
      callback: unknownDistribution(),
      xrun: unknownXrun(),
      loopDrift: unknownDrift(),
    },
    software: { runtimeSnapshot: null, callback96kProfile: null },
  };

  const trace = {
    schema: 'webrc.instrument-grade-trace',
    schemaVersion: 1,
    reportId: runId,
    method: {
      harness: 'OfflineAudioContext; actual FX classes imported from src/audio/fx',
      pulseTimeSeconds: 2,
      renderDurationSeconds: 4.5,
      threshold: 'first sample with abs(amplitude) >= 1e-4 * whole-render peak',
      repeatsPerCase: 5,
      cpuTimeDefinition: 'wall-clock time spent awaiting OfflineAudioContext.startRendering(); not realtime/device latency',
      browserExecutable: browserPathString,
      browserVersion: browser.version(),
      liveDeviceAccess: false,
      processingSampleRatesHz: [44100, 48000, 96000],
      inputChannelsOpened: false,
      outputMonitorEnabled: false,
      liveCompressorCapture: 'AudioContext at 48 kHz, sample capture in a second AudioWorklet tap, synthetic AudioBufferSourceNode, output set to sinkId none or a private MediaStreamDestination; no getUserMedia/enumerateDevices calls',
    },
    summaries: result.summaries,
    compressorDiagnostics: result.compressorDiagnostics,
    compressorRealtimeDiagnostics: result.compressorRealtimeDiagnostics,
    runs: result.runs,
    sourceSha256: {
      compressorFxTs: createHash('sha256').update(await readFile(join(ROOT, 'src', 'audio', 'fx', 'CompressorFX.ts'))).digest('hex'),
      compressorProcessorJs: createHash('sha256').update(await readFile(join(ROOT, 'public', 'worklets', 'compressor-processor.js'))).digest('hex'),
    },
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ reportPath: outputPath, tracePath, effectCount: metrics.length, runs: result.runs.length, compressorAt48k: metrics.find((fx) => fx.effectId === 'compressorAmount50-48000hz'), compressorRealtimeDiagnostics: result.compressorRealtimeDiagnostics }, null, 2)}\n`);
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function basename(path) {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function measuredScalar(value, sampleCount, sampleRateHz, evidenceRef, measuredAt) {
  if (!Number.isFinite(value)) return unknownScalar('ms');
  return {
    unit: 'ms',
    value,
    provenance: 'software-diagnostic',
    sampleCount,
    measuredAt,
    device: 'OfflineAudioContext (software only)',
    sampleRateHz,
    evidenceRef,
    anchorRef: null,
  };
}

function unknownScalar(unit) {
  return { unit, value: null, provenance: 'unknown', sampleCount: 0, measuredAt: null, device: null, sampleRateHz: null, evidenceRef: null, anchorRef: null };
}

function unknownDistribution() {
  return { unit: 'ms', p50: null, p95: null, p99: null, max: null, maxAbs: null, provenance: 'unknown', sampleCount: 0, measuredAt: null, device: null, sampleRateHz: null, evidenceRef: null, anchorRef: null };
}

function unknownXrun() {
  return { ...unknownScalar('count'), coverageSeconds: null, coverageScope: 'unknown', callbackDeadlineMs: null, physicalSampleMarkerContinuous: null, hardwareDropoutEvidenceRef: null };
}

function unknownDrift() {
  return { unit: 'ms', maxAbs: null, slopeMsPerMinute: null, nonAccumulating: null, provenance: 'unknown', sampleCount: 0, measuredAt: null, device: null, sampleRateHz: null, evidenceRef: null, anchorRef: null };
}
