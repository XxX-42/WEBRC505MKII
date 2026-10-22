#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

if (process.argv[2] === '--server') {
  const serverStarted = performance.now();
  const { createServer } = await import('vite');
  const server = await createServer({ cacheDir: process.argv[3], server: { host: '127.0.0.1', port: Number(process.argv[4]), strictPort: true } });
  server.watcher.on('ready', () => console.log(`COLD_WATCH_READY ${JSON.stringify({ sinceServerStartMs: performance.now() - serverStarted, uptimeMs: process.uptime() * 1000 })}`));
  await server.listen();
  console.log('COLD_MEASURE_READY');
  const timer = setInterval(() => console.log(`COLD_CPU ${JSON.stringify({ cpu: process.cpuUsage(), memory: process.memoryUsage(), uptime: process.uptime() })}`), 2000);
  const shutdown = async () => {
    clearInterval(timer);
    const watched = server.watcher.getWatched();
    const distribution = {};
    let entries = 0;
    for (const [directory, children] of Object.entries(watched)) {
      entries += children.length;
      const relative = path.relative(process.cwd(), directory);
      const top = relative.startsWith('..') ? '[outside-root]' : (relative.split(path.sep)[0] || '[root]');
      distribution[top] = (distribution[top] || 0) + children.length;
    }
    console.log(`COLD_WATCH_COUNTS ${JSON.stringify({ directories: Object.keys(watched).length, entries, topLevelEntries: distribution })}`);
    await server.close(); process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('message', message => { if (message === 'shutdown') void shutdown(); });
} else {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const rounds = Number(option('--rounds', '3'));
  const mode = option('--audio', 'browser');
  if (!['browser', 'native'].includes(mode)) throw new Error('--audio must be browser or native');
  const port = Number(option('--port', mode === 'native' ? '4174' : '5186'));
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer from 1 to 65535');
  const output = path.resolve(option('--output', path.join(os.tmpdir(), 'rc505-vite-cold-start.json')));
  const { chromium } = await import('@playwright/test');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (!executablePath) throw new Error('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is required');
  const runs = [];
  await mkdir(path.dirname(output), { recursive: true });
  for (let round = 0; round < rounds; round++) {
    // Normal Native App initialization can reconfigure the host. Refuse to
    // launch a fresh client if that could overwrite a recorded or active loop.
    // This safety preflight precedes process spawn; all startup timings below
    // still begin at process spawn and include the full Vite startup cost.
    if (mode === 'native') {
      const response = await fetch('http://127.0.0.1:17755/v1/status', { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error(`Native safety preflight returned HTTP ${response.status}; no client was started.`);
      const status = await response.json();
      if (!Array.isArray(status.nativeTracks) || status.nativeTracks.length === 0 ||
          status.nativeTracks.some(track => track?.state !== 'Empty')) {
        throw new Error('Native safety preflight requires reported tracks to all be Empty; no client was started and the host was left untouched.');
      }
    }
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'rc505-vite-cold-cache-'));
    const started = performance.now();
    const profileDir = option('--cpu-profile', '');
    if (profileDir) await mkdir(profileDir, { recursive: true });
    const profileArgs = profileDir ? ['--cpu-prof', `--cpu-prof-dir=${profileDir}`] : [];
    const child = spawn(process.execPath, [...profileArgs, import.meta.filename, '--server', cacheDir, String(port)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let log = ''; const cpuSamples = [];
    child.stdout.on('data', data => { const text = String(data); log += text; for (const line of text.split('\n')) if (line.startsWith('COLD_CPU ')) { try { cpuSamples.push(JSON.parse(line.slice(9))); } catch {} } });
    child.stderr.on('data', data => { log += String(data); });
    let browser;
    const result = { round: round + 1, cacheDir, port, mode, budgetMs: 30000, requests: [], failures: [], cpuSamples };
    const elapsed = () => performance.now() - started;
    const remaining = () => Math.max(1, 30000 - elapsed());
    try {
      while (!log.includes('COLD_MEASURE_READY')) {
        if (child.exitCode !== null) throw new Error(`Vite exited ${child.exitCode}: ${log}`);
        if (elapsed() >= 30000) throw new Error('Vite listen exceeded 30000 ms');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const response = await fetch(`http://127.0.0.1:${port}/`);
      result.httpMs = elapsed(); result.coop = response.headers.get('cross-origin-opener-policy'); result.coep = response.headers.get('cross-origin-embedder-policy');
      browser = await chromium.launch({ executablePath, headless: true });
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      const requestStart = new Map();
      result.responseErrors = [];
      result.consoleErrors = [];
      page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
      page.on('pageerror', error => result.consoleErrors.push(error.message));
      page.on('response', response => { if (response.status() >= 400) result.responseErrors.push({ url: response.url(), status: response.status() }); });
      page.on('request', request => requestStart.set(request, performance.now()));
      page.on('requestfinished', request => result.requests.push({ url: request.url(), type: request.resourceType(), durationMs: performance.now() - requestStart.get(request), timing: request.timing() }));
      page.on('requestfailed', request => result.failures.push({ url: request.url(), error: request.failure() }));
      const navigation = performance.now();
      const goto = page.goto(`http://127.0.0.1:${port}/?audio=${mode}&ui=classic`, { timeout: remaining(), waitUntil: 'load' }).then(() => { result.loadMs = elapsed(); result.navigationLoadMs = performance.now() - navigation; }).catch(error => { result.loadError = error.message; });
      try {
        await page.locator('.app-root').waitFor({ timeout: remaining() }); result.appRootMs = elapsed();
        const lcd = page.getByTestId('rc505-lcd-screen');
        await lcd.waitFor({ timeout: remaining() });
        await page.locator('[data-panel-control="page-next"]').click({ timeout: remaining() });
        await page.waitForFunction(() => document.querySelector('[data-testid="rc505-lcd-screen"]')?.getAttribute('data-classic-screen') === 'track-status', null, { timeout: remaining() });
        result.classicInteractiveMs = elapsed();
        if (mode === 'native') { await page.locator('.status-pill').filter({ hasText: 'NATIVE AUDIO READY' }).waitFor({ timeout: remaining() }); result.nativeReadyMs = elapsed(); }
      } catch (error) { result.readinessError = error.message; }
      await goto;
      result.uiStatus = await page.evaluate(() => document.querySelector('.top-status-strip')?.textContent ?? null).catch(() => null);
      result.browserPerformance = await page.evaluate(() => ({ navigation: performance.getEntriesByType('navigation').map(x => x.toJSON()), resources: performance.getEntriesByType('resource').map(x => x.toJSON()) })).catch(() => null);
      result.inflight = [...requestStart.keys()].filter(request => !result.requests.some(x => x.url === request.url()) && !result.failures.some(x => x.url === request.url())).map(request => ({ url: request.url(), durationMs: performance.now() - requestStart.get(request) }));
    } catch (error) { result.error = error.message; }
    finally {
      result.totalMs = elapsed();
      if (browser) await browser.close();
      if (child.connected) child.send('shutdown');
      await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
      result.requests.sort((a, b) => b.durationMs - a.durationMs);
      for (const line of log.split('\n')) {
        if (line.startsWith('COLD_WATCH_READY ')) result.watcherReady = JSON.parse(line.slice(17));
        if (line.startsWith('COLD_WATCH_COUNTS ')) result.watcherCounts = JSON.parse(line.slice(18));
      }
      const stages = ['httpMs', 'loadMs', 'appRootMs', 'classicInteractiveMs', ...(mode === 'native' ? ['nativeReadyMs'] : [])];
      result.passed = stages.every(key => Number.isFinite(result[key]) && result[key] <= 30000) && result.coop === 'same-origin' && result.coep === 'require-corp' && !result.error && !result.loadError && !result.readinessError;
      result.serverLog = log;
      runs.push(result);
      await writeFile(output, JSON.stringify({ scope: 'Fresh Vite process, unique cold optimizer cache, fresh browser process/context; existing runtime ports and caches untouched. Timing budget is 30 seconds from process spawn. Native mode starts the normal App initialization and connects to an existing host; that client initialization is not claimed to be read-only. The host implementation is unchanged.', runs }, null, 2));
      console.log(JSON.stringify({ round: result.round, httpMs: result.httpMs, loadMs: result.loadMs, classicInteractiveMs: result.classicInteractiveMs, nativeReadyMs: result.nativeReadyMs, error: result.error || result.readinessError || result.loadError, slowest: result.requests.slice(0, 5).map(({url,durationMs}) => ({url,durationMs})), output }));
    }
  }
  process.exitCode = runs.every(run => run.passed) ? 0 : 1;
}
