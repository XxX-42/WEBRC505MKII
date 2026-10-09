import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const outputDirectory = resolve(repoRoot, 'test-results/dsp-wasm');
const processorPath = resolve(repoRoot, 'shared/dsp/wasm/tests/dsp-wasm-worklet-processor.js');
const pageScriptPath = resolve(repoRoot, 'shared/dsp/wasm/tests/worklet-smoke-page.js');
const htmlPath = resolve(repoRoot, 'shared/dsp/wasm/tests/worklet-smoke.html');
const wasmPath = resolve(repoRoot, 'test-results/dsp-wasm/webrc-dsp.wasm');
const buildManifestPath = resolve(repoRoot, 'test-results/dsp-wasm/webrc-dsp.build.json');
const sourcePaths = {
  primitiveHeader: resolve(repoRoot, 'shared/dsp/include/webrc/dsp/primitives.hpp'),
  primitiveSource: resolve(repoRoot, 'shared/dsp/src/primitives.cpp'),
  wasmWrapperHeader: resolve(repoRoot, 'shared/dsp/wasm/webrc_dsp_wasm.h'),
  wasmWrapperSource: resolve(repoRoot, 'shared/dsp/wasm/webrc_dsp_wasm.cpp'),
  workletProcessor: resolve(repoRoot, 'shared/dsp/wasm/tests/dsp-wasm-worklet-processor.js'),
  workletPage: resolve(repoRoot, 'shared/dsp/wasm/tests/worklet-smoke-page.js'),
  workletRunner: resolve(fileURLToPath(import.meta.url)),
  buildScript: resolve(repoRoot, 'shared/dsp/wasm/build-wasm.ps1'),
  nativeGolden: resolve(repoRoot, 'shared/dsp/benchmarks/results/native_primitives_golden.json'),
  wasmBuildManifest: buildManifestPath,
};
const sampleRate = argumentNumber('--sample-rate', 48000, 8000, 192000);
const blocks = argumentNumber('--blocks', 1024, 1, 10000);
const maxBlockFrames = argumentNumber('--max-block-frames', 512, 1, 8192);
const timeoutMs = argumentNumber('--timeout-ms', 30000, 1000, 600000);
const traceCategory = 'disabled-by-default-audio-worklet';
const allowedFiles = new Map([
  ['/worklet-smoke.html', htmlPath],
  ['/worklet-smoke-page.js', pageScriptPath],
  ['/dsp-wasm-worklet-processor.js', processorPath],
  ['/webrc-dsp.wasm', wasmPath],
]);

function argumentNumber(name, fallback, minimum, maximum) {
  const argument = process.argv.find((item) => item.startsWith(`${name}=`));
  if (!argument) return fallback;
  const value = Number(argument.slice(name.length + 1));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function contentType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createTestServer() {
  return createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const path = allowedFiles.get(pathname);
    if (!path) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    try {
      const body = await readFile(path);
      response.writeHead(200, {
        'content-type': contentType(path),
        'cache-control': 'no-store',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error));
    }
  });
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index];
}

function findFrameCount(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  for (const [key, child] of Object.entries(value)) {
    if (/^(frameCount|framesCount|numberOfFrames|renderQuantumFrames)$/i.test(key) &&
        Number.isInteger(child) && child > 0) return child;
  }
  for (const child of Object.values(value)) {
    const nested = findFrameCount(child, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

function analyzeTrace(events, bufferUsage, run, traceComplete) {
  const allProcessEvents = events.filter((event) =>
    event.name === 'AudioWorkletProcessor::Process (author script execution)' &&
    event.ph === 'X' && Number.isFinite(event.dur));
  const callbackEvents = allProcessEvents.filter((event) =>
    String(event.cat || '').includes('audio-worklet'));
  const tids = [...new Set(callbackEvents.map((event) => event.tid).filter(Number.isInteger))];
  const start = run.summary.startCallbackIndex;
  const callbackCount = run.summary.totalCallbacks;
  const selected = callbackEvents.length === callbackCount &&
      Number.isInteger(start) && start >= 0 && start + run.targetBlocks <= callbackEvents.length
    ? callbackEvents.slice(start, start + run.targetBlocks)
    : [];
  const durationsUs = selected.map((event) => event.dur);
  const traceFrames = callbackEvents.map((event) => findFrameCount(event.args));
  const detectedLossEvents = events.filter((event) => {
    const text = `${event.name || ''} ${JSON.stringify(event.args || {})}`;
    return /TraceBufferFull|lostTraceEvents|dataLossOccurred|droppedEvents/i.test(text);
  });
  const maximumBufferUse = bufferUsage.reduce((value, sample) => {
    const candidate = Number(sample.percentFull ?? sample.value);
    return Number.isFinite(candidate) ? Math.max(value, candidate) : value;
  }, 0);
  const dataLossOccurred = typeof traceComplete?.dataLossOccurred === 'boolean'
    ? traceComplete.dataLossOccurred
    : null;
  const exactCoverage = selected.length === run.targetBlocks && tids.length === 1 &&
    callbackEvents.length === callbackCount;
  const lossDetected = detectedLossEvents.length > 0 || maximumBufferUse >= 0.99 || dataLossOccurred === true
    ? true
    : dataLossOccurred === false ? false : null;
  const selectedTraceFrames = exactCoverage ? traceFrames.slice(start, start + run.targetBlocks) : [];
  const hasTraceFrameArgs = traceFrames.some(Number.isInteger);
  const frameArgsMatch = hasTraceFrameArgs && selectedTraceFrames.length === run.targetBlocks &&
    selectedTraceFrames.every((frames, index) => frames === run.measuredFrameCounts[index]);
  const frameAlignmentValid = hasTraceFrameArgs ? frameArgsMatch : traceFrames.every((frames) => frames === null);
  const quantumDistribution = {};
  for (const frames of run.measuredFrameCounts) quantumDistribution[frames] = (quantumDistribution[frames] || 0) + 1;
  const attributable = exactCoverage && frameAlignmentValid;
  let durationStatus = 'unavailable';
  if (attributable && lossDetected === false && durationsUs.every(Number.isFinite)) {
    durationStatus = 'complete-for-measured-interface-callbacks';
  } else if (selected.length > 0) {
    durationStatus = 'partial; no complete P99 reported';
  }

  return {
    sourceEventNamesObserved: [...new Set(callbackEvents.map((event) => event.name))],
    categoryRequested: traceCategory,
    rawTraceEventCount: events.length,
    processDurationEventCount: callbackEvents.length,
    audioWorkletProcessorThreadIds: tids,
    workletCallbackCount: callbackCount,
    workletIsolation: 'one fresh browser context, one page, one AudioWorkletNode; callback count must match trace Process events',
    processorAttribution: attributable
      ? 'matched the isolated single-node callback count and frame sequence'
      : 'unconfirmed; P50/P95/P99 suppressed',
    measuredStartCallbackIndex: start,
    measuredBlockCount: run.targetBlocks,
    durationCoverage: callbackEvents.length === 0 ? 0 : selected.length / run.targetBlocks,
    durationStatus,
    durationUnits: 'microseconds (Chromium trace dur)',
    p50Us: durationStatus === 'complete-for-measured-interface-callbacks' ? percentile(durationsUs, 0.50) : null,
    p95Us: durationStatus === 'complete-for-measured-interface-callbacks' ? percentile(durationsUs, 0.95) : null,
    p99Us: durationStatus === 'complete-for-measured-interface-callbacks' ? percentile(durationsUs, 0.99) : null,
    maxUs: durationStatus === 'complete-for-measured-interface-callbacks'
      ? durationsUs.reduce((maximum, duration) => Math.max(maximum, duration), 0)
      : null,
    alignedMeasuredFrameCounts: exactCoverage ? run.measuredFrameCounts : [],
    measuredTraceReportedFrameCounts: hasTraceFrameArgs ? selectedTraceFrames : [],
    frameCountInTraceArgs: hasTraceFrameArgs,
    traceFrameArgumentsMatchWorkletOutputs: hasTraceFrameArgs ? frameArgsMatch : null,
    workletQuantumFrameCounts: quantumDistribution,
    lostTraceEventsCheck: {
      explicitLossMarkers: detectedLossEvents.length,
      maximumReportedBufferUsage: maximumBufferUse,
      tracingCompleteDataLossOccurred: dataLossOccurred,
      lossDetected,
      status: lossDetected === true
        ? 'possible-loss-or-buffer-saturation'
        : lossDetected === false
          ? 'Tracing.tracingComplete reports dataLossOccurred=false; no buffer saturation observed'
          : bufferUsage.length > 0 && maximumBufferUse < 0.99
            ? 'unknown; reported trace buffer stayed below saturation, but Chromium exposed no dropped-event counter'
            : 'unknown; Chromium did not report trace-buffer usage or a lost-event counter',
    },
    bufferUsageSamples: bufferUsage,
  };
}

await mkdir(outputDirectory, { recursive: true });
const wasmBytes = await readFile(wasmPath);
const buildManifest = JSON.parse(await readFile(buildManifestPath, 'utf8'));
assert.equal(buildManifest.schemaVersion, 1, 'WASM build manifest schema');
assert.equal(buildManifest.sourceFilesStableDuringBuild, true, 'compiled inputs stayed stable for this build');
assert.equal(buildManifest.artifact.byteLength, wasmBytes.byteLength);
assert.equal(buildManifest.artifact.sha256, sha256(wasmBytes), 'WASM artifact matches its build manifest');
assert.equal(buildManifest.build.emsdkCommit, '35ff8a6d150541276abbc6bae512ca90bcfbe220');
assert.match(buildManifest.build.compilerIdentity, /6\.0\.10 \(d6c521a7f05449857c76bd99e396895583cf2083\)$/);
assert.ok(buildManifest.build.flags.includes('-fno-exceptions'));
assert.ok(buildManifest.build.flags.includes('-fno-rtti'));
assert.ok(buildManifest.build.flags.includes('-sALLOW_MEMORY_GROWTH=0'));
assert.ok(buildManifest.build.flags.includes('-sINITIAL_MEMORY=67108864'));
const canonicalSourceSet = Object.keys(buildManifest.sourceFiles ?? {}).sort()
  .map(relativePath => `${relativePath}=${buildManifest.sourceFiles[relativePath]}`).join('\n');
assert.equal(buildManifest.sourceSetSha256, sha256(Buffer.from(canonicalSourceSet, 'utf8')),
  'source-set digest matches the manifest file hashes');
for (const [relativePath, expectedSha256] of Object.entries(buildManifest.sourceFiles ?? {})) {
  const currentSha256 = sha256(await readFile(resolve(repoRoot, relativePath)));
  assert.equal(currentSha256, expectedSha256,
    `current source ${relativePath} differs from the source set that produced this WASM; rebuild before acceptance`);
}
const fingerprint = {};
for (const [name, path] of Object.entries(sourcePaths)) fingerprint[name] = sha256(await readFile(path));
fingerprint.wasmModule = sha256(wasmBytes);
const server = createTestServer();
await new Promise((resolvePromise, rejectPromise) => {
  server.once('error', rejectPromise);
  server.listen(0, '127.0.0.1', resolvePromise);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const chromeCandidates = [
  process.env.WEBRC_CHROME_PATH,
  process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
].filter(Boolean);
const installedChrome = chromeCandidates.find((path) => existsSync(path));
const browser = await chromium.launch({
  headless: true,
  ...(installedChrome ? { executablePath: installedChrome } : {}),
  args: ['--mute-audio'],
});
const browserVersion = browser.version();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error.stack || error)));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text());
});
const cdp = await page.context().newCDPSession(page);
const traceEvents = [];
const bufferUsageSamples = [];
cdp.on('Tracing.dataCollected', (data) => {
  if (Array.isArray(data.value)) {
    for (const event of data.value) traceEvents.push(event);
  }
});
cdp.on('Tracing.bufferUsage', (data) => bufferUsageSamples.push(data));

let tracingStarted = false;
let traceStartMode = 'ReportEvents with record-until-full';
let traceStartWarning = null;
let run = null;
let testError = null;
let traceComplete = null;
let contextStateBeforeTracing = null;
try {
  await page.goto(`http://127.0.0.1:${address.port}/worklet-smoke.html?blocks=${blocks}&maxBlockFrames=${maxBlockFrames}&sampleRate=${sampleRate}&timeoutMs=${timeoutMs}`, {
    waitUntil: 'load',
    timeout: 30000,
  });
  await page.evaluate(async () => {
    await window.workletHarnessReady;
    return true;
  });
  contextStateBeforeTracing = await page.evaluate(() => window.workletHarness.context.state);
  assert.equal(contextStateBeforeTracing, 'suspended', 'start tracing while the prepared AudioContext is suspended');

  try {
    await cdp.send('Tracing.start', {
      categories: traceCategory,
      options: 'record-until-full',
      transferMode: 'ReportEvents',
      bufferUsageReportingInterval: 1000,
    });
    tracingStarted = true;
  } catch (firstError) {
    traceStartWarning = String(firstError.message || firstError);
    traceStartMode = 'ReportEvents without optional buffer-use telemetry';
    await cdp.send('Tracing.start', {
      categories: traceCategory,
      options: 'record-until-full',
      transferMode: 'ReportEvents',
    });
    tracingStarted = true;
  }

  await page.locator('#start-test').click();
  await page.waitForFunction(() => window.workletHarnessResult || window.workletHarnessFailure, null, {
    timeout: timeoutMs + 10000,
  });
  run = await page.evaluate(() => {
    if (window.workletHarnessFailure) throw new Error(window.workletHarnessFailure);
    return window.workletHarnessResult;
  });
  assert.equal(run.status, 'complete');
  assert.equal(run.summary.measuredBlocks, blocks);
  assert.equal(run.summary.processError, 0);
  assert.equal(run.summary.wasiIoCalls, 0, 'the Worklet must observe no WASI stdio/import calls');
  assert.equal(run.summary.wasiIoFailures, 0, 'unexpected WASI I/O must fail closed');
  assert.equal(run.audioContextClosed, true, 'final Worklet callback count is sampled only after context shutdown');
  assert.equal(run.audioContextStateAtSetup, 'suspended');
  assert.equal(run.summary.totalCallbacksAtTargetCompletion, blocks);
  assert.ok(run.summary.totalCallbacks >= run.summary.totalCallbacksAtTargetCompletion);
  assert.equal(run.summary.wasmBytesAfter, 64 * 1024 * 1024);
  assert.equal(run.summary.frameGaps, 0, 'currentFrame should advance continuously across measured callbacks');
  assert.ok(run.summary.nonZeroInput > 0, 'Worklet must receive the software-generated input signal');
  assert.equal(run.summary.nonFinite, 0, 'WASM output must stay finite');
  assert.ok(run.summary.peak > 0, 'filtered output must be non-silent');
  assert.ok(run.measuredFrameCounts.every((frames) => frames > 0 && frames <= maxBlockFrames));
  assert.equal(run.actualSampleRate, sampleRate);
  assert.equal(run.sinkMode === 'sink-none' || run.sinkMode === 'muted-destination', true);
  assert.deepEqual(pageErrors, []);
} catch (error) {
  testError = String(error.stack || error);
} finally {
  if (tracingStarted) {
    const completePromise = new Promise((resolvePromise) => {
      cdp.once('Tracing.tracingComplete', resolvePromise);
      setTimeout(() => resolvePromise(null), 10000);
    });
    try {
      await cdp.send('Tracing.end');
      traceComplete = await completePromise;
    } catch (error) {
      traceStartWarning = [traceStartWarning, `Tracing.end: ${String(error)}`].filter(Boolean).join('\n');
    }
  }
  await browser.close().catch(() => {});
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

const traceAnalysis = run ? analyzeTrace(traceEvents, bufferUsageSamples, run, traceComplete) : {
  durationStatus: 'unavailable; Worklet run did not complete',
  rawTraceEventCount: traceEvents.length,
  processDurationEventCount: 0,
  audioWorkletProcessorThreadIds: [],
  p50Us: null,
  p95Us: null,
  p99Us: null,
  maxUs: null,
  lostTraceEventsCheck: { status: 'not-assessed', lossDetected: null },
};
const rawTrace = {
  metadata: {
    browserVersion,
    sourceFingerprintSha256: fingerprint,
    scope: 'diagnostic single-node shared-core AudioWorklet interface run; no hardware; no full effect graph/admission claim',
    requestedCategory: traceCategory,
    startMode: traceStartMode,
    audioContextStateBeforeTrace: contextStateBeforeTracing,
    startWarning: traceStartWarning,
    tracingComplete: traceComplete,
    run,
  },
  traceEvents,
};
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
const resultsDirectory = resolve(repoRoot, 'shared/dsp/benchmarks/results');
await mkdir(resultsDirectory, { recursive: true });
const rawTracePath = resolve(outputDirectory, 'audio-worklet-smoke-trace.json');
const summaryPath = resolve(outputDirectory, 'audio-worklet-smoke-summary.json');
const archiveStem = `wasm-audio-worklet-interface-${stamp}`;
const archivedTracePath = resolve(resultsDirectory, `${archiveStem}.trace.json.gz`);
const archivedSummaryPath = resolve(resultsDirectory, `${archiveStem}.json`);
const serializedTrace = `${JSON.stringify(rawTrace)}\n`;
const serializedTraceBytes = Buffer.from(serializedTrace);
const compressedTrace = gzipSync(serializedTraceBytes, { level: 9 });
const traceSha256 = sha256(serializedTraceBytes);
const compressedTraceSha256 = sha256(compressedTrace);
await writeFile(rawTracePath, serializedTrace);
await writeFile(archivedTracePath, compressedTrace);
const report = {
  status: testError ? 'failed' : 'complete',
  testError,
  browser: 'Playwright Chromium headless',
  browserVersion,
  toolScope: 'one diagnostic shared-core biquad in a real AudioWorklet process callback; synthetic software input; sink none or zero-gain destination',
  gateScope: 'interface and callback behavior only; not full app graph, 53 FX, 30-minute stress, or Gate 2 acceptance',
  wasm: {
    path: wasmPath,
    byteLength: wasmBytes.byteLength,
    sha256: fingerprint.wasmModule,
  },
  wasmBuildManifest: {
    path: buildManifestPath,
    sourceSetSha256: buildManifest.sourceSetSha256,
    sourceFiles: buildManifest.sourceFiles,
    compilerIdentity: buildManifest.build.compilerIdentity,
    emsdkCommit: buildManifest.build.emsdkCommit,
    currentSourcesMatchBuild: true,
  },
  sourceFingerprintSha256: fingerprint,
  rawTraceSha256: traceSha256,
  traceArchiveCompression: {
    format: 'gzip',
    uncompressedBytes: serializedTraceBytes.byteLength,
    uncompressedSha256: traceSha256,
    compressedBytes: compressedTrace.byteLength,
    compressedSha256: compressedTraceSha256,
  },
  run,
  trace: traceAnalysis,
  rawTracePath,
  immutableArchive: {
    summaryPath: archivedSummaryPath,
    tracePath: archivedTracePath,
  },
  traceCapture: {
    startMode: traceStartMode,
    startWarning: traceStartWarning,
    completionReceived: traceComplete !== null,
    rawEventCount: traceEvents.length,
  },
  pageErrors,
};
await writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(archivedSummaryPath, `${JSON.stringify(report, null, 2)}\n`);
const compactReport = structuredClone(report);
if (compactReport.run) {
  compactReport.run.measuredFrameCounts = `${report.run.measuredFrameCounts.length} actual outputs[0][0].length records`;
}
if (compactReport.trace && report.run) {
  compactReport.trace.alignedMeasuredFrameCounts = `${report.run.measuredFrameCounts.length} records; counts=${JSON.stringify(report.trace.workletQuantumFrameCounts)}`;
  compactReport.trace.measuredTraceReportedFrameCounts = report.trace.measuredTraceReportedFrameCounts.length
    ? `${report.trace.measuredTraceReportedFrameCounts.length} counts in trace args`
    : 'not present in Chromium event args; aligned by exact callback count/order';
}
process.stdout.write(`${JSON.stringify(compactReport, null, 2)}\n`);
process.stdout.write(`summary=${summaryPath}\ntrace=${rawTracePath}\narchiveSummary=${archivedSummaryPath}\narchiveTrace=${archivedTracePath}\n`);
if (testError) process.exitCode = 1;
