import {
  BROWSER_REALTIME_MAX_TRACK_FRAMES,
  BROWSER_REALTIME_QUANTUM_FRAMES,
  BROWSER_REALTIME_SAMPLE_RATE,
  BROWSER_REALTIME_TRACK_COUNT,
  BROWSER_REALTIME_TRACK_CHANNEL_COUNT,
  BROWSER_REALTIME_LAYOUT_VERSION,
  BROWSER_REALTIME_LAYOUT_MONO,
  BROWSER_REALTIME_LAYOUT_PLANAR_LR,
  BrowserRealtimeOpcode,
  BrowserRealtimeStatus,
  ControlWord,
  CONTROL_TRACK_POSITIONS_BYTE_OFFSET,
  CONTROL_TRACK_STATES_BYTE_OFFSET,
  TRACK_META_BYTES,
  TrackMetaWord,
  createMonoLoopbackSharedBuffer,
  createTrackSharedBuffer,
  loadSharedFrame,
  queueSharedCommand,
  type BrowserRealtimeAck,
  type BrowserRealtimeMetrics,
} from './browserRealtimeProtocol';

export type BrowserRealtimeRuntimeMessage = {
  type: string;
  track?: number;
  frames?: number;
  startFrame?: number;
  message?: string;
  beatOrdinal?: number;
  frame?: number;
  channelCount?: number;
  layoutVersion?: number;
  storageLayout?: number;
  } & Partial<BrowserRealtimeAck>;

type AckWaiter = {
  intentFrame: number;
  targetFrame: number;
  resolve: (ack: BrowserRealtimeAck) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const ACKNOWLEDGEMENT_GRACE_MS = 2_000;

export class BrowserRealtimeRuntime {
  public readonly controlBuffer: SharedArrayBuffer;
  public readonly control: Int32Array;
  public readonly trackStates: Int32Array;
  public readonly trackPositions: Float32Array;

  private readonly node: AudioWorkletNode;
  private readonly sampleRate: number;
  private readonly trackBuffers: Array<SharedArrayBuffer | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly trackMetadata: Array<Int32Array | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly trackSamplesLeft: Array<Float32Array | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly trackSamplesRight: Array<Float32Array | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly attachWaiters = new Map<number, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private readonly trackPreparationPromises: Array<Promise<void> | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly ackWaiters = new Map<number, AckWaiter>();
  private loopbackArmWaiter: { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> } | null = null;
  private sequence = 0;
  private messageHandler: ((message: BrowserRealtimeRuntimeMessage) => void) | null = null;
  private disposed = false;

  public constructor(node: AudioWorkletNode, controlBuffer: SharedArrayBuffer, sampleRate: number) {
    this.node = node;
    this.sampleRate = sampleRate;
    this.controlBuffer = controlBuffer;
    this.control = new Int32Array(this.controlBuffer);
    this.trackStates = new Int32Array(
      this.controlBuffer,
      CONTROL_TRACK_STATES_BYTE_OFFSET,
      BROWSER_REALTIME_TRACK_COUNT,
    );
    this.trackPositions = new Float32Array(
      this.controlBuffer,
      CONTROL_TRACK_POSITIONS_BYTE_OFFSET,
      BROWSER_REALTIME_TRACK_COUNT,
    );

    Atomics.store(this.control, ControlWord.BPM, 120);
    this.node.port.onmessage = (event: MessageEvent<BrowserRealtimeRuntimeMessage>) => this.handleMessage(event.data);
    this.node.port.onmessageerror = () => this.failAllWaiters(new Error('The browser realtime worklet message channel failed.'));
  }

  public setMessageHandler(handler: ((message: BrowserRealtimeRuntimeMessage) => void) | null) {
    this.messageHandler = handler;
  }

  public async prepareAllTracks(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (let track = 0; track < BROWSER_REALTIME_TRACK_COUNT; track += 1) {
      pending.push(this.prepareTrack(track));
    }
    await Promise.all(pending);
  }

  public async prepareTrack(track: number): Promise<void> {
    this.assertTrackIndex(track);
    const existingPreparation = this.trackPreparationPromises[track];
    if (existingPreparation) return await existingPreparation;
    if (this.trackBuffers[track]) return;
    if (this.disposed) throw new Error('Browser realtime runtime is closed.');

    const buffer = createTrackSharedBuffer(BROWSER_REALTIME_MAX_TRACK_FRAMES);
    const metadata = new Int32Array(buffer, 0, TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT);
    const samplesLeft = new Float32Array(buffer, TRACK_META_BYTES, BROWSER_REALTIME_MAX_TRACK_FRAMES);
    const samplesRight = new Float32Array(
      buffer,
      TRACK_META_BYTES + BROWSER_REALTIME_MAX_TRACK_FRAMES * Float32Array.BYTES_PER_ELEMENT,
      BROWSER_REALTIME_MAX_TRACK_FRAMES,
    );
    Atomics.store(metadata, TrackMetaWord.STATE, 0);
    Atomics.store(metadata, TrackMetaWord.CAPACITY_FRAMES, BROWSER_REALTIME_MAX_TRACK_FRAMES);
    Atomics.store(metadata, TrackMetaWord.ALIGNMENT_SAMPLES, 0);
    Atomics.store(metadata, TrackMetaWord.CHANNEL_COUNT, BROWSER_REALTIME_TRACK_CHANNEL_COUNT);
    Atomics.store(metadata, TrackMetaWord.LAYOUT_VERSION, BROWSER_REALTIME_LAYOUT_VERSION);
    Atomics.store(metadata, TrackMetaWord.STORAGE_LAYOUT, BROWSER_REALTIME_LAYOUT_PLANAR_LR);

    this.trackBuffers[track] = buffer;
    this.trackMetadata[track] = metadata;
    this.trackSamplesLeft[track] = samplesLeft;
    this.trackSamplesRight[track] = samplesRight;

    const preparation = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.attachWaiters.delete(track);
        reject(new Error(`Realtime worklet did not attach storage for track ${track + 1}.`));
      }, 2_000);
      this.attachWaiters.set(track, { resolve, reject, timeout });
      this.node.port.postMessage({
        type: 'ATTACH_TRACK',
        track,
        buffer,
        channelCount: BROWSER_REALTIME_TRACK_CHANNEL_COUNT,
        layoutVersion: BROWSER_REALTIME_LAYOUT_VERSION,
        storageLayout: BROWSER_REALTIME_LAYOUT_PLANAR_LR,
      });
    });
    this.trackPreparationPromises[track] = preparation;
    try {
      await preparation;
    } catch (error) {
      if (this.trackBuffers[track] === buffer) {
        this.trackBuffers[track] = null;
        this.trackMetadata[track] = null;
        this.trackSamplesLeft[track] = null;
        this.trackSamplesRight[track] = null;
      }
      throw error;
    } finally {
      if (this.trackPreparationPromises[track] === preparation) {
        this.trackPreparationPromises[track] = null;
      }
    }
  }

  public getCurrentFrame(): number {
    return loadSharedFrame(
      this.control,
      ControlWord.RENDER_FRAME_SEQUENCE,
      ControlWord.RENDER_FRAME_LOW,
      ControlWord.RENDER_FRAME_HIGH,
    );
  }

  public getSafeTargetFrame(): number {
    // The shared frame is the most recently completed sample. A command that
    // misses the next quantum is executed late at the first available sample;
    // adding a fixed lookahead here would impose avoidable trigger latency.
    return this.getCurrentFrame();
  }

  public getImmediateTargetFrame(): number {
    return this.getCurrentFrame();
  }

  public async enqueue(
    opcode: number,
    track: number,
    arg0 = 0,
    arg1 = 0,
    targetFrame?: number,
  ): Promise<BrowserRealtimeAck> {
    if (this.disposed) throw new Error('Browser realtime runtime is closed.');
    const intentFrame = this.getCurrentFrame();
    const scheduledTargetFrame = targetFrame ?? intentFrame;
    const sequence = this.nextSequence();
    const intentionalWaitMs = Math.max(0, ((scheduledTargetFrame - intentFrame) / this.sampleRate) * 1000);
    const timeoutMs = Math.min(0x7fff_ffff, Math.ceil(intentionalWaitMs) + ACKNOWLEDGEMENT_GRACE_MS);
    return await new Promise<BrowserRealtimeAck>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ackWaiters.delete(sequence);
        reject(new Error(`Realtime worklet did not acknowledge command ${sequence}.`));
      }, timeoutMs);
      this.ackWaiters.set(sequence, { intentFrame, targetFrame: scheduledTargetFrame, resolve, reject, timeout });

      const queued = queueSharedCommand(this.control, {
        sequence,
        opcode,
        track,
        targetFrame: scheduledTargetFrame,
        arg0,
        arg1,
      });
      if (!queued) {
        clearTimeout(timeout);
        this.ackWaiters.delete(sequence);
        reject(new Error('Realtime command queue is full.'));
      }
    });
  }

  public async setAlignmentSamples(track: number, samples: number): Promise<BrowserRealtimeAck> {
    this.assertTrackIndex(track);
    return await this.enqueue(
      BrowserRealtimeOpcode.SET_ALIGNMENT,
      track,
      Math.max(-BROWSER_REALTIME_SAMPLE_RATE, Math.min(BROWSER_REALTIME_SAMPLE_RATE, Math.round(samples))),
    );
  }

  public setRhythm(running: boolean, pattern: number): Promise<BrowserRealtimeAck> {
    return this.enqueue(BrowserRealtimeOpcode.SET_RHYTHM, -1, running ? 1 : 0, pattern);
  }

  public setBpm(bpm: number): Promise<BrowserRealtimeAck> {
    return this.enqueue(BrowserRealtimeOpcode.SET_BPM, -1, Math.max(40, Math.min(300, Math.round(bpm))));
  }

  public setClock(running: boolean): Promise<BrowserRealtimeAck> {
    return this.enqueue(BrowserRealtimeOpcode.SET_CLOCK, -1, running ? 1 : 0);
  }

  public async armLoopbackCapture(buffer: SharedArrayBuffer, startFrame: number, frames: number): Promise<void> {
    const meta = new Int32Array(buffer, 0, TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT);
    const capacityFrames = Atomics.load(meta, TrackMetaWord.CAPACITY_FRAMES);
    const validMonoLoopback = Atomics.load(meta, TrackMetaWord.CHANNEL_COUNT) === 1 &&
      Atomics.load(meta, TrackMetaWord.LAYOUT_VERSION) === BROWSER_REALTIME_LAYOUT_VERSION &&
      Atomics.load(meta, TrackMetaWord.STORAGE_LAYOUT) === BROWSER_REALTIME_LAYOUT_MONO &&
      buffer.byteLength === TRACK_META_BYTES + capacityFrames * Float32Array.BYTES_PER_ELEMENT &&
      Number.isInteger(frames) && frames > 0 && frames <= capacityFrames;
    if (!validMonoLoopback) {
      throw new Error('Loopback capture storage must use the versioned mono layout with sufficient capacity.');
    }
    if (this.loopbackArmWaiter) throw new Error('A loopback capture request is already awaiting worklet acknowledgement.');
    Atomics.store(meta, TrackMetaWord.RECORDING_FRAMES, 0);
    Atomics.store(meta, TrackMetaWord.LOOP_FRAMES, 0);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.loopbackArmWaiter = null;
        reject(new Error('Realtime worklet did not acknowledge loopback capture storage.'));
      }, 2_000);
      this.loopbackArmWaiter = { resolve, reject, timeout };
      this.node.port.postMessage({ type: 'ARM_LOOPBACK', buffer, startFrame, frames });
    });
  }

  public createLoopbackCaptureBuffer(frames: number): SharedArrayBuffer {
    return createMonoLoopbackSharedBuffer(frames);
  }

  public async exportTrack(track: number, context: AudioContext): Promise<AudioBuffer> {
    this.assertTrackIndex(track);
    const ack = await this.enqueue(BrowserRealtimeOpcode.EXPORT_TRACK, track);
    if (ack.status !== BrowserRealtimeStatus.OK && ack.status !== BrowserRealtimeStatus.LATE) {
      throw new Error(`Track ${track + 1} cannot be exported while it is recording or overdubbing.`);
    }
    if (ack.loopFrames <= 0) {
      throw new Error(`Track ${track + 1} has no recorded audio.`);
    }

    const samplesLeft = this.trackSamplesLeft[track];
    const samplesRight = this.trackSamplesRight[track];
    if (!samplesLeft || !samplesRight) throw new Error(`Track ${track + 1} storage is unavailable.`);
    const audioBuffer = context.createBuffer(BROWSER_REALTIME_TRACK_CHANNEL_COUNT, ack.loopFrames, context.sampleRate);
    audioBuffer.getChannelData(0).set(samplesLeft.subarray(0, ack.loopFrames));
    audioBuffer.getChannelData(1).set(samplesRight.subarray(0, ack.loopFrames));
    return audioBuffer;
  }

  public getMetrics(): BrowserRealtimeMetrics {
    const renderedFrame = this.getCurrentFrame();
    const read = Atomics.load(this.control, ControlWord.COMMAND_READ);
    const write = Atomics.load(this.control, ControlWord.COMMAND_WRITE);
    const loopFrames = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);
    const recordingFrames = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);
    const trackCapacityFrames = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);
    const trackStates = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);
    const trackPositions = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);

    for (let track = 0; track < BROWSER_REALTIME_TRACK_COUNT; track += 1) {
      const metadata = this.trackMetadata[track];
      loopFrames[track] = metadata ? Atomics.load(metadata, TrackMetaWord.LOOP_FRAMES) : 0;
      recordingFrames[track] = metadata ? Atomics.load(metadata, TrackMetaWord.RECORDING_FRAMES) : 0;
      trackCapacityFrames[track] = metadata ? Atomics.load(metadata, TrackMetaWord.CAPACITY_FRAMES) : 0;
      trackStates[track] = Atomics.load(this.trackStates, track);
      trackPositions[track] = this.trackPositions[track] ?? 0;
    }

    const deadlineMetricAvailable = Atomics.load(this.control, ControlWord.DEADLINE_METRIC_AVAILABLE) !== 0;
    const deadlineMisses = Atomics.load(this.control, ControlWord.DEADLINE_MISSES);

    return {
      sampleRate: this.sampleRate,
      quantumFrames: Math.max(1, Atomics.load(this.control, ControlWord.LAST_QUANTUM_FRAMES) || BROWSER_REALTIME_QUANTUM_FRAMES),
      renderedFrame,
      underruns: Atomics.load(this.control, ControlWord.UNDERRUNS),
      commandQueueDepth: (write - read) >>> 0,
      loopFrames,
      recordingFrames,
      trackStates,
      trackPositions,
      outputMonitorEnabled: Atomics.load(this.control, ControlWord.OUTPUT_MONITOR_ENABLED) !== 0,
      backendMode: 'sab-worklet',
      lastAckSequence: Atomics.load(this.control, ControlWord.LAST_ACK_SEQUENCE) >>> 0,
      commandOverruns: Atomics.load(this.control, ControlWord.COMMAND_OVERRUNS),
      processDeadlineMisses: deadlineMetricAvailable ? deadlineMisses : null,
      deadlineMetricAvailable,
      inputDropoutBlocks: Atomics.load(this.control, ControlWord.INPUT_DROPOUT_BLOCKS),
      trackCapacityOverruns: Atomics.load(this.control, ControlWord.TRACK_CAPACITY_OVERRUNS),
      maxTrackFrames: BROWSER_REALTIME_MAX_TRACK_FRAMES,
      trackCapacityFrames,
    };
  }

  public getTrackMetadata(track: number): Int32Array | null {
    this.assertTrackIndex(track);
    return this.trackMetadata[track] ?? null;
  }

  public getTrackSamples(track: number, channel: 0 | 1 = 0): Float32Array | null {
    this.assertTrackIndex(track);
    return (channel === 0 ? this.trackSamplesLeft[track] : this.trackSamplesRight[track]) ?? null;
  }

  public getTrackChannelSamples(track: number, channel: 0 | 1): Float32Array | null {
    return this.getTrackSamples(track, channel);
  }

  public dispose() {
    this.disposed = true;
    this.failAllWaiters(new Error('Browser realtime runtime closed before acknowledgement.'));
    this.node.port.onmessage = null;
    this.node.port.onmessageerror = null;
  }

  private handleMessage(message: BrowserRealtimeRuntimeMessage) {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'TRACK_ATTACHED' && typeof message.track === 'number') {
      const waiter = this.attachWaiters.get(message.track);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.attachWaiters.delete(message.track);
        if (message.channelCount !== BROWSER_REALTIME_TRACK_CHANNEL_COUNT ||
            message.layoutVersion !== BROWSER_REALTIME_LAYOUT_VERSION ||
            message.storageLayout !== BROWSER_REALTIME_LAYOUT_PLANAR_LR) {
          waiter.reject(new Error(
            `Track ${message.track + 1} storage handshake mismatch: expected ${BROWSER_REALTIME_TRACK_CHANNEL_COUNT}-channel planar LR layout v${BROWSER_REALTIME_LAYOUT_VERSION}.`,
          ));
        } else {
          waiter.resolve();
        }
      }
    } else if (message.type === 'LOOPBACK_ARMED') {
      const waiter = this.loopbackArmWaiter;
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.loopbackArmWaiter = null;
        waiter.resolve();
      }
    } else if (message.type === 'LOOPBACK_ARM_ERROR') {
      const waiter = this.loopbackArmWaiter;
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.loopbackArmWaiter = null;
        waiter.reject(new Error(message.message || 'Loopback capture storage was rejected by the worklet.'));
      }
    } else if (message.type === 'TRACK_ATTACH_ERROR' && typeof message.track === 'number') {
      const waiter = this.attachWaiters.get(message.track);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.attachWaiters.delete(message.track);
        waiter.reject(new Error(message.message || `Track ${message.track + 1} storage layout was rejected by the worklet.`));
      }
    } else if (message.type === 'ACK' && typeof message.sequence === 'number') {
      const sequence = message.sequence >>> 0;
      const waiter = this.ackWaiters.get(sequence);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.ackWaiters.delete(sequence);
        const executedFrame = message.executedFrame ?? 0;
        const targetFrame = message.targetFrame ?? waiter.targetFrame;
        const intentToScheduledFrames = targetFrame - waiter.intentFrame;
        const scheduledToActualFrames = executedFrame - targetFrame;
        waiter.resolve({
          sequence,
          opcode: message.opcode ?? 0,
          track: message.track ?? -1,
          intentFrame: waiter.intentFrame,
          executedFrame,
          targetFrame,
          intentToScheduledFrames,
          scheduledToActualFrames,
          intentToScheduledMs: (intentToScheduledFrames / this.sampleRate) * 1000,
          scheduledToActualMs: (scheduledToActualFrames / this.sampleRate) * 1000,
          status: message.status ?? BrowserRealtimeStatus.INVALID_STATE,
          loopFrames: message.loopFrames ?? 0,
          recordingFrames: message.recordingFrames ?? 0,
        });
      }
    }

    this.messageHandler?.(message);
  }

  private nextSequence(): number {
    this.sequence = (this.sequence + 1) >>> 0;
    if (this.sequence === 0) this.sequence = 1;
    return this.sequence;
  }

  private assertTrackIndex(track: number) {
    if (!Number.isInteger(track) || track < 0 || track >= BROWSER_REALTIME_TRACK_COUNT) {
      throw new RangeError(`Track index must be between 0 and ${BROWSER_REALTIME_TRACK_COUNT - 1}.`);
    }
  }

  private failAllWaiters(error: Error) {
    for (const waiter of this.attachWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.attachWaiters.clear();
    for (const waiter of this.ackWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.ackWaiters.clear();
    if (this.loopbackArmWaiter) {
      clearTimeout(this.loopbackArmWaiter.timeout);
      this.loopbackArmWaiter.reject(error);
      this.loopbackArmWaiter = null;
    }
  }
}
