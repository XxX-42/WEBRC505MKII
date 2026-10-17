import { NATIVE_CATALOG_FX_LABELS } from './nativeFxCatalog';

export type NativeBackend = 'WASAPI' | 'ASIO';
export type NativeLooperState = 'Empty' | 'Recording' | 'Stopped' | 'Playing' | 'Overdubbing';
export type NativeHqEngine = 'R2' | 'R3';
export type NativeLoopTransportMode = 'off' | 'beatShift' | 'vinylFlick';
export type NativeLoopTransportStatus =
  | 'disabled'
  | 'waitingForLoop'
  | 'waitingForPlayback'
  | 'active'
  | 'unsupportedRecording'
  | 'unsupportedOverdubbing';

export interface NativeLoopTransportConfig {
  mode: NativeLoopTransportMode;
  beatOffsetBeats: number;
  bpm: number;
  crossfadeMs: number;
  vinylSpeedPercent: number;
  motorReturnSeconds: number;
  brakePercent: number;
  vinylMixPercent: number;
}

export interface NativeHqRendererCapability {
  available: boolean;
  engines: NativeHqEngine[];
}

export interface NativeDeviceInfo {
  id: string;
  name: string;
  sampleRates: number[];
  isDefault: boolean;
}

export interface NativeDeviceCatalog {
  ok: boolean;
  backends: NativeBackend[];
  inputsByBackend: Record<string, NativeDeviceInfo[]>;
  outputsByBackend: Record<string, NativeDeviceInfo[]>;
  defaultInputIdByBackend: Record<string, string>;
  defaultOutputIdByBackend: Record<string, string>;
  bufferOptions: number[];
}

export interface NativeRhythmConfig {
  enabled: boolean;
  bpm: number;
  kitIndex: number;
  patternIndex: number;
  variation: 'A' | 'B' | 'C' | 'D';
  section: 'main' | 'intro' | 'ending' | 'fill';
  swingPercent: number;
  quantizeGrid: '1/16' | '1/8' | '1/4';
  volume: number;
}

/** Validate at the boundary so unsupported selections never silently become defaults. */
export function isNativeRhythmConfig(config: NativeRhythmConfig): boolean {
  return typeof config.enabled === 'boolean'
    && Number.isFinite(config.bpm) && config.bpm >= 40 && config.bpm <= 300
    && Number.isInteger(config.kitIndex) && config.kitIndex >= 1 && config.kitIndex <= 16
    && Number.isInteger(config.patternIndex) && config.patternIndex >= 1 && config.patternIndex <= 240
    && ['A', 'B', 'C', 'D'].includes(config.variation)
    && ['main', 'intro', 'ending', 'fill'].includes(config.section)
    && Number.isInteger(config.swingPercent) && config.swingPercent >= 50 && config.swingPercent <= 75
    && ['1/16', '1/8', '1/4'].includes(config.quantizeGrid)
    && Number.isInteger(config.volume) && config.volume >= 0 && config.volume <= 100;
}

export interface NativeStatus {
  ok: boolean;
  bridgeHealthy: boolean;
  engineRunning: boolean;
  backend: NativeBackend;
  inputDeviceId: string;
  outputDeviceId: string;
  inputDeviceName: string;
  outputDeviceName: string;
  sampleRate: number;
  bufferFrames: number;
  /** Absolute frame cursor used for Native sample-clocked MIDI events. */
  nativeSampleFrame?: number;
  monitoringEnabled: boolean;
  state: NativeLooperState;
  inputLatencyMs: number;
  outputLatencyMs: number;
  roundTripEstimateMs: number;
  inputPeak: number;
  outputPeak: number;
  xrunsOrDropouts: number;
  lastError: string;
  loopProgress: number;
  nativeLooperTrackCount?: number;
  nativeLooperMultiTrackImplemented?: boolean;
  nativeLooperTracksStereo?: boolean;
  nativeLooperMaxRecordSeconds?: number;
  nativeLooperPreallocatedBytes?: number;
  nativeLooperStorageBudgetBytes?: number;
  nativeTracks?: Array<{
    trackId: number;
    state: NativeLooperState;
    loopProgress: number;
    loopTransportStatus?: NativeLoopTransportStatus;
  }>;
  nativePitch?: NativePitchStatus;
  /** Missing status is treated as unavailable; old bridge builds cannot render Native HQ. */
  nativeHqRenderer?: NativeHqRendererCapability;
  nativeRhythm?: NativeRhythmConfig & {
    available: boolean;
    patternCatalogAvailable: boolean;
    patternId: string;
    genre: string;
    pattern: string;
    beat: string;
    meterNumerator: number;
    meterDenominator: number;
    eventsCleanRoomProcedural: boolean;
    patternSource: 'metadata-only-240-pattern-catalog';
    statusNote: string;
  };
  nativeFx?: {
    implementedCatalogEffects?: string[];
    catalogEffectAvailability?: Array<{
      effectId: string;
      sourceIndex?: number;
      input: boolean;
      track: boolean;
      perTrackInsert?: boolean;
    }>;
    catalogGraphAvailable?: boolean;
    /** Independent pre-sum loop chains, separate from the legacy postmix bank. */
    perTrackCatalogAvailable?: boolean;
    catalogControlFaultCount?: number;
    perTrackCatalogBanks?: NativePerTrackCatalogBank[];
    sourceAwareLoopTransport?: {
      experimental: boolean;
      stage: 'preInsert';
      orderedInsertPlacementSupported: boolean;
      effects: string[];
      statusNote: string;
    };
    catalogSlots?: Array<{
      slot: NativeFxSlot;
      effectId: string;
      bypassed: boolean;
    }>;
    inputCatalogSlots?: Array<{
      slot: NativeFxSlot;
      effectId: string;
      bypassed: boolean;
    }>;
    trackOutputBank?: {
      layout: NativeFxSlot[];
      activeSlots: NativeFxSlot[];
      multiTrackImplemented: boolean;
    };
    fractionalDelay?: {
      available: boolean;
      enabled: boolean;
      slot: NativeFxSlot;
      algorithm: 'lagrange4';
      delayMs: number;
      wetMix: number;
      feedback: number;
      maxDelayMs: number;
    };
    compressor?: {
      available: boolean;
      enabled: boolean;
      slot: NativeFxSlot;
      algorithm: 'peakCompressor';
      thresholdDb: number;
      ratio: number;
      attackMs: number;
      releaseMs: number;
      wetMix: number;
      makeupDb: number;
    };
    chorus?: {
      available: boolean;
      enabled: boolean;
      slot: NativeFxSlot;
      algorithm: 'stereoLfoLagrange4';
      rateHz: number;
      depthMs: number;
      feedback: number;
      wetMix: number;
    };
    autoPan?: {
      available: boolean;
      enabled: boolean;
      slot: NativeFxSlot;
      algorithm: 'equalPowerMidSideLfo';
      rateHz: number;
      depth: number;
      waveform: NativeAutoPanWaveform;
      wetMix: number;
    };
    oscVocMidi?: {
      eventQueueCapacity: number;
      currentSampleFrame: number;
      inputSlots: NativeOscVocSlotStatus[];
      trackSlots: NativeOscVocSlotStatus[];
      statusNote: string;
    };
    catalogMidi?: {
      inputSlots: NativeCatalogMidiSlotStatus[];
      trackSlots: NativeCatalogMidiSlotStatus[];
      statusNote: string;
    };
  };
}

export interface NativeCatalogSlotStatus {
  slot: NativeFxSlot;
  effectId: string;
  /** Requested control-thread bypass, which may be waiting for a callback. */
  bypassed: boolean;
  appliedBypassed: boolean;
  prepared: boolean;
  processingFaulted: boolean;
  controlFaulted: boolean;
  requestedRevision: number;
  appliedRevision: number;
}

export interface NativePerTrackCatalogBank {
  trackId: number;
  slots: NativeCatalogSlotStatus[];
  midiSlots: NativeCatalogMidiSlotStatus[];
}

export interface NativeOscVocSlotStatus {
  slot: NativeFxSlot;
  selected: boolean;
  currentFrame: number;
  queuedEvents: number;
  overflowEventCount: number;
  lateEventCount: number;
  rejectedEventCount: number;
}

export interface NativeCatalogMidiSlotStatus extends NativeOscVocSlotStatus {
  effectId: string;
  queueCapacity: number;
}

export interface NativePitchStatus {
    pitchCorrectionAvailable: boolean;
    pitchCorrectionImplemented: boolean;
    enabled: boolean;
    active: boolean;
    /** 0 is the legacy summed bus; 1..5 identifies the selected loop. */
    trackId: number;
    reversePlayback: boolean;
    mode: 'liveMonoKeepPitch' | 'livePolyPhaseVocoder';
    algorithm: 'cleanRoomYinPsola' | 'signalsmithStretch132Cheaper';
    semitones: number;
    frequencyHz: number;
    confidence: number;
    voiced: boolean;
    latencySamples: number;
    fallbackReason: 'none' | 'notRequested' | 'processorNotPrepared' | 'playbackBufferUnavailable' |
      'reversePlayback' | 'unsupportedChannelCount' | 'loopShorterThanLatency' | 'unknown';
    statusNote: string;
}

export interface NativeHealth {
  ok: boolean;
  version: string;
  engineRunning: boolean;
  backends: NativeBackend[];
  lastError: string;
}

export interface NativeLoopSnapshot {
  readonly sampleRate: number;
  readonly frameCount: number;
  /** 1 for legacy hosts; 2 for the current Native stereo-track snapshot. */
  readonly channels: 1 | 2;
  readonly samples: Float32Array;
}

export interface NativeLoopSnapshotMetadata {
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly channels: 1 | 2;
}

export interface NativeTrackMetadata {
  readonly trackId: number;
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly channels: 2;
}

export interface NativeHqRenderOptions {
  readonly semitones: number;
  readonly playbackRate: number;
  readonly engine: NativeHqEngine;
  readonly memoryBudgetBytes: number;
  readonly format: 'pcm16' | 'pcm24' | 'float32';
}

export interface NativeHqRenderResult extends NativeTrackMetadata {
  readonly samples: Float32Array;
  readonly engine: NativeHqEngine;
  readonly latencySamples: 0;
}

export interface NativeConfig {
  backend: NativeBackend;
  inputDeviceId: string;
  outputDeviceId: string;
  sampleRate: number;
  bufferFrames: number;
  monitoringEnabled: boolean;
  nativeLooperStorageBudgetBytes: number;
}

export type NativeFxSlot = 'A' | 'B' | 'C' | 'D';

export interface NativeFractionalDelayConfig {
  slot: NativeFxSlot;
  enabled: boolean;
  algorithm: 'lagrange4';
  delayMs: number;
  wetMix: number;
  feedback: number;
}

export interface NativeCompressorConfig {
  slot: NativeFxSlot;
  enabled: boolean;
  algorithm: 'peakCompressor';
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  wetMix: number;
  makeupDb: number;
}

export interface NativeChorusConfig {
  slot: NativeFxSlot;
  enabled: boolean;
  algorithm: 'stereoLfoLagrange4';
  rateHz: number;
  depthMs: number;
  feedback: number;
  wetMix: number;
}

export type NativeAutoPanWaveform = 'sine' | 'triangle' | 'square';

export interface NativeAutoPanConfig {
  slot: NativeFxSlot;
  enabled: boolean;
  algorithm: 'equalPowerMidSideLfo';
  rateHz: number;
  depth: number;
  waveform: NativeAutoPanWaveform;
  wetMix: number;
}

export interface NativeCatalogSlotConfig {
  path?: 'input' | 'track';
  /** 0/omitted is the legacy bank; Track 1..5 selects an independent loop chain. */
  trackId?: number;
  slot: NativeFxSlot;
  effectId: string;
  parameters?: Record<string, number>;
  bypassed: boolean;
}

export interface NativeOscVocMidiEvent {
  path: 'input' | 'track';
  trackId?: number;
  slot: NativeFxSlot;
  type: 'noteOn' | 'noteOff';
  /** 1-based MIDI channel, in the range 1–16. */
  channel: number;
  note: number;
  velocity: number;
  /** Absolute Native sample frame, as an integer exactly representable in JS. */
  frame: number;
}

export interface NativeCatalogMidiEvent extends NativeOscVocMidiEvent {
  effectId: 'osc_voc_m' | 'hrm_auto_m';
}

export interface NativePitchConfig {
  enabled: boolean;
  /** Optional per-track route; omission preserves the legacy global bus (0). */
  trackId?: number;
  mode?: 'liveMonoKeepPitch' | 'livePolyPhaseVocoder';
  semitones: number;
  reversePlayback?: boolean;
}

interface BridgeResponse {
  ok: boolean;
  error?: string;
}

export class NativeBridgeClient {
  private readonly baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:17755') {
    this.baseUrl = baseUrl;
  }

  public async health(): Promise<NativeHealth> {
    return this.request<NativeHealth>('/health');
  }

  public async getDevices(): Promise<NativeDeviceCatalog> {
    return this.request<NativeDeviceCatalog>('/v1/devices');
  }

  public async getStatus(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/status');
  }

  /** Gets the small loop description before requesting any rendered PCM bytes. */
  public async getTrackMetadata(trackId = 1): Promise<NativeTrackMetadata> {
    assertNativeTrackId(trackId);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/export/track-metadata?trackId=${trackId}`, { method: 'GET' });
    } catch (error) {
      throw new Error(`Native bridge is unreachable at ${this.baseUrl}: ${error}`);
    }
    if (!response.ok) throw await this.readHttpError(response, 'Native track metadata request failed');

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Native bridge returned invalid track metadata JSON.');
    }
    if (!isObject(payload) || payload.ok !== true || payload.trackId !== trackId ||
        !Number.isInteger(payload.sampleRate) || (payload.sampleRate as number) < 8_000 || (payload.sampleRate as number) > 192_000 ||
        !Number.isSafeInteger(payload.frameCount) || (payload.frameCount as number) <= 0 || payload.channels !== 2) {
      throw new Error('Native bridge returned invalid HQ render track metadata.');
    }
    return {
      trackId,
      sampleRate: payload.sampleRate as number,
      frameCount: payload.frameCount as number,
      channels: 2,
    };
  }

  /** Requests rendered interleaved Float32LE PCM from the Native Rubber Band renderer. */
  public async renderHqTrack(
    trackId: number,
    options: NativeHqRenderOptions,
    expectedMetadata?: NativeTrackMetadata,
  ): Promise<NativeHqRenderResult> {
    assertNativeTrackId(trackId);
    if (!Number.isFinite(options.semitones) || options.semitones < -24 || options.semitones > 24) {
      throw new RangeError('semitones must be between -24 and +24');
    }
    if (!Number.isFinite(options.playbackRate) || options.playbackRate < 0.5 || options.playbackRate > 2) {
      throw new RangeError('playbackRate must be between 0.5 and 2');
    }
    if (options.engine !== 'R2' && options.engine !== 'R3') {
      throw new TypeError('Native HQ engine must be R2 or R3.');
    }
    if (!Number.isSafeInteger(options.memoryBudgetBytes) || options.memoryBudgetBytes <= 0) {
      throw new RangeError('HQ WAV export memory budget must be a positive safe integer number of bytes');
    }
    if (options.format !== 'pcm16' && options.format !== 'pcm24' && options.format !== 'float32') {
      throw new TypeError(`Unsupported WAV sample format: ${String(options.format)}`);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/export/hq-render?trackId=${trackId}`, {
        method: 'POST',
        // text/plain is a CORS-safelisted content type. The bridge parses the
        // JSON body itself; avoiding a JSON preflight keeps this local-host
        // endpoint usable from the app's separate origin without OPTIONS.
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(options),
      });
    } catch (error) {
      throw new Error(`Native bridge is unreachable at ${this.baseUrl}: ${error}`);
    }
    if (!response.ok) throw await this.readHttpError(response, 'Native HQ render request failed');

    const sampleRateHeader = response.headers.get('X-Native-Loop-Sample-Rate');
    const frameCountHeader = response.headers.get('X-Native-Loop-Frame-Count');
    const channelsHeader = response.headers.get('X-Native-Loop-Channels');
    const latencyHeader = response.headers.get('X-Native-HQ-Latency-Samples');
    const sampleRate = Number(sampleRateHeader);
    const frameCount = Number(frameCountHeader);
    const channels = Number(channelsHeader);
    const sampleFormat = response.headers.get('X-Native-Loop-Sample-Format');
    const returnedEngine = response.headers.get('X-Native-HQ-Engine');
    const latencySamples = Number(latencyHeader);
    if (sampleRateHeader == null || frameCountHeader == null || channelsHeader == null || latencyHeader == null ||
        !Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000 ||
        !Number.isSafeInteger(frameCount) || frameCount <= 0 || channels !== 2 ||
        sampleFormat !== 'float32le' || returnedEngine !== options.engine || latencySamples !== 0) {
      await cancelResponseBody(response);
      throw new Error('Native HQ renderer returned invalid output metadata or engine headers.');
    }
    if (expectedMetadata && (sampleRate !== expectedMetadata.sampleRate ||
        frameCount !== Math.ceil(expectedMetadata.frameCount / options.playbackRate) || channels !== expectedMetadata.channels)) {
      await cancelResponseBody(response);
      throw new Error('Native HQ renderer output does not match the admitted loop metadata and playback rate.');
    }

    const bytes = await response.arrayBuffer();
    const sampleCount = frameCount * channels;
    if (!Number.isSafeInteger(sampleCount) || bytes.byteLength !== sampleCount * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error('Native HQ renderer returned a truncated or oversized PCM response.');
    }
    const isLittleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    let samples: Float32Array;
    if (isLittleEndian) {
      samples = new Float32Array(bytes);
    } else {
      const view = new DataView(bytes);
      samples = new Float32Array(sampleCount);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        samples[sample] = view.getFloat32(sample * Float32Array.BYTES_PER_ELEMENT, true);
      }
    }
    return { trackId, sampleRate, frameCount, channels: 2, samples, engine: options.engine, latencySamples: 0 };
  }

  public async getLoopSnapshot(
    trackId = 1,
    beforeRead?: (metadata: NativeLoopSnapshotMetadata) => void,
  ): Promise<NativeLoopSnapshot> {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) {
      throw new RangeError('Native track ID must be an integer between 1 and 5.');
    }
    let response: Response;
    try {
      // Keep this a simple GET so the loopback bridge does not require a CORS
      // preflight. The bridge exposes only the four metadata headers below to
      // trusted loopback app origins.
      const trackQuery = trackId === 1 ? '' : `?trackId=${trackId}`;
      response = await fetch(`${this.baseUrl}/v1/export/loop-snapshot${trackQuery}`, { method: 'GET' });
    } catch (error) {
      throw new Error(`Native bridge is unreachable at ${this.baseUrl}: ${error}`);
    }

    if (!response.ok) {
      let message = `Native loop snapshot request failed with HTTP ${response.status}.`;
      try {
        const payload = await response.json() as BridgeResponse;
        if (payload.error) message = payload.error;
      } catch {
        // Retain the status-based message for a non-JSON bridge error.
      }
      throw new Error(message);
    }

    const sampleRate = Number(response.headers.get('X-Native-Loop-Sample-Rate'));
    const frameCount = Number(response.headers.get('X-Native-Loop-Frame-Count'));
    const channelHeader = response.headers.get('X-Native-Loop-Channels');
    const channelsValue = channelHeader == null ? 1 : Number(channelHeader);
    const channels = channelsValue === 2 ? 2 : channelsValue === 1 ? 1 : 0;
    const sampleFormat = response.headers.get('X-Native-Loop-Sample-Format');
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000 ||
        !Number.isSafeInteger(frameCount) || frameCount <= 0 || (channels !== 1 && channels !== 2) ||
        sampleFormat !== 'float32le') {
      throw new Error('Native bridge returned invalid loop snapshot metadata.');
    }

    // Native responses expose validated size metadata before their raw PCM
    // body is materialized as an ArrayBuffer. Callers can reject an over-budget
    // render here, leaving both the Native loop and the large response body
    // untouched.
    try {
      beforeRead?.({ sampleRate, frameCount, channels });
    } catch (error) {
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the admission error; cancelling is only a best-effort release.
      }
      throw error;
    }

    const bytes = await response.arrayBuffer();
    const sampleCount = frameCount * channels;
    if (!Number.isSafeInteger(sampleCount) || bytes.byteLength !== sampleCount * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error('Native bridge returned a truncated or oversized loop snapshot.');
    }

    const isLittleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    let samples: Float32Array;
    if (isLittleEndian) {
      samples = new Float32Array(bytes);
    } else {
      const view = new DataView(bytes);
      samples = new Float32Array(sampleCount);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        samples[sample] = view.getFloat32(sample * Float32Array.BYTES_PER_ELEMENT, true);
      }
    }

    return { sampleRate, frameCount, channels, samples };
  }

  public async applyConfig(config: NativeConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/config/apply', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async startEngine(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/engine/start', { method: 'POST' });
  }

  public async stopEngine(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/engine/stop', { method: 'POST' });
  }

  public async record(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/record', { method: 'POST' });
  }

  public async recordTrack(trackId: number): Promise<NativeStatus> {
    return this.requestTrackTransport('/v1/transport/record', trackId);
  }

  public async stopTransport(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/stop', { method: 'POST' });
  }

  public async stopTrack(trackId: number): Promise<NativeStatus> {
    return this.requestTrackTransport('/v1/transport/stop', trackId);
  }

  public async play(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/play', { method: 'POST' });
  }

  public async playTrack(trackId: number): Promise<NativeStatus> {
    return this.requestTrackTransport('/v1/transport/play', trackId);
  }

  public async toggleOverdub(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/overdub-toggle', { method: 'POST' });
  }

  public async toggleTrackOverdub(trackId: number): Promise<NativeStatus> {
    return this.requestTrackTransport('/v1/transport/overdub-toggle', trackId);
  }

  public async clear(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/clear', { method: 'POST' });
  }

  public async clearTrack(trackId: number): Promise<NativeStatus> {
    return this.requestTrackTransport('/v1/transport/clear', trackId);
  }

  public async setLoopTransport(trackId: number, config: NativeLoopTransportConfig): Promise<NativeStatus> {
    assertNativeTrackId(trackId);
    if (!isNativeLoopTransportConfig(config)) {
      throw new RangeError('Native loop transport settings are outside the supported mode, Beat Shift, or Vinyl Flick ranges.');
    }
    return this.request<NativeStatus>('/v1/native-loop-transport/config', {
      method: 'POST',
      body: JSON.stringify({ trackId, ...config }),
    });
  }

  private async requestTrackTransport(path: string, trackId: number): Promise<NativeStatus> {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) {
      throw new RangeError('Native track ID must be an integer between 1 and 5.');
    }
    // Keep the original track-one routes unchanged for compatibility; higher
    // track IDs use the same command endpoint with an explicit 1-based selector.
    const suffix = trackId === 1 ? '' : `?trackId=${trackId}`;
    return this.request<NativeStatus>(`${path}${suffix}`, { method: 'POST' });
  }

  public async setMonitoring(enabled: boolean): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/monitoring', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  }

  public async setFractionalDelay(config: NativeFractionalDelayConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/native-fx/fractional-delay', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async setCompressor(config: NativeCompressorConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/native-fx/compressor', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async setChorus(config: NativeChorusConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/native-fx/chorus', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async setAutoPan(config: NativeAutoPanConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/native-fx/auto-pan', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async setRhythm(config: NativeRhythmConfig): Promise<NativeStatus> {
    if (!isNativeRhythmConfig(config)) {
      throw new RangeError('Native rhythm settings require BPM 40–300, pattern 1–240, kit 1–16, variation A–D, a supported section, swing 50–75, quantize 1/16|1/8|1/4, and volume 0–100.');
    }
    return this.request<NativeStatus>('/v1/native-rhythm/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async setPitch(config: NativePitchConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/native-pitch/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async setCatalogSlot(config: NativeCatalogSlotConfig): Promise<NativeStatus> {
    assertNativeFxTarget(config.path === undefined ? 'track' : config.path, config.trackId === undefined ? 0 : config.trackId);
    if (!(['A', 'B', 'C', 'D'] as const).includes(config.slot) ||
        typeof config.effectId !== 'string' ||
        (config.effectId !== '' && config.effectId !== 'hrm_auto_m' && !Object.prototype.hasOwnProperty.call(NATIVE_CATALOG_FX_LABELS, config.effectId)) ||
        typeof config.bypassed !== 'boolean' ||
        (config.parameters !== undefined && (!isObject(config.parameters) ||
          Object.entries(config.parameters).some(([key, value]) => !key || !Number.isFinite(value))))) {
      throw new RangeError('Native catalog slot has an invalid slot, effect type, bypass, or parameter value.');
    }
    return this.request<NativeStatus>('/v1/native-fx/catalog-slot', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async queueOscVocMidiEvent(event: NativeOscVocMidiEvent): Promise<NativeStatus> {
    assertNativeFxTarget(event.path, event.trackId === undefined ? 0 : event.trackId);
    if ((event.path !== 'input' && event.path !== 'track') ||
        !(['A', 'B', 'C', 'D'] as const).includes(event.slot) ||
        (event.type !== 'noteOn' && event.type !== 'noteOff') ||
        !Number.isInteger(event.channel) || event.channel < 1 || event.channel > 16 ||
        !Number.isInteger(event.note) || event.note < 0 || event.note > 127 ||
        !Number.isInteger(event.velocity) || event.velocity < 0 || event.velocity > 127 ||
        !Number.isSafeInteger(event.frame) || event.frame < 0) {
      throw new RangeError('Native OSC VOC MIDI event has an invalid path, slot, type, channel, note, velocity, or absolute frame.');
    }
    return this.request<NativeStatus>('/v1/native-fx/osc-voc-midi', {
      method: 'POST',
      body: JSON.stringify(event),
    });
  }

  public async queueCatalogMidiEvent(event: NativeCatalogMidiEvent): Promise<NativeStatus> {
    assertNativeFxTarget(event.path, event.trackId === undefined ? 0 : event.trackId);
    if ((event.effectId !== 'osc_voc_m' && event.effectId !== 'hrm_auto_m') ||
        (event.path !== 'input' && event.path !== 'track') ||
        !(['A', 'B', 'C', 'D'] as const).includes(event.slot) ||
        (event.type !== 'noteOn' && event.type !== 'noteOff') ||
        !Number.isInteger(event.channel) || event.channel < 1 || event.channel > 16 ||
        !Number.isInteger(event.note) || event.note < 0 || event.note > 127 ||
        !Number.isInteger(event.velocity) || event.velocity < 0 || event.velocity > 127 ||
        !Number.isSafeInteger(event.frame) || event.frame < 0) {
      throw new RangeError('Native catalog MIDI event has an invalid effect, path, slot, type, channel, note, velocity, or absolute frame.');
    }
    return this.request<NativeStatus>('/v1/native-fx/catalog-midi', {
      method: 'POST',
      body: JSON.stringify(event),
    });
  }

  private async request<T extends BridgeResponse>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          'Content-Type': 'application/json',
        },
        ...init,
      });
    } catch (error) {
      throw new Error(`Native bridge is unreachable at ${this.baseUrl}: ${error}`);
    }

    const payload = (await response.json()) as T;
    if (response.ok === false || !payload.ok) {
      throw new Error(payload.error || `Native bridge request failed${response.status ? ` with HTTP ${response.status}` : ''}.`);
    }
    return payload;
  }

  private async readHttpError(response: Response, fallback: string): Promise<Error> {
    let message = `${fallback} with HTTP ${response.status}.`;
    try {
      const payload = await response.json() as BridgeResponse;
      if (payload.error) message = payload.error;
    } catch {
      // Keep the status-based message for non-JSON bridge errors.
    }
    return new Error(message);
  }
}

/** Input accepts only target 0; Track accepts legacy 0 or explicit loop IDs 1..5. */
export function assertNativeFxTarget(path: string, trackId: number): void {
  if ((path !== 'input' && path !== 'track') || !Number.isInteger(trackId) || trackId < 0 || trackId > 5 ||
      (path === 'input' && trackId !== 0)) {
    throw new RangeError('Native FX target requires Input track ID 0 or Track ID 0–5.');
  }
}

function assertNativeTrackId(trackId: number): void {
  if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) {
    throw new RangeError('Native track ID must be an integer between 1 and 5.');
  }
}

/** Validate every Native endpoint before making a request, matching LooperCore's current transport ranges. */
export function isNativeLoopTransportConfig(config: NativeLoopTransportConfig): boolean {
  return (config.mode === 'off' || config.mode === 'beatShift' || config.mode === 'vinylFlick')
    && Number.isFinite(config.beatOffsetBeats) && config.beatOffsetBeats >= -4 && config.beatOffsetBeats <= 4
    && Number.isFinite(config.bpm) && config.bpm >= 20 && config.bpm <= 300
    && Number.isFinite(config.crossfadeMs) && config.crossfadeMs >= 1 && config.crossfadeMs <= 10
    && Number.isFinite(config.vinylSpeedPercent) && config.vinylSpeedPercent >= -100 && config.vinylSpeedPercent <= 100
    && Number.isFinite(config.motorReturnSeconds) && config.motorReturnSeconds >= 0.05 && config.motorReturnSeconds <= 10
    && Number.isFinite(config.brakePercent) && config.brakePercent >= 0 && config.brakePercent <= 100
    && Number.isFinite(config.vinylMixPercent) && config.vinylMixPercent >= 0 && config.vinylMixPercent <= 100;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Keep the metadata validation error; cancelling only releases the body early.
  }
}
