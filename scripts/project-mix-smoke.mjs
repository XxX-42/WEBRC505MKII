import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const host = '127.0.0.1';
const startedAt = new Date().toISOString();
const outputPath = join(tmpdir(), `webrc-project-mix-smoke-${Date.now()}.json`);
const result = {
  startedAt,
  softwareOnly: true,
  hardwareCertified: false,
  status: 'RUNNING',
  assertions: [],
  browserConsoleErrors: [],
  note: 'Actual Chromium BrowserAudioEngine, ProjectService, BrowserProjectAdapter, shared time-stretch core and registered FX graphs; synthetic input only, all physical audio outputs muted or redirected.',
  repro: 'node scripts/project-mix-smoke.mjs',
};

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { host, port: 0, strictPort: false, hmr: false },
  logLevel: 'warn',
});

let browser;
let page;

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
    try { localStorage.clear(); } catch { /* first-origin storage may not be ready */ }

    const NativeAudioContext = window.AudioContext;
    const contexts = [];
    const syntheticContexts = [];
    const muteDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
    if (muteDescriptor?.get && muteDescriptor?.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
        configurable: true,
        enumerable: muteDescriptor.enumerable,
        get() { return muteDescriptor.get.call(this); },
        set() { muteDescriptor.set.call(this, true); },
      });
      const forceMute = (element) => {
        if (element instanceof HTMLMediaElement) muteDescriptor.set.call(element, true);
      };
      const muteInsertedMedia = (node) => {
        forceMute(node);
        if (node instanceof Element) node.querySelectorAll('audio,video').forEach(forceMute);
      };
      const mediaObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) mutation.addedNodes.forEach(muteInsertedMedia);
      });
      mediaObserver.observe(document, { childList: true, subtree: true });
      const originalPlay = HTMLMediaElement.prototype.play;
      if (originalPlay) {
        HTMLMediaElement.prototype.play = function (...args) {
          forceMute(this);
          return originalPlay.apply(this, args);
        };
      }
    }

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

    window.__webrcProjectMixContexts = contexts;
    window.__webrcProjectMixSyntheticContexts = syntheticContexts;
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

    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
        const record = contexts[contexts.length - 1];
        const output = context.createMediaStreamDestination();
        output.channelCount = 2;
        output.channelCountMode = 'explicit';
        const merger = context.createChannelMerger(2);
        const left = context.createOscillator();
        const leftGain = context.createGain();
        left.frequency.value = 250;
        leftGain.gain.value = 0.02;
        left.connect(leftGain);
        leftGain.connect(merger, 0, 0);
        const right = context.createOscillator();
        const rightGain = context.createGain();
        right.frequency.value = 500;
        rightGain.gain.value = 0.018;
        right.connect(rightGain);
        rightGain.connect(merger, 0, 1);
        merger.connect(output);
        await context.resume();
        left.start();
        right.start();
        syntheticContexts.push({ context, output, record, sources: [left, right] });
        return output.stream;
      },
    });
  });

  await page.goto(`${baseUrl}/?audio=browser`, { waitUntil: 'networkidle' });
  result.crossOriginIsolated = await page.evaluate(() => window.crossOriginIsolated);
  result.sharedArrayBufferAvailable = await page.evaluate(() => typeof SharedArrayBuffer !== 'undefined');
  if (!result.crossOriginIsolated || !result.sharedArrayBufferAvailable) {
    throw new Error('Chromium did not receive COOP/COEP isolation and SharedArrayBuffer support.');
  }

  let status;
  const readyDeadline = Date.now() + 30_000;
  while (Date.now() < readyDeadline) {
    status = await page.evaluate(async () => {
      const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
      const engine = AudioEngine.getInstance();
      const ui = engine.getUiStatus();
      return { ready: ui.ready, mode: ui.mode, lastError: ui.lastError, message: ui.message };
    });
    if (status.ready || status.lastError) break;
    await page.waitForTimeout(100);
  }
  result.engineStatus = status;
  if (!status?.ready || status.mode !== 'browser') {
    throw new Error(`Browser audio did not initialize: ${status?.lastError || status?.message || 'timeout'}`);
  }

  result.smoke = await page.evaluate(async () => {
    const assertions = [];
    const samples = {};
    window.__webrcProjectMixAssertions = assertions;
    window.__webrcProjectMixSamples = samples;
    const add = (name, condition, details = {}) => {
      assertions.push({ name, passed: Boolean(condition), details });
      if (!condition) throw new Error(`${name}: ${JSON.stringify(details)}`);
    };
    const metrics = (buffer) => {
      if (!buffer) return null;
      const channels = Math.min(buffer.numberOfChannels, 2);
      const result = { frames: buffer.length, sampleRate: buffer.sampleRate, numberOfChannels: buffer.numberOfChannels, channels: [] };
      for (let channel = 0; channel < channels; channel += 1) {
        const data = buffer.getChannelData(channel);
        let square = 0;
        let peak = 0;
        let hash = 2166136261;
        const bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
        for (let i = 0; i < data.length; i += 1) {
          const value = data[i];
          square += value * value;
          peak = Math.max(peak, Math.abs(value));
          hash ^= bits[i];
          hash = Math.imul(hash, 16777619);
        }
        result.channels.push({ rms: Math.sqrt(square / Math.max(1, data.length)), peak, hash: (hash >>> 0).toString(16).padStart(8, '0') });
      }
      return result;
    };
    const addBuffers = (left, right) => {
      const length = Math.min(left.length, right.length);
      const sum = new Float32Array(length);
      for (let i = 0; i < length; i += 1) sum[i] = left[i] + right[i];
      return sum;
    };
    const estimateFrequency = (data, sampleRate, startFrame = 2048, endFrame = data.length - 2048) => {
      const start = Math.max(1, Math.min(data.length - 1, startFrame));
      const end = Math.max(start + 2, Math.min(data.length - 1, endFrame));
      const crossings = [];
      for (let i = start + 1; i < end; i += 1) {
        const previous = data[i - 1];
        const current = data[i];
        if (previous <= 0 && current > 0) {
          const fraction = -previous / (current - previous);
          crossings.push(i - 1 + fraction);
        }
      }
      if (crossings.length < 4) return 0;
      return (crossings.length - 1) * sampleRate / (crossings[crossings.length - 1] - crossings[0]);
    };
    const selectedFrequencyMagnitude = (data, sampleRate, frequency, startFrame = 2048, requestedFrames = 16_384) => {
      const length = Math.min(requestedFrames, data.length - startFrame);
      if (length < 16) return 0;
      let real = 0;
      let imaginary = 0;
      for (let i = 0; i < length; i += 1) {
        const angle = (2 * Math.PI * frequency * i) / sampleRate;
        const sample = data[startFrame + i];
        real += sample * Math.cos(angle);
        imaginary -= sample * Math.sin(angle);
      }
      return Math.hypot(real, imaginary) / length;
    };
    const createToneBuffer = (context, frames, leftHz, rightHz, leftAmp = 0.32, rightAmp = 0.23) => {
      const buffer = context.createBuffer(2, frames, context.sampleRate);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let i = 0; i < frames; i += 1) {
        left[i] = leftAmp * Math.sin(2 * Math.PI * leftHz * i / context.sampleRate);
        right[i] = rightAmp * Math.sin(2 * Math.PI * rightHz * i / context.sampleRate);
      }
      return buffer;
    };
    const createRampBuffer = (context, frames) => {
      const buffer = context.createBuffer(2, frames, context.sampleRate);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let i = 0; i < frames; i += 1) {
        const value = 0.1 + 0.7 * i / Math.max(1, frames - 1);
        left[i] = value;
        right[i] = value;
      }
      return buffer;
    };
    const digestTrack = async (track) => metrics(await track.exportAudioBuffer());
    const closeEnough = (a, b, threshold) => {
      if (!a || !b || a.length !== b.length) return { ok: false, relativeError: Infinity };
      let errorSquare = 0;
      let referenceSquare = 0;
      for (let channel = 0; channel < 2; channel += 1) {
        const x = a.getChannelData(channel);
        const y = b.getChannelData(channel);
        for (let i = 0; i < x.length; i += 1) {
          const error = x[i] - y[i];
          errorSquare += error * error;
          referenceSquare += x[i] * x[i];
        }
      }
      const relativeError = Math.sqrt(errorSquare / Math.max(referenceSquare, 1e-20));
      return { ok: relativeError <= threshold, relativeError };
    };
    const engineModule = await import('/src/audio/AudioEngine.ts');
    const { BrowserProjectAdapter } = await import('/src/project/BrowserProjectAdapter.ts');
    const { ProjectMixRenderer } = await import('/src/project/projectMixRenderer.ts');
    const engine = engineModule.AudioEngine.getInstance();
    const browser = engine.browser;
    const service = engine.getProjectService();
    const contexts = window.__webrcProjectMixContexts;
    await Promise.all(contexts.map((entry) => entry.sinkPromise));
    const contextSafety = contexts.map((entry) => ({
      rerouted: entry.destinationRerouted,
      sinkIdNone: entry.sinkIdNone,
      sampleRate: entry.context.sampleRate,
      sinkError: entry.sinkError,
    }));
    add('all live AudioContexts are software-only and outputs are redirected',
      contextSafety.length >= 2 && contextSafety.every((entry) => entry.rerouted || entry.sinkIdNone), { contextSafety });
    add('AudioEngine uses ready BrowserAudioEngine and actual ProjectService',
      browser.isReady && service && engine.getMode() === 'browser', { ready: browser.isReady, mode: engine.getMode() });
    add('browser runtime runs at canonical 48 kHz', browser.context.sampleRate === 48_000, { sampleRate: browser.context.sampleRate });
    add('all HTML audio/video elements remain muted',
      [...document.querySelectorAll('audio,video')].every((element) => element.muted),
      { mediaElements: [...document.querySelectorAll('audio,video')].length });

    const sampleRate = browser.context.sampleRate;
    const frames = sampleRate;
    const tracks = engine.tracks;
    await tracks[0].importAudioBuffer(createToneBuffer(browser.context, frames, 250.3, 440.7));
    await tracks[1].importAudioBuffer(createToneBuffer(browser.context, frames, 337.1, 571.3, 0.24, 0.19));
    const originals = [await digestTrack(tracks[0]), await digestTrack(tracks[1])];
    const runtimeDefaults = tracks.slice(0, 2).map((track) => track.getRuntimeSettings());
    const mixerDefaults = browser.getMixerState();
    for (let index = 0; index < 2; index += 1) {
      await tracks[index].updateRuntimeSettings({
        speed: 1,
        reverse: false,
        keepPitch: false,
        tempoSyncEnabled: false,
        tempoSyncSpeed: 'NORMAL',
        tempoSyncMode: 'PITCH',
        recordBpm: null,
      });
    }
    let mixer = browser.getMixerState();
    mixer.masterLevel = 0.72;
    mixer.tracks[0].level = 1.25;
    mixer.tracks[0].pan = 0;
    mixer.tracks[1].level = 0.85;
    mixer.tracks[1].pan = 0;
    await browser.applyMixerState(mixer);

    const runBounce = async (targetTrackId, selectedTrackIds, durationFrames, realtime) => {
      const output = await service.bounceTrack(targetTrackId, { selectedTrackIds, durationFrames, realtime });
      const imported = await tracks[targetTrackId - 1].exportAudioBuffer();
      const samePcm = JSON.stringify(metrics(output)) === JSON.stringify(metrics(imported));
      add(`ProjectService ${realtime ? 'realtime' : 'offline'} bounce imports exact PCM into target ${targetTrackId}`,
        samePcm && output.length === durationFrames && output.numberOfChannels === 2 && output.sampleRate === sampleRate,
        { targetTrackId, selectedTrackIds, durationFrames, realtime, returned: metrics(output), imported: metrics(imported), samePcm });
      samples[`bounce-${realtime ? 'realtime' : 'offline'}-${selectedTrackIds.join('-')}`] = metrics(output);
      return output;
    };

    const dryOffline = await runBounce(3, [1, 2], frames, false);
    const dryRealtime = await runBounce(4, [1, 2], frames, true);
    const dryParity = closeEnough(dryOffline, dryRealtime, 0.06);
    const baselineMetrics = metrics(dryOffline);
    const stereoProbe = await service.renderBounce({ selectedTrackIds: [1], durationFrames: frames });
    const left = stereoProbe.getChannelData(0);
    const right = stereoProbe.getChannelData(1);
    const stereoFrequencies = {
      left250: estimateFrequency(left, sampleRate),
      right441: estimateFrequency(right, sampleRate),
      left250Magnitude: selectedFrequencyMagnitude(left, sampleRate, 250.3),
      left441Leakage: selectedFrequencyMagnitude(left, sampleRate, 440.7),
      right441Magnitude: selectedFrequencyMagnitude(right, sampleRate, 440.7),
      right250Leakage: selectedFrequencyMagnitude(right, sampleRate, 250.3),
    };
    add('actual two-track offline and realtime PCM agree and separate stereo probe retains distinct L/R sources',
      baselineMetrics.channels.every((channel) => channel.rms > 0.05) &&
      Math.abs(stereoFrequencies.left250 - 250.3) < 4 && Math.abs(stereoFrequencies.right441 - 440.7) < 4 &&
      stereoFrequencies.left250Magnitude > stereoFrequencies.left441Leakage * 4 &&
      stereoFrequencies.right441Magnitude > stereoFrequencies.right250Leakage * 4 && dryParity.ok,
      { baselineMetrics, stereoFrequencies, dryOfflineRealtimeRelativeError: dryParity.relativeError });

    const centerLevel = browser.getMixerState();
    centerLevel.tracks[1].level = 1;
    centerLevel.tracks[1].pan = 0;
    centerLevel.masterLevel = 0.8;
    await browser.applyMixerState(centerLevel);
    const gainReference = await service.renderBounce({ selectedTrackIds: [2], durationFrames: frames });
    const gainReferenceMetrics = metrics(gainReference);
    const reducedLevel = browser.getMixerState();
    reducedLevel.tracks[1].level = 0.5;
    reducedLevel.masterLevel = 0.4;
    await browser.applyMixerState(reducedLevel);
    const reducedGain = await service.renderBounce({ selectedTrackIds: [2], durationFrames: frames });
    const gainRatio = metrics(reducedGain).channels[0].rms / Math.max(gainReferenceMetrics.channels[0].rms, 1e-12);
    const panState = browser.getMixerState();
    panState.tracks[1].level = 1;
    panState.masterLevel = 0.8;
    panState.tracks[1].pan = -0.95;
    await browser.applyMixerState(panState);
    const hardLeft = await service.renderBounce({ selectedTrackIds: [2], durationFrames: frames });
    const panMetrics = metrics(hardLeft);
    const rightToLeft = panMetrics.channels[1].rms / Math.max(panMetrics.channels[0].rms, 1e-12);
    add('project track gain and master level affect actual rendered PCM', gainRatio > 0.20 && gainRatio < 0.30,
      { expectedRatio: 0.25, actualRatio: gainRatio, gainReferenceMetrics, reducedMetrics: metrics(reducedGain) });
    add('project track pan changes the rendered stereo balance', rightToLeft < 0.25,
      { pan: -0.95, rightToLeft, hardLeftMetrics: panMetrics });

    const normalMixer = browser.getMixerState();
    normalMixer.tracks[0].level = 1;
    normalMixer.tracks[0].pan = 0;
    normalMixer.tracks[1].level = 0;
    normalMixer.tracks[1].pan = 0;
    normalMixer.masterLevel = 1;
    await browser.applyMixerState(normalMixer);
    const trackOne = tracks[0];
    const frequencyCases = [];
    for (const speed of [0.5, 2]) {
      await trackOne.updateRuntimeSettings({ speed, reverse: false, keepPitch: false, tempoSyncEnabled: false, recordBpm: null });
      const buffer = await service.renderBounce({ selectedTrackIds: [1], durationFrames: frames });
      const leftHz = estimateFrequency(buffer.getChannelData(0), sampleRate);
      const rightHz = estimateFrequency(buffer.getChannelData(1), sampleRate);
      const expectedLeft = 250.3 * speed;
      const expectedRight = 440.7 * speed;
      const item = { speed, expectedLeft, expectedRight, measuredLeft: leftHz, measuredRight: rightHz, pcm: metrics(buffer) };
      frequencyCases.push(item);
      add(`manual speed ${speed} changes actual source pitch by the requested factor`,
        Math.abs(leftHz - expectedLeft) < expectedLeft * 0.035 && Math.abs(rightHz - expectedRight) < expectedRight * 0.035,
        item);
    }

    await trackOne.updateRuntimeSettings({ speed: 1.5, reverse: false, keepPitch: true, tempoSyncEnabled: false, recordBpm: null });
    const keepPitchBuffer = await service.renderBounce({ selectedTrackIds: [1], durationFrames: frames });
    const keepPitchLeft = estimateFrequency(keepPitchBuffer.getChannelData(0), sampleRate);
    const keepPitchRight = estimateFrequency(keepPitchBuffer.getChannelData(1), sampleRate);
    const keepPitchCase = { speed: 1.5, expectedLeftHz: 250.3, expectedRightHz: 440.7, measuredLeftHz: keepPitchLeft, measuredRightHz: keepPitchRight, pcm: metrics(keepPitchBuffer) };
    add('keep-pitch renderer preserves independent left/right fundamentals at variable speed',
      Math.abs(keepPitchLeft - 250.3) < 8 && Math.abs(keepPitchRight - 440.7) < 10,
      keepPitchCase);

    await engine.updateLoopSettings({ bpm: 240 });
    await trackOne.updateRuntimeSettings({
      speed: 0.5,
      reverse: false,
      keepPitch: false,
      tempoSyncEnabled: true,
      tempoSyncSpeed: 'DOUBLE',
      tempoSyncMode: 'PITCH',
      recordBpm: 120,
    });
    const tempoBuffer = await service.renderBounce({ selectedTrackIds: [1], durationFrames: frames });
    const tempoLeft = estimateFrequency(tempoBuffer.getChannelData(0), sampleRate);
    const tempoRight = estimateFrequency(tempoBuffer.getChannelData(1), sampleRate);
    const tempoCase = { globalBpm: engine.getLoopSettings().bpm, recordBpm: trackOne.getRuntimeSettings().recordBpm,
      manualSpeed: trackOne.getRuntimeSettings().speed, tempoSyncSpeed: trackOne.getRuntimeSettings().tempoSyncSpeed,
      expectedEffectiveSpeed: 2, measuredLeftHz: tempoLeft, measuredRightHz: tempoRight, pcm: metrics(tempoBuffer) };
    add('manual speed combines with live master tempo and track tempo factor in the actual renderer',
      tempoCase.globalBpm === 240 && Math.abs(tempoLeft - 500.6) < 18 && Math.abs(tempoRight - 881.4) < 30,
      tempoCase);
    await engine.updateLoopSettings({ bpm: 120 });

    await tracks[4].importAudioBuffer(createRampBuffer(browser.context, frames));
    await tracks[4].updateRuntimeSettings({ speed: 1, reverse: true, keepPitch: false, tempoSyncEnabled: false, recordBpm: null });
    const reversed = await service.renderBounce({ selectedTrackIds: [5], durationFrames: 4096 });
    const reversedLeft = reversed.getChannelData(0);
    const reverseMonotonic = reversedLeft[10] > reversedLeft[3000];
    add('reverse setting reverses imported source PCM in the actual offline renderer', reverseMonotonic,
      { firstSample: reversedLeft[0], sample10: reversedLeft[10], sample3000: reversedLeft[3000], pcm: metrics(reversed) });

    await tracks[4].importAudioBuffer(createToneBuffer(browser.context, frames, 337.1, 571.3, 0.82, 0.79));
    await tracks[4].updateRuntimeSettings({ speed: 1, reverse: false, keepPitch: false, tempoSyncEnabled: false, recordBpm: null });
    await tracks[0].updateRuntimeSettings({ speed: 1, reverse: false, keepPitch: false, tempoSyncEnabled: false, recordBpm: null });
    const preCompressor = await service.renderBounce({ selectedTrackIds: [1, 5], durationFrames: frames });
    const compressor = {
      type: 'COMPRESSOR',
      enabled: true,
      params: { thresholdDb: -24, ratio: 12, kneeDb: 30, attackSeconds: 0.003, releaseSeconds: 0.25 },
    };
    await engine.updateFxBankSlot('track', 0, compressor);
    await engine.setTrackFxSend(1, true);
    await engine.setTrackFxSend(5, true);
    const compressedMixOffline = await runBounce(3, [1, 5], frames, false);
    const compressedMixRealtime = await runBounce(4, [1, 5], frames, true);
    const compressorParity = closeEnough(compressedMixOffline, compressedMixRealtime, 0.18);
    const dryRms = metrics(preCompressor).channels[0].rms;
    const wetRms = metrics(compressedMixOffline).channels[0].rms;
    const soloOne = await service.renderBounce({ selectedTrackIds: [1], durationFrames: frames });
    const soloTwo = await service.renderBounce({ selectedTrackIds: [5], durationFrames: frames });
    const soloSumLeft = addBuffers(soloOne.getChannelData(0), soloTwo.getChannelData(0));
    const soloSumRight = addBuffers(soloOne.getChannelData(1), soloTwo.getChannelData(1));
    const mixLeft = compressedMixOffline.getChannelData(0);
    const mixRight = compressedMixOffline.getChannelData(1);
    let nonlinearError = 0;
    let nonlinearReference = 0;
    for (let i = 0; i < Math.min(mixLeft.length, soloSumLeft.length); i += 1) {
      const dl = mixLeft[i] - soloSumLeft[i];
      const dr = mixRight[i] - soloSumRight[i];
      nonlinearError += dl * dl + dr * dr;
      nonlinearReference += mixLeft[i] * mixLeft[i] + mixRight[i] * mixRight[i];
    }
    const nonlinearDifference = Math.sqrt(nonlinearError / Math.max(nonlinearReference, 1e-20));
    add('real TRACK bank Compressor is nonlinear after the two source sends are combined once',
      wetRms < dryRms * 0.7 && nonlinearDifference > 0.12 && compressorParity.ok,
      { dryRms, wetRms, wetToDryRatio: wetRms / Math.max(dryRms, 1e-12), nonlinearDifference,
        offlineRealtimeRelativeError: compressorParity.relativeError,
        wetOffline: metrics(compressedMixOffline), wetRealtime: metrics(compressedMixRealtime),
        sumOfSeparatelyCompressedSolos: { leftRms: Math.sqrt(soloSumLeft.reduce((sum, value) => sum + value * value, 0) / soloSumLeft.length),
          rightRms: Math.sqrt(soloSumRight.reduce((sum, value) => sum + value * value, 0) / soloSumRight.length) } });

    const adapter = new BrowserProjectAdapter(browser);
    const currentCapture = await adapter.captureProject();
    const audioByTrackId = new Map(currentCapture.audio.filter((entry) => entry.buffer).map((entry) => [entry.trackId, entry.buffer]));
    const negativeRenderer = new ProjectMixRenderer();
    let missingFxError = null;
    try {
      await negativeRenderer.renderOffline({
        context: browser.context,
        document: currentCapture.document,
        audioByTrackId,
        selectedTrackIds: [1, 5],
        durationFrames: 4096,
        createTrackFxGraph: (context, trackId, doc) => adapter.createTrackFxGraph(context, trackId, doc),
        createSelectedTrackFxGraph: async () => null,
        createMasterFxGraph: (context, doc) => adapter.createMasterFxGraph(context, doc),
      });
    } catch (error) {
      missingFxError = error instanceof Error ? error.message : String(error);
    }
    add('enabled shared FX with no real graph rejects instead of returning dry PCM',
      Boolean(missingFxError && missingFxError.includes('unavailable')),
      { missingFxError, activeBankId: currentCapture.document.activeFxBankId,
        selectedTrackBankFx: currentCapture.document.fxBanks.find((bank) => bank.id === currentCapture.document.activeFxBankId)?.track[0] });

    const delayedDocument = structuredClone(currentCapture.document);
    delayedDocument.fxBanks.find((bank) => bank.id === delayedDocument.activeFxBankId).track[0] = null;
    delayedDocument.tracks[0].settings.fxSw = 'OFF';
    delayedDocument.tracks[0].settings.fxChain = {
      FILTER: { type: 'FILTER', enabled: true, params: { frequency: 1, resonance: 0.7 } },
    };
    const delayedRenderer = new ProjectMixRenderer();
    const delayStartedAt = performance.now();
    const delayedBuffer = await delayedRenderer.renderRealtime({
      context: browser.context,
      document: delayedDocument,
      audioByTrackId,
      selectedTrackIds: [1],
      durationFrames: frames,
      createTrackFxGraph: async (context, trackId, doc) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return await adapter.createTrackFxGraph(context, trackId, doc);
      },
      createSelectedTrackFxGraph: (context, doc) => adapter.createSelectedTrackFxGraph(context, doc),
      createMasterFxGraph: (context, doc) => adapter.createMasterFxGraph(context, doc),
    });
    const delayMs = performance.now() - delayStartedAt;
    const delayedOnset = delayedBuffer.getChannelData(0).findIndex((value) => Math.abs(value) > 0.002);
    add('a real delayed FX graph initializes beyond the previous 42.7 ms lead without losing bounce onset',
      delayMs > 100 && delayedOnset >= 0 && delayedOnset < 256,
      { initializationDelayMs: delayMs, firstMeaningfulSampleFrame: delayedOnset, expectedStartWindowFrames: 256,
        pcm: metrics(delayedBuffer) });

    await tracks[0].updateRuntimeSettings(runtimeDefaults[0]);
    await tracks[1].updateRuntimeSettings(runtimeDefaults[1]);
    await browser.applyMixerState(mixerDefaults);
    const unchangedSources = [await digestTrack(tracks[0]), await digestTrack(tracks[1])];
    const restoredRuntime = [tracks[0].getRuntimeSettings(), tracks[1].getRuntimeSettings()];
    add('rendering and target imports leave the original selected source PCM and settings intact',
      JSON.stringify(unchangedSources) === JSON.stringify(originals) &&
      JSON.stringify(restoredRuntime) === JSON.stringify(runtimeDefaults),
      { originals, unchangedSources, runtimeDefaults, restoredRuntime });
    const actualMedia = [...document.querySelectorAll('audio,video')].map((element) => ({ muted: element.muted, tag: element.tagName }));
    add('no HTML media output became audible during the software-only test', actualMedia.every((entry) => entry.muted), { actualMedia });

    samples.frequencyCases = frequencyCases;
    samples.keepPitch = keepPitchCase;
    samples.tempoEffective = tempoCase;
    samples.reverse = { descending: reverseMonotonic, firstSample: reversedLeft[0], sample10: reversedLeft[10], sample3000: reversedLeft[3000] };
    samples.compressor = { dryRms, wetRms, nonlinearDifference, offlineRealtimeRelativeError: compressorParity.relativeError };
    samples.delayedFx = { delayMs, onsetFrame: delayedOnset };
    return { status: 'PASSED', assertions, samples, contextSafety, projectState: service.getState() };
  }).catch((error) => ({
    status: 'FAILED',
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
    assertions: window.__webrcProjectMixAssertions || [],
    samples: window.__webrcProjectMixSamples || {},
  }));

  result.assertions = result.smoke?.assertions ?? [];
  if (result.smoke.status !== 'PASSED') throw new Error(result.smoke.error || 'Project mix smoke failed.');
  result.status = 'PASSED';
} catch (error) {
  result.status = 'FAILED';
  result.error = error instanceof Error ? error.message : String(error);
  result.stack = error instanceof Error ? error.stack : null;
} finally {
  if (page) {
    try {
      result.outputSafety = await page.evaluate(() => ({
        contexts: (window.__webrcProjectMixContexts || []).map((entry) => ({
          destinationRerouted: entry.destinationRerouted,
          sinkIdNone: entry.sinkIdNone,
          sampleRate: entry.context.sampleRate,
          state: entry.context.state,
          sinkError: entry.sinkError,
        })),
        syntheticGetUserMediaRequests: (window.__webrcProjectMixSyntheticContexts || []).length,
        audibleMediaCount: [...document.querySelectorAll('audio,video')].filter((element) => !element.muted).length,
      }));
    } catch { /* the page may already have closed */ }
  }
  await browser?.close();
  await server.close();
  result.finishedAt = new Date().toISOString();
  result.outputPath = outputPath;
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASSED') process.exitCode = 1;
