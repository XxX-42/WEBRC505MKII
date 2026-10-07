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

    linearRampToValueAtTime(value) {
      this.value = value;
    }

    cancelScheduledValues() {}
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
    constructor(options = {}) {
      this.state = 'running';
      this.sampleRate = options.sampleRate || 48000;
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

    async close() { this.state = 'closed'; }

    async setSinkId() {}

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

    createMediaStreamSource() {
      return new MockAudioNode();
    }

    createBuffer(channels, length, sampleRate) {
      return new MockAudioBuffer(channels, length, sampleRate);
    }
  }

  // UI-only control acknowledgements. This fixture renders no samples and must
  // never be used by a latency, dropout, or instrument-grade benchmark.
  class MockAudioWorkletNode extends MockAudioNode {
    constructor(_context, _name, options = {}) {
      super();
      this.parameters = new Map();
      const buffer = options.processorOptions?.controlBuffer;
      const control = buffer ? new Int32Array(buffer) : null;
      this.port = {
        onmessage: null,
        start() {},
        close: () => window.clearInterval(this.controlTimer),
        postMessage: (message) => {
          if (message?.type === 'ATTACH_TRACK') {
            queueMicrotask(() => {
              this.port.onmessage?.({ data: { type: 'TRACK_ATTACHED', track: message.track } });
            });
          }
        },
      };
      if (control) {
        this.controlTimer = window.setInterval(() => {
          let read = Atomics.load(control, 0);
          const write = Atomics.load(control, 1);
          while (read !== write) {
            // Protocol header: 96 bytes; each command: eight Int32 words.
            const offset = 24 + (read % 256) * 8;
            const executedFrame = (control[offset + 4] >>> 0) * 4294967296 + (control[offset + 3] >>> 0);
            const sequence = control[offset] >>> 0;
            Atomics.store(control, 6, sequence);
            this.port.onmessage?.({ data: {
              type: 'ACK', sequence, opcode: control[offset + 1], track: control[offset + 2],
              executedFrame, targetFrame: executedFrame, status: 0, loopFrames: 0, recordingFrames: 0,
            } });
            read += 1;
          }
          Atomics.store(control, 0, read);
        }, 10);
      }
    }
  }

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

  const mediaDevices = {
    getUserMedia: async () => ({
      getTracks: () => [{ stop() {}, getSettings() { return { sampleRate: 48000, channelCount: 1, deviceId: 'mic-1' }; } }],
      getAudioTracks: () => [{ stop() {}, getSettings() { return { sampleRate: 48000, channelCount: 1, deviceId: 'mic-1' }; } }],
    }),
    getSupportedConstraints: () => ({ latency: true, sampleRate: true, channelCount: true }),
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

  const originalFetch = window.fetch?.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('http://127.0.0.1:17755')) {
      if (!originalFetch) {
        throw new Error(`Unexpected fetch without original handler: ${url}`);
      }
      return originalFetch(input, init);
    }

    const path = url.replace('http://127.0.0.1:17755', '');
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

    return { json: async () => ({ ok: true }) };
  };
})();
