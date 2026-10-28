import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

class WorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly messages: Array<{ message: any; transfers: Transferable[] }> = [];

  postMessage(message: any, transfers: Transferable[] = []) {
    this.messages.push({ message: { ...message }, transfers: transfers.slice() });
  }

  receive(message: unknown) {
    const data = message && typeof message === 'object' && (message as any).type === 'START_CAPTURE'
      && !Number.isSafeInteger((message as any).captureReadyEpoch)
      ? { ...(message as any), captureReadyEpoch: this.messages
        .filter(({ message: sent }) => sent.type === 'INPUT_CAPTURE_READY')
        .at(-1)?.message.captureReadyEpoch ?? 0 }
      : message;
    this.onmessage?.({ data });
  }
}

class WorkletBase {
  readonly port = new WorkletPort();
  constructor(_options?: unknown) {}
}

function loadProcessor() {
  const source = readFileSync(resolve(process.cwd(), 'public/worklets/browser-input-capture.js'), 'utf8');
  const factory = new Function('AudioWorkletProcessor', 'registerProcessor', `${source}\nreturn BrowserInputCaptureProcessor;`) as (
    base: typeof WorkletBase,
    register: (name: string, processor: new (options?: any) => any) => void,
  ) => new (options?: any) => any;
  return factory(WorkletBase, () => {});
}

function createCapture(options: Record<string, number> = {}) {
  const Processor = loadProcessor();
  const processor = new Processor({
    processorOptions: {
      trackCount: 1,
      chunkSize: 4,
      chunkPoolSize: 3,
      preRollFrames: 8,
      maxRecordingBytes: 256,
      ...options,
    },
  });
  processor.port.receive({ type: 'INPUT_READY', ready: true, generation: 1 });
  const process = (left: number[], right?: number[], frameStart?: number,
    processedLeftValues: number[] = left, processedRightValues?: number[],
    bounceInputs: Array<[number[], number[]?]> = []) => {
    const rawLeft = Float32Array.from(left);
    const rawChannels = right === undefined ? [rawLeft] : [rawLeft, Float32Array.from(right)];
    const processedLeft = Float32Array.from(processedLeftValues);
    const defaultProcessedRight = processedLeftValues === left && right !== undefined
      ? right : processedLeftValues;
    const processedChannels = [processedLeft, Float32Array.from(processedRightValues ?? defaultProcessedRight)];
    const inputs = [rawChannels, processedChannels];
    for (let source = 0; source < (options.trackCount ?? 1); source += 1) {
      const bounce = bounceInputs[source];
      inputs.push(bounce ? [Float32Array.from(bounce[0]), Float32Array.from(bounce[1] ?? bounce[0])] : []);
    }
    const outputs = [[new Float32Array(left.length), new Float32Array(left.length)]];
    const runtimeGlobal = globalThis as typeof globalThis & { currentFrame?: number };
    const hadCurrentFrame = Object.prototype.hasOwnProperty.call(runtimeGlobal, 'currentFrame');
    const previousCurrentFrame = runtimeGlobal.currentFrame;
    if (frameStart !== undefined) runtimeGlobal.currentFrame = frameStart;
    try {
      expect(processor.process(inputs, outputs)).toBe(true);
    } finally {
      if (frameStart !== undefined) {
        if (hadCurrentFrame) runtimeGlobal.currentFrame = previousCurrentFrame;
        else delete runtimeGlobal.currentFrame;
      }
    }
    expect(Array.from(outputs[0]![0]!)).toEqual(new Array(left.length).fill(0));
    expect(Array.from(outputs[0]![1]!)).toEqual(new Array(left.length).fill(0));
  };
  const messages = (type: string) => processor.port.messages
    .map(({ message }) => message)
    .filter((message) => message.type === type);
  return { processor, process, messages };
}

describe('Browser shared input capture worklet', () => {
  it('acknowledges a quantized start on the exact current input frame', () => {
    const capture = createCapture();
    capture.process([0, 1, 2, 3], undefined, 0);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 80, inputGeneration: 1,
      startFrame: 4, maxRecordingBytes: 256,
    });

    // Requested frame equals the next callback's currentFrame exactly.
    capture.process([4, 5, 6, 7], undefined, 4);

    expect(capture.messages('RECORD_CONFIGURED')[0]).toMatchObject({
      requestedStartFrame: 4, captureStartFrame: 4,
    });
    expect(capture.messages('RECORD_CHUNK')[0]).toMatchObject({ startFrame: 4, validFrames: 4 });
  });

  it('fails closed when a callback jump skips the requested first frame', () => {
    const capture = createCapture();
    capture.process([0, 1, 2, 3], undefined, 0);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 81, inputGeneration: 1,
      startFrame: 4, maxRecordingBytes: 256,
    });

    // The target was frame 4, but the next callback begins at frame 8.
    capture.process([8, 9, 10, 11], undefined, 8);

    expect(capture.messages('RECORD_CONFIGURED')).toHaveLength(0);
    expect(capture.messages('CAPTURE_ERROR')[0]).toMatchObject({
      reason: 'input-frame-discontinuity', callbackFrameStart: 8, callbackFrameCount: 4,
      previousCallbackEndFrame: 4, preRollEndAtCallbackStart: 4,
    });
    expect(capture.messages('RECORD_ABORTED')).toHaveLength(1);
  });

  it('stops backfill after a frame continuity abort without repeated errors or completion', () => {
    const capture = createCapture({ readyPreRollFrames: 4 });
    capture.process([0, 1, 2, 3], undefined, 0);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 82, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256,
    });
    const slot = capture.processor.slots[0];
    // Simulate an internal cursor mismatch at the first backfilled frame.
    slot.captureFramesProcessed = 1;

    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 82, stopFrame: 4 });

    expect(capture.messages('CAPTURE_ERROR')).toHaveLength(1);
    expect(capture.messages('CAPTURE_ERROR')[0]).toMatchObject({ reason: 'capture-frame-discontinuity' });
    expect(capture.messages('RECORD_ABORTED')).toHaveLength(1);
    expect(capture.messages('RECORD_COMPLETE')).toHaveLength(0);
  });

  it('backfills the requested stereo start frame and reports an exclusive stop frame', () => {
    const capture = createCapture();
    capture.process([0, 1, 2, 3], [0, -1, -2, -3]);
    capture.process([4, 5, 6, 7], [-4, -5, -6, -7]);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 1, inputGeneration: 1,
      startFrame: 2, maxRecordingBytes: 256,
    });
    capture.process([8, 9, 10, 11], [-8, -9, -10, -11]);

    // The STOP message arrives after frames 10 and 11 were already processed.
    // The ACK's [2, 10) limit is authoritative; final assembly must discard the
    // two captured-but-unrequested tail samples in the last in-flight buffer.
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 1, stopFrame: 10 });
    const configured = capture.messages('RECORD_CONFIGURED')[0];
    const chunks = capture.messages('RECORD_CHUNK');
    const complete = capture.messages('RECORD_COMPLETE')[0];

    expect(configured).toMatchObject({
      channelCount: 2, requestedStartFrame: 2,
      preRollCapacityFrames: 8, preRollValidFrames: 8,
    });
    expect(Number.isSafeInteger(configured.startReceivedFrame)).toBe(true);
    expect(configured.requestAgeAtStartFrames).toBe(configured.startReceivedFrame - configured.requestedStartFrame);
    expect(chunks.map((chunk: any) => [chunk.startFrame, chunk.validFrames])).toEqual([[2, 4], [6, 4]]);
    expect(chunks.flatMap((chunk: any) => Array.from(chunk.channels[0].subarray(0, chunk.validFrames))))
      .toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(chunks.flatMap((chunk: any) => Array.from(chunk.channels[1].subarray(0, chunk.validFrames))))
      .toEqual([-2, -3, -4, -5, -6, -7, -8, -9]);
    expect(complete).toMatchObject({
      requestedStartFrame: 2, stopFrame: 10, framesCaptured: 8,
      chunksSent: 2, channelCount: 2, status: 'complete',
      preRollCapacityFrames: 8,
    });
    expect(complete.startReceivedFrame).toBe(configured.startReceivedFrame);
    expect(complete.requestAgeAtStartFrames).toBe(configured.requestAgeAtStartFrames);
    expect(capture.messages('INPUT_CAPTURE_READY').at(-1)).toMatchObject({
      oldestAvailableFrame: 0, latestAvailableFrame: 8,
      preRollValidFrames: 8, requiredPreRollFrames: 8,
    });
  });

  it('mixes only the snapshotted Bounce source mask into stereo input and pre-roll', () => {
    const capture = createCapture({ trackCount: 5, chunkSize: 16, preRollFrames: 8, readyPreRollFrames: 4 });
    const sources = (left: number, right: number): Array<[number[], number[]]> => [
      [[100, 100, 100, 100], [100, 100, 100, 100]],
      [[left, left, left, left], [right, right, right, right]],
      [[200, 200, 200, 200], [200, 200, 200, 200]],
      [[300, 300, 300, 300], [300, 300, 300, 300]],
      [[400, 400, 400, 400], [400, 400, 400, 400]],
    ];
    capture.process([1, 1, 1, 1], [10, 10, 10, 10], 0, [1, 1, 1, 1], [10, 10, 10, 10], sources(2, 20));
    capture.processor.port.receive({ type: 'START_CAPTURE', trackIndex: 0, sessionId: 70, inputGeneration: 1,
      startFrame: 2, maxRecordingBytes: 256, bounceSourceMask: 2 });
    capture.process([1, 1, 1, 1], [10, 10, 10, 10], 4, [1, 1, 1, 1], [10, 10, 10, 10], sources(2, 20));
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 70, stopFrame: 6 });
    const chunks = capture.messages('RECORD_CHUNK');
    expect(chunks.flatMap((chunk: any) => Array.from(chunk.channels[0].subarray(0, chunk.validFrames)))).toEqual([3, 3, 3, 3]);
    expect(chunks.flatMap((chunk: any) => Array.from(chunk.channels[1].subarray(0, chunk.validFrames)))).toEqual([30, 30, 30, 30]);
    capture.processor.port.receive({ type: 'START_CAPTURE', trackIndex: 0, sessionId: 71, inputGeneration: 1,
      startFrame: 6, maxRecordingBytes: 256, bounceSourceMask: 1 });
    expect(capture.messages('CAPTURE_ERROR').at(-1)).toMatchObject({ sessionId: 71, reason: 'invalid-capture-request' });
  });

  it('switches one recording from processed to raw exactly at the acknowledged frame', () => {
    const capture = createCapture({ chunkSize: 16, preRollFrames: 16, readyPreRollFrames: 4 });
    capture.process([10, 11, 12, 13], [20, 21, 22, 23], 100,
      [1, 2, 3, 4], [-1, -2, -3, -4]);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 99, inputGeneration: 1,
      startFrame: 100, maxRecordingBytes: 256,
    });
    capture.processor.port.receive({
      type: 'SET_TRACK_FX_APPLY', trackIndex: 0, enabled: false, revision: 1, applyFrame: 106,
    });
    capture.process([14, 15, 16, 17], [24, 25, 26, 27], 104,
      [5, 6, 7, 8], [-5, -6, -7, -8]);
    capture.process([18, 19, 20, 21], [28, 29, 30, 31], 108,
      [9, 10, 11, 12], [-9, -10, -11, -12]);
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 99, stopFrame: 112 });

    const chunk = capture.messages('RECORD_CHUNK').find((message: any) => message.sessionId === 99);
    expect(Array.from(chunk.channels[0].subarray(0, chunk.validFrames))).toEqual([1, 2, 3, 4, 5, 6, 16, 17, 18, 19, 20, 21]);
    expect(Array.from(chunk.channels[1].subarray(0, chunk.validFrames))).toEqual([-1, -2, -3, -4, -5, -6, 26, 27, 28, 29, 30, 31]);
    expect(capture.messages('TRACK_FX_APPLY_ACK')).toContainEqual(expect.objectContaining({
      route: 'input', trackIndex: 0, revision: 1, enabled: false, requestedFrame: 106,
      appliedFrame: 106, ok: true,
    }));
  });

  it('publishes readiness only after contiguous pre-roll and invalidates it across a forward gap', () => {
    const capture = createCapture({ preRollFrames: 8 });
    capture.process([0, 1, 2, 3], undefined, 100);
    expect(capture.messages('INPUT_CAPTURE_READY')).toHaveLength(0);

    capture.process([4, 5, 6, 7], undefined, 104);
    expect(capture.messages('INPUT_CAPTURE_READY')).toMatchObject([
      { oldestAvailableFrame: 100, latestAvailableFrame: 108, preRollValidFrames: 8, requiredPreRollFrames: 8 },
    ]);

    // Frames [108,112) are unavailable. Readiness must be withdrawn, and a
    // start request anchored in that missing region must fail rather than move.
    capture.process([12, 13, 14, 15], undefined, 112);
    expect(capture.messages('INPUT_CAPTURE_NOT_READY').at(-1)).toMatchObject({
      reason: 'input-frame-discontinuity', frameStart: 112,
      oldestAvailableFrame: 100, latestAvailableFrame: 108,
      preRollValidFrames: 8,
    });
    capture.processor.port.receive({ type: 'CHECK_CAPTURE_READINESS', inputGeneration: 1 });
    expect(capture.messages('CAPTURE_READINESS_STATE').at(-1)).toMatchObject({
      inputGeneration: 1, captureReadyEpoch: 1, ready: false,
      preRollValidFrames: 4, requiredPreRollFrames: 8,
    });
    expect(capture.messages('INPUT_CAPTURE_READY')).toHaveLength(1);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 82, inputGeneration: 1,
      startFrame: 108, maxRecordingBytes: 256,
    });
    expect(capture.messages('CAPTURE_ERROR').at(-1)).toMatchObject({
      sessionId: 82, reason: 'capture-readiness-epoch-changed',
      requestedStartFrame: 108, oldestAvailableFrame: 112,
    });

    capture.process([16, 17, 18, 19], undefined, 116);
    expect(capture.messages('INPUT_CAPTURE_READY')).toHaveLength(2);
    expect(capture.messages('INPUT_CAPTURE_READY').at(-1)).toMatchObject({
      oldestAvailableFrame: 112, latestAvailableFrame: 120,
      preRollValidFrames: 8, requiredPreRollFrames: 8,
    });
    capture.processor.port.receive({ type: 'CHECK_CAPTURE_READINESS', inputGeneration: 1 });
    expect(capture.messages('CAPTURE_READINESS_STATE').at(-1)).toMatchObject({
      inputGeneration: 1, captureReadyEpoch: 1, ready: true,
      oldestAvailableFrame: 112, latestAvailableFrame: 120,
    });

    // Once the tap has acknowledged a fresh contiguous pre-roll, retrying at
    // a frame inside that range succeeds without shifting the requested frame.
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 84, inputGeneration: 1,
      startFrame: 116, maxRecordingBytes: 256,
    });
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 84, stopFrame: 120 });
    expect(capture.messages('RECORD_CONFIGURED').at(-1)).toMatchObject({
      sessionId: 84, requestedStartFrame: 116, captureStartFrame: 116,
    });
    expect(capture.messages('RECORD_COMPLETE').at(-1)).toMatchObject({
      sessionId: 84, requestedStartFrame: 116, stopFrame: 120, framesCaptured: 4,
    });
  });

  it('keeps a future scheduled capture across a gap that ends before its requested frame', () => {
    const capture = createCapture({ chunkSize: 4, preRollFrames: 8 });
    capture.process([0, 1, 2, 3], undefined, 100);
    capture.process([4, 5, 6, 7], undefined, 104);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 83, inputGeneration: 1,
      startFrame: 112, maxRecordingBytes: 256,
    });

    // The missing [108,112) frames precede the scheduled start. Readiness is
    // withdrawn and pre-roll is rebuilt, while the future capture remains
    // pending so no samples at or after its requested boundary are lost.
    capture.process([12, 13, 14, 15], undefined, 112);
    expect(capture.messages('CAPTURE_ERROR')).toHaveLength(0);
    expect(capture.messages('INPUT_CAPTURE_NOT_READY').at(-1)).toMatchObject({
      reason: 'input-frame-discontinuity', frameStart: 112,
    });
    capture.process([16, 17, 18, 19], undefined, 116);
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 83, stopFrame: 120 });
    capture.process([20, 21, 22, 23], undefined, 120);

    expect(capture.messages('RECORD_COMPLETE').at(-1)).toMatchObject({
      sessionId: 83, requestedStartFrame: 112, stopFrame: 120, framesCaptured: 8, droppedFrames: 0,
    });
    const chunks = capture.messages('RECORD_CHUNK').filter((message: any) => message.sessionId === 83);
    expect(chunks.flatMap((message: any) => Array.from(message.channels[0].subarray(0, message.validFrames))))
      .toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('does not count duplicate or overlapping AudioWorklet frames toward the warm-up threshold', () => {
    const capture = createCapture({ preRollFrames: 12 });
    capture.process([0, 1, 2, 3], undefined, 100);
    capture.process([4, 5, 6, 7], undefined, 104);
    expect(capture.messages('INPUT_CAPTURE_READY')).toHaveLength(0);

    capture.processor.port.receive({ type: 'INPUT_READY', ready: true, generation: 2 });
    capture.process([0, 1, 2, 3], undefined, 200);
    capture.process([4, 5, 6, 7], undefined, 204);
    expect(capture.messages('INPUT_CAPTURE_READY')).toHaveLength(0);
    capture.process([4, 5, 6, 7], undefined, 204); // duplicate callback range
    capture.process([6, 7, 8, 9], undefined, 206); // two overlapping, two new
    expect(capture.processor.preRollValidFrames).toBe(10);
    expect(capture.messages('INPUT_CAPTURE_READY')).toHaveLength(0);
    capture.process([10, 11], undefined, 210);
    expect(capture.messages('INPUT_CAPTURE_READY')).toHaveLength(1);
    expect(capture.messages('INPUT_CAPTURE_READY').at(-1)).toMatchObject({ preRollValidFrames: 12 });
  });

  it('deduplicates rewound and partially overlapping callback ranges without losing the take', () => {
    const capture = createCapture({ chunkSize: 16, preRollFrames: 16, readyPreRollFrames: 4 });
    capture.process([0, 1, 2, 3], [10, 11, 12, 13], 100);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 50, inputGeneration: 1,
      startFrame: 100, maxRecordingBytes: 256,
    });

    capture.process([4, 5, 6, 7], [14, 15, 16, 17], 104);
    // Duplicate the already-processed quantum, then deliver a block whose
    // first two frames overlap and whose remaining suffix is new.
    capture.process([4, 5, 6, 7], [14, 15, 16, 17], 104);
    capture.process([6, 7, 8, 9], [16, 17, 18, 19], 106);
    capture.process([10, 11, 12, 13], [20, 21, 22, 23], 110);
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 50, stopFrame: 114 });

    expect(capture.messages('CAPTURE_ERROR')).toHaveLength(0);
    expect(capture.messages('RECORD_ABORTED')).toHaveLength(0);
    const chunks = capture.messages('RECORD_CHUNK').filter((message: any) => message.sessionId === 50);
    expect(chunks.flatMap((chunk: any) => Array.from(chunk.channels[0].subarray(0, chunk.validFrames))) )
      .toEqual(Array.from({ length: 14 }, (_, index) => index));
    expect(chunks.flatMap((chunk: any) => Array.from(chunk.channels[1].subarray(0, chunk.validFrames))) )
      .toEqual(Array.from({ length: 14 }, (_, index) => index + 10));
    expect(capture.messages('RECORD_COMPLETE').at(-1)).toMatchObject({
      requestedStartFrame: 100, stopFrame: 114, framesCaptured: 14,
      timelineOverlapEvents: 2, timelineOverlapFrames: 6,
    });
  });

  it('still aborts an active take when callback frames skip forward', () => {
    const capture = createCapture({ readyPreRollFrames: 4 });
    capture.process([1, 2, 3, 4], undefined, 0);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 51, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256,
    });
    capture.process([5, 6, 7, 8], undefined, 8);
    expect(capture.messages('CAPTURE_ERROR').at(-1)).toMatchObject({
      sessionId: 51, reason: 'input-frame-discontinuity',
    });
    expect(capture.messages('RECORD_ABORTED')).toHaveLength(1);
  });

  it('clips already-transferred chunks when STOP arrives late', () => {
    const capture = createCapture();
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 9, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256,
    });
    capture.process([0, 1, 2, 3], [10, 11, 12, 13]);
    capture.process([4, 5, 6, 7], [14, 15, 16, 17]);
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 9, stopFrame: 6 });

    const chunks = capture.messages('RECORD_CHUNK');
    const complete = capture.messages('RECORD_COMPLETE')[0];
    expect(chunks.map((chunk: any) => chunk.startFrame)).toEqual([0, 4]);
    expect(complete).toMatchObject({ requestedStartFrame: 0, stopFrame: 6, framesCaptured: 6, chunksSent: 2 });
    // The second transferred block contains frames 6-7, so main-thread
    // assembly must enforce framesCaptured rather than trusting full chunk size.
    expect(chunks[1]!.validFrames).toBe(4);
    expect(chunks[1]!.startFrame + chunks[1]!.validFrames).toBeGreaterThan(complete.framesCaptured);
  });

  it('waits for a future requested start and captures only before future stop', () => {
    const capture = createCapture();
    capture.process([0, 1, 2, 3]);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 2, inputGeneration: 1,
      startFrame: 6, maxRecordingBytes: 256,
    });
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 2, stopFrame: 9 });
    capture.process([4, 5, 6, 7]);
    capture.process([8, 9, 10, 11]);
    expect(capture.messages('RECORD_CONFIGURED')[0]).toMatchObject({
      requestedStartFrame: 6, captureStartFrame: 6,
    });

    const chunks = capture.messages('RECORD_CHUNK');
    const complete = capture.messages('RECORD_COMPLETE')[0];
    expect(chunks.flatMap((chunk: any) => Array.from(chunk.channels[0].subarray(0, chunk.validFrames))))
      .toEqual([6, 7, 8]);
    expect(complete).toMatchObject({ requestedStartFrame: 6, stopFrame: 9, framesCaptured: 3, chunksSent: 1 });
  });

  it('rejects a start frame that has expired from the bounded pre-roll', () => {
    const capture = createCapture({ preRollFrames: 4 });
    capture.process([0, 1, 2, 3]);
    capture.process([4, 5, 6, 7]);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 3, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256,
    });
    expect(capture.messages('CAPTURE_ERROR').at(-1)).toMatchObject({
      reason: 'request-frame-outside-preroll', startRejected: true,
      requestedStartFrame: 0,
      startReceivedFrame: 8,
      requestAgeAtStartFrames: 8,
      preRollCapacityFrames: 4,
      preRollValidFrames: 4,
      oldestAvailableFrame: 4,
      latestAvailableFrame: 8,
      inputReady: true,
      inputGeneration: 1,
      currentInputGeneration: 1,
    });
    expect(capture.messages('RECORD_CHUNK')).toHaveLength(0);
  });

  it('allows a fresh recording request after an expired preroll request is rejected', () => {
    const capture = createCapture({ preRollFrames: 4 });
    capture.process([0, 1, 2, 3]);
    capture.process([4, 5, 6, 7]);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 30, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256,
    });
    expect(capture.messages('CAPTURE_ERROR').at(-1)).toMatchObject({ reason: 'request-frame-outside-preroll', startRejected: true });

    // The refusal must leave the slot reusable. A caller that starts a new
    // take at a frame still present in the ring receives the exact PCM.
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 31, inputGeneration: 1,
      startFrame: 4, maxRecordingBytes: 256,
    });
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 31, stopFrame: 9 });
    capture.process([8, 9, 10, 11]);

    const complete = capture.messages('RECORD_COMPLETE').at(-1);
    const chunks = capture.messages('RECORD_CHUNK').filter((message: any) => message.sessionId === 31);
    expect(complete).toMatchObject({ sessionId: 31, requestedStartFrame: 4, stopFrame: 9, framesCaptured: 5, status: 'complete' });
    expect(chunks.flatMap((chunk: any) => Array.from(chunk.channels[0].subarray(0, chunk.validFrames))))
      .toEqual([4, 5, 6, 7, 8]);
  });

  it('requires returned buffers before reusing a track capture slot', () => {
    const capture = createCapture({ chunkSize: 2, chunkPoolSize: 1, preRollFrames: 4 });
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 4, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256,
    });
    capture.process([1, 2]);
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 4, stopFrame: 2 });
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 5, inputGeneration: 1,
      startFrame: 2, maxRecordingBytes: 256,
    });
    expect(capture.messages('CAPTURE_ERROR').at(-1)).toMatchObject({ reason: 'chunk-pool-not-reclaimed', startRejected: true });

    const chunk = capture.messages('RECORD_CHUNK')[0];
    capture.processor.port.receive({
      type: 'RECYCLE_CHUNK', trackIndex: 0, sessionId: 4, inputGeneration: 1, chunkIndex: chunk.chunkIndex,
      channels: [new Float32Array(2)],
    });
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 5, inputGeneration: 1,
      startFrame: 2, maxRecordingBytes: 256,
    });
    expect(capture.messages('CAPTURE_ERROR').at(-1)?.reason).toBe('chunk-pool-not-reclaimed');
    // Session IDs cannot be reused to mutate a newer slot's pool lease.
    capture.processor.port.receive({
      type: 'RECYCLE_CHUNK', trackIndex: 0, sessionId: 4, inputGeneration: 1, chunkIndex: chunk.chunkIndex,
      channels: [new Float32Array(2)],
    });
    expect(capture.processor.slots[0].state).toBe('pending');
  });

  it('confirms an aborted session only after its exact pool has been reclaimed and the slot is idle', () => {
    const capture = createCapture({ chunkSize: 2, chunkPoolSize: 1, preRollFrames: 4 });
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 44, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256,
    });
    capture.process([1, 2]);
    const chunk = capture.messages('RECORD_CHUNK')[0];
    capture.processor.port.receive({ type: 'ABORT_CAPTURE', trackIndex: 0, sessionId: 44, inputGeneration: 1 });
    expect(capture.processor.slots[0].state).toBe('aborting');
    expect(capture.messages('CAPTURE_POOL_RELEASED')).toHaveLength(0);

    // A stale recycle from another session cannot release this pool lease.
    capture.processor.port.receive({
      type: 'RECYCLE_CHUNK', trackIndex: 0, sessionId: 43, inputGeneration: 1, chunkIndex: chunk.chunkIndex,
      channels: [new Float32Array(2), new Float32Array(2)],
    });
    expect(capture.processor.slots[0].state).toBe('aborting');
    expect(capture.messages('CAPTURE_POOL_RELEASED')).toHaveLength(0);

    capture.processor.port.receive({
      type: 'RECYCLE_CHUNK', trackIndex: 0, sessionId: 44, inputGeneration: 1, chunkIndex: chunk.chunkIndex,
      channels: [new Float32Array(2), new Float32Array(2)],
    });
    expect(capture.processor.slots[0].state).toBe('idle');
    expect(capture.messages('CAPTURE_POOL_RELEASED')).toEqual([{
      type: 'CAPTURE_POOL_RELEASED', trackIndex: 0, sessionId: 44, inputGeneration: 1,
    }]);
  });

  it('keeps a completed slot leased when Clear runs between ordered chunk and complete messages', () => {
    const capture = createCapture({ chunkSize: 2, chunkPoolSize: 1, preRollFrames: 4 });
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 45, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256,
    });
    capture.process([1, 2]);
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 45, stopFrame: 2 });

    const chunk = capture.messages('RECORD_CHUNK')[0];
    expect(capture.messages('RECORD_COMPLETE')).toHaveLength(1);
    expect(capture.processor.port.messages
      .map(({ message }) => message.type)
      .filter((type) => type === 'RECORD_CHUNK' || type === 'RECORD_COMPLETE'))
      .toEqual(['RECORD_CHUNK', 'RECORD_COMPLETE']);
    expect(capture.processor.slots[0].state).toBe('idle');
    expect(capture.processor.slots[0].poolLeasePending).toBe(true);
    expect(capture.messages('CAPTURE_POOL_RELEASED')).toHaveLength(0);

    // The worklet emitted these in FIFO order. Main-thread Clear may run after
    // handling the chunk message and before its next complete-message task;
    // the retained chunk is returned only after that Clear has retired the
    // session. The pool ACK must wait for this exact generation's return.
    capture.processor.port.receive({ type: 'ABORT_CAPTURE', trackIndex: 0, sessionId: 45, inputGeneration: 1 });
    capture.processor.port.receive({
      type: 'RECYCLE_CHUNK', trackIndex: 0, sessionId: 45, inputGeneration: 0,
      chunkIndex: chunk.chunkIndex, channels: [new Float32Array(2), new Float32Array(2)],
    });
    expect(capture.processor.slots[0].state).toBe('aborting');
    expect(capture.messages('CAPTURE_POOL_RELEASED')).toHaveLength(0);

    capture.processor.port.receive({
      type: 'RECYCLE_CHUNK', trackIndex: 0, sessionId: 45, inputGeneration: 1,
      chunkIndex: chunk.chunkIndex, channels: [new Float32Array(2), new Float32Array(2)],
    });
    expect(capture.processor.slots[0].state).toBe('idle');
    expect(capture.messages('CAPTURE_POOL_RELEASED')).toEqual([{
      type: 'CAPTURE_POOL_RELEASED', trackIndex: 0, sessionId: 45, inputGeneration: 1,
    }]);
  });

  it('applies an explicit per-session frame budget to a bounded startup-backfill capture', () => {
    const capture = createCapture({ chunkSize: 4, chunkPoolSize: 3, preRollFrames: 8 });
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 21, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256, maxRecordingFrames: 2,
    });
    capture.process([1, 2, 3, 4], [-1, -2, -3, -4]);
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 21, stopFrame: 4 });

    const configured = capture.messages('RECORD_CONFIGURED')[0];
    const chunk = capture.messages('RECORD_CHUNK')[0];
    const complete = capture.messages('RECORD_COMPLETE')[0];
    expect(configured).toMatchObject({ requestedStartFrame: 0, maxRecordingFrames: 2, channelCount: 2 });
    expect(chunk).toMatchObject({ startFrame: 0, validFrames: 2, channelCount: 2 });
    expect(Array.from(chunk.channels[0].subarray(0, chunk.validFrames))).toEqual([1, 2]);
    expect(Array.from(chunk.channels[1].subarray(0, chunk.validFrames))).toEqual([-1, -2]);
    expect(complete).toMatchObject({
      requestedStartFrame: 0, stopFrame: 4, framesCaptured: 2,
      maxRecordingFrames: 2, droppedFrames: 2, status: 'incomplete',
    });
  });

  it('fails an active capture when the input generation changes', () => {
    const capture = createCapture();
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 6, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256,
    });
    capture.process([1, 2]);
    capture.processor.port.receive({ type: 'INPUT_READY', ready: false, generation: 2 });
    expect(capture.messages('CAPTURE_ERROR').map((message: any) => message.reason)).toContain('input-disconnected');
    expect(capture.messages('RECORD_ABORTED')).toHaveLength(1);
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 7, inputGeneration: 1,
      startFrame: 4, maxRecordingBytes: 256,
    });
    expect(capture.messages('CAPTURE_ERROR').at(-1)?.reason).toBe('invalid-capture-request');
  });

  it('does not carry a live capture across a ready-to-ready device generation switch', () => {
    const capture = createCapture();
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 8, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256,
    });
    capture.process([1, 2]);
    capture.processor.port.receive({ type: 'INPUT_READY', ready: true, generation: 2 });
    expect(capture.messages('CAPTURE_ERROR').map((message: any) => message.reason))
      .toContain('input-generation-changed');
    expect(capture.messages('RECORD_ABORTED')).toHaveLength(1);
    expect(capture.processor.preRollValidFrames).toBe(0);
  });

  it('tags stale start errors with the requested generation so the owning session can observe them', () => {
    const capture = createCapture();
    capture.process([0, 1, 2, 3]);
    capture.processor.port.receive({ type: 'INPUT_READY', ready: true, generation: 2 });
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 19, inputGeneration: 1,
      startFrame: 4, maxRecordingBytes: 256,
    });

    expect(capture.messages('CAPTURE_ERROR').at(-1)).toMatchObject({
      sessionId: 19, inputGeneration: 1, reason: 'invalid-capture-request',
    });
  });

  it('reports pool exhaustion as an incomplete take rather than silently skipping frames', () => {
    const capture = createCapture({ chunkSize: 2, chunkPoolSize: 1, preRollFrames: 4 });
    capture.processor.port.receive({
      type: 'START_CAPTURE', trackIndex: 0, sessionId: 20, inputGeneration: 1,
      startFrame: 0, maxRecordingBytes: 256,
    });
    capture.process([1, 2, 3, 4]);
    capture.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 20, stopFrame: 4 });

    expect(capture.messages('RECORD_COMPLETE').at(-1)).toMatchObject({
      framesCaptured: 2, droppedFrames: 2, overflowEvents: 1, status: 'incomplete',
    });
  });
});


describe('Browser AutoRec sample trigger', () => {
  it('waits on raw stereo input and captures the exact crossing sample without pre-trigger PCM', () => {
    const c = createCapture();
    c.process([0, 0, 0, 0]); c.process([0, 0, 0, 0]);
    c.processor.port.receive({ type: 'START_CAPTURE', trackIndex: 0, sessionId: 1, inputGeneration: 1, startFrame: 8, autoRecThreshold: 0.5 });
    c.process([0.1, 0.2, 0.5, 0.1], undefined, 8, [1, 1, 1, 1]);
    expect(c.messages('RECORD_CONFIGURED')).toHaveLength(0); // FX output alone cannot trigger.
    c.process([0.1, 0.1, 0.1, 0.1], [0.1, -0.75, 0.1, 0.1], 12, [2, 3, 4, 5]);
    expect(c.messages('RECORD_CONFIGURED')[0]).toMatchObject({ requestedStartFrame: 13 });
    c.processor.port.receive({ type: 'STOP_CAPTURE', trackIndex: 0, sessionId: 1, stopFrame: 16 });
    const chunk = c.messages('RECORD_CHUNK')[0];
    expect(chunk.validFrames).toBe(3);
    expect(Array.from(chunk.channels[0]).slice(0, 3)).toEqual([3, 4, 5]);
    expect(c.messages('RECORD_COMPLETE')[0]).toMatchObject({ requestedStartFrame: 13, stopFrame: 16, framesCaptured: 3 });
  });
  it('cancels an armed session without producing a take and allows rearming', () => {
    const c = createCapture(); c.process([0, 0, 0, 0]); c.process([0, 0, 0, 0]);
    c.processor.port.receive({ type: 'START_CAPTURE', trackIndex: 0, sessionId: 1, inputGeneration: 1, startFrame: 8, autoRecThreshold: 0.5 });
    c.processor.port.receive({ type: 'ABORT_CAPTURE', trackIndex: 0, sessionId: 1, inputGeneration: 1 });
    c.process([1, 1, 1, 1]);
    expect(c.messages('RECORD_CONFIGURED')).toHaveLength(0);
    expect(c.messages('RECORD_COMPLETE')).toHaveLength(0);
    c.processor.port.receive({ type: 'START_CAPTURE', trackIndex: 0, sessionId: 2, inputGeneration: 1, startFrame: 12, autoRecThreshold: 0.5 });
    c.process([0, 1, 0, 0]);
    expect(c.messages('RECORD_CONFIGURED')[0]).toMatchObject({ sessionId: 2, requestedStartFrame: 13 });
  });
  it('input generation loss aborts an armed session, with no silent completed loop', () => {
    const c = createCapture(); c.process([0, 0, 0, 0]); c.process([0, 0, 0, 0]);
    c.processor.port.receive({ type: 'START_CAPTURE', trackIndex: 0, sessionId: 1, inputGeneration: 1, startFrame: 8, autoRecThreshold: 0.5 });
    c.processor.port.receive({ type: 'INPUT_READY', ready: false, generation: 2 });
    c.process([1, 1, 1, 1]);
    expect(c.messages('RECORD_ABORTED')).toHaveLength(1);
    expect(c.messages('RECORD_COMPLETE')).toHaveLength(0);
  });
});
