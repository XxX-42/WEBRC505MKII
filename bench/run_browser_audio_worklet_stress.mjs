#!/usr/bin/env node
/**
 * Actual-browser AudioWorklet stress harness for the Browser FX graph.
 *
 * Short smoke:   node bench/run_browser_audio_worklet_stress.mjs --duration-seconds 10
 * 30 wall min:   node bench/run_browser_audio_worklet_stress.mjs --duration-minutes 30
 *
 * The 30-minute mode is real wall time. Results are generated only after the
 * run finishes. Do not start that mode until the coordinating task authorizes it.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_BROWSER = '/tmp/rc505-cft154/chrome-headless-shell-linux64/chrome-headless-shell';

function readOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'duration-seconds': { type: 'string' },
      'duration-minutes': { type: 'string' },
      'sample-rate-hz': { type: 'string', default: '48000' },
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
      '  --sample-rate-hz N     Requested AudioContext rate (default: 48000)',
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
  const sampleRate = Number(values['sample-rate-hz']);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 1_800) {
    throw new RangeError('Measurement duration must be greater than 0 and no more than 1800 seconds');
  }
  if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0 || minutes > 30)) {
    throw new RangeError('Duration in minutes must be greater than 0 and no more than 30');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError('Requested sample rate must be an integer from 8000 through 192000 Hz');
  }
  const diagnosticStage = values['diagnostic-stage'];
  if (!['production', 'instrumented-heartbeat', 'single-lpf'].includes(diagnosticStage)) {
    throw new RangeError(`Unsupported diagnostic stage: ${diagnosticStage}`);
  }
  const diagnosticMeasurementMode = values['diagnostic-measurement-mode'];
  if (!['record', 'preflight'].includes(diagnosticMeasurementMode)) {
    throw new RangeError(`Unsupported diagnostic measurement mode: ${diagnosticMeasurementMode}`);
  }

  return {
    durationSeconds,
    sampleRate,
    browserPath: resolve(values.browser),
    outputPath: values.output ? resolve(values.output) : null,
    diagnosticDirectSource: values['diagnostic-direct-source'],
      diagnosticOutputProbe: values['diagnostic-output-probe'],
    diagnosticStage,
    diagnosticMeasurementMode,
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

function sanitizeLaunchArguments(browser) {
  const args = browser.process()?.spawnargs ?? [];
  const forbidden = args.filter((arg) => /^(--no-sandbox|--disable-setuid-sandbox|--disable-web-security|--allow-running-insecure-content|--allow-insecure-localhost)(=|$)/i.test(arg));
  if (forbidden.length > 0) {
    throw new Error(`Refusing to benchmark with Chromium security-disabling flags: ${forbidden.join(', ')}`);
  }
  return args.filter((arg) => arg.startsWith('--'));
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  if (!options) return;
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Refusing to launch Chrome as root; run as an unprivileged user so Chromium sandboxing can remain enabled');
  }
  await access(options.browserPath);
  const browserBinaryVersion = inspectBrowserVersion(options.browserPath);

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
let browserServer;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not expose its local listening port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    browserServer = await chromium.launchServer({
      executablePath: options.browserPath,
      headless: true,
      chromiumSandbox: true,
    });
    const launchArgs = sanitizeLaunchArguments(browserServer);
    browser = await chromium.connect(browserServer.wsEndpoint());
    const browserVersion = await browser.version();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') process.stderr.write(`[browser console] ${message.text()}\n`);
    });
    page.on('pageerror', (error) => process.stderr.write(`[browser page error] ${error.message}\n`));

    const pageUrl = new URL('/bench/browser_audio_worklet_stress.html', baseUrl);
    pageUrl.searchParams.set('seconds', String(options.durationSeconds));
    pageUrl.searchParams.set('sampleRate', String(options.sampleRate));
    if (options.diagnosticDirectSource) pageUrl.searchParams.set('diagnosticDirectSource', '1');
    if (options.diagnosticOutputProbe) pageUrl.searchParams.set('diagnosticOutputProbe', '1');
    if (options.diagnosticStage !== 'production') pageUrl.searchParams.set('diagnosticStage', options.diagnosticStage);
    if (options.diagnosticMeasurementMode !== 'record') pageUrl.searchParams.set('diagnosticMeasurementMode', options.diagnosticMeasurementMode);
    await page.goto(pageUrl.toString(), { waitUntil: 'networkidle' });
    await page.locator('#start').click();

    const setupTimeout = 90_000;
    await page.waitForFunction(() => window.__rc505Bench?.ready || window.__rc505Bench?.error, null, { timeout: setupTimeout });
    const setup = await page.evaluate(() => ({
      ready: window.__rc505Bench?.ready ?? false,
      error: window.__rc505Bench?.error ?? null,
      readySlots: window.__rc505Bench?.readySlots ?? 0,
      nodeCount: window.__rc505Bench?.nodeCount ?? 0,
    }));
    if (setup.error) throw new Error(`Browser graph setup failed: ${setup.error}`);
    process.stdout.write(`Graph ready: ${setup.readySlots}/${setup.nodeCount} instrumented worklet processors; measuring ${options.durationSeconds} real-wall seconds\n`);

    const measurementTimeout = (options.durationSeconds * 1000) + 120_000;
    await page.waitForFunction(
      () => window.__rc505BenchResult || window.__rc505Bench?.error,
      null,
      { timeout: measurementTimeout },
    );
    const browserError = await page.evaluate(() => window.__rc505Bench?.error ?? null);
    if (browserError) throw new Error(`Browser measurement failed: ${browserError}`);
    const result = await page.evaluate(() => window.__rc505BenchResult ?? null);
    if (!result) throw new Error('The browser page finished without returning benchmark JSON');

    result.runner = {
      browserExecutablePath: options.browserPath,
      browserBinaryVersion,
      playwrightBrowserVersion: browserVersion,
      sandboxRequested: true,
      chromiumSandboxFlagEnabled: !launchArgs.includes('--no-sandbox') && !launchArgs.includes('--disable-setuid-sandbox'),
      launchFlags: launchArgs,
      runnerNodeVersion: process.version,
      requestedDurationSeconds: options.durationSeconds,
      requestedSampleRateHz: options.sampleRate,
      localServerOrigin: baseUrl,
      browserPageUrl: pageUrl.toString(),
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

    const outputPath = options.outputPath ?? resolve(REPO_ROOT, 'bench/results', `browser_audio_worklet_stress_${isoFileTimestamp()}.json`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`Saved benchmark JSON: ${outputPath}\n`);
    process.stdout.write(`Browser: ${browserBinaryVersion}; actual sample rate: ${result.browser.actualSampleRateHz} Hz; measured wall duration: ${result.duration.seconds.toFixed(3)} s\n`);
    process.stdout.write(`Callbacks: ${result.metrics.callbackCounts.totalInstrumentedCallbacks}; estimated missing callbacks: ${result.metrics.callbackCounts.estimatedMissingCallbacks}; deadline misses: ${result.metrics.callbackCounts.deadlineMisses}; non-finite outputs: ${result.metrics.callbackCounts.nonFiniteOutputSamples}\n`);
  } finally {
    await browser?.close().catch(() => undefined);
    await browserServer?.close().catch(() => undefined);
    await server.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
  process.exitCode = 1;
});
