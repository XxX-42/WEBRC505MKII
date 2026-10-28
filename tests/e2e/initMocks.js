(() => {
  class MockAudioParam {
    constructor(value = 0) {
      this.value = value;
    }

    setTargetAtTime(value) {
      this.value = value;
    }

    setValueAtTime(value) {
      this.value = value;
    }

    exponentialRampToValueAtTime(value) {
      this.value = value;
    }
  }

  class MockAudioNode {
    connect() {
      return undefined;
    }

    disconnect() {
      return undefined;
    }
  }

  class MockGainNode extends MockAudioNode {
    constructor() {
      super();
      this.gain = new MockAudioParam(1);
    }
  }

  class MockStereoPannerNode extends MockAudioNode {
    constructor() {
      super();
      this.pan = new MockAudioParam(0);
    }
  }

  class MockDelayNode extends MockAudioNode {
    constructor() {
      super();
      this.delayTime = new MockAudioParam(0);
    }
  }

  class MockBiquadFilterNode extends MockAudioNode {
    constructor() {
      super();
      this.type = 'lowpass';
      this.frequency = new MockAudioParam(20000);
      this.Q = new MockAudioParam(1);
    }
  }

  class MockDynamicsCompressorNode extends MockAudioNode {
    constructor() {
      super();
      this.threshold = new MockAudioParam(-24);
      this.knee = new MockAudioParam(30);
      this.ratio = new MockAudioParam(12);
      this.attack = new MockAudioParam(0.003);
      this.release = new MockAudioParam(0.25);
    }
  }

  class MockConvolverNode extends MockAudioNode {
    constructor() {
      super();
      this.buffer = null;
    }
  }

  class MockOscillatorNode extends MockAudioNode {
    constructor() {
      super();
      this.frequency = new MockAudioParam(440);
      this.type = 'sine';
    }

    start() {}
    stop() {}
  }

  class MockBufferSourceNode extends MockAudioNode {
    constructor() {
      super();
      this.buffer = null;
      this.loop = false;
      this.playbackRate = new MockAudioParam(1);
    }

    start() {}
    stop() {}
  }

  class MockScriptProcessorNode extends MockAudioNode {
    constructor() {
      super();
      this.onaudioprocess = null;
    }
  }

  // TrackAudio adds an independent, silent two-channel meter branch to each
  // track after the shared post-fader FX routing was introduced. Preserve the
  // real WebAudio API surface used by that route in application E2E tests.
  class MockChannelSplitterNode extends MockAudioNode {}

  class MockAnalyserNode extends MockAudioNode {
    constructor() {
      super();
      this.fftSize = 2048;
      this.smoothingTimeConstant = 0.8;
      this.channelCount = 2;
      this.channelCountMode = 'max';
    }

    getFloatTimeDomainData(samples) {
      samples.fill(0);
    }
  }

  class MockAudioBuffer {
    constructor(channels, length, sampleRate) {
      this.numberOfChannels = channels;
      this.length = length;
      this.sampleRate = sampleRate;
      this.duration = length / sampleRate;
      this._channels = Array.from({ length: channels }, () => new Float32Array(length));
    }

    getChannelData(channel) {
      return this._channels[channel];
    }

    copyToChannel(source, channel) {
      this._channels[channel].set(source);
    }
  }

  class MockAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 44100;
      this.currentTime = 0;
      this.baseLatency = 0.01;
      this.destination = new MockAudioNode();
      this.audioWorklet = {
        addModule: async () => undefined,
      };
    }

    resume() {
      this.state = 'running';
      return Promise.resolve();
    }

    createGain() {
      return new MockGainNode();
    }

    createStereoPanner() {
      return new MockStereoPannerNode();
    }

    createDelay() {
      return new MockDelayNode();
    }

    createBiquadFilter() {
      return new MockBiquadFilterNode();
    }

    createDynamicsCompressor() {
      return new MockDynamicsCompressorNode();
    }

    createConvolver() {
      return new MockConvolverNode();
    }

    createOscillator() {
      return new MockOscillatorNode();
    }

    createBufferSource() {
      return new MockBufferSourceNode();
    }

    createScriptProcessor() {
      return new MockScriptProcessorNode();
    }

    createMediaStreamSource() {
      return new MockAudioNode();
    }

    createChannelSplitter() {
      return new MockChannelSplitterNode();
    }

    createAnalyser() {
      return new MockAnalyserNode();
    }

    createBuffer(channels, length, sampleRate) {
      return new MockAudioBuffer(channels, length, sampleRate);
    }
  }

  class MockAudioWorkletNode extends MockAudioNode {
    constructor(context, processorName, options = {}) {
      super();
      this.context = context;
      this.name = processorName;
      this.processorOptions = options.processorOptions || {};
      const mockNode = this;
      let onmessage = null;
      let inputGeneration = 0;
      let captureReadyEpoch = 0;
      let inputCaptureReady = false;
      let monoSemitones = Number.isFinite(this.processorOptions.semitones)
        ? this.processorOptions.semitones
        : 0;
      if (pitchUiE2e && processorName === 'rc505-live-mono-pitch') {
        window.__rc505LivePitchNodeCreations.push({
          processorName,
          processorOptions: { ...this.processorOptions },
        });
      }
      this.port = {
        get onmessage() { return onmessage; },
        set onmessage(handler) {
          onmessage = handler;
          if (pitchUiE2e && processorName === 'rc505-live-mono-pitch' && typeof handler === 'function') {
            // Synthetic ready ack for the UI-to-worklet boundary only. DSP
            // execution is covered separately by the real Browser DSP tests.
            queueMicrotask(() => handler({ data: {
              type: 'ready',
              sampleRate: mockNode.context.sampleRate,
              latencySamples: 2206,
              latencySeconds: 2206 / mockNode.context.sampleRate,
              semitones: monoSemitones,
              voiced: false,
              frequencyHz: 0,
              confidence: 0,
            } }));
          }
        },
        close: () => undefined,
        postMessage: (message) => {
          // Test-only observation point for proving UI controls reach the
          // AudioWorklet adapter. Real DSP execution is covered by the
          // unmocked browser-fx-audio-worklet tests.
          window.__rc505AudioWorkletMessages.push({
            processorName,
            algorithm: mockNode.processorOptions.algorithm || null,
            message,
          });
          if (pitchUiE2e && processorName === 'rc505-live-mono-pitch' && message?.type === 'set-semitones') {
            monoSemitones = message.semitones;
          }
          if (pitchUiE2e && processorName === 'rc505-live-mono-pitch' && message?.type === 'get-status') {
            queueMicrotask(() => {
              if (onmessage) onmessage({ data: {
                type: 'status',
                requestId: message.requestId,
                sampleRate: mockNode.context.sampleRate,
                latencySamples: 2206,
                latencySeconds: 2206 / mockNode.context.sampleRate,
                semitones: monoSemitones,
                voiced: false,
                frequencyHz: 0,
                confidence: 0,
              } });
            });
          }
          if (processorName === 'rc505-input-capture' && message?.type === 'INPUT_READY'
            && Number.isSafeInteger(message.generation) && message.generation > inputGeneration) {
            inputGeneration = message.generation;
            captureReadyEpoch = 0;
            inputCaptureReady = message.ready === true;
          }
          if (processorName === 'rc505-input-capture' && message?.type === 'INPUT_READY' && message.ready === true) {
            // The application E2E suites intentionally replace AudioContext
            // and AudioWorkletNode. Give that mocked input-capture node a
            // coherent synthetic pre-roll handshake; exact frame capture is
            // verified separately with the real Chromium AudioWorklet.
            const preRollCapacityFrames = mockNode.processorOptions.preRollFrames;
            const requiredPreRollFrames = Number.isSafeInteger(preRollCapacityFrames)
              ? preRollCapacityFrames
              : 8_192;
            queueMicrotask(() => {
              if (onmessage) onmessage({ data: {
                type: 'INPUT_CAPTURE_READY',
                inputGeneration,
                sampleRate: mockNode.context.sampleRate,
                captureReadyEpoch,
                oldestAvailableFrame: 0,
                latestAvailableFrame: requiredPreRollFrames,
                preRollValidFrames: requiredPreRollFrames,
                preRollCapacityFrames: requiredPreRollFrames,
                requiredPreRollFrames,
              } });
            });
          }
          if (processorName === 'rc505-input-capture' && message?.type === 'CHECK_CAPTURE_READINESS') {
            // Match the real worklet's message-ordered readiness query. A
            // synthetic READY above represents a fully warmed pre-roll ring.
            const preRollCapacityFrames = mockNode.processorOptions.preRollFrames;
            const requiredPreRollFrames = Number.isSafeInteger(preRollCapacityFrames)
              ? preRollCapacityFrames
              : 8_192;
            queueMicrotask(() => {
              if (onmessage) onmessage({ data: {
                type: 'CAPTURE_READINESS_STATE',
                inputGeneration,
                captureReadyEpoch,
                sampleRate: mockNode.context.sampleRate,
                ready: inputCaptureReady,
                oldestAvailableFrame: 0,
                latestAvailableFrame: inputCaptureReady ? requiredPreRollFrames : 0,
                preRollValidFrames: inputCaptureReady ? requiredPreRollFrames : 0,
                requiredPreRollFrames,
              } });
            });
          }
          if (message && message.type === 'STOP_RECORD' && this.port.onmessage) {
            this.port.onmessage({
              data: {
                type: 'RECORD_COMPLETE',
                buffer: new Float32Array(44100),
              },
            });
          }
        },
      };
    }

    addEventListener() {}
  }

  window.__rc505AudioWorkletMessages = [];

  // This opt-in path belongs only to the focused LIVE KEEP PITCH E2E. Keep the
  // default recording response below unchanged for the legacy one-track cases.
  const pitchUiE2e = new URLSearchParams(window.location.search).get('pitchUiE2e') === '1';
  window.__rc505NativePitchRequests = [];
  window.__rc505NativePitchAcks = [];
  window.__rc505LivePitchNodeCreations = [];

  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    writable: true,
    value: MockAudioContext,
  });
  Object.defineProperty(window, 'webkitAudioContext', {
    configurable: true,
    writable: true,
    value: MockAudioContext,
  });
  Object.defineProperty(window, 'AudioWorkletNode', {
    configurable: true,
    writable: true,
    value: MockAudioWorkletNode,
  });
  Object.defineProperty(window, 'confirm', {
    configurable: true,
    writable: true,
    value: () => true,
  });

  const createMockAudioTrack = () => {
    const listeners = new Map();
    return {
      kind: 'audio',
      readyState: 'live',
      addEventListener(type, listener) {
        const entries = listeners.get(type) ?? new Set();
        entries.add(listener);
        listeners.set(type, entries);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      // MediaStreamTrack.stop() changes readyState but does not dispatch ended.
      stop() {
        this.readyState = 'ended';
      },
    };
  };
  const mediaDevices = {
    getUserMedia: async () => {
      const tracks = [createMockAudioTrack()];
      return {
        getTracks: () => tracks,
        getAudioTracks: () => tracks,
      };
    },
    enumerateDevices: async () => ([
      { deviceId: 'mic-1', kind: 'audioinput', label: 'Mock Input' },
      { deviceId: 'out-1', kind: 'audiooutput', label: 'Mock Output' },
    ]),
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: mediaDevices,
  });

  const nativeStatus = {
    ok: true,
    bridgeHealthy: true,
    engineRunning: true,
    backend: 'WASAPI',
    inputDeviceId: 'mic-1',
    outputDeviceId: 'out-1',
    inputDeviceName: 'Mock Input',
    outputDeviceName: 'Mock Output',
    sampleRate: 48000,
    bufferFrames: 128,
    monitoringEnabled: false,
    state: 'Stopped',
    inputLatencyMs: 5,
    outputLatencyMs: 5,
    roundTripEstimateMs: 10,
    inputPeak: 0.05,
    outputPeak: 0.05,
    xrunsOrDropouts: 0,
    lastError: '',
    loopProgress: 0,
  };

  const nativeTrackFxUiE2e = new URLSearchParams(window.location.search).get('nativeTrackFxUiE2e') === '1';
  window.__rc505NativeCatalogSlotRequests = [];
  if (nativeTrackFxUiE2e && new URLSearchParams(window.location.search).get('audio') === 'native') {
    const makeSlotStatus = (slot, effectId = '') => ({
      slot,
      effectId,
      bypassed: effectId === 'phaser',
      appliedBypassed: effectId === 'phaser',
      prepared: effectId !== '',
      processingFaulted: false,
      controlFaulted: false,
      requestedRevision: effectId === 'phaser' ? 1 : 0,
      appliedRevision: effectId === 'phaser' ? 1 : 0,
    });
    const perTrackCatalogBanks = Array.from({ length: 5 }, (_, index) => ({
      trackId: index + 1,
      slots: ['A', 'B', 'C', 'D'].map((slot) => makeSlotStatus(slot, index === 1 && slot === 'B' ? 'phaser' : '')),
      midiSlots: [],
    }));
    // The physical shared TRACK FX knob needs an installed effect too. Seed
    // the app's saved editor state and the matching bridge status together so
    // this fixture exercises real enabled-control behavior in both contexts.
    const nativeSharedSlots = ['A', 'B', 'C', 'D'].map((id) => ({
      id,
      type: id === 'A' ? 'PHASER' : '',
      value: 0,
      active: false,
    }));
    localStorage.setItem('webrc505_native_fx_catalog', JSON.stringify({ inputSlots: [], trackSlots: nativeSharedSlots }));
    nativeStatus.nativeLooperTrackCount = 5;
    nativeStatus.nativeLooperMultiTrackImplemented = true;
    nativeStatus.nativeTracks = Array.from({ length: 5 }, (_, index) => ({
      trackId: index + 1,
      state: 'Empty',
      loopProgress: 0,
    }));
    nativeStatus.nativeFx = {
      implementedCatalogEffects: ['phaser'],
      catalogEffectAvailability: [{ effectId: 'phaser', input: false, track: true, perTrackInsert: true }],
      catalogGraphAvailable: true,
      perTrackCatalogAvailable: true,
      perTrackCatalogBanks,
      catalogSlots: ['A', 'B', 'C', 'D'].map((slot) => makeSlotStatus(slot, slot === 'A' ? 'phaser' : '')),
      inputCatalogSlots: ['A', 'B', 'C', 'D'].map((slot) => makeSlotStatus(slot)),
    };
  }

  if (pitchUiE2e && new URLSearchParams(window.location.search).get('audio') === 'native') {
    // Advertise multi-track support only in the explicit mock-bridge scenario.
    // The ordinary Native fixture still exercises the legacy one-track fallback.
    nativeStatus.nativeLooperTrackCount = 5;
    nativeStatus.nativeLooperMultiTrackImplemented = true;
    nativeStatus.nativeTracks = Array.from({ length: 5 }, (_, index) => ({
      trackId: index + 1,
      state: 'Empty',
      loopProgress: 0,
    }));
  }

  const rhythmUiE2e = new URLSearchParams(window.location.search).get('rhythmUiE2e') === '1';
  window.__rc505NativeRhythmRequests = [];
  if (rhythmUiE2e) {
    nativeStatus.nativeRhythm = {
      available: true, enabled: false, bpm: 93, patternIndex: 198, kitIndex: 13,
      variation: 'C', section: 'intro', swingPercent: 67, quantizeGrid: '1/8', volume: 73,
      patternCatalogAvailable: true, patternId: 'rhythm-198', genre: 'ELCTRO', pattern: 'ELCTRO1', beat: '4/4',
      meterNumerator: 4, meterDenominator: 4, eventsCleanRoomProcedural: true,
      patternSource: 'metadata-only-240-pattern-catalog', statusNote: 'TEST-ONLY clean-room Native rhythm fixture',
    };
    window.__rc505NativeRhythmState = nativeStatus.nativeRhythm;
  }

  const originalFetch = window.fetch?.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('http://127.0.0.1:18755')) {
      if (!originalFetch) {
        throw new Error(`Unexpected fetch without original handler: ${url}`);
      }
      return originalFetch(input, init);
    }

    const path = url.replace('http://127.0.0.1:18755', '');
    if (path === '/health') {
      return { json: async () => ({ ok: true, version: 'mock', engineRunning: true, backends: ['WASAPI'], lastError: '' }) };
    }
    if (path === '/v1/devices') {
      return {
        json: async () => ({
          ok: true,
          backends: ['WASAPI'],
          inputsByBackend: { WASAPI: [{ id: 'mic-1', name: 'Mock Input', sampleRates: [48000], isDefault: true }] },
          outputsByBackend: { WASAPI: [{ id: 'out-1', name: 'Mock Output', sampleRates: [48000], isDefault: true }] },
          defaultInputIdByBackend: { WASAPI: 'mic-1' },
          defaultOutputIdByBackend: { WASAPI: 'out-1' },
          bufferOptions: [128, 256],
        }),
      };
    }
    if (path === '/v1/status' || path === '/v1/config/apply' || path === '/v1/engine/start') {
      return { json: async () => nativeStatus };
    }
    if (path === '/v1/transport/record') {
      nativeStatus.state = 'Recording';
      return { json: async () => nativeStatus };
    }
    if (path === '/v1/transport/play') {
      nativeStatus.state = 'Playing';
      return { json: async () => nativeStatus };
    }
    if (path === '/v1/transport/stop') {
      nativeStatus.state = 'Stopped';
      return { json: async () => nativeStatus };
    }
    if (path === '/v1/transport/overdub-toggle') {
      nativeStatus.state = nativeStatus.state === 'Overdubbing' ? 'Playing' : 'Overdubbing';
      return { json: async () => nativeStatus };
    }
    if (path === '/v1/transport/clear') {
      nativeStatus.state = 'Empty';
      return { json: async () => nativeStatus };
    }
    if (path === '/v1/monitoring') {
      const body = init && init.body ? JSON.parse(String(init.body)) : { enabled: false };
      nativeStatus.monitoringEnabled = Boolean(body.enabled);
      return { json: async () => nativeStatus };
    }
    if (path === '/v1/native-fx/catalog-slot' && nativeTrackFxUiE2e) {
      const config = init && init.body ? JSON.parse(String(init.body)) : {};
      window.__rc505NativeCatalogSlotRequests.push(config);
      const targetSlots = config.trackId
        ? nativeStatus.nativeFx?.perTrackCatalogBanks?.find((bank) => bank.trackId === config.trackId)?.slots
        : config.path === 'input' ? nativeStatus.nativeFx?.inputCatalogSlots : nativeStatus.nativeFx?.catalogSlots;
      const slot = targetSlots?.find((item) => item.slot === config.slot);
      if (slot) {
        slot.effectId = config.effectId || '';
        slot.bypassed = Boolean(config.bypassed);
        slot.appliedBypassed = Boolean(config.bypassed);
        slot.prepared = Boolean(config.effectId);
        slot.requestedRevision += 1;
        slot.appliedRevision = slot.requestedRevision;
      }
      return { json: async () => ({ ...nativeStatus }) };
    }
    if (path === '/v1/native-rhythm/config' && rhythmUiE2e) {
      const config = init && init.body ? JSON.parse(String(init.body)) : {};
      window.__rc505NativeRhythmRequests.push(config);
      if (window.__rc505RejectNativeRhythmConfig) {
        return { json: async () => ({ ok: false, error: 'Native rhythm configuration rejected by test bridge' }) };
      }
      Object.assign(nativeStatus.nativeRhythm, config);
      return { json: async () => nativeStatus };
    }
    if (path === '/v1/native-pitch/config' && pitchUiE2e) {
      const config = init && init.body ? JSON.parse(String(init.body)) : {};
      window.__rc505NativePitchRequests.push(config);
      const mode = config.mode === 'livePolyPhaseVocoder' ? 'livePolyPhaseVocoder' : 'liveMonoKeepPitch';
      const acknowledgement = {
        pitchCorrectionAvailable: true,
        pitchCorrectionImplemented: true,
        enabled: Boolean(config.enabled),
        active: Boolean(config.enabled),
        trackId: Number.isInteger(config.trackId) ? config.trackId : 0,
        reversePlayback: Boolean(config.reversePlayback),
        mode,
        algorithm: mode === 'livePolyPhaseVocoder' ? 'signalsmithStretch132Cheaper' : 'cleanRoomYinPsola',
        semitones: Number.isFinite(config.semitones) ? config.semitones : 0,
        frequencyHz: 0,
        confidence: 0,
        voiced: false,
        latencySamples: mode === 'livePolyPhaseVocoder' ? 6720 : 2206,
        fallbackReason: 'none',
        statusNote: `TEST-ONLY MOCK BRIDGE ACK for track ${config.trackId}`,
      };
      window.__rc505NativePitchAcks.push(acknowledgement);
      nativeStatus.nativePitch = acknowledgement;
      return { json: async () => ({ ...nativeStatus }) };
    }

    return { json: async () => ({ ok: true }) };
  };
})();
