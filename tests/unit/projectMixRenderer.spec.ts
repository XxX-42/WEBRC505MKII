import { describe, expect, it } from 'vitest';
import { createDefaultProjectDocument } from '../../src/project/projectValidation';
import {
  BOUNCE_CAPTURE_HEADER_BYTES,
  BOUNCE_CAPTURE_HEADER_WORDS,
  BounceCaptureState,
  BounceCaptureWord,
} from '../../src/project/bounceCaptureProtocol';
import {
  ProjectMixRenderer,
  estimateProjectMixRenderBytes,
  getEffectiveProjectTrackSpeed,
  getProjectMixDefaultDurationFrames,
  isProjectTrackPitchPreserved,
  type ProjectMixRenderOptions,
} from '../../src/project/projectMixRenderer';

function makeAudioBuffer(length: number, sampleRate = 48_000, channels = 2): AudioBuffer {
  const pcm = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    length,
    sampleRate,
    numberOfChannels: channels,
    duration: length / sampleRate,
    getChannelData(channel: number) { return pcm[channel]!; },
    copyFromChannel() {},
    copyToChannel() {},
  } as unknown as AudioBuffer;
}

function makeOptions(overrides: Partial<ProjectMixRenderOptions> = {}): ProjectMixRenderOptions {
  const document = createDefaultProjectDocument();
  const audioByTrackId = new Map([[1, makeAudioBuffer(1_000)]]);
  return {
    context: { sampleRate: 48_000 } as BaseAudioContext,
    document,
    audioByTrackId,
    selectedTrackIds: [1],
    durationFrames: 1_000,
    createTrackFxGraph: async () => null,
    createSelectedTrackFxGraph: async () => null,
    createMasterFxGraph: async () => null,
    ...overrides,
  };
}

class FakeAudioParam {
  setValueAtTime() {}
  linearRampToValueAtTime() {}
}

class FakeAudioNode {
  connect() {}
  disconnect() {}
}

class FakeOfflineAudioContext {
  static createdSources: AudioBufferSourceNode[] = [];
  readonly destination = new FakeAudioNode() as unknown as AudioNode;
  readonly currentTime = 0;
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
  }

  createGain() {
    return Object.assign(new FakeAudioNode(), { gain: new FakeAudioParam() }) as unknown as GainNode;
  }

  createStereoPanner() {
    return Object.assign(new FakeAudioNode(), { pan: new FakeAudioParam() }) as unknown as StereoPannerNode;
  }

  createBufferSource() {
    const source = Object.assign(new FakeAudioNode(), {
      loop: false,
      buffer: null as AudioBuffer | null,
      playbackRate: new FakeAudioParam(),
      start() {},
      stop() {},
    }) as unknown as AudioBufferSourceNode;
    FakeOfflineAudioContext.createdSources.push(source);
    return source;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
    return makeAudioBuffer(length, sampleRate, numberOfChannels);
  }

  async startRendering(): Promise<AudioBuffer> {
    return makeAudioBuffer(this.length, this.sampleRate);
  }
}

async function withFakeRealtimeGlobals<T>(action: () => Promise<T>): Promise<T> {
  const scope = globalThis as typeof globalThis & { AudioWorkletNode?: typeof AudioWorkletNode };
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
  class FakeAudioWorkletNode extends FakeAudioNode {
    port = { postMessage() {} };
    onprocessorerror: (() => void) | null = null;

    constructor(_context: BaseAudioContext, _name: string, options: AudioWorkletNodeOptions) {
      super();
      const processorOptions = options.processorOptions as { buffer: SharedArrayBuffer; targetFrames: number };
      const header = new Int32Array(processorOptions.buffer, 0, BOUNCE_CAPTURE_HEADER_WORDS);
      const ring = new Float32Array(processorOptions.buffer, BOUNCE_CAPTURE_HEADER_BYTES);
      const targetFrames = processorOptions.targetFrames;
      const chunkFrames = Atomics.load(header, BounceCaptureWord.CHUNK_FRAMES);
      const slotCount = Atomics.load(header, BounceCaptureWord.SLOT_COUNT);
      ring.fill(0);
      let remaining = targetFrames;
      let sequence = 0;
      while (remaining > 0) {
        const slot = sequence % slotCount;
        const length = Math.min(remaining, chunkFrames);
        Atomics.store(header, BounceCaptureWord.SLOT_LENGTHS + slot, length);
        remaining -= length;
        sequence += 1;
      }
      Atomics.store(header, BounceCaptureWord.STATE, BounceCaptureState.COMPLETE);
      Atomics.store(header, BounceCaptureWord.CAPTURED_FRAMES, targetFrames);
      Atomics.store(header, BounceCaptureWord.WRITE_SEQUENCE, sequence);
    }
  }

  Object.defineProperty(scope, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode });
  try {
    return await action();
  } finally {
    if (prior) Object.defineProperty(scope, 'AudioWorkletNode', prior);
    else delete scope.AudioWorkletNode;
  }
}

async function withFakeOfflineContext(action: () => Promise<void>): Promise<void> {
  const scope = globalThis as typeof globalThis & { OfflineAudioContext?: typeof OfflineAudioContext };
  const prior = scope.OfflineAudioContext;
  Object.defineProperty(scope, 'OfflineAudioContext', { configurable: true, value: FakeOfflineAudioContext });
  try {
    await action();
  } finally {
    if (prior === undefined) delete scope.OfflineAudioContext;
    else Object.defineProperty(scope, 'OfflineAudioContext', { configurable: true, value: prior });
  }
}

describe('ProjectMixRenderer plan and resource preflight', () => {
  it('combines manual speed with the project tempo factor and PITCH/XFADE policy', () => {
    const runtime = createDefaultProjectDocument().tracks[0]!.settings.runtime;
    runtime.speed = 1.25;
    runtime.tempoSyncEnabled = true;
    runtime.tempoSyncSpeed = 'DOUBLE';
    runtime.recordBpm = 150;
    expect(getEffectiveProjectTrackSpeed(runtime, 150)).toBe(2.5);
    runtime.tempoSyncMode = 'XFADE';
    expect(isProjectTrackPitchPreserved(runtime)).toBe(true);
    runtime.tempoSyncEnabled = false;
    expect(getEffectiveProjectTrackSpeed(runtime, 300)).toBe(1.25);
    expect(isProjectTrackPitchPreserved(runtime)).toBe(false);
  });

  it('derives default loop duration from effective rate and estimates source, stretch, output and ring memory', () => {
    const options = makeOptions();
    options.document.tracks[0]!.settings.runtime.speed = 0.5;
    options.document.tracks[0]!.settings.runtime.tempoSyncEnabled = false;
    options.document.tracks[0]!.settings.runtime.keepPitch = true;
    expect(getProjectMixDefaultDurationFrames(options.document, options.audioByTrackId, [1])).toBe(2_000);

    const estimate = estimateProjectMixRenderBytes({ ...options, durationFrames: 4_000 }, true);
    expect(estimate.sourceBytes).toBe(1_000 * 2 * Float32Array.BYTES_PER_ELEMENT);
    expect(estimate.workingBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(estimate.workingBytes).toBeGreaterThan(2_000 * 2 * Float32Array.BYTES_PER_ELEMENT);
    expect(estimate.outputBytes).toBe(4_000 * 2 * Float32Array.BYTES_PER_ELEMENT);
    expect(estimate.captureBytes).toBeGreaterThan(0);
    expect(estimate.totalBytes).toBe(estimate.sourceBytes + estimate.workingBytes + estimate.outputBytes + estimate.captureBytes);
  });

  it('rejects missing PCM, mute/solo-empty selections and a render above the memory budget before graph construction', () => {
    const missing = makeOptions({ audioByTrackId: new Map() });
    expect(() => estimateProjectMixRenderBytes(missing)).toThrow(/no valid project PCM/i);

    const muted = makeOptions();
    muted.document.mixer.tracks[0]!.muted = true;
    expect(() => estimateProjectMixRenderBytes(muted)).toThrow(/No selected source track remains/i);

    const oversized = makeOptions({ maxMemoryBytes: 1 });
    expect(() => estimateProjectMixRenderBytes(oversized)).toThrow(/above the configured 1-byte memory limit/i);
  });

  it('rejects an enabled fixed FX chain when the renderer cannot reproduce it', async () => {
    const options = makeOptions();
    options.document.tracks[0]!.settings.fxChain.delay!.enabled = true;
    await withFakeOfflineContext(async () => {
      await expect(new ProjectMixRenderer().renderOffline(options)).rejects.toThrow(/enabled fixed FX.*could not reproduce/i);
    });
  });

  it('rejects enabled shared track-bank and master FX instead of silently bouncing dry audio', async () => {
    const trackBankOptions = makeOptions();
    trackBankOptions.document.fxBanks[0]!.track[0] = { type: 'DELAY', enabled: true, params: { mix: 0.5 } };
    await withFakeOfflineContext(async () => {
      await expect(new ProjectMixRenderer().renderOffline(trackBankOptions)).rejects.toThrow(/shared track-bank FX.*dry signal/i);
    });

    const masterOptions = makeOptions();
    masterOptions.document.masterFxChain.delay!.enabled = true;
    await withFakeOfflineContext(async () => {
      await expect(new ProjectMixRenderer().renderOffline(masterOptions)).rejects.toThrow(/enabled master FX.*dry signal/i);
    });
  });

  it('renders keep-pitch bounce through the verified shared Worker and preserves reversed stereo PCM', async () => {
    const input = makeAudioBuffer(8);
    input.getChannelData(0).set([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    input.getChannelData(1).set([-0.8, -0.7, -0.6, -0.5, -0.4, -0.3, -0.2, -0.1]);
    const options = makeOptions({
      audioByTrackId: new Map([[1, input]]), durationFrames: 4,
      sharedPitchArtifact: {
        module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
        sha256: 'a'.repeat(64), sourceSetSha256: 'b'.repeat(64), byteLength: 8,
        compilerIdentity: 'emcc 6.0.10',
      },
    });
    const runtime = options.document.tracks[0]!.settings.runtime;
    runtime.keepPitch = true;
    runtime.speed = 2;
    runtime.reverse = true;
    let renderRequest: Parameters<NonNullable<ProjectMixRenderOptions['renderSharedPitch']>>[0] | null = null;
    options.renderSharedPitch = async (request) => {
      renderRequest = request;
      return {
        profile: 'HQ_RENDER', sampleRate: 48_000, inputFrames: 8, outputFrames: 4,
        playbackRate: 2, left: new Float32Array([0.8, 0.7, 0.6, 0.5]),
        right: new Float32Array([-0.1, -0.2, -0.3, -0.4]),
        wasmSha256: 'a'.repeat(64), sourceSetSha256: 'b'.repeat(64),
        alignment: 'signalsmith-exact-output-seek-flush', latency: { inputSamples: 32, outputSamples: 48 },
      };
    };

    FakeOfflineAudioContext.createdSources = [];
    await withFakeOfflineContext(async () => { await new ProjectMixRenderer().renderOffline(options); });

    expect(renderRequest).toMatchObject({ profile: 'HQ_RENDER', sampleRate: 48_000,
      playbackRate: 2, reverse: true, left: input.getChannelData(0), right: input.getChannelData(1) });
    const renderedSource = FakeOfflineAudioContext.createdSources[0];
    expect(renderedSource?.buffer?.length).toBe(4);
    expect(renderedSource!.buffer!.getChannelData(0)).toEqual(new Float32Array([0.8, 0.7, 0.6, 0.5]));
    expect(renderedSource!.buffer!.getChannelData(1)).toEqual(new Float32Array([-0.1, -0.2, -0.3, -0.4]));
  });

  it('fails the bounce when the pinned shared pitch Worker fails, with no legacy stretch fallback', async () => {
    const options = makeOptions({
      sharedPitchArtifact: {
        module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
        sha256: 'a'.repeat(64), sourceSetSha256: 'b'.repeat(64), byteLength: 8,
        compilerIdentity: 'emcc 6.0.10',
      },
    });
    options.document.tracks[0]!.settings.runtime.keepPitch = true;
    options.document.tracks[0]!.settings.runtime.speed = 2;
    options.renderSharedPitch = async () => { throw new Error('exact seek/flush exports unavailable'); };
    FakeOfflineAudioContext.createdSources = [];
    await withFakeOfflineContext(async () => {
      await expect(new ProjectMixRenderer().renderOffline(options)).rejects.toThrow(/exact seek\/flush exports unavailable/);
    });
    expect(FakeOfflineAudioContext.createdSources).toHaveLength(0);
  });

  it('chooses the realtime capture epoch after slow FX setup, preserving a fresh setup lead', async () => {
    const sourceStarts: number[] = [];
    let nowSeconds = 1;
    const context = {
      sampleRate: 48_000,
      get currentTime() { return nowSeconds; },
      state: 'running',
      audioWorklet: { async addModule() {} },
      destination: new FakeAudioNode() as unknown as AudioNode,
      createGain() { return Object.assign(new FakeAudioNode(), { gain: new FakeAudioParam() }) as unknown as GainNode; },
      createStereoPanner() { return Object.assign(new FakeAudioNode(), { pan: new FakeAudioParam() }) as unknown as StereoPannerNode; },
      createBufferSource() {
        return Object.assign(new FakeAudioNode(), {
          loop: false,
          buffer: null as AudioBuffer | null,
          playbackRate: new FakeAudioParam(),
          start(time: number) { sourceStarts.push(time); },
          stop() {},
        }) as unknown as AudioBufferSourceNode;
      },
      createBuffer(_channels: number, length: number, sampleRate: number) { return makeAudioBuffer(length, sampleRate); },
      async resume() {},
    } as unknown as AudioContext;
    const options = makeOptions({ context, durationFrames: 256 });
    options.document.masterFxChain.reverb!.enabled = true;
    options.createMasterFxGraph = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      nowSeconds = 5;
      return { input: new FakeAudioNode() as unknown as AudioNode, output: new FakeAudioNode() as unknown as AudioNode };
    };

    await withFakeRealtimeGlobals(async () => {
      const output = await new ProjectMixRenderer().renderRealtime(options);
      expect(output.length).toBe(256);
    });
    expect(sourceStarts).toHaveLength(1);
    expect(sourceStarts[0]).toBeGreaterThanOrEqual(5 + 2_048 / 48_000);
  });
});
