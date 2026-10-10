import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = process.cwd();
const runId = process.env.WEBRC_PRODUCTION_GRAPH_RUN_ID || new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z');
const archive = process.env.WEBRC_PRODUCTION_GRAPH_OUTPUT || join(root, 'bench', 'results', `browser-production-fullgraph-r7-${runId}`);
const outDir = join(archive, 'dist');
const harnessInput = join(archive, 'input', 'browser-production-smoke-harness.ts');
const harnessHtml = join(archive, 'input', 'harness.html');
const harnessRunner = join(archive, 'production-smoke-runner.mjs');
const productionStressRunner = join(archive, 'input', 'browser-stress-production.mjs');
const probeSource = `
  class WebRcChannelCountProbe extends AudioWorkletProcessor {
    constructor(options) { super(); this.captureId = options.processorOptions.captureId; }
    process(inputs, outputs) {
      const output = outputs[0] || [];
      for (let channel = 0; channel < output.length; channel += 1) output[channel].fill(0);
      if (this.captureId !== 0) {
        const input = inputs[0] || [];
        this.port.postMessage({ captureId: this.captureId, channelCount: input.length,
          leftSample: input[0] ? input[0][0] : null, rightSample: input[1] ? input[1][0] : null });
        this.captureId = 0;
      }
      return true;
    }
  }
  registerProcessor('webrc-channel-count-probe', WebRcChannelCountProbe);
`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

if (existsSync(archive)) throw new Error(`Refusing to overwrite production smoke evidence: ${archive}`);
mkdirSync(dirname(harnessInput), { recursive: true });
mkdirSync(outDir, { recursive: true });

const harnessSource = `
import { AudioEngine } from '/src/audio/AudioEngine.ts';
import * as browserRealtimeProtocol from '/src/audio/browserRealtimeProtocol.ts';
import * as controlDispatcher from '/src/composables/useControlDispatcher.ts';
import * as transport from '/src/core/Transport.ts';

Object.assign(window, { __webrcSmokeModules: {
  '/src/audio/AudioEngine.ts': { AudioEngine },
  '/src/audio/browserRealtimeProtocol.ts': browserRealtimeProtocol,
  '/src/composables/useControlDispatcher.ts': controlDispatcher,
  '/src/core/Transport.ts': transport,
  ready: true,
} });
`;
writeFileSync(harnessInput, harnessSource, 'utf8');
writeFileSync(harnessHtml, `<!doctype html><html><head><meta charset="UTF-8"></head><body><script type="module" src="./browser-production-smoke-harness.ts"></script></body></html>\n`, 'utf8');

const originalStressPath = join(root, 'scripts', 'browser-stress-32fx.mjs');
let stressSource = readFileSync(originalStressPath, 'utf8');
stressSource = stressSource.replace(/await import\('([^']+)'\)/g, (_match, specifier) =>
  `window.__webrcSmokeModules[${JSON.stringify(specifier)}]`);
if (stressSource.includes("await import('/src/")) {
  throw new Error('Production stress helper transformation left a Vite-only source import unresolved.');
}
writeFileSync(productionStressRunner, stressSource, 'utf8');

const buildStartedAt = new Date().toISOString();
const buildResult = await build({
  configFile: resolve(root, 'vite.config.ts'),
  mode: 'production',
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        browserProductionHarness: harnessHtml,
      },
    },
  },
});
const buildCompletedAt = new Date().toISOString();

const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
const harnessHtmlOutput = outputs.flatMap((entry) => entry.output || []).find((item) => item.type === 'asset' && item.fileName.endsWith('harness.html'));
if (!harnessHtmlOutput) throw new Error('Vite build did not emit the production harness HTML entry.');
const emittedHarnessHtmlPath = join(outDir, harnessHtmlOutput.fileName);
const emittedHarnessHtml = readFileSync(emittedHarnessHtmlPath, 'utf8');
const harnessScriptPath = emittedHarnessHtml.match(/<script[^>]+src="([^"]+)"/)?.[1];
if (!harnessScriptPath) throw new Error(`Could not locate the compiled harness module in ${harnessHtmlOutput.fileName}.`);
writeFileSync(join(outDir, '__webrc-channel-count-probe.js'), probeSource, 'utf8');

const originalSmokePath = join(root, 'scripts', 'browser-realtime-smoke.mjs');
let smokeSource = readFileSync(originalSmokePath, 'utf8');
smokeSource = smokeSource.replace("import { createServer } from 'vite';", "import { preview } from 'vite';");
smokeSource = smokeSource.replace(
  "import { createHash } from 'node:crypto';",
  "import { createHash } from 'node:crypto';\nimport { gzipSync } from 'node:zlib';",
);
const serverStart = smokeSource.indexOf('const server = await createServer({');
const serverEnd = smokeSource.indexOf('\n\nlet browser;', serverStart);
if (serverStart < 0 || serverEnd < 0) throw new Error('Could not isolate the dev-server setup in the existing full-graph smoke.');
smokeSource = `${smokeSource.slice(0, serverStart)}const server = await preview({\n  configFile: 'vite.config.ts',\n  build: { outDir: process.env.WEBRC_PRODUCTION_OUTDIR },\n  preview: { host, port: 0, strictPort: false },\n  logLevel: 'warn',\n});${smokeSource.slice(serverEnd)}`;
smokeSource = smokeSource.replace('  await server.listen();\n', '  // Vite preview starts listening when created.\n');
smokeSource = smokeSource.replace(
  "  await page.goto(`${baseUrl}/?audio=browser`, { waitUntil: 'commit' });",
  "  await page.goto(`${baseUrl}/?audio=browser`, { waitUntil: 'domcontentloaded' });\n" +
    "  await page.addScriptTag({ url: `${baseUrl}${process.env.WEBRC_PRODUCTION_HARNESS_URL}`, type: 'module' });\n" +
    "  await page.waitForFunction(() => window.__webrcSmokeModules?.ready === true, null, { timeout: 5_000 });",
);
smokeSource = smokeSource.replace(
  "    await page.reload({ waitUntil: 'networkidle' });",
  "    await page.reload({ waitUntil: 'domcontentloaded' });\n" +
    "    await page.addScriptTag({ url: `${baseUrl}${process.env.WEBRC_PRODUCTION_HARNESS_URL}`, type: 'module' });\n" +
    "    await page.waitForFunction(() => window.__webrcSmokeModules?.ready === true, null, { timeout: 5_000 });",
);
smokeSource = smokeSource.replace(/await import\('([^']+)'\)/g, (_match, specifier) =>
  `window.__webrcSmokeModules[${JSON.stringify(specifier)}]`);
smokeSource = smokeSource.replace(
  "import { runBrowserStress32Fx } from './browser-stress-32fx.mjs';",
  `import { runBrowserStress32Fx } from ${JSON.stringify(pathToFileURL(productionStressRunner).href)};`,
);
const traceAuditHelpers = `
const traceAuditConfig = {
  includedCategories: ['audio', 'webaudio', 'disabled-by-default-audio', 'disabled-by-default-audio-worklet', 'disabled-by-default-v8.gc'],
  excludedCategories: ['*'],
};
const startScopedTraceAudit = async (targetPage, durationMs) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const session = await targetPage.context().newCDPSession(targetPage);
  const events = [];
  let completion = null;
  let resolveComplete;
  const completePromise = new Promise((resolve) => { resolveComplete = resolve; });
  const onCollected = (entry) => { for (const event of entry.value || []) events.push(event); };
  const onComplete = (entry) => { completion = entry; resolveComplete(entry); };
  session.on('Tracing.dataCollected', onCollected);
  session.on('Tracing.tracingComplete', onComplete);
  const startedAtMs = Date.now();
  await session.send('Tracing.start', { traceConfig: traceAuditConfig, transferMode: 'ReportEvents' });
  return { stop: async () => {
    await session.send('Tracing.end');
    await Promise.race([completePromise, new Promise((_, reject) => setTimeout(() => reject(new Error('Scoped trace completion timed out.')), 60_000))]);
    const completedAtMs = Date.now();
    session.off('Tracing.dataCollected', onCollected);
    session.off('Tracing.tracingComplete', onComplete);
    await session.detach();
    const countBy = (key) => {
      const counts = new Map();
      for (const event of events) {
        const value = String(event[key] ?? '(none)');
        counts.set(value, (counts.get(value) || 0) + 1);
      }
      return Object.fromEntries([...counts.entries()].sort((left, right) => left[0].localeCompare(right[0])));
    };
    const categories = new Map();
    for (const event of events) for (const category of String(event.cat || '(none)').split(',')) {
      categories.set(category, (categories.get(category) || 0) + 1);
    }
    const categoryCounts = Object.fromEntries([...categories.entries()].sort((left, right) => left[0].localeCompare(right[0])));
    const selectedNames = ['AudioWorkletProcessor::Process', 'RealtimeAudioDestinationHandler::Render', 'AudioDestination::RequestRender', 'AudioDestination::Render'];
    const selectedNameCounts = Object.fromEntries(selectedNames.map((name) => [name, events.filter((event) => event.name === name).length]));
    const workletProcessEvents = events.filter((event) => event.name === 'AudioWorkletProcessor::Process' && event.ph === 'X');
    const audioTids = [...new Set(workletProcessEvents.map((event) => event.tid))];
    const audioThreadGcCount = events.filter((event) => audioTids.includes(event.tid) && String(event.cat || '').toLowerCase().includes('v8.gc')).length;
    const raw = Buffer.from(JSON.stringify({ schemaVersion: 1, startedAt: new Date(startedAtMs).toISOString(), completedAt: new Date(completedAtMs).toISOString(), traceConfig: traceAuditConfig, completion: completion ? { dataLossOccurred: Object.hasOwn(completion, 'dataLossOccurred') ? completion.dataLossOccurred : null, streamFormat: completion.streamFormat ?? null } : null, events }));
    const compressed = gzipSync(raw, { level: 9 });
    const rawPath = process.env.WEBRC_TRACE_AUDIT_OUTPUT?.replace(/\\.json$/, '.trace.json.gz');
    const reportPath = process.env.WEBRC_TRACE_AUDIT_OUTPUT;
    if (!rawPath || !reportPath) throw new Error('Scoped trace audit output paths are missing.');
    writeFileSync(rawPath, compressed);
    const report = {
      status: 'CAPTURED', startedAt: new Date(startedAtMs).toISOString(), completedAt: new Date(completedAtMs).toISOString(),
      requestedDurationMs: durationMs, actualDurationMs: completedAtMs - startedAtMs, traceConfig: traceAuditConfig,
      dataLossOccurred: completion && Object.hasOwn(completion, 'dataLossOccurred') ? completion.dataLossOccurred : null,
      eventCount: events.length, categoryCounts, topEventNames: countBy('name'), selectedNameCounts,
      audioWorkletProcessEventCount: workletProcessEvents.length, audioWorkletThreadIds: audioTids,
      audioThreadGcEventCount: audioThreadGcCount,
      wholeAudioRenderTask: { status: 'not-measured', reason: 'This trace inventories scoped Chrome audio events; it does not calculate a verified whole-graph render-task duration.' },
      rawTrace: { path: rawPath, bytes: compressed.byteLength, uncompressedBytes: raw.byteLength, sha256: createHash('sha256').update(compressed).digest('hex') },
      reportPath,
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\\n', 'utf8');
    return report;
  } };
};
`;
smokeSource = smokeSource.replace(
  "const host = '127.0.0.1';",
  `${traceAuditHelpers}\nconst host = '127.0.0.1';`,
);
smokeSource = smokeSource.replace(
  '  const smoke = await page.evaluate(async (useProjectContextForSyntheticInput) => {',
  `  const scopedTraceDurationMs = Number(process.env.WEBRC_TRACE_AUDIT_MS || 0);\n` +
    `  const scopedTrace = await startScopedTraceAudit(page, scopedTraceDurationMs);\n` +
    `  const scopedTracePromise = scopedTrace ? new Promise((resolve) => setTimeout(resolve, scopedTraceDurationMs)).then(() => scopedTrace.stop()) : null;\n` +
    '  const smoke = await page.evaluate(async (useProjectContextForSyntheticInput) => {',
);
smokeSource = smokeSource.replace(
  '  }, singleContextSyntheticInput);\n\n  result.assertions = smoke.assertions;',
  `  }, singleContextSyntheticInput);\n` +
    `  if (scopedTracePromise) {\n` +
    `    try { result.traceAudit = await scopedTracePromise; }\n` +
    `    catch (error) { result.traceAudit = { status: 'FAIL', error: error instanceof Error ? error.message : String(error) }; }\n` +
    `  }\n\n  result.assertions = smoke.assertions;`,
);
if (smokeSource.includes("await import('/src/") || smokeSource.includes("from './browser-stress-32fx.mjs'")) {
  throw new Error('Production smoke transformation left a Vite-only source import unresolved.');
}
writeFileSync(harnessRunner, smokeSource, 'utf8');

const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else {
      const bytes = readFileSync(path);
      files.push({ path: relative(archive, path).split(sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
};
walk(outDir);
const sourcePaths = [
  'index.html', 'vite.config.ts', 'package-lock.json',
  'src/audio/AudioEngine.ts', 'src/audio/BrowserAudioEngine.ts', 'src/audio/BrowserRealtimeRuntime.ts',
  'src/audio/browserRealtimeProtocol.ts', 'src/audio/browserFxMidiProtocol.ts', 'src/audio/browserRouting.ts',
  'src/audio/sharedDspGraph.ts', 'src/audio/TrackAudio.ts', 'src/audio/RhythmEngine.ts',
  'src/composables/useControlDispatcher.ts', 'src/core/Transport.ts',
  'scripts/browser-realtime-smoke.mjs', 'scripts/browser-stress-32fx.mjs',
  'scripts/browser-production-fullgraph-smoke.mjs',
  'public/worklets/looper-processor.js', 'public/worklets/master-fx-processor.js',
  'public/dsp/webrc-dsp.wasm', 'public/dsp/webrc-dsp.build.json',
];
const sourceRows = sourcePaths.map((path) => {
  const bytes = readFileSync(join(root, path));
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const sourceSetSha256 = sha256(Buffer.from(sourceRows.map((row) => `${row.path}=${row.sha256}\n`).join(''), 'utf8'));
const provenance = {
  schemaVersion: 1,
  runId,
  baseCommit: (await new Promise((resolveDone) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.on('close', (code) => resolveDone(code === 0 ? stdout.trim() : null));
  })),
  browserSmokeSource: { path: originalSmokePath, sha256: sha256(readFileSync(originalSmokePath)) },
  stressSource: { path: originalStressPath, sha256: sha256(readFileSync(originalStressPath)) },
  generatedSmokeRunner: { path: harnessRunner, sha256: sha256(readFileSync(harnessRunner)) },
  generatedProductionStressRunner: { path: productionStressRunner, sha256: sha256(readFileSync(productionStressRunner)) },
  harnessInput: { path: harnessInput, sha256: sha256(readFileSync(harnessInput)) },
  sourceFiles: sourceRows,
  sourceSetSha256,
  build: {
    startedAt: buildStartedAt,
    completedAt: buildCompletedAt,
    viteEntryPoints: ['index.html', relative(root, harnessHtml).split(sep).join('/')],
    outputFiles: files,
    outputFileCount: files.length,
  },
  outputDirectory: outDir,
  generatedHarnessScriptPath: harnessScriptPath,
};
writeJson(join(archive, 'provenance.json'), provenance);

const buildOutputLog = createWriteStream(join(archive, 'fullgraph-smoke.stdout.log'));
const buildErrorLog = createWriteStream(join(archive, 'fullgraph-smoke.stderr.log'));
const outputPath = join(archive, 'fullgraph-smoke.json');
const childEnvironment = {
  ...process.env,
  WEBRC_PRODUCTION_OUTDIR: relative(root, outDir).split(sep).join('/'),
  WEBRC_PRODUCTION_HARNESS_URL: harnessScriptPath,
  WEBRC_BROWSER_SMOKE_OUTPUT: outputPath,
  WEBRC_STRESS_MINUTES: process.env.WEBRC_STRESS_MINUTES ?? '0',
  WEBRC_STRESS_OUTPUT_DIR: process.env.WEBRC_STRESS_OUTPUT_DIR ?? join(archive, 'stress-output'),
  WEBRC_TRACE_AUDIT_MS: process.env.WEBRC_TRACE_AUDIT_MS ?? '0',
  WEBRC_TRACE_AUDIT_OUTPUT: join(archive, 'trace-audit.json'),
  WEBRC_SINGLE_CONTEXT_INPUT: '1',
};
const runner = spawn(process.execPath, [harnessRunner], { cwd: root, env: childEnvironment, windowsHide: true });
runner.stdout.pipe(buildOutputLog);
runner.stderr.pipe(buildErrorLog);
const exitCode = await new Promise((resolveDone) => runner.on('close', resolveDone));
buildOutputLog.end();
buildErrorLog.end();
const outputBytes = readFileSync(join(archive, 'fullgraph-smoke.stdout.log'));
const errorBytes = readFileSync(join(archive, 'fullgraph-smoke.stderr.log'));
writeJson(join(archive, 'runner-status.json'), {
  exitCode,
  outputPath,
  stdoutSha256: sha256(outputBytes),
  stderrSha256: sha256(errorBytes),
  completedAt: new Date().toISOString(),
});
console.log(JSON.stringify({ exitCode, archive, outputPath, sourceSetSha256, harnessScriptPath }));
if (exitCode !== 0) process.exitCode = exitCode ?? 1;
