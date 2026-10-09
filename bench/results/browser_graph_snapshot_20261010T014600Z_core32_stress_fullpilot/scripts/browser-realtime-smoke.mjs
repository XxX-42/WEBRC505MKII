import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { runBrowserStress32Fx } from './browser-stress-32fx.mjs';

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
const singleContextSyntheticInput = process.env.WEBRC_SINGLE_CONTEXT_INPUT === '1';
const protocolSource = readFileSync('src/audio/browserRealtimeProtocol.ts', 'utf8');
const layoutVersion = Number(protocolSource.match(/BROWSER_REALTIME_LAYOUT_VERSION\s*=\s*(\d+)/)?.[1] ?? -1);
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sharedDspManifestBytes = readFileSync('public/dsp/webrc-dsp.build.json');
const sharedDspManifest = JSON.parse(sharedDspManifestBytes.toString('utf8'));
const result = {
  startedAt,
  softwareOnly: true,
  hardwareCertified: false,
  validationConfig: { layoutVersion, sampleRate: 48_000, quantumFrames: null, audioSink: 'none', input: 'synthetic oscillators',
    inputContextTopology: singleContextSyntheticInput ? 'same-project-audio-context' : 'dedicated-context-per-input' },
  sharedDspBuild: {
    buildManifestSha256: sha256Bytes(sharedDspManifestBytes),
    sourceSetSha256: sharedDspManifest.sourceSetSha256 ?? null,
    candidateArtifactSha256: sharedDspManifest.artifact?.sha256 ?? null,
    candidateArtifactBytes: sharedDspManifest.artifact?.byteLength ?? null,
    runtimeResponse: null,
  },
  sourceSha256: {
    smoke: sha256('scripts/browser-realtime-smoke.mjs'),
    browserAudioEngine: sha256('src/audio/BrowserAudioEngine.ts'),
    realtimeProtocol: sha256('src/audio/browserRealtimeProtocol.ts'),
    realtimeRuntime: sha256('src/audio/BrowserRealtimeRuntime.ts'),
    audioEngine: sha256('src/audio/AudioEngine.ts'),
    browserRouting: sha256('src/audio/browserRouting.ts'),
    rhythmEngine: sha256('src/audio/RhythmEngine.ts'),
    rhythmTypes: sha256('src/audio/rhythmTypes.ts'),
    rhythmDocuments: sha256('src/controls/rhythmDocuments.ts'),
    cleanRoomRhythmCatalog: sha256('src/audio/cleanroomRhythmCatalog.ts'),
    rhythmEditor: sha256('src/components/RhythmEditorPanel.vue'),
    sharedDspGraph: sha256('src/audio/sharedDspGraph.ts'),
    looperWorklet: sha256('public/worklets/looper-processor.js'),
    masterFxWorklet: sha256('public/worklets/master-fx-processor.js'),
    timeStretchCore: sha256('public/worklets/time-stretch-core.js'),
    browserStressPilot: sha256('scripts/browser-stress-32fx.mjs'),
  },
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
  let sharedDspResponsePromise = Promise.resolve();
  page.on('response', (response) => {
    let pathname;
    try { pathname = new URL(response.url()).pathname; } catch { return; }
    if (!pathname.endsWith('/dsp/webrc-dsp.wasm')) return;
    sharedDspResponsePromise = response.body().then((body) => {
      result.sharedDspBuild.runtimeResponse = {
        status: response.status(),
        urlPath: pathname,
        byteLength: body.byteLength,
        sha256: sha256Bytes(body),
        matchesManifest: body.byteLength === result.sharedDspBuild.candidateArtifactBytes &&
          sha256Bytes(body) === result.sharedDspBuild.candidateArtifactSha256,
      };
    }).catch((error) => {
      result.sharedDspBuild.runtimeResponse = { error: error instanceof Error ? error.message : String(error) };
    });
  });
  page.on('pageerror', (error) => result.browserConsoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') result.browserConsoleErrors.push(`console: ${message.text()}`);
  });

  await page.addInitScript((useProjectContextForSyntheticInput) => {
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
        const antiPhase = requestedDeviceId === 'smoke-antiphase-input';
        if (useProjectContextForSyntheticInput) {
          for (const prior of syntheticContexts) {
            for (const source of prior.sources) {
              try { source.oscillator.stop(); } catch { /* an already stopped source is harmless */ }
              try { source.oscillator.disconnect(); } catch { /* node may already be disconnected */ }
              try { source.level.disconnect(); } catch { /* node may already be disconnected */ }
            }
            try { prior.streamDestination.disconnect(); } catch { /* already disconnected */ }
            for (const track of prior.streamDestination.stream.getTracks()) track.stop();
          }
        }
        const projectContext = useProjectContextForSyntheticInput
          ? (window.__webrcProjectAudioContext ?? contexts[0]?.context)
          : null;
        const context = projectContext || new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
        const contextRecord = contexts.find((entry) => entry.context === context) ?? contexts[contexts.length - 1];
        const streamDestination = context.createMediaStreamDestination();
        streamDestination.channelCount = mono ? 1 : 2;
        streamDestination.channelCountMode = 'explicit';
        const inputTrack = streamDestination.stream.getAudioTracks()[0];
        const nativeGetSettings = inputTrack?.getSettings.bind(inputTrack);
        if (inputTrack && nativeGetSettings) {
          const stableDeviceId = requestedDeviceId || 'smoke-stereo-input';
          Object.defineProperty(inputTrack, 'getSettings', {
            configurable: true,
            value: () => ({ ...nativeGetSettings(), deviceId: stableDeviceId }),
          });
        }
        const sources = [];
        if (mono) {
          const oscillator = context.createOscillator();
          const level = context.createGain();
          oscillator.frequency.value = 220;
          level.gain.value = 0.02;
          oscillator.connect(level);
          level.connect(streamDestination);
          sources.push({ oscillator, level, frequencyHz: 220, channel: 'mono' });
        } else if (antiPhase) {
          const merger = context.createChannelMerger(2);
          const oscillator = context.createOscillator();
          const leftLevel = context.createGain();
          const rightLevel = context.createGain();
          oscillator.frequency.value = 333;
          leftLevel.gain.value = 0.02;
          rightLevel.gain.value = -0.02;
          oscillator.connect(leftLevel);
          oscillator.connect(rightLevel);
          leftLevel.connect(merger, 0, 0);
          rightLevel.connect(merger, 0, 1);
          merger.connect(streamDestination);
          sources.push({ oscillator, level: leftLevel, frequencyHz: 333, channel: 'anti-phase' });
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
  }, singleContextSyntheticInput);

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
      if (status.ready && engine.browser?.context) window.__webrcProjectAudioContext = engine.browser.context;
      return { ready: status.ready, lastError: status.lastError, message: status.message };
    });
    if (readyState.ready || readyState.lastError) break;
    await page.waitForTimeout(100);
  }
  result.engineStatus = readyState;
  if (!readyState?.ready) throw new Error(`BrowserAudioEngine did not become ready: ${readyState?.lastError || 'timeout'}`);

  const smoke = await page.evaluate(async (useProjectContextForSyntheticInput) => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const engine = AudioEngine.getInstance();
    const audio = engine.browser;
    window.__webrcProjectAudioContext = audio.context;
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

    const result = { assertions: checks, status: 'RUNNING', validationConfig: { quantumFrames: null } };
    const syntheticInputTopology = () => {
      const synthetic = window.__webrcSyntheticContexts || [];
      const contexts = new Set(synthetic.map((entry) => entry.context));
      return {
        configured: window.__webrcSingleContextSyntheticInput === true,
        projectContextIdentityMatchesAllSources: synthetic.length > 0 && synthetic.every((entry) => entry.context === audio.context),
        syntheticSourceSwitchCount: synthetic.length,
        uniqueSyntheticContextCount: contexts.size,
        projectContextSampleRate: audio.context.sampleRate,
        syntheticContextsShareProjectContext: synthetic.length > 0 && contexts.size === 1 && contexts.has(audio.context),
      };
    };
    window.__webrcSingleContextSyntheticInput = useProjectContextForSyntheticInput;
    try {
      await Promise.all(window.__webrcSoftwareContexts.map((record) => record.sinkPromise));
      const safety = contextSafety();
      assert('all audio output is redirected away from physical devices',
        safety.length >= (useProjectContextForSyntheticInput ? 1 : 2) &&
          safety.every((record) => record.destinationRerouted || record.sinkIdNone),
        { contexts: safety });
      const initialInputTopology = syntheticInputTopology();
      assert('single-context synthetic input is attached to the project AudioContext',
        !useProjectContextForSyntheticInput || initialInputTopology.syntheticContextsShareProjectContext,
        initialInputTopology);

      assert('browser realtime engine is initialized', audio.isReady && audio.realtimeRuntime !== null);
      await waitFor(() => {
        const quantum = copyMetrics().quantumFrames;
        return Number.isInteger(quantum) && quantum > 0;
      }, 'observe the AudioWorklet output quantum');
      const initialMetrics = copyMetrics();
      const initialSharedDspFailures = await audio.realtimeRuntime.getSharedDspFailureDiagnostics();
      result.validationConfig.quantumFrames = initialMetrics.quantumFrames;
      assert('48 kHz / observed AudioWorklet quantum backend',
        initialMetrics.sampleRate === 48_000 && Number.isInteger(initialMetrics.quantumFrames) && initialMetrics.quantumFrames > 0 && initialMetrics.backendMode === 'sab-worklet',
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
      assert('rhythm feedback routing delay matches the observed Worklet quantum',
        ioSnapshot.rhythmRoutingDelayFrames === initialMetrics.quantumFrames && audio.getRoutingState().sources.find((source) => source.id === 'rhythm')?.routingDelayFrames === initialMetrics.quantumFrames,
        { rhythmRoutingDelayFrames: ioSnapshot.rhythmRoutingDelayFrames });
      const initialRouting = audio.getRoutingState();
      const captureSource = initialRouting.sources.find((source) => source.id === 'capture');
      const leftCaptureRoute = initialRouting.routes.find((route) => route.sourceId === 'capture' && route.sourceChannel === 0);
      const rightCaptureRoute = initialRouting.routes.find((route) => route.sourceId === 'capture' && route.sourceChannel === 1);
      assert('capture routing inventory exposes the real synthetic stereo channel count and explicit LR targets',
        captureSource?.available === true && captureSource.channelCount === 2 &&
        leftCaptureRoute?.tracks[0]?.targetChannel === 'left' && rightCaptureRoute?.tracks[0]?.targetChannel === 'right',
        { captureSource, leftTarget: leftCaptureRoute?.tracks[0]?.targetChannel, rightTarget: rightCaptureRoute?.tracks[0]?.targetChannel });
      const routingNodesBeforeUpdates = audio.routingGraph.getNodeDiagnostics();
      for (let update = 0; update < 100; update += 1) {
        const routes = initialRouting.routes.map((route) => route.sourceId === 'capture' && route.sourceChannel === 0
          ? { ...route, tracks: route.tracks.map((send) => send.trackId === 1 ? { ...send, gain: 0.5 + (update % 50) / 100 } : send) }
          : route);
        await audio.updateRoutingState({ routes });
      }
      const routingNodesAfterUpdates = audio.routingGraph.getNodeDiagnostics();
      assert('100 gain-only routing updates reuse nodes without leaving owned fanout connections',
        JSON.stringify(routingNodesBeforeUpdates) === JSON.stringify(routingNodesAfterUpdates),
        { before: routingNodesBeforeUpdates, after: routingNodesAfterUpdates });
      await audio.updateRoutingState({ routes: initialRouting.routes });
      if (leftCaptureRoute) {
        const routes = initialRouting.routes.map((route) => route === leftCaptureRoute
          ? { ...route, tracks: route.tracks.map((send) => send.trackId === 2 ? { ...send, gain: 0 } : send) }
          : route);
        await audio.updateRoutingState({ routes });
      }

      // Meter the actual output buses through MediaStreamAudioDestination taps.
      // Keep the sub/headphones HTMLAudioElements muted even while their software
      // routes are enabled; these tests never play through a physical device.
      const createBusTap = (stream) => {
        const source = audio.context.createMediaStreamSource(stream);
        const splitter = audio.context.createChannelSplitter(2);
        const analysers = [audio.context.createAnalyser(), audio.context.createAnalyser()];
        const silentSink = audio.context.createGain();
        silentSink.gain.value = 0;
        analysers.forEach((analyser) => { analyser.fftSize = 8192; });
        source.connect(splitter);
        splitter.connect(analysers[0], 0, 0);
        splitter.connect(analysers[1], 1, 0);
        analysers.forEach((analyser) => analyser.connect(silentSink));
        silentSink.connect(audio.context.destination);
        const samples = analysers.map((analyser) => new Float32Array(analyser.fftSize));
        const channels = () => analysers.map((analyser, channel) => {
          analyser.getFloatTimeDomainData(samples[channel]);
          return samples[channel];
        });
        const rms = () => {
          const [left, right] = channels();
          let sum = 0;
          for (let index = 0; index < left.length; index += 1) sum += left[index] * left[index] + right[index] * right[index];
          return Math.sqrt(sum / (2 * left.length));
        };
        return { channels, rms, dispose: () => { source.disconnect(); splitter.disconnect(); analysers.forEach((node) => node.disconnect()); silentSink.disconnect(); } };
      };
      const mainTap = createBusTap(audio.context.destination.stream);
      const subTap = createBusTap(audio.routingGraph.outputDestinations.sub.stream);
      const headphonesTap = createBusTap(audio.routingGraph.outputDestinations.headphones.stream);
      const createNodeTap = (node) => {
        const analyser = audio.context.createAnalyser();
        const silentSink = audio.context.createGain();
        const samples = new Float32Array(8192);
        analyser.fftSize = samples.length;
        silentSink.gain.value = 0;
        node.connect(analyser);
        analyser.connect(silentSink);
        silentSink.connect(audio.context.destination);
        return {
          rms: () => {
            analyser.getFloatTimeDomainData(samples);
            let squareSum = 0;
            for (const value of samples) squareSum += value * value;
            return Math.sqrt(squareSum / samples.length);
          },
          dispose: () => { node.disconnect(analyser); analyser.disconnect(); silentSink.disconnect(); },
        };
      };
      const createStereoNodeTap = (node) => {
        const splitter = audio.context.createChannelSplitter(2);
        const analysers = [audio.context.createAnalyser(), audio.context.createAnalyser()];
        const silentSink = audio.context.createGain();
        const samples = analysers.map(() => new Float32Array(8192));
        analysers.forEach((analyser) => { analyser.fftSize = samples[0].length; });
        silentSink.gain.value = 0;
        node.connect(splitter);
        splitter.connect(analysers[0], 0, 0);
        splitter.connect(analysers[1], 1, 0);
        analysers.forEach((analyser) => analyser.connect(silentSink));
        silentSink.connect(audio.context.destination);
        return {
          measure: () => analysers.map((analyser, channel) => {
            analyser.getFloatTimeDomainData(samples[channel]);
            let squareSum = 0;
            let peak = 0;
            for (const sample of samples[channel]) {
              squareSum += sample * sample;
              peak = Math.max(peak, Math.abs(sample));
            }
            return { rms: Math.sqrt(squareSum / samples[channel].length), peak };
          }),
          dispose: () => {
            node.disconnect(splitter);
            splitter.disconnect();
            analysers.forEach((analyser) => analyser.disconnect());
            silentSink.disconnect();
          },
        };
      };
      const directMainGateTap = createNodeTap(audio.routingGraph.mainDestinationGain);
      const directSubGateTap = createNodeTap(audio.routingGraph.outputGains.sub);
      const directHeadphonesGateTap = createNodeTap(audio.routingGraph.outputGains.headphones);
      const masterChannels = mainTap.channels;
      const masterRms = mainTap.rms;
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

      const cleanRoomRhythmTap = createStereoNodeTap(audio.rhythmEngine.outputNode);
      await audio.selectCleanRoomRhythm(0, 7);
      const selectedCleanRoomPreset = audio.getRhythmSnapshot().cleanRoomPreset;
      assert('Browser selects a real clean-room table pattern and procedural kit through the Worklet protocol',
        selectedCleanRoomPreset?.patternIndex === 0 && selectedCleanRoomPreset.kitIndex === 7,
        { selectedCleanRoomPreset, patternCount: 240, kitCount: 16 });
      audio.rhythmEngine.start();
      await waitFor(() => audio.getRhythmSnapshot().enabled, 'clean-room rhythm start acknowledgement');
      await sleep(1_100);
      const cleanRoomRhythmLevels = cleanRoomRhythmTap.measure();
      assert('kind-121 rhythm renders nonzero stereo PCM into the live Browser rhythm bus',
        cleanRoomRhythmLevels.length === 2 && cleanRoomRhythmLevels.every((channel) => channel.rms > 1e-6 && channel.peak > 1e-5),
        { cleanRoomRhythmLevels, patternIndex: 0, kitIndex: 7, sampleRate: audio.context.sampleRate,
          quantumFrames: copyMetrics().quantumFrames });
      audio.rhythmEngine.stop();
      await waitFor(() => !audio.getRhythmSnapshot().enabled, 'clean-room rhythm stop acknowledgement');
      await sleep(2_100);
      cleanRoomRhythmTap.dispose();
      result.cleanRoomRhythm = { selected: selectedCleanRoomPreset, levels: cleanRoomRhythmLevels,
        renderer: 'shared-dsp-wasm-kind-121', eventClock: 'actual AudioWorklet currentFrame and observed output frame length' };

      const probeOscillator = audio.context.createOscillator();
      const probeGain = audio.context.createGain();
      probeOscillator.frequency.value = 1000;
      probeGain.gain.value = 0.05;
      probeOscillator.connect(probeGain);
      probeGain.connect(audio.masterGainNode);
      audio.routingGraph.outputElements.sub.muted = true;
      audio.routingGraph.outputElements.headphones.muted = true;
      await audio.updateRoutingState({ outputs: {
        main: { enabled: true }, sub: { enabled: true }, headphones: { enabled: true },
      } });
      probeOscillator.start();
      await sleep(250);
      const mainBeforeOffRms = masterRms();
      const directMainBeforeOffRms = directMainGateTap.rms();
      await audio.updateRoutingState({ outputs: {
        main: { enabled: false }, sub: { enabled: true }, headphones: { enabled: true },
      } });
      const mainOffStartFrame = copyMetrics().renderedFrame;
      await waitFor(() => copyMetrics().renderedFrame >= mainOffStartFrame + 48_000 + 8192,
        'main output and stream bridge settle past one second plus FFT window');
      const directMainOffRms = directMainGateTap.rms();
      const mainOffRmsWindows = [];
      const mainOffFrameWindows = [];
      for (let window = 0; window < 5; window += 1) {
        mainOffRmsWindows.push(masterRms());
        mainOffFrameWindows.push(copyMetrics().renderedFrame);
        if (window < 4) await sleep(100);
      }
      const mainOffRms = Math.max(...mainOffRmsWindows);
      const subEnabledRms = subTap.rms();
      const headphonesEnabledRms = headphonesTap.rms();
      const directSubEnabledRms = directSubGateTap.rms();
      const directHeadphonesEnabledRms = directHeadphonesGateTap.rms();
      assert('main output OFF silences only the software main destination branch after steady signal',
        mainBeforeOffRms > 0.001 && directMainBeforeOffRms > 0.001 && directMainOffRms < 0.00001,
        { mainBeforeOffRms, directMainBeforeOffRms, directMainOffRms, mainOffRms, mainOffRmsWindows,
          mainOffStartFrame, mainOffFrameWindows, subEnabledRms, headphonesEnabledRms });
      assert('main output OFF leaves enabled sub and headphone software buses live',
        subEnabledRms > 0.001 && headphonesEnabledRms > 0.001 &&
          mainOffRmsWindows.slice(1).every((value) => value < 0.00001),
        { mainBeforeOffRms, directMainOffRms, mainOffRms, mainOffRmsWindows,
          mainOffStartFrame, mainOffFrameWindows, subEnabledRms, headphonesEnabledRms });
      await audio.updateRoutingState({ outputs: {
        main: { enabled: true }, sub: { enabled: false }, headphones: { enabled: false },
      } });
      const subOffStartFrame = copyMetrics().renderedFrame;
      await waitFor(() => copyMetrics().renderedFrame >= subOffStartFrame + 48_000 + 8192,
        'sub/headphone output buses and stream bridges settle past one second plus FFT window');
      const directSubOffRms = directSubGateTap.rms();
      const directHeadphonesOffRms = directHeadphonesGateTap.rms();
      const mainEnabledRms = masterRms();
      const mainEnabledDirectRms = directMainGateTap.rms();
      const subDisabledRmsWindows = [];
      const headphonesDisabledRmsWindows = [];
      const disabledOutputFrameWindows = [];
      for (let window = 0; window < 5; window += 1) {
        subDisabledRmsWindows.push(subTap.rms());
        headphonesDisabledRmsWindows.push(headphonesTap.rms());
        disabledOutputFrameWindows.push(copyMetrics().renderedFrame);
        if (window < 4) await sleep(100);
      }
      const subDisabledRms = Math.max(...subDisabledRmsWindows);
      const headphonesDisabledRms = Math.max(...headphonesDisabledRmsWindows);
      assert('main output ON restores its software signal while disabled sub/headphone buses are silent',
        mainEnabledDirectRms > 0.001 && mainEnabledRms > 0.001 &&
          directSubEnabledRms > 0.001 && directHeadphonesEnabledRms > 0.001 &&
          directSubOffRms < 0.00001 && directHeadphonesOffRms < 0.00001 &&
          subDisabledRmsWindows.slice(1).every((value) => value < 0.00001) &&
          headphonesDisabledRmsWindows.slice(1).every((value) => value < 0.00001),
        { mainEnabledRms, mainEnabledDirectRms, directSubEnabledRms, directHeadphonesEnabledRms,
          directSubOffRms, directHeadphonesOffRms, subDisabledRms, headphonesDisabledRms,
          subDisabledRmsWindows, headphonesDisabledRmsWindows, subOffStartFrame, disabledOutputFrameWindows });
      probeOscillator.stop();
      probeOscillator.disconnect();
      probeGain.disconnect();
      directMainGateTap.dispose();
      directSubGateTap.dispose();
      directHeadphonesGateTap.dispose();
      await audio.updateRoutingState({ outputs: initialRouting.outputs });
      // Keep these analysers connected: later playback/filter checks read the
      // real main-bus tap. The streams are software-only and the output elements
      // remain muted, so retaining them cannot reach a physical sink.

      const monitorGain = audio.monitorGainNode;
      monitorGain.disconnect();
      const monitorSplitter = audio.context.createChannelSplitter(2);
      const monitorAnalysers = [audio.context.createAnalyser(), audio.context.createAnalyser()];
      monitorAnalysers.forEach((analyser) => { analyser.fftSize = 2048; });
      const monitorTap = audio.context.createMediaStreamDestination();
      monitorGain.connect(monitorSplitter);
      monitorSplitter.connect(monitorAnalysers[0], 0, 0);
      monitorSplitter.connect(monitorAnalysers[1], 1, 0);
      monitorAnalysers[0].connect(monitorTap);
      const monitorSamples = monitorAnalysers.map((analyser) => new Float32Array(analyser.fftSize));
      const monitorChannelRms = () => monitorAnalysers.map((analyser, channel) => {
        analyser.getFloatTimeDomainData(monitorSamples[channel]);
        let sum = 0;
        for (const sample of monitorSamples[channel]) sum += sample * sample;
        return Math.sqrt(sum / monitorSamples[channel].length);
      });
      const monitorRms = () => {
        const channels = monitorChannelRms();
        return Math.sqrt((channels[0] ** 2 + channels[1] ** 2) / 2);
      };

      assert('record path starts with software monitor disabled', !initialMetrics.outputMonitorEnabled);
      audio.setMonitoring(true);
      await waitFor(() => copyMetrics().outputMonitorEnabled, 'monitor-on acknowledgement');
      let activeMonitorRms = 0;
      await waitFor(() => (activeMonitorRms = monitorRms()) > 0.001, 'synthetic live monitor signal');
      assert('monitor ON carries synthetic input through the persistent Worklet', activeMonitorRms > 0.001,
        { monitorRms: activeMonitorRms });
      const dspCapabilities = audio.getSharedDspRouteCapabilities();
      assert('shared DSP capability table keeps bank/master/bounce scope explicit',
        dspCapabilities.monitor.status === 'available' &&
        dspCapabilities.inputFxBank.status === 'available' &&
        dspCapabilities.trackFxBank.status === 'available' &&
        dspCapabilities.masterOutput.status === 'available' &&
        dspCapabilities.bounce.status === 'not-integrated',
        { capabilities: dspCapabilities });
      const monitorBeforeFilter = monitorRms();
      const filteredReply = await audio.configureRealtimeDspFilter({
        route: 'monitor', filter: 'highpass', values: [1500, 0.707, 0],
      });
      await sleep(100);
      const monitorAfterFilter = monitorRms();
      assert('real Worklet stereo DSP filter changes the live synthetic monitor PCM',
        filteredReply.ok === true && monitorBeforeFilter > 0.001 &&
        monitorAfterFilter > 0 && monitorAfterFilter < monitorBeforeFilter * 0.3,
        { monitorBeforeFilter, monitorAfterFilter, filteredReply });
      let invalidFilterRejected = false;
      try {
        await audio.configureRealtimeDspFilter({ route: 'monitor', filter: 'highpass', values: [0, 0.7, 0] });
      } catch { invalidFilterRejected = true; }
      await sleep(30);
      const monitorAfterRejectedFilter = monitorRms();
      assert('rejected out-of-range DSP settings preserve the active Worklet filter',
        invalidFilterRejected && monitorAfterRejectedFilter < monitorBeforeFilter * 0.3,
        { invalidFilterRejected, monitorBeforeFilter, monitorAfterRejectedFilter });
      const clearedReply = await audio.clearRealtimeDspFilter('monitor');
      await sleep(100);
      const monitorAfterClear = monitorRms();
      assert('clearing the prepared Worklet filter restores unfiltered live monitor audio',
        clearedReply.ok === true && monitorAfterClear > monitorBeforeFilter * 0.7,
        { monitorBeforeFilter, monitorAfterClear, clearedReply });
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
        const expectedActiveChannels = index === 1 ? channelRms[1] > 0.001 : channelRms[0] > 0.001 && channelRms[1] > 0.001;
        assert(`track ${index + 1} exports planar LR with the configured active channels`,
          audioBuffer.numberOfChannels === 2 && loopFrames > 0 && expectedActiveChannels,
          { loopFrames, exportedFrames: audioBuffer.length, numberOfChannels: audioBuffer.numberOfChannels, channelRms });
        if (index === 1) {
          assert('routing matrix independently disconnects capture L from track 2 while preserving capture R',
            channelRms[0] < channelRms[1] * 0.1 && channelRms[1] > 0.001,
            { channelRms });
        }
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

      // Re-record five independent spectral pairs, then measure the live
      // TrackAudio output nodes after the production Worklet's 1.3x keep-pitch
      // playback path. AudioBuffer export alone would only test storage.
      await audio.updateRoutingState({ routes: initialRouting.routes });
      const shortLoopTrack = tracks[4];
      const shortLoopFramesBefore = copyMetrics().loopFrames[4];
      const shortLoopPcmBefore = await shortLoopTrack.exportAudioBuffer();
      const shortLoopTap = audio.context.createAnalyser();
      const shortLoopSink = audio.context.createGain();
      shortLoopTap.fftSize = 8192;
      shortLoopSink.gain.value = 0;
      shortLoopTrack.outputNode.connect(shortLoopTap);
      shortLoopTap.connect(shortLoopSink);
      shortLoopSink.connect(audio.context.destination);
      await shortLoopTrack.updateRuntimeSettings({ speed: 1.3, keepPitch: true });
      await sleep(220);
      const shortLoopSamples = new Float32Array(shortLoopTap.fftSize);
      shortLoopTap.getFloatTimeDomainData(shortLoopSamples);
      let shortLoopSquareSum = 0;
      let shortLoopMaxStep = 0;
      let shortLoopFinite = true;
      for (let sample = 0; sample < shortLoopSamples.length; sample += 1) {
        const value = shortLoopSamples[sample];
        shortLoopFinite &&= Number.isFinite(value);
        shortLoopSquareSum += value * value;
        if (sample > 0) shortLoopMaxStep = Math.max(shortLoopMaxStep, Math.abs(value - shortLoopSamples[sample - 1]));
      }
      const shortLoopPcmAfter = await shortLoopTrack.exportAudioBuffer();
      let shortLoopPcmChanged = shortLoopFramesBefore !== shortLoopPcmAfter.length;
      for (let sample = 0; !shortLoopPcmChanged && sample < shortLoopPcmAfter.length; sample += 1) {
        shortLoopPcmChanged = shortLoopPcmBefore.getChannelData(0)[sample] !== shortLoopPcmAfter.getChannelData(0)[sample] ||
          shortLoopPcmBefore.getChannelData(1)[sample] !== shortLoopPcmAfter.getChannelData(1)[sample];
      }
      const shortLoopKeepPitch = { frames: shortLoopFramesBefore, liveRms: Math.sqrt(shortLoopSquareSum / shortLoopSamples.length),
        liveMaxStep: shortLoopMaxStep, allFinite: shortLoopFinite, sourcePcmUnchanged: !shortLoopPcmChanged };
      assert('short recorded loops remain non-silent and PCM-stable during live keep-pitch playback',
        shortLoopFramesBefore > 0 && shortLoopKeepPitch.liveRms > 0.001 && shortLoopFinite &&
        shortLoopMaxStep < 0.1 && !shortLoopPcmChanged,
        shortLoopKeepPitch);
      shortLoopTrack.outputNode.disconnect(shortLoopTap);
      shortLoopTap.disconnect();
      shortLoopSink.disconnect();
      await shortLoopTrack.updateRuntimeSettings({ speed: 1, keepPitch: false });

      // Use one-second integer-cycle PCM loops so seam discontinuities and
      // non-bin-centered test tones cannot masquerade as channel leakage.
      const keepPitchFrequencies = [
        { left: 277, right: 733 }, { left: 331, right: 811 }, { left: 419, right: 907 },
        { left: 503, right: 977 }, { left: 587, right: 1_061 },
      ];
      const liveTrackAnalyzers = [];
      const trackTapSink = audio.context.createGain();
      trackTapSink.gain.value = 0;
      trackTapSink.connect(audio.context.destination);
      for (let index = 0; index < tracks.length; index += 1) {
        await tracks[index].clear();
        await waitFor(() => tracks[index].state === 'EMPTY' && copyMetrics().loopFrames[index] === 0,
          `clear track ${index + 1} before integer-cycle keep-pitch fixture`);
        const source = audio.context.createBuffer(2, audio.context.sampleRate, audio.context.sampleRate);
        for (let sample = 0; sample < source.length; sample += 1) {
          source.getChannelData(0)[sample] = 0.025 * Math.sin(2 * Math.PI * keepPitchFrequencies[index].left * sample / audio.context.sampleRate);
          source.getChannelData(1)[sample] = 0.02 * Math.sin(2 * Math.PI * keepPitchFrequencies[index].right * sample / audio.context.sampleRate);
        }
        await tracks[index].importAudioBuffer(source);
        await waitFor(() => copyMetrics().loopFrames[index] === source.length, `load track ${index + 1} one-second LR PCM fixture`);
        const importedMetrics = copyMetrics();
        const importedMetadata = audio.realtimeRuntime?.getTrackMetadata(index);
        assert(`imported track ${index + 1} publishes STOPPED state through runtime and UI views`,
          importedMetrics.trackStates[index] === 6 && tracks[index].state === 'STOPPED',
          { visibleState: tracks[index].state,
            runtimeState: importedMetrics.trackStates[index],
            metadataState: importedMetadata?.[0] ?? null,
            loopFrames: importedMetrics.loopFrames[index] });
        await tracks[index].play();
        const playActionError = tracks[index].getLastActionError();
        const playMetadata = audio.realtimeRuntime?.getTrackMetadata(index);
        assert(`track ${index + 1} keep-pitch PLAY command is accepted`, playActionError === null,
          { state: tracks[index].state,
            lastActionError: playActionError,
            modelOneShot: tracks[index].track.oneShot,
            runtimeSettings: tracks[index].getRuntimeSettings(),
            metadataWords: playMetadata ? Array.from(playMetadata.slice(0, 40)) : null,
            metrics: copyMetrics(),
            transportState: audio.transport?.state ?? null });
        try {
          await waitFor(() => tracks[index].state === 'PLAYING', `play track ${index + 1} keep-pitch fixture`);
        } catch (error) {
          result.liveKeepPitchStartFailure = { track: index + 1,
            visibleState: tracks[index].state,
            lastActionError: tracks[index].getLastActionError(),
            runtimeMetrics: copyMetrics(),
            runtimeSettings: tracks[index].getRuntimeSettings(),
            loopSyncSwitch: tracks[index].track.loopSyncSw };
          throw error;
        }
        const splitter = audio.context.createChannelSplitter(2);
        const analyzers = [audio.context.createAnalyser(), audio.context.createAnalyser()];
        analyzers.forEach((analyzer) => {
          analyzer.fftSize = 32_768;
          analyzer.connect(trackTapSink);
        });
        tracks[index].outputNode.connect(splitter);
        splitter.connect(analyzers[0], 0, 0);
        splitter.connect(analyzers[1], 1, 0);
        liveTrackAnalyzers.push({ splitter, analyzers, samples: analyzers.map(() => new Float32Array(32_768)) });
      }
      const neutralMixer = audio.getMixerState();
      neutralMixer.masterLevel = 1;
      neutralMixer.tracks.forEach((track) => { track.level = 1; track.pan = 0; track.muted = false; track.solo = false; });
      await audio.applyMixerState(neutralMixer);
      const candidateFrequencies = [
        ...keepPitchFrequencies.map((pair) => pair.left),
        ...keepPitchFrequencies.map((pair) => pair.right),
      ];
      const measureLiveTrackTones = () => liveTrackAnalyzers.map((tap, index) => {
        const channels = tap.analyzers.map((analyzer, channel) => {
          analyzer.getFloatTimeDomainData(tap.samples[channel]);
          return tap.samples[channel];
        });
        const expected = keepPitchFrequencies[index];
        const leftMagnitudes = candidateFrequencies.map((frequency) => toneMagnitude(channels[0], frequency));
        const rightMagnitudes = candidateFrequencies.map((frequency) => toneMagnitude(channels[1], frequency));
        const leftIndex = keepPitchFrequencies.findIndex((pair) => pair.left === expected.left);
        const rightIndex = keepPitchFrequencies.findIndex((pair) => pair.right === expected.right);
        const leftExpected = leftMagnitudes[leftIndex];
        const rightExpected = rightMagnitudes[keepPitchFrequencies.length + rightIndex];
        const leftLeakIndex = leftMagnitudes.reduce((best, magnitude, candidate) => {
          if (candidate === leftIndex) return best;
          return best === leftIndex || magnitude > (leftMagnitudes[best] ?? -Infinity) ? candidate : best;
        }, leftIndex);
        const rightTargetIndex = keepPitchFrequencies.length + rightIndex;
        const rightLeakIndex = rightMagnitudes.reduce((best, magnitude, candidate) => {
          if (candidate === rightTargetIndex) return best;
          return best === rightTargetIndex || magnitude > (rightMagnitudes[best] ?? -Infinity) ? candidate : best;
        }, rightTargetIndex);
        const leftLeak = leftMagnitudes[leftLeakIndex];
        const rightLeak = rightMagnitudes[rightLeakIndex];
        const estimateFrequency = (samples) => {
          const crossings = [];
          for (let sample = 1; sample < samples.length; sample += 1) {
            const before = samples[sample - 1];
            const after = samples[sample];
            if (before <= 0 && after > 0) {
              crossings.push(sample - 1 + (-before / (after - before)));
            }
          }
          return crossings.length > 1
            ? audio.context.sampleRate * (crossings.length - 1) / (crossings.at(-1) - crossings[0])
            : null;
        };
        return { track: index + 1, expected, leftExpected, rightExpected, leftLeak, rightLeak,
          leftLeakHz: candidateFrequencies[leftLeakIndex], rightLeakHz: candidateFrequencies[rightLeakIndex],
          leftMagnitudes, rightMagnitudes,
          leftEstimatedHz: estimateFrequency(channels[0]), rightEstimatedHz: estimateFrequency(channels[1]),
          leftDominance: leftExpected / Math.max(leftLeak, 1e-9), rightDominance: rightExpected / Math.max(rightLeak, 1e-9) };
      });
      await Promise.all(tracks.map((track) => track.updateRuntimeSettings({ speed: 1, keepPitch: false })));
      await sleep(700);
      const liveNormalSpeedMeasurements = measureLiveTrackTones();
      await Promise.all(tracks.map((track) => track.updateRuntimeSettings({ speed: 1.3, keepPitch: true })));
      await sleep(800);
      const liveKeepPitchMeasurements = measureLiveTrackTones();
      const keepPitchMetrics = copyMetrics();
      result.liveKeepPitch = { frequencies: keepPitchFrequencies,
        normalSpeedMeasurements: liveNormalSpeedMeasurements,
        keepPitchMeasurements: liveKeepPitchMeasurements,
        deadlineMetricAvailable: keepPitchMetrics.deadlineMetricAvailable,
        processDeadlineMisses: keepPitchMetrics.processDeadlineMisses,
        inputDropoutFrames: keepPitchMetrics.inputDropoutFrames,
        storageGrowthFailures: keepPitchMetrics.storageGrowthFailures,
        trackCapacityOverruns: keepPitchMetrics.trackCapacityOverruns,
        commandOverruns: keepPitchMetrics.commandOverruns };
      assert('five live Worklet tracks preserve their independent LR tones at 1.3x keep-pitch',
        liveKeepPitchMeasurements.length === 5 && liveKeepPitchMeasurements.every((measurement) =>
          measurement.leftExpected > 0.002 && measurement.rightExpected > 0.002 &&
          measurement.leftDominance > 4 && measurement.rightDominance > 4 &&
          Math.abs(measurement.leftEstimatedHz - measurement.expected.left) < 4 &&
          Math.abs(measurement.rightEstimatedHz - measurement.expected.right) < 4) &&
        keepPitchMetrics.inputDropoutFrames === 0 && keepPitchMetrics.storageGrowthFailures === 0 &&
        keepPitchMetrics.trackCapacityOverruns === 0 && keepPitchMetrics.commandOverruns === 0,
        { shortLoopKeepPitch, liveNormalSpeedMeasurements, liveKeepPitchMeasurements,
          runtimeSettings: tracks.map((track) => track.getRuntimeSettings()),
          metrics: keepPitchMetrics });
      assert('unavailable Worklet deadline telemetry remains NA instead of being treated as zero XRUNs',
        keepPitchMetrics.deadlineMetricAvailable === false && keepPitchMetrics.processDeadlineMisses === null,
        { deadlineMetricAvailable: keepPitchMetrics.deadlineMetricAvailable,
          processDeadlineMisses: keepPitchMetrics.processDeadlineMisses, xrunInterpretation: 'not available' });

      // Measure the five independent track signatures after their own stereo
      // panners, then restore the exact mixer snapshot. This supplements the
      // existing capture/input-processor LR checks with hard pan endpoint and
      // route restoration evidence at the playback output ports.
      const mixerBeforePanProbe = audio.getMixerState();
      await Promise.all(tracks.map((track) => track.updateRuntimeSettings({ speed: 1, keepPitch: false })));
      await sleep(700);
      const neutralPanMeasurements = measureLiveTrackTones();
      const panVector = [-1, 0, 1, -1, 1];
      const panProbeMixer = audio.getMixerState();
      panProbeMixer.masterLevel = 1;
      panProbeMixer.tracks.forEach((track, index) => {
        track.level = 1;
        track.pan = panVector[index];
        track.muted = false;
        track.solo = false;
      });
      await audio.applyMixerState(panProbeMixer);
      await sleep(700);
      const readPanProbe = () => liveTrackAnalyzers.map((tap, index) => {
        const pair = keepPitchFrequencies[index];
        const channels = tap.analyzers.map((analyzer, channel) => {
          analyzer.getFloatTimeDomainData(tap.samples[channel]);
          return tap.samples[channel];
        });
        const channelRms = channels.map((samples) => Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, samples.length),
        ));
        const expectedMagnitudes = channels.map((samples) => ({
          leftSignature: toneMagnitude(samples, pair.left),
          rightSignature: toneMagnitude(samples, pair.right),
        }));
        return { track: index + 1, requestedPan: panVector[index], channelRms, expectedMagnitudes };
      });
      const panProbeMeasurements = readPanProbe();
      const panProbePass = panProbeMeasurements.every((measurement) => {
        const [leftRms, rightRms] = measurement.channelRms;
        if (measurement.requestedPan <= -1) return leftRms > 0.001 && rightRms < leftRms * 0.04;
        if (measurement.requestedPan >= 1) return rightRms > 0.001 && leftRms < rightRms * 0.04;
        return leftRms > 0.001 && rightRms > 0.001 &&
          rightRms / leftRms > 0.5 && rightRms / leftRms < 1.8;
      });
      assert('five distinct stereo track signatures follow hard-left, center, and hard-right panning',
        panProbePass && panProbeMeasurements.length === 5 &&
          panProbeMeasurements.every((measurement) =>
            measurement.expectedMagnitudes.some((channel) => channel.leftSignature > 0.001) &&
            measurement.expectedMagnitudes.some((channel) => channel.rightSignature > 0.001)),
        { panVector, measurements: panProbeMeasurements, signatures: keepPitchFrequencies });
      await audio.applyMixerState(mixerBeforePanProbe);
      await sleep(700);
      const restoredPanMeasurements = readPanProbe();
      const panRestorePass = restoredPanMeasurements.every((measurement, index) => {
        const baseline = neutralPanMeasurements[index];
        return baseline && measurement.channelRms.every((rms, channel) => {
          const reference = channel === 0 ? baseline.leftExpected : baseline.rightExpected;
          const actual = measurement.expectedMagnitudes[channel][channel === 0 ? 'leftSignature' : 'rightSignature'];
          return reference > 0.001 && actual > reference * 0.55 && actual < reference * 1.8;
        });
      });
      assert('restoring the prior mixer state restores every track’s independent stereo output',
        panRestorePass && JSON.stringify(audio.getMixerState()) === JSON.stringify(mixerBeforePanProbe),
        { before: mixerBeforePanProbe, after: audio.getMixerState(), neutralPanMeasurements,
          panMeasurements: panProbeMeasurements, restoredMeasurements: restoredPanMeasurements });
      result.trackPanEndToEnd = { mixerBefore: mixerBeforePanProbe, panVector,
        neutralPanMeasurements, panMeasurements: panProbeMeasurements,
        restoredMeasurements: restoredPanMeasurements, passed: panProbePass && panRestorePass };

      // Exercise the actual three shared-DSP bank boundaries together on five
      // distinct stereo loop sources. Keep the shared slots in a spare bank so
      // the project-memory fixture below can still verify the user's saved A/B
      // bank state independently.
      const dspBankBefore = audio.getFxState();
      const sharedFxTimelineStart = {
        contextCurrentTimeSeconds: audio.context.currentTime,
        contextFrameEstimate: Math.round(audio.context.currentTime * audio.context.sampleRate),
        workletRenderedFrame: copyMetrics().renderedFrame,
        quantumFrames: copyMetrics().quantumFrames,
      };
      const originalTrackFxSends = tracks.map((track) => track.track.fxSw === 'ON');
      const dspTestBank = dspBankBefore.banks.find((bank) => bank.id !== dspBankBefore.activeBankId &&
        ['input', 'track', 'output'].every((location) => bank[location].every((slot) => slot === null)));
      if (!dspTestBank) throw new Error('The shared-DSP route fixture needs one empty spare FX bank.');
      const fxCatalog = audio.getSharedDspFxCatalog();
      const makeSharedFx = (ordinal, overrides = {}) => {
        const descriptor = fxCatalog.find((entry) => entry.ordinal === ordinal);
        if (!descriptor) throw new Error(`Shared-DSP ordinal ${ordinal} is absent from the loaded catalog.`);
        const params = Object.fromEntries(descriptor.parameters.map((parameter) => [String(parameter.id), parameter.defaultValue]));
        Object.assign(params, overrides);
        return { type: `SHARED_DSP_FX_${ordinal}`, enabled: true, params };
      };
      const lowPassFx = (frequencyHz) => makeSharedFx(1, { '1': frequencyHz, '3': 1 });
      const savedMonitoringForDsp = audio.monitoringEnabled;
      const savedMixerForDsp = audio.getMixerState();
      await audio.selectFxBank(dspTestBank.id);
      await audio.updateFxBankSlot('input', 0, lowPassFx(350));
      await audio.updateFxBankSlot('input', 2, lowPassFx(500));
      let interleavedBankRejected = false;
      let interleavedBankError = '';
      try {
        await audio.updateFxBankSlot('input', 1,
          { type: 'FILTER', enabled: true, params: { frequency: 0.5, resonance: 0.2 } });
      } catch (error) {
        interleavedBankRejected = true;
        interleavedBankError = error instanceof Error ? error.message : String(error);
      }
      const retainedDspBank = audio.getFxBanks().find((bank) => bank.id === dspTestBank.id);
      assert('A(shared)/B(legacy)/C(shared) refuses the reorder and preserves both shared processors',
        interleavedBankRejected && retainedDspBank?.input[0]?.type === 'SHARED_DSP_FX_1' &&
          retainedDspBank.input[1] === null && retainedDspBank.input[2]?.type === 'SHARED_DSP_FX_1',
        { interleavedBankRejected, interleavedBankError, inputSlots: retainedDspBank?.input });

      await tracks[4].clear();
      await waitFor(() => tracks[4].state === 'EMPTY' && copyMetrics().loopFrames[4] === 0,
        'clear track five for the shared input-bank capture');
      await tracks[4].startRecording();
      await waitFor(() => tracks[4].state === 'RECORDING', 'shared input-bank track five record start');
      await sleep(250);
      await tracks[4].stopRecording(true);
      await waitFor(() => tracks[4].state === 'PLAYING', 'shared input-bank track five record stop');
      const sharedInputPcm = await tracks[4].exportAudioBuffer();
      const sharedInputLeft = sharedInputPcm.getChannelData(0);
      const sharedInputRight = sharedInputPcm.getChannelData(1);
      const sharedInputSignature = {
        left250: toneMagnitude(sharedInputLeft, 250), left500: toneMagnitude(sharedInputLeft, 500),
        right250: toneMagnitude(sharedInputRight, 250), right500: toneMagnitude(sharedInputRight, 500),
      };
      assert('shared INPUT FX records the synthetic left and right signatures into their own PCM channels',
        sharedInputPcm.numberOfChannels === 2 && sharedInputPcm.length > 0 &&
          sharedInputSignature.left250 > sharedInputSignature.left500 * 5 &&
          sharedInputSignature.right500 > sharedInputSignature.right250 * 5,
        { frames: sharedInputPcm.length, signature: sharedInputSignature, slots: retainedDspBank?.input });

      // Restore Track 5's known independent stereo fixture, then check the real
      // per-track shared-FX route on all five playback ports.
      const sharedTrackFixture = audio.context.createBuffer(2, audio.context.sampleRate, audio.context.sampleRate);
      for (let sample = 0; sample < sharedTrackFixture.length; sample += 1) {
        sharedTrackFixture.getChannelData(0)[sample] = 0.025 * Math.sin(2 * Math.PI * keepPitchFrequencies[4].left * sample / audio.context.sampleRate);
        sharedTrackFixture.getChannelData(1)[sample] = 0.02 * Math.sin(2 * Math.PI * keepPitchFrequencies[4].right * sample / audio.context.sampleRate);
      }
      await tracks[4].importAudioBuffer(sharedTrackFixture);
      await waitFor(() => copyMetrics().loopFrames[4] === sharedTrackFixture.length,
        'restore track five stereo DSP playback fixture');
      await tracks[4].play();
      await audio.updateFxBankSlot('track', 0, lowPassFx(1800));
      await Promise.all(tracks.map((_, index) => audio.setTrackFxSend(index + 1, true)));
      await sleep(700);
      const sharedTrackMeasurements = measureLiveTrackTones();
      assert('shared Track FX keeps five independent stereo signatures on their actual playback ports',
        sharedTrackMeasurements.length === 5 && sharedTrackMeasurements.every((measurement) =>
          measurement.leftExpected > 0.001 && measurement.rightExpected > 0.001 &&
          measurement.leftDominance > 4 && measurement.rightDominance > 4),
        { measurements: sharedTrackMeasurements, ordinal: 1, cutoffHz: 1800,
          fxSend: tracks.map((track) => track.track.fxSw) });

      const masterReverb = makeSharedFx(47, {
        '16': 0.6, '17': 4500, '18': 0.23, '19': 0.18, '20': 0.7, '21': 0.35,
      });
      await audio.updateFxBankSlot('output', 0, masterReverb);
      const dspMuteMixer = audio.getMixerState();
      dspMuteMixer.masterLevel = 1;
      dspMuteMixer.tracks.forEach((track) => { track.muted = true; track.solo = false; });
      await audio.applyMixerState(dspMuteMixer);
      await audio.setMonitoring(false);
      audio.rhythmEngine.stop();
      const masterImpulse = audio.context.createBuffer(2, 64, audio.context.sampleRate);
      masterImpulse.getChannelData(0)[0] = 1;
      masterImpulse.getChannelData(1)[0] = 0.7;
      const masterImpulseSource = audio.context.createBufferSource();
      masterImpulseSource.buffer = masterImpulse;
      masterImpulseSource.connect(audio.masterGainNode);
      const masterImpulseEnded = new Promise((resolve) => { masterImpulseSource.onended = resolve; });
      masterImpulseSource.start();
      await masterImpulseEnded;
      masterImpulseSource.disconnect();
      await sleep(300);
      const masterDspTailChannels = mainTap.channels();
      const masterDspTail = masterDspTailChannels.map((samples) => {
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        return { rms: Math.sqrt(sum / samples.length), peak: Math.max(...samples.map(Math.abs)) };
      });
      assert('shared Master FX runs the actual post-mix FDN stereo path and renders its impulse tail',
        masterDspTail.length === 2 && masterDspTail.every((channel) =>
          Number.isFinite(channel.rms) && Number.isFinite(channel.peak) && channel.rms > 1e-6 && channel.peak > 1e-5),
        { tail: masterDspTail, ordinal: 47, wet: masterReverb.params['21'], contextSampleRate: audio.context.sampleRate });

      // Capture the real post-master Worklet output while replacing a DC-
      // attenuating high-pass with dry. This exercises the committed old/new
      // chain transition rather than only checking the new-chain startup ramp.
      await audio.updateFxBankSlot('output', 0, makeSharedFx(3, { '1': 1800 }));
      await sleep(100);
      const masterFxNode = audio.getMasterFxOutputNode();
      if (!masterFxNode) throw new Error('The prepared post-master FX Worklet is not exposed for software capture.');
      await audio.context.audioWorklet.addModule('/worklets/bounce-capture-processor.js');
      const transitionTargetFrames = 16_384;
      const transitionChunkFrames = 1_024;
      const transitionSlots = 16;
      const transitionStartFrame = copyMetrics().renderedFrame + 512;
      const transitionCaptureBytes = 80 * Int32Array.BYTES_PER_ELEMENT +
        transitionSlots * transitionChunkFrames * 2 * Float32Array.BYTES_PER_ELEMENT;
      const transitionCaptureBuffer = new SharedArrayBuffer(transitionCaptureBytes);
      const transitionHeader = new Int32Array(transitionCaptureBuffer, 0, 80);
      transitionHeader[0] = 0x42434d50;
      transitionHeader[1] = 1;
      transitionHeader[5] = transitionTargetFrames;
      transitionHeader[6] = 0;
      transitionHeader[7] = transitionStartFrame | 0;
      transitionHeader[8] = Math.floor(transitionStartFrame / 0x1_0000_0000) | 0;
      transitionHeader[10] = transitionChunkFrames;
      transitionHeader[11] = transitionSlots;
      const transitionCapture = new AudioWorkletNode(audio.context, 'webrc505mk2-bounce-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { buffer: transitionCaptureBuffer, targetFrames: transitionTargetFrames, startFrame: transitionStartFrame },
      });
      const captureSilentGain = audio.context.createGain();
      captureSilentGain.gain.value = 0;
      masterFxNode.connect(transitionCapture);
      transitionCapture.connect(captureSilentGain);
      captureSilentGain.connect(audio.context.destination);
      const dcSource = audio.context.createConstantSource();
      const dcGain = audio.context.createGain();
      dcSource.offset.value = 0.2;
      dcGain.gain.value = 1;
      dcSource.connect(dcGain);
      dcGain.connect(audio.masterGainNode);
      dcSource.start();
      try {
        await waitFor(() => Atomics.load(transitionHeader, 6) >= 4096,
          'post-master DC capture reaches the pre-transition window', 5_000);
        const transitionCaptureOffset = Atomics.load(transitionHeader, 6);
        await audio.updateFxBankSlot('output', 0, null);
        await waitFor(() => Atomics.load(transitionHeader, 2) === 2,
          'post-master FX replacement capture completes', 5_000);
        const transitionRing = new Float32Array(transitionCaptureBuffer, 80 * Int32Array.BYTES_PER_ELEMENT);
        const transitionLeft = new Float32Array(transitionTargetFrames);
        const transitionRight = new Float32Array(transitionTargetFrames);
        let transitionCopied = 0;
        const transitionWriteSequence = Atomics.load(transitionHeader, 3);
        for (let sequence = 0; sequence < transitionWriteSequence; sequence += 1) {
          const slot = sequence % transitionSlots;
          const length = Atomics.load(transitionHeader, 16 + slot);
          if (length < 1 || transitionCopied + length > transitionTargetFrames) {
            throw new Error('The post-master FX replacement capture ring returned an invalid chunk.');
          }
          const slotOffset = slot * transitionChunkFrames * 2;
          transitionLeft.set(transitionRing.subarray(slotOffset, slotOffset + length), transitionCopied);
          transitionRight.set(transitionRing.subarray(slotOffset + transitionChunkFrames,
            slotOffset + transitionChunkFrames + length), transitionCopied);
          transitionCopied += length;
        }
        const segmentRms = (samples, start, end) => Math.sqrt(
          samples.slice(start, end).reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, end - start),
        );
        let transitionMaximumAdjacentStep = 0;
        for (let frame = 1; frame < transitionCopied; frame += 1) {
          transitionMaximumAdjacentStep = Math.max(transitionMaximumAdjacentStep,
            Math.abs(transitionLeft[frame] - transitionLeft[frame - 1]),
            Math.abs(transitionRight[frame] - transitionRight[frame - 1]));
        }
        const attenuatedDcRms = [segmentRms(transitionLeft, 1024, 3072), segmentRms(transitionRight, 1024, 3072)];
        const dryDcRms = [segmentRms(transitionLeft, transitionCopied - 2048, transitionCopied),
          segmentRms(transitionRight, transitionCopied - 2048, transitionCopied)];
        assert('post-master Worklet crossfades the real stereo DC path from attenuating FX to dry without a hard step',
          transitionCopied === transitionTargetFrames && attenuatedDcRms.every((rms) => rms < 0.01) &&
            dryDcRms.every((rms) => rms > 0.15) && transitionMaximumAdjacentStep < 0.01,
          { transitionStartFrame, transitionCaptureOffset, frames: transitionCopied,
            attenuatedDcRms, dryDcRms, transitionMaximumAdjacentStep, threshold: 0.01,
            source: '0.2 DC ConstantSourceNode → Master FX Worklet → bounce-capture Worklet; sink remains none' });
        result.sharedFxReplacementTransition = {
          source: '0.2 DC ConstantSourceNode', previousOrdinal: 3, replacement: 'dry',
          transitionStartFrame, transitionCaptureOffset, frames: transitionCopied,
          attenuatedDcRms, dryDcRms, maximumAdjacentStep: transitionMaximumAdjacentStep,
        };
      } finally {
        try { dcSource.stop(); } catch { /* capture may have failed before start */ }
        dcSource.disconnect();
        dcGain.disconnect();
        transitionCapture.disconnect();
        captureSilentGain.disconnect();
      }

      await audio.updateFxBankSlot('input', 0, null);
      await audio.updateFxBankSlot('input', 2, null);
      await audio.updateFxBankSlot('track', 0, null);
      await audio.updateFxBankSlot('output', 0, null);
      await Promise.all(tracks.map((_, index) => audio.setTrackFxSend(index + 1, originalTrackFxSends[index] ?? false)));
      await audio.selectFxBank(dspBankBefore.activeBankId);
      await audio.applyMixerState(savedMixerForDsp);
      if (audio.monitoringEnabled !== savedMonitoringForDsp) await audio.setMonitoring(savedMonitoringForDsp);
      await sleep(100);
      result.sharedFxBrowserGraph = {
        activeBankId: dspTestBank.id,
        start: sharedFxTimelineStart,
        end: {
          contextCurrentTimeSeconds: audio.context.currentTime,
          contextFrameEstimate: Math.round(audio.context.currentTime * audio.context.sampleRate),
          workletRenderedFrame: copyMetrics().renderedFrame,
          quantumFrames: copyMetrics().quantumFrames,
        },
        input: { ordinal: 1, cutoffHz: [350, 500], recordedSignature: sharedInputSignature, frames: sharedInputPcm.length },
        track: { ordinal: 1, cutoffHz: 1800, ports: sharedTrackMeasurements },
        master: { ordinal: 47, tailChannels: masterDspTail, reverbSeconds: masterReverb.params['16'] },
        interleavedSharedLegacySharedRejected: interleavedBankRejected,
        allFiveStereoSendStatesRestored: tracks.every((track, index) => (track.track.fxSw === 'ON') === originalTrackFxSends[index]),
      };

      liveTrackAnalyzers.forEach((tap, index) => {
        tracks[index].outputNode.disconnect(tap.splitter);
        tap.splitter.disconnect();
        tap.analyzers.forEach((analyzer) => analyzer.disconnect());
      });
      trackTapSink.disconnect();
      await Promise.all(tracks.map((track) => track.updateRuntimeSettings({ speed: 1, keepPitch: false })));

      const pcmDigest = (buffer) => {
        let hash = 2_166_136_261;
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          const samples = buffer.getChannelData(channel);
          const words = new Uint32Array(samples.buffer, samples.byteOffset, samples.length);
          for (let frame = 0; frame < words.length; frame += 1) hash = Math.imul(hash ^ words[frame], 16_777_619) >>> 0;
        }
        return { frames: buffer.length, channels: buffer.numberOfChannels, fnv1a32: hash.toString(16).padStart(8, '0') };
      };
      const controlApi = await import('/src/composables/useControlDispatcher.ts');
      const dispatcher = controlApi.controlCommandDispatcher;
      dispatcher.setAssignment(0, { source: 'cc', channel: 1, number: 21, trigger: 'value', command: 'set-track-pan', trackId: 1 });
      engine.setControlStateAdapter({ read: () => dispatcher.getState(), apply: (state) => dispatcher.setState(state) });
      await audio.updateLoopSettings({ bpm: 93, masterTrackId: 1 });
      await tracks[0].updateRuntimeSettings({ reverse: true, speed: 1.25, keepPitch: false });
      await audio.updateFxBankSlot('track', 0, { type: 'FILTER', enabled: true, params: { frequency: 0.82, resonance: 0.22 } });
      await audio.setTrackFxSend(1, true);
      const mixerA = audio.getMixerState();
      mixerA.masterLevel = 0.8;
      mixerA.tracks[0].level = 0.7;
      mixerA.tracks[0].pan = 0.2;
      await audio.applyMixerState(mixerA);
      const routingA = audio.getRoutingState();
      const routeA = routingA.routes.find((route) => route.sourceId === 'capture' && route.sourceChannel === 0);
      if (!routeA) throw new Error('The project-memory fixture could not find the synthetic capture route.');
      const routesA = routingA.routes.map((route) => route === routeA
        ? { ...route, mainGain: 0.35, tracks: route.tracks.map((send) => send.trackId === 1 ? { ...send, gain: 0.65 } : send) }
        : route);
      await audio.updateRoutingState({ routes: routesA });
      await audio.selectCleanRoomRhythm(0, 7);
      const memoryService = engine.getProjectService();
      const memoryAHashes = await Promise.all(tracks.map(async (track, index) =>
        copyMetrics().loopFrames[index] > 0 ? pcmDigest(await track.exportAudioBuffer()) : null));
      const memoryABankId = audio.getActiveFxBankId();
      const memoryARhythmPreset = audio.getRhythmSnapshot().cleanRoomPreset;
      const memoryAInfo = await memoryService.saveMemory(1, 'software memory A');

      // Give B different PCM on every non-master track as well. Track 2 stays
      // loaded so it can be selected as B's valid master; A→B→A must therefore
      // re-import the cleared tracks instead of passing on stale in-memory PCM.
      for (let index = 0; index < tracks.length; index += 1) {
        if (index === 1) continue;
        await tracks[index].clear();
        await waitFor(() => copyMetrics().loopFrames[index] === 0 && tracks[index].state === 'EMPTY', `prepare distinct project B PCM on track ${index + 1}`);
      }
      await tracks[0].updateRuntimeSettings({ reverse: false, speed: 0.75, keepPitch: false });
      await audio.updateLoopSettings({ bpm: 127, masterTrackId: 2 });
      await audio.updateFxBankSlot('track', 0, null);
      await audio.setTrackFxSend(1, false);
      const secondBankId = audio.getFxBanks().find((bank) => bank.id !== memoryABankId)?.id;
      if (!secondBankId) throw new Error('The project-memory fixture could not find a second FX bank.');
      await audio.selectFxBank(secondBankId);
      const mixerB = audio.getMixerState();
      mixerB.masterLevel = 0.5;
      mixerB.tracks[0].pan = -0.3;
      await audio.applyMixerState(mixerB);
      const routingB = audio.getRoutingState();
      await audio.updateRoutingState({ routes: routingB.routes.map((route) => route.sourceId === 'capture' && route.sourceChannel === 0
        ? { ...route, mainGain: 0.12 }
        : route) });
      await audio.selectCleanRoomRhythm(17, 5);
      dispatcher.setAssignment(0, null);
      const memoryBInfo = await memoryService.saveMemory(2, 'software memory B');
      const restoredDocumentA = await memoryService.loadMemory(1);
      for (let index = 0; index < 5; index += 1) {
        const expected = memoryAHashes[index];
        await waitFor(() => (copyMetrics().loopFrames[index] ?? 0) === (expected?.frames ?? 0), `Memory A track ${index + 1} restored frame count`);
      }
      const memoryARestoredHashes = await Promise.all(tracks.map(async (track, index) =>
        memoryAHashes[index] ? pcmDigest(await track.exportAudioBuffer()) : null));
      const pcmExact = JSON.stringify(memoryARestoredHashes) === JSON.stringify(memoryAHashes);
      const restoredRouteA = audio.getRoutingState().routes.find((route) => route.sourceId === 'capture' && route.sourceChannel === 0);
      const restoredBankA = audio.getFxBanks().find((bank) => bank.id === memoryABankId);
      const restoredRhythmPreset = (restoredDocumentA.extensions.rhythm)?.cleanRoomPreset ?? null;
      const runtimeRhythmPreset = audio.getRhythmSnapshot().cleanRoomPreset;
      const rhythmPresetExact = JSON.stringify(restoredRhythmPreset) === JSON.stringify(memoryARhythmPreset) &&
        JSON.stringify(runtimeRhythmPreset) === JSON.stringify(memoryARhythmPreset);
      assert('real BrowserAudioEngine Memory A→B→A restores native stereo PCM, clock, mix, FX send, routing, and assignments',
        memoryAInfo.slot === 1 && memoryBInfo.slot === 2 && pcmExact && restoredDocumentA.global.bpm === 93 &&
        restoredDocumentA.global.masterTrackId === 1 && audio.getLoopSettings().bpm === 93 &&
        audio.getLoopSettings().masterTrackId === 1 && tracks[0].getRuntimeSettings().reverse === true &&
        tracks[0].getRuntimeSettings().speed === 1.25 && audio.getMixerState().masterLevel === 0.8 &&
        Math.abs(audio.getMixerState().tracks[0].pan - 0.2) < 1e-6 && tracks[0].track.fxSw === 'ON' &&
        audio.getActiveFxBankId() === memoryABankId && restoredBankA?.track[0]?.type === 'FILTER' &&
        restoredBankA.track[0]?.enabled === true && restoredRouteA?.mainGain === 0.35 &&
        dispatcher.getState().assignments[0]?.number === 21 && memoryAHashes.some((entry) => entry !== null) && rhythmPresetExact,
        { memoryAInfo, memoryBInfo, pcmExact, memoryAHashes, memoryARestoredHashes,
          memoryARhythmPreset, restoredRhythmPreset, runtimeRhythmPreset, rhythmPresetExact,
          bpm: audio.getLoopSettings().bpm, masterTrackId: audio.getLoopSettings().masterTrackId,
          runtimeSettings: tracks[0].getRuntimeSettings(), mixer: audio.getMixerState(), trackFxSend: tracks[0].track.fxSw,
          activeBankId: audio.getActiveFxBankId(), bankFx: restoredBankA?.track[0], restoredMainGain: restoredRouteA?.mainGain,
          controlAssignment: dispatcher.getState().assignments[0] });
      result.projectMemoryReload = { slot: 1, expectedPcm: memoryAHashes, expectedBankId: memoryABankId,
        expectedRhythmPreset: memoryARhythmPreset, status: 'PENDING' };

      // Exercise the actual BrowserAudioEngine external-clock path, then make a
      // quantized REC request on the Worklet. The acknowledged target must lie
      // on the same fractional-BPM measure grid derived from SYNC's scheduled
      // target frame (not its potentially late execution frame).
      const { BrowserRealtimeOpcode } = await import('/src/audio/browserRealtimeProtocol.ts');
      const { Transport } = await import('/src/core/Transport.ts');
      await tracks[0].updateRuntimeSettings({ reverse: false, speed: 1, keepPitch: false });
      const externalClockBpm = 93.4567;
      const normalizedExternalBpm = Math.round(externalClockBpm * 1_000) / 1_000;
      const runtime = audio.realtimeRuntime;
      const externalBeatFrames = audio.context.sampleRate * 60 / normalizedExternalBpm;
      const externalBeatOrdinal = Math.ceil(runtime.getCurrentFrame() / externalBeatFrames) + 10;
      const externalClockAck = await audio.syncExternalClock(externalClockBpm, externalBeatOrdinal);
      const transport = Transport.getInstance();
      const externalClockOrigin = externalClockAck.targetFrame - externalBeatOrdinal * externalBeatFrames;
      assert('fractional external clock updates Transport with Worklet scheduled phase epoch',
        (externalClockAck.status === 0 || externalClockAck.status === 1) &&
        transport.bpm === normalizedExternalBpm && transport.hasClockEpoch &&
        Math.abs(transport.clockOriginFrame - externalClockOrigin) < 1e-6 &&
        externalClockOrigin < 0 && Math.abs(externalClockOrigin - Math.trunc(externalClockOrigin)) > 1e-4,
        { requestedBpm: externalClockBpm, appliedBpm: transport.bpm, beatOrdinal: externalBeatOrdinal,
          syncTargetFrame: externalClockAck.targetFrame, syncExecutedFrame: externalClockAck.executedFrame,
          transportClockOrigin: transport.clockOriginFrame, expectedClockOrigin: externalClockOrigin,
          currentFrameBeforeSync: runtime.getCurrentFrame(), originMustBeNegativeAndFractional: true });

      // Changing the master and restarting Transport must preserve the external
      // beat-grid epoch. Observe actual Worklet beat messages as well as the
      // BrowserAudioEngine calls, so a stale UI-only epoch cannot pass.
      const clockStateAcks = [];
      const masterEpochAcks = [];
      const workletBeatEvents = [];
      const originalSetClock = runtime.setClock.bind(runtime);
      const originalSetMasterClockEpoch = runtime.setMasterClockEpoch.bind(runtime);
      const onWorkletBeat = (event) => workletBeatEvents.push(event);
      runtime.setClock = async (...args) => {
        const ack = await originalSetClock(...args);
        clockStateAcks.push({ running: args[0], ack });
        return ack;
      };
      runtime.setMasterClockEpoch = async (...args) => {
        const ack = await originalSetMasterClockEpoch(...args);
        masterEpochAcks.push({ origin: args[0], bpm: args[1], startClock: args[3] === true, ack });
        return ack;
      };
      transport.on('beat', onWorkletBeat);
      try {
        const beforeMasterChangeEpochCount = masterEpochAcks.length;
        await audio.updateLoopSettings({ masterTrackId: 2 });
        const masterChangeEpoch = masterEpochAcks.at(-1);
      assert('selecting another loaded master preserves the negative external beat epoch',
        audio.getLoopSettings().masterTrackId === 2 && transport.hasClockEpoch &&
        Math.abs(transport.clockOriginFrame - externalClockOrigin) < 1e-6 &&
        masterEpochAcks.length > beforeMasterChangeEpochCount && masterChangeEpoch?.origin === externalClockOrigin &&
        (masterChangeEpoch.ack.status === 0 || masterChangeEpoch.ack.status === 1),
        { masterTrackId: audio.getLoopSettings().masterTrackId, transportClockOrigin: transport.clockOriginFrame,
          expectedClockOrigin: externalClockOrigin, bpm: transport.bpm, masterChangeEpoch });
        if (transport.state === 'PLAYING') {
          transport.stop();
          await waitFor(() => clockStateAcks.some((entry) => entry.running === false), 'stop Transport before phase restart');
        } else {
          const stoppedAck = await runtime.setClock(false);
          clockStateAcks.push({ running: false, ack: stoppedAck });
        }
        const priorEpochCount = masterEpochAcks.length;
        transport.start();
        await waitFor(() => masterEpochAcks.length > priorEpochCount &&
          masterEpochAcks.at(-1)?.ack && workletBeatEvents.length > 0, 'restart Transport on the external phase epoch');
        const restartedEpoch = masterEpochAcks.at(-1);
        const phaseTick = workletBeatEvents.find((event) =>
          Math.abs(event.frame - (externalClockOrigin + event.beatOrdinal * externalBeatFrames)) <= 0.500001);
        const offPhaseTicks = workletBeatEvents.filter((event) =>
          Math.abs(event.frame - (externalClockOrigin + event.beatOrdinal * externalBeatFrames)) > 0.500001);
        assert('stop/start reanchors every observed Worklet beat tick to the same negative fractional epoch',
          restartedEpoch.origin === externalClockOrigin && restartedEpoch.startClock === true &&
          (restartedEpoch.ack.status === 0 || restartedEpoch.ack.status === 1) && phaseTick !== undefined && offPhaseTicks.length === 0,
          { externalClockOrigin, restartedEpoch, clockStateAcks,
            firstBeatEvents: workletBeatEvents.slice(0, 4), matchingPhaseTick: phaseTick, offPhaseTicks });
        result.transportPhase = { originFrame: externalClockOrigin, beatOrdinal: externalBeatOrdinal,
          masterAfterSync: audio.getLoopSettings().masterTrackId, masterChangeEpoch,
          restartedEpoch, beatEvents: workletBeatEvents.slice(0, 8), offPhaseTicks };
      } finally {
        transport.off('beat', onWorkletBeat);
        runtime.setClock = originalSetClock;
        runtime.setMasterClockEpoch = originalSetMasterClockEpoch;
      }

      await audio.updateLoopSettings({ quantize: 'MEASURE' });
      await tracks[4].clear();
      await waitFor(() => copyMetrics().loopFrames[4] === 0 && tracks[4].state === 'EMPTY', 'prepare measure-quantized MIDI REC');
      let startRecordAck = null;
      const originalEnqueue = runtime.enqueue.bind(runtime);
      runtime.enqueue = async (...args) => {
        const ack = await originalEnqueue(...args);
        if (args[0] === BrowserRealtimeOpcode.START_RECORD) startRecordAck = ack;
        return ack;
      };
      try {
        await tracks[4].startRecording();
      } finally {
        runtime.enqueue = originalEnqueue;
      }
      if (!startRecordAck) throw new Error('The quantized REC request did not produce a Worklet ACK.');
      const measureFrames = audio.context.sampleRate * 60 * 4 / normalizedExternalBpm;
      const measureOrdinal = (startRecordAck.targetFrame - externalClockOrigin) / measureFrames;
      const nearestMeasureOrdinal = Math.round(measureOrdinal);
      const measureGridErrorFrames = Math.abs(startRecordAck.targetFrame -
        (externalClockOrigin + nearestMeasureOrdinal * measureFrames));
      assert('fractional MIDI clock quantizes a real REC target to the next measure',
        startRecordAck.targetFrame >= externalClockAck.targetFrame &&
        nearestMeasureOrdinal >= 1 && measureGridErrorFrames <= 0.500001 &&
        Math.abs(startRecordAck.targetFrame - transport.getNextMeasureStartFrame(startRecordAck.targetFrame - 1)) <= 1,
        { externalClockOrigin, externalBeatFrames, measureFrames, measureOrdinal,
          nearestMeasureOrdinal, measureGridErrorFrames,
          syncTargetFrame: externalClockAck.targetFrame, recordTargetFrame: startRecordAck.targetFrame,
          recordExecutedFrame: startRecordAck.executedFrame, transportBpm: transport.bpm });
      await audio.updateLoopSettings({ quantize: 'OFF' });
      await waitFor(() => tracks[4].state === 'RECORDING', 'MIDI-quantized REC reaches its scheduled sample');
      await sleep(80);
      await tracks[4].stopRecording(true);
      await waitFor(() => tracks[4].state === 'PLAYING', 'stop MIDI-quantized REC');
      await tracks[4].clear();
      await waitFor(() => copyMetrics().loopFrames[4] === 0 && tracks[4].state === 'EMPTY', 'clear MIDI-quantized recording');

      const dryInputFxRms = [...trackResults[4].channelRms];
      await tracks[4].clear();
      await waitFor(() => copyMetrics().loopFrames[4] === 0, 'clear dry input-FX capture');
      // The Memory A round-trip above intentionally restored a lower MAIN gain
      // for capture L than its Track 5 send. Use equal branch gains here so the
      // comparison measures the shared INPUT-FX signal instead of route trim.
      const inputFxRouting = audio.getRoutingState();
      const captureInputFxRoutes = inputFxRouting.routes.map((route) => {
        if (route.sourceId !== 'capture') return route;
        const trackGain = route.tracks.find((send) => send.trackId === 5)?.gain ?? 0;
        return { ...route, mainGain: trackGain };
      });
      await audio.updateRoutingState({ routes: captureInputFxRoutes });
      await audio.updateFxBankSlot('input', 0, {
        type: 'COMPRESSOR',
        enabled: true,
        params: { amount: 1, thresholdDb: -60, ratio: 20, kneeDb: 30, attackSeconds: 0.003, releaseSeconds: 0.25 },
      });
      await audio.setMonitoring(true);
      await waitFor(() => copyMetrics().outputMonitorEnabled, 'input-FX monitor enable');
      await tracks[4].startRecording();
      await waitFor(() => tracks[4].state === 'RECORDING', 'input-compressor track 5 record start');
      await sleep(220);
      const wetInputMonitorRms = monitorChannelRms();
      await tracks[4].stopRecording(true);
      await waitFor(() => tracks[4].state === 'PLAYING', 'input-compressor track 5 record stop');
      const wetInputCapture = await tracks[4].exportAudioBuffer();
      const wetInputFxRms = [0, 1].map((channel) => {
        const samples = wetInputCapture.getChannelData(channel);
        let squareSum = 0;
        for (let sample = 0; sample < samples.length; sample += 1) squareSum += samples[sample] * samples[sample];
        return Math.sqrt(squareSum / Math.max(1, samples.length));
      });
      assert('enabled INPUT compressor changes captured PCM on both stereo channels',
        wetInputFxRms[0] < dryInputFxRms[0] * 0.75 && wetInputFxRms[1] < dryInputFxRms[1] * 0.75,
        { dryInputFxRms, wetInputFxRms, gainRatios: wetInputFxRms.map((value, index) => value / Math.max(dryInputFxRms[index], 1e-9)) });

      const wetTailFrames = Math.min(2048, wetInputCapture.length);
      const wetRecordedTailRms = [0, 1].map((channel) => {
        const samples = wetInputCapture.getChannelData(channel);
        let squareSum = 0;
        for (let sample = samples.length - wetTailFrames; sample < samples.length; sample += 1) squareSum += samples[sample] * samples[sample];
        return Math.sqrt(squareSum / Math.max(1, wetTailFrames));
      });
      assert('capture and live monitor use the same single-pass stereo INPUT FX signal',
        wetRecordedTailRms.every((value, channel) => value > 0 && wetInputMonitorRms[channel] > 0 &&
          value / wetInputMonitorRms[channel] > 0.7 && value / wetInputMonitorRms[channel] < 1.3),
        { wetRecordedTailRms, wetInputMonitorRms, ratios: wetRecordedTailRms.map((value, channel) => value / Math.max(wetInputMonitorRms[channel] ?? 0, 1e-9)) });
      await audio.setMonitoring(false);
      await waitFor(() => !copyMetrics().outputMonitorEnabled, 'input-FX monitor disable');

      const compressorSnapshot = {
        type: 'COMPRESSOR',
        enabled: true,
        params: { amount: 1, thresholdDb: -60, ratio: 20, kneeDb: 30, attackSeconds: 0.003, releaseSeconds: 0.25 },
      };
      await audio.updateFxBankSlot('input', 0, { ...compressorSnapshot, enabled: false });
      const beforeQuadRouting = audio.getRoutingState();
      await tracks[4].clear();
      await waitFor(() => copyMetrics().loopFrames[4] === 0 && tracks[4].state === 'EMPTY', 'clear before four-channel dry routing capture');
      const withoutCaptureToTrack5 = beforeQuadRouting.routes.map((route) => route.sourceId === 'capture'
        ? { ...route, tracks: route.tracks.map((send) => ({ ...send, gain: 0 })) }
        : route);
      await audio.updateRoutingState({ routes: withoutCaptureToTrack5 });
      const quadFrequencies = [600, 700, 800, 900];
      const runQuadCapture = async (id, activeChannels = [0, 1, 2, 3]) => {
        await tracks[4].clear();
        await waitFor(() => copyMetrics().loopFrames[4] === 0 && tracks[4].state === 'EMPTY', `clear before ${id}`);
        const quadInputBuffer = audio.context.createBuffer(4, audio.context.sampleRate, audio.context.sampleRate);
        quadFrequencies.forEach((frequency, channel) => {
          if (!activeChannels.includes(channel)) return;
          const samples = quadInputBuffer.getChannelData(channel);
          for (let sample = 0; sample < samples.length; sample += 1) {
            samples[sample] = 0.03 * Math.sin(2 * Math.PI * frequency * sample / audio.context.sampleRate);
          }
        });
        const source = audio.context.createBufferSource();
        source.buffer = quadInputBuffer;
        await audio.routingGraph.setSource({
          id, node: source, label: 'Synthetic four-channel input', kind: 'capture', channelCount: 4,
        }, id);
        source.start();
        await tracks[4].startRecording();
        await waitFor(() => tracks[4].state === 'RECORDING', `${id} record start`);
        await sleep(180);
        await tracks[4].stopRecording(true);
        await waitFor(() => tracks[4].state === 'PLAYING', `${id} record stop`);
        source.stop();
        const capture = await tracks[4].exportAudioBuffer();
        const left = capture.getChannelData(0);
        const right = capture.getChannelData(1);
        const magnitudes = {
          left600: toneMagnitude(left, 600), left800: toneMagnitude(left, 800),
          left700: toneMagnitude(left, 700), left900: toneMagnitude(left, 900),
          right700: toneMagnitude(right, 700), right900: toneMagnitude(right, 900),
          right600: toneMagnitude(right, 600), right800: toneMagnitude(right, 800),
        };
        await audio.routingGraph.setSource(null, id);
        return { capture, magnitudes };
      };
      const quadDry = await runQuadCapture('smoke-quad-dry');
      const quadDryMagnitudes = quadDry.magnitudes;
      const quadDryCrosstalkRatios = {
        left600FromRight: quadDryMagnitudes.left700 / Math.max(quadDryMagnitudes.left600, 1e-9),
        left800FromRight: quadDryMagnitudes.left900 / Math.max(quadDryMagnitudes.left800, 1e-9),
        right700FromLeft: quadDryMagnitudes.right600 / Math.max(quadDryMagnitudes.right700, 1e-9),
        right900FromLeft: quadDryMagnitudes.right800 / Math.max(quadDryMagnitudes.right900, 1e-9),
      };
      assert('four-channel dry routing keeps stereo pairs isolated without folding channels',
        quadDry.capture.numberOfChannels === 2 && [quadDryMagnitudes.left600, quadDryMagnitudes.left800,
          quadDryMagnitudes.right700, quadDryMagnitudes.right900].every((value) => value > 0.02),
        { sourceChannels: 4, quadDryMagnitudes,
          dualToneSpectralLeakageDiagnosticOnly: quadDryCrosstalkRatios });
      const isolatedDry0 = (await runQuadCapture('smoke-quad-dry-channel-0', [0])).magnitudes;
      const isolatedDry1 = (await runQuadCapture('smoke-quad-dry-channel-1', [1])).magnitudes;
      const isolatedDry2 = (await runQuadCapture('smoke-quad-dry-channel-2', [2])).magnitudes;
      const isolatedDry3 = (await runQuadCapture('smoke-quad-dry-channel-3', [3])).magnitudes;
      const dryRouteRatios = {
        channel0LeftToRight: isolatedDry0.right600 / Math.max(isolatedDry0.left600, 1e-9),
        channel1RightToLeft: isolatedDry1.left700 / Math.max(isolatedDry1.right700, 1e-9),
        channel2LeftToRight: isolatedDry2.right800 / Math.max(isolatedDry2.left800, 1e-9),
        channel3RightToLeft: isolatedDry3.left900 / Math.max(isolatedDry3.right900, 1e-9),
      };
      assert('four-channel dry routing isolates each actual source channel from the opposite output side',
        [isolatedDry0.left600, isolatedDry1.right700, isolatedDry2.left800, isolatedDry3.right900].every((value) => value > 0.02) &&
          Object.values(dryRouteRatios).every((ratio) => ratio < 0.02),
        { isolatedDry0, isolatedDry1, isolatedDry2, isolatedDry3, dryRouteRatios,
          dualToneSpectralLeakageDiagnosticOnly: quadDryCrosstalkRatios });

      await audio.updateFxBankSlot('input', 0, compressorSnapshot);
      const quadWet = await runQuadCapture('smoke-quad-input-fx');
      const quadWetMagnitudes = quadWet.magnitudes;
      assert('four-channel source retains both left/right pairs with INPUT FX enabled',
        quadWet.capture.numberOfChannels === 2 && [quadWetMagnitudes.left600, quadWetMagnitudes.left800,
          quadWetMagnitudes.right700, quadWetMagnitudes.right900].every((value) => value > 0.0001),
        { sourceChannels: 4, quadWetMagnitudes });
      const isolatedFirstLeft = (await runQuadCapture('smoke-quad-channel-0-input-fx', [0])).magnitudes;
      const isolatedFirstRight = (await runQuadCapture('smoke-quad-channel-1-input-fx', [1])).magnitudes;
      const firstPairRouteRatios = {
        leftToRight: isolatedFirstLeft.right600 / Math.max(isolatedFirstLeft.left600, 1e-9),
        rightToLeft: isolatedFirstRight.left700 / Math.max(isolatedFirstRight.right700, 1e-9),
      };
      assert('four-channel INPUT FX keeps isolated first-pair source channels on their assigned stereo sides',
        isolatedFirstLeft.left600 > 0.0001 && isolatedFirstRight.right700 > 0.0001 &&
        Object.values(firstPairRouteRatios).every((ratio) => ratio < 0.02),
        { sourcePair: [0, 1], isolatedLeft: isolatedFirstLeft, isolatedRight: isolatedFirstRight, firstPairRouteRatios });
      const isolatedSecondLeft = (await runQuadCapture('smoke-quad-channel-2-input-fx', [2])).magnitudes;
      const isolatedSecondRight = (await runQuadCapture('smoke-quad-channel-3-input-fx', [3])).magnitudes;
      const secondPairRouteRatios = {
        leftToRight: isolatedSecondLeft.right800 / Math.max(isolatedSecondLeft.left800, 1e-9),
        rightToLeft: isolatedSecondRight.left900 / Math.max(isolatedSecondRight.right900, 1e-9),
      };
      assert('four-channel INPUT FX keeps isolated second-pair source channels on their assigned stereo sides',
        isolatedSecondLeft.left800 > 0.0001 && isolatedSecondRight.right900 > 0.0001 &&
        Object.values(secondPairRouteRatios).every((ratio) => ratio < 0.02),
        { sourcePair: [2, 3], isolatedLeft: isolatedSecondLeft, isolatedRight: isolatedSecondRight, secondPairRouteRatios });
      result.inputFxFourChannel = { quadDryMagnitudes, quadDryCrosstalkRatios, quadWetMagnitudes,
        dryIsolatedChannels: { channel0: isolatedDry0, channel1: isolatedDry1, channel2: isolatedDry2, channel3: isolatedDry3, routeRatios: dryRouteRatios },
        firstPair: { left: isolatedFirstLeft, right: isolatedFirstRight, routeRatios: firstPairRouteRatios },
        secondPair: { left: isolatedSecondLeft, right: isolatedSecondRight, routeRatios: secondPairRouteRatios } };
      await audio.updateRoutingState({ routes: beforeQuadRouting.routes });
      await audio.setInputDevice('smoke-mono-input');
      await tracks[4].clear();
      await waitFor(() => copyMetrics().loopFrames[4] === 0 && tracks[4].state === 'EMPTY', 'clear before active-FX source replacement capture');
      await tracks[4].startRecording();
      await waitFor(() => tracks[4].state === 'RECORDING', 'replacement source INPUT-FX record start');
      await sleep(180);
      await tracks[4].stopRecording(true);
      await waitFor(() => tracks[4].state === 'PLAYING', 'replacement source INPUT-FX record stop');
      const replacementSourceCapture = await tracks[4].exportAudioBuffer();
      const replacementSourceRms = [0, 1].map((channel) => {
        const samples = replacementSourceCapture.getChannelData(channel);
        let squareSum = 0;
        for (let sample = 0; sample < samples.length; sample += 1) squareSum += samples[sample] * samples[sample];
        return Math.sqrt(squareSum / Math.max(1, samples.length));
      });
      assert('replacing a source while INPUT FX is enabled rebuilds its owned source-to-splitter path',
        replacementSourceCapture.length > 0 && replacementSourceRms.every((value) => value > 0 && value < 0.0035),
        { replacementSourceChannels: audio.getRoutingState().sources.find((source) => source.id === 'capture')?.channelCount,
          replacementSourceRms, nodeDiagnostics: audio.routingGraph.getNodeDiagnostics() });
      await tracks[4].clear();
      await audio.updateFxBankSlot('input', 0, null);

      // Keep only one recorded loop active so the output frequency test exercises the
      // production track FX -> gain -> centered StereoPanner -> master route in isolation.
      for (let index = 1; index < 5; index += 1) await tracks[index].clear();
      const centeredPlaybackMixer = audio.getMixerState();
      centeredPlaybackMixer.masterLevel = 1;
      centeredPlaybackMixer.tracks.forEach((track) => {
        track.level = 1;
        track.pan = 0;
        track.muted = false;
        track.solo = false;
      });
      await audio.applyMixerState(centeredPlaybackMixer);
      if (tracks[0].state === 'STOPPED') await tracks[0].play();
      await waitFor(() => tracks[0].state === 'PLAYING' && copyMetrics().loopFrames[0] > 0,
        'single-track centered stereo playback start');
      await sleep(100);
      const [masterLeft, masterRight] = masterChannels();
      const playbackTones = {
        left277: toneMagnitude(masterLeft, 277),
        left733: toneMagnitude(masterLeft, 733),
        right277: toneMagnitude(masterRight, 277),
        right733: toneMagnitude(masterRight, 733),
      };
      assert('centered stereo playback preserves left/right frequency separation through the master output',
        playbackTones.left277 > playbackTones.left733 * 5 && playbackTones.right733 > playbackTones.right277 * 5,
        { playbackTones, state: tracks[0].state, loopFrames: copyMetrics().loopFrames[0], metrics: copyMetrics() });

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
      assert('clear releases loop history while retaining a bounded reusable storage reserve',
        clearedMetrics.loopFrames[4] === 0 && clearedMetrics.trackCapacityFrames[4] > 0 &&
        clearedMetrics.trackCapacityFrames[4] <= initialMetrics.trackCapacityFrames[4],
        { loopFrames: clearedMetrics.loopFrames[4], capacityFrames: clearedMetrics.trackCapacityFrames[4] });

      await audio.setInputDevice('smoke-antiphase-input');
      await tracks[4].startRecording();
      await waitFor(() => tracks[4].state === 'RECORDING', 'antiphase input track 5 record start');
      await sleep(120);
      await tracks[4].stopRecording(true);
      await waitFor(() => tracks[4].state === 'PLAYING', 'antiphase input track 5 record stop');
      const antiPhaseBuffer = await tracks[4].exportAudioBuffer();
      const antiLeft = antiPhaseBuffer.getChannelData(0);
      const antiRight = antiPhaseBuffer.getChannelData(1);
      let antiCorrelationNumerator = 0;
      let antiLeftEnergy = 0;
      let antiRightEnergy = 0;
      for (let sample = 0; sample < antiLeft.length; sample += 1) {
        antiCorrelationNumerator += antiLeft[sample] * antiRight[sample];
        antiLeftEnergy += antiLeft[sample] * antiLeft[sample];
        antiRightEnergy += antiRight[sample] * antiRight[sample];
      }
      const antiCorrelation = antiCorrelationNumerator / Math.sqrt(Math.max(antiLeftEnergy * antiRightEnergy, 1e-18));
      assert('channel-aware routing preserves opposite polarity in the two recorded channels',
        antiLeft.length > 0 && antiCorrelation < -0.98,
        { frames: antiLeft.length, antiCorrelation });
      await tracks[4].clear();

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
      const finalSharedDspFailures = await audio.realtimeRuntime.getSharedDspFailureDiagnostics();
      const sharedDspFailureDelta = finalSharedDspFailures.aggregateCount - initialSharedDspFailures.aggregateCount;
      const failureKindDeltas = Object.fromEntries(Object.entries(finalSharedDspFailures.counts).map(([kind, count]) =>
        [kind, count - (initialSharedDspFailures.counts[kind] ?? 0)]));
      const explainedFailureDelta = Object.values(failureKindDeltas).reduce((sum, count) => sum + count, 0);
      const timelineDiagnostics = {
        duplicateCallbacks: finalSharedDspFailures.timelineDuplicateCallbacks - initialSharedDspFailures.timelineDuplicateCallbacks,
        forwardGapCount: finalSharedDspFailures.timelineForwardGapCount - initialSharedDspFailures.timelineForwardGapCount,
        forwardGapFrames: finalSharedDspFailures.timelineForwardGapFrames - initialSharedDspFailures.timelineForwardGapFrames,
        boundedCatchupFrames: finalSharedDspFailures.timelineRecoveryCatchupFrames - initialSharedDspFailures.timelineRecoveryCatchupFrames,
        recoveryCount: finalSharedDspFailures.timelineRecoveryCount - initialSharedDspFailures.timelineRecoveryCount,
        recoveryCompleteCount: finalSharedDspFailures.timelineRecoveryCompleteCount - initialSharedDspFailures.timelineRecoveryCompleteCount,
        xrunCount: finalSharedDspFailures.timelineXrunCount - initialSharedDspFailures.timelineXrunCount,
        uniqueAdvancedFrames: finalSharedDspFailures.timelineUniqueAdvancedFrames - initialSharedDspFailures.timelineUniqueAdvancedFrames,
        droppedOutputCallbacks: finalSharedDspFailures.timelineDroppedOutputCallbacks - initialSharedDspFailures.timelineDroppedOutputCallbacks,
        droppedOutputFrames: finalSharedDspFailures.timelineDroppedOutputFrames - initialSharedDspFailures.timelineDroppedOutputFrames,
        droppedInputCallbacks: finalSharedDspFailures.timelineDroppedInputCallbacks - initialSharedDspFailures.timelineDroppedInputCallbacks,
        droppedInputFrames: finalSharedDspFailures.timelineDroppedInputFrames - initialSharedDspFailures.timelineDroppedInputFrames,
        explicitRecoveryCount: finalSharedDspFailures.timelineExplicitRecoveryCount - initialSharedDspFailures.timelineExplicitRecoveryCount,
        explicitRecoverySkippedFrames: finalSharedDspFailures.timelineExplicitRecoverySkippedFrames - initialSharedDspFailures.timelineExplicitRecoverySkippedFrames,
        timelineFailureCount: finalSharedDspFailures.timelineFailureCount - initialSharedDspFailures.timelineFailureCount,
        recoveryNeededAtEnd: finalSharedDspFailures.timelineRecoveryNeeded,
        unrecoveredGapFramesAtEnd: finalSharedDspFailures.timelineUnrecoveredGapFrames,
        rhythmCallDiscontinuities: finalSharedDspFailures.rhythmCallDiscontinuityCount - initialSharedDspFailures.rhythmCallDiscontinuityCount,
        lastExpectedFrame: finalSharedDspFailures.timelineExpectedFrame,
        lastActualFrame: finalSharedDspFailures.timelineLastActualFrame,
        lastStatus: finalSharedDspFailures.timelineLastStatus,
      };
      assert('no unexpected shared DSP process or command failures occurred during this smoke',
        sharedDspFailureDelta === 0 && explainedFailureDelta === 0,
        { initial: initialSharedDspFailures, final: finalSharedDspFailures,
          sharedDspFailureDelta, expectedFailureDelta: 0, failureKindDeltas, explainedFailureDelta,
          intentionalRejectedSettingProbe: 'configure range rejection is setup-only and must not increment process failures' });
      assert('duplicate and bounded forward callbacks are handled without timeline faults',
        timelineDiagnostics.timelineFailureCount === 0 && !timelineDiagnostics.recoveryNeededAtEnd &&
          timelineDiagnostics.rhythmCallDiscontinuities === 0,
        { ...timelineDiagnostics, gapsAreReportedAsRecoveries: true,
          zeroXrunQualification: false,
          qualificationNote: 'Functional recovery smoke only; any xrun/dropout remains visible and prevents a zero-xrun timing claim.' });
      result.sharedDspFailureDiagnostics = { initial: initialSharedDspFailures,
        final: finalSharedDspFailures, sharedDspFailureDelta, expectedFailureDelta: 0,
        failureKindDeltas, explainedFailureDelta };
      result.timelineDiagnostics = { initial: {
          duplicateCallbacks: initialSharedDspFailures.timelineDuplicateCallbacks,
          forwardGapCount: initialSharedDspFailures.timelineForwardGapCount,
          forwardGapFrames: initialSharedDspFailures.timelineForwardGapFrames,
          timelineFailureCount: initialSharedDspFailures.timelineFailureCount,
          rhythmCallDiscontinuities: initialSharedDspFailures.rhythmCallDiscontinuityCount,
        }, final: finalSharedDspFailures, delta: timelineDiagnostics,
        recoveryDoesNotQualifyAsZeroXrun: true,
        actualZeroXrunGatePassed: false };
      result.status = 'PASS';
      result.syntheticInputTopology = syntheticInputTopology();
      result.contextSampleRate = audio.context.sampleRate;
      result.contextState = audio.context.state;
      result.sharedDspRuntimeIdentity = audio.getSharedDspRuntimeIdentity();
      result.contextSafety = contextSafety();
      result.initialMetrics = initialMetrics;
      result.finalMetrics = copyMetrics();
      result.ioSnapshot = engine.getBrowserIoSnapshot();
      result.latencyInfo = engine.getLatencyInfo();
      result.trackResults = trackResults;
      result.inputCompressorCapture = {
        dryRms: dryInputFxRms, wetRms: wetInputFxRms, monitorRms: wetInputMonitorRms,
        recordedTailRms: wetRecordedTailRms,
        quadDry: { magnitudes: quadDryMagnitudes, crosstalkRatios: quadDryCrosstalkRatios },
        quadWet: { magnitudes: quadWetMagnitudes },
        quadWetIsolatedChannels: result.inputFxFourChannel,
      };
      result.stereoPlayback = playbackTones;
      result.routing = { captureSource, leftTarget: leftCaptureRoute?.tracks[0]?.targetChannel, rightTarget: rightCaptureRoute?.tracks[0]?.targetChannel, antiCorrelation };
      result.routingNodeReuse = { before: routingNodesBeforeUpdates, after: routingNodesAfterUpdates };
      result.replacementSourceInputFx = { sourceChannels: audio.getRoutingState().sources.find((source) => source.id === 'capture')?.channelCount, rms: replacementSourceRms };
      result.changedOverdubSamples = changedSamples;
      result.changedOverdubRightSamples = changedRightSamples;
      result.monoCompatibility = { frames: monoCompatBuffer.length, maxChannelDifference: monoChannelMaxDifference };
      result.filterOutputRms = { ui100: filterHighCutoffRms, ui1: filterLowCutoffRms };
      result.monitorOnRms = activeMonitorRms;
      result.monitorOffRms = mutedMonitorRms;
      result.calibration = { beforeDeviceSwitchMs: calibratedBeforeSwitchMs, afterDeviceSwitchMs: calibratedAfterSwitchMs };
      result.outputRouting = { mainBeforeOffRms, directMainBeforeOffRms, directMainOffRms,
        mainOffRms, mainOffRmsWindows, mainOffFrameWindows, mainOffStartFrame,
        subEnabledRms, headphonesEnabledRms, directSubEnabledRms, directHeadphonesEnabledRms,
        mainEnabledRms, mainEnabledDirectRms, directSubOffRms, directHeadphonesOffRms,
        subDisabledRms, headphonesDisabledRms, subDisabledRmsWindows, headphonesDisabledRmsWindows,
        subOffStartFrame, disabledOutputFrameWindows };
      result.externalClockQuantizedRecord = {
        requestedBpm: externalClockBpm,
        appliedBpm: normalizedExternalBpm,
        beatOrdinal: externalBeatOrdinal,
        syncAck: { status: externalClockAck.status, targetFrame: externalClockAck.targetFrame, executedFrame: externalClockAck.executedFrame },
        transportClockOrigin: transport.clockOriginFrame,
        recordTargetFrame: startRecordAck.targetFrame,
        recordExecutedFrame: startRecordAck.executedFrame,
        measureOrdinal,
      };
      result.softwareTaps = {
        mainStreamTracks: audio.context.destination.stream.getAudioTracks().length,
        subStreamTracks: audio.routingGraph.outputDestinations.sub.stream.getAudioTracks().length,
        headphonesStreamTracks: audio.routingGraph.outputDestinations.headphones.stream.getAudioTracks().length,
        monitorStreamTracks: monitorTap.stream.getAudioTracks().length,
      };
    } catch (error) {
      result.status = 'FAIL';
      result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      result.syntheticInputTopology = syntheticInputTopology();
      result.contextSafety = contextSafety();
      result.metricsAtFailure = copyMetrics();
      result.ioSnapshot = engine.getBrowserIoSnapshot();
      result.latencyInfo = engine.getLatencyInfo();
      try {
        result.sharedDspFailureDiagnosticsAtFailure = await audio.realtimeRuntime?.getSharedDspFailureDiagnostics(1_500) ?? null;
      } catch (diagnosticError) {
        result.sharedDspFailureDiagnosticsError = diagnosticError instanceof Error
          ? diagnosticError.message : String(diagnosticError);
      }
    }
    return result;
  }, singleContextSyntheticInput);

  result.assertions = smoke.assertions;
  result.syntheticInputTopology = smoke.syntheticInputTopology ?? null;
  result.validationConfig.quantumFrames = smoke.validationConfig?.quantumFrames ?? null;
  await sharedDspResponsePromise;
  const loadedSharedDspMatchesManifest = result.sharedDspBuild.runtimeResponse?.matchesManifest === true;
  smoke.assertions.push({
    name: 'the Browser fetched the exact shared-DSP module named by its build manifest',
    passed: loadedSharedDspMatchesManifest,
    details: { sharedDspBuild: result.sharedDspBuild },
  });
  if (!loadedSharedDspMatchesManifest && smoke.status === 'PASS') {
    smoke.status = 'FAIL';
    smoke.error = 'The runtime shared-DSP response was absent or did not match the pinned build manifest.';
  }
  result.softwareSmoke = smoke;
  result.status = smoke.status;
  if (smoke.status === 'PASS' && smoke.projectMemoryReload?.slot) {
    await page.reload({ waitUntil: 'networkidle' });
    let reloadedEngineReady = false;
    const reloadDeadline = Date.now() + 30_000;
    while (Date.now() < reloadDeadline) {
      reloadedEngineReady = await page.evaluate(async () => {
        const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
        const engine = AudioEngine.getInstance();
        const status = engine.getUiStatus();
        return status.ready && status.lastError.length === 0;
      });
      if (reloadedEngineReady) break;
      await page.waitForTimeout(100);
    }
    if (!reloadedEngineReady) throw new Error('Browser audio did not initialize after the real IndexedDB reload.');
    result.projectMemoryReload = await page.evaluate(async ({ slot, expectedPcm, expectedBankId, expectedRhythmPreset }) => {
      const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
      const { controlCommandDispatcher } = await import('/src/composables/useControlDispatcher.ts');
      const engine = AudioEngine.getInstance();
      engine.setControlStateAdapter({
        read: () => controlCommandDispatcher.getState(),
        apply: (state) => controlCommandDispatcher.setState(state),
      });
      const service = engine.getProjectService();
      const document = await service.loadMemory(slot);
      const audio = engine.browser;
      const metrics = audio.getRealtimeMetrics();
      const hashes = await Promise.all(audio.tracks.map(async (track, index) => {
        if (!expectedPcm[index]) return null;
        const buffer = await track.exportAudioBuffer();
        let hash = 2_166_136_261;
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          const samples = buffer.getChannelData(channel);
          const words = new Uint32Array(samples.buffer, samples.byteOffset, samples.length);
          for (let frame = 0; frame < words.length; frame += 1) hash = Math.imul(hash ^ words[frame], 16_777_619) >>> 0;
        }
        return { frames: buffer.length, channels: buffer.numberOfChannels, fnv1a32: hash.toString(16).padStart(8, '0') };
      }));
      const route = audio.getRoutingState().routes.find((entry) => entry.sourceId === 'capture' && entry.sourceChannel === 0);
      const dispatcher = controlCommandDispatcher.getState();
      const restoredRhythmPreset = document.extensions.rhythm?.cleanRoomPreset ?? null;
      const runtimeRhythmPreset = audio.getRhythmSnapshot().cleanRoomPreset;
      const rhythmPresetExact = JSON.stringify(restoredRhythmPreset) === JSON.stringify(expectedRhythmPreset) &&
        JSON.stringify(runtimeRhythmPreset) === JSON.stringify(expectedRhythmPreset);
      const pcmExact = JSON.stringify(hashes) === JSON.stringify(expectedPcm);
      const loopSettings = audio.getLoopSettings();
      return {
        slot,
        pass: pcmExact && document.global.bpm === 93 && loopSettings.bpm === 93 &&
          document.global.masterTrackId === 1 && loopSettings.masterTrackId === 1 &&
          audio.tracks[0].getRuntimeSettings().reverse === true && audio.tracks[0].getRuntimeSettings().speed === 1.25 &&
          audio.getMixerState().masterLevel === 0.8 && audio.getActiveFxBankId() === expectedBankId &&
          audio.getFxBanks().find((bank) => bank.id === expectedBankId)?.track[0]?.type === 'FILTER' &&
          route?.mainGain === 0.35 && dispatcher.assignments[0]?.number === 21 && rhythmPresetExact,
        pcmExact,
        expectedRhythmPreset, restoredRhythmPreset, runtimeRhythmPreset, rhythmPresetExact,
        expectedPcm,
        restoredPcm: hashes,
        bpm: loopSettings.bpm,
        masterTrackId: loopSettings.masterTrackId,
        runtimeSettings: audio.tracks[0].getRuntimeSettings(),
        mixer: audio.getMixerState(),
        activeBankId: audio.getActiveFxBankId(),
        bankFx: audio.getFxBanks().find((bank) => bank.id === expectedBankId)?.track[0] ?? null,
        routeMainGain: route?.mainGain ?? null,
        controlAssignment: dispatcher.assignments[0] ?? null,
        renderedFrame: metrics?.renderedFrame ?? null,
      };
    }, smoke.projectMemoryReload);
    if (!result.projectMemoryReload.pass) {
      result.status = 'FAIL';
      browserError = 'Real IndexedDB reload did not restore the saved project PCM and settings.';
      result.error = browserError;
    }
  }
  const stressMinutes = Number(process.env.WEBRC_STRESS_MINUTES || 0);
  if (Number.isFinite(stressMinutes) && stressMinutes > 0 && !browserError && result.status === 'PASS') {
    result.sustainedStress = await runBrowserStress32Fx({
      page,
      minutes: stressMinutes,
      outputDirectory: process.env.WEBRC_STRESS_OUTPUT_DIR,
    });
  }
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
        syntheticInputUniqueContextCount: new Set((window.__webrcSyntheticContexts || []).map((record) => record.context)).size,
        syntheticInputUsesProjectContext: Boolean(window.__webrcProjectAudioContext) &&
          (window.__webrcSyntheticContexts || []).every((record) => record.context === window.__webrcProjectAudioContext),
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
  result.outputFile = process.env.WEBRC_BROWSER_SMOKE_OUTPUT ||
    join(process.env.TEMP || tmpdir(), `webrc505-browser-realtime-smoke-${safeTimestamp}.json`);
  mkdirSync(dirname(result.outputFile), { recursive: true });
  writeFileSync(result.outputFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ status: result.status, outputFile: result.outputFile, error: result.error || null }));
}

if (browserError) process.exitCode = 1;
