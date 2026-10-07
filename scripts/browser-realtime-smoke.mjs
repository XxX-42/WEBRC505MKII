import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const host = '127.0.0.1';
const server = await createServer({
  configFile: 'vite.config.ts',
  server: { host, port: 0, strictPort: false, hmr: false },
  logLevel: 'warn',
});

let browser;
let page;
let browserError = null;
const startedAt = new Date().toISOString();
const result = {
  startedAt,
  softwareOnly: true,
  hardwareCertified: false,
  status: 'RUNNING',
  assertions: [],
  browserConsoleErrors: [],
  note: 'Synthetic oscillator input and software taps only; no physical input/output or hardware latency certification.',
};

try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP address.');
  const baseUrl = `http://${host}:${address.port}`;

  const playwrightChromiumPath = chromium.executablePath();
  const localPlaywright1228Path = join(
    process.env.LOCALAPPDATA || '',
    'ms-playwright',
    'chromium-1228',
    'chrome-win64',
    'chrome.exe',
  );
  const executablePath = process.env.WEBRC_CHROMIUM_PATH ||
    (existsSync(localPlaywright1228Path) ? localPlaywright1228Path : playwrightChromiumPath);
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  result.chromiumVersion = browser.version();
  result.executablePath = executablePath;

  page = await browser.newPage();
  page.on('pageerror', (error) => result.browserConsoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') result.browserConsoleErrors.push(`console: ${message.text()}`);
  });

  await page.addInitScript(() => {
    try { localStorage.clear(); } catch { /* origin storage may not be available on the first document */ }

    const NativeAudioContext = window.AudioContext;
    const contexts = [];
    const syntheticContexts = [];
    const makeSoftwareContext = (context) => {
      const record = { context, destinationRerouted: false, sinkIdNone: false, sinkError: null };
      try {
        const silentDestination = context.createMediaStreamDestination();
        Object.defineProperty(context, 'destination', {
          configurable: true,
          get: () => silentDestination,
        });
        record.destinationRerouted = context.destination === silentDestination;
        record.silentDestination = silentDestination;
      } catch (error) {
        record.destinationError = String(error);
      }

      if (typeof context.setSinkId === 'function') {
        record.sinkPromise = Promise.resolve(context.setSinkId({ type: 'none' }))
          .then(() => { record.sinkIdNone = true; })
          .catch((error) => { record.sinkError = String(error); });
      } else {
        record.sinkPromise = Promise.resolve();
      }
      contexts.push(record);
      return record;
    };

    window.__webrcSoftwareContexts = contexts;
    window.__webrcSyntheticContexts = syntheticContexts;
    window.AudioContext = new Proxy(NativeAudioContext, {
      construct(target, args, newTarget) {
        const options = args[0] && typeof args[0] === 'object' ? args[0] : {};
        let context;
        try {
          context = Reflect.construct(target, [{ ...options, sinkId: { type: 'none' } }], newTarget);
        } catch {
          context = Reflect.construct(target, [options], newTarget);
        }
        makeSoftwareContext(context);
        return context;
      },
    });

    const syntheticMediaDevices = navigator.mediaDevices;
    const originalGetUserMedia = syntheticMediaDevices.getUserMedia.bind(syntheticMediaDevices);
    Object.defineProperty(syntheticMediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints) => {
        const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
        const contextRecord = contexts[contexts.length - 1];
        const oscillator = context.createOscillator();
        const level = context.createGain();
        const streamDestination = context.createMediaStreamDestination();
        oscillator.frequency.value = 220;
        level.gain.value = 0.025;
        oscillator.connect(level);
        level.connect(streamDestination);
        await context.resume();
        oscillator.start();
        syntheticContexts.push({ context, oscillator, level, streamDestination, constraints, contextRecord });
        return streamDestination.stream;
      },
    });
    window.__webrcOriginalGetUserMedia = originalGetUserMedia;
  });

  await page.goto(`${baseUrl}/?audio=browser`, { waitUntil: 'networkidle' });
  result.crossOriginIsolated = await page.evaluate(() => window.crossOriginIsolated);
  result.sharedArrayBufferAvailable = await page.evaluate(() => typeof SharedArrayBuffer !== 'undefined');

  if (!result.crossOriginIsolated || !result.sharedArrayBufferAvailable) {
    throw new Error('The real Chromium page did not receive COOP/COEP isolation and SharedArrayBuffer.');
  }

  let readyState;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    readyState = await page.evaluate(async () => {
      const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
      const engine = AudioEngine.getInstance();
      const status = engine.getUiStatus();
      return { ready: status.ready, lastError: status.lastError, message: status.message };
    });
    if (readyState.ready || readyState.lastError) break;
    await page.waitForTimeout(100);
  }
  result.engineStatus = readyState;
  if (!readyState?.ready) throw new Error(`BrowserAudioEngine did not become ready: ${readyState?.lastError || 'timeout'}`);

  const smoke = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const engine = AudioEngine.getInstance();
    const audio = engine.browser;
    const checks = [];
    const assert = (name, condition, details = {}) => {
      checks.push({ name, passed: Boolean(condition), ...details });
      if (!condition) throw new Error(`${name} failed: ${JSON.stringify(details)}`);
    };
    const waitFor = async (predicate, name, timeoutMs = 5_000) => {
      const until = performance.now() + timeoutMs;
      while (performance.now() < until) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`${name} timed out.`);
    };
    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const copyMetrics = () => {
      const metrics = engine.getRealtimeMetrics();
      return metrics ? JSON.parse(JSON.stringify(metrics)) : null;
    };
    const contextSafety = () => window.__webrcSoftwareContexts.map((record) => ({
      destinationRerouted: record.destinationRerouted,
      sinkIdNone: record.sinkIdNone,
      sinkError: record.sinkError,
      destinationError: record.destinationError || null,
      contextSampleRate: record.context.sampleRate,
      contextSinkId: record.context.sinkId ?? null,
    }));

    const result = { assertions: checks, status: 'RUNNING' };
    try {
      await Promise.all(window.__webrcSoftwareContexts.map((record) => record.sinkPromise));
      const safety = contextSafety();
      assert('all audio output is redirected away from physical devices',
        safety.length >= 2 && safety.every((record) => record.destinationRerouted || record.sinkIdNone),
        { contexts: safety });

      assert('browser realtime engine is initialized', audio.isReady && audio.realtimeRuntime !== null);
      const initialMetrics = copyMetrics();
      assert('48 kHz / 128-frame AudioWorklet backend',
        initialMetrics.sampleRate === 48_000 && initialMetrics.quantumFrames === 128 && initialMetrics.backendMode === 'sab-worklet',
        { metrics: initialMetrics });
      assert('all five tracks have preallocated loop storage',
        initialMetrics.trackCapacityFrames.length === 5 && initialMetrics.trackCapacityFrames.every((frames) => frames > 0),
        { capacities: initialMetrics.trackCapacityFrames });
      const ioSnapshot = engine.getBrowserIoSnapshot();
      assert('browser loop recording/playback channel limit is explicit',
        ioSnapshot.loopRecordingChannelCount === 1 &&
        ioSnapshot.loopPlaybackOutputChannelCount === 2 &&
        ioSnapshot.loopChannelLayout === 'mono input downmix, duplicated to stereo playback',
        { loopRecordingChannelCount: ioSnapshot.loopRecordingChannelCount, loopPlaybackOutputChannelCount: ioSnapshot.loopPlaybackOutputChannelCount, loopChannelLayout: ioSnapshot.loopChannelLayout });
      assert('AudioEngine reports the software-only sink type', ioSnapshot.outputSinkType === 'none',
        { outputSinkType: ioSnapshot.outputSinkType });

      // Reconnect both production output branches to software-only taps before triggering any sound.
      audio.masterGainNode.disconnect();
      const masterTap = audio.context.createMediaStreamDestination();
      const masterAnalyser = audio.context.createAnalyser();
      masterAnalyser.fftSize = 2048;
      audio.masterGainNode.connect(masterAnalyser);
      masterAnalyser.connect(masterTap);
      const masterSamples = new Float32Array(masterAnalyser.fftSize);
      const masterRms = () => {
        masterAnalyser.getFloatTimeDomainData(masterSamples);
        let sum = 0;
        for (let index = 0; index < masterSamples.length; index += 1) sum += masterSamples[index] * masterSamples[index];
        return Math.sqrt(sum / masterSamples.length);
      };
      const monitorGain = audio.monitorGainNode;
      monitorGain.disconnect();
      const monitorAnalyser = audio.context.createAnalyser();
      monitorAnalyser.fftSize = 2048;
      const monitorTap = audio.context.createMediaStreamDestination();
      monitorGain.connect(monitorAnalyser);
      monitorAnalyser.connect(monitorTap);
      const monitorSamples = new Float32Array(monitorAnalyser.fftSize);
      const monitorRms = () => {
        monitorAnalyser.getFloatTimeDomainData(monitorSamples);
        let sum = 0;
        for (let index = 0; index < monitorSamples.length; index += 1) sum += monitorSamples[index] * monitorSamples[index];
        return Math.sqrt(sum / monitorSamples.length);
      };

      assert('record path starts with software monitor disabled', !initialMetrics.outputMonitorEnabled);
      audio.setMonitoring(true);
      await waitFor(() => copyMetrics().outputMonitorEnabled, 'monitor-on acknowledgement');
      let activeMonitorRms = 0;
      await waitFor(() => (activeMonitorRms = monitorRms()) > 0.001, 'synthetic live monitor signal');
      assert('monitor ON carries synthetic input through the persistent Worklet', activeMonitorRms > 0.001,
        { monitorRms: activeMonitorRms });
      audio.setMonitoring(false);
      await waitFor(() => !copyMetrics().outputMonitorEnabled, 'monitor-off acknowledgement');
      await sleep(100);
      const mutedMonitorRms = monitorRms();
      assert('monitor OFF is silent at its sample-gated output', mutedMonitorRms < 0.00001,
        { monitorRms: mutedMonitorRms });

      const tracks = engine.tracks;
      const trackResults = [];
      for (let index = 0; index < 5; index += 1) {
        const track = tracks[index];
        await track.startRecording();
        await waitFor(() => track.state === 'RECORDING', `track ${index + 1} record start`);
        await sleep(120);
        await track.stopRecording(true);
        await waitFor(() => track.state === 'PLAYING', `track ${index + 1} record stop`);
        const loopFrames = copyMetrics().loopFrames[index];
        const audioBuffer = await track.exportAudioBuffer();
        const samples = audioBuffer.getChannelData(0);
        let squareSum = 0;
        for (let sample = 0; sample < samples.length; sample += 1) squareSum += samples[sample] * samples[sample];
        const rms = Math.sqrt(squareSum / Math.max(1, samples.length));
        assert(`track ${index + 1} records and loops non-silent samples`, loopFrames > 0 && rms > 0.001,
          { loopFrames, exportedFrames: samples.length, rms });
        trackResults.push({ track: index + 1, loopFrames, exportedRms: rms });
      }

      const track0 = tracks[0];
      const beforeOverdub = await track0.exportAudioBuffer();
      const beforeSamples = beforeOverdub.getChannelData(0);
      const beforeCopy = new Float32Array(beforeSamples);
      track0.triggerRecord();
      await waitFor(() => track0.state === 'OVERDUBBING', 'track 1 overdub start');
      await sleep(120);
      track0.triggerRecord();
      await waitFor(() => track0.state === 'PLAYING', 'track 1 overdub stop');
      const afterOverdub = await track0.exportAudioBuffer();
      const afterSamples = afterOverdub.getChannelData(0);
      let changedSamples = 0;
      for (let sample = 0; sample < Math.min(beforeCopy.length, afterSamples.length); sample += 1) {
        if (Math.abs(beforeCopy[sample] - afterSamples[sample]) > 1e-5) changedSamples += 1;
      }
      assert('overdub runs inside persistent loop storage', changedSamples > 0,
        { changedSamples, loopFrames: afterSamples.length });

      await tracks[4].clear();
      await waitFor(() => copyMetrics().loopFrames[4] === 0 && tracks[4].state === 'EMPTY', 'track 5 clear acknowledgement');
      const clearedMetrics = copyMetrics();
      assert('clear releases the loop state without reallocating track storage',
        clearedMetrics.loopFrames[4] === 0 && clearedMetrics.trackCapacityFrames[4] === initialMetrics.trackCapacityFrames[4],
        { loopFrames: clearedMetrics.loopFrames[4], capacityFrames: clearedMetrics.trackCapacityFrames[4] });

      engine.setFxType('track', 0, 'FILTER');
      engine.setFxActive('track', 0, true);
      engine.setFxParam('track', 0, 100);
      await sleep(100);
      const filterHighCutoffRms = masterRms();
      engine.setFxParam('track', 0, 1);
      await sleep(100);
      const filterLowCutoffRms = masterRms();
      assert('dynamic Filter UI endpoint 100 maps to the normalized 20 kHz endpoint',
        filterHighCutoffRms > 0.002 && filterHighCutoffRms > filterLowCutoffRms * 4,
        { filterHighCutoffRms, filterLowCutoffRms, ratio: filterHighCutoffRms / Math.max(filterLowCutoffRms, 1e-9) });

      audio.setLatency(8);
      const calibratedBeforeSwitchMs = audio.getLatencyInfo().roundTripLatencyMs;
      const routeCalibrationLatency = engine.getLatencyInfo();
      assert('unverified browser route calibration is not reported as physical round-trip',
        routeCalibrationLatency.roundTripLatencyMs === 8 && routeCalibrationLatency.physicalRoundTripMs === null,
        { roundTripLatencyMs: routeCalibrationLatency.roundTripLatencyMs, physicalRoundTripMs: routeCalibrationLatency.physicalRoundTripMs, note: routeCalibrationLatency.roundTripLatencyNote });
      await audio.setInputDevice('smoke-synthetic-input-b');
      const calibratedAfterSwitchMs = audio.getLatencyInfo().roundTripLatencyMs;
      assert('input device change invalidates device-scoped latency calibration',
        calibratedBeforeSwitchMs === 8 && calibratedAfterSwitchMs === null,
        { calibratedBeforeSwitchMs, calibratedAfterSwitchMs, selectedInputDeviceId: audio.selectedInputDeviceId });

      await waitFor(() => copyMetrics().renderedFrame > initialMetrics.renderedFrame + 20_000, 'Worklet sample clock advance');
      result.status = 'PASS';
      result.contextSampleRate = audio.context.sampleRate;
      result.contextState = audio.context.state;
      result.contextSafety = contextSafety();
      result.initialMetrics = initialMetrics;
      result.finalMetrics = copyMetrics();
      result.ioSnapshot = engine.getBrowserIoSnapshot();
      result.latencyInfo = engine.getLatencyInfo();
      result.trackResults = trackResults;
      result.changedOverdubSamples = changedSamples;
      result.filterOutputRms = { ui100: filterHighCutoffRms, ui1: filterLowCutoffRms };
      result.monitorOnRms = activeMonitorRms;
      result.monitorOffRms = mutedMonitorRms;
      result.calibration = { beforeDeviceSwitchMs: calibratedBeforeSwitchMs, afterDeviceSwitchMs: calibratedAfterSwitchMs };
      result.softwareTaps = { masterStreamTracks: masterTap.stream.getAudioTracks().length, monitorStreamTracks: monitorTap.stream.getAudioTracks().length };
    } catch (error) {
      result.status = 'FAIL';
      result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      result.contextSafety = contextSafety();
      result.metricsAtFailure = copyMetrics();
      result.ioSnapshot = engine.getBrowserIoSnapshot();
      result.latencyInfo = engine.getLatencyInfo();
    }
    return result;
  });

  result.assertions = smoke.assertions;
  result.softwareSmoke = smoke;
  result.status = smoke.status;
  if (smoke.status !== 'PASS') browserError = smoke.error || 'Software smoke returned a failure.';
} catch (error) {
  result.status = 'FAIL';
  result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  browserError = result.error;
} finally {
  if (browserError) result.error ??= browserError;
  result.completedAt = new Date().toISOString();
  if (page) {
    try {
      const contextData = await page.evaluate(() => ({
        contexts: (window.__webrcSoftwareContexts || []).map((record) => ({
          destinationRerouted: record.destinationRerouted,
          sinkIdNone: record.sinkIdNone,
          sinkError: record.sinkError,
          destinationError: record.destinationError || null,
          sampleRate: record.context.sampleRate,
          sinkId: record.context.sinkId ?? null,
        })),
        syntheticInputContextCount: (window.__webrcSyntheticContexts || []).length,
      }));
      result.softwareContexts ??= contextData.contexts;
      result.syntheticInputContextCount ??= contextData.syntheticInputContextCount;
    } catch { /* the page may never have loaded */ }
  }
  if (browser) await browser.close();
  await server.close();
  const safeTimestamp = startedAt.replace(/[:.]/g, '-');
  result.outputFile = join(process.env.TEMP || tmpdir(), `webrc505-browser-realtime-smoke-${safeTimestamp}.json`);
  writeFileSync(result.outputFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ status: result.status, outputFile: result.outputFile, error: result.error || null }));
}

if (browserError) process.exitCode = 1;
