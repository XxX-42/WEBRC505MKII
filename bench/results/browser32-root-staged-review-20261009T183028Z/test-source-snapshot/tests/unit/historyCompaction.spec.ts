import { describe, expect, it } from 'vitest';
import { createCoreAudioHarness, type CoreAudioHarness } from '../helpers/coreAudioHarness';
import {
  BROWSER_REALTIME_STORAGE_BATCH_FRAMES,
  BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
  BROWSER_REALTIME_MAX_STORAGE_BYTES,
  BrowserRealtimeOpcode,
  ControlWord,
  TRACK_META_BYTES,
  TrackMetaWord,
} from '../../src/audio/browserRealtimeProtocol';

const LONG_LOOP_FRAMES = BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * 8 + 1;
const TAKE_FRAMES = 128;

interface ExpectedPcm {
  left: Float32Array;
  right: Float32Array;
}

function createExportContext(sampleRate = 48_000): AudioContext {
  return {
    sampleRate,
    createBuffer(channelCount: number, length: number, rate: number) {
      const channels = Array.from({ length: channelCount }, () => new Float32Array(length));
      return {
        numberOfChannels: channelCount,
        length,
        sampleRate: rate,
        getChannelData(channel: number) { return channels[channel]!; },
      } as unknown as AudioBuffer;
    },
  } as unknown as AudioContext;
}

function expectPcm(actual: AudioBuffer, expected: ExpectedPcm): void {
  expect(actual.numberOfChannels).toBe(2);
  expect(actual.length).toBe(expected.left.length);
  let maxError = 0;
  const actualLeft = actual.getChannelData(0);
  const actualRight = actual.getChannelData(1);
  for (let frame = 0; frame < expected.left.length; frame += 1) {
    maxError = Math.max(maxError, Math.abs(actualLeft[frame]! - expected.left[frame]!));
    maxError = Math.max(maxError, Math.abs(actualRight[frame]! - expected.right[frame]!));
  }
  expect(maxError).toBeLessThan(1e-7);
}

function setExpectedTake(
  expected: ExpectedPcm,
  startFrame: number,
  mode: 'OVERDUB' | 'REPLACE1' | 'REPLACE2',
  inputLeft: number,
  inputRight: number,
): void {
  for (let offset = 0; offset < TAKE_FRAMES; offset += 1) {
    const frame = (startFrame + offset) % expected.left.length;
    if (mode === 'OVERDUB') {
      expected.left[frame] = expected.left[frame]! + inputLeft;
      expected.right[frame] = expected.right[frame]! + inputRight;
    } else {
      expected.left[frame] = inputLeft;
      expected.right[frame] = inputRight;
    }
  }
}

function createBasePcm(): ExpectedPcm {
  const left = new Float32Array(LONG_LOOP_FRAMES);
  const right = new Float32Array(LONG_LOOP_FRAMES);
  for (let frame = 0; frame < LONG_LOOP_FRAMES; frame += 1) {
    left[frame] = 0.025 + (frame % 23) * 0.0001;
    right[frame] = -0.031 - (frame % 19) * 0.00012;
  }
  return { left, right };
}

function observeWorkletInputs(harness: CoreAudioHarness): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const processor = harness.processor;
  const original = processor.handlePortMessage.bind(processor);
  processor.handlePortMessage = (message: unknown) => {
    if (typeof message === 'object' && message !== null) messages.push(message as Record<string, unknown>);
    original(message);
  };
  return messages;
}

async function commitTake(
  harness: CoreAudioHarness,
  expected: ExpectedPcm,
  takeNumber: number,
): Promise<void> {
  const mode = takeNumber === 8 ? 'REPLACE1' : takeNumber === 21 ? 'REPLACE2' : 'OVERDUB';
  const inputLeft = Math.fround((takeNumber + 1) * 0.0002);
  const inputRight = Math.fround(-(takeNumber + 1) * 0.00013);
  await harness.run(harness.runtime.beginTake(0, mode));
  const metadata = harness.runtime.getTrackMetadata(0);
  if (!metadata) throw new Error('Track metadata disappeared during take preparation.');
  const startFrame = Atomics.load(metadata, TrackMetaWord.PLAY_POSITION);
  const source = (_frame: number, channel: 0 | 1) => channel === 0 ? inputLeft : inputRight;
  await harness.command(BrowserRealtimeOpcode.START_OVERDUB, 0, 0, 0, 0, source);
  await harness.command(BrowserRealtimeOpcode.STOP_OVERDUB, 0);
  setExpectedTake(expected, startFrame, mode, inputLeft, inputRight);
}

async function expectExport(harness: CoreAudioHarness, expected: ExpectedPcm): Promise<void> {
  const actual = await harness.runtime.exportTrack(0, createExportContext());
  expectPcm(actual, expected);
}

describe('long realtime history compaction', () => {
  it('compacts over 32 planar takes without changing PCM, recent undo, Rec Back, or Mark', async () => {
    const harness = createCoreAudioHarness();
    try {
      const workletInputs = observeWorkletInputs(harness);
      const original = createBasePcm();
      const expected = { left: original.left.slice(), right: original.right.slice() };
      await harness.run(harness.runtime.loadTrack(0, harness.createAudioBuffer(original.left, original.right)));
      await harness.command(BrowserRealtimeOpcode.PLAY, 0);

      let marked: ExpectedPcm | null = null;
      let bytesBeforeFirstCompaction = 0;
      const lateHistory = new Map<number, ExpectedPcm>();
      for (let take = 0; take < 40; take += 1) {
        await commitTake(harness, expected, take);
        if (take === 11) {
          marked = { left: expected.left.slice(), right: expected.right.slice() };
          await harness.run(harness.runtime.markTrack(0));
        }
        if (take === 13) bytesBeforeFirstCompaction = harness.runtime.getMetrics().storageAllocatedBytes;
        if (take >= 31) lateHistory.set(take + 1, { left: expected.left.slice(), right: expected.right.slice() });
      }

      const current = { left: expected.left.slice(), right: expected.right.slice() };
      await expectExport(harness, current);
      expect(harness.runtime.getMetrics().historyDepth[0]).toBeLessThan(16);
      expect(harness.runtime.getMetrics().storageAllocatedBytes).toBeLessThan(bytesBeforeFirstCompaction);
      expect(harness.runtime.getMetrics().storageAllocatedBytes).toBeLessThan(
        24 * BROWSER_REALTIME_STORAGE_BATCH_FRAMES * 8,
      );

      const batches = workletInputs.filter((message) =>
        message.type === 'ATTACH_HISTORY_COMPACTION_SEGMENTS');
      const batchSizes = batches.map((message) => Array.isArray(message.buffers) ? message.buffers.length : 0);
      expect(batchSizes.every((size) => size > 0 && size <= 8)).toBe(true);
      expect(batchSizes).toContain(8);
      expect(batchSizes).toContain(1);
      expect(harness.processor.port.messages.some((message) => message.type === 'TRACK_HISTORY_COMPACTED')).toBe(true);

      for (let take = 39; take >= 32; take -= 1) {
        await harness.command(BrowserRealtimeOpcode.UNDO, 0);
        const state = lateHistory.get(take);
        if (!state) throw new Error(`Expected undo snapshot ${take} was not retained.`);
        await expectExport(harness, state);
      }
      for (let take = 33; take <= 40; take += 1) {
        await harness.command(BrowserRealtimeOpcode.REDO, 0);
        const state = lateHistory.get(take);
        if (!state) throw new Error(`Expected redo snapshot ${take} was not retained.`);
        await expectExport(harness, state);
      }

      const preBranch = lateHistory.get(38);
      if (!preBranch) throw new Error('The pre-branch history checkpoint was not retained.');
      await harness.command(BrowserRealtimeOpcode.UNDO, 0);
      await harness.command(BrowserRealtimeOpcode.UNDO, 0);
      await harness.command(BrowserRealtimeOpcode.PLAY, 0);
      const branch = { left: preBranch.left.slice(), right: preBranch.right.slice() };
      await commitTake(harness, branch, 40);
      await expectExport(harness, branch);

      if (!marked) throw new Error('The mark checkpoint was not captured.');
      await harness.run(harness.runtime.restoreMarkedTrack(0));
      await expectExport(harness, marked);
      await harness.command(BrowserRealtimeOpcode.RESET_BACK, 0);
      await expectExport(harness, original);
    } finally {
      harness.dispose();
    }
  }, 30_000);

  it('aborts a malformed staged batch and preserves the pre-compaction history', async () => {
    const harness = createCoreAudioHarness();
    try {
      const original = createBasePcm();
      const expected = { left: original.left.slice(), right: original.right.slice() };
      await harness.run(harness.runtime.loadTrack(0, harness.createAudioBuffer(original.left, original.right)));
      await harness.command(BrowserRealtimeOpcode.PLAY, 0);

      const processor = harness.processor;
      const originalHandleMessage = processor.handlePortMessage.bind(processor);
      processor.handlePortMessage = (message: unknown) => {
        if (typeof message === 'object' && message !== null &&
            'type' in message && message.type === 'ATTACH_HISTORY_COMPACTION_SEGMENTS' &&
            'firstSegment' in message && message.firstSegment === 8 &&
            'buffers' in message && Array.isArray(message.buffers)) {
          const firstBuffer = message.buffers[0];
          if (firstBuffer instanceof SharedArrayBuffer) {
            const firstMeta = new Int32Array(firstBuffer, 0, 32);
            Atomics.store(firstMeta, TrackMetaWord.CHANNEL_COUNT, 1);
          }
        }
        originalHandleMessage(message);
      };

      for (let take = 0; take < 15; take += 1) await commitTake(harness, expected, take);
      await expect(harness.run(harness.runtime.beginTake(0, 'OVERDUB'))).rejects.toThrow(/segment|layout|invalid/i);
      expect(harness.processor.port.messages.some((message) => message.type === 'TRACK_COMPACTION_ABORTED')).toBe(true);
      expect(harness.processor.port.messages.some((message) => message.type === 'TRACK_HISTORY_COMPACTED')).toBe(false);
      const metadata = harness.runtime.getTrackMetadata(0);
      if (!metadata) throw new Error('Track metadata disappeared after compaction abort.');
      expect(Atomics.load(metadata, TrackMetaWord.HISTORY_CURSOR)).toBe(16);
      await expectExport(harness, expected);
      expect(harness.runtime.getMetrics().storageAllocatedBytes).toBeLessThan(
        24 * BROWSER_REALTIME_STORAGE_BATCH_FRAMES * 8,
      );
    } finally {
      harness.dispose();
    }
  }, 30_000);

  it('rejects a near-budget long import before compaction and preserves PCM, mark, undo, and redo', async () => {
    const harness = createCoreAudioHarness();
    try {
      const original = createBasePcm();
      const expected = { left: original.left.slice(), right: original.right.slice() };
      const expectedHistory: ExpectedPcm[] = [{ left: expected.left.slice(), right: expected.right.slice() }];
      await harness.run(harness.runtime.loadTrack(0, harness.createAudioBuffer(original.left, original.right)));
      await harness.command(BrowserRealtimeOpcode.PLAY, 0);

      let marked: ExpectedPcm | null = null;
      for (let take = 0; take < 15; take += 1) {
        await commitTake(harness, expected, take);
        expectedHistory.push({ left: expected.left.slice(), right: expected.right.slice() });
        if (take === 11) {
          marked = { left: expected.left.slice(), right: expected.right.slice() };
          await harness.run(harness.runtime.markTrack(0));
        }
      }

      if (!marked) throw new Error('The mark checkpoint was not captured.');
      const metadata = harness.runtime.getTrackMetadata(0);
      if (!metadata) throw new Error('Track metadata disappeared before import preflight.');
      const cursorBefore = Atomics.load(metadata, TrackMetaWord.HISTORY_CURSOR);
      const historyLengthBefore = Atomics.load(metadata, TrackMetaWord.HISTORY_LENGTH);
      const markCursorBefore = Atomics.load(metadata, TrackMetaWord.MARK_CURSOR);
      const storageBefore = harness.runtime.getMetrics().storageAllocatedBytes;
      const anchorSegments = Math.ceil(LONG_LOOP_FRAMES / BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
      const anchorBytes = anchorSegments * (
        TRACK_META_BYTES + BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * (2 * Float32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT)
      );
      const heldByOtherTracks = BROWSER_REALTIME_MAX_STORAGE_BYTES - storageBefore - anchorBytes;
      expect(heldByOtherTracks).toBeGreaterThanOrEqual(0);
      const runtimeAccounting = harness.runtime as unknown as { reservedStorageBytes: number };
      const previousReserved = runtimeAccounting.reservedStorageBytes;
      const compactionMessagesBefore = harness.processor.port.messages.filter((message) =>
        message.type === 'TRACK_HISTORY_COMPACTED',
      ).length;

      // Model memory already claimed by the other tracks without allocating
      // hundreds of megabytes just to reach the same deterministic budget edge.
      runtimeAccounting.reservedStorageBytes = heldByOtherTracks;
      const importFrames = BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * 100;
      const longImport = harness.createAudioBuffer(new Float32Array(importFrames).fill(0.12), new Float32Array(importFrames).fill(-0.08));
      try {
        await expect(harness.run(harness.runtime.loadTrack(0, longImport))).rejects.toThrow(/budget/i);
      } finally {
        runtimeAccounting.reservedStorageBytes = previousReserved;
      }

      expect(harness.runtime.getMetrics().storageAllocatedBytes).toBe(storageBefore);
      expect(harness.processor.port.messages.filter((message) => message.type === 'TRACK_HISTORY_COMPACTED')).toHaveLength(
        compactionMessagesBefore,
      );
      expect(Atomics.load(metadata, TrackMetaWord.HISTORY_CURSOR)).toBe(cursorBefore);
      expect(Atomics.load(metadata, TrackMetaWord.HISTORY_LENGTH)).toBe(historyLengthBefore);
      expect(Atomics.load(metadata, TrackMetaWord.MARK_CURSOR)).toBe(markCursorBefore);
      expect(harness.runtime.hasMarkSnapshot(0)).toBe(true);
      await expectExport(harness, expected);

      await harness.command(BrowserRealtimeOpcode.UNDO, 0);
      await expectExport(harness, expectedHistory[expectedHistory.length - 2]!);
      await harness.command(BrowserRealtimeOpcode.REDO, 0);
      await expectExport(harness, expected);

      await harness.run(harness.runtime.restoreMarkedTrack(0));
      await expectExport(harness, marked);
      await harness.command(BrowserRealtimeOpcode.RESET_BACK, 0);
      await expectExport(harness, original);
    } finally {
      harness.dispose();
    }
  }, 30_000);

  it('uses all 32 flag bits as the master epoch high word while retaining milli-BPM precision', async () => {
    const harness = createCoreAudioHarness();
    try {
      const epochFrame = 0x2_0000_0000;
      const ack = await harness.run(harness.runtime.setMasterClockEpoch(epochFrame, 120.5));
      expect(ack.status).toBe(0);
      expect(ack.targetFrame).toBe(0);
      expect(ack.executedFrame).toBe(0);
      expect(Atomics.load(harness.runtime.control, ControlWord.BPM)).toBe(121);
      expect(Atomics.load(harness.runtime.control, ControlWord.MASTER_ORIGIN_LOW) >>> 0).toBe(0);
      expect(Atomics.load(harness.runtime.control, ControlWord.MASTER_ORIGIN_HIGH) >>> 0).toBe(2);
    } finally {
      harness.dispose();
    }
  });
});
