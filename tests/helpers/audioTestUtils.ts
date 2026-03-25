class MockAudioParam {
  public value: number;

  constructor(value = 0) {
    this.value = value;
  }

  public setTargetAtTime(value: number) {
    this.value = value;
  }

  public setValueAtTime(value: number) {
    this.value = value;
  }

  public exponentialRampToValueAtTime(value: number) {
    this.value = value;
  }
}

class MockAudioNode {
  public connect(_target?: unknown) {
    return;
  }

  public disconnect() {
    return;
  }
}

class MockGainNode extends MockAudioNode {
  public gain = new MockAudioParam(1);
}

class MockStereoPannerNode extends MockAudioNode {
  public pan = new MockAudioParam(0);
}

class MockDelayNode extends MockAudioNode {
  public delayTime = new MockAudioParam(0);
}

class MockBiquadFilterNode extends MockAudioNode {
  public type: BiquadFilterType = 'lowpass';
  public frequency = new MockAudioParam(20_000);
  public Q = new MockAudioParam(1);
}

class MockDynamicsCompressorNode extends MockAudioNode {
  public threshold = new MockAudioParam(-24);
  public knee = new MockAudioParam(30);
  public ratio = new MockAudioParam(12);
  public attack = new MockAudioParam(0.003);
  public release = new MockAudioParam(0.25);
}

class MockConvolverNode extends MockAudioNode {
  public buffer: AudioBuffer | null = null;
}

class MockOscillatorNode extends MockAudioNode {
  public frequency = new MockAudioParam(440);
  public type: OscillatorType = 'sine';

  public start() {
    return;
  }

  public stop() {
    return;
  }
}

class MockBufferSourceNode extends MockAudioNode {
  public buffer: AudioBuffer | null = null;
  public loop = false;
  public playbackRate = new MockAudioParam(1);

  public start() {
    return;
  }

  public stop() {
    return;
  }
}

class MockScriptProcessorNode extends MockAudioNode {
  public onaudioprocess: ((event: unknown) => void) | null = null;
}

class MockMediaStreamSourceNode extends MockAudioNode {}

class MockAudioBuffer {
  public readonly numberOfChannels: number;
  public readonly length: number;
  public readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  public get duration() {
    return this.length / this.sampleRate;
  }

  public getChannelData(channel: number) {
    return this.channels[channel] ?? new Float32Array(this.length);
  }

  public copyToChannel(source: Float32Array, channel: number) {
    this.getChannelData(channel).set(source);
  }
}

export function createMockAudioContext() {
  const sampleRate = 44_100;

  return {
    state: 'running',
    sampleRate,
    currentTime: 0,
    baseLatency: 0.01,
    destination: new MockAudioNode() as unknown as AudioDestinationNode,
    audioWorklet: {
      addModule: async () => undefined,
    },
    resume: async () => undefined,
    createGain: () => new MockGainNode() as unknown as GainNode,
    createStereoPanner: () => new MockStereoPannerNode() as unknown as StereoPannerNode,
    createDelay: () => new MockDelayNode() as unknown as DelayNode,
    createBiquadFilter: () => new MockBiquadFilterNode() as unknown as BiquadFilterNode,
    createDynamicsCompressor: () => new MockDynamicsCompressorNode() as unknown as DynamicsCompressorNode,
    createConvolver: () => new MockConvolverNode() as unknown as ConvolverNode,
    createOscillator: () => new MockOscillatorNode() as unknown as OscillatorNode,
    createBufferSource: () => new MockBufferSourceNode() as unknown as AudioBufferSourceNode,
    createScriptProcessor: () => new MockScriptProcessorNode() as unknown as ScriptProcessorNode,
    createMediaStreamSource: () => new MockMediaStreamSourceNode() as unknown as MediaStreamAudioSourceNode,
    createBuffer: (channels: number, length: number, rate: number) =>
      new MockAudioBuffer(channels, length, rate) as unknown as AudioBuffer,
  } as unknown as AudioContext;
}
