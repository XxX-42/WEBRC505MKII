import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

// Run explicitly after performance sampling; this starts its own server/browser.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = randomUUID();
const name = `__vite_watch_probe_${id}`;
const output = await mkdtemp(path.join(os.tmpdir(), 'rc505-vite-watch-'));
const receiptPath = path.join(output, 'receipt.json');
const normalize = (value) => path.resolve(value).replaceAll('\\', '/');
const files = {
  source: path.join(root, 'src', `${name}.ts`),
  docs: path.join(root, 'docs', `${name}.json`),
  bench: path.join(root, 'bench', `${name}.ts`),
  nativeOutput: path.join(root, 'native-mvp', 'build', `${name}.txt`),
  benchOutput: path.join(root, 'bench', 'results', `${name}.txt`),
};
const created = [];
const events = [];
const receipt = { id, root, port: 5187, output, cacheDir: path.join(output, 'cache'), files,
  startedAt: new Date().toISOString(), checks: {}, events, cleanup: [] };
let server;
let browser;
let failure;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function source(version) {
  return `export const version = ${version};
window.__watchProbeEvaluations = (window.__watchProbeEvaluations || 0) + 1;
window.__watchProbeVersion = version;
if (import.meta.hot) import.meta.hot.accept((next) => {
  window.__watchProbeAccepted = next?.version;
});\n`;
}
try {
  for (const [kind, filename] of Object.entries(files)) {
    await mkdir(path.dirname(filename), { recursive: true });
    const content = kind === 'source' ? source(1) : kind === 'docs' ? '{"version":1}\n'
      : kind === 'bench' ? 'export const version = 1;\n' : 'version 1\n';
    await writeFile(filename, content, { flag: 'wx' });
    created.push(filename);
  }
  await mkdir(receipt.cacheDir, { recursive: true });
  const route = `/__vite_watch_scope_${id}`;
  server = await createServer({
    root, cacheDir: receipt.cacheDir,
    server: { host: '127.0.0.1', port: 5187, strictPort: true, open: false },
    plugins: [{
      name: 'isolated-watch-scope-probe',
      configureServer(probeServer) {
        // Install before Vite's SPA fallback, which would otherwise serve App.
        probeServer.middlewares.use((request, response, next) => {
          if (request.url?.split('?')[0] !== route) return next();
          response.setHeader('Content-Type', 'text/html');
          response.end(`<!doctype html><title>Isolated Vite watch probe</title>
<script>window.__watchProbeBoot = crypto.randomUUID()</script>
<script type="module" src="/@vite/client"></script>
<script type="module" src="/src/${name}.ts"></script>`);
        });
      },
    }],
  });
  server.watcher.on('all', (event, filename) => {
    if (Object.values(files).some((probe) => normalize(probe) === normalize(filename))) {
      events.push({ event, file: normalize(filename), at: new Date().toISOString() });
    }
  });
  await server.listen();
  await until(() => {
    const current = new Set(Object.entries(server.watcher.getWatched()).flatMap(([directory, names]) =>
      names.map((entry) => normalize(path.join(directory, entry)))));
    return ['source', 'docs', 'bench'].every((kind) => current.has(normalize(files[kind])));
  }, 'source/docs/bench watcher registration', 30_000);
  await pause(500);
  const watched = server.watcher.getWatched();
  const entries = new Set(Object.entries(watched).flatMap(([directory, names]) =>
    names.map((entry) => normalize(path.join(directory, entry)))));
  const watchedDirs = new Set(Object.keys(watched).map(normalize));
  receipt.checks.watchedInventory = {
    directoryCount: watchedDirs.size,
    source: entries.has(normalize(files.source)),
    docs: entries.has(normalize(files.docs)),
    bench: entries.has(normalize(files.bench)),
    publicDirectory: watchedDirs.has(normalize(path.join(root, 'public'))),
    index: entries.has(normalize(path.join(root, 'index.html'))),
    config: entries.has(normalize(path.join(root, 'vite.config.ts'))),
    nativeOutput: entries.has(normalize(files.nativeOutput)),
    benchOutput: entries.has(normalize(files.benchOutput)),
  };
  for (const kind of ['source', 'docs', 'bench', 'publicDirectory', 'index', 'config']) {
    assert.equal(receipt.checks.watchedInventory[kind], true, `${kind} must remain watched`);
  }
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  let navigations = 0;
  const browserErrors = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto(`http://127.0.0.1:5187${route}`);
  await page.waitForFunction(() => window.__watchProbeVersion === 1);
  const boot = await page.evaluate(() => window.__watchProbeBoot);
  const baselineNavigations = navigations;
  await writeFile(files.source, source(2));
  await page.waitForFunction(() => window.__watchProbeAccepted === 2);
  receipt.checks.hmr = await page.evaluate(() => ({
    version: window.__watchProbeVersion, accepted: window.__watchProbeAccepted,
    evaluations: window.__watchProbeEvaluations, boot: window.__watchProbeBoot,
  }));
  receipt.checks.hmr.navigations = navigations;
  receipt.checks.hmr.baselineNavigations = baselineNavigations;
  receipt.checks.hmr.browserErrors = browserErrors;
  assert.equal(receipt.checks.hmr.boot, boot, 'HMR must retain the original document');
  assert.equal(navigations, baselineNavigations, 'HMR must not navigate/reload');
  assert.equal(receipt.checks.hmr.version, 2);
  assert.equal(receipt.checks.hmr.evaluations, 2);
  assert.deepEqual(browserErrors, []);
  for (const kind of ['docs', 'bench']) {
    const before = events.length;
    await writeFile(files[kind], kind === 'docs' ? '{"version":2}\n' : 'export const version = 2;\n');
    await until(() => events.slice(before).some((entry) =>
      entry.file === normalize(files[kind]) && entry.event === 'change'), `${kind} source change event`);
    receipt.checks[`${kind}ChangeVisible`] = true;
  }
  const beforeIgnored = events.length;
  await writeFile(files.nativeOutput, 'version 2\n');
  await writeFile(files.benchOutput, 'version 2\n');
  await pause(1_200);
  const ignoredEvents = events.slice(beforeIgnored).filter((entry) =>
    entry.file === normalize(files.nativeOutput) || entry.file === normalize(files.benchOutput));
  receipt.checks.ignoredOutputEvents = ignoredEvents;
  assert.deepEqual(ignoredEvents, [], 'ignored build/results writes must not reach the watcher');
  assert.equal(receipt.checks.watchedInventory.nativeOutput, false);
  assert.equal(receipt.checks.watchedInventory.benchOutput, false);
  receipt.ok = true;
} catch (error) {
  failure = error;
  receipt.ok = false;
  receipt.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
} finally {
  for (const [label, cleanup] of [['browser', () => browser?.close()], ['server', () => server?.close()]]) {
    try { await cleanup(); } catch (error) { receipt.cleanup.push({ label, error: String(error) }); failure ??= error; }
  }
  // Only unlink files successfully created by this invocation; retain cache and receipt.
  for (const filename of created) {
    try { await unlink(filename); receipt.cleanup.push({ file: filename, removed: true }); }
    catch (error) { receipt.cleanup.push({ file: filename, error: String(error) }); failure ??= error; }
  }
  receipt.finishedAt = new Date().toISOString();
  if (failure) receipt.ok = false;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ ok: receipt.ok, receiptPath, checks: receipt.checks }, null, 2));
}
if (failure) process.exitCode = 1;
