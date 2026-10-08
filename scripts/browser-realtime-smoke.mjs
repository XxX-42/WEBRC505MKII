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
        const requestedDeviceId = constraints?.audio?.deviceId?.exact ?? constraints?.audio?.deviceId?.ideal ?? '';
        const mono = requestedDeviceId === 'smoke-mono-input';
        const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
        const contextRecord = contexts[contexts.length - 1];
        const streamDestination = context.createMediaStreamDestination();
        streamDestination.channelCount = mono ? 1 : 2;
        streamDestination.channelCountMode = 'explicit';
        const sources = [];
        if (mono) {
          const oscillator = context.createOscillator();
          const level = context.createGain();
          oscillator.frequency.value = 220;
          level.gain.value = 0.02;
          oscillator.connect(level);
          level.connect(streamDestination);
          sources.push({ oscillator, level, frequencyHz: 220, channel: 'mono' });
        } else {
          const merger = context.createChannelMerger(2);
          const leftOscillator = context.createOscillator();
          const leftLevel = context.createGain();
          leftOscillator.frequency.value = 250;
          leftLevel.gain.value = 0.025;
          leftOscillator.connect(leftLevel);
          leftLevel.connect(merger, 0, 0);

          const rightOscillator = context.createOscillator();
          const rightLevel = context.createGain();
          rightOscillator.frequency.value = 500;
          rightLevel.gain.value = 0.02;
          rightOscillator.connect(rightLevel);
          rightLevel.connect(merger, 0, 1);
          merger.connect(streamDestination);
          sources.push(
            { oscillator: leftOscillator, level: leftLevel, frequencyHz: 250, channel: 'left' },
            { oscillator: rightOscillator, level: rightLevel, frequencyHz: 500, channel: 'right' },
          );
        }
        await context.resume();
        for (const source of sources) source.oscillator.start();
        syntheticContexts.push({ context, sources, streamDestination, constraints, requestedDeviceId, mono, contextRecord });
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
        ioSnapshot.loopRecordingChannelCount === 2 &&
        ioSnapshot.loopPlaybackOutputChannelCount === 2 &&
        ioSnapshot.loopChannelLayout === 'stereo planar LR; stereo input preserved and mono input duplicated to LR',
        { loopRecordingChannelCount: ioSnapshot.loopRecordingChannelCount, loopPlaybackOutputChannelCount: ioSnapshot.loopPlaybackOutputChannelCount, loopChannelLayout: ioSnapshot.loopChannelLayout });
      assert('AudioEngine reports the software-only sink type', ioSnapshot.outputSinkType === 'none',
        { outputSinkType: ioSnapshot.outputSinkType });

      // Reconnect both production output branches to software-only taps before triggering any sound.
      audio.masterGainNode.disconnect();
      const masterTap = audio.context.createMediaStreamDestination();
      const masterSplitter = audio.context.createChannelSplitter(2);
      const masterAnalyserLeft = audio.context.createAnalyser();
      const masterAnalyserRight = audio.context.createAnalyser();
      masterAnalyserLeft.fftSize = 8192;
      masterAnalyserRight.fftSize = 8192;
      audio.masterGainNode.connect(masterSplitter);
      masterSplitter.connect(masterAnalyserLeft, 0, 0);
      masterSplitter.connect(masterAnalyserRight, 1, 0);
      masterAnalyserLeft.connect(masterTap);
      const masterSamplesLeft = new Float32Array(masterAnalyserLeft.fftSize);
      const masterSamplesRight = new Float32Array(masterAnalyserRight.fftSize);
      const masterChannels = () => {
        masterAnalyserLeft.getFloatTimeDomainData(masterSamplesLeft);
        masterAnalyserRight.getFloatTimeDomainData(masterSamplesRight);
        return [masterSamplesLeft, masterSamplesRight];
      };
      const masterRms = () => {
        const [left, right] = masterChannels();
        let sum = 0;
        for (let index = 0; index < left.length; index += 1) {
          sum += left[index] * left[index] + right[index] * right[index];
        }
        return Math.sqrt(sum / (2 * left.length));
      };
      const toneMagnitude = (samples, frequencyHz) => {
        let real = 0;
        let imaginary = 0;
        for (let index = 0; index < samples.length; index += 1) {
          const phase = 2 * Math.PI * frequencyHz * index / audio.context.sampleRate;
          real += samples[index] * Math.cos(phase);
          imaginary -= samples[index] * Math.sin(phase);
        }
        return 2 * Math.hypot(real, imaginary) / samples.length;
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
        const channelRms = [0, 1].map((channel) => {
          const samples = audioBuffer.getChannelData(channel);
          let squareSum = 0;
          for (let sample = 0; sample < samples.length; sample += 1) squareSum += samples[sample] * samples[sample];
          return Math.sqrt(squareSum / Math.max(1, samples.length));
        });
        assert(`track ${index + 1} exports two active planar LR channels`,
          audioBuffer.numberOfChannels === 2 && loopFrames > 0 && channelRms[0] > 0.001 && channelRms[1] > 0.001,
          { loopFrames, exportedFrames: audioBuffer.length, numberOfChannels: audioBuffer.numberOfChannels, channelRms });
        if (index === 0) {
          const left = audioBuffer.getChannelData(0);
          const right = audioBuffer.getChannelData(1);
          const left250 = toneMagnitude(left, 250);
          const left500 = toneMagnitude(left, 500);
          const right250 = toneMagnitude(right, 250);
          const right500 = toneMagnitude(right, 500);
          assert('exported channel 0 keeps the 250 Hz left tone and rejects 500 Hz right leakage',
            left250 > left500 * 5,
            { left250, left500, leakageRatio: left500 / Math.max(left250, 1e-9) });
          assert('exported channel 1 keeps the 500 Hz right tone and rejects 250 Hz left leakage',
            right500 > right250 * 5,
            { right250, right500, leakageRatio: right250 / Math.max(right500, 1e-9) });
        }
        trackResults.push({ track: index + 1, loopFrames, numberOfChannels: audioBuffer.numberOfChannels, channelRms });
      }

      // Keep only one recorded loop active so the output frequency test exercises the
      // production track FX -> gain -> centered StereoPanner -> master route in isolation.
      for (let index = 1; index < 5; index += 1) await tracks[index].clear();
      await sleep(100);
      const [masterLeft, masterRight] = masterChannels();
      const playbackTones = {
        left250: toneMagnitude(masterLeft, 250),
        left500: toneMagnitude(masterLeft, 500),
        right250: toneMagnitude(masterRight, 250),
        right500: toneMagnitude(masterRight, 500),
      };
      assert('centered stereo playback preserves left/right frequency separation through the master output',
        playbackTones.left250 > playbackTones.left500 * 5 && playbackTones.right500 > playbackTones.right250 * 5,
        { playbackTones });

      const track0 = tracks[0];
      const beforeOverdub = await track0.exportAudioBuffer();
      const beforeSamples = beforeOverdub.getChannelData(0);
      const beforeCopy = new Float32Array(beforeSamples);
      const beforeRightCopy = new Float32Array(beforeOverdub.getChannelData(1));
      track0.triggerRecord();
      await waitFor(() => track0.state === 'OVERDUBBING', 'track 1 overdub start');
      await sleep(120);
      track0.triggerRecord();
      await waitFor(() => track0.state === 'PLAYING', 'track 1 overdub stop');
      const afterOverdub = await track0.exportAudioBuffer();
      const afterSamples = afterOverdub.getChannelData(0);
      const afterRightSamples = afterOverdub.getChannelData(1);
      let changedSamples = 0;
      for (let sample = 0; sample < Math.min(beforeCopy.length, afterSamples.length); sample += 1) {
        if (Math.abs(beforeCopy[sample] - afterSamples[sample]) > 1e-5) changedSamples += 1;
      }
      let changedRightSamples = 0;
      for (let sample = 0; sample < Math.min(beforeRightCopy.length, afterRightSamples.length); sample += 1) {
        if (Math.abs(beforeRightCopy[sample] - afterRightSamples[sample]) > 1e-5) changedRightSamples += 1;
      }
      assert('overdub updates both planar channels inside persistent loop storage', changedSamples > 0 && changedRightSamples > 0,
        { changedSamples, changedRightSamples, loopFrames: afterSamples.length });

      await tracks[4].clear();
      await waitFor(() => copyMetrics().loopFrames[4] === 0 && tracks[4].state === 'EMPTY', 'track 5 clear acknowledgement');
      const clearedMetrics = copyMetrics();
      assert('clear releases the loop state without reallocating track storage',
        clearedMetrics.loopFrames[4] === 0 && clearedMetrics.trackCapacityFrames[4] === initialMetrics.trackCapacityFrames[4],
        { loopFrames: clearedMetrics.loopFrames[4], capacityFrames: clearedMetrics.trackCapacityFrames[4] });

      audio.setLatency(8);
      const calibratedBeforeSwitchMs = audio.getLatencyInfo().roundTripLatencyMs;
      const routeCalibrationLatency = engine.getLatencyInfo();
      assert('unverified browser route calibration is not reported as physical round-trip',
        routeCalibrationLatency.roundTripLatencyMs === 8 && routeCalibrationLatency.physicalRoundTripMs === null,
        { roundTripLatencyMs: routeCalibrationLatency.roundTripLatencyMs, physicalRoundTripMs: routeCalibrationLatency.physicalRoundTripMs, note: routeCalibrationLatency.roundTripLatencyNote });
      await audio.setInputDevice('smoke-mono-input');
      const calibratedAfterSwitchMs = audio.getLatencyInfo().roundTripLatencyMs;
      assert('input device change invalidates device-scoped latency calibration',
        calibratedBeforeSwitchMs === 8 && calibratedAfterSwitchMs === null,
        { calibratedBeforeSwitchMs, calibratedAfterSwitchMs, selectedInputDeviceId: audio.selectedInputDeviceId });

      await tracks[4].startRecording();
      await waitFor(() => tracks[4].state === 'RECORDING', 'mono source track 5 record start');
      await sleep(120);
      await tracks[4].stopRecording(true);
      await waitFor(() => tracks[4].state === 'PLAYING', 'mono source track 5 record stop');
      const monoCompatBuffer = await tracks[4].exportAudioBuffer();
      const monoLeft = monoCompatBuffer.getChannelData(0);
      const monoRight = monoCompatBuffer.getChannelData(1);
      let monoChannelMaxDifference = 0;
      for (let sample = 0; sample < monoLeft.length; sample += 1) {
        monoChannelMaxDifference = Math.max(monoChannelMaxDifference, Math.abs(monoLeft[sample] - monoRight[sample]));
      }
      assert('mono capture remains a separate supported path and duplicates into both loop channels',
        monoCompatBuffer.numberOfChannels === 2 && monoLeft.length > 0 && monoChannelMaxDifference < 1e-7,
        { numberOfChannels: monoCompatBuffer.numberOfChannels, frames: monoCompatBuffer.length, monoChannelMaxDifference,
          inputChannelCount: engine.getBrowserIoSnapshot().inputChannelCount });

      // Isolate a known mono 220 Hz loop so the earlier stereo playback test's
      // different frequencies do not bias this existing normalized Filter check.
      await tracks[0].clear();
      await waitFor(() => copyMetrics().loopFrames[0] === 0, 'clear stereo source before Filter check');
      engine.setFxType('track', 0, 'FILTER');
      engine.setFxActive('track', 0, true);
      engine.setFxParam('track', 0, 100);
      // The analyser window is 8192 frames (~171 ms), and the Filter frequency
      // parameter is smoothed. Wait longer than the full window plus settling so
      // the second reading cannot contain the previous cutoff's samples.
      await sleep(300);
      const filterHighCutoffRms = masterRms();
      engine.setFxParam('track', 0, 1);
      await sleep(300);
      const filterLowCutoffRms = masterRms();
      assert('dynamic Filter UI endpoint 100 maps to the normalized 20 kHz endpoint',
        filterHighCutoffRms > 0.002 && filterHighCutoffRms > filterLowCutoffRms * 4,
        { filterHighCutoffRms, filterLowCutoffRms, ratio: filterHighCutoffRms / Math.max(filterLowCutoffRms, 1e-9) });

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
      result.stereoPlayback = playbackTones;
      result.changedOverdubSamples = changedSamples;
      result.changedOverdubRightSamples = changedRightSamples;
      result.monoCompatibility = { frames: monoCompatBuffer.length, maxChannelDifference: monoChannelMaxDifference };
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
        syntheticInputLayouts: (window.__webrcSyntheticContexts || []).map((record) => ({
          requestedDeviceId: record.requestedDeviceId,
          mono: record.mono,
          sourceChannels: record.streamDestination.channelCount,
          trackSettings: record.streamDestination.stream.getAudioTracks()[0]?.getSettings?.() || null,
        })),
      }));
      result.softwareContexts ??= contextData.contexts;
      result.syntheticInputContextCount ??= contextData.syntheticInputContextCount;
      result.syntheticInputLayouts ??= contextData.syntheticInputLayouts;
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
