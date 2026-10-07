import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(`Offline browser FX benchmark (no audio-device stream is opened)\n\nUsage:\n  node scripts/dsp-effects-benchmark.mjs [--base-url http://127.0.0.1:5173] [--repeats 5] [--output-dir <TEMP path>]\n\nThe Vite development server must already be running. Outputs are restricted to the system TEMP directory.\n`);
  process.exit(0);
}

const baseUrl = validateBaseUrl(args.baseUrl ?? 'http://127.0.0.1:5173');
const repeats = positiveInteger(args.repeats ?? '5', '--repeats');
const sampleRate = 48000;
const renderDurationSeconds = 4.5;
const inputTimeSeconds = 0.25;
const thresholdFraction = 1e-4;
const tempRoot = path.resolve(os.tmpdir());
const outputRoot = path.resolve(args.outputDir ?? path.join(
  tempRoot,
  `webrc-dsp-effects-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomBytes(4).toString('hex')}`,
));

if (!isWithin(tempRoot, outputRoot)) {
  throw new Error(`Output directory must be under the system TEMP directory: ${outputRoot}`);
}
fs.mkdirSync(outputRoot, { recursive: true });

const require = createRequire(pathToFileURL(path.join(repoRoot, 'package.json')));
const { chromium } = require('@playwright/test');

const moduleHarness = String.raw`
import { FXChain } from '/src/audio/FXChain.ts';
import { FilterFX } from '/src/audio/fx/FilterFX.ts';
import { CompressorFX } from '/src/audio/fx/CompressorFX.ts';
import { DelayFX } from '/src/audio/fx/DelayFX.ts';
import { ReverbFX } from '/src/audio/fx/ReverbFX.ts';
import { PhaserFX } from '/src/audio/fx/PhaserFX.ts';
import { SlicerFX } from '/src/audio/fx/SlicerFX.ts';

const SAMPLE_RATE = 48000;
const RENDER_SECONDS = 4.5;
const INPUT_TIME_SECONDS = 0.25;
const THRESHOLD_FRACTION = 1e-4;
const uiPercent = (value) => Math.min(100, Math.max(0, value)) / 100;

// FX classes expose normalized 0..1 values. Convert the UI's documented 0..100
// controls at the same boundary used by BrowserAudioEngine.
const caseBuilders = {
  FILTER: (context) => {
    const fx = new FilterFX(context);
    fx.setParam('frequency', uiPercent(50));
    fx.setParam('resonance', uiPercent(25));
    fx.setBypass(false);
    return { input: fx.input, output: fx.output, dispose: () => fx.dispose(), params: { frequencyUi: 50, resonanceUi: 25 } };
  },
  COMPRESSOR: (context) => {
    const fx = new CompressorFX(context);
    fx.setParam('amount', uiPercent(55));
    fx.setBypass(false);
    return {
      input: fx.input, output: fx.output, dispose: () => fx.dispose(),
      initialize: async () => {
        await fx.initialize();
        if (!fx.isReady || !fx.active) throw new Error('Compressor DSP must be active before benchmarking.');
      },
      params: { amountUi: 55 },
    };
  },
  DELAY: (context) => {
    const fx = new DelayFX(context);
    fx.setParam('time', 0.3); // This API parameter is seconds, not a 0..100 dial.
    fx.setParam('feedback', uiPercent(40));
    fx.setParam('mix', uiPercent(100));
    fx.setBypass(false);
    return { input: fx.input, output: fx.output, dispose: () => fx.dispose(), params: { timeSeconds: 0.3, feedbackUi: 40, mixUi: 100 } };
  },
  REVERB: (context) => {
    const fx = new ReverbFX(context);
    fx.setParam('mix', uiPercent(100));
    fx.setBypass(false);
    return { input: fx.input, output: fx.output, dispose: () => fx.dispose(), params: { impulseResponseSeconds: 2, mixUi: 100 } };
  },
  PHASER: (context) => {
    const fx = new PhaserFX(context);
    fx.setParam('rate', 50); // Phaser/Slicer APIs already take UI 0..100.
    fx.setParam('depth', 65);
    fx.setBypass(false);
    return { input: fx.input, output: fx.output, dispose: () => fx.dispose(), params: { rateUi: 50, depthUi: 65 } };
  },
  SLICER: (context) => {
    const fx = new SlicerFX(context);
    fx.setParam('rate', 50);
    fx.setParam('depth', 65);
    fx.setBypass(false);
    return { input: fx.input, output: fx.output, dispose: () => fx.dispose(), params: { rateUi: 50, depthUi: 65 } };
  },
  FULL_CHAIN: (context) => {
    // Use the app's real fixed four-effect routing: Compressor -> Filter -> Delay -> Reverb.
    const chain = new FXChain(context);
    chain.compressor.setParam('amount', uiPercent(45));
    chain.compressor.setBypass(false);
    chain.filter.setParam('frequency', uiPercent(50));
    chain.filter.setParam('resonance', uiPercent(25));
    chain.filter.setBypass(false);
    chain.delay.setParam('time', 0.3);
    chain.delay.setParam('feedback', uiPercent(35));
    chain.delay.setParam('mix', uiPercent(45));
    chain.delay.setBypass(false);
    // Preserve ReverbFX's constructor-generated 2.0-second impulse response.
    chain.reverb.setParam('mix', uiPercent(45));
    chain.reverb.setBypass(false);
    return {
      input: chain.input,
      output: chain.output,
      initialize: async () => {
        await chain.initialize();
        if (!chain.compressor.isReady || !chain.compressor.active) throw new Error('Full-chain compressor DSP is not active.');
      },
      dispose: () => {
        chain.input.disconnect();
        chain.compressor.dispose();
        chain.filter.dispose();
        chain.delay.dispose();
        chain.reverb.dispose();
        chain.output.disconnect();
      },
      params: {
        compressorAmountUi: 45,
        filterFrequencyUi: 50,
        filterResonanceUi: 25,
        delayTimeSeconds: 0.3,
        delayFeedbackUi: 35,
        delayMixUi: 45,
        reverbImpulseResponseSeconds: 2,
        reverbMixUi: 45,
      },
    };
  },
};

function measureOutput(buffer, inputFrame) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  let peakAmplitude = 0;
  let peakFrame = -1;
  for (let frame = 0; frame < buffer.length; frame += 1) {
    let magnitude = 0;
    for (const samples of channels) magnitude = Math.max(magnitude, Math.abs(samples[frame]));
    if (magnitude > peakAmplitude) {
      peakAmplitude = magnitude;
      peakFrame = frame;
    }
  }

  const threshold = peakAmplitude * THRESHOLD_FRACTION;
  let firstFrame = -1;
  let lastFrame = -1;
  if (threshold > 0) {
    for (let frame = 0; frame < buffer.length; frame += 1) {
      let magnitude = 0;
      for (const samples of channels) magnitude = Math.max(magnitude, Math.abs(samples[frame]));
      if (magnitude >= threshold) {
        if (firstFrame < 0) firstFrame = frame;
        lastFrame = frame;
      }
    }
  }
  const offsetMs = (frame) => frame < 0 ? null : (frame - inputFrame) / SAMPLE_RATE * 1000;
  return {
    firstArrivalOffsetSamples: firstFrame < 0 ? null : firstFrame - inputFrame,
    firstArrivalOffsetMs: offsetMs(firstFrame),
    peakOffsetSamples: peakFrame < 0 ? null : peakFrame - inputFrame,
    peakOffsetMs: offsetMs(peakFrame),
    peakAmplitude,
    tailEndOffsetSamples: lastFrame < 0 ? null : lastFrame - inputFrame,
    tailEndOffsetMs: offsetMs(lastFrame),
    thresholdAmplitude: threshold,
  };
}

async function renderOne(caseName, repeat) {
  const context = new OfflineAudioContext(2, Math.round(SAMPLE_RATE * RENDER_SECONDS), SAMPLE_RATE);
  const source = context.createBufferSource();
  const pulse = context.createBuffer(1, 1, SAMPLE_RATE);
  pulse.getChannelData(0)[0] = 1;
  source.buffer = pulse;
  const fx = caseBuilders[caseName](context);
  await fx.initialize?.();
  const inputFrame = Math.round(INPUT_TIME_SECONDS * SAMPLE_RATE);
  source.connect(fx.input);
  fx.output.connect(context.destination);
  source.start(INPUT_TIME_SECONDS);

  const renderStart = performance.now();
  let rendered;
  try {
    rendered = await context.startRendering();
  } catch (error) {
    fx.dispose();
    throw error;
  }
  const offlineRenderCpuMs = performance.now() - renderStart;
  const measured = measureOutput(rendered, inputFrame);
  fx.dispose();
  return {
    sampleRate: SAMPLE_RATE,
    caseName,
    repeat,
    inputFrame,
    inputTimeSeconds: INPUT_TIME_SECONDS,
    renderDurationSeconds: RENDER_SECONDS,
    thresholdFraction: THRESHOLD_FRACTION,
    ...measured,
    offlineRenderCpuMs,
    parameters: fx.params,
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length - 1) * p)];
}

function summarize(runs) {
  const metrics = ['firstArrivalOffsetMs', 'peakOffsetMs', 'tailEndOffsetMs', 'offlineRenderCpuMs'];
  return Object.keys(caseBuilders).map((caseName) => {
    const cases = runs.filter((run) => run.caseName === caseName);
    const summary = { sampleRate: SAMPLE_RATE, caseName, repeats: cases.length };
    for (const metric of metrics) {
      const values = cases.map((run) => run[metric]).filter(Number.isFinite);
      const label = metric.replace(/Ms$/, '');
      summary[label + 'P50'] = percentile(values, 0.50);
      summary[label + 'P95'] = percentile(values, 0.95);
      summary[label + 'P99'] = percentile(values, 0.99);
      summary[label + 'Max'] = values.length ? Math.max(...values) : null;
    }
    return summary;
  });
}

window.runFxBench = async (repeatCount) => {
  const runs = [];
  for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
    for (const caseName of Object.keys(caseBuilders)) {
      runs.push(await renderOne(caseName, repeat));
    }
  }
  return { runs, summaries: summarize(runs) };
};
window.fxBenchReady = true;
`;

const response = await fetch(baseUrl);
if (!response.ok) throw new Error(`Vite returned HTTP ${response.status} at ${baseUrl}`);
const browserExecutable = resolveChromiumExecutable(chromium);
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(browserExecutable ? { executablePath: browserExecutable } : {}),
});
let page;
try {
  page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => process.stderr.write(`browser page error: ${error.message}\n`));
  // Keep Vue's production app bootstrap from initializing any audio engine or
  // requesting devices; this page is only the Vite same-origin TS module host.
  await page.route(/\/src\/main\.ts(?:\?.*)?$/, (route) => route.abort('blockedbyclient'));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ type: 'module', content: moduleHarness });
  await page.waitForFunction(() => window.fxBenchReady === true);
  const browserInfo = await page.evaluate(() => ({ userAgent: navigator.userAgent, platform: navigator.platform }));
  const startedAt = new Date().toISOString();
  const result = await page.evaluate((count) => window.runFxBench(count), repeats);
  const report = {
    benchmark: 'Actual project TypeScript FX classes in independent 48 kHz stereo OfflineAudioContexts; no audio-device streams',
    startedAt,
    completedAt: new Date().toISOString(),
    baseUrl,
    browserInfo,
    sampleRate,
    repeatsPerCase: repeats,
    input: 'One-sample full-scale impulse at 0.25 s, mono source, stereo output',
    arrivalAndTailThreshold: 'first/last frame whose max absolute channel sample is >= 1e-4 * full-render peak',
    offlineRenderCpuDefinition: 'wall time around awaiting OfflineAudioContext.startRendering(); excludes graph setup and post-render sample analysis; not realtime CPU or device latency',
    cases: ['FILTER', 'COMPRESSOR', 'DELAY', 'REVERB', 'PHASER', 'SLICER', 'FULL_CHAIN'],
    result,
  };
  const rawPath = path.join(outputRoot, 'raw-results.json');
  const runsCsvPath = path.join(outputRoot, 'runs.csv');
  const summaryCsvPath = path.join(outputRoot, 'summary.csv');
  const reproPath = path.join(outputRoot, 'repro-command.ps1');
  fs.writeFileSync(rawPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(runsCsvPath, toCsv(result.runs), 'utf8');
  fs.writeFileSync(summaryCsvPath, toCsv(result.summaries), 'utf8');
  const escapedRoot = repoRoot.replaceAll("'", "''");
  fs.writeFileSync(reproPath, `Set-Location '${escapedRoot}'\nnode scripts/dsp-effects-benchmark.mjs --base-url '${baseUrl}' --repeats ${repeats}\n`, 'utf8');
  process.stdout.write(JSON.stringify({ outputRoot, rawPath, runsCsvPath, summaryCsvPath, reproPath, summaries: result.summaries }, null, 2) + '\n');
} finally {
  if (page) await page.close();
  await browser.close();
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (['--base-url', '--repeats', '--output-dir'].includes(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      parsed[{ '--base-url': 'baseUrl', '--repeats': 'repeats', '--output-dir': 'outputDir' }[arg]] = value;
      i += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function positiveInteger(value, option) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100) throw new Error(`${option} must be an integer from 1 to 100`);
  return number;
}

function validateBaseUrl(value) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('--base-url must point to a local Vite server');
  if (url.protocol !== 'http:') throw new Error('--base-url must use http:');
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
}

function resolveChromiumExecutable(playwrightChromium) {
  const explicit = process.env.WEBRC_CHROMIUM_EXECUTABLE;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`WEBRC_CHROMIUM_EXECUTABLE does not exist: ${explicit}`);
    return explicit;
  }
  const configured = playwrightChromium.executablePath();
  if (fs.existsSync(configured)) return configured;
  const browserCache = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(browserCache)) return undefined;
  const cachedVersions = fs.readdirSync(browserCache, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^chromium_headless_shell-\d+$/.test(entry.name))
    .sort((left, right) => Number(right.name.split('-').at(-1)) - Number(left.name.split('-').at(-1)));
  for (const version of cachedVersions) {
    const candidate = path.join(browserCache, version.name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function toCsv(rows) {
  if (!rows.length) return '\n';
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value) => {
    const cell = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  };
  return `${fields.map(escape).join(',')}\r\n${rows.map((row) => fields.map((field) => escape(row[field])).join(',')).join('\r\n')}\r\n`;
}
