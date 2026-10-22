#!/usr/bin/env node
/**
 * Actual-browser AudioWorklet stress harness for both a synthetic probe and
 * the production BrowserAudioEngine five-track private-FX application graph.
 *
 * Short smoke:   node bench/run_browser_audio_worklet_stress.mjs --duration-seconds 10
 * 30 wall min:   node bench/run_browser_audio_worklet_stress.mjs --duration-minutes 30
 *
 * The 30-minute mode is real wall time. Progress and status checkpoints are
 * atomically persisted while it runs; only a final result file counts as complete.
 */
import { mkdir, writeFile, access, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_BROWSER = '/tmp/rc505-cft154/chrome-headless-shell-linux64/chrome-headless-shell';
// Full-runtime's 30-minute workload can create 104 cumulative worklet nodes:
// 35 at setup, then 10 recording cycles (one recorder + one replacement
// LIVE_POLY node each) and 49 overdub nodes. Keep a small fixed reserve.
const MAX_INSTRUMENTED_WORKLET_NODES = 112;
const FULL_RUNTIME_INITIAL_WORKLET_NODES = 35;
const SHARED_MEMORY_BYTES_PER_SLOT = (17 + (2_048 + 1) + (3 * (65_535 + 1))) * Int32Array.BYTES_PER_ELEMENT;
const SHARED_MEMORY_FIXED_BYTES = 2 * Int32Array.BYTES_PER_ELEMENT;
const INSTRUMENTATION_SHARED_MEMORY_BYTES =
  (MAX_INSTRUMENTED_WORKLET_NODES * SHARED_MEMORY_BYTES_PER_SLOT) + SHARED_MEMORY_FIXED_BYTES;
let activeRunStatus = null;

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function writeRunStatus(updates) {
  if (!activeRunStatus) return;
  activeRunStatus = { ...activeRunStatus, ...updates, updatedAtUtc: new Date().toISOString() };
  await writeJsonAtomic(activeRunStatus.statusPath, activeRunStatus);
}

process.once('SIGTERM', () => {
  void writeRunStatus({ state: 'interrupted', terminalReason: 'runner received SIGTERM', finishedAtUtc: new Date().toISOString() })
    .finally(() => process.exit(143));
});
process.once('SIGINT', () => {
  void writeRunStatus({ state: 'interrupted', terminalReason: 'runner received SIGINT', finishedAtUtc: new Date().toISOString() })
    .finally(() => process.exit(130));
});

function readOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'duration-seconds': { type: 'string' },
      'duration-minutes': { type: 'string' },
      'sample-rate-hz': { type: 'string' },
      profile: { type: 'string', default: 'synthetic-probe' },
      'operation-interval-seconds': { type: 'string', default: '30' },
      'diagnostic-disable-live-poly': { type: 'boolean', default: false },
      'diagnostic-omit-private-track-fx': { type: 'boolean', default: false },
      'diagnostic-shared-input-capture': { type: 'boolean', default: false },
      'diagnostic-observe-live-poly-playback': { type: 'boolean', default: false },
      browser: { type: 'string', default: DEFAULT_BROWSER },
      'diagnostic-direct-source': { type: 'boolean', default: false },
      'diagnostic-output-probe': { type: 'boolean', default: false },
      'diagnostic-stage': { type: 'string', default: 'production' },
      'diagnostic-measurement-mode': { type: 'string', default: 'record' },
      output: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write([
      'Usage:',
      '  node bench/run_browser_audio_worklet_stress.mjs [options]',
      '',
      'Options:',
      '  --duration-seconds N   Real-wall measurement duration (default: 10; maximum: 1800)',
      '  --duration-minutes N   Real-wall duration in minutes (use 30 for the long run)',
      '  --sample-rate-hz N     Requested AudioContext rate (default: 48000 for synthetic-probe; 44100 for full-runtime)',
      '  --profile NAME         synthetic-probe (default) or full-runtime (five production Browser TrackAudio private A–D banks)',
      '  --operation-interval-seconds N  Full-runtime record/overdub cadence (default 30; use short intervals only for harness smoke tests)',
      '  --diagnostic-disable-live-poly  Isolate the five-node Signalsmith contribution; diagnostic only, not the full-load gate',
      '  --diagnostic-omit-private-track-fx  Isolate the 20 private A–D stages; diagnostic only, not the full-load gate',
      '  --diagnostic-shared-input-capture  Add the persistent engine-owned input capture tap to the 35-node full-runtime synthetic input graph (36 initial nodes); repeated sequential record/overdub operations are supported; diagnostic only',
      '  --diagnostic-observe-live-poly-playback  Observe LIVE_POLY RPCs during PCM history diagnostics; adds main-thread instrumentation',
      `  --browser PATH         Chrome for Testing headless shell (default: ${DEFAULT_BROWSER})`,
      '  --diagnostic-direct-source  Add a test-only 440 Hz oscillator to isolate render-path behavior',
      '  --output PATH          JSON destination (default: bench/results with timestamp)',
      '  -h, --help             Show this help',
      '',
      'The runner refuses to disable Chromium sandboxing and records any runtime flags.',
    ].join('\n') + '\n');
    return null;
  }
  if (values['duration-seconds'] !== undefined && values['duration-minutes'] !== undefined) {
    throw new Error('Choose either --duration-seconds or --duration-minutes');
  }

  const minutes = values['duration-minutes'] === undefined ? null : Number(values['duration-minutes']);
  const durationSeconds = values['duration-seconds'] === undefined
    ? (minutes === null ? 10 : minutes * 60)
    : Number(values['duration-seconds']);
  const profile = values.profile;
  if (!['synthetic-probe', 'full-runtime'].includes(profile)) throw new RangeError(`Unsupported benchmark profile: ${profile}`);
  if (values['diagnostic-shared-input-capture'] && profile !== 'full-runtime') {
    throw new Error('--diagnostic-shared-input-capture is available only with --profile full-runtime');
  }
  const sampleRate = Number(values['sample-rate-hz'] ?? (profile === 'full-runtime' ? '44100' : '48000'));
  const operationIntervalSeconds = Number(values['operation-interval-seconds']);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 1_800) {
    throw new RangeError('Measurement duration must be greater than 0 and no more than 1800 seconds');
  }
  if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0 || minutes > 30)) {
    throw new RangeError('Duration in minutes must be greater than 0 and no more than 30');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError('Requested sample rate must be an integer from 8000 through 192000 Hz');
  }
  if (!Number.isFinite(operationIntervalSeconds) || operationIntervalSeconds < 2 || operationIntervalSeconds > 180) {
    throw new RangeError('Operation interval must be from 2 through 180 seconds');
  }
  const diagnosticStage = values['diagnostic-stage'];
  if (!['production', 'instrumented-heartbeat', 'single-lpf'].includes(diagnosticStage)) {
    throw new RangeError(`Unsupported diagnostic stage: ${diagnosticStage}`);
  }
  const diagnosticMeasurementMode = values['diagnostic-measurement-mode'];
  if (!['record', 'preflight'].includes(diagnosticMeasurementMode)) {
    throw new RangeError(`Unsupported diagnostic measurement mode: ${diagnosticMeasurementMode}`);
  }
  const plannedDynamicOperationCount = profile === 'full-runtime'
    ? Math.max(0, Math.floor(Math.max(0, durationSeconds - 25) / operationIntervalSeconds))
    : 0;
  const plannedDynamicRecordCount = Math.ceil(plannedDynamicOperationCount / 6);
  if (values['diagnostic-shared-input-capture']) {
    if (values['diagnostic-disable-live-poly'] || values['diagnostic-omit-private-track-fx'] || values['diagnostic-direct-source']) {
      throw new Error('--diagnostic-shared-input-capture is a full-load check and cannot be combined with disabled FX, disabled LIVE_POLY, or an extra direct source');
    }
  }
  const initialInstrumentedWorkletNodes = profile === 'full-runtime'
    ? FULL_RUNTIME_INITIAL_WORKLET_NODES + Number(values['diagnostic-shared-input-capture'])
    : null;
  const plannedInstrumentedNodePeak = profile === 'full-runtime'
    ? initialInstrumentedWorkletNodes + plannedDynamicOperationCount + plannedDynamicRecordCount
    : null;
  if (plannedInstrumentedNodePeak !== null && plannedInstrumentedNodePeak > MAX_INSTRUMENTED_WORKLET_NODES) {
    throw new RangeError(
      `The full-runtime workload needs ${plannedInstrumentedNodePeak} cumulative worklet slots, `
      + `but the configured bounded instrumentation capacity is ${MAX_INSTRUMENTED_WORKLET_NODES}.`,
    );
  }

  return {
    durationSeconds,
    sampleRate,
    profile,
    operationIntervalSeconds,
    diagnosticDisableLivePoly: values['diagnostic-disable-live-poly'],
    diagnosticOmitPrivateTrackFx: values['diagnostic-omit-private-track-fx'],
    diagnosticSharedInputCapture: values['diagnostic-shared-input-capture'],
    diagnosticObserveLivePolyPlayback: values['diagnostic-observe-live-poly-playback'],
    browserPath: resolve(values.browser),
    outputPath: values.output ? resolve(values.output) : null,
    diagnosticDirectSource: values['diagnostic-direct-source'],
      diagnosticOutputProbe: values['diagnostic-output-probe'],
    diagnosticStage,
    diagnosticMeasurementMode,
    initialInstrumentedWorkletNodes,
    maxInstrumentedWorkletNodes: MAX_INSTRUMENTED_WORKLET_NODES,
    instrumentationSharedMemoryBytes: INSTRUMENTATION_SHARED_MEMORY_BYTES,
    instrumentationSharedMemoryMiB: INSTRUMENTATION_SHARED_MEMORY_BYTES / (1024 * 1024),
    plannedDynamicOperationCount,
    plannedDynamicRecordCount,
    plannedInstrumentedNodePeak,
  };
}

function isoFileTimestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function inspectBrowserVersion(browserPath) {
  const result = spawnSync(browserPath, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (result.error) throw new Error(`Could not query the configured headless shell version: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Headless shell --version exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  return (result.stdout || result.stderr).trim();
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  if (!options) return;
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Refusing to launch Chrome as root; run as an unprivileged user so Chromium sandboxing can remain enabled');
  }
  await access(options.browserPath);
  const browserBinaryVersion = inspectBrowserVersion(options.browserPath);
  const outputPath = options.outputPath ?? resolve(REPO_ROOT, 'bench/results', `browser_audio_worklet_stress_${isoFileTimestamp()}.json`);
  const statusPath = outputPath.replace(/\.json$/i, '.status.json');
  const progressPath = outputPath.replace(/\.json$/i, '.progress.json');
  activeRunStatus = {
    schemaVersion: 1,
    benchmark: 'rc505_browser_audio_worklet_stress',
    state: 'starting',
    pid: process.pid,
    hostUid: typeof process.getuid === 'function' ? process.getuid() : null,
    startedAtUtc: new Date().toISOString(),
    expectedDurationSeconds: options.durationSeconds,
    profile: options.profile,
    sampleRateHz: options.sampleRate,
    operationIntervalSeconds: options.operationIntervalSeconds,
    maxInstrumentedWorkletNodes: options.maxInstrumentedWorkletNodes,
    instrumentationSharedMemoryBytes: options.instrumentationSharedMemoryBytes,
    instrumentationSharedMemoryMiB: options.instrumentationSharedMemoryMiB,
    plannedDynamicOperationCount: options.plannedDynamicOperationCount,
    plannedDynamicRecordCount: options.plannedDynamicRecordCount,
    plannedInstrumentedNodePeak: options.plannedInstrumentedNodePeak,
    initialInstrumentedWorkletNodes: options.initialInstrumentedWorkletNodes,
    diagnosticDisableLivePoly: options.diagnosticDisableLivePoly,
    diagnosticOmitPrivateTrackFx: options.diagnosticOmitPrivateTrackFx,
    diagnosticSharedInputCapture: options.diagnosticSharedInputCapture,
    browserPath: options.browserPath,
    browserBinaryVersion,
    resultPath: outputPath,
    progressPath,
    statusPath,
    checkpointsWritten: 0,
    latestProgressAtUtc: null,
    latestElapsedWallSeconds: 0,
  };
  await writeRunStatus({ state: 'starting' });

  const server = await createServer({
    configFile: false,
    root: REPO_ROOT,
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
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not expose its local listening port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
  await writeRunStatus({ setupPhase: 'Vite server listening', localServerOrigin: baseUrl });

    browser = await chromium.launch({
      executablePath: options.browserPath,
      headless: true,
      chromiumSandbox: true,
    });
    const browserVersion = await browser.version();
  await writeRunStatus({ setupPhase: 'headless browser launched', browserVersion });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') process.stderr.write(`[browser console] ${message.text()}\n`);
    });
    page.on('pageerror', (error) => process.stderr.write(`[browser page error] ${error.message}\n`));
    page.on('requestfailed', (request) => process.stderr.write(`[browser request failed] ${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}\n`));
    page.on('response', (response) => {
      if (response.status() >= 400) process.stderr.write(`[browser HTTP ${response.status()}] ${response.url()}\n`);
    });

    const pageUrl = new URL('/bench/browser_audio_worklet_stress.html', baseUrl);
    pageUrl.searchParams.set('seconds', String(options.durationSeconds));
    pageUrl.searchParams.set('sampleRate', String(options.sampleRate));
    pageUrl.searchParams.set('profile', options.profile);
    pageUrl.searchParams.set('operationIntervalSeconds', String(options.operationIntervalSeconds));
    pageUrl.searchParams.set('maxInstrumentedNodes', String(options.maxInstrumentedWorkletNodes));
    if (options.diagnosticDisableLivePoly) pageUrl.searchParams.set('diagnosticDisableLivePoly', '1');
    if (options.diagnosticOmitPrivateTrackFx) pageUrl.searchParams.set('diagnosticOmitPrivateTrackFx', '1');
    if (options.diagnosticSharedInputCapture) pageUrl.searchParams.set('diagnosticSharedInputCapture', '1');
    if (options.diagnosticObserveLivePolyPlayback) pageUrl.searchParams.set('diagnosticObserveLivePolyPlayback', '1');
    if (options.diagnosticDirectSource) pageUrl.searchParams.set('diagnosticDirectSource', '1');
    if (options.diagnosticOutputProbe) pageUrl.searchParams.set('diagnosticOutputProbe', '1');
    if (options.diagnosticStage !== 'production') pageUrl.searchParams.set('diagnosticStage', options.diagnosticStage);
    if (options.diagnosticMeasurementMode !== 'record') pageUrl.searchParams.set('diagnosticMeasurementMode', options.diagnosticMeasurementMode);
  const navigationResponse = await page.goto(pageUrl.toString(), { waitUntil: 'networkidle' });
  const pageProbe = await page.evaluate(() => ({
    title: document.title,
    readyState: document.readyState,
    startButtonPresent: Boolean(document.querySelector('#start')),
    harnessLoaded: typeof window.__rc505Bench?.ready === 'boolean',
  }));
  await writeRunStatus({
    setupPhase: 'benchmark page loaded',
    pageHttpStatus: navigationResponse?.status() ?? null,
    pageProbe,
  });
  if (navigationResponse && !navigationResponse.ok()) {
    throw new Error(`Benchmark page returned HTTP ${navigationResponse.status()}`);
  }
  if (!pageProbe.harnessLoaded) {
    throw new Error(`Benchmark page did not initialize its harness module: ${JSON.stringify(pageProbe)}`);
  }
    await page.locator('#start').click();
  await writeRunStatus({ setupPhase: 'Start button clicked; building audio graph' });

    const setupTimeout = 90_000;
  const setupDeadline = Date.now() + setupTimeout;
  let setup;
  let lastSetupPhase = null;
  let lastSetupPhaseUpdatedAt = null;
  while (true) {
    setup = await page.evaluate(() => ({
      ready: window.__rc505Bench?.ready ?? false,
      error: window.__rc505Bench?.error ?? null,
      readySlots: window.__rc505Bench?.readySlots ?? 0,
      nodeCount: window.__rc505Bench?.nodeCount ?? 0,
      phase: window.__rc505BenchPhase ?? null,
    }));
    if (setup.phase?.updatedAtUtc !== lastSetupPhaseUpdatedAt) {
      lastSetupPhaseUpdatedAt = setup.phase?.updatedAtUtc ?? null;
      const phaseChanged = setup.phase?.stage !== lastSetupPhase;
      lastSetupPhase = setup.phase?.stage ?? null;
      if (phaseChanged) process.stdout.write(`Setup phase: ${lastSetupPhase ?? 'page module has not reported a phase'}\n`);
      await writeRunStatus({
        setupPhase: lastSetupPhase,
        setupPhaseDetails: setup.phase?.details ?? null,
        setupPhaseUpdatedAtUtc: setup.phase?.updatedAtUtc ?? null,
        readySlots: setup.readySlots,
        nodeCount: setup.nodeCount,
      });
    }
    if (setup.ready || setup.error) break;
    if (Date.now() >= setupDeadline) {
      throw new Error(`Timed out waiting for Browser graph setup after ${setupTimeout} ms; last phase=${lastSetupPhase ?? 'none'}, nodes=${setup.nodeCount}, ready=${setup.readySlots}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
    if (setup.error) throw new Error(`Browser graph setup failed: ${setup.error}`);
    process.stdout.write(`Graph ready: ${setup.readySlots}/${setup.nodeCount} instrumented worklet processors; profile=${options.profile}; measuring ${options.durationSeconds} real-wall seconds\n`);
    await writeRunStatus({
      state: 'running',
      graphReadyAtUtc: new Date().toISOString(),
      readySlots: setup.readySlots,
      nodeCount: setup.nodeCount,
      browserVersion,
      pageUrl: pageUrl.toString(),
    });

    const measurementTimeoutAt = Date.now() + (options.durationSeconds * 1000) + 300_000;
    let result = null;
    while (!result) {
      if (Date.now() > measurementTimeoutAt) throw new Error('Timed out waiting for Browser stress measurement after its requested duration plus five minutes');
      // Persist enough progress for interruption diagnosis without polling so
      // often that the control page becomes a meaningful part of the workload.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const poll = await page.evaluate(() => ({
        result: window.__rc505BenchResult ?? null,
        error: window.__rc505Bench?.error ?? null,
        exception: window.__rc505Bench?.exception ?? null,
        diagnostic: window.__rc505Bench?.diagnostic ?? null,
        progress: window.__rc505Bench?.progress ?? null,
      }));
      if (poll.progress) {
        await writeJsonAtomic(progressPath, poll.progress);
        await writeRunStatus({
          state: poll.progress.state === 'completed' ? 'finalizing' : 'running',
          checkpointsWritten: (activeRunStatus?.checkpointsWritten ?? 0) + 1,
          latestProgressAtUtc: poll.progress.generatedAtUtc,
          latestElapsedWallSeconds: poll.progress.elapsedWallSeconds ?? 0,
          latestInstrumentedNodeCount: poll.progress.instrumentedNodeCount ?? null,
          latestCallbackErrors: poll.progress.callbackErrors ?? null,
          latestEstimatedMissingCallbacks: poll.progress.estimatedMissingCallbacks ?? null,
          latestProcessorErrors: poll.progress.processorErrors ?? [],
        });
      }
      if (poll.error) {
        const failureDetailsPath = outputPath.replace(/\.json$/i, '.failure.json');
        await writeJsonAtomic(failureDetailsPath, {
          schemaVersion: 1,
          state: 'failed',
          terminalReason: poll.error,
          pageException: poll.exception,
          diagnostic: poll.diagnostic,
          lastProgress: poll.progress,
          runner: {
            browserExecutablePath: options.browserPath,
            browserBinaryVersion,
            playwrightBrowserVersion: browserVersion,
            chromiumSandboxRequested: true,
            harnessExtraLaunchArgs: [],
            launchArgumentsObserved: false,
            requestedDurationSeconds: options.durationSeconds,
            requestedSampleRateHz: options.sampleRate,
            profile: options.profile,
            operationIntervalSeconds: options.operationIntervalSeconds,
            maxInstrumentedWorkletNodes: options.maxInstrumentedWorkletNodes,
            instrumentationSharedMemoryBytes: options.instrumentationSharedMemoryBytes,
            instrumentationSharedMemoryMiB: options.instrumentationSharedMemoryMiB,
            plannedInstrumentedNodePeak: options.plannedInstrumentedNodePeak,
            diagnosticDisableLivePoly: options.diagnosticDisableLivePoly,
            diagnosticOmitPrivateTrackFx: options.diagnosticOmitPrivateTrackFx,
            diagnosticSharedInputCapture: options.diagnosticSharedInputCapture,
            initialInstrumentedWorkletNodes: options.initialInstrumentedWorkletNodes,
            localServerOrigin: baseUrl,
            browserPageUrl: pageUrl.toString(),
          },
        });
        await writeRunStatus({ failureDetailsPath });
        throw new Error(`Browser measurement failed: ${poll.error}; detailed evidence saved to ${failureDetailsPath}`);
      }
      if (poll.result) result = poll.result;
    }
    if (!result) throw new Error('The browser page finished without returning benchmark JSON');

    result.runner = {
      browserExecutablePath: options.browserPath,
      browserBinaryVersion,
      playwrightBrowserVersion: browserVersion,
      sandboxRequested: true,
      chromiumSandboxRequested: true,
      harnessExtraLaunchArgs: [],
      launchArgumentsObserved: false,
      runnerNodeVersion: process.version,
      requestedDurationSeconds: options.durationSeconds,
      requestedSampleRateHz: options.sampleRate,
      profile: options.profile,
      operationIntervalSeconds: options.operationIntervalSeconds,
      maxInstrumentedWorkletNodes: options.maxInstrumentedWorkletNodes,
      instrumentationSharedMemoryBytes: options.instrumentationSharedMemoryBytes,
      instrumentationSharedMemoryMiB: options.instrumentationSharedMemoryMiB,
      plannedDynamicOperationCount: options.plannedDynamicOperationCount,
      plannedDynamicRecordCount: options.plannedDynamicRecordCount,
      plannedInstrumentedNodePeak: options.plannedInstrumentedNodePeak,
      initialInstrumentedWorkletNodes: options.initialInstrumentedWorkletNodes,
      diagnosticSharedInputCapture: options.diagnosticSharedInputCapture,
      localServerOrigin: baseUrl,
      browserPageUrl: pageUrl.toString(),
      statusPath,
      progressPath,
    };
    if (result.browser.requestedSampleRateHz !== options.sampleRate) {
      throw new Error(`Harness page requested ${result.browser.requestedSampleRateHz} Hz but runner requested ${options.sampleRate} Hz`);
    }
    if (result.browser.actualSampleRateHz !== options.sampleRate) {
      throw new Error(`AudioContext ran at ${result.browser.actualSampleRateHz} Hz, not the requested ${options.sampleRate} Hz`);
    }
    if (!result.contextProgression?.passed) {
      throw new Error(`AudioContext clock progression failed: ${JSON.stringify(result.contextProgression)}`);
    }
    if (!result.outputSignalSentinel?.passed) {
      throw new Error(`Final output signal sentinel failed: ${JSON.stringify(result.outputSignalSentinel)}`);
    }
    if (options.diagnosticMeasurementMode === 'record' && !result.metrics.callbackCoveragePassed) {
      throw new Error(`Worklet callback coverage failed: ${JSON.stringify(result.metrics.callbackCoverage)}`);
    }
    if (options.diagnosticMeasurementMode === 'preflight' && !result.metrics.preflightCallbacksPassed) {
      throw new Error(`Preflight-mode worklet callback progression failed: ${JSON.stringify(result.metrics.preflightCallbacksDuringMeasurement)}`);
    }

    await writeJsonAtomic(outputPath, result);
    await writeRunStatus({
      state: 'completed',
      finishedAtUtc: new Date().toISOString(),
      measuredDurationSeconds: result.duration.seconds,
      callbackErrors: result.metrics.callbackCounts.callbackErrors,
      estimatedMissingCallbacks: result.metrics.callbackCounts.estimatedMissingCallbacks,
      outputSignalPassed: result.outputSignalSentinel.passed,
      contextProgressionPassed: result.contextProgression.passed,
      callbackCoveragePassed: result.metrics.callbackCoveragePassed,
      resultPath: outputPath,
    });
    process.stdout.write(`Saved benchmark JSON: ${outputPath}\n`);
    process.stdout.write(`Browser: ${browserBinaryVersion}; actual sample rate: ${result.browser.actualSampleRateHz} Hz; measured wall duration: ${result.duration.seconds.toFixed(3)} s\n`);
    process.stdout.write(`Callbacks: ${result.metrics.callbackCounts.totalInstrumentedCallbacks}; estimated missing callbacks: ${result.metrics.callbackCounts.estimatedMissingCallbacks}; deadline misses: ${result.metrics.callbackCounts.deadlineMisses}; non-finite outputs: ${result.metrics.callbackCounts.nonFiniteOutputSamples}\n`);
  } finally {
    await browser?.close().catch(() => undefined);
    await server.close();
  }
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
  await writeRunStatus({
    state: 'failed',
    finishedAtUtc: new Date().toISOString(),
    terminalReason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  process.exitCode = 1;
});
